// ─── Onboarding, version 2: the brief's four questions ──────────────────────
//
// Shradha's onboarding brief, 19 Oct 2026 (eight screens). The labels below are
// HER wording, in her order, word for word, punctuation included: "I am looking
// for a cofounder" has no full stop in the brief, so it has none here.
//
// Version 1 (options.ts) stays exactly as it is: the live app asks those five
// questions until go-live. Version 2 keys are new strings that never collide
// with a version 1 key, so both can sit in the same database columns
// (looking_to_meet, can_offer, self_kinds) and every reader can tell which
// version an answer came from.
//
// A key is the identity of an option: stored, matched on, never reworded. A
// label is what a person reads. Each question ends with "Something else. I'd
// like to say it in my own words.", which opens a text box: the member's own
// words, up to 120 characters, required when that option is chosen.
//
// The 25 Oct review (Stefan and Claus) changed the brief in three ways. Every
// question is "Select all that apply.": a founder can invest, and a student
// can freelance. Each list gained answers for people who are not founders,
// placed before "Something else" (and on Q4 second and third, where an
// employee looks first). And the advisor answer no longer says "experienced
// professional", so an experienced employee is not filed as an advisor; its
// key stays, so nothing stored changes.

import type { OnboardingOption, TourOutcome } from './options';
import type { OnboardingStatus } from '../types/onboarding';

const OWN_WORDS = "Something else. I'd like to say it in my own words.";

/** Screen 3, "1 of 4": "Who would you like to meet?" (all that apply) */
export const ONBOARDING_V2_MEET = [
  { key: 'meet_founders_owners', label: 'I would like to meet founders and business owners.', shortLabel: 'Founders and business owners' },
  { key: 'meet_investors', label: 'I would like to meet investors.', shortLabel: 'Investors' },
  { key: 'meet_advisors_experienced', label: 'I would like to meet advisors, mentors and experienced professionals.', shortLabel: 'Advisors and mentors' },
  { key: 'meet_specialists', label: 'I would like to meet specialists, such as developers, designers or marketers.', shortLabel: 'Specialists' },
  { key: 'meet_freelancers_consultants', label: 'I would like to meet freelancers and consultants.', shortLabel: 'Freelancers and consultants' },
  { key: 'meet_students_early_career', label: 'I would like to meet students and people early in their career.', shortLabel: 'Students and early career' },
  { key: 'meet_managers_leaders', label: 'I would like to meet managers and leaders in companies and organisations.', shortLabel: 'Managers and leaders' },
  { key: 'meet_hiring', label: 'I would like to meet people who are hiring.', shortLabel: 'People who are hiring' },
  { key: 'meet_other', label: OWN_WORDS, shortLabel: 'Something else' },
] as const satisfies readonly OnboardingOption[];

/** Screen 4, "2 of 4": "What are you hoping to find?" (all that apply) */
export const ONBOARDING_V2_FIND = [
  { key: 'find_customers', label: 'I am looking for customers or clients.', shortLabel: 'Customers or clients' },
  { key: 'find_funding', label: 'I am looking to raise funding.', shortLabel: 'Raising funding' },
  { key: 'find_cofounder', label: 'I am looking for a cofounder', shortLabel: 'A cofounder' },
  { key: 'find_friends_conversations', label: 'I would like to make new friends and have good conversations.', shortLabel: 'New friends and good conversations' },
  { key: 'find_new_role', label: 'I am looking for a new job or my next career step.', shortLabel: 'A new job or career step' },
  { key: 'find_advice_learning', label: 'I am looking for advice, mentoring or to learn from others.', shortLabel: 'Advice, mentoring or learning' },
  { key: 'find_hire', label: 'I am looking for people to hire.', shortLabel: 'People to hire' },
  { key: 'find_partners', label: 'I am looking for partners or collaborators.', shortLabel: 'Partners or collaborators' },
  { key: 'find_other', label: OWN_WORDS, shortLabel: 'Something else' },
] as const satisfies readonly OnboardingOption[];

/** Screen 5, "3 of 4": "What can you offer others?" (all that apply) */
export const ONBOARDING_V2_OFFER = [
  { key: 'offer_products_services', label: 'I can offer my products or services.', shortLabel: 'Products or services' },
  { key: 'offer_investment', label: 'I can invest in promising ideas.', shortLabel: 'Investment' },
  { key: 'offer_join_build_team', label: 'I am open to joining or building a team.', shortLabel: 'Joining or building a team' },
  { key: 'offer_advice_mentoring', label: 'I can give advice and mentoring.', shortLabel: 'Advice and mentoring' },
  { key: 'offer_introductions', label: 'I can introduce people to others in my network.', shortLabel: 'Introductions' },
  { key: 'offer_friends_conversations', label: 'I am happy to make new friends and have good conversations.', shortLabel: 'New friends and good conversations' },
  { key: 'offer_knowledge', label: 'I can share what I know from my work.', shortLabel: 'Knowledge from my work' },
  { key: 'offer_referrals', label: 'I can help people find jobs or refer them where I work.', shortLabel: 'Job referrals' },
  { key: 'offer_other', label: OWN_WORDS, shortLabel: 'Something else' },
] as const satisfies readonly OnboardingOption[];

/** Screen 6, "4 of 4": "How would you describe yourself?" (all that apply) */
export const ONBOARDING_V2_SELF = [
  { key: 'self_founder_owner', label: 'I am a founder or business owner.', shortLabel: 'Founder or business owner' },
  { key: 'self_employee', label: 'I work for a company or organisation.', shortLabel: 'Employee' },
  { key: 'self_manager_leader', label: 'I lead a team or part of an organisation.', shortLabel: 'Manager or leader' },
  { key: 'self_investor', label: 'I am an investor.', shortLabel: 'Investor' },
  { key: 'self_advisor_experienced', label: 'I am an advisor or mentor.', shortLabel: 'Advisor or mentor' },
  { key: 'self_specialist', label: 'I am a specialist, such as a developer, designer or marketer.', shortLabel: 'Specialist' },
  { key: 'self_freelancer_consultant', label: 'I am a freelancer or consultant.', shortLabel: 'Freelancer or consultant' },
  { key: 'self_student_early_career', label: 'I am a student or early in my career.', shortLabel: 'Student or early career' },
  { key: 'self_other', label: OWN_WORDS, shortLabel: 'Something else' },
] as const satisfies readonly OnboardingOption[];

/** The question titles and helper lines, verbatim from the brief as the 25 Oct review changed it. */
export const ONBOARDING_V2_COPY = {
  meet: { title: 'Who would you like to meet?', hint: 'Select all that apply.' },
  find: { title: 'What are you hoping to find?', hint: 'Select all that apply.' },
  findSpecific: {
    label: "Is there anything specific you're looking for? (optional)",
    example: 'For example: "I\'m looking for someone who has helped small businesses expand internationally."',
  },
  offer: { title: 'What can you offer others?', hint: 'Select all that apply.' },
  self: { title: 'How would you describe yourself?', hint: 'Select all that apply.' },
} as const;

/** The "in my own words" option of each question: choosing it requires its text. */
export const ONBOARDING_V2_OTHER_KEYS = {
  meet: 'meet_other',
  find: 'find_other',
  offer: 'offer_other',
  self: 'self_other',
} as const;

/**
 * The most keys one answer list may hold: a guard against a runaway request, never a limit a member meets,
 * since no question has this many answers. The server's Zod and the database (migration 109) hold each list
 * to it.
 */
const ANSWERS_CEILING = 20;

export const ONBOARDING_V2_LIMITS = {
  meetMin: 1,
  findMin: 1,
  offerMin: 1,
  selfMin: 1,
  ceiling: ANSWERS_CEILING,
  // No question has a maximum any more (25 Oct). The preview's screens still read these three until they
  // drop their limit lines, so each is the ceiling, which no member reaches.
  meetMax: ANSWERS_CEILING,
  findMax: ANSWERS_CEILING,
  selfMax: ANSWERS_CEILING,
  /** Each "Something else" text box. */
  otherMaxLen: 120,
  /** "Is there anything specific you're looking for?" */
  findSpecificMaxLen: 300,
  displayNameMaxLen: 100,
  jobTitleMaxLen: 120,
  companyMaxLen: 120,
  industryMaxLen: 100,
  timezoneMaxLen: 50,
  linkedinUrlMaxLen: 500,
} as const;

/** The brief's screens 1 to 7 (screen 8 is For You, outside the flow). */
export const ONBOARDING_V2_STEPS = ['welcome', 'signup', 'q1', 'q2', 'q3', 'q4', 'profile'] as const;

export type MeetV2Key = typeof ONBOARDING_V2_MEET[number]['key'];
export type FindV2Key = typeof ONBOARDING_V2_FIND[number]['key'];
export type OfferV2Key = typeof ONBOARDING_V2_OFFER[number]['key'];
export type SelfV2Key = typeof ONBOARDING_V2_SELF[number]['key'];
export type OnboardingV2Step = typeof ONBOARDING_V2_STEPS[number];

/** Everything the four questions collect. Free text is null unless its option is chosen. */
export interface OnboardingV2Answers {
  lookingToMeet: MeetV2Key[];
  meetOther: string | null;
  hopingToFind: FindV2Key[];
  findOther: string | null;
  /** "Is there anything specific you're looking for?" (optional, any answer to Q2). */
  findSpecific: string | null;
  canOffer: OfferV2Key[];
  offerOther: string | null;
  selfKinds: SelfV2Key[];
  selfOther: string | null;
}

/** Screen 7, "Here's how others will see you": what the profile holds now. */
export interface OnboardingV2Profile {
  displayName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  industry: string | null;
  /** IANA zone, for example "Asia/Kathmandu". Only the member sees it. */
  timezone: string | null;
  linkedinUrl: string | null;
}

export type OnboardingV2LinkedinStatus = 'none' | 'searching' | 'found' | 'partial' | 'not_found' | 'failed';

/** What the member's own LinkedIn page said, for them to keep or change. Never saved until they confirm. */
export interface OnboardingV2LinkedinPrefill {
  displayName: string | null;
  photoUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  industry: string | null;
  location: string | null;
  /**
   * Every Q4 answer the member's own stated role supports (the headline when there is no role), in the order
   * it names them; empty when it says nothing clear. A role LinkedIn only inferred from the rest of the page
   * suggests nothing (25 Oct review).
   */
  selfGuesses: SelfV2Key[];
  /** The first of selfGuesses, or null: what a screen that preselects one answer reads. */
  selfGuess: SelfV2Key | null;
}

export interface OnboardingV2Linkedin {
  status: OnboardingV2LinkedinStatus;
  /** Present only when status is 'found' or 'partial'. */
  prefill?: OnboardingV2LinkedinPrefill;
}

/** Screen 2: "Continue with LinkedIn" or "Continue with email". */
export type OnboardingV2SignupChoice = 'linkedin' | 'email';

/** The state's linkedin block: the lookup, and how the member chose on screen 2. */
export interface OnboardingV2StateLinkedin extends OnboardingV2Linkedin {
  /** Whichever they pressed last, in any tab or on any device; null before either. */
  chosen: OnboardingV2SignupChoice | null;
}

/** GET /api/onboarding/v2/state */
export interface OnboardingV2State {
  status: OnboardingStatus;
  /** 2 once version 2 was confirmed; null before. */
  version: number | null;
  step: OnboardingV2Step;
  answers: OnboardingV2Answers;
  /** True when at least one question was filled from the member's version 1 answers. */
  prefilledFromV1: boolean;
  profile: OnboardingV2Profile;
  linkedin: OnboardingV2StateLinkedin;
  tour: { pending: boolean; seenAt: string | null; outcome: TourOutcome | null };
}

/**
 * The profile half of POST /api/onboarding/v2/confirm. A field left out, or sent as null, keeps what is
 * stored. jobTitle, company and industry sent as "" (empty once trimmed) are cleared: send "" only when the
 * member emptied a field that had a value. displayName can never be cleared: a blank name keeps the stored one.
 */
export interface OnboardingV2ProfileInput {
  displayName?: string | null;
  jobTitle?: string | null;
  company?: string | null;
  industry?: string | null;
  timezone?: string | null;
  /** "Keep this photo": make the photo from their LinkedIn page their own. */
  useLinkedinPhoto?: boolean;
}

/** POST /api/onboarding/v2/confirm */
export interface OnboardingV2ConfirmRequest extends OnboardingV2Answers {
  profile?: OnboardingV2ProfileInput;
}

export type OnboardingV2SearchChange = 'created' | 'resumed' | 'updated' | 'paused';

export interface OnboardingV2ConfirmResponse {
  /** False when the same answers were confirmed again. */
  changed: boolean;
  /** The searches this confirm created, resumed, reworded or paused. */
  agents: Array<{ id: string; label: string; status: 'active' | 'paused' | 'archived'; change: OnboardingV2SearchChange }>;
  /** The first search now running because of this confirm, or null. */
  primaryAgentId: string | null;
  /** The LinkedIn photo, when it was asked for: 'used', 'none' (nothing to use) or 'failed'. */
  photo: 'used' | 'none' | 'failed' | null;
}

/** POST /api/onboarding/v2/linkedin: the linkedin block, plus the address as it was saved. */
export interface OnboardingV2LinkedinResponse extends OnboardingV2Linkedin {
  linkedinUrl: string;
}
