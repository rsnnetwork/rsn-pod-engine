// ─── Option signals ──────────────────────────────────────────────────────────
//
// What each tick-box answer MEANS to matching (21 Sep 2026).
//
// The deck says the answers "write directly to a matching field", but the
// labels cannot be written anywhere the scorer reads them. It matches on words,
// and Shradha's wording does not survive that trip:
//   "Skills & services"              → every word a stop word, no signal at all
//   "Grow my professional network"   → same
//   "Find a co-founder or key talent"→ "talent" reads as someone who wants to
//                                      BE hired, the opposite of the intent
//   "Sales / marketing / growth leaders" → two different kinds of person
//   "Event organisers & community builders" → no bucket to land in
//
// So a key is never shown to the scorer as its label. It is translated here,
// once, into the words and buckets the existing matcher already understands.
// The guard tests pin every one of those translations.

import type {
  IntentKey, MeetKey, OfferKey, IndustryKey, MeetV2Key, FindV2Key, OfferV2Key, SelfV2Key,
} from '@rsn/shared';
import { ONBOARDING_V2_FIND, shortLabelFor } from '@rsn/shared';
import { designationsWanted, ROLE_TAXONOMY } from './intent-signals';

export interface MeetSignal {
  /** ROLE_TAXONOMY keys this asks for. */
  buckets: string[];
  /** The name of the standing search created for it. */
  agentLabel: string;
  /** Stored as the search's want text — words, not the label. */
  wantText: string;
  /** Singular forms, for the synonym expansion the scorer applies. */
  tags: string[];
  /** Written into professional_role when the member says this is what they ARE. */
  roleTitles: string[];
}

export const MEET_SIGNALS: Record<MeetKey, MeetSignal> = {
  founders: {
    buckets: ['founder'],
    agentLabel: 'Founders & entrepreneurs',
    wantText: 'founders and co-founders building companies',
    tags: ['founder', 'entrepreneur'],
    roleTitles: ['Founder'],
  },
  investors: {
    buckets: ['investor'],
    agentLabel: 'Investors & VCs',
    wantText: 'investors, angels and venture capital partners',
    tags: ['investor', 'angel'],
    roleTitles: ['Investor'],
  },
  sales_marketing_growth: {
    // One tick, two kinds of person: the search asks for both rather than
    // splitting into two searches the member never asked for.
    buckets: ['sales', 'marketer'],
    agentLabel: 'Sales & marketing leaders',
    wantText: 'sales leaders and marketing leaders driving growth',
    tags: ['sales', 'marketing'],
    roleTitles: ['Sales lead', 'Marketing lead'],
  },
  advisors_mentors: {
    buckets: ['advisor'],
    agentLabel: 'Advisors & mentors',
    wantText: 'advisors and mentors with experience to share',
    tags: ['advisor', 'mentor'],
    roleTitles: ['Advisor'],
  },
  developers_technical: {
    buckets: ['developer'],
    agentLabel: 'Developers & technical people',
    wantText: 'developers and engineers who build the product',
    tags: ['developer', 'engineer'],
    roleTitles: ['Developer'],
  },
  event_community: {
    // 'community' is a bucket this flow adds; see intent-signals.ts.
    buckets: ['community'],
    agentLabel: 'Event organisers & community builders',
    wantText: 'event organisers and community builders',
    tags: ['organiser', 'community'],
    roleTitles: ['Community builder'],
  },
};

export interface OfferSignal {
  /** Presentable on the public card AND carrying at least one real word. */
  offerText: string;
  /** What offering this makes you, when nothing else says who you are. */
  buckets: string[];
}

export const OFFER_SIGNALS: Record<OfferKey, OfferSignal> = {
  mentoring_advice: { offerText: 'mentoring and advice', buckets: ['advisor'] },
  investment: { offerText: 'investment', buckets: ['investor'] },
  introductions_network: { offerText: 'introductions to my network', buckets: [] },
  // "Skills & services" is two stop words. Name the thing instead.
  skills_services: { offerText: 'specialist services and expertise', buckets: [] },
  partnerships_collaboration: { offerText: 'partnerships and collaboration', buckets: ['partner'] },
  hiring_open_roles: { offerText: 'hiring for open roles', buckets: [] },
};

export interface IntentSignal {
  /** Which ticked kind this reason points at, so it leads the list. */
  primaryMeetKey?: MeetKey;
  /** What someone offering this would be to them. */
  complementOfferKeys: OfferKey[];
  /** Plain words for the member's own "why", or null when it says nothing. */
  reasonText: string | null;
}

export const INTENT_SIGNALS: Record<IntentKey, IntentSignal> = {
  // Says nothing about WHO: it must not become want text, or everyone matches.
  grow_network: { complementOfferKeys: ['introductions_network'], reasonText: null },
  find_customers_partners: {
    complementOfferKeys: ['partnerships_collaboration', 'introductions_network'],
    reasonText: 'to find customers and partners',
  },
  find_investors: {
    primaryMeetKey: 'investors',
    complementOfferKeys: ['investment'],
    reasonText: 'to find investors or funding',
  },
  find_cofounder_talent: {
    primaryMeetKey: 'founders',
    complementOfferKeys: ['skills_services', 'partnerships_collaboration'],
    // Never the word "talent": the scorer reads it as someone wanting to BE hired.
    reasonText: 'to find a co-founder or key people to build with',
  },
  get_advice: {
    primaryMeetKey: 'advisors_mentors',
    complementOfferKeys: ['mentoring_advice'],
    reasonText: 'to get advice from experienced people',
  },
  invited_exploring: { complementOfferKeys: [], reasonText: null },
};

export const INDUSTRY_TEXT: Record<IndustryKey, string> = {
  software_ai: 'software and AI',
  finance_investing: 'finance and investing',
  health_wellbeing: 'health and wellbeing',
  consumer_retail: 'consumer and retail',
  media_creative: 'media and creative',
  other: '',
};

/** The industry line shown on a card and read by the scorer, <= 100 chars. */
export function industrySummary(keys: IndustryKey[], other: string | null): string {
  const parts = keys.filter(k => k !== 'other').map(k => INDUSTRY_TEXT[k]).filter(Boolean);
  // "Other" is the member's own words, so it leads: it is the most specific
  // thing they told us, and for anyone outside the five fixed industries it is
  // the ONLY thing they told us.
  if (other?.trim()) parts.unshift(other.trim());
  return parts.join(', ').slice(0, 100);
}

/** What the member wants, as the text a standing search is built from. */
export function wantTextFor(key: MeetKey): string {
  return MEET_SIGNALS[key].wantText;
}

/** What the member offers, as one presentable line. */
export function offerSummary(keys: OfferKey[]): string {
  return keys.map(k => OFFER_SIGNALS[k].offerText).join(', ');
}

/** Who the member is, as titles the existing designation check understands. */
export function roleTitlesFor(keys: MeetKey[]): string[] {
  return [...new Set(keys.flatMap(k => MEET_SIGNALS[k].roleTitles))];
}

/** Every bucket the member's own answers say they belong to. */
export function selfBuckets(selfKinds: MeetKey[], offers: OfferKey[]): string[] {
  const fromSelf = selfKinds.flatMap(k => MEET_SIGNALS[k].buckets);
  // Offering investment makes you an investor to someone looking for one, even
  // if they never said so outright. Only used when nothing else identifies them.
  const fromOffers = offers.flatMap(k => OFFER_SIGNALS[k].buckets);
  return [...new Set([...fromSelf, ...fromOffers])];
}

// ─── Version 2 (Shradha's onboarding brief, 19 Oct 2026) ─────────────────────
//
// The brief's labels are whole sentences ("I would like to meet founders and
// business owners."), so a label still never reaches the scorer. Each key
// becomes want, intent, offer or role text here, checked against the scorer's
// stop list (intent-signals.ts) and pinned by option-signals-v2.test.ts:
//   - "products", "services", "join", "build" and "team" are stop words, so the
//     offers that use them name something else as well;
//   - "friends" and "conversations" are NOT stop words, and nearly everyone
//     ticks "new friends and good conversations", so those two answers add no
//     words at all: as want or offer text they would make everyone match;
//   - "such as" is avoided ("such" is not a stop word either).
// "In my own words" text is appended where its question's text goes, so the
// scorer reads a place or a number of years in it like any other want.

type MeetV2Fixed = Exclude<MeetV2Key, 'meet_other'>;
type FindV2Fixed = Exclude<FindV2Key, 'find_other'>;
type OfferV2Fixed = Exclude<OfferV2Key, 'offer_other'>;
type SelfV2Fixed = Exclude<SelfV2Key, 'self_other'>;

export interface MeetV2Signal {
  /** ROLE_TAXONOMY keys this asks for. */
  buckets: string[];
  /** The name of the standing search made for it (matching_agents.label, at most 80). */
  agentLabel: string;
  /** Stored as want text: words, not the label. */
  wantText: string;
  /** Singular forms, for the synonym expansion stored on the search. */
  tags: string[];
}

export const MEET_V2_SIGNALS: Record<MeetV2Fixed, MeetV2Signal> = {
  meet_founders_owners: {
    buckets: ['founder', 'owner'],
    agentLabel: 'Founders & business owners',
    wantText: 'founders, co-founders and business owners',
    tags: ['founder', 'business owner'],
  },
  meet_investors: {
    buckets: ['investor'],
    agentLabel: 'Investors',
    // Not "venture capital partners" (v1): "partners" also asks for the partner
    // bucket, which is any law-firm or agency partner.
    wantText: 'investors, angel investors and venture capital firms',
    tags: ['investor', 'angel'],
  },
  meet_advisors_experienced: {
    buckets: ['advisor'],
    agentLabel: 'Advisors & mentors',
    // "experience" and "share" are stop words; "experienced" is not, and would
    // match every bio that calls itself experienced.
    wantText: 'advisors and mentors with experience to share',
    tags: ['advisor', 'mentor'],
  },
  meet_specialists: {
    // "specialists" is the employee bucket, which is where a member who says
    // "I am a specialist" and types no title lands ("Specialist").
    buckets: ['employee', 'developer', 'designer', 'marketer'],
    agentLabel: 'Developers, designers & marketers',
    wantText: 'specialists: developers, engineers, designers and marketers',
    tags: ['specialist', 'developer', 'designer', 'marketing'],
  },
  meet_freelancers_consultants: {
    buckets: ['consultant'],
    agentLabel: 'Freelancers & consultants',
    wantText: 'freelancers and consultants',
    tags: ['freelancer', 'consultant'],
  },
  meet_students_early_career: {
    buckets: ['student'],
    agentLabel: 'Students & early career',
    // "early" and "career" are not stop words, and "early-stage" is in half
    // the bios on the network.
    wantText: 'students, interns and recent graduates',
    tags: ['student', 'graduate'],
  },
  // The 25 Oct review: people who are not founders.
  meet_managers_leaders: {
    buckets: ['manager', 'executive'],
    agentLabel: 'Managers & leaders',
    wantText: 'managers, directors and executives',
    tags: ['manager', 'director', 'executive'],
  },
  meet_hiring: {
    buckets: ['hr', 'manager'],
    agentLabel: 'People who are hiring',
    // Never "recruit", "hire" or "talent" on their own: as a want, those read
    // as a search for candidates, people who want to BE hired. "hiring
    // managers" names the manager, which the candidate want leaves out. The
    // tag is the same phrase: "recruiter" or "hr" would expand to "talent".
    wantText: 'recruiters and hiring managers',
    tags: ['hiring manager'],
  },
};

export interface FindV2Signal {
  /** Plain words for the member's "why", or null when it says nothing about anyone. */
  intentText: string | null;
}

export const FIND_V2_SIGNALS: Record<FindV2Fixed, FindV2Signal> = {
  find_customers: { intentText: 'to find customers and clients' },
  // Names investors, so raising funding is a search for investors.
  find_funding: { intentText: 'to raise funding and capital from investors' },
  // A co-founder, never "talent": that reads as someone who wants to BE hired.
  find_cofounder: { intentText: 'to find a co-founder for a startup' },
  find_friends_conversations: { intentText: null },
  // The 25 Oct review: goals that are not founder goals.
  // The people who hire: "hiring managers" never reads as a want for candidates.
  find_new_role: { intentText: 'to find a new role, meeting recruiters and hiring managers' },
  find_advice_learning: { intentText: 'to get advice from mentors and advisors' },
  // Candidates. Not "recruit", which also asks for HR people.
  find_hire: { intentText: 'to hire people and find candidates' },
  find_partners: { intentText: 'to find partners and collaborators' },
};

/** Presentable on the public card ("They can bring: …"), or null for no words at all. */
export const OFFER_V2_TEXT: Record<OfferV2Fixed, string | null> = {
  offer_products_services: 'products and services as a supplier or provider',
  offer_investment: 'investment and capital for promising ideas',
  offer_join_build_team: 'joining a startup or co-founding a team',
  offer_advice_mentoring: 'advice and mentoring as an advisor and mentor',
  offer_introductions: 'introductions to people in my network',
  offer_friends_conversations: null,
  // Named by their job title when it is known (offerTextV2). "experience",
  // "expertise" and "professional" are stop words; "profession" is not.
  offer_knowledge: 'knowledge from my profession',
  offer_referrals: 'job referrals and introductions to hiring managers',
};

/** Written into professional_role, the field "what B is" is read from. */
export const SELF_V2_TITLES: Record<SelfV2Fixed, string[]> = {
  // They said founder OR business owner: either kind of search should find them.
  self_founder_owner: ['Founder', 'Business owner'],
  // These three are replaced by the member's own job title when they typed
  // one (roleTitlesV2): it says more than the kind does.
  self_employee: ['Employee'],
  self_manager_leader: ['Manager'],
  self_investor: ['Investor'],
  self_advisor_experienced: ['Advisor'],
  self_specialist: ['Specialist'],
  self_freelancer_consultant: ['Consultant'],
  self_student_early_career: ['Student'],
};

/** The kinds a typed job title says better than the kind's own title does. */
const TITLE_SAYS_MORE = new Set<SelfV2Key>(['self_specialist', 'self_employee', 'self_manager_leader']);

const isFixedMeet = (k: MeetV2Key): k is MeetV2Fixed => k !== 'meet_other';
const isFixedFind = (k: FindV2Key): k is FindV2Fixed => k !== 'find_other';
const isFixedOffer = (k: OfferV2Key): k is OfferV2Fixed => k !== 'offer_other';
const isFixedSelf = (k: SelfV2Key): k is SelfV2Fixed => k !== 'self_other';
const words = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t.length ? t : null;
};

/** Who they want to meet, as want text: the ticked kinds, then their own words. */
export function wantTextV2(keys: MeetV2Key[], meetOther: string | null): string {
  const parts = keys.filter(isFixedMeet).map(k => MEET_V2_SIGNALS[k].wantText);
  const own = keys.includes('meet_other') ? words(meetOther) : null;
  if (own) parts.push(own);
  return parts.join('; ');
}

/** What they hope to find, as intent text, or null when it names nothing. */
export function intentTextV2(keys: FindV2Key[], findOther: string | null, findSpecific: string | null): string | null {
  const parts = keys
    .filter(isFixedFind)
    .map(k => FIND_V2_SIGNALS[k].intentText)
    .filter((t): t is string => !!t);
  const own = keys.includes('find_other') ? words(findOther) : null;
  if (own) parts.push(own);
  const specific = words(findSpecific);
  if (specific) parts.push(specific);
  return parts.length ? parts.join('; ') : null;
}

/**
 * What they can offer, as one line for the card and the scorer, or null when it names nothing. Sharing what
 * they know names their work when the profile holds a job title.
 */
export function offerTextV2(keys: OfferV2Key[], offerOther: string | null, jobTitle: string | null = null): string | null {
  const title = words(jobTitle);
  const parts = keys
    .filter(isFixedOffer)
    .map(k => (k === 'offer_knowledge' && title ? `knowledge from my work as ${title}` : OFFER_V2_TEXT[k]))
    .filter((t): t is string => !!t);
  const own = keys.includes('offer_other') ? words(offerOther) : null;
  if (own) parts.push(own);
  return parts.length ? parts.join('; ') : null;
}

/** Who they are, as titles the designation check reads. A typed job title wins over "Specialist", "Employee" and "Manager". */
export function roleTitlesV2(keys: SelfV2Key[], selfOther: string | null, jobTitle: string | null): string[] {
  const typed = words(jobTitle);
  const titles = keys.flatMap((k): string[] => {
    if (!isFixedSelf(k)) {
      const own = words(selfOther);
      return own ? [own] : [];
    }
    if (typed && TITLE_SAYS_MORE.has(k)) return [typed];
    return SELF_V2_TITLES[k];
  });
  const seen = new Set<string>();
  return titles.filter(t => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** reasons_to_connect: the live-event matcher compares these between two people. */
export function reasonsV2(keys: FindV2Key[]): string[] {
  return keys
    .filter(isFixedFind)
    .filter(k => FIND_V2_SIGNALS[k].intentText !== null)
    .map(k => shortLabelFor(ONBOARDING_V2_FIND, k));
}

/** The kinds of person their answers ask for, for the live-event matcher. */
export function desiredDesignationsV2(meet: MeetV2Key[], find: FindV2Key[]): string[] {
  const fromMeet = meet.filter(isFixedMeet).flatMap(k => MEET_V2_SIGNALS[k].buckets);
  const fromFind = find.filter(isFixedFind).flatMap(k => {
    const text = FIND_V2_SIGNALS[k].intentText;
    return text ? designationsWanted(text).map(d => d.key) : [];
  });
  return [...new Set([...fromMeet, ...fromFind])];
}

/**
 * Q4's likely answers, read from a role through ROLE_TAXONOMY, for the member
 * to confirm or change (brief, screen 6). Only buckets that clearly say one
 * answer have one: a manufacturer, a community builder, a candidate, a
 * customer or a partner could be any of them, so they get none.
 */
const SELF_GUESS_BY_BUCKET: Partial<Record<string, SelfV2Key>> = {
  founder: 'self_founder_owner',
  owner: 'self_founder_owner',
  // On this network a CEO title is nearly always someone running their own company.
  ceo: 'self_founder_owner',
  investor: 'self_investor',
  advisor: 'self_advisor_experienced',
  board: 'self_advisor_experienced',
  // 25 Oct review: a manager or an executive leads, and is never filed as an
  // advisor; the rest of a company's people work for it.
  executive: 'self_manager_leader',
  manager: 'self_manager_leader',
  employee: 'self_employee',
  product_manager: 'self_employee',
  hr: 'self_employee',
  sales: 'self_employee',
  developer: 'self_specialist',
  designer: 'self_specialist',
  marketer: 'self_specialist',
  consultant: 'self_freelancer_consultant',
  student: 'self_student_early_career',
};

/** Between two titles: "Founder & CEO | Angel investor", "Owner, Bakery Schmidt", "Founder – helping …". */
const BETWEEN_TITLES = /\s*[|·•,;/]\s*|\s+[-–—]\s+/;
/** Where a title ends and its company, or the people it serves, begin: "Investor at Northwind", "Advisor to founders". */
const AFTER_THE_TITLE = /\s(?:at|@|for|to|with)\s[\s\S]*$/;
/** Two titles in one: "Founder & CEO", "Mentor and board advisor". */
const AND = /\s+(?:&|and)\s+/;
/** A headline that opens with what someone does ("Helping founders raise capital") says nothing about who they are. */
const OPENS_WITH_A_DOING_WORD = /^([a-z]{2,}ing)\b/;
/** Words in -ing that open job titles ("Marketing Lead", "Managing Director"): those are titles, not doing. */
const TITLE_WORDS_IN_ING = new Set([
  'accounting', 'acting', 'advertising', 'banking', 'consulting', 'engineering', 'founding', 'fundraising',
  'learning', 'managing', 'manufacturing', 'marketing', 'merchandising', 'nursing', 'operating', 'planning',
  'programming', 'publishing', 'purchasing', 'recruiting', 'sourcing', 'teaching', 'training', 'visiting',
]);

const saysWhatTheyDo = (phrase: string): boolean => {
  const opening = OPENS_WITH_A_DOING_WORD.exec(phrase);
  return !!opening && !TITLE_WORDS_IN_ING.has(opening[1]);
};

/**
 * The titles in which the executive kind leads: a C-level title (a chief anything, a CTO, the c-suite) or a
 * leadership compound. On its own, "executive" names a level of a function, not a leader: a sales, HR,
 * marketing or business development executive, or an executive assistant, does the work of that function
 * (task review, 26 Oct 2026).
 */
const EXECUTIVE_WHO_LEADS = new RegExp([
  'chief', 'c[-\\s]?suite',
  'ceo', 'cto', 'cfo', 'coo', 'cmo', 'cpo', 'cio', 'cso', 'cco', 'cdo', 'cro', 'ciso',
  'executive (?:director|vice president|chair(?:man|woman|person)?)', 'evp', 'svp',
  'vice president', 'vp', 'chair(?:man|woman|person)', 'managing director', 'head of',
].map(t => `\\b${t}\\b`).join('|'));

/**
 * Every answer one title names, the most specific kind first. A match that is
 * only part of a longer one is no second answer: the "manager" of "product
 * manager" says nothing more. The executive kind is the exception both ways:
 * it leads only in a title EXECUTIVE_WHO_LEADS names, so "Sales Executive" is
 * no leader, and "Chief Executive Officer" is one although its "chief" sits
 * inside the CEO title.
 */
function guessesIn(title: string): SelfV2Key[] {
  const hits = ROLE_TAXONOMY.flatMap((bucket) => {
    const m = bucket.is.exec(title);
    return m ? [{ key: bucket.key, start: m.index, end: m.index + m[0].length }] : [];
  });
  const insideALongerOne = (h: typeof hits[number]) => hits.some(o =>
    o.start <= h.start && h.end <= o.end && o.end - o.start > h.end - h.start);
  const counts = (h: typeof hits[number]) =>
    (h.key === 'executive' ? EXECUTIVE_WHO_LEADS.test(title) : !insideALongerOne(h));
  return hits
    .filter(counts)
    .map(h => SELF_GUESS_BY_BUCKET[h.key])
    .filter((k): k is SelfV2Key => !!k);
}

/**
 * Q4's likely answers from what LinkedIn says (25 Oct review): every answer
 * the role names, in the order it names them, each once. The headline is read
 * only when there is no role, and a headline phrase that says what they do for
 * others ("Helping founders raise capital") is skipped, or it would suggest
 * the very people they help. A company, or the people a title serves ("at
 * Northwind", "to founders"), is never read as their role.
 */
export function selfGuessesFromText(role: string | null | undefined, headline: string | null | undefined): SelfV2Key[] {
  const stated = words(role);
  const text = stated ?? words(headline);
  if (!text) return [];
  const out: SelfV2Key[] = [];
  for (const piece of text.toLowerCase().split(BETWEEN_TITLES)) {
    const segment = piece.trim();
    if (!segment || (!stated && saysWhatTheyDo(segment))) continue;
    for (const title of segment.replace(AFTER_THE_TITLE, '').split(AND)) {
      for (const key of guessesIn(title.trim())) if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}
