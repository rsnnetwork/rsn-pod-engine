-- Migration 074: Extend notifications.type to include 'platform_match'
-- (REASON platform v1 Phase 1, 17 Jul 2026 — the standing match loop.)
--
-- When someone new completes onboarding and fits what an existing member is
-- looking for, that member gets a bell notification pointing at /matches
-- ("you'll be notified when new people arrive" from Stefan's flow).
-- Carries forward the full prior allowlist (034, 046, 048) so existing rows
-- keep validating.

BEGIN;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message', 'poke', 'platform_match'));

COMMIT;
