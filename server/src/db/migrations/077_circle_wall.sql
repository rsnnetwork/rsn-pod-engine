-- Migration 077: Circle wall (REASON v1 Phase 4, 20 Jul 2026)
--
-- The first user-generated-content tables in the platform. Design decisions
-- (docs/superpowers/plans/2026-07-19-circles-wall-architecture.md):
--   * client_id + UNIQUE(author_id, client_id): a double-tapped or retried
--     submit can never double-post (idempotency at the schema level).
--   * media is Cloudinary-host-validated in the service before it lands here.
--   * link_url carries an external share; NO server-side unfurl (SSRF).
--   * soft delete (deleted_at) — moderation is reversible.
--   * comment_count denormalised, moved in the same tx as the comment row.
--   * The partial index on (circle_id, created_at DESC) is THE feed index —
--     keyset pagination, never OFFSET.

BEGIN;

CREATE TABLE IF NOT EXISTS circle_posts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id     UUID NOT NULL,
  circle_id     UUID NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content       TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 8000),
  media         JSONB NOT NULL DEFAULT '[]',
  link_url      TEXT NULL CHECK (link_url IS NULL OR link_url ~* '^https?://'),
  comment_count INTEGER NOT NULL DEFAULT 0,
  pinned_at     TIMESTAMPTZ NULL,
  deleted_at    TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at     TIMESTAMPTZ NULL,
  UNIQUE (author_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_circle_posts_feed
  ON circle_posts (circle_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS circle_post_comments (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id    UUID NOT NULL REFERENCES circle_posts(id) ON DELETE CASCADE,
  author_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 4000),
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_circle_comments_post
  ON circle_post_comments (post_id, created_at ASC) WHERE deleted_at IS NULL;

-- Bell notification for circle members on new posts (deduped per circle per
-- hour in the service). Carries the full prior allowlist forward.
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('event_invite', 'pod_invite', 'join_request', 'approval', 'direct_message', 'poke', 'platform_match', 'meeting_confirmed', 'circle_post'));

COMMIT;
