-- 071 — Matching Engine Phase 2: richer match storage + per-event intention.
--
-- Additive + idempotent (safe to re-run). No inner BEGIN/COMMIT (the runner
-- wraps each file in its own transaction). No backfills.
--
-- matches: store which template produced the pairing, a 0..1 confidence, and an
-- is_override flag (host hand-swap; defaults FALSE — wired in Phase 3). Foundation
-- for the matching analytics. matching_template_id is a plain nullable UUID (null
-- = default engine, no template); analytics treats null accordingly.
ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS matching_template_id UUID,
  ADD COLUMN IF NOT EXISTS confidence DECIMAL(5,4),
  ADD COLUMN IF NOT EXISTS is_override BOOLEAN NOT NULL DEFAULT FALSE;

-- session_participants: per-event intention captured at check-in (separate from
-- the permanent onboarding profile) + openness-to-unexpected (serendipity dial).
ALTER TABLE session_participants
  ADD COLUMN IF NOT EXISTS event_intention VARCHAR(60),
  ADD COLUMN IF NOT EXISTS openness VARCHAR(20);
