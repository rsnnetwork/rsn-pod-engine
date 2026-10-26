-- server/src/db/migrations/115_pod_wall.sql
-- The pod wall (26 Oct 2026). 25 Oct walkthrough, Stefan, back in the pod after an event: "We can't write
-- in the pod itself. There's no wall, like a Facebook wall. There should be." A pod's active members get a
-- discussion: posts, comments with one level of replies, one reaction per member per post, likes on
-- comments. It mirrors the circle wall (migrations 077 and 091) in tables of its own, so a pod's posts
-- cannot be reached from any circle route: the audit's option B (05-post-event-comms.md section 4.2).
--   * client_id with UNIQUE (author_id, client_id): a retried submit returns the first post, never a second.
--   * comment_count is moved with the comments by the service, in the same transaction.
--   * Deleting is soft, and says who did it, so a moderator's decision can be looked at afterwards.
--   * session_id is the event a post is about. Nothing writes it yet; a post about an event needs no
--     further migration.
-- The four bell types the wall rings with (pod_post, pod_comment, pod_reply, pod_reaction) are allowed by
-- migration 108, the only migration of this batch that restates notifications_type_check, so this file does
-- not touch notifications.
-- Only adds: four tables and their indexes, each created only if it is missing.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS pod_posts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL,
  pod_id        UUID NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 8000),
  media         JSONB NOT NULL DEFAULT '[]',
  link_url      TEXT NULL CHECK (link_url IS NULL OR link_url ~* '^https?://'),
  session_id    UUID NULL REFERENCES sessions(id) ON DELETE SET NULL,
  comment_count INTEGER NOT NULL DEFAULT 0,
  pinned_at     TIMESTAMPTZ NULL,
  deleted_at    TIMESTAMPTZ NULL,
  deleted_by    UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  edited_at     TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (author_id, client_id)
);

-- The feed: a pod's live posts, newest first, in the keyset order (created_at, id). Never OFFSET.
CREATE INDEX IF NOT EXISTS idx_pod_posts_feed
  ON pod_posts (pod_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
-- The pinned strip above the feed.
CREATE INDEX IF NOT EXISTS idx_pod_posts_pinned
  ON pod_posts (pod_id, pinned_at DESC) WHERE deleted_at IS NULL AND pinned_at IS NOT NULL;
-- The cap on posts a member can make in a minute counts that member's recent rows.
CREATE INDEX IF NOT EXISTS idx_pod_posts_author
  ON pod_posts (author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pod_post_comments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id           UUID NOT NULL REFERENCES pod_posts(id) ON DELETE CASCADE,
  author_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content           TEXT NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 4000),
  parent_comment_id UUID NULL REFERENCES pod_post_comments(id) ON DELETE CASCADE,
  deleted_at        TIMESTAMPTZ NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pod_comments_post
  ON pod_post_comments (post_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pod_comments_parent
  ON pod_post_comments (parent_comment_id) WHERE parent_comment_id IS NOT NULL;
-- The cap on comments a member can make in a minute counts that member's recent rows.
CREATE INDEX IF NOT EXISTS idx_pod_comments_author
  ON pod_post_comments (author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pod_post_reactions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID NOT NULL REFERENCES pod_posts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction   TEXT NOT NULL CHECK (reaction IN ('like', 'love', 'applause', 'insightful', 'celebrate')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS pod_comment_likes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID NOT NULL REFERENCES pod_post_comments(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (comment_id, user_id)
);
