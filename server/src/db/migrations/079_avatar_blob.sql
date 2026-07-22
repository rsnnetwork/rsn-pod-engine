-- 079_avatar_blob.sql — LinkedIn photos are served from expiring CDN URLs;
-- we download once and serve from our own endpoint. BYTEA is fine at current
-- scale (<1k users, ~100KB each); revisit with object storage past ~10k users.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_blob BYTEA,
  ADD COLUMN IF NOT EXISTS avatar_blob_type TEXT;
