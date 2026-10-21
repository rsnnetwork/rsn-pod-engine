-- 106 — onboarding, version 2 (Shradha's brief, 19 Oct 2026).
--
-- Four questions, each with "Something else. I'd like to say it in my own
-- words." The v2 keys go into the existing looking_to_meet, can_offer and
-- self_kinds arrays (their limits, 3 and 2, already fit) beside the v1 keys,
-- which are different strings, so a reader can always tell the two apart. The
-- new question, "What are you hoping to find?", gets its own array, and each
-- "own words" box its own column.
--
-- Additive and idempotent: nothing is dropped, nothing is rewritten, no
-- existing member is touched. No BEGIN/COMMIT (the runner wraps each file).

ALTER TABLE users ADD COLUMN IF NOT EXISTS hoping_to_find TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS meet_other VARCHAR(120);
ALTER TABLE users ADD COLUMN IF NOT EXISTS find_other VARCHAR(120);
ALTER TABLE users ADD COLUMN IF NOT EXISTS find_specific VARCHAR(300);
ALTER TABLE users ADD COLUMN IF NOT EXISTS offer_other VARCHAR(120);
ALTER TABLE users ADD COLUMN IF NOT EXISTS self_other VARCHAR(120);
-- 2 once a member has confirmed version 2; NULL before.
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_version SMALLINT;

DO $$
BEGIN
  -- Q2 is "Select up to three answers." Enforced in Zod too; this is the floor under it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_hoping_to_find_max') THEN
    ALTER TABLE users ADD CONSTRAINT users_hoping_to_find_max
      CHECK (cardinality(hoping_to_find) <= 3);
  END IF;
END $$;

-- The onboarding state reads the member's approved join request by email, as
-- the LinkedIn photo and the first sign-in already do: lower(email) was never
-- indexed.
CREATE INDEX IF NOT EXISTS idx_join_requests_lower_email ON join_requests (lower(email));

-- Every value 100 allowed, restated, plus the two LinkedIn stages of screen 2:
-- the member connected their LinkedIn profile, or chose to continue with email.
ALTER TABLE onboarding_stage_events
  DROP CONSTRAINT IF EXISTS onboarding_stage_events_stage_check;
ALTER TABLE onboarding_stage_events
  ADD CONSTRAINT onboarding_stage_events_stage_check
  CHECK (stage IN (
    -- the eleven from 080
    'enrich_started', 'enrich_found', 'enrich_partial', 'enrich_not_found', 'enrich_failed',
    'photo_captured', 'photo_failed', 'chat_started', 'confirmed', 'fallback_form', 'extract_failed',
    -- the tick-box flow (100)
    'answers_saved', 'tour_shown', 'tour_completed', 'tour_skipped',
    -- onboarding v2 (106)
    'linkedin_connected', 'linkedin_skipped'
  ));
