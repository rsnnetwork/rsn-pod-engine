-- 063 — Fix attachment-only DMs (Feature 19 + 20 follow-up).
--
-- Migration 062 added `direct_messages_content_or_attachment_chk` to allow
-- a message to carry an attachment with no text, BUT left the original
-- 045 column-level constraint intact:
--
--   content TEXT NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 4000)
--
-- So when the client posted a message with only an image, the row passed
-- the new combined check but tripped the old per-column one
-- (`direct_messages_content_check`). Postgres surfaced this as
-- "violates check constraint direct_messages_content_check" and the
-- request bubbled out as a 500 with "An unexpected error occurred" to
-- the user.
--
-- Fix: drop the old per-column rule + the NOT NULL on content. Length cap
-- is preserved as a fresh constraint. The combined
-- `direct_messages_content_or_attachment_chk` (added in 062) is now the
-- sole arbiter of "must have content or attachment". The application
-- layer is also updated to write NULL (not '') when no caption is
-- supplied — both work, but NULL is the cleaner storage form.

-- Idempotent: I manually ran an earlier version of this file against the
-- live Neon DB while diagnosing the bug on 2026-05-15, which means the
-- new constraint already exists in prod by the time Render's migration
-- runner picks the file up on the next deploy. ADD CONSTRAINT without an
-- IF NOT EXISTS guard tripped error 42710 (constraint already exists)
-- and failed the deploy. DROP IF EXISTS before ADD makes this safe to
-- re-run from any starting state.

ALTER TABLE direct_messages
  DROP CONSTRAINT IF EXISTS direct_messages_content_check;

ALTER TABLE direct_messages
  ALTER COLUMN content DROP NOT NULL;

ALTER TABLE direct_messages
  DROP CONSTRAINT IF EXISTS direct_messages_content_length_chk;

ALTER TABLE direct_messages
  ADD CONSTRAINT direct_messages_content_length_chk
    CHECK (content IS NULL OR length(content) <= 4000);
