-- LinkedIn lookups that ScrapingDog asked us to try again later (12 Nov 2026).
--
-- Since 6 Nov 2026 ScrapingDog answers a page it holds no copy of with "the copy of this profile will be scraped and
-- stored in our db, please try again after 2-3 minutes". A lookup that gets that answer (or a 202 or a rate limit that
-- outlasts its budget) leaves one row here, and a worker (enrichment-retry.worker.ts, every minute) tries it once more
-- when run_at comes:
--   join_request_id  the approval-time lookup for a request: written to the request (join_requests.enriched), or, when
--                    the applicant has an account by then, run as that member's own lookup.
--   user_id          the member's own lookup (onboarding, a LinkedIn change, an admin refresh).
-- Exactly one of the two is set. A row is deleted when it is claimed (DELETE ... RETURNING, FOR UPDATE SKIP LOCKED), so
-- several instances never run it twice, and the retry never asks for another: one later attempt, at most. A server that
-- restarts before run_at keeps the row; one that stops in the minute a retry runs loses that one attempt (the member's
-- next lookup or an admin refresh covers it).
-- The partial unique indexes keep one waiting row per request and per member (a second schedule does nothing).
-- linkedin_url and full_name are the lookup's input, kept only until the retry runs.
--
-- Only adds: one new table and its indexes, each made only when missing. Safe to run twice.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS enrichment_retries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  join_request_id UUID NULL REFERENCES join_requests(id) ON DELETE CASCADE,
  user_id         UUID NULL REFERENCES users(id) ON DELETE CASCADE,
  linkedin_url    TEXT NOT NULL,
  full_name       VARCHAR(200) NULL,
  run_at          TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT enrichment_retries_one_subject CHECK ((join_request_id IS NULL) <> (user_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_enrichment_retries_run_at ON enrichment_retries (run_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrichment_retries_join_request
  ON enrichment_retries (join_request_id) WHERE join_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_enrichment_retries_user
  ON enrichment_retries (user_id) WHERE user_id IS NOT NULL;
