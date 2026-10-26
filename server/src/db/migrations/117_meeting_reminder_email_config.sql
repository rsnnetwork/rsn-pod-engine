-- 117 — an admin switch for meeting reminder emails (26 Oct 2026)
--
-- The reminder 10 minutes before a meeting (services/meetings/meeting-reminder.worker.ts) emails each
-- person whose notify_email is on, and only while the admin email switch for 'meeting_reminder' is on.
-- That switch is a row of email_config, which the admin dashboard lists and toggles (routes/admin.ts,
-- /admin/email-config). A type with no row fails open, so the reminder emails went out with nothing for
-- an admin to switch off. This seeds the row, on, as 082 did for the meeting request emails.
--
-- Idempotent: ON CONFLICT DO NOTHING never overwrites a switch an admin has already set.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

INSERT INTO email_config (email_type, enabled, subject) VALUES
  ('meeting_reminder', TRUE, 'Your meeting with {name} starts in 10 minutes')
ON CONFLICT (email_type) DO NOTHING;
