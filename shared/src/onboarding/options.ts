// ─── Onboarding option catalogue ─────────────────────────────────────────────
//
// Shradha's deck, 21 Sep 2026: the open-ended chat is replaced by tick boxes,
// because "open-ended questions yield unusable data for matching". The lists
// below are HER wording, in her order, verbatim.
//
// A key is the identity of an option and never changes or gets reused: it is
// what lands in the database and what matching compares. A label is only what
// a person reads, and may be reworded freely. Client and server both build
// from this one file, so what is shown can never drift from what is validated.

export interface OnboardingOption<K extends string = string> {
  /** Stored, matched on, never reworded. */
  readonly key: K;
  /** Shown on the question. Shradha's wording. */
  readonly label: string;
  /** Shown back on the confirm screen and on cards, where space is tight. */
  readonly shortLabel: string;
}

/** Q1 — "What brings you to RSN?" (one answer) */
export const ONBOARDING_INTENTS = [
  { key: 'grow_network', label: 'Grow my professional network', shortLabel: 'Grow my network' },
  { key: 'find_customers_partners', label: 'Find customers or partners', shortLabel: 'Customers or partners' },
  { key: 'find_investors', label: 'Find investors or funding', shortLabel: 'Investors or funding' },
  { key: 'find_cofounder_talent', label: 'Find a co-founder or key talent', shortLabel: 'Co-founder or talent' },
  { key: 'get_advice', label: 'Get advice from experienced people', shortLabel: 'Advice' },
  { key: 'invited_exploring', label: 'I was invited - just exploring', shortLabel: 'Just exploring' },
] as const satisfies readonly OnboardingOption[];

/** Q2 — "Who do you want to meet?" (up to three) */
export const ONBOARDING_MEET = [
  { key: 'founders', label: 'Founders & entrepreneurs', shortLabel: 'Founders' },
  { key: 'investors', label: 'Investors & VCs', shortLabel: 'Investors & VCs' },
  { key: 'sales_marketing_growth', label: 'Sales / marketing / growth leaders', shortLabel: 'Growth leaders' },
  { key: 'advisors_mentors', label: 'Advisors & mentors', shortLabel: 'Advisors & mentors' },
  { key: 'developers_technical', label: 'Developers & technical people', shortLabel: 'Technical people' },
  { key: 'event_community', label: 'Event organisers & community builders', shortLabel: 'Community builders' },
] as const satisfies readonly OnboardingOption[];

/** Q3 — "What can you offer?" (any number) */
export const ONBOARDING_OFFERS = [
  { key: 'mentoring_advice', label: 'Mentoring & advice', shortLabel: 'Mentoring' },
  { key: 'investment', label: 'Investment', shortLabel: 'Investment' },
  { key: 'introductions_network', label: 'Introductions & my network', shortLabel: 'Introductions' },
  { key: 'skills_services', label: 'Skills & services', shortLabel: 'Skills & services' },
  { key: 'partnerships_collaboration', label: 'Partnerships & collaboration', shortLabel: 'Partnerships' },
  { key: 'hiring_open_roles', label: 'Hiring - I have open roles', shortLabel: 'Hiring' },
] as const satisfies readonly OnboardingOption[];

/** Q4 — "Which industries are you in?" (any number; 'other' opens a text box) */
export const ONBOARDING_INDUSTRIES = [
  { key: 'software_ai', label: 'Software & AI', shortLabel: 'Software & AI' },
  { key: 'finance_investing', label: 'Finance & investing', shortLabel: 'Finance' },
  { key: 'health_wellbeing', label: 'Health & wellbeing', shortLabel: 'Health' },
  { key: 'consumer_retail', label: 'Consumer & retail', shortLabel: 'Consumer & retail' },
  { key: 'media_creative', label: 'Media & creative', shortLabel: 'Media & creative' },
  { key: 'other', label: 'Other', shortLabel: 'Other' },
] as const satisfies readonly OnboardingOption[];

/**
 * Q5 — "Which best describes you?" (up to two)
 *
 * Not in the deck, and the single biggest hole in it: the five steps never ask
 * who the member IS, yet slide 9 calls ROLE "a core matching field" that
 * "can't ship blank". Matching compares what you want against what the other
 * person IS, so without this a member who only ticked boxes is invisible to
 * everyone and their card is a bare name. Same six kinds as Q2, so wanting and
 * being are two sides of one vocabulary.
 */
export const ONBOARDING_SELF_KINDS = ONBOARDING_MEET;

export const ONBOARDING_LIMITS = {
  meetMin: 1,
  meetMax: 3,
  offersMin: 1,
  industriesMin: 1,
  selfMin: 1,
  selfMax: 2,
  otherMaxLen: 60,
  aboutMaxLen: 160,
  roleMaxLen: 120,
  companyMaxLen: 120,
} as const;

export type IntentKey = typeof ONBOARDING_INTENTS[number]['key'];
export type MeetKey = typeof ONBOARDING_MEET[number]['key'];
export type OfferKey = typeof ONBOARDING_OFFERS[number]['key'];
export type IndustryKey = typeof ONBOARDING_INDUSTRIES[number]['key'];

/** Everything the five steps collect. */
export interface OnboardingAnswers {
  intent: IntentKey;
  lookingToMeet: MeetKey[];
  canOffer: OfferKey[];
  industries: IndustryKey[];
  /** Only when 'other' is among the industries. */
  industryOther: string | null;
  selfKinds: MeetKey[];
  jobTitle: string | null;
  company: string | null;
  about: string | null;
}

export type OnboardingStep = 'welcome' | 'q1' | 'q2' | 'q3' | 'q4' | 'q5' | 'confirm';
export const ONBOARDING_STEPS: readonly OnboardingStep[] =
  ['welcome', 'q1', 'q2', 'q3', 'q4', 'q5', 'confirm'] as const;

export type TourOutcome = 'completed' | 'skipped';

/** What the client needs to draw the flow, and nothing it did not provide. */
export interface OnboardingState {
  status: 'not_started' | 'in_progress' | 'update_required' | 'completed';
  answers: Partial<OnboardingAnswers>;
  step: OnboardingStep;
  displayName: string | null;
  avatarUrl: string | null;
  tour: { pending: boolean; seenAt: string | null; outcome: TourOutcome | null };
}

/** The label for a stored key, for display only. */
export function labelFor(list: readonly OnboardingOption[], key: string): string {
  return list.find(o => o.key === key)?.label ?? key;
}

export function shortLabelFor(list: readonly OnboardingOption[], key: string): string {
  return list.find(o => o.key === key)?.shortLabel ?? key;
}
