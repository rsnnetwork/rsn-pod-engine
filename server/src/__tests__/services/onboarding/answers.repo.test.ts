// ─── Tick-box answers: what actually gets written ────────────────────────────
//
// The deck's rule is that nothing in the profile is a guess. These pin the two
// halves of that: only ticked or typed values are written, and they are written
// in a form the existing matcher can read — so a member who joined tonight and
// a member who joined in June can still find each other.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { getState, saveDraft, confirm, markTourSeen } from '../../../services/onboarding/answers.repo';
import { designationsWanted, normalizeDesignation } from '../../../services/matching/intent-signals';

const FULL = {
  intent: 'find_investors' as const,
  lookingToMeet: ['investors', 'advisors_mentors'] as const,
  canOffer: ['mentoring_advice'] as const,
  industries: ['software_ai'] as const,
  industryOther: null,
  selfKinds: ['founders'] as const,
  jobTitle: 'Founder & CEO',
  company: 'Vokt',
  about: 'Building an operating system for businesses.',
};

/** The UPDATE users statement and the values it was given. */
function updateCall() {
  const call = mockQuery.mock.calls.find(c => /UPDATE users SET\s+onboarding_intent/.test(c[0] as string));
  if (!call) throw new Error('users was never updated');
  return { sql: call[0] as string, params: call[1] as unknown[] };
}
const paramAfter = (sql: string, column: string, params: unknown[]) => {
  const m = new RegExp(`${column} = (?:COALESCE\\()?\\$(\\d+)`).exec(sql);
  if (!m) throw new Error(`${column} is not written`);
  return params[Number(m[1]) - 1];
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockImplementation((sql: string) => {
    if (/SELECT onboarding_status, onboarding_intent/.test(sql)) {
      return Promise.resolve({ rows: [{ onboarding_status: 'in_progress', onboarding_intent: null, looking_to_meet: null, can_offer: null, industries: null, self_kinds: null, industry_other: null, bio: null }] });
    }
    return Promise.resolve({ rows: [] });
  });
});

describe('confirm writes only what the member said', () => {
  it('stores the keys, so two members can be compared at all', async () => {
    await confirm('u-1', FULL as never);
    const { sql, params } = updateCall();
    expect(paramAfter(sql, 'onboarding_intent', params)).toBe('find_investors');
    expect(paramAfter(sql, 'looking_to_meet', params)).toEqual(['investors', 'advisors_mentors']);
    expect(paramAfter(sql, 'can_offer', params)).toEqual(['mentoring_advice']);
    expect(paramAfter(sql, 'self_kinds', params)).toEqual(['founders']);
  });

  it('writes words the matcher understands, never the labels', async () => {
    await confirm('u-1', FULL as never);
    const { sql, params } = updateCall();
    const wants = paramAfter(sql, 'who_i_want_to_meet', params) as string;
    const offers = paramAfter(sql, 'what_i_can_help_with', params) as string;
    const roles = paramAfter(sql, 'professional_role', params) as string[];

    // Ticking "Investors & VCs" has to make the scorer look for investors.
    expect(designationsWanted(wants).map(d => d.key)).toEqual(expect.arrayContaining(['investor', 'advisor']));
    // And saying "I am a founder" has to read back as one, or nobody
    // searching for founders will ever reach them.
    expect(roles.map(t => normalizeDesignation(t))).toContain('founder');
    expect(offers).toMatch(/mentoring/);
    // The raw label would be unusable here; make sure it is not what we stored.
    expect(wants).not.toBe('Investors & VCs');
  });

  it('never wipes something they typed elsewhere with silence', async () => {
    // about/jobTitle/company are COALESCEd: leaving them blank in the flow must
    // not erase a longer bio written on the profile page.
    const { sql } = await confirm('u-1', { ...FULL, about: null, jobTitle: null, company: null } as never)
      .then(() => updateCall());
    expect(sql).toMatch(/bio = COALESCE\(/);
    expect(sql).toMatch(/job_title = COALESCE\(/);
    expect(sql).toMatch(/company = COALESCE\(/);
  });

  it('feeds the live-event matcher too, which never reads professional_role', async () => {
    await confirm('u-1', FULL as never);
    const call = mockQuery.mock.calls.find(c => /INSERT INTO user_intent_profiles/.test(c[0] as string))!;
    const intent = JSON.parse((call[1] as string[])[1]);
    expect(intent.source).toBe('tickbox_v1');
    expect(intent.userDesignation).toBeTruthy();
    expect(intent.desiredDesignations).toEqual(expect.arrayContaining(['investor', 'advisor']));
  });

  it('clears the draft once the answers are real', async () => {
    await confirm('u-1', FULL as never);
    const call = mockQuery.mock.calls.find(c => /INSERT INTO user_intent_profiles/.test(c[0] as string))!;
    expect(call[0]).toMatch(/onboarding_draft = '\{\}'::jsonb/);
  });

  it('opens the wizard for someone finishing, and never for someone who has seen it', async () => {
    await confirm('u-1', FULL as never);
    expect(updateCall().sql).toMatch(/tour_due_at = CASE WHEN tour_seen_at IS NULL THEN NOW\(\) ELSE tour_due_at END/);
  });
});

describe('confirm knows when nothing actually changed', () => {
  it('reports no change when the same answers are sent again', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT onboarding_status, onboarding_intent/.test(sql)) {
        return Promise.resolve({ rows: [{
          onboarding_status: 'completed', onboarding_intent: 'find_investors',
          looking_to_meet: ['investors', 'advisors_mentors'], can_offer: ['mentoring_advice'],
          industries: ['software_ai'], self_kinds: ['founders'], industry_other: null, bio: null,
        }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await confirm('u-1', FULL as never);
    expect(r.changed).toBe(false);
    expect(r.firstCompletion).toBe(false);
  });

  it('treats an invite sign-up as a first completion, despite the old flag', async () => {
    // Invite and Google rows are created with onboarding_completed already
    // true, so only the STATUS can tell us whether they ever finished.
    const r = await confirm('u-1', FULL as never);
    expect(r.firstCompletion).toBe(true);
  });

  it('notices a changed answer', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT onboarding_status, onboarding_intent/.test(sql)) {
        return Promise.resolve({ rows: [{
          onboarding_status: 'completed', onboarding_intent: 'find_investors',
          looking_to_meet: ['investors'], can_offer: ['mentoring_advice'],
          industries: ['software_ai'], self_kinds: ['founders'], industry_other: null, bio: null,
        }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const r = await confirm('u-1', FULL as never);
    expect(r.changed).toBe(true);
  });
});

describe('the draft', () => {
  it('merges rather than replaces, so going back a step loses nothing', async () => {
    await saveDraft('u-1', { lookingToMeet: ['founders'] } as never);
    const call = mockQuery.mock.calls.find(c => /INSERT INTO user_intent_profiles/.test(c[0] as string))!;
    expect(call[0]).toMatch(/onboarding_draft \|\| \$2::jsonb/);
  });

  it('never touches the columns other members are matched against', async () => {
    await saveDraft('u-1', { lookingToMeet: ['founders'] } as never);
    const touched = mockQuery.mock.calls.map(c => c[0] as string).join('\n');
    expect(touched).not.toMatch(/who_i_want_to_meet/);
    expect(touched).not.toMatch(/professional_role/);
  });
});

describe('getState', () => {
  it('returns their own answers and their name, and nothing guessed about them', async () => {
    mockQuery.mockImplementation(() => Promise.resolve({ rows: [{
      onboarding_status: 'in_progress', display_name: 'Ana', avatar_url: 'https://x/a.png',
      tour_due_at: null, tour_seen_at: null, tour_outcome: null,
      onboarding_intent: null, looking_to_meet: null, can_offer: null, industries: null,
      industry_other: null, self_kinds: null, job_title: null, company: null, bio: null,
      draft: { lookingToMeet: ['founders'], step: 'q3' },
    }] }));
    const s = await getState('u-1');
    expect(s.displayName).toBe('Ana');
    expect(s.answers.lookingToMeet).toEqual(['founders']);
    expect(s.step).toBe('q3');
    expect(s.tour.pending).toBe(false);
    // The country-from-IP and company-from-email-domain guesses the old confirm
    // screen showed as fact have no way to reach this payload at all.
    expect(Object.keys(s)).not.toContain('country');
  });

  it('shows confirmed answers over a stale draft', async () => {
    mockQuery.mockImplementation(() => Promise.resolve({ rows: [{
      onboarding_status: 'completed', display_name: 'Ana', avatar_url: null,
      tour_due_at: new Date(), tour_seen_at: null, tour_outcome: null,
      onboarding_intent: 'get_advice', looking_to_meet: ['advisors_mentors'], can_offer: ['investment'],
      industries: ['software_ai'], industry_other: null, self_kinds: ['founders'],
      job_title: 'CEO', company: 'Vokt', bio: 'hello',
      draft: { lookingToMeet: ['founders'] },
    }] }));
    const s = await getState('u-1');
    expect(s.answers.lookingToMeet).toEqual(['advisors_mentors']);
    expect(s.tour.pending).toBe(true);
  });
});

describe('the wizard', () => {
  it('records how it was left, and a second device cannot overwrite that', async () => {
    await markTourSeen('u-1', 'skipped');
    const call = mockQuery.mock.calls.find(c => /tour_seen_at = COALESCE/.test(c[0] as string))!;
    expect(call[0]).toMatch(/tour_outcome = COALESCE\(tour_outcome, \$2\)/);
  });
});
