-- Migration 046: Extend notifications.type to include direct_message
-- (Phase C of chat-fix-and-dm-system, 1 May 2026)
--
-- Migration 034 widened notifications.type to ('event_invite', 'pod_invite',
-- 'join_request', 'approval'). We add 'direct_message' here. The full prior
-- list is preserved so production rows (including existing 'join_request'
-- and 'approval' notifications) keep validating.

BEGIN;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message'));

COMMIT;
