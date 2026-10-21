// ─── Option signals, version 2: words the scorer understands ─────────────────
//
// The brief's labels are sentences ("I would like to meet founders and business
// owners."), and the scorer reads words. These pin what each v2 key becomes in
// the columns matching reads, the same way the v1 guard tests do, and they run
// the real scorer where a rule is about who finds whom.

import {
  MEET_V2_SIGNALS, FIND_V2_SIGNALS, OFFER_V2_TEXT, SELF_V2_TITLES,
  wantTextV2, intentTextV2, offerTextV2, roleTitlesV2, reasonsV2, desiredDesignationsV2, selfGuessFromRole,
} from '../../../services/matching/option-signals';
import { designationsWanted, normalizeDesignation, tokenizeTerms } from '../../../services/matching/intent-signals';
import { extractConstraints } from '../../../services/matching/want-constraints';
import { scoreWants, MATCH_THRESHOLD, IntentProfile } from '../../../services/matching/platform-match.service';
import { ONBOARDING_V2_MEET, ONBOARDING_V2_FIND, ONBOARDING_V2_OFFER, ONBOARDING_V2_SELF } from '@rsn/shared';
import type { MeetV2Key, SelfV2Key, OfferV2Key, FindV2Key } from '@rsn/shared';

const person = (over: Partial<IntentProfile>): IntentProfile => ({
  id: 'u-x', displayName: 'Bo', avatarUrl: null,
  professionalRole: null, jobTitle: null, company: null,
  expertiseText: null, whatICanHelpWith: null, whatICareAbout: null,
  goals: null, interests: null, myIntent: null,
  whoIWantToMeet: null, whyIWantToMeet: null,
  ...over,
});
const wantedKeys = (text: string | null) => designationsWanted(text ?? '').map(d => d.key);

describe('every v2 option has a translation', () => {
  it('each kind of person to meet, except "in my own words"', () => {
    for (const o of ONBOARDING_V2_MEET) {
      if (o.key === 'meet_other') continue;
      expect(MEET_V2_SIGNALS[o.key]).toBeDefined();
    }
  });
  it('each thing hoped for, each offer and each self-description', () => {
    for (const o of ONBOARDING_V2_FIND) if (o.key !== 'find_other') expect(FIND_V2_SIGNALS[o.key]).toBeDefined();
    for (const o of ONBOARDING_V2_OFFER) if (o.key !== 'offer_other') expect(o.key in OFFER_V2_TEXT).toBe(true);
    for (const o of ONBOARDING_V2_SELF) if (o.key !== 'self_other') expect(SELF_V2_TITLES[o.key]).toBeDefined();
  });
});

describe('meet: each tick asks for the right kind of person', () => {
  it.each(Object.entries(MEET_V2_SIGNALS))('%s asks for its own buckets', (_key, sig) => {
    const found = wantedKeys(sig.wantText);
    for (const bucket of sig.buckets) expect(found).toContain(bucket);
  });

  it('founders and business owners asks for both kinds', () => {
    expect(wantedKeys(MEET_V2_SIGNALS.meet_founders_owners.wantText)).toEqual(expect.arrayContaining(['founder', 'owner']));
  });

  it('specialists asks for developers, designers and marketers', () => {
    expect(wantedKeys(MEET_V2_SIGNALS.meet_specialists.wantText)).toEqual(expect.arrayContaining(['developer', 'designer', 'marketer']));
  });

  it('freelancers and consultants asks for consultants', () => {
    expect(wantedKeys(MEET_V2_SIGNALS.meet_freelancers_consultants.wantText)).toContain('consultant');
  });

  it('students and early career asks for students', () => {
    expect(wantedKeys(MEET_V2_SIGNALS.meet_students_early_career.wantText)).toContain('student');
  });

  it('no want text is the label', () => {
    for (const o of ONBOARDING_V2_MEET) {
      if (o.key === 'meet_other') continue;
      expect(MEET_V2_SIGNALS[o.key].wantText).not.toBe(o.label);
    }
  });

  it('every search name fits the column it is stored in', () => {
    for (const sig of Object.values(MEET_V2_SIGNALS)) expect(sig.agentLabel.length).toBeLessThanOrEqual(80);
  });
});

describe('self: the titles the brief names', () => {
  it('freelancer or consultant is a Consultant, a student a Student, an advisor an Advisor', () => {
    expect(roleTitlesV2(['self_freelancer_consultant'], null, null)).toEqual(['Consultant']);
    expect(roleTitlesV2(['self_student_early_career'], null, null)).toEqual(['Student']);
    expect(roleTitlesV2(['self_advisor_experienced'], null, null)).toEqual(['Advisor']);
  });

  it('a specialist is a Specialist, unless they typed a job title, which wins', () => {
    expect(roleTitlesV2(['self_specialist'], null, null)).toEqual(['Specialist']);
    expect(roleTitlesV2(['self_specialist'], null, 'Product Designer')).toEqual(['Product Designer']);
    expect(roleTitlesV2(['self_specialist'], null, '   ')).toEqual(['Specialist']);
  });

  it('a typed job title does not replace any other kind', () => {
    expect(roleTitlesV2(['self_investor'], null, 'Partner at Northwind')).toEqual(['Investor']);
  });

  it('"in my own words" is their own words', () => {
    expect(roleTitlesV2(['self_other'], 'Chef and restaurant owner', null)).toEqual(['Chef and restaurant owner']);
    expect(roleTitlesV2(['self_other', 'self_investor'], null, null)).toEqual(['Investor']);
  });

  it.each(Object.entries(SELF_V2_TITLES))('%s reads back as a kind of person the taxonomy knows', (_key, titles) => {
    for (const t of titles) expect(normalizeDesignation(t)).not.toBeNull();
  });

  it('two answers never repeat a title', () => {
    expect(roleTitlesV2(['self_specialist', 'self_other'], 'Specialist', null)).toEqual(['Specialist']);
  });
});

describe('find: what they hope for, in words that work', () => {
  it('raising funding names investors', () => {
    expect(FIND_V2_SIGNALS.find_funding.intentText).toMatch(/investors/);
    expect(wantedKeys(FIND_V2_SIGNALS.find_funding.intentText)).toContain('investor');
  });

  it('a cofounder asks for founders, and never for candidates', () => {
    const text = FIND_V2_SIGNALS.find_cofounder.intentText;
    expect(wantedKeys(text)).toContain('founder');
    expect(wantedKeys(text)).not.toContain('job_seeker');
  });

  it('the reasons shown to the live-event matcher leave out friends and own words', () => {
    expect(reasonsV2(['find_funding', 'find_friends_conversations', 'find_other'])).toEqual(['Raising funding']);
  });

  it('desired designations come from the people to meet and from what they hope for', () => {
    expect(desiredDesignationsV2(['meet_students_early_career'], ['find_funding'])).toEqual(expect.arrayContaining(['student', 'investor']));
  });
});

describe('friends and good conversations add no words', () => {
  // On a networking platform nearly everyone ticks this. As want or offer words
  // it would make everyone match everyone.
  it('has no intent text and no offer text', () => {
    expect(FIND_V2_SIGNALS.find_friends_conversations.intentText).toBeNull();
    expect(OFFER_V2_TEXT.offer_friends_conversations).toBeNull();
  });

  it('a friends-only member has no want text, intent text or offer text at all', () => {
    expect(intentTextV2(['find_friends_conversations'], null, null)).toBeNull();
    expect(offerTextV2(['offer_friends_conversations'], null)).toBeNull();
  });

  it('never leaks "friends" or "conversations" next to other answers', () => {
    const intent = intentTextV2(['find_customers', 'find_friends_conversations'], null, null);
    const offer = offerTextV2(['offer_investment', 'offer_friends_conversations'], null);
    const words = tokenizeTerms([intent, offer]);
    expect(words).not.toContain('friends');
    expect(words).not.toContain('conversations');
  });

  it('two friends-only members do not match each other', () => {
    const wants = [intentTextV2(['find_friends_conversations'], null, null)];
    const other = person({ whatICanHelpWith: offerTextV2(['offer_friends_conversations'], null) });
    expect(scoreWants(wants, other).score).toBe(0);
  });
});

describe('offers carry words, not stop words', () => {
  it.each(Object.entries(OFFER_V2_TEXT).filter(([, t]) => t !== null))('%s has meaningful words', (_key, text) => {
    expect(tokenizeTerms([text]).length).toBeGreaterThan(0);
  });

  it('products or services, and joining or building a team, in particular', () => {
    // "products", "services", "join", "build" and "team" are all stop words.
    expect(tokenizeTerms([OFFER_V2_TEXT.offer_products_services])).not.toEqual([]);
    expect(tokenizeTerms([OFFER_V2_TEXT.offer_join_build_team])).not.toEqual([]);
  });
});

describe('free text is appended and read by the place and years parser', () => {
  it('meet: their words follow the ticked kinds', () => {
    const text = wantTextV2(['meet_investors', 'meet_other'], 'bakers in Germany');
    expect(text).toContain(MEET_V2_SIGNALS.meet_investors.wantText);
    expect(text).toContain('bakers in Germany');
    expect(extractConstraints([text]).location).toEqual(['germany']);
  });

  it('meet: "in my own words" without its text adds nothing', () => {
    expect(wantTextV2(['meet_other'], null)).toBe('');
  });

  it('find: their own words and the specific line are both read', () => {
    const text = intentTextV2(['find_funding', 'find_other'], 'a lawyer for my seed round', 'someone with 10 years in logistics')!;
    expect(text).toContain('a lawyer for my seed round');
    expect(text).toContain('someone with 10 years in logistics');
    expect(extractConstraints([text]).minYears).toBe(10);
  });

  it('find: the specific line counts on its own, whatever was ticked', () => {
    expect(intentTextV2(['find_friends_conversations'], null, 'people who sail')).toBe('people who sail');
  });

  it('offer: their own words follow the ticked offers', () => {
    expect(offerTextV2(['offer_other'], 'Japanese lessons')).toBe('Japanese lessons');
    expect(offerTextV2(['offer_introductions', 'offer_other'], 'Japanese lessons')).toMatch(/introductions.*Japanese lessons/);
  });
});

describe('a v2 member can be found by a v2 member', () => {
  // The end-to-end promise, per kind: wanting X finds someone who says they are X.
  const pairs: Array<[MeetV2Key, SelfV2Key]> = [
    ['meet_founders_owners', 'self_founder_owner'],
    ['meet_investors', 'self_investor'],
    ['meet_advisors_experienced', 'self_advisor_experienced'],
    ['meet_specialists', 'self_specialist'],
    ['meet_freelancers_consultants', 'self_freelancer_consultant'],
    ['meet_students_early_career', 'self_student_early_career'],
  ];

  it.each(pairs)('wanting %s finds someone who says %s', (meetKey, selfKey) => {
    const wanted = wantedKeys(MEET_V2_SIGNALS[meetKey as Exclude<MeetV2Key, 'meet_other'>].wantText);
    const theirBuckets = roleTitlesV2([selfKey], null, null).map(t => normalizeDesignation(t));
    expect(wanted.some(w => theirBuckets.includes(w))).toBe(true);
  });

  it.each(pairs)('and the real scorer calls %s finding %s a strong match', (meetKey, selfKey) => {
    const wants = [wantTextV2([meetKey], null)];
    const them = person({ professionalRole: roleTitlesV2([selfKey], null, null) });
    expect(scoreWants(wants, them).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('a specialist who typed their title is still found by a search for specialists', () => {
    const wants = [wantTextV2(['meet_specialists'], null)];
    const them = person({ professionalRole: roleTitlesV2(['self_specialist'], null, 'Senior UX Designer') });
    expect(scoreWants(wants, them).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('and is not found by a search for something else', () => {
    const wants = [wantTextV2(['meet_investors'], null)];
    const developer = person({ professionalRole: roleTitlesV2(['self_specialist'], null, 'Backend developer') });
    expect(scoreWants(wants, developer).score).toBeLessThan(MATCH_THRESHOLD);
  });

  it('a v1 search for freelancers now finds a v2 freelancer', () => {
    const them = person({ professionalRole: roleTitlesV2(['self_freelancer_consultant'], null, null) });
    expect(scoreWants(['freelancers who can help with design'], them).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});

describe('offers reach the people who are looking for them', () => {
  const offering = (offers: OfferV2Key[]) => person({ whatICanHelpWith: offerTextV2(offers, null) });
  const hoping = (find: FindV2Key[]) => [intentTextV2(find, null, null)];

  it('raising funding finds someone who can invest', () => {
    expect(scoreWants(hoping(['find_funding']), offering(['offer_investment'])).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('looking for a cofounder finds someone open to joining or building a team', () => {
    expect(scoreWants(hoping(['find_cofounder']), offering(['offer_join_build_team'])).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('wanting advisors and mentors finds someone who gives advice and mentoring', () => {
    const wants = [wantTextV2(['meet_advisors_experienced'], null)];
    expect(scoreWants(wants, offering(['offer_advice_mentoring'])).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('wanting investors finds someone who can invest', () => {
    const wants = [wantTextV2(['meet_investors'], null)];
    expect(scoreWants(wants, offering(['offer_investment'])).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});

describe('selfGuess: Q4\'s likeliest answer, read from the LinkedIn role', () => {
  it.each([
    ['Founder & CEO', 'self_founder_owner'],
    ['Owner, Bakery Schmidt', 'self_founder_owner'],
    ['Angel Investor', 'self_investor'],
    ['Mentor and board advisor', 'self_advisor_experienced'],
    ['Senior Software Engineer', 'self_specialist'],
    ['Growth Marketing Lead', 'self_specialist'],
    ['Freelance consultant', 'self_freelancer_consultant'],
    ['MBA Student', 'self_student_early_career'],
  ] as const)('%s → %s', (role, key) => {
    expect(selfGuessFromRole(role)).toBe(key);
  });

  it('says nothing when the role says nothing clear', () => {
    expect(selfGuessFromRole('Wizard')).toBeNull();
    expect(selfGuessFromRole(null)).toBeNull();
    expect(selfGuessFromRole('')).toBeNull();
  });
});
