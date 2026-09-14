// ─── The LinkedIn result strengthens the intent (14 Sep 2026) ────────────────
//
// Ali, after the full-flow smoke: "its not only about getting photo at login
// also linkedIn whole data so profile is strong". Until now the extractor read
// the CHAT only, so a member with a rich LinkedIn and a two-word chat
// (Shradha: "networking", "blogs") ended with a weak matching profile even
// though we held their role, company, About and skills. Two layers:
//
//   1. The extractor is handed the known profile as stated facts (prompts.ts,
//      serializeKnownForExtraction) and told to use them.
//   2. This module fills, deterministically, whatever the extraction still
//      left empty, from the same facts. Never overwrites what the member said
//      in the chat; never guesses a role (a headline is not a title).
//
// Wants stay the member's own: LinkedIn's "likely wants to meet" is used only
// when the chat, after inference, named nobody at all, and at low confidence.

import type { ExtractedIntent } from './intent.schema';
import type { EnrichedProfile } from './enrichment.service';

export interface KnownForIntent {
  name?: string | null;
  headline?: string | null;
  role?: string | null;
  company?: string | null;
  industry?: string | null;
  location?: string | null;
  about?: string | null;
  skills?: string[];
  pastRoles?: string[];
  likelyWantsToMeet?: string[];
  likelyOffers?: string[];
  reason?: string | null;
  /** 14 Sep 2026: the rest of the LinkedIn page (certifications, volunteering, publications, education, followers) as lines. */
  highlights?: string[];
  languages?: string[];
}

/** "Python for Data Science (IBM, Jul 2025)" → "Python for Data Science". */
const certName = (c: string): string => c.replace(/\s*\([^)]*\)\s*$/, '').trim();

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : []);
const dedupe = (xs: string[]): string[] => {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
};

/**
 * Everything we hold about the member, from the cached enrichment first and
 * the saved profile columns (the host's known block) on top: a saved title,
 * industry or bio is the member's own and wins over the scrape.
 */
export function knownForIntent(
  enr: EnrichedProfile | null | undefined,
  saved?: { role?: string | null; industry?: string | null; about?: string | null; company?: string | null; interests?: string[]; whyHere?: string | null } | null,
  name?: string | null,
): KnownForIntent {
  return {
    name: s(name) ?? s(enr?.fullName),
    headline: s(enr?.headline),
    role: s(saved?.role) ?? s(enr?.currentRole),
    company: s(saved?.company) ?? s(enr?.currentCompany),
    industry: s(saved?.industry) ?? s(enr?.industry),
    location: s(enr?.location),
    about: s(saved?.about) ?? s(enr?.summary),
    // Skills, then what they certified in: both are things they know.
    skills: dedupe([...arr(saved?.interests), ...arr(enr?.skills), ...arr(enr?.certifications).map(certName)]).slice(0, 15),
    pastRoles: arr(enr?.pastRoles).slice(0, 6),
    likelyWantsToMeet: arr(enr?.likelyWantsToMeet).slice(0, 6),
    likelyOffers: arr(enr?.likelyOffers).slice(0, 6),
    reason: s(saved?.whyHere),
    highlights: arr(enr?.highlights).slice(0, 8),
    languages: arr(enr?.languages).slice(0, 8),
  };
}

/** True when the block holds at least one fact worth telling the extractor. */
export function hasKnownFacts(k: KnownForIntent | null | undefined): boolean {
  if (!k) return false;
  return !!(k.headline || k.role || k.company || k.industry || k.location || k.about || k.skills?.length || k.pastRoles?.length || k.likelyWantsToMeet?.length || k.likelyOffers?.length || k.highlights?.length || k.languages?.length);
}

/** The first one or two sentences of an About, for a summary the card can show. */
function shortAbout(about: string): string {
  const sentences = about.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const out = sentences.slice(0, 2).join(' ');
  return out.length > 300 ? out.slice(0, 297).trimEnd() + '…' : out;
}

/**
 * Fill what the extraction left empty from the known profile. Pure, defensive
 * (a partial intent object is tolerated), and never touches a field the chat
 * already filled.
 */
export function strengthenIntent<T extends Partial<ExtractedIntent>>(intent: T, known: KnownForIntent | null | undefined): T {
  if (!hasKnownFacts(known) && !known?.reason) return intent;
  const k = known!;
  const out: Partial<ExtractedIntent> = { ...intent };
  const filled: string[] = [];
  const fillStr = (key: 'userRole' | 'userCompany' | 'userIndustry' | 'userLocation' | 'userProfileSummary' | 'reasonForMeeting' | 'embeddingText', value: string | null | undefined) => {
    if (!s(out[key]) && s(value)) { out[key] = s(value)!; filled.push(key); }
  };
  const fillArr = (key: 'userExpertise' | 'userInterests' | 'userCanOffer' | 'desiredPeople', values: string[] | undefined, cap: number) => {
    if (arr(out[key]).length === 0 && arr(values).length) { out[key] = dedupe(arr(values)).slice(0, cap); filled.push(key); }
  };

  // Facts. A role only when the profile states one; a headline is not a title.
  fillStr('userRole', k.role);
  fillStr('userCompany', k.company);
  fillStr('userIndustry', k.industry);
  fillStr('userLocation', k.location);
  fillStr('reasonForMeeting', k.reason);
  fillArr('userExpertise', k.skills, 10);
  fillArr('userInterests', k.skills, 10);
  fillArr('userCanOffer', k.likelyOffers, 6);

  // Who they are, in words: the About first, else the headline, else what
  // the rest of the page says (certified in, volunteers as, published).
  const aboutLine = k.about ? shortAbout(k.about) : null;
  const pageLine = arr(k.highlights).length ? arr(k.highlights).slice(0, 2).join('. ') : null;
  fillStr('userProfileSummary', aboutLine ?? k.headline ?? pageLine);
  if (arr(out.userLanguages).length === 0 && arr(k.languages).length) { out.userLanguages = dedupe(arr(k.languages)).slice(0, 8); filled.push('userLanguages'); }

  // Wants: the member's own words first (the extractor already inferred from
  // the chat); LinkedIn's guess only when nothing at all came through.
  if (arr(out.desiredPeople).length === 0 && arr(out.desiredRoles).length === 0 && arr(k.likelyWantsToMeet).length) {
    out.desiredPeople = dedupe(arr(k.likelyWantsToMeet)).slice(0, 6);
    filled.push('desiredPeople');
    const c = out.confidenceScores ?? { desiredPeople: 0, reasonForMeeting: 0, userProfile: 0 };
    out.confidenceScores = { ...c, desiredPeople: Math.max(Number(c.desiredPeople) || 0, 0.3) };
  }

  // Text for semantic search, when the chat gave none.
  if (!s(out.embeddingText)) {
    const who = [s(out.userRole), s(out.userCompany) ? `at ${s(out.userCompany)}` : null].filter(Boolean).join(' ');
    const parts = [
      k.name && who ? `${k.name}, ${who}.` : who ? `${who}.` : null,
      aboutLine ?? k.headline ?? pageLine,
      s(out.reasonForMeeting) ? `Here to ${s(out.reasonForMeeting)!.replace(/^(to|for)\s+/i, '')}.` : null,
      arr(out.desiredPeople).length ? `Wants to meet ${arr(out.desiredPeople).join(', ')}.` : null,
    ].filter(Boolean);
    if (parts.length) { out.embeddingText = parts.join(' '); filled.push('embeddingText'); }
  }

  // Tags: skills and the industry, when the chat produced few.
  const tags = arr(out.matchingTags);
  if (tags.length < 5) {
    const extra = [...arr(k.skills), ...(k.industry ? [k.industry] : [])].map((t) => t.toLowerCase());
    const merged = dedupe([...tags, ...extra]).slice(0, 12);
    if (merged.length > tags.length) { out.matchingTags = merged; filled.push('matchingTags'); }
  }

  // The profile side of confidence: a stated role or company plus an About is
  // a known person, however short the chat was.
  const knownPerson = !!(s(out.userRole) || s(out.userCompany)) && !!(aboutLine || k.headline || pageLine || arr(k.skills).length);
  if (knownPerson) {
    const c = out.confidenceScores ?? { desiredPeople: 0, reasonForMeeting: 0, userProfile: 0 };
    if ((Number(c.userProfile) || 0) < 0.7) { out.confidenceScores = { ...c, userProfile: 0.7 }; filled.push('confidenceScores.userProfile'); }
  }

  return filled.length ? (out as T) : intent;
}
