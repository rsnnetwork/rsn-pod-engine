// ─── Version 1 answers, carried into version 2 ───────────────────────────────
//
// A member who answered the five v1 questions opens v2 with what they already
// said, wherever v2 has the same meaning, and nothing where it has none. The
// table is the one decision; these tests pin every entry of it.

import {
  MEET_V1_TO_V2, SELF_V1_TO_V2, INTENT_V1_TO_V2, OFFER_V1_TO_V2,
  v2FromV1, isMeetV2Key, isFindV2Key, isOfferV2Key, isSelfV2Key, isMeetV1Key,
} from '../../../services/onboarding/answers-v2.map';
import { ONBOARDING_MEET, ONBOARDING_OFFERS, ONBOARDING_INTENTS } from '@rsn/shared';

describe('the mapping table covers every v1 key', () => {
  it('each kind of person, as someone to meet and as who they are', () => {
    for (const o of ONBOARDING_MEET) {
      expect(o.key in MEET_V1_TO_V2).toBe(true);
      expect(o.key in SELF_V1_TO_V2).toBe(true);
    }
  });
  it('each reason for being here, and each offer', () => {
    for (const o of ONBOARDING_INTENTS) expect(o.key in INTENT_V1_TO_V2).toBe(true);
    for (const o of ONBOARDING_OFFERS) expect(o.key in OFFER_V1_TO_V2).toBe(true);
  });
});

describe('the table itself', () => {
  it('who to meet', () => {
    expect(MEET_V1_TO_V2).toEqual({
      founders: 'meet_founders_owners',
      investors: 'meet_investors',
      advisors_mentors: 'meet_advisors_experienced',
      developers_technical: 'meet_specialists',
      sales_marketing_growth: 'meet_specialists',
      event_community: null,
    });
  });
  it('who they are', () => {
    expect(SELF_V1_TO_V2).toEqual({
      founders: 'self_founder_owner',
      investors: 'self_investor',
      advisors_mentors: 'self_advisor_experienced',
      developers_technical: 'self_specialist',
      sales_marketing_growth: 'self_specialist',
      event_community: null,
    });
  });
  it('what they hope to find', () => {
    expect(INTENT_V1_TO_V2).toEqual({
      find_customers_partners: 'find_customers',
      find_investors: 'find_funding',
      find_cofounder_talent: 'find_cofounder',
      grow_network: 'find_friends_conversations',
      // "Get advice from experienced people" is the 25 Oct "I am looking for advice, mentoring or to learn from others."
      get_advice: 'find_advice_learning',
      invited_exploring: null,
    });
  });
  it('what they offer', () => {
    expect(OFFER_V1_TO_V2).toEqual({
      mentoring_advice: 'offer_advice_mentoring',
      investment: 'offer_investment',
      introductions_network: 'offer_introductions',
      skills_services: 'offer_products_services',
      hiring_open_roles: 'offer_join_build_team',
      partnerships_collaboration: null,
    });
  });
});

describe('v2FromV1', () => {
  it('carries a full v1 member across', () => {
    expect(v2FromV1({
      intent: 'find_investors',
      lookingToMeet: ['investors', 'advisors_mentors'],
      canOffer: ['mentoring_advice', 'skills_services'],
      selfKinds: ['founders'],
    })).toEqual({
      lookingToMeet: ['meet_investors', 'meet_advisors_experienced'],
      hopingToFind: ['find_funding'],
      canOffer: ['offer_advice_mentoring', 'offer_products_services'],
      selfKinds: ['self_founder_owner'],
    });
  });

  it('merges two v1 kinds that became one, and drops kinds v2 does not have', () => {
    expect(v2FromV1({
      intent: 'invited_exploring',
      lookingToMeet: ['developers_technical', 'sales_marketing_growth', 'event_community'],
      canOffer: ['partnerships_collaboration'],
      selfKinds: ['event_community'],
    })).toEqual({ lookingToMeet: ['meet_specialists'], hopingToFind: [], canOffer: [], selfKinds: [] });
  });

  it('a v1 member who came for advice opens Q2 with the advice answer', () => {
    expect(v2FromV1({ intent: 'get_advice', lookingToMeet: [], canOffer: [], selfKinds: [] }).hopingToFind)
      .toEqual(['find_advice_learning']);
  });

  it('ignores anything that is not a v1 key, including v2 keys already in the same column', () => {
    expect(v2FromV1({
      intent: null,
      lookingToMeet: ['meet_investors', 'astronauts'],
      canOffer: [],
      selfKinds: ['self_investor'],
    })).toEqual({ lookingToMeet: [], hopingToFind: [], canOffer: [], selfKinds: [] });
  });

  it('carries every answer, with no cut to three people or two self-descriptions (v2 has no maximum now)', () => {
    const r = v2FromV1({
      intent: 'grow_network',
      lookingToMeet: ['founders', 'investors', 'advisors_mentors', 'developers_technical'],
      canOffer: ONBOARDING_OFFERS.map(o => o.key),
      selfKinds: ['founders', 'investors', 'advisors_mentors'],
    });
    expect(r.lookingToMeet).toEqual(['meet_founders_owners', 'meet_investors', 'meet_advisors_experienced', 'meet_specialists']);
    expect(r.selfKinds).toEqual(['self_founder_owner', 'self_investor', 'self_advisor_experienced']);
    expect(r.hopingToFind).toEqual(['find_friends_conversations']);
  });
});

describe('telling the versions apart in a shared column', () => {
  it('recognises each version\'s keys and only those', () => {
    expect(isMeetV2Key('meet_investors')).toBe(true);
    expect(isMeetV2Key('investors')).toBe(false);
    expect(isMeetV1Key('investors')).toBe(true);
    expect(isMeetV1Key('meet_investors')).toBe(false);
    expect(isFindV2Key('find_funding')).toBe(true);
    expect(isFindV2Key('find_investors')).toBe(false);
    expect(isOfferV2Key('offer_investment')).toBe(true);
    expect(isOfferV2Key('investment')).toBe(false);
    expect(isSelfV2Key('self_investor')).toBe(true);
    expect(isSelfV2Key('investors')).toBe(false);
  });
});
