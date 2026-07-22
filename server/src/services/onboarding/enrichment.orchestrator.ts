// ─── Enrichment Orchestrator ──────────────────────────────────────────────────
//
// Background job that takes a member from "here's a LinkedIn URL" to a
// terminal enrichment state (found / partial / not_found / failed), persisted
// via the state machine A4 built (enrichment.repo.ts). Fire-and-forget-safe:
// callers (POST /onboarding/enrich, the join-request approval preload) invoke
// this without awaiting completion — it NEVER throws, so a crash here can
// never surface as an unhandled rejection or a 500.
//
// Steps (task A5 spec):
//   1. provider 'none' or no linkedinUrl           → not_found, return
//   2. fresh 90-day cache + same slug              → reflect cached status, return
//   3. write 'searching' + log start
//   4. call the resolved provider (registry.ts)
//   5. found/partial → facts-grounded extras pass (tolerant of failure)
//   6. save candidate + terminal state (found/partial)
//   7. not_found/retry_exhausted/provider_error → terminal state (not_found/failed)
//   8. every terminal transition logs { userId, provider, outcome, durationMs }
//   9. the Haiku→Sonnet escalation loop stays inside the legacy claude_web path
//      (enrichProfile) only — scrapingdog's identity is deterministic, nothing
//      to escalate.

import config from '../../config';
import logger from '../../config/logger';
import {
  applyMatchVerification,
  getClient,
  linkedinSlug,
  normalizeLinkedinUrl,
  type EnrichedProfile,
  type EnrichResult,
} from './enrichment.service';
import { getCachedEnrichment, saveEnrichedCandidate, setEnrichmentState } from './enrichment.repo';
import { resolveEnrichProvider, runProvider, statusFromConfidence, type EnrichProviderName } from './providers/registry';
import type { ProviderOutcome } from './providers/provider.types';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface RunEnrichmentInput {
  linkedinUrl: string | null;
  fullName?: string;
}

/** True when `cached` is usable as-is for `requestedLinkedinUrl` — no genuinely
 *  new URL supplied, and not older than 90 days. Exported so the route can make
 *  the same 202-vs-200 decision the orchestrator's own cache step makes,
 *  without duplicating the freshness rule in two places. */
export function isFreshCacheHit(cached: EnrichResult | null, requestedLinkedinUrl: string | null): boolean {
  if (!cached || cached.confidence <= 0) return false;
  const sameLinkedin =
    !requestedLinkedinUrl ||
    !cached.requestedLinkedinUrl ||
    linkedinSlug(requestedLinkedinUrl) === linkedinSlug(cached.requestedLinkedinUrl);
  const fresh = !cached.enrichedAt || Date.now() - new Date(cached.enrichedAt).getTime() < NINETY_DAYS_MS;
  return sameLinkedin && fresh;
}

function logTerminal(userId: string, provider: EnrichProviderName, outcome: string, startedAtMs: number, extra?: Record<string, unknown>): void {
  // stage-event recording (E1) lands with the admin-inspector workstream — this
  // call site is the single seam it will hook into once that table exists.
  logger.info({ userId, provider, outcome, durationMs: Date.now() - startedAtMs, ...extra }, 'enrichment terminal');
}

async function writeState(userId: string, state: Parameters<typeof setEnrichmentState>[1]): Promise<void> {
  try {
    await setEnrichmentState(userId, state);
  } catch (err) {
    logger.warn({ err, userId, state }, 'enrichment: failed to persist state transition (non-fatal)');
  }
}

interface ExtrasFields {
  likelyWantsToMeet: string[];
  likelyOffers: string[];
  conversationStarters: string[];
  questionsToVerify: string[];
}

const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];

/** Tolerant JSON extraction — same shape as enrichment.service.ts's
 *  parseEnriched: pull the first {...} block, ignore surrounding prose. */
function parseExtras(text: string): ExtrasFields | null {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return {
      likelyWantsToMeet: strArr(j.likelyWantsToMeet),
      likelyOffers: strArr(j.likelyOffers),
      conversationStarters: strArr(j.conversationStarters),
      questionsToVerify: strArr(j.questionsToVerify),
    };
  } catch {
    return null;
  }
}

/**
 * One no-tools Haiku call grounded ONLY in the facts the provider already
 * fetched — suggests the soft, hosting-facing fields the deterministic
 * scrapingdog path can't produce on its own (it always returns these as []).
 * Never throws into the orchestrator: any failure here is logged and the
 * enrichment proceeds to its success state without the extras.
 */
async function runExtrasPass(profile: EnrichedProfile, userId: string): Promise<ExtrasFields | null> {
  try {
    const resp = await getClient().messages.create({
      model: config.onboardingChatModel,
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content:
            'From these verified facts only, suggest likelyWantsToMeet, likelyOffers, ' +
            '3 conversationStarters, questionsToVerify. JSON only.\n\n' +
            JSON.stringify(profile),
        },
      ],
    });
    const text = resp.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('\n');
    return parseExtras(text);
  } catch (err) {
    logger.warn({ err, userId }, 'enrichment extras pass failed — proceeding without extras');
    return null;
  }
}

async function withExtras(result: EnrichResult, userId: string): Promise<EnrichResult> {
  if (!result.profile) return result;
  const extras = await runExtrasPass(result.profile, userId);
  if (!extras) return result;
  return { ...result, profile: { ...result.profile, ...extras } };
}

function mapFailureOutcome(
  outcome: Extract<ProviderOutcome, { kind: 'not_found' | 'retry_exhausted' | 'provider_error' }>,
): { status: 'not_found' | 'failed'; error: string } {
  switch (outcome.kind) {
    case 'not_found':
      return { status: 'not_found', error: outcome.reason };
    case 'provider_error':
      return { status: 'failed', error: outcome.reason };
    case 'retry_exhausted':
      return { status: 'failed', error: 'retry exhausted' };
  }
}

/**
 * Run one enrichment attempt for `userId`. Fire-and-forget-safe: writes every
 * state transition itself and NEVER throws, so callers only need `.catch()`
 * as a belt-and-braces guard against a truly unexpected rejection escaping
 * the try/catch below (there shouldn't be one).
 */
export async function runEnrichment(userId: string, input: RunEnrichmentInput): Promise<void> {
  const startedAtMs = Date.now();
  let provider: EnrichProviderName = 'none';
  try {
    provider = resolveEnrichProvider();
    const linkedinUrl = normalizeLinkedinUrl(input.linkedinUrl);

    // Step 1: no URL at all, or enrichment deliberately killed.
    if (!linkedinUrl) {
      await writeState(userId, { status: 'not_found', error: 'no linkedin url', source: null });
      logTerminal(userId, provider, 'not_found', startedAtMs);
      return;
    }
    if (provider === 'none') {
      await writeState(userId, { status: 'not_found', error: null, source: null });
      logTerminal(userId, provider, 'not_found', startedAtMs);
      return;
    }

    // Step 2: 90-day cache.
    const cached = await getCachedEnrichment(userId).catch(() => null);
    if (isFreshCacheHit(cached, linkedinUrl)) {
      const status = statusFromConfidence(cached!.confidence);
      await writeState(userId, { status });
      logTerminal(userId, provider, status, startedAtMs, { cacheHit: true });
      return;
    }

    // Step 3: searching.
    await writeState(userId, { status: 'searching', source: provider });
    logger.info({ userId, slug: linkedinSlug(linkedinUrl), provider }, 'enrichment searching');

    // Step 4: call the provider.
    const outcome = await runProvider(provider as Exclude<EnrichProviderName, 'none'>, {
      linkedinUrl,
      fullName: input.fullName,
    });

    // Steps 5-6: found/partial.
    if (outcome.kind === 'found' || outcome.kind === 'partial') {
      let result = applyMatchVerification(outcome.result, linkedinUrl);
      result = await withExtras(result, userId);
      await saveEnrichedCandidate(userId, result).catch((err) =>
        logger.warn({ err, userId }, 'enrichment: saveEnrichedCandidate failed (non-fatal)'),
      );
      await writeState(userId, { status: outcome.kind, source: provider });
      // A7 (photo capture) hooks in here — outcome.photoUrl is available once
      // that task exists; nothing to kick yet.
      logTerminal(userId, provider, outcome.kind, startedAtMs);
      return;
    }

    // Step 7: not_found / retry_exhausted / provider_error.
    const { status, error } = mapFailureOutcome(outcome);
    await writeState(userId, { status, error, source: provider });
    logTerminal(userId, provider, status, startedAtMs);
  } catch (err) {
    // Never throws: any unexpected failure still lands in a terminal, visible
    // state rather than disappearing into an unhandled rejection.
    logger.error({ err, userId, provider }, 'enrichment orchestrator crashed — marking failed');
    await writeState(userId, {
      status: 'failed',
      error: err instanceof Error ? err.message : 'unknown orchestrator error',
      source: provider === 'none' ? null : provider,
    });
    logTerminal(userId, provider, 'failed', startedAtMs, { crashed: true });
  }
}
