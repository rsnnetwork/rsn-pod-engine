-- ─── Migration 017: Pod Visibility — Access Models + Join Config ──────────────
-- Adds two new visibility/access modes:
--   public_with_approval: anyone can find and request, director approves (no screening)
--   request_to_join:      anyone can request; optional rules/agreement text shown to requester
-- Also adds join_config JSONB column on pods for storing:
--   { rulesText?: string, agreementText?: string }

ALTER TYPE pod_visibility ADD VALUE IF NOT EXISTS 'public_with_approval';
ALTER TYPE pod_visibility ADD VALUE IF NOT EXISTS 'request_to_join';

-- join_config stores optional director-authored rules + agreement for the request flow
ALTER TABLE pods ADD COLUMN IF NOT EXISTS join_config JSONB;
