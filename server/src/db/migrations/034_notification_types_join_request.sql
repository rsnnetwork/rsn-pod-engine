-- Migration 034: Extend notification types for join-request flow
-- Adds 'join_request' (admin sees new application) and 'approval' (user sees welcome).

BEGIN;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval'));

COMMIT;
