-- Migration 040: Add is_manual column to matches table.
--
-- Manual breakout rooms (host-created via the "Room" button) and algorithm-
-- generated rounds are architecturally independent. The is_manual flag is the
-- canonical way to distinguish them in queries — replaces the brittle
-- room_id LIKE '%-host-%' pattern.

BEGIN;

ALTER TABLE matches ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill existing manual matches from room_id pattern (Change 4.5 convention)
UPDATE matches
SET is_manual = TRUE
WHERE room_id LIKE '%-host-%' OR room_id LIKE '%host-%';

-- Index for fast filtering in algorithm exclusion query
CREATE INDEX IF NOT EXISTS idx_matches_session_round_is_manual
  ON matches (session_id, round_number, is_manual);

COMMENT ON COLUMN matches.is_manual IS
  'TRUE if match was created by host via manual breakout. FALSE for algorithm-generated round matches. Manual matches are invisible to the algorithm exclusion logic.';

COMMIT;
