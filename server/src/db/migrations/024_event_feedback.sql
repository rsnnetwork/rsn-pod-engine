-- Migration 024: Event-Level Feedback
-- Stores post-event qualitative feedback from participants.

BEGIN;

CREATE TABLE IF NOT EXISTS event_feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feedback    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_feedback_session ON event_feedback(session_id);

COMMIT;
