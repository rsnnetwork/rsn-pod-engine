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
--    (035) becomes Public with approval, as 035 did. The column's default becomes Private, and a CHECK accepts only the
--    three settings from now on (the enum keeps its old values: Postgres cannot drop one).
--
-- 3. users.show_communities: whether a member's profile may list the circles and pods they belong to (S3 reads it;
--    on by default, the member may turn it off).
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
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pods_visibility_three_settings') THEN
    ALTER TABLE pods ADD CONSTRAINT pods_visibility_three_settings
      CHECK (visibility::text IN ('private', 'public_with_approval', 'public'));
  END IF;
END $$;

ALTER TABLE pods ALTER COLUMN visibility SET DEFAULT 'private';

-- 3. A member may keep the communities they belong to off their profile.
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_communities BOOLEAN NOT NULL DEFAULT TRUE;
