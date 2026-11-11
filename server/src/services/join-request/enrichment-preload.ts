// ─── The approval-time LinkedIn lookup ────────────────────────────────────────
//
// Run in the background when a join request is approved, during the approval → login gap, so the member's profile
// card is filled the moment they log in (identity.service copies join_requests.enriched forward). Routed through the
// same provider registry the onboarding orchestrator uses, but with no user row yet it cannot use the user-scoped
// enrichment state machine: it writes straight to join_requests.enriched.
//
// 12 Nov 2026: a lookup that found nothing was dropped without a word (`if (!result) return;`), which hid six days of
// ScrapingDog answering "not stored yet, try again after 2-3 minutes". Every empty end is logged now, and a lookup that
// ScrapingDog asked us to repeat later gets one later attempt (enrichment-retry.repo / .worker).

import { query } from '../../db';
import logger from '../../config/logger';
import { applyMatchVerification, normalizeLinkedinUrl } from '../onboarding/enrichment.service';
import { resolveEnrichProvider, runProvider, resultFromOutcome } from '../onboarding/providers/registry';
import type { ProviderOutcome } from '../onboarding/providers/provider.types';
import { scheduleEnrichmentRetry } from '../onboarding/enrichment-retry.repo';

export interface PreloadInput {
  id: string;
  fullName: string;
  email: string;
  linkedinUrl: string | null;
}

/** Why a lookup brought back no profile, for the log: the outcome's own reason, or what kind of wait it was. */
export function emptyReason(outcome: ProviderOutcome): string {
  switch (outcome.kind) {
    case 'not_found':
    case 'provider_error':
      return outcome.reason;
    case 'retry_exhausted':
      if (outcome.notReady) return 'not stored yet (asked to try again later)';
      return outcome.rateLimited ? 'rate limited' : 'still 202 when the budget ran out';
    default:
      return 'no result';
  }
}

/**
 * Look the applicant up and keep what is found on the request. Never throws. `scheduleRetry` is false for the one
 * later attempt itself, so a retry never asks for another.
 */
export async function preloadJoinRequestEnrichment(
  request: PreloadInput,
  options: { scheduleRetry: boolean },
): Promise<void> {
  try {
    const provider = resolveEnrichProvider();
    if (provider === 'none') return;
    // LinkedIn is optional on the form: with no address (NULL, or an empty string in older rows) there
    // is nothing to look up, and no paid lookup is run. Approval itself never depends on it.
    const linkedinUrl = normalizeLinkedinUrl(request.linkedinUrl);
    if (!linkedinUrl) return;
    const outcome = await runProvider(provider, {
      linkedinUrl,
      fullName: request.fullName,
      email: request.email,
    });
    const result = resultFromOutcome(outcome);
    if (!result) {
      const retryScheduled = outcome.kind === 'retry_exhausted' && options.scheduleRetry
        ? await scheduleEnrichmentRetry({ joinRequestId: request.id }, { linkedinUrl, fullName: request.fullName })
        : false;
      logger.warn(
        { joinRequestId: request.id, provider, outcome: outcome.kind, reason: emptyReason(outcome), retryScheduled, retry: !options.scheduleRetry },
        'join-request enrichment preload found nothing',
      );
      return;
    }
    const verified = applyMatchVerification(result, linkedinUrl);
    if (verified.confidence <= 0) {
      logger.warn({ joinRequestId: request.id, provider, outcome: outcome.kind, reason: 'identity check rejected the match' },
        'join-request enrichment preload found nothing');
      return;
    }
    // Stash the RESOLVED provider onto the cached blob (additive — every
    // existing reader of this JSONB duck-types it and none reads
    // `provider` strictly) so identity.service.ts's copy-forward can
    // attribute the preload to whichever provider actually ran instead of
    // assuming a fixed one.
    await query(`UPDATE join_requests SET enriched = $1::jsonb WHERE id = $2`, [
      JSON.stringify({ ...verified, provider }),
      request.id,
    ]);
    logger.info({ joinRequestId: request.id, provider, outcome: outcome.kind, retry: !options.scheduleRetry }, 'join-request enrichment preload saved');
  } catch (err) {
    logger.warn({ err, joinRequestId: request.id }, 'join-request enrichment preload failed (non-fatal)');
  }
}
