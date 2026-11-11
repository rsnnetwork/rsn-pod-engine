-- Walls that work for owners (Shirley pilot S4, 11 Nov 2026; plan decisions D2, D3 and D8).
--
-- Both walls (a circle's and a pod's) let an author edit their own post or comment, show that it was edited, and let
-- the people who run the space (a circle's owner and moderators, a pod's director and hosts, platform admins) delete
-- anyone's post or comment and pin and unpin posts. Each moderation is written to audit_log by the service, in the
-- transaction that makes it. This file adds only the columns, the index and the check that need:
--
-- 1. edited_at on both comment tables (the post tables already have it: 077 and 115). Set by an edit that changed the
--    words, read by the screen as "Edited".
-- 2. deleted_by on both comment tables and on circle_posts (pod_posts has had it since 115): who removed it, the author
--    or a moderator. ON DELETE SET NULL: a person whose account row is ever deleted leaves the record that a post was
--    removed, without who.
-- 3. idx_circle_posts_pinned: the pinned strip of a circle's wall, and the count of its pinned posts that a pin checks
--    (at most three), mirroring idx_pod_posts_pinned (115).
-- 4. withdrawn_at on both comment tables (S4 fix round 1, controller ruling): an author who deletes their own comment
--    no longer takes other people's replies with it. A comment that has replies is withdrawn instead: its words are
--    cleared (content = ''), withdrawn_at is set, and it reads "This comment was deleted" above the replies, which
--    stay. The comment check (077, 115: words that are not blank, at most 4000) becomes one that also allows the
--    empty words of a withdrawn comment, and nothing else; the old check is found by what it says, not by its name.
--    An instance still running the code before this file writes only non-blank words, which the new check accepts.
-- 5. idx_circle_posts_shared_from: the live shares of a post, which a removal or an edit of the post tells (S4 fix
--    round 1: their cards carry its words).
-- 6. idx_notifications_wall_link: the wall bells by link (text_pattern_ops, for the link prefix), partial on the eight
--    wall bell types, so a removal finds the bells carrying the removed words without reading every notification.
--
-- Every statement is guarded, so the file can run again and change nothing. No row is written or changed.

ALTER TABLE pod_post_comments    ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ NULL;
ALTER TABLE pod_post_comments    ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE circle_post_comments ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ NULL;
ALTER TABLE circle_post_comments ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE circle_posts         ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_circle_posts_pinned
  ON circle_posts (circle_id, pinned_at DESC) WHERE deleted_at IS NULL AND pinned_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_circle_posts_shared_from
  ON circle_posts (shared_from_post_id) WHERE shared_from_post_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_wall_link
  ON notifications (link text_pattern_ops)
  WHERE type IN ('circle_post', 'circle_reaction', 'circle_comment', 'circle_reply',
                 'pod_post', 'pod_reaction', 'pod_comment', 'pod_reply');

ALTER TABLE pod_post_comments    ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ NULL;
ALTER TABLE circle_post_comments ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ NULL;

DO $$
DECLARE
  t TEXT;
  old_check RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['pod_post_comments', 'circle_post_comments'] LOOP
    FOR old_check IN
      SELECT conname FROM pg_constraint
       WHERE conrelid = t::regclass AND contype = 'c'
         AND conname <> t || '_words_or_withdrawn'
         AND pg_get_constraintdef(oid) ILIKE '%length(TRIM(%content%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, old_check.conname);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t::regclass AND conname = t || '_words_or_withdrawn') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (length(content) <= 4000 AND (length(btrim(content)) > 0 OR (withdrawn_at IS NOT NULL AND content = %L)))',
        t, t || '_words_or_withdrawn', '');
    END IF;
  END LOOP;
END $$;
