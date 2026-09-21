-- 100 — tick-box onboarding (Shradha's deck, 21 Sep 2026, task 1).
--
-- The open-ended chat produced free text that nothing could compare: "why are
-- you here?" gave 36 LLM-extracted fields, none of them filterable. Five steps
-- of fixed options replace it, and every answer is a stable KEY, so two members
-- can actually be compared.
--
-- self_kinds is not in the deck. The five steps never ask who the member IS,
-- yet slide 9 calls ROLE a core matching field that cannot ship blank: matching
-- compares what you want against what the other person is, so without it a
-- tick-box member is invisible to everyone. One more question, same six kinds.
--
-- Additive and idempotent. Nothing is dropped, nothing is rewritten, and no
-- existing member is touched: their free text keeps working through the same
-- scorer. No explicit BEGIN/COMMIT (the runner wraps each file; 092-099 match).

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_intent TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS looking_to_meet TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_offer TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS industries TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS self_kinds TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS industry_other VARCHAR(60);

-- The wizard that explains the product. due_at is stamped at completion so the
-- tour opens once for people who just finished; everyone who onboarded before
-- this has NULL and is never interrupted. E2E users are inserted straight into
-- the table and so are never interrupted either.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_due_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_seen_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tour_outcome TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_tour_outcome_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_tour_outcome_check
      CHECK (tour_outcome IS NULL OR tour_outcome IN ('completed', 'skipped'));
  END IF;
  -- Q2 is "pick up to 3". Enforced in Zod too; this is the floor under it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_looking_to_meet_max') THEN
    ALTER TABLE users ADD CONSTRAINT users_looking_to_meet_max
      CHECK (cardinality(looking_to_meet) <= 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_self_kinds_max') THEN
    ALTER TABLE users ADD CONSTRAINT users_self_kinds_max
      CHECK (cardinality(self_kinds) <= 2);
  END IF;
END $$;

-- A half-finished flow has to survive a refresh, a second device, and the
-- round trip out to Google for a photo. It lives beside the member's intent
-- row rather than in their live matching columns, so an unconfirmed answer
-- never reaches anyone else's suggestions.
ALTER TABLE user_intent_profiles
  ADD COLUMN IF NOT EXISTS onboarding_draft JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The admin inspector reads the stage trail; these are the new stages.
ALTER TABLE onboarding_stage_events
  DROP CONSTRAINT IF EXISTS onboarding_stage_events_stage_check;
ALTER TABLE onboarding_stage_events
  ADD CONSTRAINT onboarding_stage_events_stage_check
  CHECK (stage IN (
    -- all eleven from 080, kept so historical rows stay readable
    'enrich_started', 'enrich_found', 'enrich_partial', 'enrich_not_found', 'enrich_failed',
    'photo_captured', 'photo_failed', 'chat_started', 'confirmed', 'fallback_form', 'extract_failed',
    -- the tick-box flow
    'answers_saved', 'tour_shown', 'tour_completed', 'tour_skipped'
  ));
