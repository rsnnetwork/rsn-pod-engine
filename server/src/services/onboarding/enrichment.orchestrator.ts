// ─── Enrichment Orchestrator ──────────────────────────────────────────────────
//
// Background job that takes a member from "here's a LinkedIn URL" to a
// terminal enrichment state (found / partial / not_found / failed), persisted
// via the state machine A4 built (enrichment.repo.ts). Fire-and-forget-safe:
// callers (POST /onboarding/enrich, the join-request approval preload) invoke
// this without awaiting completion — it NEVER throws, so a crash here can
// never surface as an unhandled rejection or a 500.
//
// Steps (task A5 spec, revised in fix round 1 — see the review findings this
// file's tests are organized around):
//   0. concurrency guards — an in-flight Map (same process) and a persisted
//      'searching' state fresher than 5 minutes (crash-tolerant, cross-process)
//      both short-circuit a duplicate attempt before it can double-spend a
//      provider call.
//   1. fresh 90-day cache — evaluated BEFORE the no-URL branch below, using
//      whatever URL this call was given (which may be null). A null URL this
//      call is not itself a reason to distrust a fresh cache: isFreshCacheHit
//      treats "nothing supplied to compare against" as a match.
//   2. no URL resolvable at all (neither this call's input nor a recoverable
//      cached.requestedLinkedinUrl anchor), or provider 'none' → not_found, return
//   3. write 'searching' + log start
//   4. call the resolved provider (registry.ts)
//   5. found/partial → facts-grounded extras pass, SCRAPINGDOG OUTCOMES ONLY
//      (tolerant of failure) — claude_web's own prompt already produces these
//      fields in one pass, so running extras there would double-spend the LLM
//      call and clobber its answers.
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
import { getCachedEnrichment, getEnrichmentState, saveEnrichedCandidate, setEnrichmentState } from './enrichment.repo';
import { resolveEnrichProvider, runProvider, statusFromConfidence, type EnrichProviderName } from './providers/registry';
import type { ProviderOutcome } from './providers/provider.types';
import { captureAvatar } from './avatar.service';
import { record as recordStageEvent, type StageEventStage, sanitizeErrorMessage } from './stage-events.repo';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
/** How fresh a persisted 'searching' state has to be to be trusted as "still
 *  actually running" rather than a crashed attempt that never reached a
 *  terminal state. See the module-level in-flight guard below for layer (i). */
const SEARCHING_LOCK_MS = 5 * 60 * 1000;

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

/** Maps a terminal outcome string to its stage-event name. Returns null for
 *  anything that isn't one of the four terminal outcomes (defensive only —
 *  every logTerminal call site today passes one of these four). */
function stageForOutcome(outcome: string): StageEventStage | null {
  switch (outcome) {
    case 'found':
      return 'enrich_found';
    case 'partial':
      return 'enrich_partial';
    case 'not_found':
      return 'enrich_not_found';
    case 'failed':
      return 'enrich_failed';
    default:
      return null;
  }
}

function logTerminal(userId: string, provider: EnrichProviderName, outcome: string, startedAtMs: number, extra?: Record<string, unknown>): void {
  // durationMs spans the WHOLE attempt — from startedAtMs (stamped at the top
  // of runEnrichmentOnce, before the cache check) through this terminal write —
  // so it includes the cache lookup, the provider call, and the extras pass
  // when one runs (scrapingdog found/partial), not just the provider call.
  const durationMs = Date.now() - startedAtMs;
  logger.info({ userId, provider, outcome, durationMs, ...extra }, 'enrichment terminal');

  // E1 stage-event telemetry (admin inspector): {provider, reason?} only —
  // cacheHit/crashed stay log-only flags, not part of the persisted detail.
  const stage = stageForOutcome(outcome);
  if (stage) {
    const reason = typeof extra?.reason === 'string' ? extra.reason : undefined;
    const detail: Record<string, unknown> = reason ? { provider, reason } : { provider };
    // Fire-and-forget — record() never throws, but the .catch() here is
    // belt-and-braces against a truly unexpected rejection, mirroring every
    // other fire-and-forget call site in this file.
    recordStageEvent(userId, stage, detail, durationMs).catch(() => {});
  }
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

// ─── Concurrency guard, layer (i): in-flight de-dupe ────────────────────────
// Two near-simultaneous calls for the same user (e.g. a double-click, or a
// client retry that races the original request) must not both pay for a
// provider + extras call. A second runEnrichment call for a userId already
// running joins the SAME promise instead of starting a second attempt.
// Process-local only — replace with a Redis lock (SET NX PX) the day this
// server runs multi-instance; a single Map can't coordinate across processes.
const inFlightByUser = new Map<string, Promise<void>>();

/**
 * Run one enrichment attempt for `userId`. Fire-and-forget-safe: writes every
 * state transition itself and NEVER throws, so callers only need `.catch()`
 * as a belt-and-braces guard against a truly unexpected rejection escaping
 * the try/catch below (there shouldn't be one).
 */
export function runEnrichment(userId: string, input: RunEnrichmentInput): Promise<void> {
  const existing = inFlightByUser.get(userId);
  if (existing) return existing;
  const run = runEnrichmentOnce(userId, input).finally(() => {
    inFlightByUser.delete(userId);
  });
  inFlightByUser.set(userId, run);
  return run;
}

async function runEnrichmentOnce(userId: string, input: RunEnrichmentInput): Promise<void> {
  const startedAtMs = Date.now();
  let provider: EnrichProviderName = 'none';
  try {
    provider = resolveEnrichProvider();

    // ─── Concurrency guard, layer (ii): persisted 'searching' lock ──────────
    // Crash-tolerant backstop for layer (i) above (which only protects a
    // single process/instance, and only for the lifetime of the in-memory
    // Map): if the DB already says 'searching' and that attempt started under
    // 5 minutes ago, assume it's still genuinely running and skip rather than
    // double-spend. Older than 5 minutes means that attempt crashed before
    // reaching a terminal state — safe (and necessary) to re-run.
    const existingState = await getEnrichmentState(userId).catch(() => null);
    if (existingState?.status === 'searching' && existingState.startedAt) {
      const ageMs = Date.now() - new Date(existingState.startedAt).getTime();
      if (ageMs < SEARCHING_LOCK_MS) {
        logger.info({ userId, ageMs }, 'enrichment: skipping — already searching');
        return;
      }
    }

    const linkedinUrl = normalizeLinkedinUrl(input.linkedinUrl);

    // Step 1: 90-day cache — evaluated BEFORE the no-URL branch below. Fixes
    // the bug where a fresh cached found/partial got downgraded to not_found
    // just because THIS call's body carried no linkedinUrl (e.g. an empty
    // POST — the client already read the cached state via the route's own
    // cache check and only fires this job to keep state in sync). Passing the
    // (possibly null) `linkedinUrl` straight to isFreshCacheHit is correct:
    // it already treats "no URL supplied this call" as "nothing new to
    // compare against", so a fresh cache still counts as a hit.
    const cached = await getCachedEnrichment(userId).catch(() => null);
    if (isFreshCacheHit(cached, linkedinUrl)) {
      const status = statusFromConfidence(cached!.confidence);
      await writeState(userId, { status });
      logTerminal(userId, provider, status, startedAtMs, { cacheHit: true });
      return;
    }

    // The cache wasn't a fresh hit (none, stale, confidence 0, or genuinely a
    // different URL). When THIS call carries no URL of its own, the cache's
    // own requested URL is a recoverable identity anchor — re-enrich against
    // it rather than forcing not_found purely because this particular call
    // happened to arrive with an empty body. Only when there is truly no URL
    // anywhere (this call AND no cached anchor) do we give up.
    const resolvedLinkedinUrl = linkedinUrl || cached?.requestedLinkedinUrl || null;

    // Step 2: no URL resolvable at all, or enrichment deliberately killed.
    if (!resolvedLinkedinUrl) {
      await writeState(userId, { status: 'not_found', error: 'no linkedin url', source: null });
      logTerminal(userId, provider, 'not_found', startedAtMs, { reason: 'no linkedin url' });
      return;
    }
    if (provider === 'none') {
      await writeState(userId, { status: 'not_found', error: null, source: null });
      logTerminal(userId, provider, 'not_found', startedAtMs);
      return;
    }

    // Step 3: searching.
    await writeState(userId, { status: 'searching', source: provider });
    logger.info({ userId, slug: linkedinSlug(resolvedLinkedinUrl), provider }, 'enrichment searching');
    recordStageEvent(userId, 'enrich_started', { provider }).catch(() => {});

    // Step 4: call the provider.
    const outcome = await runProvider(provider as Exclude<EnrichProviderName, 'none'>, {
      linkedinUrl: resolvedLinkedinUrl,
      fullName: input.fullName,
    });

    // Steps 5-6: found/partial.
    if (outcome.kind === 'found' || outcome.kind === 'partial') {
      let result = applyMatchVerification(outcome.result, resolvedLinkedinUrl);
      // Extras is a second, facts-grounded LLM call — scrapingdog outcomes
      // only. claude_web's own prompt already asks for these same four hint
      // fields in its single pass; running extras on top would double-spend
      // the LLM call and overwrite what that prompt already produced.
      if (provider === 'scrapingdog') {
        result = await withExtras(result, userId);
      }
      await saveEnrichedCandidate(userId, result).catch((err) =>
        logger.warn({ err, userId }, 'enrichment: saveEnrichedCandidate failed (non-fatal)'),
      );
      await writeState(userId, { status: outcome.kind, source: provider });
      // A7: LinkedIn photo capture — fire-and-forget, deliberately NOT
      // awaited. A photo failure must never affect (or delay) the
      // enrichment outcome above, which has already been written. The
      // .catch() here is a defensive backstop only — captureAvatar itself
      // never throws (it returns false + logs on every failure path) — so
      // this guards against a truly unexpected rejection escaping it,
      // mirroring runEnrichment's own top-level never-throws guarantee.
      // E1: photo_captured/photo_failed recorded from THIS call site (not
      // inside avatar.service.ts, which stays photo-only) — duration_ms
      // spans just the capture itself, not the enrichment attempt above.
      if (outcome.photoUrl) {
        const photoStartedAtMs = Date.now();
        captureAvatar(userId, outcome.photoUrl)
          .then((captured) => {
            const stage = captured ? 'photo_captured' : 'photo_failed';
            recordStageEvent(userId, stage, {}, Date.now() - photoStartedAtMs).catch(() => {});
          })
          .catch((err) => {
            logger.warn({ err, userId }, 'enrichment: captureAvatar rejected unexpectedly (non-fatal)');
            const reason = sanitizeErrorMessage(err instanceof Error ? err.message : 'unknown avatar capture error');
            recordStageEvent(userId, 'photo_failed', { reason }, Date.now() - photoStartedAtMs).catch(() => {});
          });
      }
      logTerminal(userId, provider, outcome.kind, startedAtMs);
      return;
    }

    // Step 7: not_found / retry_exhausted / provider_error.
    const { status, error } = mapFailureOutcome(outcome);
    await writeState(userId, { status, error, source: provider });
    logTerminal(userId, provider, status, startedAtMs, error ? { reason: sanitizeErrorMessage(error) } : undefined);
  } catch (err) {
    // Never throws: any unexpected failure still lands in a terminal, visible
    // state rather than disappearing into an unhandled rejection.
    logger.error({ err, userId, provider }, 'enrichment orchestrator crashed — marking failed');
    const crashReason = sanitizeErrorMessage(err instanceof Error ? err.message : 'unknown orchestrator error');
    await writeState(userId, {
      status: 'failed',
      error: crashReason,
      source: provider === 'none' ? null : provider,
    });
    logTerminal(userId, provider, 'failed', startedAtMs, { crashed: true, reason: crashReason });
  }
}
