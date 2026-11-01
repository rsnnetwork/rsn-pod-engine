-- 131 — a 6-digit sign-in code beside the sign-in link (1 Nov 2026)
--
-- The sign-in email now also carries a 6-digit code, typed on the waiting screen, for a member who opens the
-- email on another device or in a mail app's own browser (where the link signs in that browser, not the one
-- waiting). The code is never stored: code_hash is a keyed hash of it bound to this row's token hash
-- (services/identity/sign-in-code.ts). code_attempts counts every try; the fifth wrong one kills the link
-- and the code together.
--
-- Additive: a row made before this file is a link with no code (code_hash NULL, no tries), which is what it
-- was, so production's link flow and the join-request review links are untouched. Adding a column with a
-- constant default does not rewrite the table. Idempotent (IF NOT EXISTS).
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE magic_links
  ADD COLUMN IF NOT EXISTS code_hash TEXT,
  ADD COLUMN IF NOT EXISTS code_attempts INTEGER NOT NULL DEFAULT 0;
