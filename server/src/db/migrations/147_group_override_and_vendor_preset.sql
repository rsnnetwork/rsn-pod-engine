-- 147: who may override an event's group rules, and the Buyers and vendors preset (Part 3 Task 12; the product owner's
-- answers of 11 Nov 2026: "THE EVENT OWNER, AND I AM NOT ABLE TO CHOOSE IN THE GROUPS WHO CAN DO IT - I SHOULD"; and
-- vendor matching beside the other speed-networking types).
--
-- 1. event_matching_rules.override_by: the event owner's choice of who may override its group rules. 'owner' is the
--    event's owner (host_user_id) and super admins, the rule before this column existed, so every existing row reads
--    'owner' (the column's default) and nothing changes for them. 'owner_and_cohosts' adds the event's co-hosts. Every
--    override stays audited (match.override). Only the owner or a super admin may change it (the service).
-- 2. A fifth matching_templates preset, Buyers and vendors, with the Founders and investors weights (migration 126) and
--    the fixed id the forms start on (shared MATCHING_PRESET_IDS.buyersVendors). An admin's later edit of its weights is
--    kept: the row is inserted only when its id is free.
--
-- The runner wraps this file in its own transaction: no BEGIN or COMMIT here. Every statement is guarded, so running the
-- file twice changes nothing: the column only when missing, the CHECK dropped if present and added again, the row only
-- when its id is free.

ALTER TABLE event_matching_rules ADD COLUMN IF NOT EXISTS override_by TEXT NOT NULL DEFAULT 'owner';

ALTER TABLE event_matching_rules DROP CONSTRAINT IF EXISTS event_matching_rules_override_by_check;
ALTER TABLE event_matching_rules ADD CONSTRAINT event_matching_rules_override_by_check
  CHECK (override_by IN ('owner', 'owner_and_cohosts'));

INSERT INTO matching_templates (id, name, description, is_default, is_preset, weights) VALUES
  ('5e7b1a5e-0000-4000-8000-000000000005', 'Buyers and vendors',
   'Buyers meet vendors first',
   FALSE, TRUE,
   '{"sharedInterests":0.10,"sharedReasons":0.15,"industryDiversity":0.05,"companyDiversity":0.15,"languageMatch":0.10,"encounterFreshness":0.10,"mutualPremiumRequest":0.20,"singlePremiumRequest":0.10,"premiumBoost":0.03,"mutualMeetAgainBoost":0.05,"intentAlignment":0.30,"designationDiversity":0.25,"avoidPenalty":0.20,"eventIntentionAlignment":0.25}'::jsonb)
ON CONFLICT (id) DO NOTHING;
