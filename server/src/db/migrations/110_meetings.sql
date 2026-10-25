-- 110 — one row per confirmed meeting (25 Oct 2026 feedback, CON-04/05).
--
-- Stefan and Claus agreed a time and nothing appeared under Events: "Now we've found a time to
-- meet. What then? ... So we can't meet." A confirmed meeting lived only in the meeting_* columns of
-- the pair's conversation, overwritten by the next one, with no history, no cancel and no reminder.
-- A meetings row is written in the SAME transaction as those columns (production's client and
-- MeetPage still read them), so the two never disagree.
--
-- Only 'scheduled' and 'cancelled' are stored. Upcoming, joinable, live and ended are worked out from
-- the time when a meeting is read. One upcoming meeting per pair is held by the conversation row lock
-- every booking takes, not by an index: an ended meeting keeps 'scheduled', so a unique index would
-- refuse the pair's next meeting.
--
-- The two notification types meetings ring with (meeting_reminder, meeting_cancelled) were added by
-- migration 108, the only migration of this batch that restates notifications_type_check.
--
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS meetings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_a_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id        UUID NULL REFERENCES user_pokes(id) ON DELETE SET NULL,  -- the accepted request
  context           TEXT NULL,               -- that request's note at confirm time: why they meet
  start_at          TIMESTAMPTZ NOT NULL,
  duration_min      INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 240),
  kind              TEXT NOT NULL CHECK (kind IN ('audio', 'video')),
  status            TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  confirmed_by      UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  moved_from        TIMESTAMPTZ NULL,        -- the start it had before its last move
  calendar_sequence INTEGER NOT NULL DEFAULT 0,  -- the calendar file's SEQUENCE, one up per move and on cancel
  cancelled_by      UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at      TIMESTAMPTZ NULL,
  joined_a_at       TIMESTAMPTZ NULL,
  joined_b_at       TIMESTAMPTZ NULL,
  reminder_sent_at  TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_a_id < user_b_id)
);

CREATE INDEX IF NOT EXISTS idx_meetings_user_a ON meetings (user_a_id, start_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_user_b ON meetings (user_b_id, start_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_conversation ON meetings (conversation_id, start_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_due_reminder ON meetings (start_at)
  WHERE status = 'scheduled' AND reminder_sent_at IS NULL;

-- The meeting the conversation's meeting_* columns describe; empty when they describe none, or a
-- legacy day part with no time.
ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS current_meeting_id UUID NULL REFERENCES meetings(id) ON DELETE SET NULL;

-- Backfill the meetings that already have an exact time (legacy day-part confirmations are skipped).
-- Every stored length is already 5 to 240 minutes (the confirm has held it there since 8 Sep); the
-- LEAST/GREATEST only makes sure a stray value can never stop this file, and with it the server's start.
INSERT INTO meetings (conversation_id, user_a_id, user_b_id, start_at, duration_min, kind,
                      confirmed_by, joined_a_at, joined_b_at, created_at)
SELECT c.id, c.user_a_id, c.user_b_id, c.meeting_start_at,
       LEAST(240, GREATEST(5, COALESCE(c.meeting_duration_min, 30))),
       COALESCE(c.meeting_type, 'video'), c.meeting_confirmed_by, c.meeting_joined_a_at, c.meeting_joined_b_at,
       COALESCE(c.meeting_confirmed_at, NOW())
  FROM dm_conversations c
 WHERE c.meeting_start_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.conversation_id = c.id);

UPDATE dm_conversations c SET current_meeting_id = m.id
  FROM meetings m WHERE m.conversation_id = c.id AND c.current_meeting_id IS NULL;
