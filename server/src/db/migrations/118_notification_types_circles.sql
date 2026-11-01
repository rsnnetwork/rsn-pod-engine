-- server/src/db/migrations/118_notification_types_circles.sql
-- Circle foundation (1 Nov 2026), three changes that circle invites need before any code relies on them.
--
-- 1. The bell for a circle invite. notifications_type_check is an allowlist, and 'circle_invite' was never on it:
--    migration 090 added circle invites but did not restate the list, so every circle-invite bell insert failed
--    (the failure is logged and swallowed) and an invited member got no bell and no live update. The list is
--    restated in full: the 23 types 108_notification_types_oct25.sql allowed (the latest definition) plus
--    'circle_invite'. This is the only migration of the programme that touches the constraint; every other new
--    bell reuses an existing type. notification-types-allowed.test.ts fails if the code inserts a type this list
--    does not carry. Every existing row already passes (the new list only adds). Dropping the constraint first,
--    only if it exists, makes the file safe to run twice.
--
-- 2. A circle's owner. circle_members.role allowed 'member' and 'moderator'; a circle's creator is its owner, so
--    'owner' is added. Whatever CHECK constrains the role column is found by what it says (not by its name), dropped
--    and restated with the three roles.
--
-- 3. Creators are members. createCircle did not add its creator, so in production the creators hold role 'member'
--    in three circles and are absent from the fourth. Every circle's created_by is inserted as 'owner', and a
--    creator who already has a row is upgraded to 'owner' (only from another role, so a second run changes nothing).
--    member_count is then set to the number of member rows, only where it differs.
--
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
                  'group_message',
                  'circle_invite'));

DO $$
DECLARE
  existing RECORD;
BEGIN
  FOR existing IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'circle_members'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE circle_members DROP CONSTRAINT %I', existing.conname);
  END LOOP;
  ALTER TABLE circle_members
    ADD CONSTRAINT circle_members_role_check
    CHECK (role IN ('member', 'moderator', 'owner'));
END $$;

INSERT INTO circle_members (circle_id, user_id, role)
SELECT c.id, c.created_by, 'owner'
  FROM circles c
ON CONFLICT (circle_id, user_id) DO UPDATE SET role = 'owner'
  WHERE circle_members.role <> 'owner';

UPDATE circles c
   SET member_count = counted.total
  FROM (SELECT c2.id, (SELECT count(*)::int FROM circle_members m WHERE m.circle_id = c2.id) AS total
          FROM circles c2) counted
 WHERE counted.id = c.id
   AND c.member_count <> counted.total;
