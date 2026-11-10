-- 135: an event's lifecycle (Part 2 foundation, Task 2; spec 11).
--
-- D1: the lifecycle sits beside sessions.status, which stays the live orchestrator's state machine. Draft and archived
-- are facts of their own:
--   publication            'draft' (seen by the people who run it only) or 'published'. Every existing event, and every
--                          event production's form makes, is 'published' through the default: nothing changes for them.
--   published_at           when it was first published (NULL for the events made before drafts existed).
--   registration_opens_at  registration opens then; NULL: as soon as it is published (every existing event).
--   archived_at / _by      put away after it ended or was cancelled; out of the default lists.
--   cancelled_at / _by     status 'cancelled' keeps its meaning; these say when, by whom and why (cancel_reason,
--   cancel_reason          at most 500 characters).
-- Nothing is backfilled and nothing is rewritten: ADD COLUMN with a constant default changes no stored row.
--
-- The bell allowlist (notifications_type_check) is restated in full: the 24 types 118_notification_types_circles.sql
-- allowed (the latest definition before this one) plus the four event bells Part 2 rings: 'event_cancelled' (this
-- task), 'event_reminder', 'event_rescheduled' and 'event_schedule_changed' (later tasks). Every existing row already
-- passes (the list only adds). notification-types-allowed.test.ts reads the latest definition.
--
-- The admin switches for the three event emails are seeded on (email_config, ON CONFLICT DO NOTHING, so a switch an
-- admin has already set is never overwritten).
--
-- The runner wraps this file in its own transaction: no BEGIN or COMMIT here. Every statement is guarded, so running
-- the file twice changes nothing.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS publication TEXT NOT NULL DEFAULT 'published';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS registration_opens_at TIMESTAMPTZ NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancelled_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cancel_reason TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_publication_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_publication_check
      CHECK (publication IN ('draft', 'published'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_cancel_reason_check') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_cancel_reason_check
      CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 500);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_draft_host ON sessions (host_user_id) WHERE publication = 'draft';
CREATE INDEX IF NOT EXISTS idx_sessions_archived_at ON sessions (archived_at) WHERE archived_at IS NOT NULL;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message',
                  'poke', 'platform_match', 'meeting_confirmed', 'circle_post', 'poke_accepted',
                  'circle_reaction', 'circle_comment', 'circle_reply',
                  'incoming_call', 'availability_updated', 'meeting_proposed',
                  'meeting_reminder', 'meeting_cancelled',
                  'pod_post', 'pod_comment', 'pod_reply', 'pod_reaction',
                  'group_message',
                  'circle_invite',
                  'event_cancelled', 'event_reminder', 'event_rescheduled', 'event_schedule_changed'));

INSERT INTO email_config (email_type, enabled, subject) VALUES
  ('event_cancelled', TRUE, 'Cancelled: {eventTitle}'),
  ('event_reminder', TRUE, 'Reminder: {eventTitle}'),
  ('event_rescheduled', TRUE, 'Rescheduled: {eventTitle}')
ON CONFLICT (email_type) DO NOTHING;
