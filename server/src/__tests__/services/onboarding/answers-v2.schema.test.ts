// ─── Onboarding v2: what the server accepts ──────────────────────────────────
//
// Every question is "Select all that apply." (the 25 Oct review): at least one
// answer, no maximum, and a ceiling of 20 against a runaway request. A key sent
// twice is still one answer. "Something else" needs its words, and a time zone
// must be one a clock can actually show. Everything else is refused before the
// database.

import { draftSchemaV2, confirmSchemaV2, linkedinSchemaV2, skipSchemaV2 } from '../../../services/onboarding/answers-v2.schema';
import { canonicalTimeZone } from '../../../services/onboarding/time-zone';

// Every answer of Q1, Q2 and Q4, written out: the new 25 Oct answers included.
const ALL_MEET = [
  'meet_founders_owners', 'meet_investors', 'meet_advisors_experienced', 'meet_specialists',
  'meet_freelancers_consultants', 'meet_students_early_career', 'meet_managers_leaders', 'meet_hiring', 'meet_other',
];
const ALL_FIND = [
  'find_customers', 'find_funding', 'find_cofounder', 'find_friends_conversations',
  'find_new_role', 'find_advice_learning', 'find_hire', 'find_partners', 'find_other',
];
const ALL_SELF = [
  'self_founder_owner', 'self_employee', 'self_manager_leader', 'self_investor', 'self_advisor_experienced',
  'self_specialist', 'self_freelancer_consultant', 'self_student_early_career', 'self_other',
];
/** 21 keys: every answer twice, then three more. Only a broken or hostile client sends this. */
const twentyOne = (all: string[]) => [...all, ...all, ...all.slice(0, 3)];
/** 20 keys: the most a list may carry. */
const twenty = (all: string[]) => [...all, ...all, ...all.slice(0, 2)];

const GOOD = {
  lookingToMeet: ['meet_investors'],
  meetOther: null,
  hopingToFind: ['find_funding'],
  findOther: null,
  findSpecific: null,
  canOffer: ['offer_advice_mentoring'],
  offerOther: null,
  selfKinds: ['self_founder_owner'],
  selfOther: null,
};
const issues = (r: { success: boolean; error?: { issues: Array<{ path: (string | number)[]; message: string }> } }) =>
  r.success ? [] : r.error!.issues.map(i => `${i.path.join('.')}: ${i.message}`);

describe('time zones', () => {
  it.each(['Asia/Kathmandu', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/GMT+5', 'America/Port-au-Prince'])(
    '%s is a real zone', (tz) => {
      expect(canonicalTimeZone(tz)).not.toBeNull();
    },
  );

  it.each(['Mars/Base', '+05:45', '-03:00', 'Asia/Kathmandu; DROP TABLE users', '', '   ', 'x'.repeat(60)])(
    '%j is not', (tz) => {
      expect(canonicalTimeZone(tz)).toBeNull();
    },
  );

  it('keeps the spelling the zone list uses, whatever the case it arrived in', () => {
    expect(canonicalTimeZone('europe/berlin')).toBe('Europe/Berlin');
    expect(canonicalTimeZone('  Europe/Berlin  ')).toBe('Europe/Berlin');
  });
});

describe('the draft: any part of the answers, as the member moves through', () => {
  it('takes a single answer and the step', () => {
    expect(draftSchemaV2.safeParse({ lookingToMeet: ['meet_investors'], step: 'q2' }).success).toBe(true);
    expect(draftSchemaV2.safeParse({}).success).toBe(true);
  });

  it('refuses a key that is not on the list, and a v1 key', () => {
    expect(draftSchemaV2.safeParse({ lookingToMeet: ['astronauts'] }).success).toBe(false);
    expect(draftSchemaV2.safeParse({ lookingToMeet: ['investors'] }).success).toBe(false);
  });

  it('accepts every meet, find and self option at once', () => {
    const r = draftSchemaV2.safeParse({ lookingToMeet: ALL_MEET, hopingToFind: ALL_FIND, selfKinds: ALL_SELF });
    expect(issues(r)).toEqual([]);
    expect(r.success && r.data).toMatchObject({ lookingToMeet: ALL_MEET, hopingToFind: ALL_FIND, selfKinds: ALL_SELF });
  });

  it('refuses 21 keys in a list, in words, and takes 20', () => {
    expect(issues(draftSchemaV2.safeParse({ lookingToMeet: twentyOne(ALL_MEET) }))).toEqual(['lookingToMeet: Choose from the answers shown.']);
    expect(draftSchemaV2.safeParse({ hopingToFind: twentyOne(ALL_FIND) }).success).toBe(false);
    expect(draftSchemaV2.safeParse({ selfKinds: twentyOne(ALL_SELF) }).success).toBe(false);
    expect(draftSchemaV2.safeParse({ lookingToMeet: twenty(ALL_MEET), hopingToFind: twenty(ALL_FIND), selfKinds: twenty(ALL_SELF) }).success).toBe(true);
  });

  it('still refuses duplicate keys: a tick sent twice is saved as one answer', () => {
    const r = draftSchemaV2.parse({ selfKinds: ['self_employee', 'self_employee', 'self_manager_leader'] });
    expect(r.selfKinds).toEqual(['self_employee', 'self_manager_leader']);
  });

  it('refuses words over their length', () => {
    expect(draftSchemaV2.safeParse({ meetOther: 'x'.repeat(121) }).success).toBe(false);
    expect(draftSchemaV2.safeParse({ meetOther: 'x'.repeat(120) }).success).toBe(true);
    expect(draftSchemaV2.safeParse({ findSpecific: 'x'.repeat(301) }).success).toBe(false);
    expect(draftSchemaV2.safeParse({ findSpecific: 'x'.repeat(300) }).success).toBe(true);
  });

  it('refuses a field it does not know, and a step that is not a v2 step', () => {
    expect(draftSchemaV2.safeParse({ intent: 'get_advice' }).success).toBe(false);
    expect(draftSchemaV2.safeParse({ step: 'q5' }).success).toBe(false);
  });

  it('does not care about minimums yet', () => {
    expect(draftSchemaV2.safeParse({ lookingToMeet: [] }).success).toBe(true);
  });
});

describe('confirm: the finished answers', () => {
  it('takes a complete set', () => {
    const r = confirmSchemaV2.safeParse(GOOD);
    expect(issues(r)).toEqual([]);
  });

  it.each([
    ['lookingToMeet', []],
    ['hopingToFind', []],
    ['canOffer', []],
    ['selfKinds', []],
  ])('needs at least one answer to %s', (field, value) => {
    expect(confirmSchemaV2.safeParse({ ...GOOD, [field]: value }).success).toBe(false);
  });

  it('accepts every meet, find and self option at once, and every offer', () => {
    const allOffers = [
      'offer_products_services', 'offer_investment', 'offer_join_build_team', 'offer_advice_mentoring',
      'offer_introductions', 'offer_friends_conversations', 'offer_knowledge', 'offer_referrals',
    ];
    const r = confirmSchemaV2.safeParse({
      ...GOOD,
      lookingToMeet: ALL_MEET, meetOther: 'bakers in Vienna',
      hopingToFind: ALL_FIND, findOther: 'a sailing crew',
      canOffer: allOffers,
      selfKinds: ALL_SELF, selfOther: 'a chef',
    });
    expect(issues(r)).toEqual([]);
    expect(r.success && r.data).toMatchObject({ lookingToMeet: ALL_MEET, hopingToFind: ALL_FIND, canOffer: allOffers, selfKinds: ALL_SELF });
  });

  it('refuses 21 keys in a list, and takes 20', () => {
    const words = { meetOther: 'bakers', findOther: 'a crew', selfOther: 'a chef' };
    expect(confirmSchemaV2.safeParse({ ...GOOD, ...words, lookingToMeet: twentyOne(ALL_MEET) }).success).toBe(false);
    expect(confirmSchemaV2.safeParse({ ...GOOD, ...words, hopingToFind: twentyOne(ALL_FIND) }).success).toBe(false);
    expect(confirmSchemaV2.safeParse({ ...GOOD, ...words, selfKinds: twentyOne(ALL_SELF) }).success).toBe(false);
    const most = confirmSchemaV2.safeParse({
      ...GOOD, ...words, lookingToMeet: twenty(ALL_MEET), hopingToFind: twenty(ALL_FIND), selfKinds: twenty(ALL_SELF),
    });
    expect(issues(most)).toEqual([]);
  });

  it('still refuses duplicate keys: a tick sent twice is one answer, in every list', () => {
    const r = confirmSchemaV2.parse({
      ...GOOD,
      lookingToMeet: ['meet_investors', 'meet_investors', 'meet_hiring'],
      hopingToFind: ['find_new_role', 'find_new_role'],
      selfKinds: ['self_employee', 'self_manager_leader', 'self_employee'],
    });
    expect(r.lookingToMeet).toEqual(['meet_investors', 'meet_hiring']);
    expect(r.hopingToFind).toEqual(['find_new_role']);
    expect(r.selfKinds).toEqual(['self_employee', 'self_manager_leader']);
  });

  it.each([
    ['lookingToMeet', 'meet_other', 'meetOther'],
    ['hopingToFind', 'find_other', 'findOther'],
    ['canOffer', 'offer_other', 'offerOther'],
    ['selfKinds', 'self_other', 'selfOther'],
  ])('"Something else" in %s needs its words', (field, key, textField) => {
    const without = confirmSchemaV2.safeParse({ ...GOOD, [field]: [key], [textField]: '   ' });
    expect(without.success).toBe(false);
    expect(issues(without).join('|')).toMatch(new RegExp(`^${textField}: Tell us`));
    const withWords = confirmSchemaV2.safeParse({ ...GOOD, [field]: [key], [textField]: 'bakers in Vienna' });
    expect(withWords.success).toBe(true);
  });

  it('words typed for an option that is no longer ticked are not kept', () => {
    const r = confirmSchemaV2.parse({ ...GOOD, meetOther: 'left over', offerOther: 'also left over' });
    expect(r.meetOther).toBeNull();
    expect(r.offerOther).toBeNull();
  });

  it('the specific line is kept whatever was ticked', () => {
    expect(confirmSchemaV2.parse({ ...GOOD, findSpecific: 'someone who exported to Japan' }).findSpecific).toBe('someone who exported to Japan');
  });

  it('cleans what was typed: control characters gone, spaces trimmed', () => {
    const r = confirmSchemaV2.parse({ ...GOOD, lookingToMeet: ['meet_other'], meetOther: '  bakers\u0000 in\u0007 Vienna  ' });
    expect(r.meetOther).toBe('bakers in Vienna');
  });

  // Fix round 1 (M2): a line break between two words is a space, never nothing,
  // or "Vienna\nor Graz" became "Viennaor Graz" and the place parser lost both.
  it('a line break or a tab between words becomes one space', () => {
    const r = confirmSchemaV2.parse({ ...GOOD, lookingToMeet: ['meet_other'], meetOther: 'bakers in Vienna\nor Graz', findSpecific: 'someone\twho\r\nexports' });
    expect(r.meetOther).toBe('bakers in Vienna or Graz');
    expect(r.findSpecific).toBe('someone who exports');
  });

  it('runs of spaces collapse to one', () => {
    expect(confirmSchemaV2.parse({ ...GOOD, findSpecific: 'a   lead    investor' }).findSpecific).toBe('a lead investor');
  });

  // Fix round 1 (M3): every refusal a member can cause says what to do, in words.
  it('a missing answer list says to choose an answer, not "Required"', () => {
    const { lookingToMeet: _omit, ...rest } = GOOD;
    const r = confirmSchemaV2.safeParse(rest);
    expect(issues(r)).toContain('lookingToMeet: Select at least one answer.');
  });

  it('a key that is not on the list says to choose one of the answers shown', () => {
    const r = confirmSchemaV2.safeParse({ ...GOOD, canOffer: ['astronauts'] });
    expect(issues(r).join('|')).toMatch(/canOffer\.0: Choose one of the answers shown\./);
  });

  it('the profile is optional, and a field left out stays out', () => {
    expect(confirmSchemaV2.parse(GOOD).profile).toEqual({});
    const r = confirmSchemaV2.parse({ ...GOOD, profile: { company: 'Vokt' } });
    expect(r.profile).toEqual({ company: 'Vokt' });
  });

  // The shared contract (final review, 21 Oct 2026): for the role, the company and the industry, a field
  // left out or sent as null keeps what is stored, and one sent empty ("" once trimmed) clears it. The
  // screen sends "" only when the member emptied a field that had a value. The name can never be cleared,
  // so a blank name keeps the stored one; a blank time zone keeps it too.
  it('an emptied role, company or industry is passed on as "", which clears it', () => {
    const r = confirmSchemaV2.parse({ ...GOOD, profile: { jobTitle: '', company: '   ', industry: '\n\t' } });
    expect(r.profile).toEqual({ jobTitle: '', company: '', industry: '' });
  });

  it('a role, company or industry left out, or sent as null, is passed on as not given', () => {
    expect(confirmSchemaV2.parse({ ...GOOD, profile: { jobTitle: null, company: null, industry: null } }).profile)
      .toEqual({ jobTitle: null, company: null, industry: null });
    expect(confirmSchemaV2.parse({ ...GOOD, profile: {} }).profile).toEqual({});
  });

  it('a role, company or industry is still tidied: a line break is a space, and the outer spaces go', () => {
    expect(confirmSchemaV2.parse({ ...GOOD, profile: { jobTitle: '  Head\nPastry   Chef ' } }).profile.jobTitle).toBe('Head Pastry Chef');
  });

  it('a blank name or time zone means "not given": the name can never be cleared', () => {
    const r = confirmSchemaV2.parse({ ...GOOD, profile: { displayName: '   ', timezone: '' } });
    expect(r.profile.displayName).toBeNull();
    expect(r.profile.timezone).toBeNull();
    expect(confirmSchemaV2.parse({ ...GOOD, profile: { displayName: '' } }).profile.displayName).toBeNull();
  });

  it('accepts a real time zone and refuses an invented one', () => {
    expect(confirmSchemaV2.parse({ ...GOOD, profile: { timezone: 'Asia/Kathmandu' } }).profile.timezone).not.toBeNull();
    const bad = confirmSchemaV2.safeParse({ ...GOOD, profile: { timezone: 'Mars/Base' } });
    expect(bad.success).toBe(false);
    expect(issues(bad).join('|')).toMatch(/^profile\.timezone: /);
  });

  it('holds profile fields to their columns', () => {
    expect(confirmSchemaV2.safeParse({ ...GOOD, profile: { displayName: 'x'.repeat(101) } }).success).toBe(false);
    expect(confirmSchemaV2.safeParse({ ...GOOD, profile: { industry: 'x'.repeat(101) } }).success).toBe(false);
    expect(confirmSchemaV2.safeParse({ ...GOOD, profile: { jobTitle: 'x'.repeat(121) } }).success).toBe(false);
  });

  it('refuses fields it does not know, at both levels', () => {
    expect(confirmSchemaV2.safeParse({ ...GOOD, intent: 'get_advice' }).success).toBe(false);
    expect(confirmSchemaV2.safeParse({ ...GOOD, profile: { linkedinUrl: 'x' } }).success).toBe(false);
  });

  it('refuses v1 keys', () => {
    expect(confirmSchemaV2.safeParse({ ...GOOD, lookingToMeet: ['investors'] }).success).toBe(false);
  });
});

describe('LinkedIn bodies', () => {
  it('connect needs an address, of a sane length', () => {
    expect(linkedinSchemaV2.safeParse({ url: 'linkedin.com/in/jane-doe' }).success).toBe(true);
    expect(linkedinSchemaV2.safeParse({}).success).toBe(false);
    expect(linkedinSchemaV2.safeParse({ url: '' }).success).toBe(false);
    expect(linkedinSchemaV2.safeParse({ url: 'x'.repeat(501) }).success).toBe(false);
  });

  it('a missing or empty address says what to enter, not "Required"', () => {
    expect(issues(linkedinSchemaV2.safeParse({}))).toEqual(['url: Enter your LinkedIn profile link.']);
    expect(issues(linkedinSchemaV2.safeParse({ url: '   ' }))).toEqual(['url: Enter your LinkedIn profile link.']);
    expect(issues(linkedinSchemaV2.safeParse({ url: 42 }))).toEqual(['url: Enter your LinkedIn profile link.']);
  });

  it('skip takes nothing', () => {
    expect(skipSchemaV2.safeParse({}).success).toBe(true);
    expect(skipSchemaV2.safeParse({ url: 'x' }).success).toBe(false);
  });
});
