// ─── Profile Enrichment ──────────────────────────────────────────────────────
//
// Pull a member's PUBLIC professional profile via Claude's web_search tool, so we
// can pre-fill their RSN profile + matching signals with minimal asking. Validated
// end-to-end in e2e/spike-enrich.mjs (Sonnet 4.6 + web_search returns clean, cited,
// structured data for both a LinkedIn-URL case and a name+company+city case).
//
// This is public web search + synthesis — NOT LinkedIn's API, NOT a login-scrape.
// Results are SUGGESTED + editable, never silently written, and gated by a
// confidence score so the no-URL path can be confirmed ("is this you?") first.
// Never throws into onboarding — returns confidence 0 on any failure.

import Anthropic from '@anthropic-ai/sdk';
import config from '../../config';
import logger from '../../config/logger';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

// Free/personal providers carry no company signal — don't treat the domain as an employer.
const FREE_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com',
  'zoho.com', 'fastmail.com', 'hey.com', 'qq.com', '163.com',
]);

/** Work-email domain → a company name hint. Free providers → null. Domain only; never the raw address. */
export function companyFromEmail(email?: string | null): string | null {
  if (!email || !email.includes('@')) return null;
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain || FREE_EMAIL_PROVIDERS.has(domain)) return null;
  const core = domain.split('.')[0];
  if (!core || core.length < 2) return null;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

export interface EnrichSignals {
  fullName: string;
  email?: string | null;
  city?: string | null;
  country?: string | null;
  company?: string | null;
  linkedinUrl?: string | null;
}

/** Build the human-readable "who to look up" string from whatever signals we hold. */
export function buildEnrichmentTarget(s: EnrichSignals): string {
  const parts: string[] = [];
  if (s.fullName?.trim()) parts.push(s.fullName.trim());
  const company = s.company?.trim() || companyFromEmail(s.email);
  if (company) parts.push(`works at/with ${company}`);
  const loc = [s.city?.trim(), s.country?.trim()].filter(Boolean).join(', ');
  if (loc) parts.push(`located in ${loc}`);
  if (s.linkedinUrl?.trim()) parts.push(`LinkedIn: ${s.linkedinUrl.trim()}`);
  return parts.join('. ');
}

export interface EnrichedProfile {
  fullName: string | null;
  headline: string | null;
  currentRole: string | null;
  currentCompany: string | null;
  industry: string | null;
  location: string | null;
  summary: string | null;
  pastRoles: string[];
  education: unknown[];
  skills: string[];
  likelyWantsToMeet: string[];
  likelyOffers: string[];
  /** Natural openers a warm host could use, referencing what we found. */
  conversationStarters: string[];
  /** Uncertain facts the host should confirm naturally rather than assume. */
  questionsToVerify: string[];
  linkedinUrl: string | null;
}
export interface EnrichResult {
  profile: EnrichedProfile | null;
  confidence: number;
  sources: string[];
  foundLinkedinUrl: string | null;
  /** The LinkedIn URL we searched WITH (so the cache only re-runs on a genuinely new URL). */
  requestedLinkedinUrl: string | null;
  /** ISO timestamp of when this enrichment ran — drives the 90-day refresh. */
  enrichedAt: string | null;
}

const EMPTY: EnrichResult = { profile: null, confidence: 0, sources: [], foundLinkedinUrl: null, requestedLinkedinUrl: null, enrichedAt: null };

/** Below this confidence, escalate the cheap (Haiku) pass to the stronger model (Stefan's rule). */
const ENRICH_ESCALATE_BELOW = 0.6;
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Coerce confidence to 0..1. The model sometimes returns a word ("high") instead
 *  of a number — map those rather than treating them as 0 (which hid real matches). */
function toConfidence(v: unknown): number {
  if (typeof v === 'number') return Math.max(0, Math.min(1, v));
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    const n = Number(t);
    if (!Number.isNaN(n)) return Math.max(0, Math.min(1, n));
    if (t.includes('high')) return 0.9; // covers "very high"
    if (t.includes('medium') || t.includes('moderate')) return 0.6;
    if (t.includes('low')) return 0.2;
  }
  return 0;
}

/** Extract + validate the JSON object from the model's reply. Tolerant of surrounding prose. */
export function parseEnriched(text: string): EnrichResult {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (!m) return EMPTY;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return EMPTY; }
  const confidence = toConfidence(j.confidence);
  const profile: EnrichedProfile = {
    fullName: str(j.fullName), headline: str(j.headline), currentRole: str(j.currentRole),
    currentCompany: str(j.currentCompany), industry: str(j.industry), location: str(j.location),
    summary: str(j.summary), pastRoles: strArr(j.pastRoles), education: Array.isArray(j.education) ? j.education : [],
    skills: strArr(j.skills), likelyWantsToMeet: strArr(j.likelyWantsToMeet), likelyOffers: strArr(j.likelyOffers),
    conversationStarters: strArr(j.conversationStarters), questionsToVerify: strArr(j.questionsToVerify),
    linkedinUrl: str(j.linkedinUrl),
  };
  return { profile, confidence, sources: strArr(j.sources), foundLinkedinUrl: str(j.linkedinUrl), requestedLinkedinUrl: null, enrichedAt: null };
}

/**
 * Canonicalize whatever the member typed into a full LinkedIn profile URL.
 * Accepts a bare slug ("avivson"), "@avivson", "linkedin.com/in/avivson", or a
 * full URL — all become "https://www.linkedin.com/in/<slug>". Unrecognizable
 * input is returned as-is (trimmed) rather than guessed at.
 */
export function normalizeLinkedinUrl(input?: string | null): string | null {
  const s = (input ?? '').trim();
  if (!s) return null;
  const slug = linkedinSlug(s);
  if (slug) return `https://www.linkedin.com/in/${slug}`;
  // No /in/ path. A bare handle (no slashes, not a linkedin domain) is a slug.
  const bare = s.replace(/^@/, '');
  if (!bare.includes('/') && !/linkedin\./i.test(bare) && /^[A-Za-z0-9][A-Za-z0-9\-_.]*$/.test(bare)) {
    return `https://www.linkedin.com/in/${bare.toLowerCase()}`;
  }
  return s;
}

/** The /in/{slug} identity from a LinkedIn URL, lowercased — for comparing two URLs. */
export function linkedinSlug(url?: string | null): string | null {
  if (!url) return null;
  const m = String(url).toLowerCase().match(/\/in\/([^/?#]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).replace(/\/+$/, ''); } catch { return m[1].replace(/\/+$/, ''); }
}

/**
 * OUR-side identity check. The member always confirms ("is this you?"), but we must
 * present a GOOD guess — not a random namesake. If they gave an exact LinkedIn URL
 * and the search came back tied to a DIFFERENT profile, it's the wrong person
 * (common-name case) — downgrade so we never auto-fill a stranger's data. Also
 * records the URL we searched with for the cache.
 */
export function applyMatchVerification(result: EnrichResult, requestedLinkedinUrl: string | null): EnrichResult {
  const out: EnrichResult = { ...result, requestedLinkedinUrl: requestedLinkedinUrl || null };
  const reqSlug = linkedinSlug(requestedLinkedinUrl);
  const foundSlug = linkedinSlug(result.foundLinkedinUrl);
  if (reqSlug && foundSlug && reqSlug !== foundSlug) {
    return { ...out, confidence: Math.min(out.confidence, 0.15) };
  }
  return out;
}

/** Haiku (and older models) use the basic web_search tool; Opus 4.6+/Sonnet 4.6 get dynamic filtering. */
function webSearchToolType(model: string): 'web_search_20260209' | 'web_search_20250305' {
  return /opus-4-(6|7|8)|sonnet-4-6/.test(model) ? 'web_search_20260209' : 'web_search_20250305';
}

const PROMPT = (s: EnrichSignals): string => {
  const company = s.company?.trim() || companyFromEmail(s.email);
  const loc = [s.city?.trim(), s.country?.trim()].filter(Boolean).join(', ');
  const lines: string[] = [
    'You are enriching a professional networking profile. Use web search to find this specific person\'s PUBLIC professional profile.',
    `Person: ${s.fullName?.trim() || ''}`,
  ];
  if (s.linkedinUrl?.trim()) {
    lines.push(`They gave THIS exact LinkedIn URL: ${s.linkedinUrl.trim()} — find the person at THIS specific profile. Many people share the same name, so only return data you are confident belongs to THIS exact profile/person, and report the LinkedIn URL you actually found.`);
  }
  const hints: string[] = [];
  if (company) hints.push(`company possibly around "${company}"`);
  if (loc) hints.push(`location possibly around "${loc}"`);
  if (hints.length) lines.push(`Weak hints (these may be inaccurate — e.g. guessed from an email domain): ${hints.join('; ')}. Use them only as soft corroboration: if the profile you find matches them, be more confident. Do NOT lower your confidence just because they differ, especially when the LinkedIn URL is a strong match.`);
  lines.push('If you CANNOT confidently identify this specific person (for example a common name with many matches and nothing to corroborate), return confidence 0 with null/empty fields. Do NOT return a different person\'s data.');
  lines.push('Also include conversationStarters (1 to 3 natural openers a warm host could use, referencing what you found) and questionsToVerify (1 to 3 facts that are uncertain and the host should confirm naturally rather than assume).');
  lines.push('Return ONLY a JSON object (no prose) with these keys: fullName, headline, currentRole, currentCompany, industry, location, summary, pastRoles (string array), education (array), skills (string array), likelyWantsToMeet (string array), likelyOffers (string array), conversationStarters (string array), questionsToVerify (string array), linkedinUrl (the profile URL you actually found), confidence (a NUMBER from 0 to 1, e.g. 0.85; do NOT use words like "high"), sources (array of urls you used).');
  lines.push('Use null or [] for anything you cannot support from search results. Do NOT invent facts.');
  return lines.join('\n');
};

/** True when enrichment can run (key present). Routes fall back gracefully when false. */
export function isEnrichmentEnabled(): boolean {
  return !!config.anthropicApiKey;
}

/**
 * Enrich a member's profile from public web data. Never throws — returns confidence 0
 * (and a null profile) on a missing key, no name, or any API/parse failure, so onboarding
 * is never blocked.
 */
/** One enrichment pass on a given model (web_search is incompatible with
 *  output_config.format, so we prompt for a JSON block and parse it). */
async function runEnrichOnce(signals: EnrichSignals, model: string): Promise<EnrichResult> {
  const resp = await getClient().messages.create({
    model,
    max_tokens: 2500,
    // Tool version is model-gated (Haiku → basic). Cap web searches low — fewer
    // round-trips = faster + cheaper.
    tools: [{ type: webSearchToolType(model), name: 'web_search', max_uses: 3 } as any],
    messages: [{ role: 'user', content: PROMPT(signals) }],
  });
  const text = resp.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('\n');
  return parseEnriched(text);
}

export async function enrichProfile(signals: EnrichSignals): Promise<EnrichResult> {
  if (!config.anthropicApiKey || !signals.fullName?.trim()) return EMPTY;
  const requested = signals.linkedinUrl?.trim() || null;
  // OUR-side identity check + stamp the run time (drives the 90-day refresh).
  const finalize = (r: EnrichResult): EnrichResult => ({
    ...applyMatchVerification(r, requested),
    enrichedAt: new Date().toISOString(),
  });
  try {
    // Primary pass on the cheap model (Haiku).
    let result = finalize(await runEnrichOnce(signals, config.onboardingEnrichModel));
    // Escalate to the stronger model (Sonnet) ONLY when the cheap pass is weak —
    // low confidence / no useful match (Stefan's cost rule). Most users never escalate.
    const fb = config.onboardingEnrichFallbackModel;
    if (result.confidence < ENRICH_ESCALATE_BELOW && fb && fb !== config.onboardingEnrichModel) {
      try {
        const better = finalize(await runEnrichOnce(signals, fb));
        if (better.confidence > result.confidence) result = better;
      } catch (err) {
        logger.warn({ err }, 'enrichProfile escalation failed — keeping the primary result');
      }
    }
    return result;
  } catch (err) {
    logger.warn({ err }, 'enrichProfile failed — onboarding continues without enrichment');
    return { ...EMPTY, requestedLinkedinUrl: requested };
  }
}
