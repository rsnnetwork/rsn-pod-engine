-- Event reminders (Part 2 foundation, Task 10; spec 03 Communications).
--
-- One row is one reminder claimed for one person about one event at one planned start. The UNIQUE key is the claim:
-- the worker INSERTs ... ON CONFLICT DO NOTHING RETURNING, so with several server instances, or after a restart, a
-- person is reminded once. scheduled_for is the event's start at the time of the claim, so an event that is moved has
-- a new key and its people are reminded again at the new time. `emailed` is set once the email has gone out.
-- The bells (event_reminder, event_rescheduled) and the email_config switches were added by migration 135.

CREATE TABLE IF NOT EXISTS event_reminder_sends (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('24h', '1h')),
  scheduled_for TIMESTAMPTZ NOT NULL,
  emailed       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, user_id, kind, scheduled_for)
);

CREATE INDEX IF NOT EXISTS idx_event_reminder_sends_user ON event_reminder_sends (user_id);

-- The worker's candidate read: published, not archived, still scheduled, ordered by start.
CREATE INDEX IF NOT EXISTS idx_sessions_reminder_candidates ON sessions (scheduled_at)
  WHERE status = 'scheduled' AND publication = 'published' AND archived_at IS NULL;
