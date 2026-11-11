// ─── The one later LinkedIn lookup (12 Nov 2026) ──────────────────────────────
//
// Called every minute from index.ts. Claims the retries that are due (enrichment-retry.repo: one DELETE ... RETURNING
// with FOR UPDATE SKIP LOCKED, so with several instances each runs on exactly one, once) and runs them one after
// another. No Redis needed: the claim is the lock. A tick that finds the previous one still running does nothing.
//
// What a retry does:
//   - a member's own lookup (user_id): runs it again through the orchestrator, which keeps its own guards (a fresh
//     cached result or a lookup already running means no second call);
//   - an approval-time lookup (join_request_id): if the request is no longer approved, or already has its result, nothing;
//     if the applicant has an active account by now, their own lookup runs (the copy at login has already happened, so a
//     result left on the request would never reach them); otherwise the request's lookup runs again.
// Either way with scheduleRetry false: a retry never asks for another.

import { query } from '../../db';
import logger from '../../config/logger';
import { claimDueEnrichmentRetries, type DueEnrichRetry } from './enrichment-retry.repo';
import { runEnrichment } from './enrichment.orchestrator';
import { preloadJoinRequestEnrichment } from '../join-request/enrichment-preload';

export const ENRICH_RETRY_INTERVAL_MS = 60_000;

let running = false;

interface RequestNow {
  id: string;
  full_name: string;
  email: string;
  linkedin_url: string | null;
  status: string;
  has_result: boolean;
  user_id: string | null;
}

async function retryForRequest(job: DueEnrichRetry & { join_request_id: string }): Promise<void> {
  const res = await query<RequestNow>(
    `SELECT jr.id, jr.full_name, jr.email, jr.linkedin_url, jr.status::text AS status,
            (jr.enriched IS NOT NULL) AS has_result,
            (SELECT u.id FROM users u WHERE LOWER(u.email) = LOWER(jr.email) AND u.status::text = 'active' LIMIT 1) AS user_id
       FROM join_requests jr
      WHERE jr.id = $1`,
    [job.join_request_id],
  );
  const request = res.rows[0];
  if (!request || request.status !== 'approved' || request.has_result) {
    logger.info({ joinRequestId: job.join_request_id, found: !!request, status: request?.status, hasResult: request?.has_result },
      'enrichment retry: nothing to do for this request');
    return;
  }
  if (request.user_id) {
    logger.info({ joinRequestId: request.id, userId: request.user_id }, 'enrichment retry: the applicant has an account now; running their own lookup');
    await runEnrichment(request.user_id, { linkedinUrl: request.linkedin_url ?? job.linkedin_url, fullName: request.full_name, scheduleRetry: false });
    return;
  }
  await preloadJoinRequestEnrichment(
    { id: request.id, fullName: request.full_name, email: request.email, linkedinUrl: request.linkedin_url ?? job.linkedin_url },
    { scheduleRetry: false },
  );
}

async function runRetry(job: DueEnrichRetry): Promise<void> {
  if (job.user_id) {
    logger.info({ userId: job.user_id }, 'enrichment retry: running the member\'s lookup again');
    await runEnrichment(job.user_id, { linkedinUrl: job.linkedin_url, fullName: job.full_name ?? undefined, scheduleRetry: false });
    return;
  }
  if (job.join_request_id) await retryForRequest({ ...job, join_request_id: job.join_request_id });
}

/** Run the retries that are due. Safe to call on an interval; never throws past its own log line. */
export async function processEnrichmentRetries(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = await claimDueEnrichmentRetries();
    for (const job of due) {
      try {
        await runRetry(job);
      } catch (err) {
        logger.warn({ err, retryId: job.id, joinRequestId: job.join_request_id, userId: job.user_id }, 'enrichment retry failed (non-fatal)');
      }
    }
  } finally {
    running = false;
  }
}
