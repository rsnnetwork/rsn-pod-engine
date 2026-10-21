-- server/src/db/migrations/105_user_banner.sql
-- A banner a member can change from their profile (19 Oct 2026 feedback: "Users should be able to change
-- their banner from their profile"). The picture is kept in the member's row, like the stored LinkedIn
-- photo (avatar_blob), and served by GET /api/users/:id/banner with the type kept beside it.
-- banner_updated_at goes into the picture's address (?v=), so a new banner is never hidden behind a cached
-- old one. All three are NULL when the member has no banner: every member today, and anyone who removes theirs.
-- Only adds: nullable, no default, nothing rewritten or removed.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_blob BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_mime VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_updated_at TIMESTAMPTZ;
