-- 143: an index for the Everyone list's order (10 Nov 2026)
--
-- GET /api/people/everyone pages members A to Z on lower(COALESCE(display_name, '')) then id, and compares that same
-- pair for the next page. The index holds exactly the members the list shows (active, finished onboarding, kept
-- "Show me in search and suggestions" on), in that order, so a page is read from the index and not sorted from the
-- whole table. The expression is written the way the query writes it; a different spelling would not match.
-- Additive and idempotent. No CONCURRENTLY and no BEGIN/COMMIT: the runner wraps this file in its own transaction.
-- 132-134 belong to Part 1 and 135-142 are reserved for Part 2; the runner tracks files by name, so the gap is fine.

CREATE INDEX IF NOT EXISTS idx_users_everyone_name
  ON users ((lower(COALESCE(display_name, ''))), id)
  WHERE status = 'active' AND onboarding_completed = true AND profile_visible = true;
