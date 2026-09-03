-- 088_user_search_index.sql — platform-wide people search (13 Aug 2026, C1).
--
-- Claus could not find himself on the platform: the only member-facing search
-- was over people you had already met. Members can now search every active,
-- onboarded member by name, job title and company (GET /users/find).
--
-- Trigram indexes so ILIKE '%claus%' does not table-scan as the network grows.
-- pg_trgm is a trusted extension on Neon; neondb_owner can install it (probed
-- inside a rolled-back transaction on 3 Sep 2026 before this shipped). Plain
-- CREATE INDEX, not CONCURRENTLY: the runner wraps each file in a transaction,
-- and the table is small enough that the lock is momentary.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm
  ON users USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_job_title_trgm
  ON users USING gin (job_title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_company_trgm
  ON users USING gin (company gin_trgm_ops);
