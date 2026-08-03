-- Migration 086: seed each existing member's first Matching Agent (Wave 2, D4)
--
-- Runs AFTER 085. Nobody should have to redo onboarding to get value from
-- agents: every member who already told us what they want wakes up with one
-- active agent doing that job, and the founder group sees counts immediately.
--
-- The want text is drawn from exactly the columns the platform scorer already
-- reads (who_i_want_to_meet / my_intent / why_i_want_to_meet / goals), so a
-- seeded agent scores identically to how that member matched yesterday.
--
-- The label is a plain, human word taken from the first designation the member
-- actually named. It is intentionally coarse: the member can rename it, and a
-- wrong-but-honest label beats an invented one.
--
-- Idempotent: seeds only for users with no agent yet, so a re-run is a no-op.

BEGIN;

INSERT INTO matching_agents (user_id, label, want_text, status)
SELECT
  u.id,
  CASE
    WHEN want.txt ~* '\m(co-?founder|founder)s?\M'        THEN 'Founders'
    WHEN want.txt ~* '\m(investor|angel|vc|venture)s?\M'  THEN 'Investors'
    WHEN want.txt ~* '\m(developer|engineer|technical|cto)s?\M' THEN 'Developers'
    WHEN want.txt ~* '\m(advisor|adviser|mentor)s?\M'     THEN 'Advisors'
    WHEN want.txt ~* '\m(customer|client|buyer|lead)s?\M' THEN 'Customers'
    WHEN want.txt ~* '\m(partner|collaborat)'             THEN 'Partners'
    WHEN want.txt ~* '\m(manufactur|supplier)'            THEN 'Manufacturers'
    WHEN want.txt ~* '\m(project manager|pm|product manager)s?\M' THEN 'Project managers'
    ELSE 'People I want to meet'
  END,
  LEFT(want.txt, 2000),
  'active'
FROM users u
CROSS JOIN LATERAL (
  SELECT trim(concat_ws(' ',
    NULLIF(u.who_i_want_to_meet, ''),
    NULLIF(u.my_intent, ''),
    NULLIF(u.why_i_want_to_meet, ''),
    NULLIF(array_to_string(u.goals, ' '), '')
  )) AS txt
) AS want
WHERE u.status = 'active'
  AND want.txt <> ''
  AND NOT EXISTS (SELECT 1 FROM matching_agents a WHERE a.user_id = u.id);

COMMIT;
