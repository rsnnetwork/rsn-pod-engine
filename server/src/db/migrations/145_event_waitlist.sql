-- An event's waiting list (10 Nov 2026 spec, Part 3 Task 3; plan K3).
--
-- An event that is full (sessions.config.maxParticipants places held) puts the next eligible person on its waiting
-- list instead of refusing them, and promotes the first in line when a place frees. The list is its own table, never
-- a participant status: every participant query (rooms, reminders, matching, DMs, counts) reads session_participants
-- and so never sees anyone who is only waiting.
--
--   status       waiting (in the line), promoted (given a place), left (took themselves off), removed (an organiser
--                took them off), lapsed (no longer allowed in when their turn came; lapsed_reason says why).
--   joined_via   how they reached the line: the event page (register), the RSN Call link, an approved request, an
--                accepted invite. Promotion re-runs every rule with the same say-so.
--   group_keys   the group they chose (an event with matching groups), checked on joining and written at promotion.
--   queued_at    the line's order (with id). A person who left or lapsed and joins again goes to the back.
--   invite_id    the invite they accepted when it put them on the line (a shared link records only its first accepter,
--                so the row remembers which link it was); promotion admits them through it while it still stands.
--
-- notifications_type_check is restated in full: 135's list plus 'event_waitlist_promoted' (the bell a promoted person
-- gets). The promotion email's admin switch is seeded on.
--
-- No BEGIN/COMMIT: the runner wraps each file in its own transaction. Safe to run twice: every statement is guarded.

CREATE TABLE IF NOT EXISTS event_waitlist (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'waiting'
                CHECK (status IN ('waiting', 'promoted', 'left', 'removed', 'lapsed')),
  joined_via    TEXT NOT NULL CHECK (joined_via IN ('register', 'call_link', 'approval', 'invite')),
  group_keys    TEXT[] NOT NULL DEFAULT '{}',
  lapsed_reason TEXT NULL CHECK (lapsed_reason IS NULL OR char_length(lapsed_reason) <= 64),
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ NULL,
  decided_by    UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, user_id)
);

-- The invite that queued the person (fix round 3, a column of this same unshipped migration): guarded on its own, so a
-- table made by an earlier run of this file gains it too. Deleting the invite keeps the row, without it.
ALTER TABLE event_waitlist ADD COLUMN IF NOT EXISTS invite_id UUID NULL REFERENCES invites(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_event_waitlist_invite ON event_waitlist (invite_id) WHERE invite_id IS NOT NULL;

-- The line itself, in order (promotion, positions, the organisers' list).
CREATE INDEX IF NOT EXISTS idx_event_waitlist_line ON event_waitlist (session_id, queued_at, id) WHERE status = 'waiting';
-- A person's own waiting places (their call-link events, an account closed).
CREATE INDEX IF NOT EXISTS idx_event_waitlist_user ON event_waitlist (user_id) WHERE status = 'waiting';

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
                  'event_cancelled', 'event_reminder', 'event_rescheduled', 'event_schedule_changed',
                  'event_waitlist_promoted'));

INSERT INTO email_config (email_type, enabled, subject) VALUES
  ('event_waitlist_promoted', TRUE, 'You''re in: {eventTitle}')
ON CONFLICT (email_type) DO NOTHING;
