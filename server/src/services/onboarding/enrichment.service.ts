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
  linkedinUrl: string | null;
}
export interface EnrichResult {
  profile: EnrichedProfile | null;
  confidence: number;
  sources: string[];
  foundLinkedinUrl: string | null;
}

const EMPTY: EnrichResult = { profile: null, confidence: 0, sources: [], foundLinkedinUrl: null };
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Extract + validate the JSON object from the model's reply. Tolerant of surrounding prose. */
export function parseEnriched(text: string): EnrichResult {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (!m) return EMPTY;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return EMPTY; }
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
  const profile: EnrichedProfile = {
    fullName: str(j.fullName), headline: str(j.headline), currentRole: str(j.currentRole),
    currentCompany: str(j.currentCompany), industry: str(j.industry), location: str(j.location),
    summary: str(j.summary), pastRoles: strArr(j.pastRoles), education: Array.isArray(j.education) ? j.education : [],
    skills: strArr(j.skills), likelyWantsToMeet: strArr(j.likelyWantsToMeet), likelyOffers: strArr(j.likelyOffers),
    linkedinUrl: str(j.linkedinUrl),
  };
  return { profile, confidence, sources: strArr(j.sources), foundLinkedinUrl: str(j.linkedinUrl) };
}

const PROMPT = (target: string) => `You are enriching a professional networking profile. Find this person's PUBLIC professional profile via web search and return ONLY a JSON object (no prose) with these keys:
fullName, headline, currentRole, currentCompany, industry, location, summary, pastRoles (string array), education (array), skills (string array), likelyWantsToMeet (string array), likelyOffers (string array), linkedinUrl, confidence (0..1 = how sure you are this is the right person), sources (array of urls you used).
Use null or [] for anything you cannot support from search results. Do NOT invent facts. If you cannot find a confident match, set confidence low.

Person: ${target}`;

/** True when enrichment can run (key present). Routes fall back gracefully when false. */
export function isEnrichmentEnabled(): boolean {
  return !!config.anthropicApiKey;
}

/**
 * Enrich a member's profile from public web data. Never throws — returns confidence 0
 * (and a null profile) on a missing key, no name, or any API/parse failure, so onboarding
 * is never blocked.
 */
export async function enrichProfile(signals: EnrichSignals): Promise<EnrichResult> {
  if (!config.anthropicApiKey || !signals.fullName?.trim()) return EMPTY;
  try {
    const resp = await getClient().messages.create({
      model: config.onboardingEnrichModel,
      max_tokens: 2500,
      // web_search is incompatible with output_config.format (citations), so we prompt
      // for a JSON block and parse it — matches the validated spike.
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 } as any],
      messages: [{ role: 'user', content: PROMPT(buildEnrichmentTarget(signals)) }],
    });
    const text = resp.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('\n');
    return parseEnriched(text);
  } catch (err) {
    logger.warn({ err }, 'enrichProfile failed — onboarding continues without enrichment');
    return EMPTY;
  }
}
