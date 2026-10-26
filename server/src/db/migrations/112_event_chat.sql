-- server/src/db/migrations/112_event_chat.sql
-- Event chat is kept (26 Oct 2026). On 25 Oct the people of a finished event reopened it and could not read
-- what they had chatted about: the chat lived in one server process's memory (at most 50 messages), was
-- deleted when the event ended, and a restart or deploy lost it mid-event. Each message is now written here
-- as it is sent, before anyone receives it, and kept as long as the event exists (it goes only with a
-- permanent delete of the event). Redis holds no chat.
--
-- A lobby message is said to the whole event. A room message is said in a breakout room: audience_ids is who
-- it reached, as resolved at send time (sender included), and only they read it back. room_id is the LiveKit
-- room; it is empty only for a room message whose sender was in no room the server tracks (seen by them alone).
-- sender_name is the name at the time it was sent; the page shows "Former member" for an account that is no
-- longer active. created_at is cut to the millisecond, the precision of the page cursor (<epochMs>_<id>), so
-- a page boundary never skips a message sent in the same millisecond. client_id is an optional key a client
-- sends so a retried message is stored once.
--
-- Only creates. No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS event_chat_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sender_id      UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  sender_name    TEXT NOT NULL CHECK (length(sender_name) <= 200),
  sender_is_host BOOLEAN NOT NULL DEFAULT FALSE,
  scope          TEXT NOT NULL CHECK (scope IN ('lobby', 'room')),
  room_id        TEXT NULL,
  match_id       UUID NULL REFERENCES matches(id) ON DELETE SET NULL,
  audience_ids   UUID[] NULL,
  content        TEXT NOT NULL CHECK (length(btrim(content)) > 0 AND length(content) <= 500),
  client_id      UUID NULL,
  deleted_at     TIMESTAMPTZ NULL,
  deleted_by     UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', NOW()),
  CONSTRAINT event_chat_room_audience CHECK (
    (scope = 'lobby' AND room_id IS NULL AND audience_ids IS NULL)
    OR (scope = 'room' AND audience_ids IS NOT NULL AND cardinality(audience_ids) > 0)
  )
);

-- The page read (newest first, keyset on created_at and id) and the room-audience filter.
CREATE INDEX IF NOT EXISTS idx_event_chat_feed ON event_chat_messages (session_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_event_chat_audience ON event_chat_messages USING GIN (audience_ids) WHERE scope = 'room';
CREATE INDEX IF NOT EXISTS idx_event_chat_sender ON event_chat_messages (sender_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_chat_client ON event_chat_messages (session_id, sender_id, client_id) WHERE client_id IS NOT NULL;
-- What a delete elsewhere looks rows up by: a permanently deleted event (the feed index skips deleted rows), a
-- match the round planner deletes and re-makes, a moderator whose account is deleted.
CREATE INDEX IF NOT EXISTS idx_event_chat_session ON event_chat_messages (session_id);
CREATE INDEX IF NOT EXISTS idx_event_chat_match ON event_chat_messages (match_id) WHERE match_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_chat_deleted_by ON event_chat_messages (deleted_by) WHERE deleted_by IS NOT NULL;

-- The three reactions the live chat offers (chat-handlers.ts), once per member per message.
CREATE TABLE IF NOT EXISTS event_chat_reactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES event_chat_messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL CHECK (emoji IN ('heart', 'clap', 'thumbs_up')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_event_chat_reactions_message ON event_chat_reactions (message_id);
CREATE INDEX IF NOT EXISTS idx_event_chat_reactions_user ON event_chat_reactions (user_id);
