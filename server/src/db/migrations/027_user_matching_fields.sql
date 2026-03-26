-- ─── Migration: 027_user_matching_fields ───────────────────────────────────────
-- Add structured matching data fields to users table for improved onboarding
-- and matching quality. These map to the 3-step onboarding flow.

ALTER TABLE users ADD COLUMN IF NOT EXISTS professional_role TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_state TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS career_stage TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS goals TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS meeting_preferences TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS matching_notes TEXT;
