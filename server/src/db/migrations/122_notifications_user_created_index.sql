-- server/src/db/migrations/122_notifications_user_created_index.sql
-- The notifications page (30 Oct 2026 review, item 4.5) reads a member's notifications thirty at a time, newest first,
-- each page starting strictly after where the last one ended, by (created_at, id). The index from 025
-- (user_id, is_read, created_at) cannot give that order for one member without sorting all of their rows; this one can.
--
-- Not CONCURRENTLY: the runner wraps each file in a transaction, where CONCURRENTLY cannot run. The table is small
-- (about 1,200 rows on production, at most 144 for one member), so the build is instant.
--
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC, id DESC);
