-- 078_enrichment_state.sql — single source of truth for enrichment state
-- (replaces the implicit 0.15/0.35/0.6 confidence thresholds as state)
DO $$ BEGIN
  CREATE TYPE enrichment_status AS ENUM ('none','searching','found','partial','not_found','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE user_intent_profiles
  ADD COLUMN IF NOT EXISTS enrichment_status enrichment_status NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS enrichment_source TEXT,
  ADD COLUMN IF NOT EXISTS enrichment_error TEXT,
  ADD COLUMN IF NOT EXISTS enrichment_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrichment_completed_at TIMESTAMPTZ;
