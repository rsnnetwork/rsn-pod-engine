-- server/src/db/migrations/111_event_format.sql
-- An event's format (26 Oct 2026). On 25 Oct a "Video Meeting" was stored as config.eventType beside five
-- 8-minute rounds and ran as speed networking: the format was a label nothing read. It is now a column the
-- live engine branches on (a video meeting is one room until the director ends it) and lists can filter on.
-- The CHECK list is the shared EVENT_FORMAT_KEYS (shared/src/events/definitions.ts) written out;
-- migration-111.test.ts fails if the two ever differ. A new format needs a NEW migration restating the CHECK.
-- Every existing event reads speed_networking, which is what actually ran. No backfill: converting an old
-- row's config.eventType would need the production-data rules (CLAUDE.md §15), and none is scheduled.
-- Only adds: one column with a constant default, and its index.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS event_format TEXT NOT NULL DEFAULT 'speed_networking'
  CHECK (event_format IN ('speed_networking', 'video_meeting', 'voice_meeting', 'webinar', 'physical_event'));

CREATE INDEX IF NOT EXISTS idx_sessions_event_format ON sessions (event_format);
