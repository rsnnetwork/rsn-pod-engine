-- 091_circle_wall_social.sql — reactions, replies, comment likes, shares (4 Sep 2026).
--
-- Ali: "inside the circles the wall still doesn't have a like option; I want a
-- proper Facebook-style like/react, comment, share, reply to a comment, and
-- delete for the poster." One reaction per member per post (changing it
-- updates the row), one level of replies (a reply to a reply attaches to the
-- top-level comment), likes on comments, and a post can carry the post it was
-- shared from so the target circle sees the attribution.
--
-- Notification types added: circle_reaction (post author), circle_comment
-- (post author), circle_reply (the comment's author). The runner wraps this
-- file in a transaction.

CREATE TABLE IF NOT EXISTS circle_post_reactions (
  post_id    UUID NOT NULL REFERENCES circle_posts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction   TEXT NOT NULL CHECK (reaction IN ('like', 'love', 'applause', 'insightful', 'celebrate')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS circle_comment_likes (
  comment_id UUID NOT NULL REFERENCES circle_post_comments(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id, user_id)
);

ALTER TABLE circle_post_comments
  ADD COLUMN IF NOT EXISTS parent_comment_id UUID NULL REFERENCES circle_post_comments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_circle_comments_parent
  ON circle_post_comments (parent_comment_id) WHERE parent_comment_id IS NOT NULL;

ALTER TABLE circle_posts
  ADD COLUMN IF NOT EXISTS shared_from_post_id UUID NULL REFERENCES circle_posts(id) ON DELETE SET NULL;

ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message', 'poke', 'platform_match', 'meeting_confirmed', 'circle_post', 'poke_accepted', 'circle_reaction', 'circle_comment', 'circle_reply'));
