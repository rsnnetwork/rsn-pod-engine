-- server/src/db/migrations/108_notification_types_oct25.sql
-- Notification types for the 25 Oct batch (26 Oct 2026). The bell will ring for a meeting reminder and
-- a cancelled meeting, for posts, comments, replies and reactions on a pod's wall, and for a message in
-- a group chat. notifications_type_check is an allowlist, so each of these must be allowed before any
-- code inserts it.
-- The list is restated in full: the 16 types 099_dm_system_messages.sql allowed (the latest definition)
-- plus the 7 new ones. This is the only migration of the batch that touches the constraint, so it
-- carries the whole final list; migration-108.test.ts fails if a type is dropped.
-- Every existing row already passes (the new list only adds), so adding the constraint cannot fail.
-- Dropping it first only if it exists makes the file safe to run twice.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message',
                  'poke', 'platform_match', 'meeting_confirmed', 'circle_post', 'poke_accepted',
                  'circle_reaction', 'circle_comment', 'circle_reply',
                  'incoming_call', 'availability_updated', 'meeting_proposed',
                  'meeting_reminder', 'meeting_cancelled',
                  'pod_post', 'pod_comment', 'pod_reply', 'pod_reaction',
                  'group_message'));
