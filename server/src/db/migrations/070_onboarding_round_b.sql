-- 070 — Onboarding v1.1 Round B: store confirmed vs guessed separately.
--
-- Stefan's doc calls for keeping what the member CONFIRMED on the card distinct
-- from what we GUESSED (inferred name/country/company + per-field confidence), so
-- matching can weight confirmed data higher and we can audit our inferences. The
-- richer extracted dimensions (valuable-to, suggested invitees, current focus,
-- match priority, city) ride inside the existing matching_intent JSONB, so no new
-- columns are needed for those.
--
-- Additive + idempotent (safe to re-run). No inner BEGIN/COMMIT: the migration
-- runner wraps each file in its own transaction.

ALTER TABLE user_intent_profiles
  ADD COLUMN IF NOT EXISTS confirmed_profile JSONB NOT NULL DEFAULT '{}',  -- what the member confirmed on the card (name/country/company/role/linkedin)
  ADD COLUMN IF NOT EXISTS inferred_profile  JSONB NOT NULL DEFAULT '{}';  -- what we guessed + which fields were guesses (the "guessed, kept separate")
