-- ============================================================
-- ALA Legal — Supabase Migration
-- Run once via the Supabase SQL editor or psql:
--   psql $DATABASE_URL -f supabase-migration.sql
-- ============================================================

-- ── Messages table ──────────────────────────────────────────
-- Logs every inbound and outbound message through the bridge.
CREATE TABLE IF NOT EXISTS mc_messages (
  id                        UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  subscriber_id             TEXT        NOT NULL,
  channel                   TEXT        NOT NULL CHECK (channel IN ('messenger','instagram','whatsapp','tiktok')),
  direction                 TEXT        NOT NULL CHECK (direction IN ('inbound','outbound')),
  content                   TEXT        NOT NULL,
  classification            TEXT,
  classification_confidence REAL,
  metadata                  JSONB       DEFAULT '{}',
  created_at                TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE  mc_messages IS 'Every inbound and outbound message through the ALA Legal ManyChat bridge';
COMMENT ON COLUMN mc_messages.classification IS 'consulta_legal | estado_caso | precalificacion | cita | precio | info_general | saludo | spam';
COMMENT ON COLUMN mc_messages.classification_confidence IS 'Score 0–1: how confident the classifier was';

-- ── Subscribers table ─────────────────────────────────────────
-- Enriched subscriber data synced from ManyChat.
CREATE TABLE IF NOT EXISTS mc_subscribers (
  subscriber_id     TEXT        PRIMARY KEY,
  first_name        TEXT,
  last_name         TEXT,
  email             TEXT,
  phone             TEXT,
  channel           TEXT,
  tags              TEXT[]      DEFAULT '{}',
  custom_fields     JSONB       DEFAULT '{}',
  first_seen_at     TIMESTAMPTZ DEFAULT now(),
  last_seen_at      TIMESTAMPTZ DEFAULT now(),
  total_messages    INT         DEFAULT 0,
  last_classification TEXT
);

COMMENT ON TABLE mc_subscribers IS 'ManyChat subscriber profiles synced on each message';

-- ── Classification stats ──────────────────────────────────────────
-- Aggregate daily counts per channel + classification for dashboards.
CREATE TABLE IF NOT EXISTS mc_classification_stats (
  id             UUID  DEFAULT gen_random_uuid() PRIMARY KEY,
  date           DATE  NOT NULL DEFAULT CURRENT_DATE,
  channel        TEXT  NOT NULL,
  classification TEXT  NOT NULL,
  count          INT   DEFAULT 0,
  UNIQUE(date, channel, classification)
);

COMMENT ON TABLE mc_classification_stats IS 'Daily aggregated message counts by channel and classification';

-- ── Indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_mc_messages_subscriber    ON mc_messages(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_mc_messages_created       ON mc_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mc_messages_classification ON mc_messages(classification);
CREATE INDEX IF NOT EXISTS idx_mc_messages_channel       ON mc_messages(channel);
CREATE INDEX IF NOT EXISTS idx_mc_subscribers_last_seen  ON mc_subscribers(last_seen_at DESC);

-- ── Row Level Security ────────────────────────────────────────────
ALTER TABLE mc_messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc_subscribers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mc_classification_stats ENABLE ROW LEVEL SECURITY;

-- Allow all operations for now — tighten with service_role policies in production
CREATE POLICY "Allow all for anon" ON mc_messages             FOR ALL USING (true);
CREATE POLICY "Allow all for anon" ON mc_subscribers          FOR ALL USING (true);
CREATE POLICY "Allow all for anon" ON mc_classification_stats FOR ALL USING (true);

-- ── Helper RPC function ───────────────────────────────────────────
-- Used by the bridge to atomically increment the daily classification count.
-- Equivalent to INSERT ... ON CONFLICT DO UPDATE SET count = count + 1
CREATE OR REPLACE FUNCTION increment_classification_stat(
  p_date           DATE,
  p_channel        TEXT,
  p_classification TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO mc_classification_stats (date, channel, classification, count)
  VALUES (p_date, p_channel, p_classification, 1)
  ON CONFLICT (date, channel, classification)
  DO UPDATE SET count = mc_classification_stats.count + 1;
END;
$$;

-- ── Subscriber message counter trigger ───────────────────────────
-- Automatically increments mc_subscribers.total_messages
-- whenever a new inbound message is logged.
CREATE OR REPLACE FUNCTION fn_increment_subscriber_messages()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.direction = 'inbound' THEN
    INSERT INTO mc_subscribers (subscriber_id, total_messages, last_seen_at)
    VALUES (NEW.subscriber_id, 1, NEW.created_at)
    ON CONFLICT (subscriber_id)
    DO UPDATE SET
      total_messages = mc_subscribers.total_messages + 1,
      last_seen_at   = EXCLUDED.last_seen_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_increment_subscriber_messages ON mc_messages;
CREATE TRIGGER trg_increment_subscriber_messages
  AFTER INSERT ON mc_messages
  FOR EACH ROW
  EXECUTE FUNCTION fn_increment_subscriber_messages();
