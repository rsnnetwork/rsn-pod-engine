-- Migration 056: DM message reactions (3 May 2026)
--
-- One row per (message, user, emoji) so a single user can have multiple
-- distinct reactions on a message but cannot stack the same emoji twice.
-- Emoji is stored as a short type string (e.g. 'heart', 'clap') rather than
-- the unicode glyph itself — keeps the table compact and lets the client
-- render the chosen glyph variant freely. Allow-list is enforced at the
-- service layer, not in SQL, so we can extend the set without a migration.
--
-- ON DELETE CASCADE on both FKs: deleting a message also drops its
-- reactions; deleting a user removes their reactions everywhere.

BEGIN;

CREATE TABLE IF NOT EXISTS dm_message_reactions (
  message_id  UUID NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       VARCHAR(16) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Hot path: load all reactions for the messages of a thread in one shot.
CREATE INDEX IF NOT EXISTS idx_dm_reactions_message
  ON dm_message_reactions(message_id);

COMMIT;
