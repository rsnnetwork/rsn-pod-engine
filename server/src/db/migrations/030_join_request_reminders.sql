-- Migration 030: Add reminder tracking to join_requests for the Nudge Engine
-- Tracks when reminders were sent so admins can poke approved-but-inactive applicants.

ALTER TABLE join_requests
  ADD COLUMN IF NOT EXISTS last_reminded_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_count    INTEGER NOT NULL DEFAULT 0;

-- Index for the auto-reminder cron: find approved requests that haven't activated
CREATE INDEX IF NOT EXISTS idx_join_requests_approved_reminders
  ON join_requests (status, last_reminded_at, reminder_count)
  WHERE status = 'approved';
