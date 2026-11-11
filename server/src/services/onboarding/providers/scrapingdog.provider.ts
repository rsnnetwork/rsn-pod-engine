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
// 12 Nov 2026: nothing was found for anyone since 6 Nov. ScrapingDog now
// answers a page it holds no copy of, after about 50 seconds, with HTTP 400
// `{success:false, message:"The copy of this profile will be scraped and
// stored in our db, please try again after 2-3 minutes."}` (seen live on
// 11 Nov, twice for the same id 3 minutes apart). Three things went wrong:
//   1. "try again" in that message read as a rate limit, the 5 s backoff no
//      longer fit the budget, and the cached copy was skipped as if the plan
//      were limited: every lookup ended "retry exhausted" after 50.2 s.
//   2. The live id got a fresh random casing on every call, so the copy
//      ScrapingDog stored for one call was never asked for again. The casing
//      now changes once per 90-day window (the refresh period), so the
//      approval-time lookup, the member's own run and a later retry all ask
//      for the same id and pick up the copy the first one caused.
//   3. Nothing logged the answer. Every answer that is not a profile is
//      logged now (status, attempt, elapsed; never the key or the slug).
// The endpoint is the documented one (`/profile?type=profile&id=`, docs read
// 12 Nov 2026); the old `/linkedin/?linkId=` is no longer in the docs.
// What the fixed id costs: within a window every lookup, an admin's
// refresh-enrichment and a member who has since edited their LinkedIn page
// included, reads the copy ScrapingDog stored at the window's first request.
// ScrapingDog documents no parameter to ask for a fresh copy (only api_key,
// type, id, premium, webhook), and a never-seen id only answers "not stored
// yet" after ~50 s, so a fresh read cannot be had in one call; the next window
// (at most 90 days, our own refresh period) reads the page anew.
//
// Security: the api_key never appears in anything this module returns,
// throws, or logs — only status codes and (sanitized) error messages.

import config from '../../../config';
import logger from '../../../config/logger';
import { linkedinSlug, normalizeLinkedinUrl, type EnrichResult, type EnrichedProfile } from '../enrichment.service';
import type { EnrichmentProvider, ProviderOutcome } from './provider.types';

const BASE = 'https://api.scrapingdog.com/profile';
// A 202 is "accepted, still scraping" (docs, LinkedIn API only, not billed):
// the same request is sent again. 15 s apart, inside each budget below.
const RETRY_DELAY_MS = 15_000;
const MAX_ATTEMPTS = 6;
// ScrapingDog's "no copy yet, it is being fetched, ask again in 2-3 minutes".
// Asking again inside the same call cannot help; a later attempt can.
const NOT_READY = /scraped and stored|try again after \d/i;
// The refresh period: one live id per window (see note 2 above).
const LOOKUP_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
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
// scrape comfortable headroom; the scrape budgets below cap what one fetch
// may actually take once the budget is nearly spent.
const FETCH_TIMEOUT_MS = 100_000;
// 18 Sep 2026 (Shradha): ScrapingDog answered 202 to six attempts in a row
// while she sat on the wait page that promises "less than a minute": six
// fetches of ~46s plus five 20s waits, 6m16s in all, and then nothing at all,
// because the exhausted live scrape was treated as a rate limit and the
// cached copy of her page was never read. A scrape now has a budget: no new
// attempt starts once it is spent, a fetch is cut at the hard cap, and only a
// rate limit that never cleared skips the cached copy. The live page keeps a
// long first fetch (a cold scrape can take 60-90s); the cached copy answers
// from ScrapingDog's own store in seconds, so its budget is short.
// 12 Nov 2026: the cached budget (20 s) equalled the 202 wait (20 s), so the
// cached copy never got a second attempt; it now allows two more. Each lets
// ScrapingDog's ~50 s "not stored yet" answer arrive. The two calls together
// never take more than SCRAPE_TOTAL_MS (105 s): the cached call gets only what
// the live one left. Of the 150 s deadline (deadline.ts) that keeps 45 s for
// the Anthropic gap fill that runs after a thin profile.
interface ScrapeBudget { budgetMs: number; hardCapMs: number }
const LIVE_BUDGET: ScrapeBudget = { budgetMs: 45_000, hardCapMs: 80_000 };
const CACHED_BUDGET: ScrapeBudget = { budgetMs: 40_000, hardCapMs: 55_000 };
export const SCRAPE_TOTAL_MS = 105_000;
export const GAP_FILL_RESERVE_MS = 45_000;
/** Less than this left: the cached call is not started (it could not answer, and a "not stored yet" needs ~50 s). */
const MIN_CACHED_MS = 10_000;

/** The cached call's budget once the live call has taken `liveElapsedMs`: the time left, at most its own; null when too little is left. */
export function cachedBudgetAfter(liveElapsedMs: number): ScrapeBudget | null {
  const left = SCRAPE_TOTAL_MS - liveElapsedMs;
  if (left < MIN_CACHED_MS) return null;
  return { budgetMs: Math.min(CACHED_BUDGET.budgetMs, left), hardCapMs: Math.min(CACHED_BUDGET.hardCapMs, left) };
}

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
 * form when the slug has any letter at all; the same seed gives the same id.
 * The provider seeds it with the 90-day lookup window (12 Nov 2026): a seed
 * per request meant no request ever found the copy an earlier one caused.
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

/** The 90-day window a moment falls in: the seed of the live id, so every lookup in one window asks for the same id. */
export function lookupWindow(now: number = Date.now()): number {
  return Math.floor(now / LOOKUP_WINDOW_MS);
}

async function fetchOnce(linkId: string, timeoutMs: number): Promise<{ status: number; body?: any }> {
  // premium=true is the working parameter — private=true returns a hard 400
  // ("Try again or use premium=true") per the live A2 discovery call. Bare
  // no-flag also worked, but ScrapingDog's own error text recommends premium.
  const url = `${BASE}?api_key=${config.scrapingdogApiKey}&type=profile&id=${encodeURIComponent(linkId)}&premium=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
// The live page pads values with newlines and runs of spaces; one space is a value's only whitespace.
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() && !isMasked(v) ? v.replace(/\s+/g, ' ').trim() : null);
/** The live page repeats the position inside the company ("Co-chair Gates Foundation"); the company is what is left. */
function companyOnly(company: string | null, role: string | null): string | null {
  if (!company || !role) return company;
  const c = company.trim();
  if (c.toLowerCase().startsWith(role.trim().toLowerCase())) {
    const rest = c.slice(role.trim().length).replace(/^[\s,:·\-–—|]+/, '').trim();
    return rest || c;
  }
  return c;
}
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
  const company = companyOnly(text(e.company_name ?? e.company), role);
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

/**
 * LinkedIn's "show more" pattern reaches the payload as the collapsed text,
 * then "Show more", then the full text, then "Show less". Keep the full text.
 */
function expandedText(v: unknown): string | null {
  const raw = typeof v === 'string' ? v : '';
  if (!raw.trim()) return null;
  const i = raw.indexOf('Show more');
  const chosen = i >= 0 ? raw.slice(i + 'Show more'.length) : raw;
  return text(chosen.replace(/Show less\s*$/i, '').replace(/^[\s“"]+|[\s”"]+$/g, ''));
}

/** "Stefan Avivson: “People who dare win more. …”" */
function formatRecommendation(r: any): string | null {
  const who = text(r.name);
  const what = expandedText(r.summary);
  if (!what) return null;
  const body = what.length > 400 ? what.slice(0, 397).trimEnd() + '…' : what;
  return who ? `${who}: “${body}”` : `“${body}”`;
}

/** "Business and Management in Asia (Springer Nature): Co-authored a book chapter…" */
function formatPublication(x: any): string | null {
  const name = nameOf(x, 'name', 'title');
  if (!name) return null;
  const publisher = text(x.sub_title ?? x.publisher);
  const summary = expandedText(x.summary);
  const head = publisher ? `${name} (${publisher})` : name;
  return summary ? `${head}: ${summary.length > 240 ? summary.slice(0, 237).trimEnd() + '…' : summary}` : head;
}

/**
 * 15 Sep 2026 (Ali's own page, live): the scrape returned LinkedIn's grey
 * placeholder (a static.licdn.com SVG) as the photo, the merge kept it over
 * the real photo in the cached copy, and the login capture rightly refused
 * it. A placeholder is no photo: real photos live on media.licdn.com.
 */
export function realPhoto(url: string | null): string | null {
  if (!url) return null;
  if (/static\.licdn\.com\//i.test(url)) return null;
  if (/\/aero-v1\/sc\/h\//i.test(url)) return null;
  if (/\.svg(\?|$)/i.test(url)) return null;
  return url;
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
export function mapProfile(raw: any, requestedUrl: string): { profile: EnrichedProfile; missing: string[]; masked: number } | null {
  const p = Array.isArray(raw) ? raw[0] : raw;
  if (!p || typeof p !== 'object') return null;

  const rawExp: any[] = list(p.experience);
  const exp: any[] = rawExp.filter(usableExperience);
  // Entries the guest view hid ("******* *******"): the cached copy may still hold them.
  const masked = rawExp.filter((e) => e && typeof e === 'object' && (isMasked(e.position ?? e.title) || isMasked(e.company_name ?? e.company))).length;
  const current = exp[0] ?? {};
  const fullName = text(p.fullName) ?? text([p.first_name, p.last_name].filter(Boolean).join(' '));
  const headline = text(p.headline);

  const hasSignal = !!fullName || !!headline || rawExp.length > 0;
  if (!hasSignal) return null;

  const certifications = dedupe(list(p.certification ?? p.certifications).map(formatCertification));
  const volunteering = dedupe(list(p.volunteering ?? p.volunteer).map(formatVolunteering));
  const languages = dedupe(list(p.languages).map((l: any) => nameOf(l, 'name', 'language')));
  const publications = dedupe(list(p.publications).map(formatPublication));
  const recommendations = dedupe(list(p.recommendations).map(formatRecommendation)).slice(0, 3);
  const posts = dedupe([...list(p.activities), ...list(p.articles)].map((x: any) => nameOf(x, 'title', 'activity', 'name'))).slice(0, 8);
  // The top card's first line is the current company on a live scrape; a
  // fallback when the experience list carries nothing usable.
  const topCardCompany = text(p.description?.description1);
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
  if (posts.length) highlights.push(`Recent posts: ${posts.slice(0, 3).join('; ')}`);
  for (const r of recommendations) highlights.push(`Recommended by ${r}`);
  if (followers) highlights.push(`${followers} on LinkedIn`);

  const currentRole = text(current.position ?? current.title);
  const profile: EnrichedProfile = {
    fullName,
    headline,
    currentRole,
    currentCompany: companyOnly(text(current.company_name ?? current.company), currentRole) ?? topCardCompany,
    industry: text(p.industry),
    location: text(p.location),
    summary: text(p.about),
    pastRoles: exp
      .slice(1)
      .map(formatPastRole)
      .filter((s: string) => s.length > 0),
    education: list(p.education),
    skills,
    photoUrl: realPhoto(text(p.profile_photo) ?? text(p.profile_pic_url)),
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
    recommendations,
    posts,
    highlights,
  };
  const missing = (['headline', 'currentRole', 'currentCompany'] as const).filter((k) => !profile[k]);
  return { profile, missing, masked };
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
    recommendations: union(live.recommendations, cached.recommendations).slice(0, 3),
    posts: union(live.posts, cached.posts).slice(0, 8),
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

type ScrapeCall = 'live' | 'cached';

/** Every occurrence of needle (compared in lower case) replaced by [profile]. String steps only, never a pattern. */
function replaceAllInsensitive(m: string, needle: string): string {
  if (!needle) return m;
  const lower = m.toLowerCase();
  let out = '';
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    out += m.slice(from, at) + '[profile]';
    from = at + needle.length;
  }
  return out + m.slice(from);
}

/**
 * ScrapingDog's message for a log line or a returned reason (a reason is stored as the member's enrichment error and
 * logged further up): short, without the key, and without the profile id in any casing, plain or percent-encoded
 * (a full URL echo carries the id too).
 */
export function scrubMessage(message: string, linkId: string): string {
  let m = redact(message).slice(0, 400);
  m = replaceAllInsensitive(m, encodeURIComponent(linkId).toLowerCase());
  m = replaceAllInsensitive(m, linkId.toLowerCase());
  return m.slice(0, 200);
}

/** Every answer that is not a profile, in the log: never the key, never the slug or any personal data. */
function logAnswer(call: ScrapeCall, linkId: string, status: number, attempt: number, elapsedMs: number, message?: string): void {
  logger.warn(
    { provider: 'scrapingdog', call, status, attempt, elapsedMs, ...(message ? { message: scrubMessage(message, linkId) } : {}) },
    'scrapingdog: lookup answered without a profile',
  );
}

/** One attempt loop for one linkId: 202 → wait, rate limit → back off, "not stored yet" → stop, plan error → provider_error.
 *  Every wait is taken only when the next attempt would still start inside the budget. */
async function scrape(linkId: string, budget: ScrapeBudget, call: ScrapeCall): Promise<Scrape> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const anotherAttemptFitsAfter = (delayMs: number) => elapsed() + delayMs < budget.budgetMs;
  let attempt = 0;
  try {
    for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const timeoutMs = Math.max(1_000, Math.min(FETCH_TIMEOUT_MS, budget.hardCapMs - elapsed()));
      const { status, body } = await fetchOnce(linkId, timeoutMs);

      // A body-level `success:false` is ScrapingDog's own signal for a
      // request/plan-level problem (bad param, quota exhausted) — never
      // "this profile doesn't exist". Checked regardless of HTTP status
      // (it has arrived under both 200 and 400 in live testing); only a
      // plain 404/410 with NO such body falls through to not_found below.
      if (body && !Array.isArray(body) && typeof body === 'object' && body.success === false) {
        const message = typeof body.message === 'string' ? body.message : 'scrapingdog error';
        logAnswer(call, linkId, status, attempt, elapsed(), message);
        // Checked before the rate limit: this message says "try again" too.
        if (NOT_READY.test(message)) return { kind: 'retry_exhausted', notReady: true };
        if (status === 429 || RATE_LIMITED.test(message)) {
          const delay = RATE_LIMIT_DELAY_MS * attempt;
          if (attempt < MAX_ATTEMPTS && anotherAttemptFitsAfter(delay)) { await sleep(delay); continue; }
          return { kind: 'retry_exhausted', rateLimited: true };
        }
        return { kind: 'provider_error', reason: scrubMessage(message, linkId) };
      }
      if (status === 200) return { kind: 'ok', body };
      logAnswer(call, linkId, status, attempt, elapsed(), typeof body?.message === 'string' ? body.message : undefined);
      if (status === 429) {
        const delay = RATE_LIMIT_DELAY_MS * attempt;
        if (attempt < MAX_ATTEMPTS && anotherAttemptFitsAfter(delay)) { await sleep(delay); continue; }
        return { kind: 'retry_exhausted', rateLimited: true };
      }
      if (status === 202) {
        if (attempt < MAX_ATTEMPTS && anotherAttemptFitsAfter(RETRY_DELAY_MS)) { await sleep(RETRY_DELAY_MS); continue; }
        return { kind: 'retry_exhausted' };
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
    // A fetch cut by AbortSignal.timeout rejects with a DOMException, which is not always `instanceof Error`.
    const message = (err as { message?: unknown } | null)?.message;
    const reason = typeof message === 'string' ? scrubMessage(message, linkId) : 'unknown';
    logAnswer(call, linkId, 0, attempt, elapsed(), reason);
    return { kind: 'provider_error', reason };
  }
}

export const scrapingdogProvider: EnrichmentProvider = {
  name: 'scrapingdog',
  async enrich({ linkedinUrl }) {
    const slug = linkedinSlug(linkedinUrl);
    if (!slug) return { kind: 'not_found', reason: 'no /in/ slug in submitted URL' };
    const requestedUrl = normalizeLinkedinUrl(linkedinUrl)!;

    const startedAt = Date.now();
    // 1. The live page, through this window's id (cached by ScrapingDog at most since the window began).
    const live = await scrape(freshSlug(slug, lookupWindow()), LIVE_BUDGET, 'live');
    let liveMapped = live.kind === 'ok' ? mapProfile(live.body, requestedUrl) : null;
    const sources: string[] = [];
    if (liveMapped) sources.push(`scrapingdog:${slug}:live`);

    // 2. The cached copy: the only answer when the live scrape failed, and a
    //    gap-filler when the live page came back thin (guest-view masking).
    //    Not after a rate limit that never cleared: the cached call would be
    //    rate-limited too. A live scrape that merely ran out of time (18 Sep
    //    2026, Shradha's six minutes of 202s) still reads it.
    let cachedMapped: { profile: EnrichedProfile; missing: string[]; masked: number } | null = null;
    let cached: Scrape | null = null;
    const liveFailedHard = live.kind === 'retry_exhausted' && live.rateLimited === true;
    // Thin, or with entries the guest view masked: the cached copy may hold
    // the headline, the About or the older positions the live page hid.
    // 12 Nov 2026: it gets only what is left of SCRAPE_TOTAL_MS, so the gap fill keeps its reserve in the deadline.
    const cachedBudget = cachedBudgetAfter(Date.now() - startedAt);
    if ((!liveMapped || isThin(liveMapped.profile) || liveMapped.masked > 0) && !liveFailedHard && cachedBudget) {
      cached = await scrape(slug, cachedBudget, 'cached');
      if (cached.kind === 'ok') {
        cachedMapped = mapProfile(cached.body, requestedUrl);
        if (cachedMapped) sources.push(`scrapingdog:${slug}`);
      }
    }
    if (!liveMapped && !cachedMapped) {
      // 12 Nov 2026: the cached call said "not stored yet, try again later" while the live call failed (a timeout, a
      // 5xx, a network error, its own wait) or came back empty: ScrapingDog asked for a later attempt, so that is the
      // verdict. Only a live 404/410 still says the profile does not exist.
      if (cached?.kind === 'retry_exhausted' && cached.notReady && live.kind !== 'not_found') {
        return { kind: 'retry_exhausted', notReady: true };
      }
      // 12 Nov 2026 (re-review N3): the live call timed out or failed, and the cached call then had less than its own
      // time (ScrapingDog's "not stored yet" takes ~50 s) or none at all, and said nothing definite. The outcome is
      // unknown, not "no such profile": one later attempt, which costs nothing unless it finds the profile.
      const cachedShortOfTime = !cachedBudget || cachedBudget.hardCapMs < CACHED_BUDGET.hardCapMs;
      const cachedSaidNothing = !cached || (cached.kind !== 'ok' && cached.kind !== 'not_found');
      if (live.kind === 'provider_error' && cachedShortOfTime && cachedSaidNothing) {
        return { kind: 'retry_exhausted', timedOut: true };
      }
      // Otherwise the live attempt's verdict stands
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
