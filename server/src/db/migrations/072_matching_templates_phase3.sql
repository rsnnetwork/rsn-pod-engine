-- 072 — Matching Engine Phase 3: configurable templates.
--
-- Additive + idempotent. The legacy template model exposed only 5 fixed weight
-- columns, mapped lossily to the engine and ignoring every Phase 1/2 signal
-- (intent, designation, avoid, event-intention) plus premium/learning. Phase 3
-- moves templates to a single `weights` JSONB holding the FULL, correctly-named
-- engine weight set, so a template fully configures the engine and new signals
-- need no migration. A template can also carry its own matching policy + cooldown.
--
-- The legacy weight_* columns are kept (nullable now) for backward read-compat;
-- the service prefers `weights` when present. No data is dropped.
ALTER TABLE matching_templates
  ADD COLUMN IF NOT EXISTS weights JSONB,
  ADD COLUMN IF NOT EXISTS matching_policy VARCHAR(20),
  ADD COLUMN IF NOT EXISTS cooldown_months INTEGER;

-- Backfill `weights` for existing rows from the legacy columns, preserving each
-- template's current behaviour exactly (same lossy legacy mapping the service
-- used), and filling the Phase 1/2 + premium/learning signals with engine defaults.
UPDATE matching_templates SET weights = jsonb_build_object(
  'sharedInterests',        COALESCE(weight_interests, 0.25),
  'sharedReasons',          COALESCE(weight_intent, 0.25),
  'industryDiversity',      COALESCE(weight_industry, 0.15),
  'companyDiversity',       CASE WHEN same_company_allowed THEN 0 ELSE 0.15 END,
  'languageMatch',          COALESCE(weight_location, 0.10),
  'encounterFreshness',     COALESCE(weight_experience, 0.10),
  'mutualPremiumRequest',   0.20,
  'singlePremiumRequest',   0.10,
  'premiumBoost',           0.03,
  'mutualMeetAgainBoost',   0.05,
  'intentAlignment',        0.20,
  'designationDiversity',   0.10,
  'avoidPenalty',           0.15,
  'eventIntentionAlignment',0.15
) WHERE weights IS NULL;

-- Legacy columns become optional (new templates write only `weights`).
ALTER TABLE matching_templates ALTER COLUMN weight_industry   DROP NOT NULL;
ALTER TABLE matching_templates ALTER COLUMN weight_interests  DROP NOT NULL;
ALTER TABLE matching_templates ALTER COLUMN weight_intent     DROP NOT NULL;
ALTER TABLE matching_templates ALTER COLUMN weight_experience DROP NOT NULL;
ALTER TABLE matching_templates ALTER COLUMN weight_location   DROP NOT NULL;
