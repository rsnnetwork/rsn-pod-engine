// ─── ScrapingDog LinkedIn Provider ───────────────────────────────────────────
//
// Deterministic replacement for the Claude web-search guess: fetch the EXACT
// profile slug the member gave us via ScrapingDog's LinkedIn API. No identity
// ambiguity (unlike web search, which can return a namesake) — the slug IS
// the identity.
//
// Field-name mapping is confirmed against real captured responses (Ali
// Hamza's own public profile, fetched live 2026-07-24 — see
// server/src/__tests__/fixtures/scrapingdog-profile.json — and Shradha's on
// 2026-09-14): fullName, first_name, last_name, headline, location, about,
// experience[].position/company_name/duration, education, certification,
// volunteering, publications, languages, projects, awards, courses,
// organizations, followers, profile_photo. Some fields (headline,
// experience[0].position, location) can arrive as empty strings rather than
// null/absent on a real profile — the fallback chains below tolerate that.
//
// 14 Sep 2026 (Shradha, Ali: "get all info which is available on the LinkedIn
// page and the recent one"). Two things learned on her profile:
//   1. ScrapingDog answers a slug it has scraped before from ITS OWN cache,
//      in about a second, however old: her copy still said RSN when her page
//      said Vokt. LinkedIn slugs are case-insensitive and ScrapingDog keys its
//      cache on the exact linkId string, so a slug with its letter casing
//      changed misses that cache and forces a live scrape (14 seconds, Vokt).
//      Every enrichment now asks for a live scrape first; the cached copy is
//      only read to fill gaps the live page left, never the other way round.
//   2. The page carries far more than headline and experience: certifications,
//      volunteering, publications, languages, projects, awards, courses,
//      organizations, followers. All of it is mapped now, and summarised into
//      `highlights` for the host and the extraction step.
//
// Security: the api_key never appears in anything this module returns,
// throws, or logs — only status codes and (sanitized) error messages.

import config from '../../../config';
import { linkedinSlug, normalizeLinkedinUrl, type EnrichResult, type EnrichedProfile } from '../enrichment.service';
import type { EnrichmentProvider, ProviderOutcome } from './provider.types';

const BASE = 'https://api.scrapingdog.com/linkedin/';
const RETRY_DELAY_MS = 20_000;
const MAX_ATTEMPTS = 6;
// 3 Sep 2026: the Lite plan allows 2 concurrent LinkedIn scrapes. A third
// member onboarding at the same moment got `{success:false, message:"Too many
// requests, please wait."}` and was marked FAILED on the spot, as if the plan
// were exhausted. A rate limit is a "wait", not a "no": back off and retry
// within the same attempt budget. Grows per attempt so a burst drains rather
// than hammers.
const RATE_LIMIT_DELAY_MS = 5_000;
// 4 Sep 2026: "Something went wrong. Try again or use premium=true." arrived
// mid-sweep for a profile that scraped fine minutes later. ScrapingDog says
// "try again"; take it at its word and retry that too.
const RATE_LIMITED = /too many requests|rate limit|try again|something went wrong/i;
// 23 Jul 2026 live test: a valid, never-before-scraped profile (ali-hamza-b0650a281)
// failed end to end with "The operation was aborted due to timeout" at both the
// approval-time preload and the user-side run. ScrapingDog answers a cached
// profile in seconds, but a genuinely cold scrape can take 60-90s — the prior
// 30s abort fired right before the real answer arrived. 100s gives a cold
// scrape comfortable headroom without materially changing the worst-case
// total wait (see the provider's own MAX_ATTEMPTS/RETRY_DELAY_MS 202-loop,
// unchanged here).
const FETCH_TIMEOUT_MS = 100_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip the API key out of any string before it can leak into a returned reason. */
function redact(msg: string): string {
  const key = config.scrapingdogApiKey;
  return key ? msg.split(key).join('[redacted]') : msg;
}

/**
 * The slug with its letter casing scrambled, so ScrapingDog's cache (keyed on
 * the exact linkId) is missed and LinkedIn is read live. Slugs are
 * case-insensitive on LinkedIn. Always differs from the canonical lowercase
 * form when the slug has any letter at all; a seed makes it reproducible in
 * tests, and a fresh seed per request means no two requests share a key.
 */
export function freshSlug(slug: string, seed: number = Date.now()): string {
  const letters = [...slug].filter((c) => /[a-z]/i.test(c)).length;
  if (!letters) return slug;
  let bits = Math.abs(Math.floor(seed)) || 1;
  let flipped = 0;
  const out = [...slug].map((c) => {
    if (!/[a-z]/i.test(c)) return c;
    const flip = (bits & 1) === 1;
    bits = Math.floor(bits / 2) || (flipped ? 0 : 1);
    if (flip) { flipped += 1; return c.toUpperCase(); }
    return c.toLowerCase();
  });
  if (!flipped) {
    const i = out.findIndex((c) => /[a-z]/i.test(c));
    out[i] = out[i].toUpperCase();
  }
  return out.join('');
}

async function fetchOnce(linkId: string): Promise<{ status: number; body?: any }> {
  // premium=true is the working parameter — private=true returns a hard 400
  // ("Try again or use premium=true") per the live A2 discovery call. Bare
  // no-flag also worked, but ScrapingDog's own error text recommends premium.
  const url = `${BASE}?api_key=${config.scrapingdogApiKey}&type=profile&linkId=${encodeURIComponent(linkId)}&premium=true`;
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

// ─── Mapping ─────────────────────────────────────────────────────────────────

// LinkedIn's guest view hides entries it will not show as runs of asterisks
// ("******* *******") and leaves every position blank. A masked entry is not a
// past role and never the current company; an entry with neither a title nor
// a company says nothing at all.
const MASKED = /^[\s*•·]+$/;
const isMasked = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0 && MASKED.test(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() && !isMasked(v) ? v.trim() : null);
const list = (v: unknown): any[] => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const dedupe = (xs: Array<string | null>): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!x) continue;
    const k = x.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
};

function usableExperience(e: any): boolean {
  if (e == null || typeof e !== 'object') return false;
  const role = text(e.position ?? e.title);
  const company = text(e.company_name ?? e.company);
  if (isMasked(e.position ?? e.title) || isMasked(e.company_name ?? e.company)) return false;
  return !!(role || company);
}

/** Render one past-experience entry into the flat string RSN's existing pastRoles: string[] shape expects. */
function formatPastRole(e: any): string {
  const role = text(e.position ?? e.title);
  const company = text(e.company_name ?? e.company);
  const duration = text(e.duration);
  return [role, company ? `at ${company}` : null, duration ? `(${duration})` : null].filter(Boolean).join(' ');
}

/** "Python for Data Science (IBM, Jul 2025)" */
function formatCertification(c: any): string | null {
  const name = text(c.certification ?? c.name ?? c.title);
  if (!name) return null;
  const issuer = text(c.company_name ?? c.issuer ?? c.authority);
  const when = text(c.issue_date)?.replace(/^issued\s+/i, '') ?? null;
  const tail = [issuer, when].filter(Boolean).join(', ');
  return tail ? `${name} (${tail})` : name;
}

/** "Researcher at Robin Hood Army" */
function formatVolunteering(v: any): string | null {
  const role = text(v.company_position ?? v.position ?? v.title ?? v.role);
  const org = text(v.company_name ?? v.organization ?? v.company);
  if (!role && !org) return null;
  return [role, org ? `at ${org}` : null].filter(Boolean).join(' ');
}

/** First non-empty name-like field of a generic section entry. */
function nameOf(x: any, ...keys: string[]): string | null {
  if (x == null) return null;
  if (typeof x === 'string') return text(x);
  for (const k of keys) {
    const v = text(x[k]);
    if (v) return v;
  }
  return null;
}

/** "BSc, Copenhagen Business School (2020 to 2022)"; a masked college is skipped. */
function formatEducation(e: any): string | null {
  const school = text(e.college_name ?? e.school ?? e.name);
  const degree = text(e.college_degree ?? e.degree);
  const field = text(e.college_degree_field ?? e.field_of_study ?? e.field);
  if (!school && !degree && !field) return null;
  const from = text(e.starts_at);
  const to = text(e.ends_at);
  const years = from || to ? `(${[from, to].filter(Boolean).join(' to ')})` : null;
  return [[degree, field].filter(Boolean).join(' in ') || null, school, years].filter(Boolean).join(', ').replace(', (', ' (');
}

/**
 * Map a raw 200 body to a profile. Returns `null` when the body carries no
 * usable profile signal at all (null body, `[]`, `{}`, or any shape with no
 * name candidate, no headline, and no experience) — ScrapingDog's own
 * convention for "no such profile" under a 200 status. Never throws: an
 * `experience` that isn't an array, or that contains null entries, is
 * tolerated and mapped as best-effort rather than crashing.
 */
export function mapProfile(raw: any, requestedUrl: string): { profile: EnrichedProfile; missing: string[] } | null {
  const p = Array.isArray(raw) ? raw[0] : raw;
  if (!p || typeof p !== 'object') return null;

  const rawExp: any[] = list(p.experience);
  const exp: any[] = rawExp.filter(usableExperience);
  const current = exp[0] ?? {};
  const fullName = text(p.fullName) ?? text([p.first_name, p.last_name].filter(Boolean).join(' '));
  const headline = text(p.headline);

  const hasSignal = !!fullName || !!headline || rawExp.length > 0;
  if (!hasSignal) return null;

  const certifications = dedupe(list(p.certification ?? p.certifications).map(formatCertification));
  const volunteering = dedupe(list(p.volunteering ?? p.volunteer).map(formatVolunteering));
  const languages = dedupe(list(p.languages).map((l: any) => nameOf(l, 'name', 'language')));
  const publications = dedupe(list(p.publications).map((x: any) => nameOf(x, 'name', 'title')));
  const projects = dedupe(list(p.projects).map((x: any) => nameOf(x, 'name', 'title', 'project')));
  const awards = dedupe(list(p.awards ?? p.honors).map((x: any) => nameOf(x, 'name', 'title', 'award')));
  const courses = dedupe(list(p.courses).map((x: any) => nameOf(x, 'name', 'title', 'course')));
  const organizations = dedupe(list(p.organizations).map((x: any) => nameOf(x, 'name', 'title', 'organization')));
  const educationText = dedupe(list(p.education).map(formatEducation));
  const followers = text(p.followers);
  const skills = dedupe(list(p.skills).map((s: any) => nameOf(s, 'name', 'skill', 'title')));

  // Everything else the page says, as lines a host can read out or an
  // extractor can lean on. Never a guess: each line is a fact from the page.
  const highlights: string[] = [];
  if (certifications.length) highlights.push(`Certified: ${certifications.slice(0, 6).join('; ')}`);
  if (volunteering.length) highlights.push(`Volunteers as ${volunteering.slice(0, 3).join('; ')}`);
  if (publications.length) highlights.push(`Published: ${publications.slice(0, 3).join('; ')}`);
  if (projects.length) highlights.push(`Projects: ${projects.slice(0, 4).join('; ')}`);
  if (awards.length) highlights.push(`Awards: ${awards.slice(0, 4).join('; ')}`);
  if (organizations.length) highlights.push(`Member of ${organizations.slice(0, 4).join('; ')}`);
  if (educationText.length) highlights.push(`Education: ${educationText.slice(0, 3).join('; ')}`);
  if (languages.length) highlights.push(`Speaks ${languages.join(', ')}`);
  if (followers) highlights.push(`${followers} on LinkedIn`);

  const profile: EnrichedProfile = {
    fullName,
    headline,
    currentRole: text(current.position ?? current.title),
    currentCompany: text(current.company_name ?? current.company),
    industry: text(p.industry),
    location: text(p.location),
    summary: text(p.about),
    pastRoles: exp
      .slice(1)
      .map(formatPastRole)
      .filter((s: string) => s.length > 0),
    education: list(p.education),
    skills,
    photoUrl: text(p.profile_photo) ?? text(p.profile_pic_url),
    likelyWantsToMeet: [],
    likelyOffers: [],
    conversationStarters: [],
    questionsToVerify: [],
    linkedinUrl: requestedUrl,
    certifications,
    volunteering,
    languages,
    publications,
    projects,
    awards,
    courses,
    organizations,
    educationText,
    followers,
    highlights,
  };
  const missing = (['headline', 'currentRole', 'currentCompany'] as const).filter((k) => !profile[k]);
  return { profile, missing };
}

/**
 * The live page first; the cached copy fills only what the live page left
 * empty. The current company, About and photo are the live page's, always:
 * that is the "recent" the member sees on LinkedIn. Past roles and list
 * sections are unioned, live first.
 */
export function mergeLiveWithCached(live: EnrichedProfile, cached: EnrichedProfile | null): EnrichedProfile {
  if (!cached) return live;
  const fill = <K extends keyof EnrichedProfile>(k: K): EnrichedProfile[K] =>
    (live[k] == null || live[k] === '' ? cached[k] : live[k]) as EnrichedProfile[K];
  const union = (a?: string[], b?: string[]): string[] => dedupe([...(a ?? []), ...(b ?? [])]);
  return {
    ...live,
    fullName: fill('fullName'),
    headline: fill('headline'),
    currentRole: fill('currentRole'),
    industry: fill('industry'),
    location: fill('location'),
    summary: fill('summary'),
    photoUrl: fill('photoUrl'),
    pastRoles: union(live.pastRoles, [
      // A cached "current" company that the live page no longer lists first is a past role now.
      ...(cached.currentCompany && cached.currentCompany !== live.currentCompany ? [`at ${cached.currentCompany}`] : []),
      ...(cached.pastRoles ?? []),
    ].filter((r) => !r.endsWith(`at ${live.currentCompany ?? ''}`) || !live.currentCompany)),
    education: live.education?.length ? live.education : cached.education,
    skills: union(live.skills, cached.skills),
    certifications: union(live.certifications, cached.certifications),
    volunteering: union(live.volunteering, cached.volunteering),
    languages: union(live.languages, cached.languages),
    publications: union(live.publications, cached.publications),
    projects: union(live.projects, cached.projects),
    awards: union(live.awards, cached.awards),
    courses: union(live.courses, cached.courses),
    organizations: union(live.organizations, cached.organizations),
    educationText: union(live.educationText, cached.educationText),
    highlights: union(live.highlights, cached.highlights),
  };
}

/** A page that gave neither a headline nor a role nor an About is thin: the cached copy may hold more. */
export function isThin(p: EnrichedProfile): boolean {
  return !p.headline && !p.currentRole && !p.summary;
}

type Scrape =
  | { kind: 'ok'; body: any }
  | Extract<ProviderOutcome, { kind: 'not_found' | 'retry_exhausted' | 'provider_error' }>;

/** One attempt loop for one linkId: 202 → wait, rate limit → back off, plan error → provider_error. */
async function scrape(linkId: string): Promise<Scrape> {
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { status, body } = await fetchOnce(linkId);

      // A body-level `success:false` is ScrapingDog's own signal for a
      // request/plan-level problem (bad param, quota exhausted) — never
      // "this profile doesn't exist". Checked regardless of HTTP status
      // (it has arrived under both 200 and 400 in live testing); only a
      // plain 404/410 with NO such body falls through to not_found below.
      if (body && !Array.isArray(body) && typeof body === 'object' && body.success === false) {
        const message = typeof body.message === 'string' ? body.message : 'scrapingdog error';
        if (status === 429 || RATE_LIMITED.test(message)) {
          if (attempt < MAX_ATTEMPTS) { await sleep(RATE_LIMIT_DELAY_MS * attempt); continue; }
          return { kind: 'retry_exhausted' };
        }
        return { kind: 'provider_error', reason: redact(message) };
      }
      if (status === 429) {
        if (attempt < MAX_ATTEMPTS) { await sleep(RATE_LIMIT_DELAY_MS * attempt); continue; }
        return { kind: 'retry_exhausted' };
      }
      if (status === 200) return { kind: 'ok', body };
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
}

export const scrapingdogProvider: EnrichmentProvider = {
  name: 'scrapingdog',
  async enrich({ linkedinUrl }) {
    const slug = linkedinSlug(linkedinUrl);
    if (!slug) return { kind: 'not_found', reason: 'no /in/ slug in submitted URL' };
    const requestedUrl = normalizeLinkedinUrl(linkedinUrl)!;

    // 1. The live page, through a linkId ScrapingDog has never cached.
    const live = await scrape(freshSlug(slug));
    let liveMapped = live.kind === 'ok' ? mapProfile(live.body, requestedUrl) : null;
    const sources: string[] = [];
    if (liveMapped) sources.push(`scrapingdog:${slug}:live`);

    // 2. The cached copy: the only answer when the live scrape failed, and a
    //    gap-filler when the live page came back thin (guest-view masking).
    //    Not after a rate limit that never cleared: the cached call would be
    //    rate-limited too, and the attempt budget has already been spent.
    let cachedMapped: { profile: EnrichedProfile; missing: string[] } | null = null;
    const liveFailedHard = live.kind === 'retry_exhausted';
    if ((!liveMapped || isThin(liveMapped.profile)) && !liveFailedHard) {
      const cached = await scrape(slug);
      if (cached.kind === 'ok') {
        cachedMapped = mapProfile(cached.body, requestedUrl);
        if (cachedMapped) sources.push(`scrapingdog:${slug}`);
      }
    }
    if (!liveMapped && !cachedMapped) {
      // Neither answered with a profile: the live attempt's verdict stands
      // (an empty body is "no such profile"; a failure is reported as it was).
      return live.kind === 'ok' ? { kind: 'not_found', reason: 'empty profile body' } : live;
    }

    const profile = liveMapped
      ? mergeLiveWithCached(liveMapped.profile, cachedMapped?.profile ?? null)
      : cachedMapped!.profile;
    const missing = (['headline', 'currentRole', 'currentCompany'] as const).filter((k) => !profile[k]);
    const result: EnrichResult = {
      profile,
      confidence: missing.length === 0 ? 0.95 : 0.7,
      sources,
      foundLinkedinUrl: requestedUrl,
      requestedLinkedinUrl: requestedUrl,
      enrichedAt: new Date().toISOString(),
    };
    return missing.length === 0
      ? { kind: 'found', result, photoUrl: profile.photoUrl }
      : { kind: 'partial', result, photoUrl: profile.photoUrl, missing };
  },
};
