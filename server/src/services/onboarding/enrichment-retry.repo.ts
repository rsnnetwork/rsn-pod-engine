// ─── LinkedIn lookups to try again, later (12 Nov 2026) ─────────────────────
//
// ScrapingDog answers a page it holds no copy of with "it will be scraped and stored, try again after 2-3 minutes"
// (scrapingdog.provider.ts). A lookup that ends that way leaves one row in enrichment_retries (migration 155);
// enrichment-retry.worker.ts runs it when run_at comes. The table holds only waiting rows: a claim deletes them.
//
// Up to two later attempts per lookup (migration 156, after the 12 Nov backfill found copies stored 12+ minutes on, not
// 2-3): attempt 1 at +10 minutes, attempt 2 thirty minutes after that; attempt 2 schedules nothing. Every scheduled
// attempt is written to enrichment_retry_log, and a fourth in 24 hours for the same request or member is refused, so a
// run of corrected addresses (each of which restarts at attempt 1) cannot keep a chain going.

import { query } from '../../db';
import logger from '../../config/logger';

/** Later attempts per lookup, and when each runs after the attempt before it: ScrapingDog asks for 2-3 minutes; the
 *  backfill saw stored copies 12 minutes on or later. Attempts at 0, +10 and +40 minutes. */
export const ENRICH_MAX_RETRIES = 2;
export const ENRICH_RETRY_DELAYS_MS: readonly number[] = [10 * 60 * 1000, 30 * 60 * 1000];
/** At most this many later attempts scheduled per request or per member in any 24 hours. */
export const ENRICH_RETRY_DAILY_LIMIT = 3;
/**
 * One retry per claim. The claim deletes what it takes before the lookup runs (up to about 150 s), so a deploy in
 * that window loses only the one it took; the others stay in the table for the next tick. One a minute is also all
 * the Lite plan's two LinkedIn lookups at once can spare beside members' own runs.
 */
export const ENRICH_RETRY_BATCH = 1;
/** A row still waiting this long after its time (lookups switched off, say) is dropped with its address and name. */
export const ENRICH_RETRY_STALE_HOURS = 24;
/** Log rows are only read for the last 24 hours; older than this they are dropped. */
export const ENRICH_RETRY_LOG_KEEP_HOURS = 48;

export type EnrichRetrySubject = { joinRequestId: string; userId?: never } | { userId: string; joinRequestId?: never };

export interface DueEnrichRetry {
  id: string;
  join_request_id: string | null;
  user_id: string | null;
  linkedin_url: string;
  full_name: string | null;
  /** Which later attempt this is: 1 or 2. */
  attempt: number;
}

/**
 * A request keeps its first waiting row (its address does not change). Inserted, and logged, only while the request
 * has had fewer than $5 later attempts scheduled in 24 hours. One statement: the bound, the row and the log together.
 */
export const SCHEDULE_REQUEST_RETRY_SQL = `WITH allowed AS (
       SELECT count(*) < $5 AS ok FROM enrichment_retry_log
        WHERE join_request_id = $1 AND created_at > NOW() - interval '24 hours'),
     ins AS (
       INSERT INTO enrichment_retries (join_request_id, user_id, linkedin_url, full_name, run_at, attempt)
       SELECT $1, NULL, $2, $3, NOW() + make_interval(secs => $4), $6 FROM allowed WHERE ok
       ON CONFLICT DO NOTHING
       RETURNING id),
     logged AS (INSERT INTO enrichment_retry_log (join_request_id) SELECT $1 FROM ins RETURNING id)
     SELECT id FROM ins`;

/**
 * A member's latest address wins: a corrected address replaces the waiting row, its time and its attempt (a new
 * address starts again at attempt 1), rather than losing its own retry. Bounded and logged like a request's.
 */
export const SCHEDULE_USER_RETRY_SQL = `WITH allowed AS (
       SELECT count(*) < $5 AS ok FROM enrichment_retry_log
        WHERE user_id = $1 AND created_at > NOW() - interval '24 hours'),
     ins AS (
       INSERT INTO enrichment_retries (join_request_id, user_id, linkedin_url, full_name, run_at, attempt)
       SELECT NULL, $1, $2, $3, NOW() + make_interval(secs => $4), $6 FROM allowed WHERE ok
       ON CONFLICT (user_id) WHERE user_id IS NOT NULL
       DO UPDATE SET linkedin_url = EXCLUDED.linkedin_url, full_name = EXCLUDED.full_name, run_at = EXCLUDED.run_at,
                     attempt = EXCLUDED.attempt
       RETURNING id),
     logged AS (INSERT INTO enrichment_retry_log (user_id) SELECT $1 FROM ins RETURNING id)
     SELECT id FROM ins`;

export const CLAIM_DUE_RETRIES_SQL = `DELETE FROM enrichment_retries
      WHERE id IN (SELECT id FROM enrichment_retries
                    WHERE run_at <= NOW()
                    ORDER BY run_at
                    LIMIT $1
                    FOR UPDATE SKIP LOCKED)
  RETURNING id, join_request_id, user_id, linkedin_url, full_name, attempt`;

export const PURGE_STALE_RETRIES_SQL = `DELETE FROM enrichment_retries WHERE run_at < NOW() - make_interval(hours => $1)`;
export const PURGE_RETRY_LOG_SQL = `DELETE FROM enrichment_retry_log WHERE created_at < NOW() - make_interval(hours => $1)`;

/** The attempt after `attempt` (0 for a lookup that is not itself a retry), or null when no more are allowed. */
export function nextRetryAttempt(attempt: number): number | null {
  const next = attempt + 1;
  return next >= 1 && next <= ENRICH_MAX_RETRIES ? next : null;
}

/**
 * Leave later attempt `attempt` (1 or 2) for this lookup. For a member, a second call replaces the waiting row (latest
 * address wins); for a request, a second call does nothing. Refused past ENRICH_RETRY_DAILY_LIMIT in 24 hours. Never
 * throws: a lookup that cannot be retried is only logged.
 */
export async function scheduleEnrichmentRetry(
  subject: EnrichRetrySubject,
  input: { linkedinUrl: string; fullName?: string | null },
  attempt: number = 1,
): Promise<boolean> {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > ENRICH_MAX_RETRIES) return false;
  const name = input.fullName ? input.fullName.slice(0, 200) : null;
  const delayMs = ENRICH_RETRY_DELAYS_MS[attempt - 1];
  const secs = Math.round(delayMs / 1000);
  try {
    const res = subject.userId
      ? await query<{ id: string }>(SCHEDULE_USER_RETRY_SQL, [subject.userId, input.linkedinUrl, name, secs, ENRICH_RETRY_DAILY_LIMIT, attempt])
      : await query<{ id: string }>(SCHEDULE_REQUEST_RETRY_SQL, [subject.joinRequestId, input.linkedinUrl, name, secs, ENRICH_RETRY_DAILY_LIMIT, attempt]);
    const scheduled = res.rows.length > 0;
    logger.info({ ...subject, scheduled, attempt, delayMs }, scheduled
      ? 'enrichment: a later lookup scheduled'
      : 'enrichment: no later lookup scheduled (one is waiting, or the 24-hour limit is reached)');
    return scheduled;
  } catch (err) {
    logger.warn({ err, ...subject }, 'enrichment: could not schedule the later lookup');
    return false;
  }
}

/** Take the retries that are due, removing them, so no other instance (or later tick) runs them again. */
export async function claimDueEnrichmentRetries(limit: number = ENRICH_RETRY_BATCH): Promise<DueEnrichRetry[]> {
  const res = await query<DueEnrichRetry>(CLAIM_DUE_RETRIES_SQL, [limit]);
  return res.rows;
}

/** Drop rows left waiting a day past their time, and log rows past their use. Returns how many waiting rows. */
export async function purgeStaleEnrichmentRetries(): Promise<number> {
  const res = await query(PURGE_STALE_RETRIES_SQL, [ENRICH_RETRY_STALE_HOURS]);
  await query(PURGE_RETRY_LOG_SQL, [ENRICH_RETRY_LOG_KEEP_HOURS]);
  return res.rowCount ?? 0;
}
