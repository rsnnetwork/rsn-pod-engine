-- server/src/db/migrations/119_profile_pictures.sql
-- The member's own picture, kept with where they placed it (30 Oct review: "Edit button that allows to fix the size or
-- position"). avatar_blob and banner_blob stay the pictures everyone sees; these keep the picture the member chose
-- (its bytes and type) and the crop they placed it with ({x, y, zoom}, shares of the picture), so it can be placed
-- again later without choosing it again. avatar_updated_at goes into the photo's address (?v=), as banner_updated_at
-- does for the banner, so a new photo is never hidden behind a cached old one.
-- Only adds: nullable, no default, nothing rewritten or removed. Every member today has none of these.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_source_blob BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_source_mime VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_crop JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_source_blob BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_source_mime VARCHAR(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_crop JSONB;
