-- Community authority and private-space safety (Shirley pilot S2, 11 Nov 2026; plan decisions D2 and D3).
--
-- 1. One owner per circle. A circle's authority now comes from circle_members.role alone (the person who made it has no
--    right of their own), so every circle needs exactly one owner and can never get a second. Before the unique index
--    is made, the data is put in that shape (production on 11 Nov: each of its 5 circles has exactly one owner, so both
--    steps change nothing there; they are here so the index can never fail on a row):
--    a. A circle with more than one owner keeps one: the person who made it when they are one of its owners, else the
--       owner who joined first (then the lowest id). Every other owner becomes a moderator, so nobody loses the right
--       to run it. The count is raised as a NOTICE (the runner logs it).
--    b. A circle with no owner whose maker is still in it: the maker becomes its owner, keeping the authority they held
--       as its maker until today. A circle whose maker has left keeps no owner and is run by platform admins, as
--       before; how many is raised as a NOTICE.
--    c. uq_circle_members_one_owner: a unique partial index, one 'owner' row per circle. Handing a circle over demotes
--       the old owner before it promotes the new one, inside one transaction.
--
-- 2. Pod visibility, three settings (D2): Private, Public with approval and Public open. "Invite only" is retired: any
--    pod still set to it becomes Private, the more private setting, so nothing becomes visible that was not (production
--    on 11 Nov has none; the count is raised as a NOTICE). A pod row still holding the merged-away 'request_to_join'
--    (035) becomes Public with approval, as 035 did. The column's default becomes Private. No CHECK is added here: while
--    a deploy swaps instances, the old one may still write 'invite_only' for a few minutes after this file runs, and a
--    CHECK would turn its pod creation into a 500. The new code reads any such row as Private and writes Private in its
--    place; a later migration may sweep the rows again and add the CHECK.
--
-- 3. users.show_communities: whether a member's profile may list the circles and pods they belong to (S3 reads it;
--    on by default, the member may turn it off).
--
-- 4. Removed is not the same as turned down (S2 fix round 1, controller ruling). Someone an organiser REMOVED cannot
--    come back by themselves (a Public open pod or an open circle refuses their own join; an approval pod or a closed
--    circle takes their request, which the organiser decides); someone whose request was DECLINED may ask again.
--    - pod_members.removal_kind ('removed' | 'rejected', NULL otherwise): both used to be status 'removed'. Existing
--      'removed' rows are told apart from audit_log: the route that turned a request down records
--      action 'reject_pod_member' with the path /<pod>/members/<user>/reject; a row whose latest such record is newer
--      than any removal of it ('remove_pod_member') is 'rejected', every other 'removed' row is 'removed' (when the
--      log cannot tell, the safer side). The counts are raised as a NOTICE.
--    - circle_removals: a circle's member row is deleted on removal, so who was removed is kept here (one row per
--      circle and person, cleared when they are let back in). Removals before this file left no record (the circle
--      route wrote no audit row), so nothing is backfilled.
--
-- No BEGIN/COMMIT: the runner wraps each file in its own transaction. Safe to run twice: every step is guarded.

-- 1a. More than one owner: keep one, the others become moderators.
DO $$
DECLARE
  demoted INTEGER;
BEGIN
  WITH ranked AS (
    SELECT m.circle_id, m.user_id,
           row_number() OVER (PARTITION BY m.circle_id
                              ORDER BY (m.user_id = c.created_by) DESC, m.joined_at ASC, m.user_id ASC) AS place
      FROM circle_members m
      JOIN circles c ON c.id = m.circle_id
     WHERE m.role = 'owner'
  )
  UPDATE circle_members m
     SET role = 'moderator'
    FROM ranked r
   WHERE m.circle_id = r.circle_id AND m.user_id = r.user_id AND r.place > 1;
  GET DIAGNOSTICS demoted = ROW_COUNT;
  RAISE NOTICE '148: % extra circle owner row(s) became moderator', demoted;
END $$;

-- 1b. No owner: the maker, when still in the circle, becomes its owner.
DO $$
DECLARE
  promoted INTEGER;
  ownerless INTEGER;
BEGIN
  UPDATE circle_members m
     SET role = 'owner'
    FROM circles c
   WHERE c.id = m.circle_id AND m.user_id = c.created_by AND m.role <> 'owner'
     AND NOT EXISTS (SELECT 1 FROM circle_members o WHERE o.circle_id = c.id AND o.role = 'owner');
  GET DIAGNOSTICS promoted = ROW_COUNT;
  SELECT count(*) INTO ownerless
    FROM circles c
   WHERE c.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM circle_members o WHERE o.circle_id = c.id AND o.role = 'owner');
  RAISE NOTICE '148: % circle maker(s) became owner of an ownerless circle; % live circle(s) still have no owner', promoted, ownerless;
END $$;

-- 1c. One owner per circle, from now on.
CREATE UNIQUE INDEX IF NOT EXISTS uq_circle_members_one_owner ON circle_members (circle_id) WHERE role = 'owner';

-- 2. Pods: three settings.
DO $$
DECLARE
  retired INTEGER;
  merged INTEGER;
BEGIN
  UPDATE pods SET visibility = 'private', updated_at = NOW() WHERE visibility::text = 'invite_only';
  GET DIAGNOSTICS retired = ROW_COUNT;
  UPDATE pods SET visibility = 'public_with_approval', updated_at = NOW() WHERE visibility::text = 'request_to_join';
  GET DIAGNOSTICS merged = ROW_COUNT;
  RAISE NOTICE '148: % invite-only pod(s) became private; % request-to-join pod(s) became public with approval', retired, merged;
END $$;

ALTER TABLE pods ALTER COLUMN visibility SET DEFAULT 'private';

-- 3. A member may keep the communities they belong to off their profile.
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_communities BOOLEAN NOT NULL DEFAULT TRUE;

-- 4a. Pods: removed by an organiser, or a request turned down.
ALTER TABLE pod_members ADD COLUMN IF NOT EXISTS removal_kind TEXT NULL
  CHECK (removal_kind IS NULL OR removal_kind IN ('removed', 'rejected'));

DO $$
DECLARE
  rejected INTEGER;
  removed INTEGER;
BEGIN
  UPDATE pod_members pm
     SET removal_kind = 'rejected'
   WHERE pm.status = 'removed' AND pm.removal_kind IS NULL
     AND EXISTS (
       SELECT 1 FROM audit_log rj
        WHERE rj.action = 'reject_pod_member' AND rj.entity_id = pm.pod_id
          AND lower(rj.details->>'path') = '/' || pm.pod_id::text || '/members/' || pm.user_id::text || '/reject'
          AND NOT EXISTS (
            SELECT 1 FROM audit_log rm
             WHERE rm.action = 'remove_pod_member' AND rm.entity_id = pm.pod_id
               AND lower(rm.details->>'path') = '/' || pm.pod_id::text || '/members/' || pm.user_id::text
               AND rm.created_at > rj.created_at));
  GET DIAGNOSTICS rejected = ROW_COUNT;
  UPDATE pod_members SET removal_kind = 'removed' WHERE status = 'removed' AND removal_kind IS NULL;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE '148: % turned-down request(s) marked rejected; % removal(s) marked removed', rejected, removed;
END $$;

-- 4b. Circles: who an organiser removed (cleared when they are let back in).
CREATE TABLE IF NOT EXISTS circle_removals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id   UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  removed_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (circle_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_circle_removals_user ON circle_removals (user_id);
