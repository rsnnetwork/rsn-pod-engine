-- server/src/db/migrations/121_message_replies.sql
-- A message may answer another one (30 Oct 2026 review, item 4.3: "you can't reply").
--
-- Messages, one-to-one and group alike, live in one table, direct_messages (045; group messages through group_id, 052),
-- so a reply is one column there: the earlier message it quotes. The server lets a member quote only a message of the
-- same conversation or group. ON DELETE SET NULL: a reply outlives the message it quoted.
--
-- The partial index is for that rule: deleting a message looks up the replies that point at it, and without an index
-- that is a scan of every message for each message deleted (closing an account deletes all of its messages at once).
-- Rows written before this migration have no reply and stay exactly as they were.
--
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE direct_messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES direct_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_direct_messages_reply_to
  ON direct_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
