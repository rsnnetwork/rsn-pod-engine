-- 062 — Feature 19 (13 May spec) — DM image attachments via Cloudinary.
--
-- Adds three columns to direct_messages so a message can carry an image
-- attachment alongside (or instead of) its text content. The client
-- uploads the image directly to Cloudinary using an unsigned upload
-- preset; the server stores only the resulting URL + metadata.
--
--   attachment_url   — the secure Cloudinary URL the client received
--   attachment_type  — short tag ('image' for this release; reserved for
--                       'audio'/'file' in later features)
--   attachment_meta  — JSONB blob for width/height/bytes/format so the
--                       client can render aspect-correct thumbnails
--                       without hitting Cloudinary's transforms endpoint
--                       on every render
--
-- Existing rows have NULL attachments and continue to render as
-- text-only messages, so the migration is additive and safe.

ALTER TABLE direct_messages
  ADD COLUMN IF NOT EXISTS attachment_url   TEXT,
  ADD COLUMN IF NOT EXISTS attachment_type  TEXT,
  ADD COLUMN IF NOT EXISTS attachment_meta  JSONB;

-- Either content OR attachment must be present — an empty message is
-- still rejected at the API layer, but the constraint backs that up.
ALTER TABLE direct_messages
  DROP CONSTRAINT IF EXISTS direct_messages_content_or_attachment_chk;
ALTER TABLE direct_messages
  ADD  CONSTRAINT direct_messages_content_or_attachment_chk
       CHECK (
         (content IS NOT NULL AND length(trim(content)) > 0)
         OR attachment_url IS NOT NULL
       );
