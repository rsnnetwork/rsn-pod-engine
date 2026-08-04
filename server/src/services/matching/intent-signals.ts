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
/**
 * THE role taxonomy. One list, used for both directions:
 *   `is`    — recognising what a person IS, from their title/role
 *   `wants` — recognising what a searcher is ASKING FOR, from their own words
 *
 * There used to be two rival lists that disagreed: this one had 12 buckets and
 * filed every engineer, developer, designer and analyst under 'employee', while
 * the want-side list in platform-match.service had 8 buckets and no developer
 * at all. A member searching for "developers" could therefore never get a role
 * match, so their agent fell back to loose word overlap and surfaced a CEO
 * because the words "can" and "build" happened to appear in her profile
 * (reported live, 3 Aug 2026).
 *
 * Both directions now derive from here, so the two can never drift apart again.
 * Order matters — the first bucket that matches wins, so specific roles come
 * before the generic ones ("Marketing Manager" is a marketer, not a manager).
 */
export interface RoleBucket {
  key: string;
  /** Plain-English plural used in match reasons: "You're looking to meet …". */
  label: string;
  /** Matches a person's own title or role. */
  is: RegExp;
  /** Matches a request for this kind of person. Defaults to `is`. */
  wants?: RegExp;
}

export const ROLE_TAXONOMY: RoleBucket[] = [
  { key: 'founder', label: 'founders', is: /\b(co[-\s]?founder|founder)s?\b/ },
  { key: 'investor', label: 'investors', is: /\b(investor|angel|venture capital|vc|general partner|managing partner)s?\b/ },
  { key: 'advisor', label: 'mentors and advisors', is: /\b(advisor|adviser|mentor)s?\b/ },
  { key: 'board', label: 'board members', is: /\b(board member|board director)s?\b/ },
  { key: 'developer', label: 'developers and engineers', is: /\b(developer|engineer|programmer|coder|software|full[-\s]?stack|front[-\s]?end|back[-\s]?end|devops|architect)s?\b/ },
  { key: 'designer', label: 'designers', is: /\b(designer|ux|ui|creative director)s?\b/ },
  { key: 'marketer', label: 'marketing people', is: /\b(marketer|marketing|growth|brand|content strategist|seo)s?\b/ },
  { key: 'sales', label: 'sales people', is: /\b(sales|business development|bizdev|account executive)s?\b/ },
  { key: 'hr', label: 'HR and people leads', is: /\b(hr|human resources|people (lead|ops|officer|partner)|recruit(er|ing|ment)?|talent)s?\b/ },
  { key: 'product_manager', label: 'product and project managers', is: /\b(product manager|project manager|programme manager|program manager|product owner|scrum master)s?\b/ },
  { key: 'manufacturer', label: 'manufacturers and suppliers', is: /\b(manufacturer|supplier|factory|fabricator|distributor)s?\b/ },
  { key: 'consultant', label: 'consultants', is: /\b(consultant|freelanc|contractor)s?\b/ },
  { key: 'ceo', label: 'CEOs', is: /\b(ceo|chief executive)s?\b/ },
  { key: 'executive', label: 'executives', is: /\b(cto|cfo|coo|cmo|cso|cco|chief|c[-\s]?suite|executive)s?\b/ },
  { key: 'owner', label: 'business owners', is: /\b(owner|proprietor)s?\b/ },
  { key: 'manager', label: 'managers and leads', is: /\b(manager|director|head of|team lead|vp|vice president)s?\b/ },
  { key: 'student', label: 'students', is: /\b(student|intern|undergrad|graduate)s?\b/ },
  {
    key: 'job_seeker', label: 'candidates',
    is: /\b(job\s?seeker|candidate|between jobs|looking for (a )?(job|role|work))s?\b/,
    // As a WANT, this is someone hiring: "we are recruiting", "looking to hire".
    wants: /\b(recruit|hire|hiring|talent|candidate)s?\b/,
  },
  {
    key: 'customer', label: 'customers and clients',
    is: /\b(customer|client|buyer)s?\b/,
  },
  {
    key: 'partner', label: 'partners',
    is: /\b(partner|collaborator|reseller)s?\b/,
  },
  // Catch-all: a recognisable working title that fits none of the above.
  { key: 'employee', label: 'specialists and analysts', is: /\b(analyst|employee|specialist|associate|operator|coordinator|assistant)s?\b/ },
];

/** What a person IS, from their job title or role. */
export function normalizeDesignation(title?: string | null): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const bucket of ROLE_TAXONOMY) {
    if (bucket.is.test(t)) return bucket.key;
  }
  return null;
}

/**
 * What a searcher is ASKING FOR, scanned from their own words. A sentence can
 * name several ("founders and investors"), so every bucket is tested rather
 * than stopping at the first.
 */
export function designationsWanted(text: string): Array<{ key: string; label: string }> {
  const t = text.toLowerCase();
  const out: Array<{ key: string; label: string }> = [];
  for (const bucket of ROLE_TAXONOMY) {
    if ((bucket.wants ?? bucket.is).test(t)) out.push({ key: bucket.key, label: bucket.label });
  }
  return out;
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

// Words that appear in almost any profile and therefore carry no matching
// signal. Two of them agreeing is not a reason to introduce two strangers: on
// 3 Aug 2026 a "react developer who can build my product" search surfaced a
// CEO because "can" and "build" both hit her profile, scoring 0.467 against a
// 0.45 bar. Specific terms (react, saas, sourdough) and role designations are
// what should carry a match, so only genuinely generic language belongs here.
const STOP = new Set([
  // articles, pronouns, connectives
  'the', 'and', 'a', 'an', 'to', 'of', 'for', 'in', 'with', 'my', 'me', 'our',
  'we', 'us', 'you', 'your', 'their', 'they', 'them', 'his', 'her', 'its',
  'this', 'that', 'these', 'those', 'who', 'whom', 'which', 'what', 'when',
  'where', 'why', 'how', 'are', 'is', 'was', 'were', 'be', 'been', 'being',
  'at', 'on', 'or', 'but', 'not', 'from', 'by', 'as', 'it', 'into', 'over',
  'out', 'up', 'down', 'about', 'than', 'then', 'so', 'if', 'all', 'any',
  'some', 'one', 'two', 'each', 'both', 'via',
  // generic people words
  'people', 'person', 'someone', 'somebody', 'anyone', 'everyone', 'other',
  'others', 'guy', 'guys', 'folks', 'member', 'members', 'individual',
  // generic intent verbs
  'want', 'wants', 'wanting', 'meet', 'meeting', 'looking', 'look', 'seek',
  'seeking', 'find', 'finding', 'need', 'needs', 'needing', 'like', 'love',
  'can', 'could', 'would', 'should', 'will', 'have', 'has', 'had', 'get',
  'getting', 'make', 'making', 'build', 'building', 'built', 'help', 'helps',
  'helping', 'work', 'works', 'working', 'join', 'joining', 'share', 'sharing',
  'learn', 'learning', 'grow', 'growing', 'connect', 'connecting', 'bring',
  'take', 'use', 'using', 'do', 'does', 'doing', 'go', 'going', 'come',
  'start', 'starting', 'run', 'running', 'give', 'know', 'knowing',
  // generic business nouns
  'product', 'products', 'business', 'businesses', 'company', 'companies',
  'thing', 'things', 'way', 'ways', 'time', 'idea', 'ideas', 'project',
  'projects', 'team', 'teams', 'network', 'networking', 'opportunity',
  'opportunities', 'experience', 'skills', 'service', 'services', 'solution',
  'solutions', 'value', 'world', 'life', 'stuff', 'lot', 'lots', 'level',
  'space', 'area', 'field', 'sector', 'side', 'part', 'kind', 'type',
  // generic qualifiers
  'more', 'most', 'new', 'good', 'great', 'best', 'better', 'big', 'small',
  'also', 'just', 'very', 'really', 'much', 'many', 'well', 'own', 'next',
  'first', 'last', 'same', 'right', 'able', 'interested', 'interesting',
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
