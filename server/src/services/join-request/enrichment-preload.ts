// ─── The approval-time LinkedIn lookup ────────────────────────────────────────
//
// Run in the background when a join request is approved, during the approval → login gap, so the member's profile
// card is filled the moment they log in (identity.service copies join_requests.enriched forward). Routed through the
// same provider registry the onboarding orchestrator uses, but with no user row yet it cannot use the user-scoped
// enrichment state machine: it writes straight to join_requests.enriched.
//
// 12 Nov 2026: a lookup that found nothing was dropped without a word (`if (!result) return;`), which hid six days of
// ScrapingDog answering "not stored yet, try again after 2-3 minutes". Every empty end is logged now (ids and a reason,
// never a name, email or address), and a lookup that ScrapingDog asked us to repeat later gets up to two later attempts
// (enrichment-retry.repo / .worker). The lookup has the same 150 s deadline as a member's own (providers/deadline.ts);
// a profile that arrives after it is still kept.

import { query } from '../../db';
import logger from '../../config/logger';
import { applyMatchVerification, normalizeLinkedinUrl } from '../onboarding/enrichment.service';
import { resolveEnrichProvider, runProvider, resultFromOutcome, type EnrichProviderName } from '../onboarding/providers/registry';
import type { ProviderOutcome } from '../onboarding/providers/provider.types';
import { raceProviderDeadline } from '../onboarding/providers/deadline';
import { nextRetryAttempt, scheduleEnrichmentRetry } from '../onboarding/enrichment-retry.repo';

export interface PreloadInput {
  id: string;
  fullName: string;
  email: string;
  linkedinUrl: string | null;
}

/** Why a lookup brought back no profile, for the log: the outcome's own reason (already scrubbed of the key and the
 *  profile id by the provider), or what kind of wait it was. */
export function emptyReason(outcome: ProviderOutcome): string {
  switch (outcome.kind) {
    case 'not_found':
    case 'provider_error':
      return outcome.reason;
    case 'retry_exhausted':
      if (outcome.notReady) return 'not stored yet (asked to try again later)';
      if (outcome.timedOut) return 'timed out (outcome unknown)';
      return outcome.rateLimited ? 'rate limited' : 'still 202 when the budget ran out';
    default:
      return 'no result';
  }
}

/** Keep a found profile on the request. A late answer only fills a request that has none yet. */
async function keepOnRequest(
  requestId: string,
  provider: EnrichProviderName,
  outcome: ProviderOutcome,
  linkedinUrl: string,
  late: boolean,
): Promise<boolean> {
  const result = resultFromOutcome(outcome);
  if (!result) return false;
  const verified = applyMatchVerification(result, linkedinUrl);
  if (verified.confidence <= 0) {
    logger.warn({ joinRequestId: requestId, provider, outcome: outcome.kind, reason: 'identity check rejected the match', late },
      'join-request enrichment preload found nothing');
    return true;
  }
  // Stash the RESOLVED provider onto the cached blob (additive — every
  // existing reader of this JSONB duck-types it and none reads
  // `provider` strictly) so identity.service.ts's copy-forward can
  // attribute the preload to whichever provider actually ran instead of
  // assuming a fixed one.
  await query(
    late
      ? `UPDATE join_requests SET enriched = $1::jsonb WHERE id = $2 AND enriched IS NULL`
      : `UPDATE join_requests SET enriched = $1::jsonb WHERE id = $2`,
    [JSON.stringify({ ...verified, provider }), requestId],
  );
  logger.info({ joinRequestId: requestId, provider, outcome: outcome.kind, late }, 'join-request enrichment preload saved');
  return true;
}

/**
 * Look the applicant up and keep what is found on the request. Never throws. `retryAttempt` is 0 at approval, and the
 * later attempt's number (1 or 2) when the retry worker runs it: the next one is asked for only while one is allowed.
 */
export async function preloadJoinRequestEnrichment(
  request: PreloadInput,
  options: { retryAttempt: number },
): Promise<void> {
  try {
    const provider = resolveEnrichProvider();
    if (provider === 'none') return;
    // LinkedIn is optional on the form: with no address (NULL, or an empty string in older rows) there
    // is nothing to look up, and no paid lookup is run. Approval itself never depends on it.
    const linkedinUrl = normalizeLinkedinUrl(request.linkedinUrl);
    if (!linkedinUrl) return;
    const { outcome, late } = await raceProviderDeadline(
      runProvider(provider, { linkedinUrl, fullName: request.fullName, email: request.email }),
      { joinRequestId: request.id },
    );
    if (late) {
      late
        .then((answer) => keepOnRequest(request.id, provider, answer, linkedinUrl, true))
        .catch((err) => logger.warn({ err, joinRequestId: request.id }, 'join-request enrichment preload: keeping the late answer failed'));
    }
    if (await keepOnRequest(request.id, provider, outcome, linkedinUrl, false)) return;
    const nextAttempt = nextRetryAttempt(options.retryAttempt);
    const retryScheduled = outcome.kind === 'retry_exhausted' && nextAttempt !== null
      ? await scheduleEnrichmentRetry({ joinRequestId: request.id }, { linkedinUrl, fullName: request.fullName }, nextAttempt)
      : false;
    logger.warn(
      { joinRequestId: request.id, provider, outcome: outcome.kind, reason: emptyReason(outcome), retryScheduled, attempt: options.retryAttempt },
      'join-request enrichment preload found nothing',
    );
  } catch (err) {
    logger.warn({ err, joinRequestId: request.id }, 'join-request enrichment preload failed (non-fatal)');
  }
}
