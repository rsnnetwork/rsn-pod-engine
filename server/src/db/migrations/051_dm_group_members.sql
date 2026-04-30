-- Migration 051: DM Group Members (Phase I of chat-fix-and-dm-system, 1 May 2026)
--
-- Per-member state: role, last_read_at (per-user unread tracking).

BEGIN;

CREATE TABLE IF NOT EXISTS dm_group_members (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        UUID NOT NULL REFERENCES dm_groups(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  last_read_at    TIMESTAMPTZ,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dm_group_members_user
  ON dm_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_group_members_group
  ON dm_group_members(group_id);

COMMIT;
