// ─── Version 1 answers, read as version 2 ────────────────────────────────────
//
// Onboarding v2 (Shradha's brief, 19 Oct 2026) opens with what a member already
// said in the v1 tick boxes, wherever v2 has the same meaning. Where it has
// none, the answer is left for them to give: a guess is never shown as their
// answer. The same table tells the searches step which v1 search stands for
// which v2 kind, so moving to v2 with the same answers makes no duplicates.
//
// v1 and v2 keys are different strings and share the looking_to_meet,
// can_offer and self_kinds columns, so the key sets below are also how any
// reader tells the two versions apart.

import {
  ONBOARDING_MEET, ONBOARDING_OFFERS, ONBOARDING_INTENTS,
  ONBOARDING_V2_MEET, ONBOARDING_V2_FIND, ONBOARDING_V2_OFFER, ONBOARDING_V2_SELF,
} from '@rsn/shared';
import type {
  IntentKey, MeetKey, OfferKey, MeetV2Key, FindV2Key, OfferV2Key, SelfV2Key, OnboardingV2Answers,
} from '@rsn/shared';

export const MEET_V1_TO_V2: Record<MeetKey, MeetV2Key | null> = {
  founders: 'meet_founders_owners',
  investors: 'meet_investors',
  advisors_mentors: 'meet_advisors_experienced',
  // Both are "specialists, such as developers, designers or marketers".
  developers_technical: 'meet_specialists',
  sales_marketing_growth: 'meet_specialists',
  // v2 has no event organisers or community builders.
  event_community: null,
};

/** v1 asked who they ARE with the same six kinds as who to meet. */
export const SELF_V1_TO_V2: Record<MeetKey, SelfV2Key | null> = {
  founders: 'self_founder_owner',
  investors: 'self_investor',
  advisors_mentors: 'self_advisor_experienced',
  developers_technical: 'self_specialist',
  sales_marketing_growth: 'self_specialist',
  event_community: null,
};

/** v1's single "What brings you here?" becomes Q2 where it means the same thing. */
export const INTENT_V1_TO_V2: Record<IntentKey, FindV2Key | null> = {
  find_customers_partners: 'find_customers',
  find_investors: 'find_funding',
  find_cofounder_talent: 'find_cofounder',
  grow_network: 'find_friends_conversations',
  // "Get advice from experienced people": since the 25 Oct review, Q2 has
  // "I am looking for advice, mentoring or to learn from others."
  get_advice: 'find_advice_learning',
  // Exploring is nothing to find.
  invited_exploring: null,
};

export const OFFER_V1_TO_V2: Record<OfferKey, OfferV2Key | null> = {
  mentoring_advice: 'offer_advice_mentoring',
  investment: 'offer_investment',
  introductions_network: 'offer_introductions',
  skills_services: 'offer_products_services',
  // Someone hiring for open roles is building a team.
  hiring_open_roles: 'offer_join_build_team',
  partnerships_collaboration: null,
};

const setOf = (list: readonly { key: string }[]) => new Set<string>(list.map(o => o.key));
const V1_MEET = setOf(ONBOARDING_MEET);
const V1_OFFER = setOf(ONBOARDING_OFFERS);
const V1_INTENT = setOf(ONBOARDING_INTENTS);
const V2_MEET = setOf(ONBOARDING_V2_MEET);
const V2_FIND = setOf(ONBOARDING_V2_FIND);
const V2_OFFER = setOf(ONBOARDING_V2_OFFER);
const V2_SELF = setOf(ONBOARDING_V2_SELF);

export const isMeetV1Key = (k: string): k is MeetKey => V1_MEET.has(k);
export const isOfferV1Key = (k: string): k is OfferKey => V1_OFFER.has(k);
export const isIntentV1Key = (k: string): k is IntentKey => V1_INTENT.has(k);
export const isMeetV2Key = (k: string): k is MeetV2Key => V2_MEET.has(k);
export const isFindV2Key = (k: string): k is FindV2Key => V2_FIND.has(k);
export const isOfferV2Key = (k: string): k is OfferV2Key => V2_OFFER.has(k);
export const isSelfV2Key = (k: string): k is SelfV2Key => V2_SELF.has(k);

/**
 * Map, drop what has no v2 meaning, de-duplicate, keep the member's order. Every answer is carried: v2 has
 * no maximum since the 25 Oct review.
 */
function carry<V1 extends string, V2 extends string>(
  keys: readonly string[] | null | undefined,
  isV1: (k: string) => k is V1,
  table: Record<V1, V2 | null>,
): V2[] {
  const out: V2[] = [];
  for (const k of keys ?? []) {
    if (!isV1(k)) continue;
    const v2 = table[k];
    if (v2 && !out.includes(v2)) out.push(v2);
  }
  return out;
}

export interface V1Answers {
  intent: string | null;
  lookingToMeet: readonly string[] | null;
  canOffer: readonly string[] | null;
  selfKinds: readonly string[] | null;
}

export type V2KeyAnswers = Pick<OnboardingV2Answers, 'lookingToMeet' | 'hopingToFind' | 'canOffer' | 'selfKinds'>;

/** A member's v1 answers as v2 keys. Anything that is not a v1 key is ignored. */
export function v2FromV1(v1: V1Answers): V2KeyAnswers {
  return {
    lookingToMeet: carry(v1.lookingToMeet, isMeetV1Key, MEET_V1_TO_V2),
    hopingToFind: carry(v1.intent ? [v1.intent] : [], isIntentV1Key, INTENT_V1_TO_V2),
    canOffer: carry(v1.canOffer, isOfferV1Key, OFFER_V1_TO_V2),
    selfKinds: carry(v1.selfKinds, isMeetV1Key, SELF_V1_TO_V2),
  };
}
