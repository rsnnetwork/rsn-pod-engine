-- 124 — an answered call is a meeting of its own kind (1 Nov 2026, 30 Oct review item 4)
--
-- A connection can now ring another directly, with no meeting held first. Each call that is answered
-- is written as a meetings row in the same transaction as the accept (meeting-call.service.ts), so it
-- lists under Events → Past, carries who joined, and is what post-meeting feedback hangs on.
-- meetings.source tells the two kinds apart:
--   'scheduled' a time the two agreed in the scheduler (every row made before this file);
--   'instant'   an answered call: starts when it is answered, already counted as reminded, never named
--               by dm_conversations.current_meeting_id, never cancellable, and never unlocks calls.
-- Adding a column with a constant default does not rewrite the table, and every existing row reads
-- 'scheduled', so production's booking, move, cancel and reminder go on reading them as before.
--
-- No call_request_id link: the accept claims the request (status pending → accepted) in the same
-- transaction that writes the row, so a second accept, on another device or a double press, writes nothing.
--
-- The index serves a caller's own live request (GET /dm/call/requests/outgoing), read to restore the
-- "Calling…" card after a refresh; the callee's side already has idx_call_requests_to_user (097).
--
-- Idempotent (IF NOT EXISTS). No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'scheduled' CHECK (source IN ('scheduled', 'instant'));

CREATE INDEX IF NOT EXISTS idx_call_requests_from_user ON call_requests (from_user_id, status);
