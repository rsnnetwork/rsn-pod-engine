// ─── Option signals, version 2: words the scorer understands ─────────────────
//
// The brief's labels are sentences ("I would like to meet founders and business
// owners."), and the scorer reads words. These pin what each v2 key becomes in
// the columns matching reads, the same way the v1 guard tests do, and they run
// the real scorer where a rule is about who finds whom.

import {
  MEET_V2_SIGNALS, FIND_V2_SIGNALS, OFFER_V2_TEXT, SELF_V2_TITLES,
  wantTextV2, intentTextV2, offerTextV2, roleTitlesV2, reasonsV2, desiredDesignationsV2, selfGuessesFromText,
} from '../../../services/matching/option-signals';
import { designationsWanted, normalizeDesignation, tokenizeTerms } from '../../../services/matching/intent-signals';
import { expandWantTags } from '../../../services/matching/want-synonyms';
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

  it('someone who works for a company is an Employee, and someone who leads a team a Manager', () => {
    expect(roleTitlesV2(['self_employee'], null, null)).toEqual(['Employee']);
    expect(roleTitlesV2(['self_manager_leader'], null, null)).toEqual(['Manager']);
    expect(normalizeDesignation('Employee')).toBe('employee');
    expect(normalizeDesignation('Manager')).toBe('manager');
  });

  it('and their typed job title wins over either, as it does over "Specialist"', () => {
    expect(roleTitlesV2(['self_employee'], null, 'Registered nurse')).toEqual(['Registered nurse']);
    expect(roleTitlesV2(['self_manager_leader'], null, 'Head of Engineering')).toEqual(['Head of Engineering']);
    expect(roleTitlesV2(['self_employee', 'self_manager_leader'], null, 'Head of Engineering')).toEqual(['Head of Engineering']);
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

// The 25 Oct review (ONB-02): answers for people who are not founders. Each one asks for the kinds of person
// the audit's table names, and never for the opposite: "people who are hiring" is not a search for candidates.
describe('the 25 Oct answers ask for the right kinds of person', () => {
  it('managers and leaders asks for managers and executives', () => {
    expect(wantedKeys(MEET_V2_SIGNALS.meet_managers_leaders.wantText)).toEqual(expect.arrayContaining(['manager', 'executive']));
  });

  it('people who are hiring asks for recruiters and hiring managers, never for candidates', () => {
    const wanted = wantedKeys(MEET_V2_SIGNALS.meet_hiring.wantText);
    expect(wanted).toEqual(expect.arrayContaining(['hr', 'manager']));
    expect(wanted).not.toContain('job_seeker');
  });

  it('and its stored tags, which the scorer reads as wants too, never ask for candidates either', () => {
    // A tag that expands to "talent" would read as a search for people who want to BE hired.
    const sig = MEET_V2_SIGNALS.meet_hiring;
    expect(wantedKeys([sig.wantText, ...expandWantTags([...sig.tags])].join(' '))).not.toContain('job_seeker');
  });

  it('a new job asks for recruiters and hiring managers, and not for candidates', () => {
    const wanted = wantedKeys(FIND_V2_SIGNALS.find_new_role.intentText);
    expect(wanted).toEqual(expect.arrayContaining(['hr', 'manager']));
    expect(wanted).not.toContain('job_seeker');
  });

  it('advice and learning asks for advisors and mentors', () => {
    expect(wantedKeys(FIND_V2_SIGNALS.find_advice_learning.intentText)).toContain('advisor');
  });

  it('people to hire asks for candidates, and not for HR', () => {
    const wanted = wantedKeys(FIND_V2_SIGNALS.find_hire.intentText);
    expect(wanted).toContain('job_seeker');
    expect(wanted).not.toContain('hr');
  });

  it('partners and collaborators asks for partners, and not for investors', () => {
    const wanted = wantedKeys(FIND_V2_SIGNALS.find_partners.intentText);
    expect(wanted).toContain('partner');
    expect(wanted).not.toContain('investor');
  });

  it('each new thing to find is a reason the live-event matcher compares', () => {
    expect(reasonsV2(['find_new_role', 'find_advice_learning', 'find_hire', 'find_partners'])).toHaveLength(4);
  });

  it('sharing what they know names their work when they gave a title, and their profession when not', () => {
    expect(offerTextV2(['offer_knowledge'], null, 'Product Manager')).toBe('knowledge from my work as Product Manager');
    expect(offerTextV2(['offer_knowledge'], null, null)).toBe('knowledge from my profession');
    expect(offerTextV2(['offer_knowledge'], null, '   ')).toBe('knowledge from my profession');
    expect(OFFER_V2_TEXT.offer_knowledge).toBe('knowledge from my profession');
  });

  it('a typed title only changes the knowledge offer', () => {
    expect(offerTextV2(['offer_investment'], null, 'Product Manager')).toBe(OFFER_V2_TEXT.offer_investment);
  });

  it('job referrals are offered in words a job seeker\'s search reads', () => {
    expect(offerTextV2(['offer_referrals'], null)).toBe('job referrals and introductions to hiring managers');
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
    ['meet_managers_leaders', 'self_manager_leader'],
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

  it('looking for a new job finds someone who can refer people where they work', () => {
    expect(scoreWants(hoping(['find_new_role']), offering(['offer_referrals'])).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('looking for advice and mentoring finds someone who gives advice and mentoring', () => {
    expect(scoreWants(hoping(['find_advice_learning']), offering(['offer_advice_mentoring'])).score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
});

// The 25 Oct review (ONB-03): with no limits, every answer the role supports is suggested, not only the first.
describe('selfGuessesFromText: Q4\'s likely answers, read from the LinkedIn role', () => {
  it.each([
    ['Founder & CEO', ['self_founder_owner']],
    ['Owner, Bakery Schmidt', ['self_founder_owner']],
    ['Angel Investor', ['self_investor']],
    ['Mentor and board advisor', ['self_advisor_experienced']],
    ['Senior Software Engineer', ['self_specialist']],
    ['Growth Marketing Lead', ['self_specialist']],
    ['Freelance consultant', ['self_freelancer_consultant']],
    ['MBA Student', ['self_student_early_career']],
  ] as const)('%s', (role, keys) => {
    expect(selfGuessesFromText(role, null)).toEqual(keys);
  });

  // A manager or an executive leads; an employee works for a company. Neither is an advisor any more.
  it.each([
    ['Engineering Manager', ['self_manager_leader']],
    ['Director of Operations', ['self_manager_leader']],
    ['CTO', ['self_manager_leader']],
    ['Data Analyst', ['self_employee']],
    ['HR Business Partner', ['self_employee']],
    ['Sales Representative', ['self_employee']],
    // A word that is only part of a longer title is not a second answer: a product manager or an account
    // executive is not suggested as someone who leads a team, nor a product owner as a business owner.
    ['Product Manager', ['self_employee']],
    ['Account Executive', ['self_employee']],
    ['Product Owner', ['self_employee']],
    // Two things the title really says.
    ['Head of Sales', ['self_employee', 'self_manager_leader']],
  ] as const)('%s', (role, keys) => {
    expect(selfGuessesFromText(role, null)).toEqual(keys);
  });

  // Fix round 1 (task review, 26 Oct): "executive" leads only as a C-level title or in a leadership
  // compound. A sales, HR, marketing or business development executive, or an executive assistant, does the
  // work of their function and is never suggested as someone who leads a team.
  it.each([
    ['Sales Executive', ['self_employee']],
    ['HR Executive', ['self_employee']],
    ['Business Development Executive', ['self_employee']],
    ['Marketing Executive', ['self_specialist']],
    ['Executive Assistant', ['self_employee']],
    ['Executive Director', ['self_manager_leader']],
    ['Executive Vice President', ['self_manager_leader']],
    ['Executive Chairman', ['self_manager_leader']],
    ['Chief Technology Officer', ['self_manager_leader']],
    // The CEO rule is unchanged (someone running their own company); spelled out, a chief executive also leads.
    ['Chief Executive Officer', ['self_founder_owner', 'self_manager_leader']],
    ['CEO', ['self_founder_owner']],
  ] as const)('%s', (role, keys) => {
    expect(selfGuessesFromText(role, null)).toEqual(keys);
  });

  it('a role that names several things suggests each, in the order it names them', () => {
    expect(selfGuessesFromText('Founder & CEO | Angel investor', null)).toEqual(['self_founder_owner', 'self_investor']);
    expect(selfGuessesFromText('CTO / Co-founder', null)).toEqual(['self_manager_leader', 'self_founder_owner']);
  });

  it('suggests each answer once', () => {
    expect(selfGuessesFromText('Co-founder, Founder & Owner', null)).toEqual(['self_founder_owner']);
  });

  it('never reads a company, or the people someone works with, as their own role', () => {
    expect(selfGuessesFromText('Investor at Founders Fund', null)).toEqual(['self_investor']);
    expect(selfGuessesFromText('Advisor to founders and investors', null)).toEqual(['self_advisor_experienced']);
    expect(selfGuessesFromText('Mentor for students', null)).toEqual(['self_advisor_experienced']);
    expect(selfGuessesFromText('Consultant with investors', null)).toEqual(['self_freelancer_consultant']);
    // Even when the page broke the line after the people they serve.
    expect(selfGuessesFromText('Advisor to founders\nand investors', null)).toEqual(['self_advisor_experienced']);
  });

  it('reads the headline only when there is no role', () => {
    expect(selfGuessesFromText(null, 'Founder at Vokt')).toEqual(['self_founder_owner']);
    expect(selfGuessesFromText('  ', 'Founder at Vokt')).toEqual(['self_founder_owner']);
    expect(selfGuessesFromText('Angel Investor', 'Founder at Vokt')).toEqual(['self_investor']);
    expect(selfGuessesFromText('Teacher', 'Teacher | Founder of a tutoring school')).toEqual([]);
  });

  it('a headline that says what they do for others suggests nothing: "Helping founders raise capital"', () => {
    expect(selfGuessesFromText(null, 'Helping founders raise capital')).toEqual([]);
    expect(selfGuessesFromText(null, 'Helping founders and investors connect')).toEqual([]);
    expect(selfGuessesFromText(null, 'Founder – helping investors find deals')).toEqual(['self_founder_owner']);
  });

  it('a headline title that opens with a word ending in -ing is still a title', () => {
    expect(selfGuessesFromText(null, 'Marketing Lead at Siemens | Helping brands grow')).toEqual(['self_specialist']);
    expect(selfGuessesFromText(null, 'Managing Director')).toEqual(['self_manager_leader']);
    expect(selfGuessesFromText(null, 'Engineering Manager')).toEqual(['self_manager_leader']);
  });

  it('says nothing when neither says anything it knows', () => {
    expect(selfGuessesFromText('Wizard', null)).toEqual([]);
    expect(selfGuessesFromText(null, null)).toEqual([]);
    expect(selfGuessesFromText('', '   ')).toEqual([]);
  });
});
