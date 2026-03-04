/**
 * ALA Legal — ManyChat Bridge
 * ============================================================
 * Bridge for the Superwave Factory template.
 * Handles agent-first classification + suggested replies,
 * PostgreSQL logging, ManyChat auto-tagging/custom fields,
 * Kanban lead creation, and Telegram approval workflow
 * before sending final replies back to ManyChat.
 *
 * Channels supported: messenger, instagram, whatsapp, tiktok
 *
 * Data layer: local PostgreSQL (pg) — zero external dependencies
 * beyond ManyChat API and OpenRouter.
 *
 * @author   Superwave Factory
 * @version  3.0.0
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
  // Agent analysis / suggestion
  AGENT_ANALYSIS_TIMEOUT_MS = '18000',
  // Immediate ack returned to ManyChat External Request
  MANYCHAT_ACK_TEXT        = 'Gracias por tu mensaje. Un asesor revisará tu caso y te responderá en breve.',
  // Disable outbound calls for local testing
  BRIDGE_DRY_RUN           = 'false',
  // Telegram review queue
  TELEGRAM_BOT_TOKEN       = '',
  TELEGRAM_REVIEW_CHAT_ID  = '',
  TELEGRAM_WEBHOOK_PATH_TOKEN = '',
  TELEGRAM_WEBHOOK_SECRET  = '',
  TELEGRAM_API_BASE_URL    = 'https://api.telegram.org',
  // Kanban board integration (OpenClaw workspace object API by default)
  KANBAN_API_BASE_URL      = 'http://web:3100',
  KANBAN_OBJECT_NAME       = 'task',
  KANBAN_DEFAULT_STATUS    = 'In Queue',
} = process.env;

const PORT = parseInt(BRIDGE_PORT, 10);
const ANALYSIS_TIMEOUT_MS = Math.max(1000, parseInt(AGENT_ANALYSIS_TIMEOUT_MS, 10) || 18000);
const DRY_RUN = ['1', 'true', 'yes', 'on'].includes(String(BRIDGE_DRY_RUN).toLowerCase());

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

    CREATE TABLE IF NOT EXISTS mc_leads (
      id               BIGSERIAL PRIMARY KEY,
      review_id        TEXT UNIQUE,
      subscriber_id    TEXT        NOT NULL,
      channel          TEXT        NOT NULL,
      first_name       TEXT,
      last_name        TEXT,
      email            TEXT,
      phone            TEXT,
      source_message   TEXT,
      classification   TEXT,
      confidence       NUMERIC(4,2),
      suggested_reply  TEXT,
      kanban_object    TEXT,
      kanban_entry_id  TEXT,
      kanban_status    TEXT,
      metadata         JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mc_pending_reviews (
      review_id         TEXT PRIMARY KEY,
      subscriber_id     TEXT        NOT NULL,
      channel           TEXT        NOT NULL,
      first_name        TEXT,
      last_name         TEXT,
      source_message    TEXT,
      classification    TEXT,
      confidence        NUMERIC(4,2),
      suggested_reply   TEXT,
      status            TEXT        NOT NULL DEFAULT 'pending',
      final_reply       TEXT,
      approved_by_chat  TEXT,
      telegram_message_id TEXT,
      lead_id           BIGINT REFERENCES mc_leads(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at       TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS mc_messages_subscriber_id_idx
      ON mc_messages (subscriber_id);
    CREATE INDEX IF NOT EXISTS mc_messages_created_at_idx
      ON mc_messages (created_at DESC);
    CREATE INDEX IF NOT EXISTS mc_subscribers_channel_idx
      ON mc_subscribers (channel);
    CREATE INDEX IF NOT EXISTS mc_classification_stats_date_idx
      ON mc_classification_stats (date DESC);
    CREATE INDEX IF NOT EXISTS mc_leads_subscriber_id_idx
      ON mc_leads (subscriber_id);
    CREATE INDEX IF NOT EXISTS mc_leads_created_at_idx
      ON mc_leads (created_at DESC);
    CREATE INDEX IF NOT EXISTS mc_pending_reviews_status_idx
      ON mc_pending_reviews (status, created_at DESC);
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

/**
 * Pending approvals waiting for Telegram review.
 * key: review_id
 */
const pendingReviews = new Map();

const AGENT_CLASSIFICATIONS = [
  'consulta_legal',
  'estado_caso',
  'precalificacion',
  'cita',
  'precio',
  'info_general',
  'saludo',
  'spam',
];

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

/**
 * Normalize classification into the supported taxonomy.
 * @param {string} value
 * @returns {string}
 */
function normalizeClassification(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (AGENT_CLASSIFICATIONS.includes(raw)) return raw;
  return 'info_general';
}

/**
 * Clamp confidence value to [0,1].
 * @param {unknown} value
 * @returns {number}
 */
function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, parseFloat(n.toFixed(2))));
}

/**
 * Extract the first JSON object from free-form model output.
 * @param {string} text
 * @returns {string|null}
 */
function extractFirstJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : text.trim();

  const firstBrace = candidate.indexOf('{');
  const lastBrace  = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return candidate.slice(firstBrace, lastBrace + 1);
}

/**
 * Default suggested reply when model output is unavailable.
 * @param {string} classification
 * @param {string} firstName
 * @returns {string}
 */
function fallbackSuggestedReply(classification, firstName) {
  const name = firstName || 'gracias por contactarnos';
  if (classification === 'consulta_legal') {
    return `Hola ${name}, lamento la situación. Para ayudarte mejor, compártenos fecha del incidente, ciudad y una breve descripción de lo ocurrido.`;
  }
  if (classification === 'estado_caso') {
    return `Hola ${name}, con gusto revisamos el estado de tu caso. ¿Nos compartes tu número de expediente o el nombre completo del titular?`;
  }
  if (classification === 'precalificacion') {
    return `Hola ${name}, te ayudamos con tu precalificación. ¿Nos compartes tu CURP y NSS para validar tus opciones?`;
  }
  if (classification === 'cita') {
    return `Hola ${name}, claro que sí. ¿Qué día y horario te funcionan para agendar una llamada o cita?`;
  }
  if (classification === 'precio') {
    return `Hola ${name}, con gusto te explicamos costos y esquema de trabajo. ¿Prefieres llamada o mensaje para darte detalles?`;
  }
  if (classification === 'spam') {
    return 'Gracias. Tu mensaje fue recibido.';
  }
  return `Hola ${name}, gracias por escribirnos. ¿Nos compartes un poco más de detalle para ayudarte mejor?`;
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
  if (DRY_RUN || !MANYCHAT_API_KEY) return `dryrun-tag-${tagName}`;
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
  if (DRY_RUN || !MANYCHAT_API_KEY) return;
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
  if (DRY_RUN || !MANYCHAT_API_KEY) return;
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
  if (DRY_RUN || !MANYCHAT_API_KEY) return;
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
 * Forward payload to the Superwave Rust agent.
 *
 * @param {object} payload - Message payload to forward
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.raw]
 * @returns {Promise<any>}
 */
async function forwardToAgent(payload, opts = {}) {
  const body = {
    ...payload,
    wait_for_response: true,
  };
  if (SUPERWAVE_WEBHOOK_SECRET) {
    body.secret = SUPERWAVE_WEBHOOK_SECRET;
  }

  const timeoutMs = Math.max(1000, parseInt(opts.timeoutMs, 10) || 30000);

  const { data } = await axios.post(SUPERWAVE_WEBHOOK_URL, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs,
  });

  if (opts.raw) return data;

  // The Superwave agent returns { response: "..." } or { text: "..." }
  return data?.response || data?.text || data?.message || JSON.stringify(data);
}

/**
 * Ask the agent to classify and draft a suggested Spanish reply.
 * Keeps regex classification as fallback if model output is malformed.
 *
 * @param {object} params
 * @returns {Promise<{classification:string, confidence:number, suggested_reply:string, lead_summary:string, lead_title:string}>}
 */
async function analyzeWithAgent(params) {
  const heuristic = classifyMessage(params.messageText);

  const instruction = [
    'Analiza el mensaje entrante de un posible cliente para ALA Legal.',
    'Devuelve SOLO JSON válido (sin markdown, sin explicación) con esta forma exacta:',
    '{"classification":"consulta_legal|estado_caso|precalificacion|cita|precio|info_general|saludo|spam","confidence":0.0,"suggested_reply":"...","lead_title":"...","lead_summary":"..."}',
    `Clasificación heurística previa: ${heuristic.category} (confidence=${heuristic.confidence}).`,
    'La suggested_reply debe ser breve, empática y en español mexicano.',
    'lead_title y lead_summary deben servir para un tablero kanban comercial.',
    '',
    `Canal: ${params.channel}`,
    `Suscriptor: ${params.firstName || ''} ${params.lastName || ''}`.trim(),
    `Mensaje del usuario: """${params.messageText}"""`,
  ].join('\n');

  let raw = '';
  try {
    raw = await forwardToAgent(
      {
        content: instruction,
        thread_id: `manychat:analysis:${params.subscriberId}`,
      },
      {
        timeoutMs: ANALYSIS_TIMEOUT_MS,
      }
    );
  } catch (err) {
    console.warn('[agent] analysis call failed, falling back to local classifier:', err.message);
  }

  const fallbackClassification = normalizeClassification(heuristic.category);
  const fallbackConfidence = normalizeConfidence(heuristic.confidence);
  const fallbackReply = fallbackSuggestedReply(fallbackClassification, params.firstName);

  const jsonText = extractFirstJsonObject(raw);
  if (!jsonText) {
    return {
      classification: fallbackClassification,
      confidence: fallbackConfidence,
      suggested_reply: fallbackReply,
      lead_title: `Lead ${fallbackClassification} — ${params.firstName || params.subscriberId}`,
      lead_summary: params.messageText.slice(0, 280),
    };
  }

  try {
    const parsed = JSON.parse(jsonText);
    const classification = normalizeClassification(parsed.classification || parsed.category);
    const confidence = normalizeConfidence(parsed.confidence);
    const suggestedReply = String(parsed.suggested_reply || parsed.suggestedReply || '').trim() || fallbackReply;
    const leadTitle = String(parsed.lead_title || parsed.leadTitle || '').trim()
      || `Lead ${classification} — ${params.firstName || params.subscriberId}`;
    const leadSummary = String(parsed.lead_summary || parsed.leadSummary || '').trim()
      || params.messageText.slice(0, 280);

    return {
      classification,
      confidence,
      suggested_reply: suggestedReply,
      lead_title: leadTitle,
      lead_summary: leadSummary,
    };
  } catch (err) {
    console.warn('[agent] analysis JSON parse failed, falling back:', err.message);
    return {
      classification: fallbackClassification,
      confidence: fallbackConfidence,
      suggested_reply: fallbackReply,
      lead_title: `Lead ${fallbackClassification} — ${params.firstName || params.subscriberId}`,
      lead_summary: params.messageText.slice(0, 280),
    };
  }
}

/**
 * Infer kanban priority from classification.
 * @param {string} classification
 * @returns {'High'|'Medium'|'Low'}
 */
function leadPriority(classification) {
  if (classification === 'consulta_legal' || classification === 'estado_caso') return 'High';
  if (classification === 'precalificacion' || classification === 'cita' || classification === 'precio') return 'Medium';
  return 'Low';
}

/**
 * Create/update lead record in local PostgreSQL.
 * @param {object} lead
 * @returns {Promise<number|null>}
 */
async function saveLeadRecord(lead) {
  try {
    const result = await pool.query(
      `INSERT INTO mc_leads
         (review_id, subscriber_id, channel, first_name, last_name, email, phone,
          source_message, classification, confidence, suggested_reply,
          kanban_object, kanban_entry_id, kanban_status, metadata, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (review_id) DO UPDATE SET
         classification = EXCLUDED.classification,
         confidence = EXCLUDED.confidence,
         suggested_reply = EXCLUDED.suggested_reply,
         kanban_entry_id = EXCLUDED.kanban_entry_id,
         kanban_status = EXCLUDED.kanban_status,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id`,
      [
        lead.review_id || null,
        lead.subscriber_id,
        lead.channel,
        lead.first_name || null,
        lead.last_name || null,
        lead.email || null,
        lead.phone || null,
        lead.source_message || null,
        lead.classification || null,
        lead.confidence != null ? lead.confidence : null,
        lead.suggested_reply || null,
        lead.kanban_object || null,
        lead.kanban_entry_id || null,
        lead.kanban_status || null,
        lead.metadata ? JSON.stringify(lead.metadata) : null,
      ]
    );
    return result.rows?.[0]?.id || null;
  } catch (err) {
    console.error('[pg] saveLeadRecord error:', err.message);
    return null;
  }
}

/**
 * Persist pending review status (best effort).
 * @param {object} review
 */
async function savePendingReview(review) {
  pendingReviews.set(review.review_id, review);
  try {
    await pool.query(
      `INSERT INTO mc_pending_reviews
         (review_id, subscriber_id, channel, first_name, last_name, source_message,
          classification, confidence, suggested_reply, status, final_reply,
          approved_by_chat, telegram_message_id, lead_id, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (review_id) DO UPDATE SET
         status = EXCLUDED.status,
         final_reply = EXCLUDED.final_reply,
         approved_by_chat = EXCLUDED.approved_by_chat,
         telegram_message_id = EXCLUDED.telegram_message_id,
         lead_id = COALESCE(EXCLUDED.lead_id, mc_pending_reviews.lead_id),
         reviewed_at = EXCLUDED.reviewed_at`,
      [
        review.review_id,
        review.subscriber_id,
        review.channel,
        review.first_name || null,
        review.last_name || null,
        review.source_message || null,
        review.classification || null,
        review.confidence != null ? review.confidence : null,
        review.suggested_reply || null,
        review.status || 'pending',
        review.final_reply || null,
        review.approved_by_chat || null,
        review.telegram_message_id || null,
        review.lead_id || null,
        review.reviewed_at || null,
      ]
    );
  } catch (err) {
    console.error('[pg] savePendingReview error:', err.message);
  }
}

/**
 * Load pending review from memory or DB.
 * @param {string} reviewId
 * @returns {Promise<object|null>}
 */
async function loadPendingReview(reviewId) {
  if (pendingReviews.has(reviewId)) return pendingReviews.get(reviewId);
  try {
    const { rows } = await pool.query(
      `SELECT * FROM mc_pending_reviews WHERE review_id = $1 LIMIT 1`,
      [reviewId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    const review = {
      review_id: row.review_id,
      subscriber_id: row.subscriber_id,
      channel: row.channel,
      first_name: row.first_name || '',
      last_name: row.last_name || '',
      source_message: row.source_message || '',
      classification: row.classification || 'info_general',
      confidence: row.confidence != null ? Number(row.confidence) : 0,
      suggested_reply: row.suggested_reply || '',
      status: row.status || 'pending',
      final_reply: row.final_reply || null,
      approved_by_chat: row.approved_by_chat || null,
      telegram_message_id: row.telegram_message_id || null,
      lead_id: row.lead_id || null,
      reviewed_at: row.reviewed_at || null,
    };
    pendingReviews.set(reviewId, review);
    return review;
  } catch (_err) {
    return null;
  }
}

/**
 * Create lead on workspace kanban object API.
 * @param {object} lead
 * @returns {Promise<{ok:boolean, entryId:string|null, error?:string}>}
 */
async function createKanbanLead(lead) {
  const objectName = String(KANBAN_OBJECT_NAME || 'task');
  const url = `${String(KANBAN_API_BASE_URL || '').replace(/\/+$/, '')}/api/workspace/objects/${encodeURIComponent(objectName)}/entries`;

  const fields = {
    Title: lead.lead_title,
    Description: lead.source_message,
    Status: KANBAN_DEFAULT_STATUS,
    Priority: leadPriority(lead.classification),
    Notes: [
      `Clasificación: ${lead.classification} (${lead.confidence})`,
      `Canal: ${lead.channel}`,
      `Suscriptor: ${lead.first_name || ''} ${lead.last_name || ''}`.trim(),
      `Resumen: ${lead.lead_summary || ''}`,
      '',
      `Sugerencia de respuesta: ${lead.suggested_reply || ''}`,
    ].join('\n'),
  };

  if (DRY_RUN) {
    console.log('[kanban] DRY_RUN create lead', { url, fields });
    return { ok: true, entryId: `dryrun-${crypto.randomUUID()}` };
  }

  try {
    const { data } = await axios.post(url, { fields }, { timeout: 8000 });
    return {
      ok: true,
      entryId: data?.entryId ? String(data.entryId) : null,
    };
  } catch (err) {
    return {
      ok: false,
      entryId: null,
      error: err?.response?.data ? JSON.stringify(err.response.data) : err.message,
    };
  }
}

/**
 * Send a text message through Telegram Bot API.
 * @param {string|number} chatId
 * @param {string} text
 * @returns {Promise<{ok:boolean,messageId:string|null,error?:string}>}
 */
async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    return { ok: false, messageId: null, error: 'Telegram bot/chat not configured' };
  }

  const url = `${TELEGRAM_API_BASE_URL}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: String(chatId),
    text,
    disable_web_page_preview: true,
  };

  if (DRY_RUN) {
    console.log('[telegram] DRY_RUN sendMessage', { url, body });
    return { ok: true, messageId: `dryrun-${crypto.randomUUID()}` };
  }

  try {
    const { data } = await axios.post(url, body, { timeout: 8000 });
    return {
      ok: !!data?.ok,
      messageId: data?.result?.message_id != null ? String(data.result.message_id) : null,
    };
  } catch (err) {
    return {
      ok: false,
      messageId: null,
      error: err?.response?.data ? JSON.stringify(err.response.data) : err.message,
    };
  }
}

/**
 * Send review request to Telegram queue.
 * @param {object} review
 * @returns {Promise<{ok:boolean,messageId:string|null,error?:string}>}
 */
async function sendTelegramReview(review) {
  const lines = [
    '🆕 Lead ManyChat en revisión',
    `ID: ${review.review_id}`,
    `Canal: ${review.channel}`,
    `Suscriptor: ${(review.first_name || '')} ${(review.last_name || '')}`.trim() || review.subscriber_id,
    `Clasificación: ${review.classification} (${review.confidence})`,
    '',
    'Mensaje del cliente:',
    review.source_message || '(sin contenido)',
    '',
    'Sugerencia del agente:',
    review.suggested_reply || '(sin sugerencia)',
    '',
    `Aprobar sugerencia: /approve ${review.review_id}`,
    `Responder texto custom: /reply ${review.review_id} <tu mensaje>`,
  ];
  return sendTelegramMessage(TELEGRAM_REVIEW_CHAT_ID, lines.join('\n'));
}

/**
 * Try to send final reply to ManyChat outbound API.
 * @param {object} params
 * @returns {Promise<{ok:boolean,error?:string}>}
 */
async function sendManyChatReply(params) {
  const endpoint = responseEndpoint(params.channel);
  const text = String(params.text || '').trim();
  if (!text) return { ok: false, error: 'Empty reply text' };

  if (DRY_RUN) {
    console.log('[manychat] DRY_RUN outbound', {
      endpoint,
      subscriber_id: params.subscriber_id,
      text,
    });
    return { ok: true };
  }

  const payloadA = {
    subscriber_id: params.subscriber_id,
    data: {
      version: 'v2',
      content: {
        messages: [{ type: 'text', text }],
      },
    },
  };

  try {
    await manychat.post(endpoint, payloadA);
    return { ok: true };
  } catch (errA) {
    const payloadB = {
      subscriber_id: params.subscriber_id,
      version: 'v2',
      content: {
        messages: [{ type: 'text', text }],
      },
    };
    try {
      await manychat.post(endpoint, payloadB);
      return { ok: true };
    } catch (errB) {
      return {
        ok: false,
        error: errB?.response?.data
          ? JSON.stringify(errB.response.data)
          : (errA?.response?.data ? JSON.stringify(errA.response.data) : errB.message),
      };
    }
  }
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

  // ── 2. Agent-first analysis (classification + suggested reply) ─────────
  const analysis = await analyzeWithAgent({
    subscriberId,
    firstName,
    lastName,
    channel,
    messageText,
  });
  const category = analysis.classification;
  const confidence = analysis.confidence;
  const suggestedReply = analysis.suggested_reply;
  console.log(`[classify:agent] → ${category} (confidence=${confidence})`);

  // ── 3. Update in-memory state ──────────────────────────────────────────
  lastMessageAt = new Date().toISOString();
  bumpStats(channel, category);
  pushRecent({
    subscriberId,
    firstName,
    channel,
    classification: category,
    confidence,
    messageSnippet: messageText.slice(0, 80),
    suggestedReplySnippet: suggestedReply.slice(0, 80),
    ts: lastMessageAt,
  });

  // ── 4. Fire-and-forget: ManyChat tagging/custom fields ────────────────
  Promise.allSettled([
    tagSubscriber(subscriberId, CLASSIFICATION_TAGS[category] || 'info_general'),
    updateClassificationFields(subscriberId, category, channel),
  ]).catch(() => {/* already handled inside each function */});

  // ── 5. Log inbound + subscriber + stats ────────────────────────────────
  logMessage({
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
      suggested_reply: suggestedReply,
    },
  });

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

  // ── 6. Create kanban lead + pending review ─────────────────────────────
  const reviewId = `rvw_${crypto.randomBytes(6).toString('hex')}`;
  const leadDraft = {
    review_id: reviewId,
    subscriber_id: subscriberId,
    channel,
    first_name: firstName,
    last_name: lastName,
    email,
    phone,
    source_message: messageText,
    classification: category,
    confidence,
    suggested_reply: suggestedReply,
    lead_title: analysis.lead_title,
    lead_summary: analysis.lead_summary,
  };

  const kanban = await createKanbanLead(leadDraft);

  const leadId = await saveLeadRecord({
    ...leadDraft,
    kanban_object: KANBAN_OBJECT_NAME,
    kanban_entry_id: kanban.entryId,
    kanban_status: KANBAN_DEFAULT_STATUS,
    metadata: {
      kanban_ok: kanban.ok,
      kanban_error: kanban.error || null,
      lead_summary: analysis.lead_summary,
    },
  });

  const pending = {
    review_id: reviewId,
    subscriber_id: subscriberId,
    channel,
    first_name: firstName,
    last_name: lastName,
    source_message: messageText,
    classification: category,
    confidence,
    suggested_reply: suggestedReply,
    status: 'pending',
    final_reply: null,
    approved_by_chat: null,
    telegram_message_id: null,
    lead_id: leadId,
    reviewed_at: null,
    created_at: lastMessageAt,
  };

  // ── 7. Send Telegram review request ────────────────────────────────────
  const reviewNotification = await sendTelegramReview(pending);
  pending.telegram_message_id = reviewNotification.messageId || null;
  await savePendingReview(pending);

  if (!reviewNotification.ok) {
    console.warn(`[telegram] Could not notify review queue for ${reviewId}: ${reviewNotification.error}`);
  } else {
    console.log(`[telegram] Review queued: ${reviewId} (msg=${reviewNotification.messageId})`);
  }

  // ── 8. Return immediate ack to ManyChat ─────────────────────────────────
  // Final customer reply is sent after /approve or /reply command from Telegram.
  return res.json({
    version: 'v2',
    content: {
      messages: [
        { type: 'text', text: MANYCHAT_ACK_TEXT },
      ],
    },
    review_id: reviewId,
    classification: category,
    suggested_reply: suggestedReply,
    kanban: {
      ok: kanban.ok,
      entry_id: kanban.entryId,
      object: KANBAN_OBJECT_NAME,
      status: KANBAN_DEFAULT_STATUS,
    },
  });
});

// ─── Telegram review webhook endpoint ─────────────────────────

/**
 * POST /telegram/webhook/:pathToken
 * Receives Telegram bot updates and handles:
 *   /approve <review_id>
 *   /reply <review_id> <custom text>
 *   /pending
 */
app.post('/telegram/webhook/:pathToken', async (req, res) => {
  const { pathToken } = req.params;
  const expectedPathToken = String(TELEGRAM_WEBHOOK_PATH_TOKEN || '').trim();

  if (!expectedPathToken) {
    return res.status(503).json({ error: 'Telegram webhook path token not configured' });
  }

  if (pathToken !== expectedPathToken) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (TELEGRAM_WEBHOOK_SECRET) {
    const provided = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    const expected = String(TELEGRAM_WEBHOOK_SECRET);
    const valid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!valid) {
      return res.status(401).json({ error: 'Invalid Telegram webhook secret' });
    }
  }

  const update = req.body || {};
  const message = update.message || update.edited_message || null;
  const text = String(message?.text || '').trim();
  const chatId = message?.chat?.id != null ? String(message.chat.id) : '';

  if (!text || !chatId) {
    return res.json({ ok: true, ignored: 'no-text' });
  }

  // Optional guard: only process commands from configured review chat.
  if (TELEGRAM_REVIEW_CHAT_ID && String(TELEGRAM_REVIEW_CHAT_ID) !== chatId) {
    return res.json({ ok: true, ignored: 'chat-not-allowed' });
  }

  const approveMatch = text.match(/^\/approve\s+([A-Za-z0-9_-]+)\s*$/i);
  const replyMatch = text.match(/^\/reply\s+([A-Za-z0-9_-]+)\s+([\s\S]+)$/i);
  const pendingCmd = /^\/pending\b/i.test(text);

  if (pendingCmd) {
    const pending = Array.from(pendingReviews.values())
      .filter((item) => item.status === 'pending')
      .slice(0, 10);
    if (!pending.length) {
      await sendTelegramMessage(chatId, 'No hay leads pendientes por aprobar.');
      return res.json({ ok: true, command: 'pending', count: 0 });
    }
    const lines = ['Leads pendientes:'];
    for (const item of pending) {
      lines.push(`- ${item.review_id} | ${item.classification} | ${(item.first_name || item.subscriber_id)}`);
    }
    await sendTelegramMessage(chatId, lines.join('\n'));
    return res.json({ ok: true, command: 'pending', count: pending.length });
  }

  if (!approveMatch && !replyMatch) {
    await sendTelegramMessage(
      chatId,
      'Comando no reconocido.\nUsa:\n/approve <review_id>\n/reply <review_id> <texto>\n/pending'
    );
    return res.json({ ok: true, ignored: 'unknown-command' });
  }

  const reviewId = approveMatch ? approveMatch[1] : replyMatch[1];
  const pending = await loadPendingReview(reviewId);
  if (!pending) {
    await sendTelegramMessage(chatId, `No encontré el review_id ${reviewId}.`);
    return res.json({ ok: true, error: 'review-not-found' });
  }

  if (pending.status !== 'pending') {
    await sendTelegramMessage(chatId, `El review_id ${reviewId} ya fue procesado (status=${pending.status}).`);
    return res.json({ ok: true, error: 'already-processed' });
  }

  const finalReply = approveMatch
    ? String(pending.suggested_reply || '').trim()
    : String(replyMatch[2] || '').trim();

  if (!finalReply) {
    await sendTelegramMessage(chatId, `No se pudo obtener texto final para ${reviewId}.`);
    return res.json({ ok: true, error: 'empty-final-reply' });
  }

  const sendResult = await sendManyChatReply({
    subscriber_id: pending.subscriber_id,
    channel: pending.channel,
    text: finalReply,
  });

  if (!sendResult.ok) {
    await sendTelegramMessage(
      chatId,
      `Error enviando respuesta a ManyChat para ${reviewId}:\n${sendResult.error || 'desconocido'}`
    );
    return res.json({ ok: true, error: 'manychat-send-failed' });
  }

  pending.status = approveMatch ? 'approved' : 'custom_reply';
  pending.final_reply = finalReply;
  pending.approved_by_chat = chatId;
  pending.reviewed_at = new Date().toISOString();
  await savePendingReview(pending);

  logMessage({
    subscriber_id: pending.subscriber_id,
    channel: pending.channel,
    direction: 'outbound',
    content: finalReply,
    classification: pending.classification,
    classification_confidence: pending.confidence,
    metadata: {
      review_id: reviewId,
      approved_by_chat: chatId,
      source: approveMatch ? 'telegram:approve' : 'telegram:reply',
    },
  });

  await sendTelegramMessage(
    chatId,
    `✅ Enviado al cliente (${pending.channel}) para ${reviewId}.\nTexto final:\n${finalReply}`
  );

  return res.json({ ok: true, review_id: reviewId, sent: true });
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
    pendingReviews: Array.from(pendingReviews.values()).filter((r) => r.status === 'pending').length,
    dryRun: DRY_RUN,
    integrations: {
      telegram_review: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_REVIEW_CHAT_ID && TELEGRAM_WEBHOOK_PATH_TOKEN),
      kanban: Boolean(KANBAN_API_BASE_URL && KANBAN_OBJECT_NAME),
      agent_analysis: Boolean(SUPERWAVE_WEBHOOK_URL),
    },
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

/**
 * GET /admin/pending
 * Returns pending review queue for Telegram approval.
 */
app.get('/admin/pending', async (req, res) => {
  const provided =
    req.headers['authorization'] ||
    req.query.secret             ||
    '';

  if (!ADMIN_SECRET || provided !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const inMemory = Array.from(pendingReviews.values())
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  // If DB is available, return authoritative list from DB.
  try {
    const { rows } = await pool.query(
      `SELECT review_id, subscriber_id, channel, first_name, last_name, source_message,
              classification, confidence, suggested_reply, status, final_reply,
              approved_by_chat, created_at, reviewed_at
       FROM mc_pending_reviews
       ORDER BY created_at DESC
       LIMIT 100`
    );
    return res.json({ count: rows.length, pending: rows });
  } catch (_err) {
    return res.json({ count: inMemory.length, pending: inMemory, source: 'memory' });
  }
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
  console.log('║   ALA Legal — ManyChat Bridge v3.0   ║');
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
    console.log(`[bridge] Dry run: ${DRY_RUN ? 'enabled' : 'disabled'}`);
    console.log(`[bridge] Kanban target: ${KANBAN_API_BASE_URL}/api/workspace/objects/${KANBAN_OBJECT_NAME}/entries`);
    console.log(`[bridge] Telegram review queue: ${
      TELEGRAM_BOT_TOKEN && TELEGRAM_REVIEW_CHAT_ID && TELEGRAM_WEBHOOK_PATH_TOKEN
        ? 'configured'
        : 'not configured'
    }`);
  });
}

main().catch((err) => {
  console.error('[startup] Fatal error:', err.message);
  process.exit(1);
});
