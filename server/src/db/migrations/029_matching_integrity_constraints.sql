-- Migration 029: Enforce matching integrity constraints for scale (200+ participants)
--
-- Problems fixed:
-- 1. participant_b_id has NO uniqueness constraint — same user can be participant_b
--    in multiple matches within the same round
-- 2. participant_c_id has NO uniqueness constraint — same user can appear unlimited times
-- 3. No constraint prevents (A=user1, B=user2) AND (A=user3, B=user1) in same round
-- 4. Auto-reassignment inserts bypass application-level checks
--
-- Solution: DB-level enforcement — one user, one room, one round. Period.

-- ═══ Step 0: Clean up existing duplicate data ═══
-- Mark duplicate participant_b entries as cancelled (keep the earliest match, cancel later ones)
UPDATE matches SET status = 'cancelled'
WHERE id IN (
  SELECT m2.id FROM matches m1
  JOIN matches m2 ON m1.session_id = m2.session_id
    AND m1.round_number = m2.round_number
    AND m1.participant_b_id = m2.participant_b_id
    AND m1.id < m2.id
    AND m1.status NOT IN ('cancelled', 'no_show')
    AND m2.status NOT IN ('cancelled', 'no_show')
);

-- Mark duplicate participant_c entries as cancelled
UPDATE matches SET status = 'cancelled'
WHERE id IN (
  SELECT m2.id FROM matches m1
  JOIN matches m2 ON m1.session_id = m2.session_id
    AND m1.round_number = m2.round_number
    AND m1.participant_c_id = m2.participant_c_id
    AND m1.participant_c_id IS NOT NULL
    AND m2.participant_c_id IS NOT NULL
    AND m1.id < m2.id
    AND m1.status NOT IN ('cancelled', 'no_show')
    AND m2.status NOT IN ('cancelled', 'no_show')
);

-- Also cancel matches where a user appears as participant_b in one match
-- and participant_a or participant_c in another (cross-column duplicates)
UPDATE matches SET status = 'cancelled'
WHERE id IN (
  SELECT m2.id FROM matches m1
  JOIN matches m2 ON m1.session_id = m2.session_id
    AND m1.round_number = m2.round_number
    AND m1.id < m2.id
    AND m1.status NOT IN ('cancelled', 'no_show')
    AND m2.status NOT IN ('cancelled', 'no_show')
    AND (
      m1.participant_a_id IN (m2.participant_a_id, m2.participant_b_id, m2.participant_c_id)
      OR m1.participant_b_id IN (m2.participant_a_id, m2.participant_b_id, m2.participant_c_id)
      OR (m1.participant_c_id IS NOT NULL AND m1.participant_c_id IN (m2.participant_a_id, m2.participant_b_id, m2.participant_c_id))
    )
);

-- ═══ Step 1: Add unique index on participant_b per round ═══
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_participant_b_per_round
  ON matches (session_id, round_number, participant_b_id)
  WHERE status NOT IN ('cancelled', 'no_show');

-- ═══ Step 2: Add unique partial index on participant_c per round ═══
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_participant_c_per_round
  ON matches (session_id, round_number, participant_c_id)
  WHERE participant_c_id IS NOT NULL AND status NOT IN ('cancelled', 'no_show');

-- ═══ Step 3: Cross-column uniqueness trigger ═══
CREATE OR REPLACE FUNCTION check_participant_uniqueness_per_round()
RETURNS TRIGGER AS $$
DECLARE
  conflict_count INTEGER;
BEGIN
  -- Skip cancelled/no_show matches
  IF NEW.status IN ('cancelled', 'no_show') THEN
    RETURN NEW;
  END IF;

  -- Check if any participant in this new match already appears in another active match this round
  SELECT COUNT(*) INTO conflict_count
  FROM matches m
  WHERE m.session_id = NEW.session_id
    AND m.round_number = NEW.round_number
    AND m.id != NEW.id
    AND m.status NOT IN ('cancelled', 'no_show')
    AND (
      NEW.participant_a_id IN (m.participant_a_id, m.participant_b_id, m.participant_c_id)
      OR NEW.participant_b_id IN (m.participant_a_id, m.participant_b_id, m.participant_c_id)
      OR (NEW.participant_c_id IS NOT NULL AND NEW.participant_c_id IN (m.participant_a_id, m.participant_b_id, m.participant_c_id))
    );

  IF conflict_count > 0 THEN
    RAISE EXCEPTION 'PARTICIPANT_ALREADY_MATCHED: One or more participants are already in an active match for session % round %',
      NEW.session_id, NEW.round_number;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_participant_uniqueness ON matches;

CREATE TRIGGER trg_check_participant_uniqueness
  BEFORE INSERT ON matches
  FOR EACH ROW
  EXECUTE FUNCTION check_participant_uniqueness_per_round();

-- ═══ Step 4: Also enforce on UPDATE ═══
DROP TRIGGER IF EXISTS trg_check_participant_uniqueness_update ON matches;

CREATE TRIGGER trg_check_participant_uniqueness_update
  BEFORE UPDATE ON matches
  FOR EACH ROW
  WHEN (OLD.status IN ('cancelled', 'no_show') AND NEW.status NOT IN ('cancelled', 'no_show'))
  EXECUTE FUNCTION check_participant_uniqueness_per_round();
