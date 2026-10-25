// ─── Onboarding v2: what is read and what is written ─────────────────────────
//
// The state a screen draws from, the draft saved as the member moves, and the
// confirm that makes it real: the key and free-text columns, the text matching
// reads, the profile fields only when given, and the gate, in one transaction.

jest.mock('../../../config', () => ({
  __esModule: true,
  default: { enrichProvider: 'scrapingdog', scrapingdogApiKey: '', anthropicApiKey: '', onboardingChatModel: 'x' },
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockQuery = jest.fn();
const mockTx = jest.fn();
const mockTransaction = jest.fn((cb: (c: { query: typeof mockTx }) => unknown) => cb({ query: mockTx }));
jest.mock('../../../db', () => ({
  __esModule: true,
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: (c: { query: typeof mockTx }) => unknown) => mockTransaction(cb),
}));

// The prefill the onboarding state shows is the one source for "kept as LinkedIn had it".
const mockShownPrefill = jest.fn();
jest.mock('../../../services/onboarding/linkedin-v2', () => ({
  __esModule: true,
  ...jest.requireActual('../../../services/onboarding/linkedin-v2'),
  shownPrefill: (...a: unknown[]) => mockShownPrefill(...a),
}));

import { getState, saveDraft, confirm } from '../../../services/onboarding/answers-v2.repo';
import { confirmSchemaV2 } from '../../../services/onboarding/answers-v2.schema';
import { designationsWanted, normalizeDesignation } from '../../../services/matching/intent-signals';
import { MEET_V2_SIGNALS } from '../../../services/matching/option-signals';

const NOW = Date.now();

/** A users row joined with its intent profile and approval-time lookup, as getState selects it. */
const stateRow = (over: Record<string, unknown> = {}) => ({
  onboarding_status: 'not_started', onboarding_version: null,
  display_name: 'Jane Doe', avatar_url: null, job_title: null, company: null, industry: null, timezone: null,
  linkedin_url: null, tour_due_at: null, tour_seen_at: null, tour_outcome: null,
  onboarding_intent: null, looking_to_meet: [], can_offer: [], self_kinds: [], hoping_to_find: [],
  meet_other: null, find_other: null, find_specific: null, offer_other: null, self_other: null,
  draft: null, enriched: null, enrichment_status: null, enrichment_started_at: null, enrichment_completed_at: null,
  lookup_url: null, preload: null, last_onboarded_at: null, signup_stage: null,
  ...over,
});

describe('getState', () => {
  const answer = (row: Record<string, unknown>) => {
    mockQuery.mockResolvedValue({ rows: [stateRow(row)] });
    return getState('u-1');
  };

  it('a new member: nothing answered, nothing guessed', async () => {
    const s = await answer({});
    expect(s).toEqual({
      status: 'not_started', version: null, step: 'welcome',
      answers: {
        lookingToMeet: [], meetOther: null, hopingToFind: [], findOther: null, findSpecific: null,
        canOffer: [], offerOther: null, selfKinds: [], selfOther: null,
      },
      prefilledFromV1: false,
      profile: { displayName: 'Jane Doe', avatarUrl: null, jobTitle: null, company: null, industry: null, timezone: null, linkedinUrl: null },
      linkedin: { status: 'none', chosen: null },
      tour: { pending: false, seenAt: null, outcome: null },
    });
  });

  it('a v1 member opens v2 with their v1 answers, through the mapping', async () => {
    const s = await answer({
      onboarding_status: 'completed', onboarding_intent: 'find_investors',
      looking_to_meet: ['investors', 'event_community'], can_offer: ['mentoring_advice'], self_kinds: ['founders'],
    });
    expect(s.answers).toMatchObject({
      lookingToMeet: ['meet_investors'], hopingToFind: ['find_funding'],
      canOffer: ['offer_advice_mentoring'], selfKinds: ['self_founder_owner'],
    });
    expect(s.prefilledFromV1).toBe(true);
  });

  it('a v2 member sees their own answers and words, not a mapping', async () => {
    const s = await answer({
      onboarding_status: 'completed', onboarding_version: 2,
      looking_to_meet: ['meet_investors', 'meet_other'], meet_other: 'bakers in Vienna',
      hoping_to_find: ['find_funding'], find_specific: 'a seed lead',
      can_offer: ['offer_other'], offer_other: 'Japanese lessons',
      self_kinds: ['self_specialist'],
    });
    expect(s.answers).toEqual({
      lookingToMeet: ['meet_investors', 'meet_other'], meetOther: 'bakers in Vienna',
      hopingToFind: ['find_funding'], findOther: null, findSpecific: 'a seed lead',
      canOffer: ['offer_other'], offerOther: 'Japanese lessons',
      selfKinds: ['self_specialist'], selfOther: null,
    });
    expect(s.version).toBe(2);
    expect(s.prefilledFromV1).toBe(false);
  });

  it('a member part way through sees their draft first, and the rest from v1', async () => {
    const s = await answer({
      onboarding_status: 'in_progress', looking_to_meet: ['investors'], can_offer: ['investment'],
      draft: { lookingToMeet: ['meet_specialists'], step: 'q3' },
    });
    expect(s.answers.lookingToMeet).toEqual(['meet_specialists']);
    expect(s.answers.canOffer).toEqual(['offer_investment']);
    expect(s.step).toBe('q3');
  });

  it('a member who finished v2 sees what they have, over a draft they left', async () => {
    const s = await answer({
      onboarding_status: 'completed', onboarding_version: 2,
      looking_to_meet: ['meet_investors'], hoping_to_find: ['find_funding'], can_offer: ['offer_investment'], self_kinds: ['self_investor'],
      draft: { lookingToMeet: ['meet_specialists'] },
    });
    expect(s.answers.lookingToMeet).toEqual(['meet_investors']);
  });

  // Fix round 1 (M4): an edit-mode screen saves a draft and redraws from the
  // state. A draft saved after the member's last confirm is the newest thing
  // they said, so it is what they see; an older one, or one with no time, is not.
  const finished = {
    onboarding_status: 'completed', onboarding_version: 2, last_onboarded_at: new Date(NOW - 60_000),
    looking_to_meet: ['meet_investors'], hoping_to_find: ['find_funding'], can_offer: ['offer_investment'], self_kinds: ['self_investor'],
  };

  it('a completed member\'s draft saved after their last confirm is what the screens show', async () => {
    const s = await answer({ ...finished, draft: { canOffer: ['offer_introductions'], step: 'q3', savedAt: new Date(NOW).toISOString() } });
    expect(s.answers.canOffer).toEqual(['offer_introductions']);
    // Every question the draft did not touch is what they have.
    expect(s.answers.lookingToMeet).toEqual(['meet_investors']);
    expect(s.step).toBe('q3');
  });

  it('a draft from before their last confirm does not override what they have', async () => {
    const s = await answer({ ...finished, draft: { canOffer: ['offer_introductions'], savedAt: new Date(NOW - 120_000).toISOString() } });
    expect(s.answers.canOffer).toEqual(['offer_investment']);
  });

  it('the database clock\'s own format is read (microseconds and an offset)', async () => {
    const s = await answer({ ...finished, last_onboarded_at: new Date('2026-10-21T05:40:12.100Z'), draft: { canOffer: ['offer_introductions'], savedAt: '2026-10-21T10:40:12.123456+05:00' } });
    expect(s.answers.canOffer).toEqual(['offer_introductions']);
  });

  it('the time stamp never shows up as an answer', async () => {
    const s = await answer({ ...finished, draft: { canOffer: ['offer_introductions'], savedAt: new Date(NOW).toISOString() } });
    expect(JSON.stringify(s.answers)).not.toMatch(/savedAt/);
  });

  it('words are only shown with the option they belong to', async () => {
    const s = await answer({
      onboarding_status: 'completed', onboarding_version: 2,
      looking_to_meet: ['meet_investors'], meet_other: 'left over',
      hoping_to_find: ['find_funding'], can_offer: ['offer_investment'], self_kinds: ['self_investor'],
    });
    expect(s.answers.meetOther).toBeNull();
  });

  it('reads only the v2 draft, never a v1 draft beside it', async () => {
    mockQuery.mockResolvedValue({ rows: [stateRow({ draft: null })] });
    await getState('u-1');
    expect(mockQuery.mock.calls[0][0]).toMatch(/onboarding_draft->'v2' AS draft/);
  });

  it('carries the LinkedIn result for the address on their profile', async () => {
    const url = 'https://www.linkedin.com/in/jane-doe';
    const s = await answer({
      linkedin_url: url, enrichment_status: 'found',
      enriched: {
        profile: { fullName: 'Jane Doe', headline: 'Angel investor at Northwind', currentRole: 'Angel Investor', currentCompany: 'Northwind', industry: 'Finance', location: 'Oslo', photoUrl: null },
        confidence: 0.95, requestedLinkedinUrl: url, foundLinkedinUrl: url, enrichedAt: new Date(NOW).toISOString(), sources: [],
      },
    });
    expect(s.profile.linkedinUrl).toBe(url);
    expect(s.linkedin).toEqual({
      status: 'found',
      prefill: {
        displayName: 'Jane Doe', photoUrl: null, jobTitle: 'Angel Investor', company: 'Northwind', industry: 'Finance', location: 'Oslo',
        selfGuesses: ['self_investor'], selfGuess: 'self_investor',
      },
      chosen: null,
    });
  });

  // Fix round 1 (Important 2): "not found" belongs to the address it was for.
  it('a not-found for an earlier address is never reported for the address on the profile now', async () => {
    const s = await answer({
      linkedin_url: 'https://www.linkedin.com/in/jane-new', enrichment_status: 'not_found',
      enrichment_completed_at: new Date(NOW), lookup_url: 'https://www.linkedin.com/in/jane-old',
    });
    expect(s.linkedin).toEqual({ status: 'none', chosen: null });
    const same = await answer({
      linkedin_url: 'https://www.linkedin.com/in/jane-old', enrichment_status: 'not_found',
      enrichment_completed_at: new Date(NOW), lookup_url: 'https://www.linkedin.com/in/jane-old',
    });
    expect(same.linkedin).toEqual({ status: 'not_found', chosen: null });
  });

  // The 25 Oct review (ONB-03): how the member chose on screen 2 is the server's to say, so the LinkedIn
  // suggestions survive a new tab or another device. It is the last of the two stages the screen records.
  it('says how the member chose on screen 2: LinkedIn, email, or not yet', async () => {
    expect((await answer({ signup_stage: 'linkedin_connected' })).linkedin.chosen).toBe('linkedin');
    expect((await answer({ signup_stage: 'linkedin_skipped' })).linkedin.chosen).toBe('email');
    expect((await answer({ signup_stage: null })).linkedin.chosen).toBeNull();
  });

  it('reads the choice from the member\'s latest LinkedIn stage, in the same query', async () => {
    mockQuery.mockResolvedValue({ rows: [stateRow()] });
    await getState('u-1');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const flat = (mockQuery.mock.calls[0][0] as string).replace(/\s+/g, ' ');
    expect(flat).toMatch(/FROM onboarding_stage_events e WHERE e\.user_id = u\.id AND e\.stage IN \('linkedin_connected', 'linkedin_skipped'\) ORDER BY e\.created_at DESC LIMIT 1/);
    expect(flat).toMatch(/AS signup_stage/);
  });

  it('reads the address the last lookup ran for', async () => {
    mockQuery.mockResolvedValue({ rows: [stateRow()] });
    await getState('u-1');
    expect(mockQuery.mock.calls[0][0]).toMatch(/inferred_profile->'lastLookup'->>'linkedinUrl' AS lookup_url/);
  });

  it('the tour is due only for someone who has just finished', async () => {
    const s = await answer({ onboarding_status: 'completed', tour_due_at: new Date(NOW) });
    expect(s.tour.pending).toBe(true);
  });

  it('a member that does not exist is a 404', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(getState('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('saveDraft', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
    mockTx.mockResolvedValue({ rows: [] });
  });

  it('stamps the draft with when it was saved, by the database clock', async () => {
    await saveDraft('u-1', { canOffer: ['offer_introductions'] });
    const call = mockTx.mock.calls.find(c => /INSERT INTO user_intent_profiles/.test(c[0] as string))!;
    expect((call[0] as string).match(/jsonb_build_object\('savedAt', NOW\(\)\)/g)).toHaveLength(2);
  });

  it('merges into the v2 draft, leaving anything else in the draft alone', async () => {
    await saveDraft('u-1', { lookingToMeet: ['meet_investors'], step: 'q2' });
    const call = mockTx.mock.calls.find(c => /INSERT INTO user_intent_profiles/.test(c[0] as string))!;
    expect(call[0]).toMatch(/jsonb_set\(/);
    expect(call[0]).toMatch(/onboarding_draft->'v2'/);
    expect(JSON.parse(call[1][1] as string)).toEqual({ lookingToMeet: ['meet_investors'], step: 'q2' });
  });

  it('marks them in progress only from not started or update required', async () => {
    await saveDraft('u-1', { step: 'q1' });
    const call = mockTx.mock.calls.find(c => /onboarding_status = 'in_progress'/.test(c[0] as string))!;
    expect(call[0]).toMatch(/onboarding_status IN \('not_started', 'update_required'\)/);
  });

  it('never touches what other members are matched against', async () => {
    await saveDraft('u-1', { lookingToMeet: ['meet_investors'] });
    const sql = mockTx.mock.calls.map(c => c[0] as string).join('\n');
    expect(sql).not.toMatch(/who_i_want_to_meet|professional_role|looking_to_meet/);
  });
});

describe('confirm', () => {
  const FULL_ANSWERS = {
    lookingToMeet: ['meet_investors', 'meet_other'], meetOther: 'bakers in Vienna',
    hopingToFind: ['find_funding', 'find_friends_conversations'], findSpecific: 'a lead for my seed round',
    canOffer: ['offer_advice_mentoring', 'offer_friends_conversations'],
    selfKinds: ['self_founder_owner'],
  };
  const FULL = confirmSchemaV2.parse({
    ...FULL_ANSWERS,
    profile: { jobTitle: 'Founder & CEO', company: 'Vokt', timezone: 'Asia/Kathmandu' },
  });
  let before: Record<string, unknown>;

  beforeEach(() => {
    mockQuery.mockReset();
    mockTx.mockReset();
    mockTransaction.mockClear();
    before = {
      onboarding_status: 'in_progress', onboarding_version: null, looking_to_meet: [], meet_other: null,
      hoping_to_find: [], find_other: null, find_specific: null, can_offer: [], offer_other: null,
      self_kinds: [], self_other: null, job_title: null, industry: 'Software',
    };
    mockShownPrefill.mockReset();
    mockShownPrefill.mockResolvedValue(null);
    mockQuery.mockImplementation(() => Promise.resolve({ rows: [] }));
    mockTx.mockImplementation((sql: string) => (
      /FOR UPDATE/.test(sql) ? Promise.resolve({ rows: [before] }) : Promise.resolve({ rows: [] })
    ));
  });

  /** The UPDATE users statement and the value bound to one column. */
  const update = () => {
    const call = mockTx.mock.calls.find(c => /UPDATE users SET\s+looking_to_meet/.test(c[0] as string));
    if (!call) throw new Error('users was never updated');
    const sql = call[0] as string;
    const params = call[1] as unknown[];
    const value = (column: string) => {
      const m = new RegExp(`\\b${column} = (?:COALESCE\\(|NULLIF\\()?\\$(\\d+)`).exec(sql)
        ?? new RegExp(`\\b${column} = CASE[\\s\\S]*?ELSE (?:NULLIF\\()?\\$(\\d+)`).exec(sql);
      if (!m) throw new Error(`${column} is not written from a parameter`);
      return params[Number(m[1]) - 1];
    };
    return { sql, value };
  };

  it('writes everything in one transaction, with the member\'s row locked', async () => {
    await confirm('u-1', FULL);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockTx.mock.calls[0][0]).toMatch(/FOR UPDATE/);
    const writes = mockTx.mock.calls.map(c => c[0] as string).filter(s => /^\s*(UPDATE|INSERT)/.test(s));
    expect(writes.some(s => /UPDATE users/.test(s))).toBe(true);
    expect(writes.some(s => /INSERT INTO user_intent_profiles/.test(s))).toBe(true);
    // Nothing is written outside it.
    expect(mockQuery.mock.calls.map(c => c[0] as string).filter(s => /^\s*(UPDATE|INSERT)/.test(s))).toEqual([]);
  });

  it('stores the keys, the words and the version', async () => {
    await confirm('u-1', FULL);
    const { sql, value } = update();
    expect(value('looking_to_meet')).toEqual(['meet_investors', 'meet_other']);
    expect(value('meet_other')).toBe('bakers in Vienna');
    expect(value('hoping_to_find')).toEqual(['find_funding', 'find_friends_conversations']);
    expect(value('find_specific')).toBe('a lead for my seed round');
    expect(value('can_offer')).toEqual(['offer_advice_mentoring', 'offer_friends_conversations']);
    expect(value('self_kinds')).toEqual(['self_founder_owner']);
    expect(value('find_other')).toBeNull();
    expect(sql).toMatch(/onboarding_version = 2/);
  });

  it('writes the text matching reads, never a label', async () => {
    await confirm('u-1', FULL);
    const { value } = update();
    const wants = value('who_i_want_to_meet') as string;
    const intent = value('my_intent') as string;
    const offers = value('what_i_can_help_with') as string;
    const roles = value('professional_role') as string[];
    expect(wants).toContain(MEET_V2_SIGNALS.meet_investors.wantText);
    expect(wants).toContain('bakers in Vienna');
    expect(designationsWanted(wants).map(d => d.key)).toContain('investor');
    expect(intent).toMatch(/investors/);
    expect(intent).toContain('a lead for my seed round');
    expect(offers).toMatch(/mentoring/);
    for (const text of [wants, intent, offers]) expect(text).not.toMatch(/friends|conversations/);
    expect(roles.map(t => normalizeDesignation(t))).toContain('founder');
    expect(value('reasons_to_connect')).toEqual(['Raising funding']);
  });

  it('an offer of only friends and good conversations writes no offer text at all', async () => {
    await confirm('u-1', { ...FULL, canOffer: ['offer_friends_conversations'] });
    expect(update().value('what_i_can_help_with')).toBeNull();
  });

  // "I can share what I know from my work." says what that work is, from the title the profile holds after
  // this confirm: the one they sent, else the one already stored, and nothing once they emptied it.
  describe('sharing what they know from their work', () => {
    const offering = (profile: Record<string, unknown>) =>
      confirm('u-1', confirmSchemaV2.parse({ ...FULL_ANSWERS, canOffer: ['offer_knowledge'], profile }));

    it('names the title they confirmed', async () => {
      await offering({ jobTitle: 'Head of Pastry' });
      expect(update().value('what_i_can_help_with')).toBe('knowledge from my work as Head of Pastry');
    });

    it('names the title already on their profile when they sent none', async () => {
      before.job_title = 'Data Engineer';
      await offering({});
      expect(update().value('what_i_can_help_with')).toBe('knowledge from my work as Data Engineer');
    });

    it('says their profession once they emptied the title', async () => {
      before.job_title = 'Data Engineer';
      await offering({ jobTitle: '' });
      expect(update().value('what_i_can_help_with')).toBe('knowledge from my profession');
    });
  });

  it('a missing industry never blanks the stored one; profile fields are written only when given', async () => {
    await confirm('u-1', { ...FULL, profile: {} });
    const { sql, value } = update();
    // Not given (null) keeps the column; given empty ('') clears it; anything else is written.
    for (const column of ['industry', 'job_title', 'company']) {
      expect(sql).toMatch(new RegExp(`\\b${column} = CASE WHEN \\$(\\d+)::text IS NULL THEN ${column} ELSE NULLIF\\(\\$\\1, ''\\) END`));
    }
    expect(sql).toMatch(/timezone = COALESCE\(\$\d+, timezone\)/);
    expect(sql).toMatch(/display_name = COALESCE\(\$\d+, display_name\)/);
    expect(value('industry')).toBeNull();
    expect(value('timezone')).toBeNull();
    expect(value('job_title')).toBeNull();
    expect(value('company')).toBeNull();
    expect(value('display_name')).toBeNull();
  });

  // The shared contract (final review, 21 Oct 2026): a member who empties their role, company or industry
  // on screen 7 sends "", and it is cleared. Left out or null keeps it. The name can never be cleared.
  describe('emptying a field on the profile screen', () => {
    const confirmWith = (profile: Record<string, unknown>) =>
      confirm('u-1', confirmSchemaV2.parse({ ...FULL_ANSWERS, profile }));

    it('an emptied role, company and industry are cleared: "" is sent, and NULLIF stores NULL', async () => {
      await confirmWith({ jobTitle: '', company: '  ', industry: '' });
      const { value } = update();
      expect(value('job_title')).toBe('');
      expect(value('company')).toBe('');
      expect(value('industry')).toBe('');
    });

    it('left out or null, they are kept: null is sent, and the column keeps its value', async () => {
      await confirmWith({ jobTitle: null, industry: null });
      const { value } = update();
      expect(value('job_title')).toBeNull();
      expect(value('company')).toBeNull();
      expect(value('industry')).toBeNull();
    });

    it('a blank name is kept, never cleared', async () => {
      await confirmWith({ displayName: '   ' });
      const { sql, value } = update();
      expect(value('display_name')).toBeNull();
      expect(sql).toMatch(/display_name = COALESCE\(\$\d+, display_name\)/);
    });

    it('a cleared title keeps where the old one came from, as a profile save does', async () => {
      await confirmWith({ jobTitle: '' });
      expect(update().sql).toMatch(/job_title_source = CASE WHEN \$(\d+)::text IS NULL OR \$\1 = '' THEN job_title_source ELSE \$\d+ END/);
      expect(mockShownPrefill).not.toHaveBeenCalled();
    });

    it('a specialist who cleared their title is no longer known by the stored one', async () => {
      before.job_title = 'Data Engineer';
      await confirm('u-1', confirmSchemaV2.parse({ ...FULL_ANSWERS, selfKinds: ['self_specialist'], profile: { jobTitle: '' } }));
      expect(update().value('professional_role')).not.toContain('Data Engineer');
    });

    it('a cleared industry is cleared for the live-event matcher too', async () => {
      await confirmWith({ industry: '' });
      const call = mockTx.mock.calls.find(c => /INSERT INTO user_intent_profiles/.test(c[0] as string))!;
      expect(JSON.parse((call[1] as string[])[1]).userIndustry).toBeNull();
    });
  });

  it('writes the profile fields that were given', async () => {
    await confirm('u-1', { ...FULL, profile: { ...FULL.profile, industry: 'Food and drink', displayName: 'Jane Q. Doe' } });
    const { value } = update();
    expect(value('industry')).toBe('Food and drink');
    expect(value('timezone')).toBe('Asia/Kathmandu');
    expect(value('company')).toBe('Vokt');
    expect(value('display_name')).toBe('Jane Q. Doe');
  });

  it('a corrected name also corrects first and last name', async () => {
    await confirm('u-1', { ...FULL, profile: { displayName: 'Jane Q. Doe' } });
    const call = mockTx.mock.calls.find(c => /UPDATE users SET\s+looking_to_meet/.test(c[0] as string))!;
    expect(call[1]).toEqual(expect.arrayContaining(['Jane', 'Q. Doe']));
  });

  const shown = (jobTitle: string | null) => ({
    displayName: 'Jane', photoUrl: null, jobTitle, company: null, industry: null, location: null, selfGuess: null,
  });

  it('a title kept as the LinkedIn prefill showed it is inferred; one they typed is stated', async () => {
    mockShownPrefill.mockResolvedValue(shown('founder & ceo'));
    await confirm('u-1', FULL);
    expect(mockShownPrefill).toHaveBeenCalledWith('u-1');
    expect(update().value('job_title_source')).toBe('inferred');
    mockTx.mockClear();
    mockShownPrefill.mockResolvedValue(shown('Chief Baker'));
    await confirm('u-1', FULL);
    expect(update().value('job_title_source')).toBe('stated');
  });

  // Fix round 1 (M3): only the prefill the state shows counts, so a result the
  // member never saw (another address, a stale one) never makes it inferred.
  it('with no prefill shown, a title is stated whatever an old result said', async () => {
    mockShownPrefill.mockResolvedValue(null);
    await confirm('u-1', FULL);
    expect(update().value('job_title_source')).toBe('stated');
  });

  it('a prefill that could not be read leaves the title stated, and the confirm goes through', async () => {
    mockShownPrefill.mockRejectedValue(new Error('db hiccup'));
    await expect(confirm('u-1', FULL)).resolves.toMatchObject({ changed: true });
    expect(update().value('job_title_source')).toBe('stated');
  });

  it('a specialist\'s typed title is who they are; with none typed, the stored title is', async () => {
    await confirm('u-1', { ...FULL, selfKinds: ['self_specialist'], profile: { jobTitle: 'UX Designer' } });
    expect(update().value('professional_role')).toEqual(['UX Designer']);
    mockTx.mockClear();
    before.job_title = 'Data Engineer';
    await confirm('u-1', { ...FULL, selfKinds: ['self_specialist'], profile: {} });
    expect(update().value('professional_role')).toEqual(['Data Engineer']);
  });

  it('passes the gate: completed, onboarded, the tour opened once', async () => {
    await confirm('u-1', FULL);
    const { sql } = update();
    expect(sql).toMatch(/onboarding_status = 'completed'/);
    expect(sql).toMatch(/onboarding_completed = true/);
    expect(sql).toMatch(/last_onboarded_at = NOW\(\)/);
    expect(sql).toMatch(/tour_due_at = CASE WHEN tour_seen_at IS NULL THEN NOW\(\) ELSE tour_due_at END/);
  });

  it('feeds the live-event matcher, and clears only the v2 draft', async () => {
    await confirm('u-1', FULL);
    const call = mockTx.mock.calls.find(c => /INSERT INTO user_intent_profiles/.test(c[0] as string))!;
    expect(call[0]).toMatch(/onboarding_draft = user_intent_profiles\.onboarding_draft - 'v2'/);
    const intent = JSON.parse((call[1] as string[])[1]);
    expect(intent).toMatchObject({ source: 'tickbox_v2', userDesignation: 'founder' });
    expect(intent.desiredDesignations).toEqual(expect.arrayContaining(['investor']));
    expect(intent.desiredPeople).toEqual(expect.arrayContaining(['Investors', 'bakers in Vienna']));
  });

  it('knows a first completion, and a v1 member\'s first v2 confirm as a change', async () => {
    const first = await confirm('u-1', FULL);
    expect(first).toMatchObject({ firstCompletion: true, changed: true });
    before.onboarding_status = 'completed';
    before.looking_to_meet = ['investors'];
    const v1 = await confirm('u-1', FULL);
    expect(v1).toMatchObject({ firstCompletion: false, changed: true });
  });

  it('the same answers again are no change; different words are', async () => {
    Object.assign(before, {
      onboarding_status: 'completed', onboarding_version: 2,
      looking_to_meet: ['meet_other', 'meet_investors'], meet_other: 'bakers in Vienna',
      hoping_to_find: ['find_friends_conversations', 'find_funding'], find_specific: 'a lead for my seed round',
      can_offer: ['offer_advice_mentoring', 'offer_friends_conversations'], self_kinds: ['self_founder_owner'],
    });
    expect((await confirm('u-1', FULL)).changed).toBe(false);
    expect((await confirm('u-1', { ...FULL, meetOther: 'bakers in Graz' })).changed).toBe(true);
    expect((await confirm('u-1', { ...FULL, findSpecific: null })).changed).toBe(true);
  });

  it('a member that does not exist is a 404', async () => {
    mockTx.mockImplementation(() => Promise.resolve({ rows: [] }));
    await expect(confirm('nope', FULL)).rejects.toMatchObject({ statusCode: 404 });
  });
});
