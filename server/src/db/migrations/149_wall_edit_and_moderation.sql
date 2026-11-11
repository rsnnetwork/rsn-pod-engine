-- Walls that work for owners (Shirley pilot S4, 11 Nov 2026; plan decisions D2, D3 and D8).
--
-- Both walls (a circle's and a pod's) let an author edit their own post or comment, show that it was edited, and let
-- the people who run the space (a circle's owner and moderators, a pod's director and hosts, platform admins) delete
-- anyone's post or comment and pin and unpin posts. Each moderation is written to audit_log by the service, in the
-- transaction that makes it. This file adds only the columns and the index that need:
--
-- 1. edited_at on both comment tables (the post tables already have it: 077 and 115). Set by an edit that changed the
--    words, read by the screen as "Edited".
-- 2. deleted_by on both comment tables and on circle_posts (pod_posts has had it since 115): who removed it, the author
--    or a moderator. ON DELETE SET NULL: a person whose account row is ever deleted leaves the record that a post was
--    removed, without who.
-- 3. idx_circle_posts_pinned: the pinned strip of a circle's wall, and the count of its pinned posts that a pin checks
--    (at most three), mirroring idx_pod_posts_pinned (115).
--
-- Every statement is guarded, so the file can run again and change nothing. No row is written or changed.

ALTER TABLE pod_post_comments    ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ NULL;
ALTER TABLE pod_post_comments    ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE circle_post_comments ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ NULL;
ALTER TABLE circle_post_comments ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE circle_posts         ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_circle_posts_pinned
  ON circle_posts (circle_id, pinned_at DESC) WHERE deleted_at IS NULL AND pinned_at IS NOT NULL;
