-- Migration 064: Exempt manual breakouts from the unique pair-per-round index.
--
-- Migration 057 added idx_matches_unique_pair_per_round, and 060 narrowed it to
-- exclude 'cancelled'/'no_show'. It still counts 'scheduled'/'active'/
-- 'completed'/'reassigned' rows — which is correct for the AUTO matcher (no
-- repeat pair within a round).
--
-- Live consequence (25 May 2026 test event ad90a44e): a host tried to create a
-- MANUAL breakout for two participants who had already been auto-matched
-- together earlier in the same round. Their auto-match was 'completed' (they
-- were back in the main room), but it still counts toward this index, so the
-- manual INSERT hit `duplicate key value violates unique constraint
-- idx_matches_unique_pair_per_round`, the bulk transaction rolled back, and no
-- room was created (the host saw the Create button do nothing).
--
-- Rule: the no-repeat-pair guarantee is an AUTO-matcher concern. A manual host
-- breakout is an explicit, intentional override — if the host puts two people
-- in a room, that must succeed even if they already met this round. Append
--   AND is_manual = FALSE
-- so the unique index applies only to auto matches; manual matches are exempt.
-- Auto-matching keeps its full no-repeat protection ('scheduled'/'active'/
-- 'completed'/'reassigned' auto pairs still collide as before).
--
-- Reversible: migration 065 could recreate the index without the is_manual
-- clause to restore prior behaviour. The new predicate indexes a strict subset
-- of the old one, so CREATE UNIQUE cannot fail on existing data.

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
    AND status NOT IN ('cancelled', 'no_show')
    AND is_manual = FALSE;

COMMIT;
