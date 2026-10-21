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
import { designationsWanted, normalizeDesignation } from './intent-signals';

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
};

/** Presentable on the public card ("They can bring: …"), or null for no words at all. */
export const OFFER_V2_TEXT: Record<OfferV2Fixed, string | null> = {
  offer_products_services: 'products and services as a supplier or provider',
  offer_investment: 'investment and capital for promising ideas',
  offer_join_build_team: 'joining a startup or co-founding a team',
  offer_advice_mentoring: 'advice and mentoring as an advisor and mentor',
  offer_introductions: 'introductions to people in my network',
  offer_friends_conversations: null,
};

/** Written into professional_role, the field "what B is" is read from. */
export const SELF_V2_TITLES: Record<SelfV2Fixed, string[]> = {
  // They said founder OR business owner: either kind of search should find them.
  self_founder_owner: ['Founder', 'Business owner'],
  self_investor: ['Investor'],
  self_advisor_experienced: ['Advisor'],
  // Replaced by the member's own job title when they typed one (roleTitlesV2).
  self_specialist: ['Specialist'],
  self_freelancer_consultant: ['Consultant'],
  self_student_early_career: ['Student'],
};

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

/** What they can offer, as one line for the card and the scorer, or null when it names nothing. */
export function offerTextV2(keys: OfferV2Key[], offerOther: string | null): string | null {
  const parts = keys
    .filter(isFixedOffer)
    .map(k => OFFER_V2_TEXT[k])
    .filter((t): t is string => !!t);
  const own = keys.includes('offer_other') ? words(offerOther) : null;
  if (own) parts.push(own);
  return parts.length ? parts.join('; ') : null;
}

/** Who they are, as titles the designation check reads. A typed job title wins over "Specialist". */
export function roleTitlesV2(keys: SelfV2Key[], selfOther: string | null, jobTitle: string | null): string[] {
  const typed = words(jobTitle);
  const titles = keys.flatMap((k): string[] => {
    if (!isFixedSelf(k)) {
      const own = words(selfOther);
      return own ? [own] : [];
    }
    if (k === 'self_specialist' && typed) return [typed];
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
 * Q4's most likely answer, read from a role through ROLE_TAXONOMY, for the
 * member to confirm or change (brief, screen 6). Only buckets that clearly say
 * one answer have one: a manufacturer, a community builder, a candidate, a
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
  executive: 'self_advisor_experienced',
  manager: 'self_advisor_experienced',
  developer: 'self_specialist',
  designer: 'self_specialist',
  marketer: 'self_specialist',
  sales: 'self_specialist',
  hr: 'self_specialist',
  product_manager: 'self_specialist',
  employee: 'self_specialist',
  consultant: 'self_freelancer_consultant',
  student: 'self_student_early_career',
};

export function selfGuessFromRole(role: string | null | undefined): SelfV2Key | null {
  const bucket = normalizeDesignation(role);
  return bucket ? SELF_GUESS_BY_BUCKET[bucket] ?? null : null;
}
