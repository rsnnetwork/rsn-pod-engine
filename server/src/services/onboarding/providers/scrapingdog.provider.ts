// ─── ScrapingDog LinkedIn Provider ───────────────────────────────────────────
//
// Deterministic replacement for the Claude web-search guess: fetch the EXACT
// profile slug the member gave us via ScrapingDog's LinkedIn API. No identity
// ambiguity (unlike web search, which can return a namesake) — the slug IS
// the identity.
//
// Field-name mapping is confirmed against a real captured response (Ali
// Hamza's own public profile, fetched live 2026-07-24 — see
// server/src/__tests__/fixtures/scrapingdog-profile.json): fullName,
// first_name, last_name, headline, location, about, experience[].position/
// company_name/duration, education, profile_photo, etc. Some fields (headline,
// experience[0].position, location) can arrive as empty strings rather than
// null/absent on a real profile — the fallback chains below tolerate that.
//
// Security: the api_key never appears in anything this module returns,
// throws, or logs — only status codes and (sanitized) error messages.

import config from '../../../config';
import { linkedinSlug, normalizeLinkedinUrl, type EnrichResult, type EnrichedProfile } from '../enrichment.service';
import type { EnrichmentProvider } from './provider.types';

const BASE = 'https://api.scrapingdog.com/linkedin/';
const RETRY_DELAY_MS = 20_000;
const MAX_ATTEMPTS = 6;
const FETCH_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip the API key out of any string before it can leak into a returned reason. */
function redact(msg: string): string {
  const key = config.scrapingdogApiKey;
  return key ? msg.split(key).join('[redacted]') : msg;
}

async function fetchOnce(slug: string): Promise<{ status: number; body?: any }> {
  // premium=true is the working parameter — private=true returns a hard 400
  // ("Try again or use premium=true") per the live A2 discovery call. Bare
  // no-flag also worked, but ScrapingDog's own error text recommends premium.
  const url = `${BASE}?api_key=${config.scrapingdogApiKey}&type=profile&linkId=${encodeURIComponent(slug)}&premium=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  // Parse the body regardless of status: ScrapingDog reports request/plan
  // problems (bad param, quota exhaustion) as a JSON `{success:false}` body,
  // which can arrive under a 200 OR a 400 — see the success:false check below.
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

/** Render one past-experience entry into the flat string RSN's existing pastRoles: string[] shape expects. */
function formatPastRole(e: any): string {
  const role = e.position ?? e.title ?? null;
  const company = e.company_name ?? e.company ?? null;
  const duration = e.duration ?? null;
  return [role, company ? `at ${company}` : null, duration ? `(${duration})` : null].filter(Boolean).join(' ');
}

/**
 * Map a raw 200 body to a profile. Returns `null` when the body carries no
 * usable profile signal at all (null body, `[]`, `{}`, or any shape with no
 * name candidate, no headline, and no experience) — ScrapingDog's own
 * convention for "no such profile" under a 200 status. Never throws: an
 * `experience` that isn't an array, or that contains null entries, is
 * tolerated and mapped as best-effort rather than crashing.
 */
function mapProfile(raw: any, requestedUrl: string): { profile: EnrichedProfile; missing: string[] } | null {
  const p = Array.isArray(raw) ? raw[0] : raw;
  if (!p || typeof p !== 'object') return null;

  const exp: any[] = Array.isArray(p.experience) ? p.experience : [];
  const current = exp[0] ?? {};
  const fullName = p.fullName ?? [p.first_name, p.last_name].filter(Boolean).join(' ') ?? null;
  const headline = p.headline ?? null;

  const hasSignal = !!fullName || !!headline || exp.some((e: any) => e != null);
  if (!hasSignal) return null;

  const profile: EnrichedProfile = {
    fullName,
    headline,
    currentRole: current.position ?? current.title ?? null,
    currentCompany: current.company_name ?? current.company ?? null,
    industry: p.industry ?? null,
    location: p.location ?? null,
    summary: p.about ?? null,
    pastRoles: exp
      .slice(1)
      .filter((e: any) => e != null)
      .map(formatPastRole)
      .filter((s: string) => s.length > 0),
    education: p.education ?? [],
    skills: p.skills ?? [],
    photoUrl: p.profile_photo ?? p.profile_pic_url ?? null,
    likelyWantsToMeet: [],
    likelyOffers: [],
    conversationStarters: [],
    questionsToVerify: [],
    linkedinUrl: requestedUrl,
  };
  const missing = (['headline', 'currentRole', 'currentCompany'] as const).filter((k) => !profile[k]);
  return { profile, missing };
}

export const scrapingdogProvider: EnrichmentProvider = {
  name: 'scrapingdog',
  async enrich({ linkedinUrl }) {
    const slug = linkedinSlug(linkedinUrl);
    if (!slug) return { kind: 'not_found', reason: 'no /in/ slug in submitted URL' };
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const { status, body } = await fetchOnce(slug);

        // A body-level `success:false` is ScrapingDog's own signal for a
        // request/plan-level problem (bad param, quota exhausted) — never
        // "this profile doesn't exist". Checked regardless of HTTP status
        // (it has arrived under both 200 and 400 in live testing); only a
        // plain 404/410 with NO such body falls through to not_found below.
        if (body && !Array.isArray(body) && typeof body === 'object' && body.success === false) {
          const message = typeof body.message === 'string' ? body.message : 'scrapingdog error';
          return { kind: 'provider_error', reason: redact(message) };
        }

        if (status === 200) {
          const mapped = mapProfile(body, normalizeLinkedinUrl(linkedinUrl)!);
          if (!mapped) return { kind: 'not_found', reason: 'empty profile body' };
          const { profile, missing } = mapped;
          const result: EnrichResult = {
            profile,
            confidence: missing.length === 0 ? 0.95 : 0.7,
            sources: [`scrapingdog:${slug}`],
            foundLinkedinUrl: normalizeLinkedinUrl(linkedinUrl),
            requestedLinkedinUrl: normalizeLinkedinUrl(linkedinUrl),
            enrichedAt: new Date().toISOString(),
          };
          return missing.length === 0
            ? { kind: 'found', result, photoUrl: profile.photoUrl }
            : { kind: 'partial', result, photoUrl: profile.photoUrl, missing };
        }
        if (status === 202) {
          if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
          continue;
        }
        // Pure 404/410 (no success:false body) is the only case that still
        // means "this profile is genuinely unretrievable". Any other status —
        // including a plain 400, which now signals a request/plan problem
        // rather than "profile unavailable" now that premium is always sent —
        // is a provider-side problem, not a not_found.
        if ([404, 410].includes(status)) return { kind: 'not_found', reason: `scrapingdog ${status}` };
        return { kind: 'provider_error', reason: `scrapingdog ${status}` };
      }
      return { kind: 'retry_exhausted' };
    } catch (err) {
      return { kind: 'provider_error', reason: err instanceof Error ? redact(err.message) : 'unknown' };
    }
  },
};
