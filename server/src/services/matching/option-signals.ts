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

import type { IntentKey, MeetKey, OfferKey, IndustryKey } from '@rsn/shared';

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
