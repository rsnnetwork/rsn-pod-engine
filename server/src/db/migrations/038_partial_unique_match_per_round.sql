-- Migration 038: Make unique_match_per_round a partial index (exclude cancelled/no_show)
--
-- This matches the pattern used for participant_b and participant_c indexes
-- (migration 029). Without this, host-remove sets match to cancelled and then
-- host cannot create a new match for the same participant_a in the same round.

BEGIN;

-- Drop the existing non-partial constraint
ALTER TABLE matches DROP CONSTRAINT IF EXISTS unique_match_per_round;
DROP INDEX IF EXISTS unique_match_per_round;

-- Recreate as partial unique index matching participant_b/c pattern
CREATE UNIQUE INDEX unique_match_per_round
  ON matches (session_id, round_number, participant_a_id)
  WHERE status NOT IN ('cancelled', 'no_show');

COMMIT;
