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

import type { OnboardingOption, TourOutcome } from './options';
import type { OnboardingStatus } from '../types/onboarding';

const OWN_WORDS = "Something else. I'd like to say it in my own words.";

/** Screen 3, "1 of 4": "Who would you like to meet?" (up to three) */
export const ONBOARDING_V2_MEET = [
  { key: 'meet_founders_owners', label: 'I would like to meet founders and business owners.', shortLabel: 'Founders and business owners' },
  { key: 'meet_investors', label: 'I would like to meet investors.', shortLabel: 'Investors' },
  { key: 'meet_advisors_experienced', label: 'I would like to meet advisors, mentors and experienced professionals.', shortLabel: 'Advisors and mentors' },
  { key: 'meet_specialists', label: 'I would like to meet specialists, such as developers, designers or marketers.', shortLabel: 'Specialists' },
  { key: 'meet_freelancers_consultants', label: 'I would like to meet freelancers and consultants.', shortLabel: 'Freelancers and consultants' },
  { key: 'meet_students_early_career', label: 'I would like to meet students and people early in their career.', shortLabel: 'Students and early career' },
  { key: 'meet_other', label: OWN_WORDS, shortLabel: 'Something else' },
] as const satisfies readonly OnboardingOption[];

/** Screen 4, "2 of 4": "What are you hoping to find?" (up to three) */
export const ONBOARDING_V2_FIND = [
  { key: 'find_customers', label: 'I am looking for customers or clients.', shortLabel: 'Customers or clients' },
  { key: 'find_funding', label: 'I am looking to raise funding.', shortLabel: 'Raising funding' },
  { key: 'find_cofounder', label: 'I am looking for a cofounder', shortLabel: 'A cofounder' },
  { key: 'find_friends_conversations', label: 'I would like to make new friends and have good conversations.', shortLabel: 'New friends and good conversations' },
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
  { key: 'offer_other', label: OWN_WORDS, shortLabel: 'Something else' },
] as const satisfies readonly OnboardingOption[];

/** Screen 6, "4 of 4": "How would you describe yourself?" (up to two) */
export const ONBOARDING_V2_SELF = [
  { key: 'self_founder_owner', label: 'I am a founder or business owner.', shortLabel: 'Founder or business owner' },
  { key: 'self_investor', label: 'I am an investor.', shortLabel: 'Investor' },
  { key: 'self_advisor_experienced', label: 'I am an advisor, mentor or experienced professional.', shortLabel: 'Advisor or mentor' },
  { key: 'self_specialist', label: 'I am a specialist, such as a developer, designer or marketer.', shortLabel: 'Specialist' },
  { key: 'self_freelancer_consultant', label: 'I am a freelancer or consultant.', shortLabel: 'Freelancer or consultant' },
  { key: 'self_student_early_career', label: 'I am a student or early in my career.', shortLabel: 'Student or early career' },
  { key: 'self_other', label: OWN_WORDS, shortLabel: 'Something else' },
] as const satisfies readonly OnboardingOption[];

/** The question titles and helper lines, verbatim from the brief. */
export const ONBOARDING_V2_COPY = {
  meet: { title: 'Who would you like to meet?', hint: 'Select up to three answers.' },
  find: { title: 'What are you hoping to find?', hint: 'Select up to three answers.' },
  findSpecific: {
    label: "Is there anything specific you're looking for? (optional)",
    example: 'For example: "I\'m looking for someone who has helped small businesses expand internationally."',
  },
  offer: { title: 'What can you offer others?', hint: 'Select all that apply.' },
  self: { title: 'How would you describe yourself?', hint: 'Select up to two answers.' },
} as const;

/** The "in my own words" option of each question: choosing it requires its text. */
export const ONBOARDING_V2_OTHER_KEYS = {
  meet: 'meet_other',
  find: 'find_other',
  offer: 'offer_other',
  self: 'self_other',
} as const;

export const ONBOARDING_V2_LIMITS = {
  meetMin: 1,
  meetMax: 3,
  findMin: 1,
  findMax: 3,
  offerMin: 1,
  selfMin: 1,
  selfMax: 2,
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
  /** Q4's most likely answer, read from the LinkedIn role; null when the role says nothing clear. */
  selfGuess: SelfV2Key | null;
}

export interface OnboardingV2Linkedin {
  status: OnboardingV2LinkedinStatus;
  /** Present only when status is 'found' or 'partial'. */
  prefill?: OnboardingV2LinkedinPrefill;
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
  linkedin: OnboardingV2Linkedin;
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
