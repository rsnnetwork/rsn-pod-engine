-- 033_onboarding_completed.sql
-- Track whether user has completed the onboarding flow

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false;

-- Mark all existing users as completed (they have already been through the platform)
UPDATE users SET onboarding_completed = true WHERE onboarding_completed = false;

COMMENT ON COLUMN users.onboarding_completed IS 'Set true after user completes onboarding. Gates onboarding to first login only.';
