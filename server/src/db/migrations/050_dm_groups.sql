-- Migration 050: DM Groups (Phase I of chat-fix-and-dm-system, 1 May 2026)
--
-- Stefan's spec: "groups too — and pods too". Two flavours:
--   - 'custom': user-created group chats with explicit member list
--   - 'pod':    auto-provisioned per pod, members synced with pod_members

BEGIN;

CREATE TABLE IF NOT EXISTS dm_groups (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 200),
  type          TEXT NOT NULL CHECK (type IN ('custom', 'pod')),
  pod_id        UUID REFERENCES pods(id) ON DELETE CASCADE,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  last_message_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Pod groups: pod_id required, one per pod.
  CHECK ((type = 'pod' AND pod_id IS NOT NULL) OR (type = 'custom' AND pod_id IS NULL))
);

-- One pod chat per pod (when type='pod').
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_groups_one_per_pod
  ON dm_groups(pod_id) WHERE type = 'pod';

CREATE INDEX IF NOT EXISTS idx_dm_groups_created_by
  ON dm_groups(created_by);

COMMIT;
