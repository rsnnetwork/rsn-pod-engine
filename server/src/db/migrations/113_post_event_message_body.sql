-- server/src/db/migrations/113_post_event_message_body.sql
-- "Message all participants" v2 (26 Oct 2026). A job used to send a fixed feedback template to every
-- attendee. Now the organiser writes the message and it is sent as their own words, and they may also
-- reach the people who registered but never came.
--   body             the organiser's text, 1 to 2000 characters once outer spaces are taken off.
--                    NULL on every job that already exists, and on any job that still uses the template,
--                    so older rows mean exactly what they always meant.
--   include_no_shows whether the people who registered but never joined were part of the audience.
-- The index serves the limit of 3 sends per event per sender per 24 hours.
-- Only adds: two columns and an index, each guarded so the file is safe to run twice.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE post_event_message_jobs
  ADD COLUMN IF NOT EXISTS body TEXT NULL CHECK (body IS NULL OR length(btrim(body)) BETWEEN 1 AND 2000),
  ADD COLUMN IF NOT EXISTS include_no_shows BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_pem_jobs_creator
  ON post_event_message_jobs (session_id, created_by, created_at DESC);
