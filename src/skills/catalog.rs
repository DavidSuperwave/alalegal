//! ClawHub skills catalog client.
//!
//! This module provides a small, resilient client for searching the public
//! skills registry and enriching results with optional metadata.

use std::sync::{Arc, OnceLock};

use serde_json::Value;

/// One skill search result from the registry.
#[derive(Debug, Clone, Default)]
pub struct CatalogEntry {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub score: f64,
    pub updated_at: Option<String>,
    pub stars: Option<u64>,
    pub downloads: Option<u64>,
    pub owner: Option<String>,
}

/// Search result payload returned by [`SkillCatalog::search`].
#[derive(Debug, Clone, Default)]
pub struct CatalogSearchOutcome {
    pub results: Vec<CatalogEntry>,
    pub error: Option<String>,
}

/// Client for interacting with the ClawHub registry API.
#[derive(Debug, Clone)]
pub struct SkillCatalog {
    registry_url: String,
    client: reqwest::Client,
}

impl SkillCatalog {
    /// Create a catalog client with an explicit registry URL.
    pub fn with_url(url: &str) -> Self {
        let registry_url = normalize_registry_url(url);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(12))
            .user_agent("superwave-agent/0.1")
            .build()
            .unwrap_or_else(|e| {
                tracing::warn!(
                    "Failed to build reqwest client for skill catalog ({}), falling back to default client",
                    e
                );
                reqwest::Client::new()
            });

        Self {
            registry_url,
            client,
        }
    }

    /// Registry base URL, normalized without trailing slash.
    pub fn registry_url(&self) -> &str {
        &self.registry_url
    }

    /// Search the registry for skills.
    ///
    /// This is best-effort by design: if the registry is unavailable,
    /// returns an empty result set with `error` populated.
    pub async fn search(&self, query: &str) -> CatalogSearchOutcome {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return CatalogSearchOutcome::default();
        }

        let encoded = urlencoding::encode(trimmed);
        let endpoints = [
            format!("{}/api/v1/search?query={}", self.registry_url, encoded),
            format!("{}/api/v1/search?type=skill&query={}", self.registry_url, encoded),
            format!("{}/api/v1/skills/search?query={}", self.registry_url, encoded),
            format!("{}/api/v1/skills?query={}", self.registry_url, encoded),
        ];

        let mut last_error: Option<String> = None;

        for endpoint in endpoints {
            match self.fetch_json(&endpoint).await {
                Ok(json) => {
                    let mut parsed = parse_catalog_entries(&json);
                    if !parsed.is_empty() {
                        // Sort by descending score, then name for stability.
                        parsed.sort_by(|a, b| {
                            b.score
                                .partial_cmp(&a.score)
                                .unwrap_or(std::cmp::Ordering::Equal)
                                .then_with(|| a.name.cmp(&b.name))
                        });
                        return CatalogSearchOutcome {
                            results: parsed,
                            error: None,
                        };
                    }
                }
                Err(e) => {
                    last_error = Some(e);
                }
            }
        }

        CatalogSearchOutcome {
            results: Vec::new(),
            error: last_error,
        }
    }

    /// Enrich top results with detail data (stars, downloads, owner).
    ///
    /// Any fetch/parse failures are ignored to keep search robust.
    pub async fn enrich_search_results(&self, entries: &mut [CatalogEntry], max_details: usize) {
        for entry in entries.iter_mut().take(max_details) {
            if entry.slug.is_empty() {
                continue;
            }
            if entry.stars.is_some() && entry.downloads.is_some() && entry.owner.is_some() {
                continue;
            }
            if let Some(detail) = self.fetch_skill_detail(&entry.slug).await {
                if entry.owner.is_none() {
                    entry.owner = detail.owner;
                }
                if entry.stars.is_none() {
                    entry.stars = detail.stars;
                }
                if entry.downloads.is_none() {
                    entry.downloads = detail.downloads;
                }
                if entry.updated_at.is_none() {
                    entry.updated_at = detail.updated_at;
                }
                if entry.description.is_empty() && !detail.description.is_empty() {
                    entry.description = detail.description;
                }
                if entry.version.is_empty() && !detail.version.is_empty() {
                    entry.version = detail.version;
                }
            }
        }
    }

    async fn fetch_skill_detail(&self, slug: &str) -> Option<CatalogEntry> {
        let slug_enc = urlencoding::encode(slug);
        let endpoints = [
            format!("{}/api/v1/skills/{}", self.registry_url, slug_enc),
            format!("{}/api/v1/skill/{}", self.registry_url, slug_enc),
            format!("{}/api/v1/skills?slug={}", self.registry_url, slug_enc),
        ];

        for endpoint in endpoints {
            if let Ok(json) = self.fetch_json(&endpoint).await {
                if let Some(entry) = parse_single_catalog_entry(&json) {
                    return Some(entry);
                }
                if let Some(first) = parse_catalog_entries(&json).into_iter().next() {
                    return Some(first);
                }
            }
        }

        None
    }

    async fn fetch_json(&self, url: &str) -> Result<Value, String> {
        let response = self
            .client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| format!("request failed for {}: {}", url, e))?;

        if !response.status().is_success() {
            return Err(format!("registry returned HTTP {} for {}", response.status(), url));
        }

        response
            .json::<Value>()
            .await
            .map_err(|e| format!("invalid JSON from {}: {}", url, e))
    }
}

/// Shared singleton catalog used by app startup.
pub fn shared_catalog() -> Arc<SkillCatalog> {
    static CATALOG: OnceLock<Arc<SkillCatalog>> = OnceLock::new();
    Arc::clone(CATALOG.get_or_init(|| {
        let url = std::env::var("SKILLS_CATALOG_URL")
            .or_else(|_| std::env::var("CLAWHUB_REGISTRY"))
            .unwrap_or_else(|_| "https://clawhub.ai".to_string());
        Arc::new(SkillCatalog::with_url(&url))
    }))
}

/// Build a registry download URL for a skill slug or name.
pub fn skill_download_url(registry_url: &str, slug_or_name: &str) -> String {
    let base = normalize_registry_url(registry_url);
    let slug = urlencoding::encode(slug_or_name.trim());
    format!("{}/api/v1/download?slug={}", base, slug)
}

fn normalize_registry_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "https://clawhub.ai".to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_catalog_entries(value: &Value) -> Vec<CatalogEntry> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for item in extract_result_items(value) {
        if let Some(entry) = parse_entry_object(item) {
            if seen.insert(entry.slug.clone()) {
                out.push(entry);
            }
        }
    }

    out
}

fn parse_single_catalog_entry(value: &Value) -> Option<CatalogEntry> {
    if let Some(obj) = value.as_object()
        && let Some(entry) = parse_entry_object(obj)
    {
        return Some(entry);
    }
    if let Some(obj) = value
        .get("result")
        .and_then(Value::as_object)
        .and_then(parse_entry_object)
    {
        return Some(obj);
    }
    if let Some(obj) = value
        .get("data")
        .and_then(Value::as_object)
        .and_then(parse_entry_object)
    {
        return Some(obj);
    }
    None
}

fn extract_result_items(value: &Value) -> Vec<&serde_json::Map<String, Value>> {
    if let Some(arr) = value.as_array() {
        return arr.iter().filter_map(Value::as_object).collect();
    }

    let containers = ["results", "skills", "data", "items", "entries"];
    for key in containers {
        if let Some(arr) = value.get(key).and_then(Value::as_array) {
            return arr.iter().filter_map(Value::as_object).collect();
        }
    }

    if let Some(arr) = value
        .get("result")
        .and_then(|v| v.get("results"))
        .and_then(Value::as_array)
    {
        return arr.iter().filter_map(Value::as_object).collect();
    }

    Vec::new()
}

fn parse_entry_object(obj: &serde_json::Map<String, Value>) -> Option<CatalogEntry> {
    let slug = first_string(obj, &["slug", "id", "name"])?;
    let name = first_string(obj, &["name", "title"]).unwrap_or_else(|| slug.clone());
    let description = first_string(obj, &["description", "summary"]).unwrap_or_default();
    let version =
        first_string(obj, &["version", "latest_version", "latestVersion"]).unwrap_or_default();
    let score = first_f64(obj, &["score", "rank"]).unwrap_or(0.0);
    let updated_at = first_string(obj, &["updated_at", "updatedAt", "updated"]);
    let stars = first_u64(obj, &["stars", "star_count", "starCount", "stargazers"]);
    let downloads = first_u64(obj, &["downloads", "download_count", "downloadCount", "installs"]);

    let owner = obj
        .get("owner")
        .and_then(parse_owner_value)
        .or_else(|| obj.get("author").and_then(parse_owner_value))
        .or_else(|| first_string(obj, &["publisher", "maintainer"]));

    Some(CatalogEntry {
        slug,
        name,
        description,
        version,
        score,
        updated_at,
        stars,
        downloads,
        owner,
    })
}

fn parse_owner_value(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
        return None;
    }
    let obj = v.as_object()?;
    first_string(obj, &["name", "username", "login", "slug"])
}

fn first_string(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(Value::as_str) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn first_f64(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(v) = obj.get(*key) {
            if let Some(n) = v.as_f64() {
                return Some(n);
            }
            if let Some(n) = v.as_u64() {
                return Some(n as f64);
            }
            if let Some(s) = v.as_str()
                && let Ok(parsed) = s.parse::<f64>()
            {
                return Some(parsed);
            }
        }
    }
    None
}

fn first_u64(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<u64> {
    for key in keys {
        if let Some(v) = obj.get(*key) {
            if let Some(n) = v.as_u64() {
                return Some(n);
            }
            if let Some(n) = v.as_i64()
                && n >= 0
            {
                return Some(n as u64);
            }
            if let Some(s) = v.as_str() {
                let compact = s.replace(',', "");
                if let Ok(parsed) = compact.parse::<u64>() {
                    return Some(parsed);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_skill_download_url() {
        let url = super::skill_download_url("https://clawhub.ai/", "owner/my skill");
        assert_eq!(
            url,
            "https://clawhub.ai/api/v1/download?slug=owner%2Fmy%20skill"
        );
    }

    #[test]
    fn test_parse_catalog_entries_from_results_key() {
        let value = serde_json::json!({
            "results": [
                {
                    "slug": "skills/markdown",
                    "name": "Markdown",
                    "description": "Markdown helper",
                    "version": "1.2.3",
                    "score": 1.5,
                    "stars": 10,
                    "downloads": 2500,
                    "owner": {"username": "openclaw"}
                }
            ]
        });
        let entries = super::parse_catalog_entries(&value);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].slug, "skills/markdown");
        assert_eq!(entries[0].owner.as_deref(), Some("openclaw"));
        assert_eq!(entries[0].stars, Some(10));
    }
}