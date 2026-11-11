// ─── The one later LinkedIn lookup (12 Nov 2026) ──────────────────────────────
//
// Called every minute from index.ts. Claims the retry that is due (enrichment-retry.repo: one DELETE ... RETURNING
// with FOR UPDATE SKIP LOCKED, so with several instances each runs on exactly one, once) and runs it. No Redis needed:
// the claim is the lock. A tick that finds the previous one still running does nothing.
//
// Only while lookups go to ScrapingDog (ENRICH_PROVIDER scrapingdog, the default): with claude_web or none nothing is
// claimed, so no prepaid Anthropic search runs for a ScrapingDog wait and no member's state is rewritten. Rows left
// waiting a day past their time are dropped either way, with the address and name they hold.
//
// What a retry does, reading everything as it is NOW:
//   - a member's own lookup (user_id): only for an active account still without a result, with the address on their profile now (a corrected
//     address is the one looked up; none at all, nothing runs), through the orchestrator, which keeps its own guards
//     (a fresh cached result or a lookup already running means no second call);
//   - an approval-time lookup (join_request_id): if the request is no longer approved, or already has its result,
//     nothing; if the applicant has an active account by now, their own lookup runs as above (the copy at login has
//     already happened, so a result left on the request would never reach them); otherwise the request's lookup runs
//     again, inside the 150 s deadline (enrichment-preload.ts).
// After a member's lookup, found or not, their screens are told through their own entity tag (user:<id>).
// Always with scheduleRetry false: a retry never asks for another.

import { query } from '../../db';
import logger from '../../config/logger';
import { fanoutUserEntity } from '../../realtime/fanout';
import { normalizeLinkedinUrl } from './enrichment.service';
import { resolveEnrichProvider } from './providers/registry';
import { getEnrichmentState } from './enrichment.repo';
import { claimDueEnrichmentRetries, purgeStaleEnrichmentRetries, type DueEnrichRetry } from './enrichment-retry.repo';
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

interface MemberNow {
  linkedin_url: string | null;
  display_name: string | null;
  status: string;
}

/**
 * The member's own lookup, with what their account says now: the address on their profile now (the scheduled one
 * only when the profile holds none: the older onboarding looks up an address it does not save), and nothing at all
 * for an account that is not active or a member who already has a result. Tells their screens.
 */
async function retryForMember(userId: string, why: 'member' | 'request', scheduledUrl: string): Promise<void> {
  const res = await query<MemberNow>(
    `SELECT linkedin_url, display_name, status::text AS status FROM users WHERE id = $1`,
    [userId],
  );
  const member = res.rows[0];
  const linkedinUrl = normalizeLinkedinUrl(member?.linkedin_url) ?? normalizeLinkedinUrl(scheduledUrl);
  if (!member || member.status !== 'active' || !linkedinUrl) {
    logger.info({ userId, why, found: !!member, status: member?.status, hasAddress: !!linkedinUrl },
      'enrichment retry: nothing to do for this member');
    return;
  }
  // A result since (their own later lookup found them): nothing to do. A lookup still running is the orchestrator's
  // own call: it skips a fresh 'searching' and takes over one a crash left behind.
  const state = await getEnrichmentState(userId).catch(() => null);
  if (state && (state.status === 'found' || state.status === 'partial')) {
    logger.info({ userId, why, status: state.status }, 'enrichment retry: the member already has a result');
    return;
  }
  logger.info({ userId, why }, 'enrichment retry: running the member\'s lookup again');
  await runEnrichment(userId, { linkedinUrl, fullName: member.display_name ?? undefined, scheduleRetry: false });
  await fanoutUserEntity(userId);
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
    logger.info({ joinRequestId: request.id, userId: request.user_id }, 'enrichment retry: the applicant has an account now');
    await retryForMember(request.user_id, 'request', request.linkedin_url ?? job.linkedin_url);
    return;
  }
  await preloadJoinRequestEnrichment(
    { id: request.id, fullName: request.full_name, email: request.email, linkedinUrl: request.linkedin_url ?? job.linkedin_url },
    { scheduleRetry: false },
  );
}

async function runRetry(job: DueEnrichRetry): Promise<void> {
  if (job.user_id) return retryForMember(job.user_id, 'member', job.linkedin_url);
  if (job.join_request_id) return retryForRequest({ ...job, join_request_id: job.join_request_id });
}

/** Run the retry that is due. Safe to call on an interval; never throws past its own log line. */
export async function processEnrichmentRetries(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const purged = await purgeStaleEnrichmentRetries();
    if (purged > 0) logger.info({ purged }, 'enrichment retry: dropped retries left waiting a day');
    if (resolveEnrichProvider() !== 'scrapingdog') return;
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
