-- Migration 075: Meeting windows (REASON v1 Phase 2, 19 Jul 2026)
--
-- Stefan's flow: after a mutual yes, "setup availability to be introduced".
-- Each side of a conversation picks time windows (day + daypart); the overlap
-- is shown in the thread and either side confirms one. Deliberately no
-- calendar integration (Ali's locked decision: time windows only).
--
-- window_key format: 'YYYY-MM-DD:morning|afternoon|evening'. One confirmed
-- meeting per conversation (v1) lives on dm_conversations.

BEGIN;

CREATE TABLE IF NOT EXISTS meeting_availability (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_key      TEXT NOT NULL CHECK (window_key ~ '^\d{4}-\d{2}-\d{2}:(morning|afternoon|evening)$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id, user_id, window_key)
);

CREATE INDEX IF NOT EXISTS idx_meeting_availability_conv
  ON meeting_availability(conversation_id);

ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS meeting_confirmed_window TEXT,
  ADD COLUMN IF NOT EXISTS meeting_confirmed_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS meeting_confirmed_at TIMESTAMPTZ;

-- Bell notification for the partner when a window is confirmed. Carries the
-- full prior allowlist forward (034, 046, 048, 074).
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message', 'poke', 'platform_match', 'meeting_confirmed'));

COMMIT;
