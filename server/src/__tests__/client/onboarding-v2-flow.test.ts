// server/src/__tests__/client/onboarding-v2-flow.test.ts
// Onboarding version 2 on screen (Shradha's brief, 19 Oct 2026): the rules the eight screens share, EXECUTED.
// flow.ts is pure (no axios, store or router), so this imports it and runs it: which screen a URL may show, whether
// a question can be left, what confirm sends, which value a profile field shows, the brief's words.
import {
  ONBOARDING_V2_COPY, ONBOARDING_V2_FIND, ONBOARDING_V2_MEET, ONBOARDING_V2_OFFER, ONBOARDING_V2_SELF,
  type OnboardingV2Answers,
} from '@rsn/shared';
import {
  QUESTIONS, WELCOME, SIGNUP, PROFILE, SELF_GUESS_LINE, SPECIFIC, OWN_WORDS_MAX,
  LINKEDIN_EMPTY, LINKEDIN_EXAMPLE,
  questionFor, questionProblem, firstIncomplete, stepToShow, stepAfter, stepBefore, parseEdit,
  toggleKey, confirmBody, draftPatch, profileValue, profileInput, linkedinForInput, linkedinInputProblem,
  zoneLabel, searchZones, onboardingError, answerSummary, linkedinNote, editAction, editFallback, guessedSelf,
  withKeys, withOwnWords, isRealZone, zoneList, currentZoneName, confirmProblem,
  safeRedirect, problemMessage, ANSWER_NEEDED, signupChoiceKey, parseSignupChoice, LANDED, isLanded, returnedKey, tourOpensAfterConfirm,
} from '../../../../client/src/features/onboarding/flow';
import { forgetReturned, hasReturned, markReturned } from '../../../../client/src/features/onboarding/tour-landing';

const NONE: OnboardingV2Answers = {
  lookingToMeet: [], meetOther: null,
  hopingToFind: [], findOther: null, findSpecific: null,
  canOffer: [], offerOther: null,
  selfKinds: [], selfOther: null,
};
const DONE: OnboardingV2Answers = {
  ...NONE,
  lookingToMeet: ['meet_investors'], hopingToFind: ['find_funding'], canOffer: ['offer_advice_mentoring'], selfKinds: ['self_founder_owner'],
};
const q = (step: 'q1' | 'q2' | 'q3' | 'q4') => questionFor(step)!;

describe('the brief\'s words, verbatim', () => {
  it('screen 1, Welcome', () => {
    expect(WELCOME.title).toBe("Welcome to REASON. We're glad you're here.");
    expect(WELCOME.lead).toBe('Every good connection starts with a reason.');
    expect(WELCOME.lines).toEqual([
      'On REASON, you connect with people you want to meet, who also want to meet you, for a specific reason.',
      'Answer quick questions and we will suggest the potential mutuals for you.',
    ]);
    expect(WELCOME.button).toBe("Let's go");
  });

  it('screen 2, Sign up', () => {
    expect(SIGNUP).toEqual({
      title: "Let's get you started",
      linkedin: 'Continue with LinkedIn',
      linkedinLine: "We'll use your LinkedIn profile to fill in your details for you.",
      email: 'Continue with email',
    });
  });

  it('screen 7, Your profile, and the line for a role picked from LinkedIn', () => {
    expect(PROFILE.title).toBe("Here's how others will see you");
    expect(PROFILE.subtitle).toBe("Change anything that isn't right.");
    expect(PROFILE.keepPhoto).toBe('Keep this photo');
    expect(PROFILE.newPhoto).toBe('Upload a new one');
    expect(PROFILE.answers).toBe('Your answers');
    expect(PROFILE.edit).toBe('Edit');
    expect(PROFILE.change).toBe('Change');
    expect(PROFILE.onlyYou).toBe('Only you see this');
    expect(PROFILE.addLinkedinLine).toBe('Add your LinkedIn profile so people can learn more about you. You can do this later.');
    expect(PROFILE.addLinkedin).toBe('Add LinkedIn');
    expect(PROFILE.later).toBe('Later');
    expect(PROFILE.finish).toBe('Show me my matches');
    expect(SELF_GUESS_LINE).toBe("We picked this from your LinkedIn. Change it if it's wrong.");
  });

  it('none of it says RSN', () => {
    const all = JSON.stringify({ WELCOME, SIGNUP, PROFILE, SELF_GUESS_LINE, QUESTIONS: QUESTIONS.map(x => [x.title, x.hint, x.limitHint, x.ownWordsMissing]) });
    expect(all).not.toMatch(/\bRSN\b/);
  });
});

describe('the four questions (screens 3 to 6)', () => {
  it('come in the brief\'s order, numbered 1 to 4, with its titles, helper lines and options', () => {
    expect(QUESTIONS.map(x => [x.step, x.number, x.title, x.hint])).toEqual([
      ['q1', 1, 'Who would you like to meet?', 'Select up to three answers.'],
      ['q2', 2, 'What are you hoping to find?', 'Select up to three answers.'],
      ['q3', 3, 'What can you offer others?', 'Select all that apply.'],
      ['q4', 4, 'How would you describe yourself?', 'Select up to two answers.'],
    ]);
    expect(QUESTIONS.map(x => x.options)).toEqual([ONBOARDING_V2_MEET, ONBOARDING_V2_FIND, ONBOARDING_V2_OFFER, ONBOARDING_V2_SELF]);
    expect(QUESTIONS.map(x => x.title)).toEqual([
      ONBOARDING_V2_COPY.meet.title, ONBOARDING_V2_COPY.find.title, ONBOARDING_V2_COPY.offer.title, ONBOARDING_V2_COPY.self.title,
    ]);
  });

  it('have the brief\'s limits, and a gentle line for when one is reached', () => {
    expect(QUESTIONS.map(x => x.max)).toEqual([3, 3, null, 2]);
    expect(QUESTIONS.map(x => x.limitHint)).toEqual([
      "You've chosen three. Untick one to choose another.",
      "You've chosen three. Untick one to choose another.",
      null,
      "You've chosen two. Untick one to choose another.",
    ]);
  });

  it('each end in "Something else", whose words are required, up to 120 characters, in the server\'s own sentences', () => {
    expect(OWN_WORDS_MAX).toBe(120);
    expect(QUESTIONS.map(x => [x.ownWordsKey, x.ownWordsField])).toEqual([
      ['meet_other', 'meetOther'], ['find_other', 'findOther'], ['offer_other', 'offerOther'], ['self_other', 'selfOther'],
    ]);
    for (const x of QUESTIONS) expect(x.options[x.options.length - 1].key).toBe(x.ownWordsKey);
    expect(QUESTIONS.map(x => x.ownWordsMissing)).toEqual([
      'Tell us who you would like to meet.',
      'Tell us what you are hoping to find.',
      'Tell us what you can offer.',
      'Tell us how you would describe yourself.',
    ]);
  });

  it('Q2 has the optional "anything specific" box, with the brief\'s example as its placeholder, up to 300 characters', () => {
    expect(SPECIFIC).toEqual({
      label: "Is there anything specific you're looking for? (optional)",
      placeholder: 'For example: "I\'m looking for someone who has helped small businesses expand internationally."',
      max: 300,
    });
  });

  it('Q1 and Q2 are only for the member to see; what they offer and who they are is public', () => {
    expect(QUESTIONS.map(x => x.onlyYou)).toEqual([true, true, false, false]);
  });

  it('questionFor knows the four steps and nothing else', () => {
    expect(questionFor('q3')?.field).toBe('canOffer');
    for (const s of ['welcome', 'signup', 'profile', 'q5', '', null, undefined]) expect(questionFor(s)).toBeUndefined();
  });
});

describe('whether a question can be left', () => {
  it('needs one answer at least', () => {
    expect(questionProblem(q('q1'), NONE)).toBe('empty');
    expect(questionProblem(q('q1'), DONE)).toBeNull();
  });

  it('"Something else" needs its words, and spaces are not words', () => {
    const other = { ...DONE, lookingToMeet: ['meet_other' as const] };
    expect(questionProblem(q('q1'), other)).toBe('own-words');
    expect(questionProblem(q('q1'), { ...other, meetOther: '   ' })).toBe('own-words');
    expect(questionProblem(q('q1'), { ...other, meetOther: 'bakers in Vienna' })).toBeNull();
  });

  it('words left in the box of an option that is not ticked do not matter', () => {
    expect(questionProblem(q('q3'), { ...DONE, offerOther: 'anything' })).toBeNull();
  });

  it('more than the limit (stale data) cannot be left either', () => {
    const four = { ...DONE, lookingToMeet: ['meet_investors', 'meet_founders_owners', 'meet_specialists', 'meet_advisors_experienced'] as OnboardingV2Answers['lookingToMeet'] };
    expect(questionProblem(q('q1'), four)).toBe('too-many');
  });

  it('says why a question cannot be left, in the server\'s own sentences: none ticked, too many, or no words', () => {
    expect(ANSWER_NEEDED).toBe('Select at least one answer.');
    expect(problemMessage(q('q1'), 'empty')).toBe('Select at least one answer.');
    expect(problemMessage(q('q1'), 'too-many')).toBe('Select up to three answers.');
    expect(problemMessage(q('q4'), 'too-many')).toBe('Select up to two answers.');
    expect(problemMessage(q('q2'), 'own-words')).toBe('Tell us what you are hoping to find.');
  });

  it('Q2\'s "anything specific" is optional', () => {
    expect(questionProblem(q('q2'), { ...DONE, findSpecific: null })).toBeNull();
  });

  it('firstIncomplete names the first question still open, optionally skipping one, and nothing when all are answered', () => {
    expect(firstIncomplete(NONE)).toBe('q1');
    expect(firstIncomplete({ ...DONE, canOffer: [] })).toBe('q3');
    expect(firstIncomplete({ ...DONE, lookingToMeet: [] }, 'q1')).toBeNull();
    expect(firstIncomplete({ ...DONE, lookingToMeet: [], selfKinds: [] }, 'q1')).toBe('q4');
    expect(firstIncomplete(DONE)).toBeNull();
  });
});

describe('which screen to show', () => {
  it('a new member starts at Welcome; welcome and sign up can always be shown', () => {
    expect(stepToShow(null, 'welcome', NONE)).toBe('welcome');
    expect(stepToShow('signup', 'welcome', NONE)).toBe('signup');
    expect(stepToShow('welcome', 'q3', DONE)).toBe('welcome');
  });

  it('never past the first question still unanswered: a deep link to the profile lands on what is missing', () => {
    expect(stepToShow('q3', 'welcome', NONE)).toBe('q1');
    expect(stepToShow('profile', 'welcome', { ...DONE, selfKinds: [] })).toBe('q4');
    expect(stepToShow('profile', 'welcome', DONE)).toBe('profile');
  });

  it('with no step asked for, or a step that is not one of the seven, resumes where the draft left off', () => {
    expect(stepToShow(null, 'q2', { ...NONE, lookingToMeet: ['meet_investors'] })).toBe('q2');
    for (const junk of ['confirm', 'q5', '', 'PROFILE']) expect(stepToShow(junk, 'q2', { ...NONE, lookingToMeet: ['meet_investors'] })).toBe('q2');
    expect(stepToShow(null, 'profile', NONE)).toBe('q1');
  });

  it('a step the flow\'s own buttons opened is shown as asked: Back from an [Edit] reaches the profile even with an answer left open', () => {
    const open = { ...DONE, lookingToMeet: ['meet_other' as const] };
    expect(stepToShow('profile', 'profile', open)).toBe('q1');
    expect(stepToShow('profile', 'profile', open, true)).toBe('profile');
    expect(stepToShow('q3', 'welcome', NONE, true)).toBe('q3');
    // Only a real step, even then.
    expect(stepToShow('confirm', 'q2', { ...NONE, lookingToMeet: ['meet_investors'] }, true)).toBe('q2');
  });

  it('steps run welcome, sign up, the four questions, the profile, and stop at both ends', () => {
    const forward = ['welcome', 'signup', 'q1', 'q2', 'q3', 'q4', 'profile'];
    expect(forward.map(s => stepAfter(s as never))).toEqual(['signup', 'q1', 'q2', 'q3', 'q4', 'profile', 'profile']);
    expect(forward.map(s => stepBefore(s as never))).toEqual(['welcome', 'welcome', 'signup', 'q1', 'q2', 'q3', 'q4']);
  });

  it('edit mode names one of the four questions or the profile, and nothing else', () => {
    for (const s of ['q1', 'q2', 'q3', 'q4', 'profile'] as const) expect(parseEdit(s)).toBe(s);
    for (const s of ['welcome', 'signup', 'q5', '', null, 'PROFILE']) expect(parseEdit(s)).toBeNull();
  });

  it('in edit mode a question saves when every other answer is there, else goes to the one still missing', () => {
    expect(editAction(DONE, 'q1')).toEqual({ kind: 'save' });
    expect(editAction({ ...DONE, lookingToMeet: [] }, 'q1')).toEqual({ kind: 'save' });
    expect(editAction({ ...DONE, hopingToFind: [] }, 'q1')).toEqual({ kind: 'next', step: 'q2' });
  });

  it('after the first confirm, a page they were sent here from is honoured only when it is a page of this app', () => {
    expect(safeRedirect('/people/3f2b8a4e')).toBe('/people/3f2b8a4e');
    expect(safeRedirect('/support')).toBe('/support');
    expect(safeRedirect('/')).toBe('/');
    // Another site, a protocol-relative or backslashed address, onboarding itself, or nothing: For You.
    for (const bad of [null, undefined, '', 'people/1', '//evil.example', '/\\evil.example', 'https://evil.example', '/onboarding', '/onboarding?step=q1', '/onboarding/x', ' /support', '/sup\nport']) {
      expect(safeRedirect(bad)).toBe('/');
    }
    expect(safeRedirect('/onboardingish')).toBe('/onboardingish');
  });

  // The router matches paths without regard to case, so /Onboarding opens onboarding too: it must never be where a
  // finished member is sent back to.
  it('onboarding itself is For You in any case: /Onboarding, /ONBOARDING?step=q1, /onBoarding/x', () => {
    for (const bad of ['/Onboarding', '/ONBOARDING', '/ONBOARDING?step=q1', '/onBoarding/x', '/OnBoarding#top']) {
      expect({ bad, to: safeRedirect(bad) }).toEqual({ bad, to: '/' });
    }
    expect(safeRedirect('/Onboardingish')).toBe('/Onboardingish');
  });

  it('a page opened straight onto edit mode returns to the profile, or to For You', () => {
    expect(editFallback('profile')).toBe('/profile');
    for (const s of ['q1', 'q2', 'q3', 'q4'] as const) expect(editFallback(s)).toBe('/');
  });
});

describe('ticking options', () => {
  it('ticks and unticks', () => {
    expect(toggleKey([], 'a', 3)).toEqual(['a']);
    expect(toggleKey(['a', 'b'], 'a', 3)).toEqual(['b']);
  });

  it('refuses a fourth (or a third, where two is the most), and Q3 has no limit', () => {
    expect(toggleKey(['a', 'b', 'c'], 'd', 3)).toEqual(['a', 'b', 'c']);
    expect(toggleKey(['a', 'b'], 'c', 2)).toEqual(['a', 'b']);
    expect(toggleKey(['a', 'b', 'c', 'd', 'e', 'f'], 'g', null)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('at the limit, one already ticked can still be unticked, so they can swap', () => {
    expect(toggleKey(['a', 'b', 'c'], 'b', 3)).toEqual(['a', 'c']);
  });

  it('a question\'s ticks and words land on that question\'s own fields and nowhere else', () => {
    expect(withKeys(NONE, q('q2'), ['find_cofounder'])).toEqual({ ...NONE, hopingToFind: ['find_cofounder'] });
    expect(withKeys(DONE, q('q4'), [])).toEqual({ ...DONE, selfKinds: [] });
    expect(withOwnWords(NONE, q('q3'), 'a bakery van')).toEqual({ ...NONE, offerOther: 'a bakery van' });
    expect(withOwnWords(DONE, q('q1'), '')).toEqual({ ...DONE, meetOther: '' });
  });

  it('LinkedIn\'s guess at Q4 is used only when they have not answered and have not touched it', () => {
    expect(guessedSelf(NONE, 'self_investor', false)).toEqual(['self_investor']);
    expect(guessedSelf(NONE, 'self_investor', true)).toBeNull();
    expect(guessedSelf(DONE, 'self_investor', false)).toBeNull();
    expect(guessedSelf(NONE, null, false)).toBeNull();
  });
});

describe('what goes to the server', () => {
  it('confirm sends the whole set, own words trimmed, and words for an option that is not ticked as null', () => {
    const body = confirmBody({
      ...DONE,
      lookingToMeet: ['meet_investors', 'meet_other'], meetOther: '  bakers in Vienna ',
      findOther: 'left over', findSpecific: '  a lead investor  ', offerOther: '', selfOther: '  ',
    });
    expect(body).toEqual({
      lookingToMeet: ['meet_investors', 'meet_other'], meetOther: 'bakers in Vienna',
      hopingToFind: ['find_funding'], findOther: null, findSpecific: 'a lead investor',
      canOffer: ['offer_advice_mentoring'], offerOther: null,
      selfKinds: ['self_founder_owner'], selfOther: null,
    });
    expect(confirmBody({ ...DONE, findSpecific: '   ' }).findSpecific).toBeNull();
  });

  it('confirm carries the profile only when there is one', () => {
    expect('profile' in confirmBody(DONE)).toBe(false);
    expect(confirmBody(DONE, { timezone: 'Asia/Kathmandu' }).profile).toEqual({ timezone: 'Asia/Kathmandu' });
  });

  // Final review, 21 Oct 2026 (C2), with the server's contract: a role, company or industry that is missing or null is
  // kept, "" clears it, and the name is never cleared. Emptying a stored field used to send null, which kept it, and the
  // member was told "Your changes are saved." for a change that was not made.
  const NOTHING_STORED = { jobTitle: null, company: null, industry: null };
  it('the profile half: what they typed, trimmed; a field never filled and left empty sends nothing; the LinkedIn photo only when kept', () => {
    expect(profileInput({ displayName: ' Ana Baker ', jobTitle: '', company: ' Crumb ', industry: '  ' }, NOTHING_STORED, 'Asia/Kathmandu', false)).toEqual({
      displayName: 'Ana Baker', company: 'Crumb', timezone: 'Asia/Kathmandu',
    });
    expect(profileInput({ displayName: 'Ana', jobTitle: '', company: '', industry: '' }, NOTHING_STORED, null, true)).toEqual({
      displayName: 'Ana', timezone: null, useLinkedinPhoto: true,
    });
  });

  it('a stored role, company or industry they emptied is sent as "", which clears it; one they left as it was is sent as it is', () => {
    const stored = { jobTitle: 'Head chef', company: 'Crumb', industry: 'Food and drink' };
    expect(profileInput({ displayName: 'Ana', jobTitle: '', company: '   ', industry: 'Food and drink' }, stored, 'Europe/Berlin', false)).toEqual({
      displayName: 'Ana', jobTitle: '', company: '', industry: 'Food and drink', timezone: 'Europe/Berlin',
    });
    // A stored value that is only spaces is no value: leaving it empty sends nothing.
    expect(profileInput({ displayName: 'Ana', jobTitle: '', company: '', industry: '' }, { jobTitle: '  ', company: null, industry: undefined }, null, false))
      .toEqual({ displayName: 'Ana', timezone: null });
    // A new value over a stored one is just the new value.
    expect(profileInput({ displayName: 'Ana', jobTitle: 'Pastry chef', company: 'Crumb', industry: '' }, stored, null, false))
      .toEqual({ displayName: 'Ana', jobTitle: 'Pastry chef', company: 'Crumb', industry: '', timezone: null });
  });

  it('never sends "" for the name: it is never cleared', () => {
    for (const displayName of ['', '   ']) {
      const sent = profileInput({ displayName, jobTitle: '', company: '', industry: '' }, { jobTitle: 'CEO', company: null, industry: null }, null, false);
      expect(sent.displayName).toBeNull();
    }
  });

  it('a draft save carries one question, its words (null when not ticked) and the next step; Q2 also its specific box', () => {
    expect(draftPatch(q('q1'), { ...DONE, meetOther: 'x' }, 'q2')).toEqual({ lookingToMeet: ['meet_investors'], meetOther: null, step: 'q2' });
    expect(draftPatch(q('q2'), { ...DONE, hopingToFind: ['find_other'], findOther: ' Vienna ', findSpecific: ' seed ' }, 'q3'))
      .toEqual({ hopingToFind: ['find_other'], findOther: 'Vienna', findSpecific: 'seed', step: 'q3' });
    expect(draftPatch(q('q3'), DONE, 'q4')).toEqual({ canOffer: ['offer_advice_mentoring'], offerOther: null, step: 'q4' });
    expect(draftPatch(q('q4'), DONE, 'profile')).toEqual({ selfKinds: ['self_founder_owner'], selfOther: null, step: 'profile' });
  });
});

describe('screen 7\'s fields', () => {
  it('what they typed wins, even a blank; then what the profile holds; then what LinkedIn suggests', () => {
    expect(profileValue('Head chef', 'CEO', 'Founder')).toEqual({ value: 'Head chef', fromLinkedin: false });
    expect(profileValue('', 'CEO', 'Founder')).toEqual({ value: '', fromLinkedin: false });
    expect(profileValue(undefined, 'CEO', 'Founder')).toEqual({ value: 'CEO', fromLinkedin: false });
    expect(profileValue(undefined, null, 'Founder')).toEqual({ value: 'Founder', fromLinkedin: true });
    expect(profileValue(undefined, '  ', ' Founder ')).toEqual({ value: 'Founder', fromLinkedin: true });
    expect(profileValue(undefined, null, null)).toEqual({ value: '', fromLinkedin: false });
  });

  it('"Your answers" reads back the short labels, with their own words in place of "Something else"', () => {
    expect(answerSummary(q('q1'), { ...DONE, lookingToMeet: ['meet_investors', 'meet_other'], meetOther: ' bakers in Vienna ' }))
      .toBe('Investors · “bakers in Vienna”');
    expect(answerSummary(q('q4'), DONE)).toBe('Founder or business owner');
    expect(answerSummary(q('q3'), NONE)).toBe('');
  });

  it('a calm line for each LinkedIn outcome that leaves something to type, and none when it all came through', () => {
    expect(linkedinNote('searching')).toMatch(/still/i);
    expect(linkedinNote('partial')).toMatch(/some of your details/i);
    expect(linkedinNote('not_found')).toMatch(/couldn't find/i);
    expect(linkedinNote('failed')).toMatch(/couldn't read/i);
    expect(linkedinNote('found')).toBeNull();
    expect(linkedinNote('none')).toBeNull();
    for (const s of ['searching', 'partial', 'not_found', 'failed'] as const) expect(linkedinNote(s)).not.toMatch(/\bRSN\b|ScrapingDog|error/i);
  });
});

// Final review, 21 Oct 2026 (C1): confirm lands an invited member on the page they followed, the tour opens there, and
// finishing it took them to For You, so on a phone they never saw the event. The flow now says where it put them.
describe('where the tour leaves a member: where the flow put them', () => {
  it('a page the flow opens itself carries LANDED in its history entry, and nothing else counts as landed', () => {
    expect(LANDED).toEqual({ landed: true });
    expect(isLanded(LANDED)).toBe(true);
    expect(isLanded({ ...LANDED, usr: 1 })).toBe(true);
    for (const state of [null, undefined, {}, { landed: 'true' }, { landed: 1 }, { openedByFlow: true }, 'landed', true]) {
      expect({ state, landed: isLanded(state) }).toEqual({ state, landed: false });
    }
  });

  it('going back through the history after an edit is remembered per member, so two people on one browser never share it', () => {
    expect(returnedKey('a1')).toBe('rsn_onb_v2_returned_a1');
    expect(returnedKey('a1')).not.toBe(returnedKey('b2'));
    expect(returnedKey('a1')).not.toBe(signupChoiceKey('a1'));
  });

  describe('the visit remembers it (this tab, through a refresh), and one tour uses it up', () => {
    const real = (global as { sessionStorage?: unknown }).sessionStorage;
    let store: Map<string, string>;
    const fake = (fail = false) => ({
      getItem: (k: string) => { if (fail) throw new Error('blocked'); return store.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (fail) throw new Error('blocked'); store.set(k, v); },
      removeItem: (k: string) => { if (fail) throw new Error('blocked'); store.delete(k); },
    });
    beforeEach(() => { store = new Map(); (global as { sessionStorage?: unknown }).sessionStorage = fake(); });
    afterAll(() => { (global as { sessionStorage?: unknown }).sessionStorage = real; });

    // Fix round 1 (M-1): the tour reads it as it draws (its last button says Done on such a page), so reading it uses
    // nothing up; the first press forgets it.
    it('is there once it is marked, reading it changes nothing, and it is gone once it is forgotten', () => {
      expect(hasReturned('a1')).toBe(false);
      markReturned('a1');
      expect(store.get('rsn_onb_v2_returned_a1')).toBe('1');
      expect(hasReturned('b2')).toBe(false);
      expect(hasReturned('a1')).toBe(true);
      expect(hasReturned('a1')).toBe(true);
      forgetReturned('a1');
      expect(hasReturned('a1')).toBe(false);
      expect(store.size).toBe(0);
    });

    it('with nobody signed in, nothing is marked, read or forgotten', () => {
      markReturned(undefined);
      expect(store.size).toBe(0);
      expect(hasReturned(undefined)).toBe(false);
      expect(() => forgetReturned(undefined)).not.toThrow();
    });

    it('with the browser\'s storage switched off, nothing breaks: the tour then goes to For You, as before', () => {
      (global as { sessionStorage?: unknown }).sessionStorage = fake(true);
      expect(() => markReturned('a1')).not.toThrow();
      expect(hasReturned('a1')).toBe(false);
      expect(() => forgetReturned('a1')).not.toThrow();
    });
  });
});

// Fix round 1 (M-7): an existing member's first edit makes the tour due (confirm stamps it whenever it was never seen),
// and its success toast sat over the tour's Skip on a phone for 2.5 seconds.
describe('whether a confirm opens the tour: whenever the member has never seen it', () => {
  it('a member who has never seen it gets it, due or not yet due; one who has seen it never again', () => {
    expect(tourOpensAfterConfirm({ pending: false, seenAt: null, outcome: null })).toBe(true);
    expect(tourOpensAfterConfirm({ pending: true, seenAt: null, outcome: null })).toBe(true);
    expect(tourOpensAfterConfirm({ pending: false, seenAt: '2026-10-20T09:00:00.000Z', outcome: 'skipped' })).toBe(false);
    expect(tourOpensAfterConfirm({ pending: false, seenAt: '2026-10-20T09:00:00.000Z', outcome: 'completed' })).toBe(false);
  });
});

describe('the choice on screen 2, remembered for the visit', () => {
  it('is kept per member, so two people on one browser never share it', () => {
    expect(signupChoiceKey('a1')).toBe('rsn_onb_v2_via_a1');
    expect(signupChoiceKey('a1')).not.toBe(signupChoiceKey('b2'));
  });

  it('reads back only the two choices; anything else is no choice', () => {
    expect(parseSignupChoice('linkedin')).toBe('linkedin');
    expect(parseSignupChoice('email')).toBe('email');
    for (const junk of [null, '', 'LinkedIn', 'yes', '1']) expect(parseSignupChoice(junk)).toBeNull();
  });
});

describe('the LinkedIn link', () => {
  it('is shown without the https://www. in front, so it fits a phone', () => {
    expect(linkedinForInput('https://www.linkedin.com/in/ana')).toBe('linkedin.com/in/ana');
    expect(linkedinForInput('http://linkedin.com/in/ana/')).toBe('linkedin.com/in/ana');
    expect(linkedinForInput(null)).toBe('');
  });

  it('an empty box or something that is not a profile link is answered at once, in the server\'s own words', () => {
    expect(LINKEDIN_EMPTY).toBe('Enter your LinkedIn profile link.');
    expect(LINKEDIN_EXAMPLE).toBe('Enter your LinkedIn profile link, for example linkedin.com/in/your-name');
    expect(linkedinInputProblem('   ')).toBe(LINKEDIN_EMPTY);
    for (const bad of ['Ana Baker', 'www.facebook.com/ana', 'linkedin.com/company/crumb', 'linkedin.com/in/']) {
      expect(linkedinInputProblem(bad)).toBe(LINKEDIN_EXAMPLE);
    }
  });

  it('any form of a profile link goes to the server, which has the last word', () => {
    for (const ok of ['linkedin.com/in/ana', 'https://uk.linkedin.com/in/ana/?x=1', 'WWW.LINKEDIN.COM/IN/Ana', 'https://www.linkedin.com/in/j%C3%B6rg']) {
      expect(linkedinInputProblem(ok)).toBeNull();
    }
  });
});

describe('the time zone', () => {
  const zones = ['Africa/Abidjan', 'America/New_York', 'Asia/Kathmandu', 'Asia/Karachi', 'Europe/Berlin', 'UTC'];

  it('is shown like "Asia/Kathmandu", with spaces where the name has underscores', () => {
    expect(zoneLabel('Asia/Kathmandu')).toBe('Asia/Kathmandu');
    expect(zoneLabel('America/New_York')).toBe('America/New York');
  });

  it('the list is searched by any part of the name, in any case, spaces or slashes alike', () => {
    expect(searchZones(zones, 'new york')).toEqual(['America/New_York']);
    expect(searchZones(zones, 'KATH')).toEqual(['Asia/Kathmandu']);
    expect(searchZones(zones, 'asia/ka')).toEqual(['Asia/Kathmandu', 'Asia/Karachi']);
    expect(searchZones(zones, 'asia ka')).toEqual(['Asia/Kathmandu', 'Asia/Karachi']);
    expect(searchZones(zones, '  ')).toEqual(zones);
    expect(searchZones(zones, 'atlantis')).toEqual([]);
  });

  it('only a real zone is ever sent: the runtime\'s own check, and an offset is not a zone', () => {
    for (const ok of ['Asia/Kathmandu', 'Asia/Katmandu', 'America/New_York', 'UTC']) expect(isRealZone(ok)).toBe(true);
    for (const bad of ['Mars/Olympus', '+05:45', '', null, undefined, 'Asia/Kathmandu; DROP']) expect(isRealZone(bad)).toBe(false);
  });

  it('a zone the runtime still knows by its old name is shown by the name people use now ("Asia/Kathmandu", "Asia/Kolkata")', () => {
    expect(currentZoneName('Asia/Katmandu')).toBe('Asia/Kathmandu');
    expect(currentZoneName('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(currentZoneName('Asia/Saigon')).toBe('Asia/Ho_Chi_Minh');
    expect(currentZoneName('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(currentZoneName('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('the list is every zone the runtime knows, by today\'s names, once each, with the current one in it, and never empty', () => {
    const list = zoneList('Asia/Kathmandu');
    expect(list).toContain('Europe/Berlin');
    expect(list).toContain('Asia/Kathmandu');
    expect(list).toContain('Asia/Kolkata');
    expect(list).not.toContain('Asia/Katmandu');
    expect(list).not.toContain('Asia/Calcutta');
    expect(new Set(list).size).toBe(list.length);
    for (const z of list) expect(isRealZone(z)).toBe(true);
    // Searching for the name people know finds it.
    expect(searchZones(list, 'kathmandu')).toEqual(['Asia/Kathmandu']);
    expect(searchZones(list, 'kolkata')).toEqual(['Asia/Kolkata']);
    expect(zoneList('Asia/Katmandu')).toContain('Asia/Kathmandu');
    expect(zoneList(null).length).toBeGreaterThan(0);
  });
});

describe('what a member is told when a request fails', () => {
  const FALLBACK = 'We could not save that. Please try again.';
  const refused = (status: number, error: { message?: unknown; details?: unknown } = {}) =>
    ({ isAxiosError: true, response: { status, data: { success: false, error } } });

  it('no answer at all is a lost connection, never the library\'s words', () => {
    expect(onboardingError({ isAxiosError: true, code: 'ERR_NETWORK', request: {} }, FALLBACK)).toBe('Connection lost. Check your internet and try again.');
    expect(onboardingError(new TypeError('x is undefined'), FALLBACK)).toBe(FALLBACK);
  });

  it('429 passes on the server\'s sentence (the LinkedIn one says how long), or asks them to slow down', () => {
    expect(onboardingError(refused(429, { message: 'Please wait a few minutes before trying another LinkedIn link.' }), FALLBACK))
      .toBe('Please wait a few minutes before trying another LinkedIn link.');
    expect(onboardingError(refused(429), FALLBACK)).toBe('Slow down a moment, then try again.');
  });

  it('400 gives the first field\'s sentence, never "Validation failed"', () => {
    expect(onboardingError(refused(400, {
      message: 'Validation failed', details: { url: ['Enter your LinkedIn profile link, for example linkedin.com/in/your-name'] },
    }), FALLBACK)).toBe('Enter your LinkedIn profile link, for example linkedin.com/in/your-name');
    expect(onboardingError(refused(400, { message: 'Validation failed' }), FALLBACK)).toBe(FALLBACK);
    expect(onboardingError(refused(400, { message: 'Validation failed', details: { x: [] } }), FALLBACK)).toBe(FALLBACK);
  });

  it('anything else is the caller\'s own sentence', () => {
    for (const status of [401, 403, 404, 500, 503]) {
      expect(onboardingError(refused(status, { message: 'User with id 3f2b8a4e-1c9d not found' }), FALLBACK)).toBe(FALLBACK);
    }
  });
});

describe('where a refusal from confirm is shown: on the thing it is about', () => {
  const FALLBACK = "We couldn't save your answers. Please try again.";
  const refused = (details: Record<string, string[]>) =>
    ({ isAxiosError: true, response: { status: 400, data: { success: false, error: { message: 'Validation failed', details } } } });

  it('a list or a key not shown belongs to its question', () => {
    expect(confirmProblem(refused({ lookingToMeet: ['Select at least one answer.'] }), FALLBACK))
      .toEqual({ message: 'Select at least one answer.', question: 'q1', ownWords: false, field: null });
    expect(confirmProblem(refused({ 'canOffer.0': ['Choose one of the answers shown.'] }), FALLBACK))
      .toEqual({ message: 'Choose one of the answers shown.', question: 'q3', ownWords: false, field: null });
    expect(confirmProblem(refused({ findSpecific: ['Keep this under 300 characters.'] }), FALLBACK).question).toBe('q2');
  });

  it('missing own words belong to that question\'s box', () => {
    expect(confirmProblem(refused({ selfOther: ['Tell us how you would describe yourself.'] }), FALLBACK))
      .toEqual({ message: 'Tell us how you would describe yourself.', question: 'q4', ownWords: true, field: null });
  });

  it('a profile field belongs to that field on screen 7, the time zone included', () => {
    expect(confirmProblem(refused({ 'profile.timezone': ['Choose your time zone from the list, for example Asia/Kathmandu.'] }), FALLBACK))
      .toEqual({ message: 'Choose your time zone from the list, for example Asia/Kathmandu.', question: null, ownWords: false, field: 'timezone' });
    expect(confirmProblem(refused({ 'profile.company': ['Keep this under 120 characters.'] }), FALLBACK).field).toBe('company');
  });

  it('anything else, a lost connection or a refusal about nothing on screen, belongs to the screen as a whole', () => {
    expect(confirmProblem({ isAxiosError: true, request: {} }, FALLBACK))
      .toEqual({ message: 'Connection lost. Check your internet and try again.', question: null, ownWords: false, field: null });
    // An unknown field is a bug in this client, in Zod's own words: never shown to a member.
    expect(confirmProblem(refused({ _root: ["Unrecognized key(s) in object: 'x'"] }), FALLBACK))
      .toEqual({ message: FALLBACK, question: null, ownWords: false, field: null });
    expect(onboardingError(refused({ _root: ["Unrecognized key(s) in object: 'x'"] }), FALLBACK)).toBe(FALLBACK);
    expect(confirmProblem(new Error('boom'), FALLBACK)).toEqual({ message: FALLBACK, question: null, ownWords: false, field: null });
  });
});
