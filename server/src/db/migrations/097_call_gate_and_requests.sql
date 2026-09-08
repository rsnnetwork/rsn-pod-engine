-- Migration 097: calls unlock after the first meeting; call requests (9 Sep 2026, Ali)
--
-- Ali's model for a connection: accepted intro → chat only (calls BLOCKED); the
-- pair uses the meeting scheduler; once a scheduled meeting has ACTUALLY
-- HAPPENED (both joined the room) → calls unlock and the scheduler disappears
-- from that chat. Calls then go request → accept, with a duration the caller
-- types (Stefan: "choose the intended duration, start once the other accepts").
--
-- Attendance is stamped per side when a participant enters the scheduled
-- meeting room inside its window; calls_unlocked_at is set once BOTH have.
-- No backfill: existing pairs unlock the same way, by holding a meeting.

ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS meeting_joined_a_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS meeting_joined_b_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS calls_unlocked_at   TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS call_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  from_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('audio', 'video')),
  duration_min    INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 240),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at    TIMESTAMPTZ
);

-- One live request per conversation at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_requests_one_pending
  ON call_requests (conversation_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_call_requests_to_user
  ON call_requests (to_user_id, status);
