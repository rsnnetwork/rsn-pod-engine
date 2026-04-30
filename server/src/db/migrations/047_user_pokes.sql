-- Migration 047: User Pokes (Phase G of chat-fix-and-dm-system, 1 May 2026)
--
-- Stefan's spec: "If you don't know each other or haven't met, you can poke."
-- A poke is a low-friction "wave hello" between two users who haven't yet
-- met in an event. The recipient can accept (which unlocks DMs and
-- creates a conversation), decline, or ignore.
--
-- Rules:
--   - One active (status='pending') poke per direction per pair. The
--     UNIQUE+partial-index combination enforces this without blocking
--     re-sends after a previous poke was responded to.
--   - Once any encounter exists between the pair, pokes become
--     irrelevant (DMs unlock directly). The application enforces this
--     at write time.
--   - Self-pokes rejected at the schema level via CHECK.
--   - Block status is checked at write time, not in the schema.

BEGIN;

CREATE TABLE IF NOT EXISTS user_pokes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'declined')),
  message       TEXT, -- optional first-line greeting
  responded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(sender_id != recipient_id)
);

-- Only one active (pending) poke per direction per pair.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_pokes_unique_pending
  ON user_pokes(sender_id, recipient_id)
  WHERE status = 'pending';

-- Inbox queries (received pending pokes) and outbox queries (sent).
CREATE INDEX IF NOT EXISTS idx_user_pokes_recipient
  ON user_pokes(recipient_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_pokes_sender
  ON user_pokes(sender_id, status, created_at DESC);

COMMIT;
