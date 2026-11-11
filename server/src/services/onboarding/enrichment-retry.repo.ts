// ─── LinkedIn lookups to try once more, later (12 Nov 2026) ──────────────────
//
// ScrapingDog answers a page it holds no copy of with "it will be scraped and stored, try again after 2-3 minutes"
// (scrapingdog.provider.ts). A lookup that ends that way leaves one row in enrichment_retries (migration 155);
// enrichment-retry.worker.ts runs it once when run_at comes. The table holds only waiting rows: a claim deletes them.

import { query } from '../../db';
import logger from '../../config/logger';

/** How long after a "not stored yet" answer the one later attempt runs: ScrapingDog asks for 2-3 minutes; ten leaves room. */
export const ENRICH_RETRY_DELAY_MS = 10 * 60 * 1000;
/**
 * One retry per claim. The claim deletes what it takes before the lookup runs (up to about 150 s), so a deploy in
 * that window loses only the one it took; the others stay in the table for the next tick. One a minute is also all
 * the Lite plan's two LinkedIn lookups at once can spare beside members' own runs.
 */
export const ENRICH_RETRY_BATCH = 1;
/** A row still waiting this long after its time (lookups switched off, say) is dropped with its address and name. */
export const ENRICH_RETRY_STALE_HOURS = 24;

export type EnrichRetrySubject = { joinRequestId: string; userId?: never } | { userId: string; joinRequestId?: never };

export interface DueEnrichRetry {
  id: string;
  join_request_id: string | null;
  user_id: string | null;
  linkedin_url: string;
  full_name: string | null;
}

/** A request keeps its first waiting row: its address does not change. */
export const SCHEDULE_REQUEST_RETRY_SQL = `INSERT INTO enrichment_retries (join_request_id, user_id, linkedin_url, full_name, run_at)
     VALUES ($1, NULL, $2, $3, NOW() + make_interval(secs => $4))
     ON CONFLICT DO NOTHING
     RETURNING id`;

/** A member's latest address wins: a corrected address replaces the waiting row (and its time) rather than losing its own retry. */
export const SCHEDULE_USER_RETRY_SQL = `INSERT INTO enrichment_retries (join_request_id, user_id, linkedin_url, full_name, run_at)
     VALUES (NULL, $1, $2, $3, NOW() + make_interval(secs => $4))
     ON CONFLICT (user_id) WHERE user_id IS NOT NULL
     DO UPDATE SET linkedin_url = EXCLUDED.linkedin_url, full_name = EXCLUDED.full_name, run_at = EXCLUDED.run_at
     RETURNING id`;

export const CLAIM_DUE_RETRIES_SQL = `DELETE FROM enrichment_retries
      WHERE id IN (SELECT id FROM enrichment_retries
                    WHERE run_at <= NOW()
                    ORDER BY run_at
                    LIMIT $1
                    FOR UPDATE SKIP LOCKED)
  RETURNING id, join_request_id, user_id, linkedin_url, full_name`;

export const PURGE_STALE_RETRIES_SQL = `DELETE FROM enrichment_retries WHERE run_at < NOW() - make_interval(hours => $1)`;

/**
 * Leave one later attempt for this lookup. For a member, a second call replaces the waiting row (latest address
 * wins); for a request, a second call does nothing. Never throws: a lookup that cannot be retried is only logged.
 */
export async function scheduleEnrichmentRetry(
  subject: EnrichRetrySubject,
  input: { linkedinUrl: string; fullName?: string | null },
  delayMs: number = ENRICH_RETRY_DELAY_MS,
): Promise<boolean> {
  const name = input.fullName ? input.fullName.slice(0, 200) : null;
  const secs = Math.round(delayMs / 1000);
  try {
    const res = subject.userId
      ? await query<{ id: string }>(SCHEDULE_USER_RETRY_SQL, [subject.userId, input.linkedinUrl, name, secs])
      : await query<{ id: string }>(SCHEDULE_REQUEST_RETRY_SQL, [subject.joinRequestId, input.linkedinUrl, name, secs]);
    const scheduled = res.rows.length > 0;
    logger.info({ ...subject, scheduled, delayMs }, scheduled
      ? 'enrichment: one later lookup scheduled'
      : 'enrichment: a later lookup is already waiting');
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

/** Drop rows left waiting a day past their time. Returns how many. */
export async function purgeStaleEnrichmentRetries(): Promise<number> {
  const res = await query(PURGE_STALE_RETRIES_SQL, [ENRICH_RETRY_STALE_HOURS]);
  return res.rowCount ?? 0;
}
