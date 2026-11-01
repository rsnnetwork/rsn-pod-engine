-- server/src/db/migrations/126_matching_presets.sql
-- Speed-networking presets (30 Oct 2026, L19): "Speed networking types, e.g. founders and investors, job-related".
-- Four matching_templates rows any organiser may choose for a speed-networking event; any other template stays a
-- platform admin's pick. Each is a full set of soft engine weights over signals the engine already scores (who people
-- want to meet, complementary roles, the check-in intention): the engine prefers these pairings and forbids none,
-- so the cards say "first". A preset's matching_policy and cooldown_months are left NULL: the event's own rule wins.
--   General                 = the engine defaults (the admin page's "Balanced").
--   Founders and investors  = the admin page's "Investor Day".
--   Jobs and hiring         = the defaults with intent 0.35, designation 0.20, event intention 0.25, industry 0.05.
--   Mentorship              = the admin page's "Mentorship".
-- The ids are fixed (shared MATCHING_PRESET_IDS) so the forms can start on one; migration-126.test.ts holds the two
-- to the same values. Running the file again changes nothing: the column only when missing, the rows only when
-- their id is free. An admin's later edit of a preset's weights is kept.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE matching_templates ADD COLUMN IF NOT EXISTS is_preset BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_matching_templates_preset ON matching_templates (is_preset) WHERE is_preset = TRUE;

INSERT INTO matching_templates (id, name, description, is_default, is_preset, weights) VALUES
  ('5e7b1a5e-0000-4000-8000-000000000001', 'General',
   'A broad mix of people, with shared interests first',
   FALSE, TRUE,
   '{"sharedInterests":0.25,"sharedReasons":0.25,"industryDiversity":0.15,"companyDiversity":0.15,"languageMatch":0.10,"encounterFreshness":0.10,"mutualPremiumRequest":0.20,"singlePremiumRequest":0.10,"premiumBoost":0.03,"mutualMeetAgainBoost":0.05,"intentAlignment":0.20,"designationDiversity":0.10,"avoidPenalty":0.15,"eventIntentionAlignment":0.15}'::jsonb),
  ('5e7b1a5e-0000-4000-8000-000000000002', 'Founders and investors',
   'Founders meet investors first',
   FALSE, TRUE,
   '{"sharedInterests":0.10,"sharedReasons":0.15,"industryDiversity":0.05,"companyDiversity":0.15,"languageMatch":0.10,"encounterFreshness":0.10,"mutualPremiumRequest":0.20,"singlePremiumRequest":0.10,"premiumBoost":0.03,"mutualMeetAgainBoost":0.05,"intentAlignment":0.30,"designationDiversity":0.25,"avoidPenalty":0.20,"eventIntentionAlignment":0.25}'::jsonb),
  ('5e7b1a5e-0000-4000-8000-000000000003', 'Jobs and hiring',
   'People hiring meet people looking for a role first',
   FALSE, TRUE,
   '{"sharedInterests":0.25,"sharedReasons":0.25,"industryDiversity":0.05,"companyDiversity":0.15,"languageMatch":0.10,"encounterFreshness":0.10,"mutualPremiumRequest":0.20,"singlePremiumRequest":0.10,"premiumBoost":0.03,"mutualMeetAgainBoost":0.05,"intentAlignment":0.35,"designationDiversity":0.20,"avoidPenalty":0.15,"eventIntentionAlignment":0.25}'::jsonb),
  ('5e7b1a5e-0000-4000-8000-000000000004', 'Mentorship',
   'Mentors meet people looking for guidance first',
   FALSE, TRUE,
   '{"sharedInterests":0.25,"sharedReasons":0.20,"industryDiversity":0.05,"companyDiversity":0.15,"languageMatch":0.10,"encounterFreshness":0.10,"mutualPremiumRequest":0.20,"singlePremiumRequest":0.10,"premiumBoost":0.03,"mutualMeetAgainBoost":0.05,"intentAlignment":0.25,"designationDiversity":0.30,"avoidPenalty":0.15,"eventIntentionAlignment":0.20}'::jsonb)
ON CONFLICT (id) DO NOTHING;
