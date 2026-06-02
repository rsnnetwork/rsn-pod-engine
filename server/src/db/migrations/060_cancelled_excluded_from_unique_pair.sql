-- Migration 060: Exclude cancelled + no_show matches from the unique pair-per-round index.
--
-- Migration 057 added idx_matches_unique_pair_per_round to prevent literal
-- duplicate pairs from accumulating in a round (Re-match button bug). Its
-- WHERE clause only filtered for 2-person matches and did NOT exclude any
-- status — so once a match row existed for (session, round, a, b) it
-- physically blocked a new INSERT with the same pair regardless of whether
-- the existing row was 'cancelled' or 'no_show'.
--
-- Live consequence (18 May 2026, Stefan test event b4d3478c):
--   1. Host clicks "Another Round" → engine generates round N preview →
--      INSERT INTO matches (status='scheduled').
--   2. Host doesn't like the preview (repeated pairs visible) → "Cancel
--      preview" → handler HARD-DELETEd the scheduled rows so no audit
--      trail remained.
--   3. With this migration in place we change cancel-preview to soft-delete
--      (UPDATE status='cancelled'), but the row would then block any future
--      regeneration of the same pair in the same round.
--
-- Rule: 'cancelled' and 'no_show' are history. They never block new INSERTs
-- — same logic already applied to the active-only partial indexes in
-- migration 041 and the trigger in 042. Migration 057 was the outlier.
--
-- This migration drops the existing index and recreates it with
--   AND status NOT IN ('cancelled', 'no_show')
-- appended to the WHERE clause. Live duplicate-pair protection still
-- applies to 'scheduled', 'active', 'completed', and 'reassigned' rows —
-- which is exactly the set we want to prevent collisions on.

BEGIN;

DROP INDEX IF EXISTS idx_matches_unique_pair_per_round;

CREATE UNIQUE INDEX idx_matches_unique_pair_per_round
  ON matches (
    session_id,
    round_number,
    LEAST(participant_a_id, participant_b_id),
    GREATEST(participant_a_id, participant_b_id)
  )
  WHERE participant_b_id IS NOT NULL
    AND participant_c_id IS NULL
    AND status NOT IN ('cancelled', 'no_show');

COMMIT;
