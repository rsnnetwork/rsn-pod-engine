// ─── LinkedIn lookups to try once more, later (12 Nov 2026) ──────────────────
//
// ScrapingDog answers a page it holds no copy of with "it will be scraped and stored, try again after 2-3 minutes"
// (scrapingdog.provider.ts). A lookup that ends that way leaves one row in enrichment_retries (migration 153);
// enrichment-retry.worker.ts runs it once when run_at comes. The table holds only waiting rows: a claim deletes them.

import { query } from '../../db';
import logger from '../../config/logger';

/** How long after a "not stored yet" answer the one later attempt runs: ScrapingDog asks for 2-3 minutes; ten leaves room. */
export const ENRICH_RETRY_DELAY_MS = 10 * 60 * 1000;
/** Retries run one after another: the Lite plan allows two LinkedIn lookups at once, and a member's own run may be the other. */
export const ENRICH_RETRY_BATCH = 2;

export type EnrichRetrySubject = { joinRequestId: string; userId?: never } | { userId: string; joinRequestId?: never };

export interface DueEnrichRetry {
  id: string;
  join_request_id: string | null;
  user_id: string | null;
  linkedin_url: string;
  full_name: string | null;
}

export const SCHEDULE_RETRY_SQL = `INSERT INTO enrichment_retries (join_request_id, user_id, linkedin_url, full_name, run_at)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))
     ON CONFLICT DO NOTHING
     RETURNING id`;

export const CLAIM_DUE_RETRIES_SQL = `DELETE FROM enrichment_retries
      WHERE id IN (SELECT id FROM enrichment_retries
                    WHERE run_at <= NOW()
                    ORDER BY run_at
                    LIMIT $1
                    FOR UPDATE SKIP LOCKED)
  RETURNING id, join_request_id, user_id, linkedin_url, full_name`;

/**
 * Leave one later attempt for this lookup. A second call for a request or member that already has one waiting does
 * nothing (the partial unique indexes). Never throws: a lookup that cannot be retried is only logged.
 */
export async function scheduleEnrichmentRetry(
  subject: EnrichRetrySubject,
  input: { linkedinUrl: string; fullName?: string | null },
  delayMs: number = ENRICH_RETRY_DELAY_MS,
): Promise<boolean> {
  try {
    const res = await query<{ id: string }>(SCHEDULE_RETRY_SQL, [
      subject.joinRequestId ?? null,
      subject.userId ?? null,
      input.linkedinUrl,
      input.fullName ? input.fullName.slice(0, 200) : null,
      Math.round(delayMs / 1000),
    ]);
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
