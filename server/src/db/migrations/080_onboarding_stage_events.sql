-- 080_onboarding_stage_events.sql — per-stage timing + failure trail for the
-- first-users observation phase (spec: "time taken for each stage",
-- "failed searches and errors").
CREATE TABLE IF NOT EXISTS onboarding_stage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN (
    'enrich_started','enrich_found','enrich_partial','enrich_not_found','enrich_failed',
    'photo_captured','photo_failed','chat_started','confirmed','fallback_form','extract_failed')),
  detail JSONB NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ose_user ON onboarding_stage_events(user_id, created_at);
