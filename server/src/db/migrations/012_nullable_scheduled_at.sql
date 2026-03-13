-- Allow sessions to be created without a scheduled date (e.g. when copying an event)
ALTER TABLE sessions ALTER COLUMN scheduled_at DROP NOT NULL;
