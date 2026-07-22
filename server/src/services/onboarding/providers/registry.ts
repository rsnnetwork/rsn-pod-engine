// ─── Enrichment Provider Registry ────────────────────────────────────────────
//
// Resolves config.enrichProvider ('scrapingdog' | 'claude_web' | 'none') to an
// actual provider call, and normalizes both providers' outputs to the shared
// ProviderOutcome contract so the orchestrator (and the join-request preload,
// which has no user row yet and can't use the state machine) only ever branch
// on one shape.
//
// `enrichProvider` is a rollback switch meant to be hand-edited in an env var —
// an unrecognized/typo'd value fails SAFE (falls back to the default,
// scrapingdog) rather than silently going dark, logging a warning so the typo
// gets noticed and fixed.

import config from '../../../config';
import logger from '../../../config/logger';
import { scrapingdogProvider } from './scrapingdog.provider';
import { enrichProfile, type EnrichResult } from '../enrichment.service';
import type { ProviderOutcome } from './provider.types';

export type EnrichProviderName = 'scrapingdog' | 'claude_web' | 'none';

const VALID_PROVIDERS: ReadonlySet<string> = new Set(['scrapingdog', 'claude_web', 'none']);

/** Validated read of config.enrichProvider — unknown/typo'd values default to
 *  'scrapingdog' (logged), never silently disable enrichment. */
export function resolveEnrichProvider(): EnrichProviderName {
  const raw = config.enrichProvider;
  if (VALID_PROVIDERS.has(raw)) return raw as EnrichProviderName;
  logger.warn({ configured: raw }, 'enrichProvider: unrecognized config value — defaulting to scrapingdog');
  return 'scrapingdog';
}

/**
 * Confidence → terminal status. Shared by the 90-day-cache reflect path and
 * the legacy claude_web → ProviderOutcome mapping below. These are the
 * historical 0.35/0.6 thresholds the client already uses to decide whether to
 * show an enrichment candidate (ChatbotOnboarding.tsx) — see
 * enrichment.repo.ts's state-machine note for the third (0.15, namesake-floor)
 * threshold, which lives inside applyMatchVerification instead.
 */
export function statusFromConfidence(confidence: number): 'found' | 'partial' | 'not_found' {
  if (confidence >= 0.6) return 'found';
  if (confidence >= 0.35) return 'partial';
  return 'not_found';
}

/** Map the legacy claude_web EnrichResult onto the same ProviderOutcome shape
 *  scrapingdog returns, so callers never need a provider-specific branch. */
function legacyOutcome(result: EnrichResult): ProviderOutcome {
  const status = statusFromConfidence(result.confidence);
  if (status === 'not_found') return { kind: 'not_found', reason: 'low confidence match' };
  const photoUrl = result.profile?.photoUrl ?? null;
  return status === 'found'
    ? { kind: 'found', result, photoUrl }
    : { kind: 'partial', result, photoUrl, missing: [] };
}

export interface RunProviderInput {
  linkedinUrl: string;
  fullName?: string;
  email?: string | null;
  city?: string | null;
  country?: string | null;
  company?: string | null;
}

/**
 * Run the resolved provider. `provider` must already be narrowed away from
 * 'none' by the caller (both call sites short-circuit on 'none' before
 * reaching here — there is nothing for this function to do in that case).
 */
export async function runProvider(
  provider: Exclude<EnrichProviderName, 'none'>,
  input: RunProviderInput,
): Promise<ProviderOutcome> {
  if (provider === 'scrapingdog') {
    return scrapingdogProvider.enrich({ linkedinUrl: input.linkedinUrl, fullName: input.fullName });
  }
  // Legacy claude_web path. The Haiku→Sonnet escalation loop lives entirely
  // inside enrichProfile() — scrapingdog has no equivalent (identity is
  // deterministic there), so it's intentionally not reimplemented here.
  const result = await enrichProfile({
    fullName: input.fullName || '',
    email: input.email,
    city: input.city,
    country: input.country,
    company: input.company,
    linkedinUrl: input.linkedinUrl,
  });
  return legacyOutcome(result);
}

/** Extract the EnrichResult out of a ProviderOutcome, or null when the
 *  outcome carries no result (not_found/retry_exhausted/provider_error). */
export function resultFromOutcome(outcome: ProviderOutcome): EnrichResult | null {
  return outcome.kind === 'found' || outcome.kind === 'partial' ? outcome.result : null;
}
