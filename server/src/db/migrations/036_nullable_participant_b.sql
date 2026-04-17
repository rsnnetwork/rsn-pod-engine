-- Allow single-participant manual rooms (host-created breakout with 1 person)
-- participant_b_id becomes nullable so a match record can exist for solo rooms

ALTER TABLE matches ALTER COLUMN participant_b_id DROP NOT NULL;

-- Update self-match constraint to handle NULL participant_b
ALTER TABLE matches DROP CONSTRAINT IF EXISTS no_self_match;
ALTER TABLE matches ADD CONSTRAINT no_self_match
  CHECK (participant_b_id IS NULL OR participant_a_id <> participant_b_id);
