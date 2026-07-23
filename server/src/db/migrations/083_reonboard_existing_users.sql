-- 083_reonboard_existing_users.sql — route every old-era account through the
-- new onboarding on next login (spec: "Old accounts should not bypass the new
-- process."). Old era = completed the pre-chatbot form (033 backfill) but
-- never produced chatbot intent data (069 default 'not_started').
-- onboarding_completed stays TRUE so platform matching eligibility
-- (platform-match.service) is not regressed during the transition.
-- Ships LAST in the truthful-loop programme, after the always-on gate was
-- verified live in prod by the headed reonboarding-gate spec (23 Jul 2026).
UPDATE users
SET onboarding_status = 'update_required'
WHERE onboarding_status = 'not_started'
  AND onboarding_completed = true;
