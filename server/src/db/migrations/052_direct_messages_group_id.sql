-- Migration 052: Add group_id to direct_messages (Phase I, 1 May 2026)
--
-- Existing direct_messages rows reference dm_conversations (1:1). For group
-- messages we add an optional group_id that is mutually exclusive with
-- conversation_id. Exactly one of the two must be set.

BEGIN;

ALTER TABLE direct_messages
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES dm_groups(id) ON DELETE CASCADE;

-- conversation_id was NOT NULL; relax it so group messages can omit it.
ALTER TABLE direct_messages
  ALTER COLUMN conversation_id DROP NOT NULL;

-- Exactly one of conversation_id or group_id must be present.
ALTER TABLE direct_messages
  ADD CONSTRAINT direct_messages_target_xor
  CHECK (
    (conversation_id IS NOT NULL AND group_id IS NULL) OR
    (conversation_id IS NULL AND group_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_dm_messages_group
  ON direct_messages(group_id, created_at DESC) WHERE group_id IS NOT NULL;

COMMIT;
