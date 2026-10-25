// ─── Onboarding v2: the catalogue is the brief, word for word ────────────────
//
// Shradha's onboarding brief (19 Oct 2026) is the copy. Every label below is
// pasted from it, punctuation included ("I am looking for a cofounder" has no
// full stop in the brief, so it has none here). If a label has to change, the
// brief changes first. The keys are fixed by the 21 Oct plan and are what the
// database stores and matching compares, so they never change at all.
//
// The 25 Oct review (Stefan and Claus) changed the brief in three ways, pinned
// here word for word: every question is "Select all that apply.", each list
// gained answers for people who are not founders (an employee, a manager, a
// new job, people to hire), and the advisor answer no longer says
// "experienced professional", so an experienced employee is not filed as an
// advisor.

import {
  ONBOARDING_V2_MEET, ONBOARDING_V2_FIND, ONBOARDING_V2_OFFER, ONBOARDING_V2_SELF,
  ONBOARDING_V2_LIMITS, ONBOARDING_V2_COPY, ONBOARDING_V2_OTHER_KEYS, ONBOARDING_V2_STEPS,
  ONBOARDING_MEET, ONBOARDING_OFFERS, ONBOARDING_INTENTS,
} from '@rsn/shared';

const OWN_WORDS = "Something else. I'd like to say it in my own words.";

describe('the four questions, verbatim', () => {
  it('Q1 "Who would you like to meet?"', () => {
    expect(ONBOARDING_V2_COPY.meet).toEqual({ title: 'Who would you like to meet?', hint: 'Select all that apply.' });
    expect(ONBOARDING_V2_MEET.map(o => [o.key, o.label])).toEqual([
      ['meet_founders_owners', 'I would like to meet founders and business owners.'],
      ['meet_investors', 'I would like to meet investors.'],
      ['meet_advisors_experienced', 'I would like to meet advisors, mentors and experienced professionals.'],
      ['meet_specialists', 'I would like to meet specialists, such as developers, designers or marketers.'],
      ['meet_freelancers_consultants', 'I would like to meet freelancers and consultants.'],
      ['meet_students_early_career', 'I would like to meet students and people early in their career.'],
      ['meet_managers_leaders', 'I would like to meet managers and leaders in companies and organisations.'],
      ['meet_hiring', 'I would like to meet people who are hiring.'],
      ['meet_other', OWN_WORDS],
    ]);
  });

  it('Q2 "What are you hoping to find?", with the optional specific line', () => {
    expect(ONBOARDING_V2_COPY.find).toEqual({ title: 'What are you hoping to find?', hint: 'Select all that apply.' });
    expect(ONBOARDING_V2_FIND.map(o => [o.key, o.label])).toEqual([
      ['find_customers', 'I am looking for customers or clients.'],
      ['find_funding', 'I am looking to raise funding.'],
      ['find_cofounder', 'I am looking for a cofounder'],
      ['find_friends_conversations', 'I would like to make new friends and have good conversations.'],
      ['find_new_role', 'I am looking for a new job or my next career step.'],
      ['find_advice_learning', 'I am looking for advice, mentoring or to learn from others.'],
      ['find_hire', 'I am looking for people to hire.'],
      ['find_partners', 'I am looking for partners or collaborators.'],
      ['find_other', OWN_WORDS],
    ]);
    expect(ONBOARDING_V2_COPY.findSpecific).toEqual({
      label: "Is there anything specific you're looking for? (optional)",
      example: 'For example: "I\'m looking for someone who has helped small businesses expand internationally."',
    });
  });

  it('Q3 "What can you offer others?"', () => {
    expect(ONBOARDING_V2_COPY.offer).toEqual({ title: 'What can you offer others?', hint: 'Select all that apply.' });
    expect(ONBOARDING_V2_OFFER.map(o => [o.key, o.label])).toEqual([
      ['offer_products_services', 'I can offer my products or services.'],
      ['offer_investment', 'I can invest in promising ideas.'],
      ['offer_join_build_team', 'I am open to joining or building a team.'],
      ['offer_advice_mentoring', 'I can give advice and mentoring.'],
      ['offer_introductions', 'I can introduce people to others in my network.'],
      ['offer_friends_conversations', 'I am happy to make new friends and have good conversations.'],
      ['offer_knowledge', 'I can share what I know from my work.'],
      ['offer_referrals', 'I can help people find jobs or refer them where I work.'],
      ['offer_other', OWN_WORDS],
    ]);
  });

  it('Q4 "How would you describe yourself?": an employee answer second, a manager answer third', () => {
    expect(ONBOARDING_V2_COPY.self).toEqual({ title: 'How would you describe yourself?', hint: 'Select all that apply.' });
    expect(ONBOARDING_V2_SELF.map(o => [o.key, o.label])).toEqual([
      ['self_founder_owner', 'I am a founder or business owner.'],
      ['self_employee', 'I work for a company or organisation.'],
      ['self_manager_leader', 'I lead a team or part of an organisation.'],
      ['self_investor', 'I am an investor.'],
      ['self_advisor_experienced', 'I am an advisor or mentor.'],
      ['self_specialist', 'I am a specialist, such as a developer, designer or marketer.'],
      ['self_freelancer_consultant', 'I am a freelancer or consultant.'],
      ['self_student_early_career', 'I am a student or early in my career.'],
      ['self_other', OWN_WORDS],
    ]);
  });
});

describe('short labels, for the summary on the profile screen', () => {
  const all = [...ONBOARDING_V2_MEET, ...ONBOARDING_V2_FIND, ...ONBOARDING_V2_OFFER, ...ONBOARDING_V2_SELF];

  it.each(all.map(o => [o.key, o.shortLabel]))('%s has a short label (%s)', (_key, shortLabel) => {
    expect(shortLabel.trim().length).toBeGreaterThan(0);
    expect(shortLabel.length).toBeLessThanOrEqual(40);
    // A summary chip is a phrase, not a sentence.
    expect(shortLabel).not.toMatch(/\.$/);
  });

  it('never says RSN', () => {
    for (const o of all) {
      expect(o.label).not.toMatch(/\bRSN\b/);
      expect(o.shortLabel).not.toMatch(/\bRSN\b/);
    }
  });
});

describe('limits', () => {
  it('at least one answer to each question, and no maximum: each list is held only to the ceiling of 20', () => {
    expect(ONBOARDING_V2_LIMITS).toMatchObject({
      meetMin: 1, findMin: 1, offerMin: 1, selfMin: 1,
      ceiling: 20,
      // Still read by the preview's screens until they drop their limit lines: each is the ceiling, so none binds.
      meetMax: 20, findMax: 20, selfMax: 20,
      otherMaxLen: 120,
      findSpecificMaxLen: 300,
    });
  });

  it('every question has fewer answers than the ceiling, so ticking every one is never refused', () => {
    for (const list of [ONBOARDING_V2_MEET, ONBOARDING_V2_FIND, ONBOARDING_V2_OFFER, ONBOARDING_V2_SELF]) {
      expect(list.length).toBeLessThan(ONBOARDING_V2_LIMITS.ceiling);
    }
  });

  it('every question has exactly one "in my own words" option, and it is last', () => {
    expect(ONBOARDING_V2_OTHER_KEYS).toEqual({ meet: 'meet_other', find: 'find_other', offer: 'offer_other', self: 'self_other' });
    expect(ONBOARDING_V2_MEET[ONBOARDING_V2_MEET.length - 1].key).toBe('meet_other');
    expect(ONBOARDING_V2_FIND[ONBOARDING_V2_FIND.length - 1].key).toBe('find_other');
    expect(ONBOARDING_V2_OFFER[ONBOARDING_V2_OFFER.length - 1].key).toBe('offer_other');
    expect(ONBOARDING_V2_SELF[ONBOARDING_V2_SELF.length - 1].key).toBe('self_other');
  });
});

describe('it lives beside version 1 without touching it', () => {
  it('no v2 key is also a v1 key, so the shared columns can tell them apart', () => {
    const v1 = new Set<string>([...ONBOARDING_MEET, ...ONBOARDING_OFFERS, ...ONBOARDING_INTENTS].map(o => o.key));
    for (const o of [...ONBOARDING_V2_MEET, ...ONBOARDING_V2_FIND, ...ONBOARDING_V2_OFFER, ...ONBOARDING_V2_SELF]) {
      expect(v1.has(o.key)).toBe(false);
    }
  });

  it('keys are unique across the four questions', () => {
    const keys = [...ONBOARDING_V2_MEET, ...ONBOARDING_V2_FIND, ...ONBOARDING_V2_OFFER, ...ONBOARDING_V2_SELF].map(o => o.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has its own steps: the brief\'s welcome, sign up, four questions and profile', () => {
    expect(ONBOARDING_V2_STEPS).toEqual(['welcome', 'signup', 'q1', 'q2', 'q3', 'q4', 'profile']);
  });
});
