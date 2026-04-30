-- Migration 043: User Blocks (Phase B of chat-fix-and-dm-system plan, 1 May 2026)
--
-- Stores user-to-user block relationships. The block table is shared between
-- the DM system (blocked users can't send DMs to each other) and the matching
-- engine (blocked pairs are added as a hard constraint and never matched).
-- This is also a foundation for the upcoming Matching Engine 1.0 spec which
-- requires `blocked_users` as a top-priority hard rule.
--
-- A block is one-directional in storage but enforced bidirectionally at
-- read time: if A blocks B, neither A nor B can DM the other AND the
-- matching engine excludes the pair regardless of direction. The
-- areBlocked(userA, userB) helper queries both directions.
--
-- The block is a simple intent record. We do not soft-delete on unblock —
-- the row is removed entirely so areBlocked() returns false immediately.

BEGIN;

CREATE TABLE IF NOT EXISTS user_blocks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  blocker_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(blocker_id, blocked_id),
  CHECK(blocker_id != blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

COMMIT;
