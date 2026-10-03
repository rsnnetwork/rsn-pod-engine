-- server/src/db/migrations/101_reason_m1.sql
-- REASON milestone 1 (29 Sep 2026). Save / Pass on a person, what happened
-- after two people met, and the format a meeting request asks for.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS person_responses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response       TEXT NOT NULL CHECK (response IN ('saved', 'passed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id <> target_user_id),
  UNIQUE (user_id, target_user_id)
);
CREATE INDEX IF NOT EXISTS idx_person_responses_user ON person_responses (user_id, response);
CREATE INDEX IF NOT EXISTS idx_person_responses_target ON person_responses (target_user_id);

CREATE TABLE IF NOT EXISTS meeting_outcomes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worth_continuing TEXT NOT NULL CHECK (worth_continuing IN ('yes', 'maybe', 'no')),
  outcome_keys     TEXT[] NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id <> target_user_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_outcomes_pair ON meeting_outcomes (user_id, target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_outcomes_target ON meeting_outcomes (target_user_id);

ALTER TABLE user_pokes
  ADD COLUMN IF NOT EXISTS preferred_format TEXT NULL
  CHECK (preferred_format IN ('video_20', 'coffee', 'message_first'));
