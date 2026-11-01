-- server/src/db/migrations/121_message_replies.sql
-- A message may answer another one (30 Oct 2026 review, item 4.3: "you can't reply").
--
-- Messages, one-to-one and group alike, live in one table, direct_messages (045; group messages through group_id, 052),
-- so a reply is one column there: the earlier message it quotes. The server lets a member quote only a message of the
-- same conversation or group, and checks that when the reply is written.
--
-- A plain column, with no foreign key (controller ruling, T6 fix round 1): a reply outlives the message it quoted, and
-- when that message is gone the reply still points at it, so the thread can say "Original message deleted". A foreign
-- key with ON DELETE SET NULL would erase that fact and leave the reply unquoted. The constraint is dropped if an
-- earlier draft of this file created it (it ran on the shared scratch database only, never on production).
--
-- The partial index (the ruling keeps one) finds the replies to a given message; most messages answer nothing, so
-- it holds only the replies. Rows written before this migration have no reply and stay exactly as they were.
--
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE direct_messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID;

ALTER TABLE direct_messages
  DROP CONSTRAINT IF EXISTS direct_messages_reply_to_id_fkey;

CREATE INDEX IF NOT EXISTS idx_direct_messages_reply_to
  ON direct_messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
