-- server/src/db/migrations/160_notification_email_outbox.sql
-- Stefan, 21 Nov 2026: "I should only get notifications if I am not online on the platform", "max X notifications a
-- day, and if more than X, then send a mail the next day on what happened on REASON", and "a weekly digest email on
-- what has happened on your account, what is happening in REASON". X = 3.
--
-- 1. notification_email_outbox: one row per member notification email that is waiting, sent, held or let go (a meeting
--    request received or accepted, a direct message, an invite to someone who already has an account). A row waits
--    until send_after (10 minutes when the member is to be emailed only while away); several due rows of one member go
--    out as ONE email. One row per member, kind and thing it is about (the unique index), so a retried write never
--    queues a second email. bell_link is the bell row the same event wrote, so a bell the member has read meanwhile
--    drops the email. Rows go with their member (CASCADE); the person who caused one may close their account and the
--    row stays (SET NULL).
-- 2. notification_email_deliveries: one row per email that went or is going (an instant one, the next-day "Yesterday on
--    REASON", the weekly "Your week on REASON"), counted for the daily cap on the member's own day (local_day). The
--    partial unique index lets one server instance claim a member's daily or weekly email for that day, however many
--    instances run the job.
-- 3. users.last_seen_at: when the member last had REASON in front of them (stamped from the foreground presence ping,
--    at most once a minute). "Was online since this was queued" is read from it.
-- 4. email_config gains the two digest switches: daily_digest on, weekly_digest OFF until the owner has read a sample.
--
-- Additive and safe to run twice. No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS notification_email_outbox (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        VARCHAR(32) NOT NULL
              CHECK (kind IN ('meeting_request', 'meeting_accepted', 'direct_message', 'invite')),
  source_id   UUID NOT NULL,
  actor_id    UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  bell_link   TEXT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      VARCHAR(16) NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'sending', 'sent', 'held', 'digesting', 'digested', 'skipped', 'dropped', 'failed')),
  reason      VARCHAR(32) NULL,
  send_after  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at  TIMESTAMPTZ NULL,
  delivery_id UUID NULL,
  sent_at     TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_email_outbox_once
  ON notification_email_outbox (user_id, kind, source_id);
CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_due
  ON notification_email_outbox (send_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_member
  ON notification_email_outbox (user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_held
  ON notification_email_outbox (created_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_claimed
  ON notification_email_outbox (claimed_at) WHERE status IN ('sending', 'digesting');
CREATE INDEX IF NOT EXISTS idx_notification_email_outbox_created
  ON notification_email_outbox (created_at);

CREATE TABLE IF NOT EXISTS notification_email_deliveries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        VARCHAR(16) NOT NULL CHECK (kind IN ('instant', 'daily', 'weekly')),
  local_day   DATE NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'sending'
              CHECK (status IN ('sending', 'sent', 'skipped', 'failed')),
  item_count  INTEGER NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_email_deliveries_once
  ON notification_email_deliveries (user_id, kind, local_day) WHERE kind IN ('daily', 'weekly');
CREATE INDEX IF NOT EXISTS idx_notification_email_deliveries_member_day
  ON notification_email_deliveries (user_id, kind, local_day);
CREATE INDEX IF NOT EXISTS idx_notification_email_deliveries_created
  ON notification_email_deliveries (created_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;

INSERT INTO email_config (email_type, enabled, subject) VALUES
  ('daily_digest', TRUE, 'Yesterday on REASON'),
  ('weekly_digest', FALSE, 'Your week on REASON')
ON CONFLICT (email_type) DO NOTHING;
