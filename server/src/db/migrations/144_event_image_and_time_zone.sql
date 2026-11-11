-- An event's image and its time zone (10 Nov 2026 spec, Part 3 Task 1; plan K1).
--
-- timezone: the IANA zone every time of the event is written in (bells, emails, screens). Existing events take their
-- host's zone when Postgres knows it (users.timezone was never checked on the profile form, so it can hold anything),
-- else UTC; then the column is NOT NULL with the default 'UTC'. The server canonicalises a zone again on read, so a
-- name pg's tzdata and the runtime's ICU disagree on is harmless. Production had no upcoming events when this was
-- written (11 Nov 2026), so nothing anyone has seen moves.
--
-- The image is kept in the row as an entity's pictures are (migration 129): the cut picture everyone sees and its
-- type, where it was placed, the picture it was cut from and its type, and when it last changed (the address's ?v=).
-- TOAST keeps the bytes out of line, and no query selects sessions.* or s.*, so no list reads them. All NULL: every
-- existing event has no image.
--
-- No BEGIN/COMMIT: the runner wraps each file in its own transaction. Safe to run twice: every column is guarded and
-- both updates touch only rows that have no zone yet.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS timezone VARCHAR(64);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS image_blob BYTEA;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS image_mime VARCHAR(40);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS image_crop JSONB;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS image_source_blob BYTEA;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS image_source_mime VARCHAR(40);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS image_updated_at TIMESTAMPTZ;

UPDATE sessions s SET timezone = u.timezone FROM users u
 WHERE s.timezone IS NULL AND u.id = s.host_user_id
   AND u.timezone IN (SELECT name FROM pg_timezone_names);
UPDATE sessions SET timezone = 'UTC' WHERE timezone IS NULL;

ALTER TABLE sessions ALTER COLUMN timezone SET DEFAULT 'UTC';
ALTER TABLE sessions ALTER COLUMN timezone SET NOT NULL;
