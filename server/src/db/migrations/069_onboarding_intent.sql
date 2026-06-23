-- 069 — Onboarding intent capture (REASON pivot, "build the brain").
--
-- Adds the data layer for the onboarding chatbot: a per-user onboarding
-- lifecycle status, and a flexible `user_intent_profiles` table that stores the
-- structured intent the host conversation extracts (who you want to meet, why,
-- who you are) plus matching tags, an embedding_text staged for a later vector
-- increment, the raw conversation, and confidence/strength signals.
--
-- The existing `users` onboarding gate (onboarding_completed + profile_complete)
-- is untouched; on confirm the service dual-writes the rich blob here AND the
-- existing `users` columns the in-event matcher already reads.
--
-- Additive + idempotent (safe to re-run). No inner BEGIN/COMMIT: the migration
-- runner (db/migrate.ts) already wraps each file in its own transaction.

-- Onboarding lifecycle enum — idempotent create (matches the OnboardingStatus
-- union in @rsn/shared).
DO $$ BEGIN
  CREATE TYPE onboarding_status AS ENUM (
    'not_started',
    'in_progress',
    'completed',
    'needs_review',
    'update_required'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_status onboarding_status NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS last_onboarded_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS user_intent_profiles (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  matching_intent         JSONB        NOT NULL DEFAULT '{}',   -- desired_people/roles/seniority/stage/industries, reason_for_meeting, desired_outcome, user_* fields
  matching_tags           TEXT[]       NOT NULL DEFAULT '{}',
  embedding_text          TEXT,                                  -- prepared now, embedded in a later increment
  profile_summary         TEXT,                                  -- short human-readable summary
  avoid_preferences       TEXT[]       NOT NULL DEFAULT '{}',
  privacy_preference      VARCHAR(40)  NOT NULL DEFAULT 'normal',
  confidence              JSONB        NOT NULL DEFAULT '{}',
  profile_strength        VARCHAR(20),                           -- 'strong' | 'weak'
  onboarding_conversation JSONB        NOT NULL DEFAULT '[]',    -- full host/user transcript
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uip_tags   ON user_intent_profiles USING GIN (matching_tags);
CREATE INDEX IF NOT EXISTS idx_uip_intent ON user_intent_profiles USING GIN (matching_intent);
