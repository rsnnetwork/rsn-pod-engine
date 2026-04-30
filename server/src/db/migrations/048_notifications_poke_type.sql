-- Migration 048: Extend notifications.type to include 'poke'
-- (Phase G of chat-fix-and-dm-system, 1 May 2026)
--
-- Carries forward the full prior allowlist (set in migrations 034 and 046)
-- so existing rows keep validating.

BEGIN;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message', 'poke'));

COMMIT;
