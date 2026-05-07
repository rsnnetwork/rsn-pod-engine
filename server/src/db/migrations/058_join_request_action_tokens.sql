-- Migration 058: admin email-action tokens for join requests.
--
-- The admin email-approve / reject feature needs single-use signed tokens
-- bound to (admin_user_id, join_request_id, action). Rather than a new
-- table we extend magic_links — same SHA-256 hashed token, same expiry
-- pattern, same cleanup cron. Login keeps using purpose='login' (default)
-- so existing rows are untouched.
--
-- All ALTERs are additive + nullable / defaulted: safe rollback is just
-- a git revert. No backfill needed.

BEGIN;

ALTER TABLE magic_links
  ADD COLUMN IF NOT EXISTS purpose         TEXT NOT NULL DEFAULT 'login',
  ADD COLUMN IF NOT EXISTS target_user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS target_id       UUID,
  ADD COLUMN IF NOT EXISTS action          TEXT;

-- Lookup index for the non-login path. Login (purpose='login') still uses
-- the existing token_hash index. This partial index keeps storage cheap.
CREATE INDEX IF NOT EXISTS idx_magic_links_purpose_target
  ON magic_links(purpose, target_id, target_user_id)
  WHERE purpose <> 'login';

COMMIT;
