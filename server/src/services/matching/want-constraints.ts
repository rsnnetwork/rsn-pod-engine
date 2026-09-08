// ─── Explicit want constraints (Stefan, 9 Sep 2026) ─────────────────────────
//
// "Manufacturer in US with 20 years experience." The LOCATION and the
// EXPERIENCE are explicit constraints — strict, never widened — while the
// CATEGORY ("manufacturer") is matched by meaning. No LLM: a curated country
// alias map plus a couple of regexes.
//
// Profiles have a free-text `location` but NO experience field, so years are
// parsed from bio/expertise text. A stated value below the bar excludes the
// person; an unstated one can't be verified, so the scorer keeps them but
// demotes them and says so in the reason (never a silent empty list).

export interface WantConstraints {
  /** Canonical location terms the person must be in (any one satisfies). */
  location: string[] | null;
  /** Minimum years of experience, when stated. */
  minYears: number | null;
}

const COUNTRY_ALIASES: Record<string, string[]> = {
  'united states': ['usa', 'u.s.a.', 'u.s.', 'united states', 'united states of america', 'america', 'american'],
  'united kingdom': ['uk', 'u.k.', 'united kingdom', 'britain', 'great britain', 'england', 'british', 'scotland', 'wales'],
  'germany': ['germany', 'deutschland', 'german'],
  'india': ['india', 'indian'],
  'canada': ['canada', 'canadian'],
  'australia': ['australia', 'australian'],
  'france': ['france', 'french'],
  'netherlands': ['netherlands', 'holland', 'dutch'],
  'switzerland': ['switzerland', 'swiss'],
  'united arab emirates': ['uae', 'united arab emirates', 'dubai', 'abu dhabi', 'emirates'],
  'pakistan': ['pakistan', 'pakistani'],
  'singapore': ['singapore'],
  'spain': ['spain', 'spanish'],
  'italy': ['italy', 'italian'],
  'sweden': ['sweden', 'swedish'],
  'denmark': ['denmark', 'danish'],
  'norway': ['norway', 'norwegian'],
  'finland': ['finland', 'finnish'],
  'ireland': ['ireland', 'irish'],
  'israel': ['israel', 'israeli'],
  'brazil': ['brazil', 'brazilian'],
  'mexico': ['mexico', 'mexican'],
  'japan': ['japan', 'japanese'],
  'china': ['china', 'chinese'],
  'south africa': ['south africa', 'south african'],
  'nigeria': ['nigeria', 'nigerian'],
  'kenya': ['kenya', 'kenyan'],
  'poland': ['poland', 'polish'],
  'portugal': ['portugal', 'portuguese'],
  'austria': ['austria', 'austrian'],
  'belgium': ['belgium', 'belgian'],
  'turkey': ['turkey', 'türkiye', 'turkish'],
  'saudi arabia': ['saudi arabia', 'saudi', 'ksa'],
  'new zealand': ['new zealand'],
  'europe': ['europe', 'european', 'eu'],
};

const ALIAS_TO_CANON: Array<{ alias: string; canon: string }> = [];
for (const [canon, aliases] of Object.entries(COUNTRY_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_CANON.push({ alias, canon });
}
// Longest aliases first so "united states" wins over "states".
ALIAS_TO_CANON.sort((a, b) => b.alias.length - a.alias.length);
// Dot-free lookup for phrases captured after a preposition ("U.K." → "uk").
const ALIAS_NODOT = new Map(ALIAS_TO_CANON.map((x) => [x.alias.replace(/\./g, ''), x.canon]));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = (alias: string) => new RegExp(`(^|[^a-z0-9])${escapeRe(alias)}(?=$|[^a-z0-9])`, 'i');

/** Words that follow a location preposition but are not places. */
const NOT_PLACES = new Set(['the', 'a', 'an', 'my', 'our', 'their', 'this', 'that', 'need', 'order', 'general', 'particular', 'tech', 'software', 'business', 'sales', 'marketing', 'finance', 'healthcare', 'manufacturing', 'ai']);

/**
 * Canonical place terms mentioned in free text: country aliases (whole-word),
 * plus capitalised words after "in / based in / located in / from / within /
 * near" so cities work ("in London" → "london"). "US" is only a country when
 * written in capitals or after a location preposition — lowercase "us" is a
 * pronoun ("help us").
 */
export function locationTerms(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const { alias, canon } of ALIAS_TO_CANON) {
    if (wholeWord(alias).test(lower)) out.add(canon);
  }
  if (/\bU\.?S\.?\b/.test(text) || /\b(?:in|from|within|near|based in|located in)\s+(?:the\s+)?us\b/i.test(text)) {
    out.add('united states');
  }
  const prepRe = /\b(?:in|based in|located in|from|within|near)\s+(?:the\s+)?([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = prepRe.exec(text)) !== null) {
    // Compare without dots so "U.K." and "U.S." resolve to their country, not
    // to a phantom city called "u.k".
    const key = m[1].toLowerCase().replace(/\./g, '').trim();
    const first = key.split(' ')[0];
    if (!key || NOT_PLACES.has(first)) continue;
    if (key === 'us' || key === 'usa') { out.add('united states'); continue; }
    if (key.length < 3) continue;
    const canon = ALIAS_NODOT.get(key);
    out.add(canon ?? key); // known alias → country; anything else is a city/region
  }
  return [...out];
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

/** The largest "N years" / "N+ yrs" / "two decades" figure in a text, or null. */
export function parseYears(text: string | null | undefined): number | null {
  if (!text) return null;
  let max: number | null = null;
  const consider = (n: number) => { if (Number.isFinite(n) && n > 0 && n <= 60) max = max === null ? n : Math.max(max, n); };
  const re = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) consider(Number(m[1]));
  const wordRe = /\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty)\s+(?:years?|yrs?)\b/gi;
  while ((m = wordRe.exec(text)) !== null) consider(WORD_NUMBERS[m[1].toLowerCase()]);
  const decRe = /\b(a|one|two|three|four|five|\d)\s+decades?\b/gi;
  while ((m = decRe.exec(text)) !== null) {
    const w = m[1].toLowerCase();
    consider((w === 'a' ? 1 : (WORD_NUMBERS[w] ?? Number(w))) * 10);
  }
  return max;
}

/** What the want text explicitly requires: a place and/or a minimum experience. */
export function extractConstraints(wants: Array<string | null | undefined>): WantConstraints {
  const text = wants.filter(Boolean).join('. ');
  const location = locationTerms(text);
  return {
    location: location.length ? location : null,
    minYears: parseYears(text),
  };
}

export interface ProfileLike {
  location?: string | null;
  bio?: string | null;
  expertiseText?: string | null;
  whatICanHelpWith?: string | null;
  whatICareAbout?: string | null;
  jobTitle?: string | null;
  company?: string | null;
}

/** Canonical place terms for a profile, from its location field (+ company text). */
export function profileLocationTerms(p: ProfileLike): string[] {
  const out = new Set<string>(locationTerms(p.location));
  // A location field like "Austin, TX" carries no alias; keep its own words too
  // so a want for "in Austin" still matches.
  for (const w of (p.location || '').toLowerCase().split(/[^a-z]+/)) {
    if (w.length >= 3) out.add(w);
  }
  return [...out];
}

/** Years of experience a profile states anywhere in its text, or null. */
export function profileYears(p: ProfileLike): number | null {
  return parseYears([p.bio, p.expertiseText, p.whatICanHelpWith, p.whatICareAbout, p.jobTitle].filter(Boolean).join('. '));
}

export interface ConstraintCheck {
  /** null = no location required; false = required and NOT satisfied (unknown location counts as not). */
  locationOk: boolean | null;
  /** null = no minimum required OR the profile doesn't state years (unverifiable); false = stated and below. */
  yearsOk: boolean | null;
  /** true when a minimum is required but the profile states no years. */
  yearsUnknown: boolean;
}

export function checkConstraints(c: WantConstraints, p: ProfileLike): ConstraintCheck {
  let locationOk: boolean | null = null;
  if (c.location) {
    const have = new Set(profileLocationTerms(p));
    locationOk = c.location.some((req) => have.has(req) || (p.location || '').toLowerCase().includes(req));
  }
  let yearsOk: boolean | null = null;
  let yearsUnknown = false;
  if (c.minYears !== null) {
    const y = profileYears(p);
    if (y === null) yearsUnknown = true;
    else yearsOk = y >= c.minYears;
  }
  return { locationOk, yearsOk, yearsUnknown };
}
