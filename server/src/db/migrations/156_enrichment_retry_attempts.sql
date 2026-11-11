-- A second later attempt for a LinkedIn lookup, and a bound on how many are scheduled (12 Nov 2026).
--
-- The 12 Nov backfill showed ScrapingDog storing a page it said would be ready "after 2-3 minutes" only 12 minutes or
-- more later, if at all. A lookup now gets up to two later attempts: at +10 minutes, then 30 minutes after that.
--   enrichment_retries.attempt  which later attempt a waiting row is: 1 or 2 (1 for every row made before this file).
--                               The attempt-2 run never schedules another.
--   enrichment_retry_log        one row per later attempt scheduled (a member's corrected address replacing the waiting
--                               row counts too), for its request or member. enrichment-retry.repo refuses a fourth in
--                               24 hours for the same request or member, so no chain of address changes or retries can
--                               keep scheduling. Rows older than 48 hours are dropped by the retry worker. No address or
--                               name is kept here.
-- Exactly one of user_id / join_request_id is set; both delete with their request or member.
--
-- Only adds: a column with a default, a CHECK dropped before it is added, one table and its indexes, a partial index on
-- user_intent_profiles for the sweep, each made only when
-- missing. Safe to run twice. No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE enrichment_retries ADD COLUMN IF NOT EXISTS attempt SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE enrichment_retries DROP CONSTRAINT IF EXISTS enrichment_retries_attempt_range;
ALTER TABLE enrichment_retries ADD CONSTRAINT enrichment_retries_attempt_range CHECK (attempt BETWEEN 1 AND 2);

CREATE TABLE IF NOT EXISTS enrichment_retry_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  join_request_id UUID NULL REFERENCES join_requests(id) ON DELETE CASCADE,
  user_id         UUID NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT enrichment_retry_log_one_subject CHECK ((join_request_id IS NULL) <> (user_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_enrichment_retry_log_user
  ON enrichment_retry_log (user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enrichment_retry_log_request
  ON enrichment_retry_log (join_request_id, created_at) WHERE join_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enrichment_retry_log_created ON enrichment_retry_log (created_at);

-- The interrupted-lookup sweep (enrichment.repo failInterruptedLookups) reads, every minute on every instance, only the
-- rows still 'searching': a partial index keeps that read to those rows however many members there are.
CREATE INDEX IF NOT EXISTS idx_uip_enrichment_searching
  ON user_intent_profiles (enrichment_started_at) WHERE enrichment_status = 'searching';
