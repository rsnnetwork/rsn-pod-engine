-- server/src/db/migrations/157_circle_requests_and_invite_only.sql
-- Ben field test (13 Nov 2026): "Not everyone needs a Circle." A circle stands for a real community or organisation,
-- so a member asks for one and a platform admin decides; and each circle chooses who can join: open, ask to join, or
-- invitation only. Private circles must keep their restrictions.
--
-- 1. circles.join_policy gains 'invite_only' (nobody can ask; only an invitation from someone who runs it lets a
--    person in). The CHECK from migration 128 is replaced by name.
-- 2. The column's default becomes 'closed'. On 13 Nov a new circle was open for the minute before its maker closed it
--    and someone joined in that minute; the service now writes the maker's choice with the row, and the default stays
--    on the safe side for any other insert. Existing circles keep the policy they have.
-- 3. circle_creation_requests: one row per ask for a new circle. One waiting ask per member and name (a partial unique
--    index the service names as its conflict target); indexes serve the admins' queue (oldest first) and a member's own
--    list. An approval points at the circle it made (SET NULL keeps the ask if that circle is ever deleted outright).
-- 4. notifications_type_check is restated in full: 145's list plus 'circle_request' (the bell platform admins get for
--    a new ask) and 'circle_request_answered' (the bell the member gets when it is approved or declined).
-- 5. email_config gains the switch for the answer's email, seeded on.
--
-- Additive and safe to run twice. No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE circles DROP CONSTRAINT IF EXISTS circles_join_policy_check;
ALTER TABLE circles ADD CONSTRAINT circles_join_policy_check CHECK (join_policy IN ('open', 'closed', 'invite_only'));
ALTER TABLE circles ALTER COLUMN join_policy SET DEFAULT 'closed';

CREATE TABLE IF NOT EXISTS circle_creation_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            VARCHAR(120) NOT NULL,
  description     TEXT NULL,
  purpose         TEXT NOT NULL,
  join_policy     VARCHAR(20) NOT NULL DEFAULT 'closed'
                  CHECK (join_policy IN ('open', 'closed', 'invite_only')),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  decided_by      UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ NULL,
  decline_reason  TEXT NULL,
  circle_id       UUID NULL REFERENCES circles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_circle_creation_requests_pending_name
  ON circle_creation_requests (requester_id, lower(name)) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_circle_creation_requests_pending
  ON circle_creation_requests (created_at, id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_circle_creation_requests_requester
  ON circle_creation_requests (requester_id, created_at DESC);

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
                  'event_waitlist_promoted',
                  'circle_request', 'circle_request_answered'));

INSERT INTO email_config (email_type, enabled, subject) VALUES
  ('circle_request_answered', TRUE, 'Your circle request')
ON CONFLICT (email_type) DO NOTHING;
