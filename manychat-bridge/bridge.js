/**
 * ALA Legal — ManyChat Bridge
 * ============================================================
 * Bridge for the Superwave Factory template.
 * Handles message classification, PostgreSQL logging,
 * ManyChat auto-tagging, custom field updates, and
 * Spanish system-prompt injection before forwarding
 * messages to the Superwave Rust agent.
 *
 * Channels supported: messenger, instagram, whatsapp, tiktok
 *
 * Data layer: local PostgreSQL (pg) — zero external dependencies
 * beyond ManyChat API and OpenRouter.
 *
 * @author   Superwave Factory
 * @version  2.1.0
 */

'use strict';

const express    = require('express');
const axios      = require('axios');
const crypto     = require('crypto');
const { Pool }   = require('pg');

// ─── Environment ────────────────────────────────────────────
const {
  MANYCHAT_API_KEY         = '',
  SUPERWAVE_WEBHOOK_URL    = 'http://agent:8080/webhook',
  SUPERWAVE_WEBHOOK_SECRET = '',
  BRIDGE_PORT              = '4000',
  BRIDGE_SECRET            = '',
  DATABASE_URL             = 'postgres://superwave:superwave-secret@db:5432/superwave',
  ADMIN_SECRET             = 'change-me',
} = process.env;

const PORT = parseInt(BRIDGE_PORT, 10);

// ─── PostgreSQL pool ─────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[pg] Unexpected pool error:', err.message);
});

// ─── Auto-migration ──────────────────────────────────────────

/**
 * Create the bridge tables if they don't exist yet.
 * Idempotent — safe to run on every startup.
 */
async function ensureTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS mc_messages (
      id                       BIGSERIAL PRIMARY KEY,
      subscriber_id            TEXT        NOT NULL,
      channel                  TEXT        NOT NULL DEFAULT 'messenger',
      direction                TEXT        NOT NULL DEFAULT 'inbound',
      content                  TEXT,
      classification           TEXT,
      classification_confidence NUMERIC(4,2),
      metadata                 JSONB,
      created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mc_subscribers (
      subscriber_id       TEXT        PRIMARY KEY,
      first_name          TEXT,
      last_name           TEXT,
      email               TEXT,
      phone               TEXT,
      channel             TEXT,
      last_seen_at        TIMESTAMPTZ,
      last_classification TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mc_classification_stats (
      id             BIGSERIAL PRIMARY KEY,
      date           DATE        NOT NULL,
      channel        TEXT        NOT NULL,
      classification TEXT        NOT NULL,
      count          INTEGER     NOT NULL DEFAULT 1,
      CONSTRAINT mc_classification_stats_date_channel_classification_key
        UNIQUE (date, channel, classification)
    );

    CREATE INDEX IF NOT EXISTS mc_messages_subscriber_id_idx
      ON mc_messages (subscriber_id);
    CREATE INDEX IF NOT EXISTS mc_messages_created_at_idx
      ON mc_messages (created_at DESC);
    CREATE INDEX IF NOT EXISTS mc_subscribers_channel_idx
      ON mc_subscribers (channel);
    CREATE INDEX IF NOT EXISTS mc_classification_stats_date_idx
      ON mc_classification_stats (date DESC);
  `;

  await pool.query(sql);
  console.log('[pg] Tables verified / created');
}

// ─── ManyChat API client ─────────────────────────────────────
const manychat = axios.create({
  baseURL: 'https://api.manychat.com',
  headers: {
    Authorization: MANYCHAT_API_KEY,
    'Content-Type': 'application/json',
  },
  timeout: 8000,
});

// ─── In-memory state ─────────────────────────────────────────
const startedAt     = Date.now();
let   lastMessageAt = null;

/** @type {Map<string, string>}  tagName → ManyChat tag ID */
const tagIdCache = new Map();

/**
 * Aggregated stats per channel and classification.
 * Structure: { [channel]: { [classification]: number } }
 */
const stats = {};

/**
 * Ring-buffer of last 10 messages for the admin endpoint.
 * @type {Array<object>}
 */
const recentMessages = [];

// ─── Classification ──────────────────────────────────────────

/**
 * Keyword patterns for Spanish-language legal chat classification.
 * Each entry: { category, weight, patterns[] }
 * Patterns are matched case-insensitively against the full message text.
 *
 * Mexican Spanish conventions included:
 *   - informal spelling: k=que, xq=porque, tb=también, etc.
 *   - common abbreviations and regional terms
 */
const CLASSIFIERS = [
  // ── spam / irrelevant ────────────────────────────────────────
  {
    category: 'spam',
    weight: 10,
    patterns: [
      /\bvende[rn]?\b/i,
      /\bcompra[rn]?\b/i,
      /\bpromoción\b/i,
      /\bdescuento\b/i,
      /\boferta\b/i,
      /\bganaste?\b/i,
      /\bpremi[oa]\b/i,
      /\bsorte[oa]\b/i,
      /\bcrypto\b/i,
      /\bbitcoin\b/i,
      /\binvers[ió]n\b/i,
      /\bclicks?\b/i,
      /\bsuscri[bp]e\b/i,
    ],
  },

  // ── greetings / small talk ──────────────────────────────────
  {
    category: 'saludo',
    weight: 1,
    patterns: [
      /^\s*hola\b/i,
      /^\s*buenas?\b/i,
      /^\s*buenos?\s+(d[ií]as?|tardes?|noches?)\b/i,
      /^\s*qu[ée]\s+tal\b/i,
      /^\s*c[oó]mo\s+est[aá][ns]?\b/i,
      /^\s*hey\b/i,
      /^\s*saludos?\b/i,
      /^\s*qu[ée]\s+onda\b/i,
      /^\s*buen\s+d[ií]a\b/i,
      /^\s*gracias\b/i,
      /^\s*ok\b/i,
      /^\s*okey\b/i,
      /^\s*bien\b/i,
      /^\s*perfecto\b/i,
      /^\s*entendido\b/i,
    ],
  },

  // ── appointment requests ─────────────────────────────────────
  {
    category: 'cita',
    weight: 8,
    patterns: [
      /\bcita\b/i,
      /\bcitas\b/i,
      /\bagendar\b/i,
      /\bagend[ae]me?\b/i,
      /\bprogramar?\b/i,
      /\breunión\b/i,
      /\breunion\b/i,
      /\bentrevista\b/i,
      /\bvisita\b/i,
      /\bcuando\s+(puedo|pueden|podemos)\s+(ir|venir|pasar|verte|verlos)\b/i,
      /\bqu[eé]\s+(d[ií]a|hora|horario)\b/i,
      /\bhorario[s]?\b/i,
      /\bhoras?\s+de\s+atenci[oó]n\b/i,
      /\bdisponibilidad\b/i,
      /\bhablar\s+(con|en)\s+persona\b/i,
      /\bconsulta\s+(presencial|f[ií]sica)\b/i,
    ],
  },

  // ── pricing inquiries ─────────────────────────────────────────
  {
    category: 'precio',
    weight: 8,
    patterns: [
      /\bprecio[s]?\b/i,
      /\bcosto[s]?\b/i,
      /\bcobran?\b/i,
      /\bcobro[s]?\b/i,
      /\bcu[aá]nto\s+(cobran?|cuesta|vale|es)\b/i,
      /\btar[ií]fa[s]?\b/i,
      /\bhonorario[s]?\b/i,
      /\bpago[s]?\b/i,
      /\bpagar?\b/i,
      /\bgrati[st]\b/i,
      /\bsin\s+costo\b/i,
      /\bbarato\b/i,
      /\beconom[ií]co\b/i,
      /\bpresupuesto\b/i,
      /\bcotizaci[oó]n\b/i,
      /\bcotizar\b/i,
      /\bcomisi[oó]n\b/i,
      /\bporcentaje\b/i,
    ],
  },

  // ── credit / pre-qualification ────────────────────────────────
  {
    category: 'precalificacion',
    weight: 9,
    patterns: [
      /\bcurp\b/i,
      /\bnss\b/i,
      /\bn[uú]mero\s+de\s+seguro\s+social\b/i,
      /\bimss\b/i,
      /\bissste\b/i,
      /\bcr[eé]dito\b/i,
      /\bpr[eé]stamo\b/i,
      /\bprecalif\w*/i,
      /\bcalificar?\b/i,
      /\bcalificaci[oó]n\b/i,
      /\bsolicitar?\s+(cr[eé]dito|pr[eé]stamo|apoyo)\b/i,
      /\bfondo[s]?\s+de\s+pensi[oó]n\b/i,
      /\bafore\b/i,
      /\bafores\b/i,
      /\bpens[ií][oó]n\b/i,
      /\bjubilaci[oó]n\b/i,
      /\brecuperaci[oó]n\s+de\s+fondos\b/i,
      /\bcu[aá]nto\s+me\s+corresponde\b/i,
    ],
  },

  // ── case status ───────────────────────────────────────────────
  {
    category: 'estado_caso',
    weight: 9,
    patterns: [
      /\bestado\s+de\s+(mi\s+)?(caso|demanda|tr[aá]mite|proceso|expediente)\b/i,
      /\b(mi\s+)?(caso|expediente|demanda)\b.*\b(c[oó]mo\s+(va|est[aá])|estado|avance)\b/i,
      /\bseguimiento\b/i,
      /\bavance[s]?\b/i,
      /\bnoticia[s]?\b/i,
      /\bqu[eé]\s+(pas[oó]|ha\s+pasado|pas[oó]\s+con)\b/i,
      /\bmi\s+(caso|expediente|tr[aá]mite)\b/i,
      /\bnúmero\s+de\s+(caso|expediente|folio)\b/i,
      /\bfolio\b/i,
      /\bexpediente\b/i,
      /\bdemanda\s+ya\s+(fue|est[aá])\b/i,
      /\bresoluci[oó]n\b/i,
      /\bfallo\b/i,
    ],
  },

  // ── legal consultation (highest weight — most important) ──────
  {
    category: 'consulta_legal',
    weight: 10,
    patterns: [
      // accidents & injuries
      /\baccidente\b/i,
      /\baccidentes\b/i,
      /\bchoque\b/i,
      /\bchocaron?\b/i,
      /\batropell[ao]\b/i,
      /\blesion[ae][sd]?\b/i,
      /\bheri[do][sa]?\b/i,
      /\bda[nñ]os?\b/i,
      /\bda[nñ]ado\b/i,
      /\bv[ií]ctima\b/i,
      /\bmuerte\b/i,
      /\bfalleci[do]\b/i,
      /\bfallecimiento\b/i,
      /\bdefunci[oó]n\b/i,
      /\bresponsabilidad\b/i,
      /\bconductor\b/i,
      // insurance
      /\baseguradora\b/i,
      /\bseguro\s+(de\s+)?(auto|vida|gastos\s+m[eé]dicos|casa|hogar|veh[ií]culo)\b/i,
      /\bindemnizaci[oó]n\b/i,
      /\bindemnizar\b/i,
      /\breclamaci[oó]n\b/i,
      /\breclamo\b/i,
      /\breclamar\b/i,
      /\bsiniestro\b/i,
      /\baxa\b/i,
      /\bgni\b/i,
      /\bqualitas\b/i,
      /\bmapfre\b/i,
      /\bgnp\b/i,
      /\bmetlife\b/i,
      /\bhdiseguros?\b/i,
      /\bseguros?\s+banorte\b/i,
      /\bajust[ae]\b/i,
      /\bajustador\b/i,
      // legal terms
      /\bdemanda\b/i,
      /\bdemandar\b/i,
      /\bjuicio\b/i,
      /\bjuzgado\b/i,
      /\blitigio\b/i,
      /\babogado\b/i,
      /\basesori[ae]\b/i,
      /\brepresentaci[oó]n\s+legal\b/i,
      /\bderecho\b/i,
      /\bderechos\b/i,
      /\bmi\s+culpa\b/i,
      /\bculpa\b/i,
      /\bnegligencia\b/i,
      /\bcompensaci[oó]n\b/i,
      // informal / slang variants
      /\bxq\s+(me\s+)?(chocaron?|accidenté)\b/i,
      /\bme\s+(chocaron?|peg[oó]|atropell[ao])\b/i,
      /\bno\s+me\s+(quieren\s+)?pagar?\b/i,
      /\bno\s+me\s+hace\s+(caso|nada)\s+(la\s+)?aseguradora\b/i,
      /\bno\s+paga\b/i,
      /\bqu[eé]\s+hago\b/i,
      /\bme\s+pueden?\s+ayudar?\b/i,
      /\bnecesito\s+(un\s+)?(abogado|asesor[ií]a|ayuda)\b/i,
    ],
  },

  // ── general info (lowest priority) ───────────────────────────
  {
    category: 'info_general',
    weight: 2,
    patterns: [
      /\bqu[eé]\s+(hacen?|ofrecen?|son|es\s+ala)\b/i,
      /\bservicios?\b/i,
      /\binfo\b/i,
      /\binformaci[oó]n\b/i,
      /\bc[oó]mo\s+(funciona|trabajan?|pueden?\s+ayudar)\b/i,
      /\bd[oó]nde\s+(est[aá]n?|queda|se\s+ubican?)\b/i,
      /\bdirecci[oó]n\b/i,
      /\bubicaci[oó]n\b/i,
      /\bt[eé]l[eé]fono\b/i,
      /\btel[eé]fono\b/i,
      /\bcorreo\b/i,
      /\bemail\b/i,
      /\bcontacto\b/i,
      /\bweb\b/i,
      /\bp[aá]gina\b/i,
      /\bsitio\b/i,
    ],
  },
];

/**
 * Classify an incoming message using keyword-pattern matching.
 * Returns the highest-scoring category plus a confidence score [0–1].
 *
 * @param {string} text - Raw message text
 * @returns {{ category: string, confidence: number }}
 */
function classifyMessage(text) {
  if (!text || typeof text !== 'string') {
    return { category: 'info_general', confidence: 0 };
  }

  const normalized = text.trim().toLowerCase();

  /** @type {Map<string, number>} */
  const scores = new Map();

  for (const { category, weight, patterns } of CLASSIFIERS) {
    let matchCount = 0;
    for (const re of patterns) {
      if (re.test(normalized)) matchCount++;
    }
    if (matchCount > 0) {
      const current = scores.get(category) || 0;
      scores.set(category, current + matchCount * weight);
    }
  }

  if (scores.size === 0) {
    // No pattern matched — return ambiguous marker so the agent decides
    return { category: 'info_general', confidence: 0 };
  }

  // Pick the category with the highest aggregate score
  let best = { category: 'info_general', score: 0 };
  for (const [category, score] of scores) {
    if (score > best.score) best = { category, score };
  }

  // Normalise confidence: cap at 1.0, diminishing past 3 matched patterns×weight
  const maxPossible = 30;
  const confidence  = Math.min(best.score / maxPossible, 1);

  return { category: best.category, confidence: parseFloat(confidence.toFixed(2)) };
}

// ─── Classification → Tag mapping ───────────────────────────
const CLASSIFICATION_TAGS = {
  consulta_legal:  'consulta_legal',
  estado_caso:     'estado_caso',
  precalificacion: 'precalificacion',
  cita:            'cita',
  precio:          'precio',
  info_general:    'info_general',
  saludo:          'nuevo',
  spam:            'spam',
};

// ─── Stats helpers ────────────────────────────────────────────

/**
 * Increment the in-memory stats counter.
 * @param {string} channel
 * @param {string} classification
 */
function bumpStats(channel, classification) {
  if (!stats[channel]) stats[channel] = {};
  stats[channel][classification] = (stats[channel][classification] || 0) + 1;
}

/**
 * Append a message to the recent-messages ring buffer (max 10 entries).
 * @param {object} entry
 */
function pushRecent(entry) {
  recentMessages.push(entry);
  if (recentMessages.length > 10) recentMessages.shift();
}

// ─── PostgreSQL helpers ───────────────────────────────────────

/**
 * Log a message row to mc_messages.
 * Silently swallows errors so the bridge doesn't crash.
 *
 * @param {object} params
 */
async function logMessage(params) {
  try {
    await pool.query(
      `INSERT INTO mc_messages
         (subscriber_id, channel, direction, content, classification,
          classification_confidence, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.subscriber_id,
        params.channel,
        params.direction || 'inbound',
        params.content   || null,
        params.classification || null,
        params.classification_confidence != null ? params.classification_confidence : null,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ]
    );
  } catch (err) {
    console.error('[pg] logMessage error:', err.message);
  }
}

/**
 * Upsert a subscriber row in mc_subscribers.
 * @param {object} subscriber
 */
async function upsertSubscriber(subscriber) {
  try {
    await pool.query(
      `INSERT INTO mc_subscribers
         (subscriber_id, first_name, last_name, email, phone,
          channel, last_seen_at, last_classification, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (subscriber_id) DO UPDATE SET
         first_name          = EXCLUDED.first_name,
         last_name           = EXCLUDED.last_name,
         email               = COALESCE(EXCLUDED.email, mc_subscribers.email),
         phone               = COALESCE(EXCLUDED.phone, mc_subscribers.phone),
         channel             = EXCLUDED.channel,
         last_seen_at        = EXCLUDED.last_seen_at,
         last_classification = EXCLUDED.last_classification,
         updated_at          = NOW()`,
      [
        subscriber.subscriber_id,
        subscriber.first_name   || null,
        subscriber.last_name    || null,
        subscriber.email        || null,
        subscriber.phone        || null,
        subscriber.channel,
        subscriber.last_seen_at || new Date().toISOString(),
        subscriber.last_classification || null,
      ]
    );
  } catch (err) {
    console.error('[pg] upsertSubscriber error:', err.message);
  }
}

/**
 * Increment the daily classification stats counter in PostgreSQL.
 * @param {string} channel
 * @param {string} classification
 */
async function logClassificationStat(channel, classification) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO mc_classification_stats (date, channel, classification, count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (date, channel, classification)
       DO UPDATE SET count = mc_classification_stats.count + 1`,
      [today, channel, classification]
    );
  } catch (err) {
    console.error('[pg] logClassificationStat error:', err.message);
  }
}

// ─── ManyChat API helpers ────────────────────────────────────

/**
 * Resolve a tag name to its ManyChat tag ID, creating it if necessary.
 * Results are cached in tagIdCache.
 *
 * @param {string} tagName
 * @returns {Promise<string|null>}
 */
async function resolveTagId(tagName) {
  if (tagIdCache.has(tagName)) return tagIdCache.get(tagName);

  try {
    // Try to create the tag (idempotent — ManyChat returns existing if duplicate)
    const { data } = await manychat.post('/fb/page/createTag', { name: tagName });
    const tagId = data?.data?.id || data?.data?.tag_id || null;
    if (tagId) {
      tagIdCache.set(tagName, String(tagId));
      console.log(`[manychat] Resolved/created tag "${tagName}" → ${tagId}`);
      return String(tagId);
    }
  } catch (err) {
    console.error(`[manychat] resolveTagId("${tagName}") error:`, err?.response?.data || err.message);
  }
  return null;
}

/**
 * Add a tag to a ManyChat subscriber.
 * Silently ignores errors so the bridge doesn't crash.
 *
 * @param {string} subscriberId
 * @param {string} tagName
 */
async function tagSubscriber(subscriberId, tagName) {
  try {
    const tagId = await resolveTagId(tagName);
    if (!tagId) return;

    await manychat.post('/fb/subscriber/addTag', {
      subscriber_id: subscriberId,
      tag_id:        tagId,
    });
    console.log(`[manychat] Tagged subscriber ${subscriberId} with "${tagName}"`);
  } catch (err) {
    console.error(`[manychat] tagSubscriber error (${tagName}):`, err?.response?.data || err.message);
  }
}

/**
 * Resolve a custom field name to its ManyChat field ID.
 * @type {Map<string, string>}
 */
const fieldIdCache = new Map();

/**
 * Fetch all custom fields from ManyChat and populate fieldIdCache.
 */
async function warmFieldCache() {
  try {
    const { data } = await manychat.get('/fb/page/getCustomFields');
    const fields = data?.data || [];
    for (const f of fields) {
      if (f.name && f.id) fieldIdCache.set(f.name, String(f.id));
    }
    console.log(`[manychat] Warmed field cache with ${fieldIdCache.size} fields`);
  } catch (err) {
    console.error('[manychat] warmFieldCache error:', err?.response?.data || err.message);
  }
}

/**
 * Set custom fields on a ManyChat subscriber.
 *
 * @param {string} subscriberId
 * @param {Array<{ field_id: string, field_value: string }>} fields
 */
async function setCustomFields(subscriberId, fields) {
  if (!fields.length) return;
  try {
    await manychat.post('/fb/subscriber/setCustomField', {
      subscriber_id: subscriberId,
      fields,
    });
    console.log(`[manychat] Set ${fields.length} custom field(s) for subscriber ${subscriberId}`);
  } catch (err) {
    console.error('[manychat] setCustomFields error:', err?.response?.data || err.message);
  }
}

/**
 * Update the three standard classification custom fields on a subscriber.
 *
 * @param {string} subscriberId
 * @param {string} classification
 * @param {string} channel
 */
async function updateClassificationFields(subscriberId, classification, channel) {
  const now    = new Date().toISOString();
  const wanted = {
    ultima_clasificacion: classification,
    ultimo_contacto:      now,
    canal:                channel,
  };

  const fields = [];
  for (const [name, value] of Object.entries(wanted)) {
    const fieldId = fieldIdCache.get(name);
    if (fieldId) {
      fields.push({ field_id: fieldId, field_value: value });
    } else {
      console.warn(`[manychat] Custom field "${name}" not in cache — skipping`);
    }
  }

  await setCustomFields(subscriberId, fields);
}

// ─── System prompt builder ────────────────────────────────────

/**
 * Build the Spanish system-context prefix to prepend to the
 * message sent to the Superwave Rust agent.
 *
 * @param {object} opts
 * @param {string} opts.channel
 * @param {string} opts.classification
 * @param {string} opts.firstName
 * @param {string} opts.lastName
 * @param {string} opts.subscriberId
 * @returns {string}
 */
function buildSystemPrefix({ channel, classification, firstName, lastName, subscriberId }) {
  const name = [firstName, lastName].filter(Boolean).join(' ') || 'Desconocido';
  return (
    `[Sistema ALA Legal] Canal: ${channel} | Clasificación: ${classification} | ` +
    `Suscriptor: ${name} (ID: ${subscriberId})\n` +
    `Responde siempre en español mexicano. ` +
    `Eres el asistente virtual de ALA Legal, despacho especializado en derecho de daños ` +
    `e indemnizaciones ante aseguradoras en Monterrey, México.`
  );
}

// ─── Channel detection ────────────────────────────────────────

/**
 * Derive the canonical channel name from the ManyChat payload.
 * ManyChat sends a "channel" field or "source" in some payloads.
 *
 * @param {object} body - Parsed request body
 * @returns {'messenger'|'instagram'|'whatsapp'|'tiktok'}
 */
function detectChannel(body) {
  const raw = (body.channel || body.source || '').toLowerCase();
  if (raw.includes('whatsapp') || raw.includes('wa'))  return 'whatsapp';
  if (raw.includes('instagram') || raw.includes('ig')) return 'instagram';
  if (raw.includes('tiktok'))                          return 'tiktok';
  return 'messenger'; // default
}

/**
 * Choose the correct ManyChat response endpoint based on channel.
 *
 * @param {string} channel
 * @returns {string}
 */
function responseEndpoint(channel) {
  if (channel === 'whatsapp') return '/wa/subscriber/sendContent';
  return '/fb/subscriber/sendContent'; // messenger, instagram, tiktok
}

// ─── Agent forwarding ─────────────────────────────────────────

/**
 * Forward the enriched message to the Superwave Rust agent and
 * return the agent's text response.
 *
 * @param {object} payload - Message payload to forward
 * @returns {Promise<string>}  Agent response text
 */
async function forwardToAgent(payload) {
  const body = {
    ...payload,
    wait_for_response: true,
  };
  if (SUPERWAVE_WEBHOOK_SECRET) {
    body.secret = SUPERWAVE_WEBHOOK_SECRET;
  }

  const { data } = await axios.post(SUPERWAVE_WEBHOOK_URL, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  // The Superwave agent returns { response: "..." } or { text: "..." }
  return data?.response || data?.text || data?.message || JSON.stringify(data);
}

// ─── Express app ─────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Shared request timestamp middleware ──────────────────────
app.use((req, _res, next) => {
  req._receivedAt = Date.now();
  next();
});

// ─── Webhook endpoint ─────────────────────────────────────────

/**
 * POST /manychat/webhook
 * Main entry point called by ManyChat External Request action.
 *
 * Expected body fields:
 *   subscriber_id   — ManyChat subscriber ID
 *   first_name      — subscriber first name
 *   last_name       — subscriber last name (optional)
 *   last_input_text — the raw message the user typed
 *   channel         — channel identifier
 *   email           — subscriber email (optional)
 *   phone           — subscriber phone (optional)
 */
app.post('/manychat/webhook', async (req, res) => {
  const body = req.body || {};

  if (BRIDGE_SECRET) {
    const provided = String(body.secret || req.headers['x-bridge-secret'] || '');
    const expected = String(BRIDGE_SECRET);
    const valid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

    if (!valid) {
      return res.status(401).json({ error: 'Invalid bridge secret' });
    }
  }

  // ── 1. Extract fields ───────────────────────────────────────
  const subscriberId = String(body.subscriber_id || body.id || '');
  const firstName    = body.first_name  || '';
  const lastName     = body.last_name   || '';
  const messageText  = body.last_input_text || body.text || body.message || '';
  const email        = body.email || '';
  const phone        = body.phone || '';
  const channel      = detectChannel(body);

  if (!subscriberId) {
    return res.status(400).json({ error: 'subscriber_id is required' });
  }

  console.log(`[webhook] ${channel} | sub=${subscriberId} | msg="${messageText.slice(0, 60)}"`);

  // ── 2. Classify ─────────────────────────────────────────────
  const { category, confidence } = classifyMessage(messageText);
  console.log(`[classify] → ${category} (confidence=${confidence})`);

  // ── 3. Update in-memory state ────────────────────────────────
  lastMessageAt = new Date().toISOString();
  bumpStats(channel, category);
  pushRecent({
    subscriberId,
    firstName,
    channel,
    classification: category,
    confidence,
    messageSnippet: messageText.slice(0, 80),
    ts: lastMessageAt,
  });

  // ── 4. Fire-and-forget: ManyChat operations (non-blocking) ──
  Promise.allSettled([
    tagSubscriber(subscriberId, CLASSIFICATION_TAGS[category] || 'info_general'),
    updateClassificationFields(subscriberId, category, channel),
  ]).catch(() => {/* already handled inside each function */});

  // ── 5. Log inbound message to PostgreSQL ────────────────────
  const inboundLog = {
    subscriber_id:              subscriberId,
    channel,
    direction:                  'inbound',
    content:                    messageText,
    classification:             category,
    classification_confidence:  confidence,
    metadata: {
      first_name: firstName,
      last_name:  lastName,
      email,
      phone,
    },
  };
  logMessage(inboundLog);

  // Upsert subscriber record
  upsertSubscriber({
    subscriber_id:       subscriberId,
    first_name:          firstName,
    last_name:           lastName,
    email:               email || null,
    phone:               phone || null,
    channel,
    last_seen_at:        lastMessageAt,
    last_classification: category,
  });

  logClassificationStat(channel, category);

  // ── 6. Build enriched payload for agent ─────────────────────
  const systemPrefix = buildSystemPrefix({
    channel,
    classification: category,
    firstName,
    lastName,
    subscriberId,
  });

  const agentPayload = {
    ...body,
    // Rust HTTP channel requires "content" and optional "secret" in JSON body.
    content:        `${systemPrefix}\n\nUsuario: ${messageText}`,
    thread_id:      `manychat:${subscriberId}`,
    // Keep original for reference
    original_text:  messageText,
    // Enriched metadata
    classification: category,
    confidence,
    channel,
    subscriber_id:  subscriberId,
    first_name:     firstName,
    last_name:      lastName,
  };

  // ── 7. Forward to agent ──────────────────────────────────────
  let agentResponse;
  try {
    agentResponse = await forwardToAgent(agentPayload);
  } catch (err) {
    console.error('[agent] Forward failed:', err.message);

    // Log the failure
    logMessage({
      subscriber_id: subscriberId,
      channel,
      direction:     'outbound',
      content:       'ERROR: agent unreachable',
      classification: category,
      metadata:      { error: err.message },
    });

    // Fallback Spanish response
    const fallback =
      'Disculpe, estamos experimentando dificultades técnicas. ' +
      'Por favor intente más tarde o llámenos al 81 1249 1200.';

    return res.json({ version: 'v2', content: { messages: [{ type: 'text', text: fallback }] } });
  }

  // ── 8. Log outbound message to PostgreSQL ───────────────────
  logMessage({
    subscriber_id:  subscriberId,
    channel,
    direction:      'outbound',
    content:        agentResponse,
    classification: category,
    metadata:       { confidence },
  });

  // ── 9. Return response in ManyChat Dynamic Response format ──
  return res.json({
    version: 'v2',
    content: {
      messages: [
        { type: 'text', text: agentResponse },
      ],
    },
  });
});

// ─── Health endpoint ──────────────────────────────────────────

/**
 * GET /health
 * Returns service status, uptime, DB status, classification stats, last message timestamp.
 */
app.get('/health', async (_req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

  let dbStatus = 'disconnected';
  try {
    await pool.query('SELECT 1');
    dbStatus = 'connected';
  } catch (_err) {
    // DB unreachable — report status but don't crash
  }

  res.json({
    status:       'ok',
    uptime:       uptimeSeconds,
    lastMessage:  lastMessageAt,
    stats,
    tagCacheSize: tagIdCache.size,
    db:           dbStatus,
    ts:           new Date().toISOString(),
  });
});

// ─── Admin endpoint ───────────────────────────────────────────

/**
 * GET /admin/stats
 * Protected endpoint (ADMIN_SECRET env var via Authorization header or ?secret= query param).
 * Returns aggregated stats and last 10 messages.
 */
app.get('/admin/stats', (req, res) => {
  const provided =
    req.headers['authorization'] ||
    req.query.secret             ||
    '';

  if (!ADMIN_SECRET || provided !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Compute totals by channel
  const byChannel = {};
  for (const [channel, classifications] of Object.entries(stats)) {
    byChannel[channel] = Object.values(classifications).reduce((a, b) => a + b, 0);
  }

  // Compute totals by classification
  const byClassification = {};
  for (const classifications of Object.values(stats)) {
    for (const [cat, count] of Object.entries(classifications)) {
      byClassification[cat] = (byClassification[cat] || 0) + count;
    }
  }

  return res.json({
    byChannel,
    byClassification,
    detail:       stats,
    lastMessages: recentMessages.slice().reverse(), // newest first
    uptime:       Math.floor((Date.now() - startedAt) / 1000),
    lastMessage:  lastMessageAt,
  });
});

// ─── 404 fallback ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ─────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[express] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Graceful shutdown ────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('[bridge] SIGTERM received, shutting down...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[bridge] SIGINT received, shutting down...');
  await pool.end();
  process.exit(0);
});

// ─── Startup ──────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║   ALA Legal — ManyChat Bridge v2.1   ║');
  console.log('╚═══════════════════════════════════════╝');

  // Auto-migrate: create tables if they don't exist
  try {
    await ensureTables();
  } catch (err) {
    // Log but don't crash — bridge can operate without DB (logs will fail gracefully)
    console.error('[startup] DB migration failed (bridge will continue without DB logging):', err.message);
  }

  // Warm the ManyChat custom field ID cache on startup
  if (MANYCHAT_API_KEY) {
    try {
      await warmFieldCache();
    } catch (err) {
      console.warn('[startup] Could not warm field cache:', err.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`[bridge] Listening on port ${PORT}`);
    console.log(`[bridge] Agent URL: ${SUPERWAVE_WEBHOOK_URL}`);
    console.log(`[bridge] DB: ${DATABASE_URL.replace(/:([^:@]+)@/, ':***@')}`);
  });
}

main().catch((err) => {
  console.error('[startup] Fatal error:', err.message);
  process.exit(1);
});
