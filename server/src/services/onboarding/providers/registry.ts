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
import { enrichProfile, applyMatchVerification, getClient, type EnrichResult, type EnrichedProfile } from '../enrichment.service';
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
    const outcome = await scrapingdogProvider.enrich({ linkedinUrl: input.linkedinUrl, fullName: input.fullName });
    return outcome.kind === 'partial' ? fillGapsFromWeb(outcome, input) : outcome;
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

// ─── Gap fill (3 Sep 2026) ───────────────────────────────────────────────────
// ScrapingDog's LinkedIn payload arrives with an EMPTY headline and empty
// positions for every profile we have tried (the July fixture, Ali, Ahmed),
// so every member reached the confirm card with Role "Not set" even though
// LinkedIn shows one. The Claude web-search provider reads the public page and
// returns the stated headline and role (Ali: 0.92, verified against the exact
// URL) while honestly returning nothing for a profile it cannot identify
// (Ahmed: 0). So when scrapingdog is partial on headline or role, ask the web
// provider to fill ONLY the fields that are empty, and only when it verified
// the same profile. A scraped fact is never overwritten by a searched one.
//
// It lives HERE, not in the onboarding orchestrator, because the approval-time
// preload (join-request.service) calls runProvider directly and caches what
// comes back for 90 days; a fill that only ran at onboarding left every
// approved-then-logged-in member with a role-less card.
const GAP_FILL_MIN_CONFIDENCE = 0.6;
const GAP_FIELDS = ['headline', 'currentRole', 'currentCompany', 'industry', 'location'] as const;
const REQUIRED_FOR_FOUND = ['headline', 'currentRole', 'currentCompany'] as const;

/**
 * 4 Sep 2026 (Ali's own test): the About we DID fetch said "a passionate
 * MLOps & Geospatial Engineer" while the card showed Role "Not set", because
 * the web step could not identify that thin profile. When the person's own
 * headline or About states their role, that is stated, not guessed: one
 * no-search call reads only the text we already hold and returns the role or
 * null. Never invents; a slogan, a company name or a list of interests → null.
 */
async function roleFromOwnWords(profile: EnrichedProfile): Promise<string | null> {
  const text = [profile.headline, profile.summary].filter(Boolean).join('\n').trim();
  if (!text) return null;
  const resp = await getClient().messages.create({
    model: config.onboardingChatModel,
    max_tokens: 120,
    messages: [{
      role: 'user',
      content:
        'Below is a person\'s own LinkedIn headline and About text. If the text STATES the person\'s current role or job title in their own words (for example "I\'m a passionate MLOps & Geospatial Engineer" → "MLOps & Geospatial Engineer"; "Founder of Rise" → "Founder"; "Fractional CMO for scale-ups" → "Fractional CMO"), return it, shortest form that is still their title. If it only names a company, an industry, interests, skills, a slogan or what they like doing, return null. Never infer a title from what they seem to do. Reply with ONLY JSON: {"currentRole": string | null}\n\n' +
        text.slice(0, 1500),
    }],
  });
  const raw = resp.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const j = JSON.parse(m[0]) as { currentRole?: unknown };
  const role = typeof j.currentRole === 'string' ? j.currentRole.trim() : '';
  return role && role.length <= 120 ? role : null;
}

async function fillGapsFromWeb(
  outcome: Extract<ProviderOutcome, { kind: 'partial' }>,
  input: RunProviderInput,
): Promise<ProviderOutcome> {
  const scraped = outcome.result.profile;
  if (!scraped || (scraped.headline && scraped.currentRole)) return outcome;

  const merged: EnrichedProfile = { ...scraped };
  const filled: string[] = [];
  let sources = [...outcome.result.sources];

  // Step 1: the public page, only when the web can verify it is the same person.
  try {
    const web = applyMatchVerification(
      await enrichProfile({ fullName: input.fullName || scraped.fullName || '', linkedinUrl: input.linkedinUrl }),
      input.linkedinUrl,
    );
    if (web.profile && web.confidence >= GAP_FILL_MIN_CONFIDENCE) {
      for (const k of GAP_FIELDS) {
        if (!merged[k] && web.profile[k]) { merged[k] = web.profile[k]; filled.push(k); }
      }
      if (!merged.skills.length && web.profile.skills.length) { merged.skills = web.profile.skills; filled.push('skills'); }
      // ScrapingDog truncates About with an ellipsis; a longer searched summary is the fuller text.
      if (web.profile.summary && (!merged.summary || (merged.summary.endsWith('…') && web.profile.summary.length > merged.summary.length))) {
        merged.summary = web.profile.summary; filled.push('summary');
      }
      sources = [...sources, ...web.sources.filter((s) => !sources.includes(s))];
    }
  } catch (err) {
    logger.warn({ err, linkedinUrl: input.linkedinUrl }, 'enrichment gap fill (web) failed — continuing with what we hold');
  }

  // Step 2: the person's own words, when the role is still missing.
  if (!merged.currentRole) {
    try {
      const own = await roleFromOwnWords(merged);
      if (own) { merged.currentRole = own; filled.push('currentRole (own words)'); }
    } catch (err) {
      logger.warn({ err, linkedinUrl: input.linkedinUrl }, 'enrichment gap fill (own words) failed — leaving the role empty');
    }
  }

  if (!filled.length) return outcome;

  const missing = REQUIRED_FOR_FOUND.filter((k) => !merged[k]);
  logger.info({ linkedinUrl: input.linkedinUrl, filled, missing }, 'enrichment: gap fill added what scrapingdog left empty');
  if (missing.length === 0) {
    return { kind: 'found', result: { ...outcome.result, profile: merged, sources, confidence: 0.95 }, photoUrl: outcome.photoUrl };
  }
  return { ...outcome, result: { ...outcome.result, profile: merged, sources }, missing };
}

/** Extract the EnrichResult out of a ProviderOutcome, or null when the
 *  outcome carries no result (not_found/retry_exhausted/provider_error). */
export function resultFromOutcome(outcome: ProviderOutcome): EnrichResult | null {
  return outcome.kind === 'found' || outcome.kind === 'partial' ? outcome.result : null;
}
