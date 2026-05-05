-- Migration 057: Unique pair-per-round constraint on matches (5 May 2026)
--
-- Phase 1 of full spec compliance. The Re-match handler historically
-- only DELETEd 'scheduled' and 'cancelled' rows before regenerating, so
-- any match in another state (confirmed/forced/active) survived and the
-- regenerate stacked NEW rows on top — producing literal duplicate pairs
-- in the same round. Live event 3fc21cbb-... round 4 had this happen on
-- 2026-05-05: pair (5b0c7b21, c52d876d) materialised twice in r4 after
-- four Re-match presses.
--
-- This migration adds a DB-level unique index on the unordered pair
-- (session, round, LEAST(a,b), GREATEST(a,b)) so duplicates cannot
-- physically exist. Combined with the widened DELETE in
-- handleHostRegenerateMatches (same commit), Re-match becomes safe.
--
-- Scope: only fires for 2-person matches (participant_b_id NOT NULL,
-- participant_c_id NULL). Trios have their own check at the engine
-- level (the duplicate-user guard at matching.engine.ts:280) and a
-- different uniqueness shape that we don't conflate here.

BEGIN;

-- Pre-flight assertion: no existing duplicates remain. If this fires the
-- migration aborts with a clear error and the deploy halts. Run the
-- cleanup script (or the surgical DELETE for session 3fc21cbb round 4)
-- before re-attempting.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT 1
    FROM matches
    WHERE participant_b_id IS NOT NULL
      AND participant_c_id IS NULL
    GROUP BY session_id, round_number,
             LEAST(participant_a_id, participant_b_id),
             GREATEST(participant_a_id, participant_b_id)
    HAVING COUNT(*) > 1
  ) AS dups;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Migration 057 aborted: % duplicate pair-per-round group(s) exist. Clean these before retrying.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_unique_pair_per_round
  ON matches (
    session_id,
    round_number,
    LEAST(participant_a_id, participant_b_id),
    GREATEST(participant_a_id, participant_b_id)
  )
  WHERE participant_b_id IS NOT NULL
    AND participant_c_id IS NULL;

COMMIT;
