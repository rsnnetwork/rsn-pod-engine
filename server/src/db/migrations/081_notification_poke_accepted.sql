-- Migration 081: Extend notifications.type to include 'poke_accepted'
-- (Task F1 — the poke loop notified the recipient on send but nobody on
-- accept; the sender only ever got a silent fanoutUserEntity badge refresh.
-- acceptPoke now inserts a bell notification for the sender: "{accepter}
-- accepted your meeting request", linking to /messages.)
--
-- Carries the full prior allowlist forward (034, 046, 048, 074, 075, 077)
-- so existing rows keep validating.

BEGIN;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message', 'poke', 'platform_match', 'meeting_confirmed', 'circle_post', 'poke_accepted'));

COMMIT;
