-- "Already met" (10 Nov 2026, Stefan's feedback): a member marks someone they have met outside the platform.
-- It is private to the marker and one-sided: it only takes the person out of the marker's own suggestions and
-- searches. It is not a connection and writes no encounter_history row (an encounter blocks meeting requests).
CREATE TABLE IF NOT EXISTS already_met (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT already_met_pair_unique UNIQUE (user_id, target_user_id),
  CONSTRAINT already_met_not_self CHECK (user_id <> target_user_id)
);

-- The pair's unique index serves reads by the marker; this one serves the delete cascade and reads by target.
CREATE INDEX IF NOT EXISTS idx_already_met_target ON already_met (target_user_id);
