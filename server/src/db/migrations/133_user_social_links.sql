-- Profile links beside LinkedIn (10 Nov 2026, Stefan: "There should also be website next to linkedin link, and
-- perhaps other social media too"). Four optional addresses on the member's profile, each public like LinkedIn.
-- The server stores them in the form shared/src/profile/links.ts makes (https, the platform's own host), and the
-- 300-character limit is checked here as well, so no route can write a longer one.
--
-- Additive and idempotent: a column with no default does not rewrite the table, and every existing row simply has
-- none. The CHECKs are named and added in a DO block that looks at pg_constraint, so a rerun changes nothing.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS website_url TEXT,
  ADD COLUMN IF NOT EXISTS instagram_url TEXT,
  ADD COLUMN IF NOT EXISTS x_url TEXT,
  ADD COLUMN IF NOT EXISTS facebook_url TEXT;

DO $$
DECLARE
  col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY['website_url', 'instagram_url', 'x_url', 'facebook_url'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'users'::regclass AND conname = 'users_' || col || '_length_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE users ADD CONSTRAINT %I CHECK (%I IS NULL OR char_length(%I) <= 300)',
        'users_' || col || '_length_check', col, col
      );
    END IF;
  END LOOP;
END $$;
