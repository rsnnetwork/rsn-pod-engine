-- 150: what a report names, and the log of calendar invitations sent by email (11 Nov 2026, Shirley Palmer's brief:
-- safety controls item 16 and RSN 09).
--
-- 1. user_reports names what was reported besides the member: one direct message or one post on a pod or circle wall
--    (subject_kind, subject_id), with a copy of its words taken when the report is made (subject_excerpt, at most 2000
--    characters). The copy is the evidence: it stays when the message, the post or the conversation is later deleted
--    (subject_id has no foreign key, as it names rows in three tables; conversation_id still goes to NULL with its
--    conversation). Only platform admins read it, in the moderation queue. A report of the member alone has none of the
--    three (the CHECK keeps the kind and the id together). One index serves the 24-hour "You already reported this."
--    check per reporter and member, the other per reporter and subject.
-- 2. meeting_invite_emails: one row per person, meeting, calendar SEQUENCE and method, written BEFORE the invitation is
--    offered to the mail provider. A second dispatch for the same meeting time finds the row and sends nothing, so a
--    retried or doubled booking never emails twice. The row's status says what happened: 'sending', 'sent', 'failed',
--    'no_provider' (no mail provider set up) or 'no_address' (we hold no email address for that person), and screens say
--    "Calendar invitation sent by email." only when it is 'sent'. It goes with the meeting or the person.
--
-- The runner wraps this file in its own transaction: no BEGIN or COMMIT here. Every statement is guarded, so running the
-- file twice changes nothing.

ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS subject_kind VARCHAR(20) NULL;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS subject_id UUID NULL;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS subject_excerpt TEXT NULL;

ALTER TABLE user_reports DROP CONSTRAINT IF EXISTS user_reports_subject_kind_check;
ALTER TABLE user_reports ADD CONSTRAINT user_reports_subject_kind_check
  CHECK (subject_kind IS NULL OR subject_kind IN ('dm_message', 'pod_post', 'circle_post'));

ALTER TABLE user_reports DROP CONSTRAINT IF EXISTS user_reports_subject_pair_check;
ALTER TABLE user_reports ADD CONSTRAINT user_reports_subject_pair_check
  CHECK ((subject_kind IS NULL) = (subject_id IS NULL));

ALTER TABLE user_reports DROP CONSTRAINT IF EXISTS user_reports_subject_excerpt_len;
ALTER TABLE user_reports ADD CONSTRAINT user_reports_subject_excerpt_len
  CHECK (subject_excerpt IS NULL OR length(subject_excerpt) <= 2000);

CREATE INDEX IF NOT EXISTS idx_user_reports_reporter_reported
  ON user_reports (reporter_id, reported_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_reports_reporter_subject
  ON user_reports (reporter_id, subject_kind, subject_id, created_at DESC)
  WHERE subject_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS meeting_invite_emails (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence    INTEGER NOT NULL,
  method      VARCHAR(10) NOT NULL DEFAULT 'REQUEST' CHECK (method IN ('REQUEST', 'CANCEL')),
  status      VARCHAR(12) NOT NULL DEFAULT 'sending'
              CHECK (status IN ('sending', 'sent', 'failed', 'no_provider', 'no_address')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meeting_invite_emails_once UNIQUE (meeting_id, user_id, sequence, method)
);

-- The UNIQUE above leads with meeting_id, so a meeting's rows are found by it; this one serves the cascade from users.
CREATE INDEX IF NOT EXISTS idx_meeting_invite_emails_user ON meeting_invite_emails (user_id);
