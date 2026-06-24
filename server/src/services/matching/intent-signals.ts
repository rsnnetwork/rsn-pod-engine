// ─── Intent Signals (onboarding-data matching enhancement) ───────────────────
//
// Pure helpers that turn the onboarding intent we already capture (who you want
// to meet, who you do not want to meet, your designation) into additive scoring
// signals for the live-event matching engine. These NEVER relax an exclusion;
// they only add relevance dimensions. A participant with no onboarding data
// scores exactly as before (these functions return neutral/zero contributions).

import { MatchingParticipant } from '@rsn/shared';

// Canonical designations distilled from the RSN Matching Engine doc's list.
// Free-text job titles are normalised into one of these buckets so designation
// compatibility (e.g. founder + investor) can be scored. Returns null when the
// title does not clearly map (treated as neutral by designationAffinity).
const DESIGNATION_RULES: Array<[RegExp, string]> = [
  [/\b(co[-\s]?founder|founder)\b/, 'founder'],
  [/\b(ceo|chief executive)\b/, 'ceo'],
  [/\b(cto|cfo|coo|cmo|chief)\b/, 'executive'],
  [/\b(investor|angel|venture|vc|general partner|managing partner|lp)\b/, 'investor'],
  [/\b(advisor|adviser|mentor)\b/, 'advisor'],
  [/\b(consultant|freelanc|contractor)\b/, 'consultant'],
  [/\b(board member|board director)\b/, 'board'],
  [/\b(owner|proprietor)\b/, 'owner'],
  [/\b(manager|director|head of|lead|vp|vice president)\b/, 'manager'],
  [/\b(student|intern|undergrad|graduate)\b/, 'student'],
  [/\b(job\s?seeker|seeking|candidate|between jobs|looking for (a )?(job|role|work))\b/, 'job_seeker'],
  [/\b(engineer|developer|designer|analyst|employee|specialist|associate|operator)\b/, 'employee'],
];

export function normalizeDesignation(title?: string | null): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const [re, d] of DESIGNATION_RULES) {
    if (re.test(t)) return d;
  }
  return null;
}

// Complementarity affinity, 0..1, symmetric. Higher = a more useful pairing.
// Cross-role complementary pairs (founder+investor, candidate+leader) score
// high; identical designations score lower (event diversity, per the doc's
// "avoid same designation repeatedly"); unknown designations are neutral.
const AFFINITY_PAIRS: Array<[string, string, number]> = [
  ['founder', 'investor', 1.0],
  ['founder', 'advisor', 0.9],
  ['founder', 'consultant', 0.7],
  ['ceo', 'investor', 0.95],
  ['owner', 'investor', 0.9],
  ['ceo', 'advisor', 0.85],
  ['student', 'advisor', 0.9],
  ['student', 'founder', 0.8],
  ['student', 'ceo', 0.85],
  ['job_seeker', 'ceo', 0.9],
  ['job_seeker', 'founder', 0.85],
  ['job_seeker', 'manager', 0.9],
  ['job_seeker', 'owner', 0.85],
  ['employee', 'investor', 0.7],
];
const AFFINITY = new Map<string, number>();
for (const [a, b, v] of AFFINITY_PAIRS) AFFINITY.set([a, b].sort().join('|'), v);
const SAME_DESIGNATION_SCORE: Record<string, number> = {
  founder: 0.4,
  investor: 0.3,
  job_seeker: 0.2,
};

export function designationAffinity(a?: string | null, b?: string | null): number {
  if (!a || !b) return 0.5; // unknown -> neutral
  if (a === b) return SAME_DESIGNATION_SCORE[a] ?? 0.45; // same -> mild diversity penalty
  return AFFINITY.get([a, b].sort().join('|')) ?? 0.6; // different, unlisted -> slightly positive
}

const STOP = new Set([
  'the', 'and', 'a', 'an', 'to', 'of', 'for', 'in', 'with', 'people', 'person',
  'someone', 'who', 'want', 'meet', 'meeting', 'looking', 'other', 'others',
  'more', 'my', 'me', 'their', 'they', 'are', 'is', 'at', 'on', 'or',
]);

/** Lowercased, de-duped word tokens (length >= 3, stopwords dropped). */
export function tokenizeTerms(items: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const it of items) {
    if (!it) continue;
    for (const w of String(it).toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !STOP.has(w)) out.add(w);
    }
  }
  return [...out];
}

/** Smooth overlap 0..1: 0,0.5,0.67,0.75… for 0,1,2,3 token matches. */
export function termOverlap(aTokens: string[], bTokens: string[]): number {
  if (!aTokens.length || !bTokens.length) return 0;
  let matches = 0;
  for (const a of aTokens) {
    if (
      bTokens.some(
        (b) => b === a || (a.length >= 4 && b.includes(a)) || (b.length >= 4 && a.includes(b))
      )
    ) {
      matches++;
    }
  }
  return matches === 0 ? 0 : 1 - 1 / (1 + matches);
}

/** Tokens describing who a participant IS (for the other side's "wants" to match against). */
export function identityTokens(p: MatchingParticipant): string[] {
  return tokenizeTerms([
    p.designation,
    p.industry,
    ...(p.interests || []),
    ...(p.reasonsToConnect || []),
  ]);
}

/**
 * Directional intent alignment: does a want to meet someone like b, and the
 * reverse? Mutual want gets a bonus. Returns the blended score plus the raw
 * directional pieces (for reason tags).
 */
export function intentAlignmentScore(
  a: MatchingParticipant,
  b: MatchingParticipant
): { score: number; aWantsB: number; bWantsA: number } {
  const aWants = tokenizeTerms(a.wantsToMeet || []);
  const bWants = tokenizeTerms(b.wantsToMeet || []);
  const aWantsB = termOverlap(aWants, identityTokens(b));
  const bWantsA = termOverlap(bWants, identityTokens(a));
  let score = 0.6 * aWantsB + 0.4 * bWantsA;
  if (aWantsB > 0 && bWantsA > 0) score = Math.min(1, score + 0.2); // mutual want bonus
  return { score, aWantsB, bWantsA };
}

/** True if either side's "do not want to meet" terms match the other's identity. */
export function avoidConflict(a: MatchingParticipant, b: MatchingParticipant): boolean {
  const aAvoid = tokenizeTerms(a.avoid || []);
  const bAvoid = tokenizeTerms(b.avoid || []);
  return termOverlap(aAvoid, identityTokens(b)) > 0 || termOverlap(bAvoid, identityTokens(a)) > 0;
}

/**
 * Phase 2 — pair confidence 0..1: the normalized score tempered by how far down
 * the fallback ladder the round landed (fresh = full confidence; each relaxed
 * level shaves 15%). Pure; stored on each persisted match for analytics.
 */
export function pairConfidence(score: number, fallbackLevel = 0): number {
  const v = score * (1 - 0.15 * (fallbackLevel || 0));
  return Math.max(0, Math.min(1, Number(v.toFixed(4))));
}

// ─── Phase 2: cooldown window ────────────────────────────────────────────────
// True if a pair last met within the cooldown window (so they should NOT be
// re-matched yet). Older pairs fall through to the freshness penalty. ~30-day
// months. `now` is injectable for tests.
export function withinCooldown(lastMetAt: Date | string, months: number, now = Date.now()): boolean {
  const cutoff = now - months * 30 * 24 * 60 * 60 * 1000;
  return new Date(lastMetAt).getTime() >= cutoff;
}

// ─── Phase 2: profile completeness (tiered scoring) ──────────────────────────
// A 0..1 score of how filled a participant's matchable profile is. Thin profiles
// get safer matching (the engine dampens sparse-data signals) without exclusion.
export function profileCompleteness(p: MatchingParticipant): number {
  const has = (v: unknown) =>
    Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim().length > 0 : !!v;
  const checks = [
    has(p.designation),
    has(p.industry),
    has(p.interests),
    has(p.reasonsToConnect),
    has(p.wantsToMeet),
    has(p.company),
  ];
  return checks.filter(Boolean).length / checks.length;
}

// ─── Phase 2: per-event intention overlay ────────────────────────────────────
// The member's stated intention for THIS event (captured at check-in) acts like
// a high-priority "wantsToMeet" term against the other person's identity.
export function eventIntentionScore(a: MatchingParticipant, b: MatchingParticipant): number {
  const aInt = tokenizeTerms(a.eventIntention ? [a.eventIntention] : []);
  const bInt = tokenizeTerms(b.eventIntention ? [b.eventIntention] : []);
  const aToB = termOverlap(aInt, identityTokens(b));
  const bToA = termOverlap(bInt, identityTokens(a));
  return Math.max(aToB, bToA);
}

// openness-to-unexpected dial: 'only_relevant' leans harder on relevance, 'very_open'
// softens it. Average of the pair; absent openness is neutral (1.0) → backward safe.
export function pairOpennessFactor(a: MatchingParticipant, b: MatchingParticipant): number {
  const f = (o?: string | null) => (o === 'only_relevant' ? 1.25 : o === 'very_open' ? 0.8 : 1.0);
  return (f(a.openness) + f(b.openness)) / 2;
}
