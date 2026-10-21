// ─── No newcomer bells about an account no person can have (21 Oct 2026) ─────
//
// The final review of 21 Oct: production end-to-end runs complete first-time onboarding as throwaway
// members on reserved addresses (e2etest-…@example.com, …@rsn-e2e.invalid), and each completion belled
// real members "Someone new matches what you're looking for" (or "Your … agent found someone") about an
// account that is deleted minutes later. A reserved domain (RFC 2606 and RFC 6761: example.com, .org and
// .net, and anything under .test, .example, .invalid or .localhost) cannot hold a person's mailbox, so a
// newcomer on one is never announced, by the profile pass or by anyone's agent.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (c: { query: typeof mockQuery }) => unknown) => cb({ query: mockQuery }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/poke/poke.service', () => ({ sendPoke: jest.fn(), __esModule: true }));
const mockEmit = jest.fn();
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: (...a: unknown[]) => mockEmit(...a) }) }, __esModule: true }));
const mockScoreNewcomer = jest.fn();
jest.mock('../../../services/matching/agent-matching.service', () => ({
  scoreNewcomerAgainstAgents: (...a: unknown[]) => mockScoreNewcomer(...a),
  __esModule: true,
}));

import { notifyMatchesOfNewUser } from '../../../services/matching/platform-match.service';
import { isReservedTestAddress } from '../../../services/identity/reserved-address';

const base = {
  avatarUrl: null, jobTitle: null, company: null, whatICanHelpWith: null, whatICareAbout: null,
  goals: null, interests: null, whyIWantToMeet: null, onboardingCompleted: true,
};
// An investor joins; a founder who wants investors is a strong fit for them, so a bell is due.
const NEWCOMER = {
  ...base, id: 'u-new', displayName: 'Iqbal', professionalRole: ['Angel Investor'],
  expertiseText: 'early stage SaaS investing', myIntent: null, whoIWantToMeet: null,
};
const MEMBER = {
  ...base, id: 'u-member', displayName: 'Fatima', professionalRole: ['Founder'], expertiseText: null,
  whoIWantToMeet: 'investors and angels for my seed round', myIntent: 'raise funding for my SaaS startup',
};

/** The newcomer signed up with `email`; Fatima's search for investors would also want to hear. */
function arm(email: string) {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM users u WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [NEWCOMER] });
    if (/SELECT profile_visible\b[\s\S]*?FROM users WHERE id = \$1/.test(sql)) {
      return Promise.resolve({ rows: [{ profile_visible: true, email }] });
    }
    if (/WHERE u\.id <> \$1/.test(sql)) return Promise.resolve({ rows: [MEMBER] });
    if (/SELECT id FROM notifications/.test(sql)) return Promise.resolve({ rows: [] });
    if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'n1', created_at: new Date() }] });
    return Promise.resolve({ rows: [] });
  });
  mockScoreNewcomer.mockResolvedValue([
    { agentId: 'a-1', ownerId: 'u-owner', label: 'Investors', score: 0.9, reason: 'You\'re looking to meet investors' },
  ]);
}

const bellsWritten = () => mockQuery.mock.calls.filter((c) => /INSERT INTO notifications/.test(String(c[0])));

beforeEach(() => { mockQuery.mockReset(); mockEmit.mockReset(); mockScoreNewcomer.mockReset(); });

describe('isReservedTestAddress: an address no person can have', () => {
  it.each([
    'e2etest-ob2li-1729500000000@example.com',
    'someone@EXAMPLE.COM',
    'someone@mail.example.com',
    'someone@example.org',
    'someone@example.net',
    't10smoke-1@rsn-e2e.invalid',
    'loadtest_7@rsn-test.invalid',
    'anyone@invalid',
    'qa@staging.test',
    'qa@docs.example',
    'qa@localhost',
    'qa@box.localhost',
    '  someone@example.com  ',
    'someone@example.com.',
  ])('%s is reserved', (email) => {
    expect(isReservedTestAddress(email)).toBe(true);
  });

  it.each([
    'ana@gmail.com',
    'ali@getjacksapp.com',
    'delivered+label@resend.dev',
    'someone@notexample.com',
    'someone@example.co',
    'someone@example.com.au',
    'someone@invalid.com',
    'someone@test.com',
    'example.com@gmail.com',
    'someone@my-example.com',
    'no-at-sign.example.com',
    '',
    null,
    undefined,
  ])('%s is not', (email) => {
    expect(isReservedTestAddress(email)).toBe(false);
  });
});

describe('a newcomer on a reserved address is never announced', () => {
  it.each([
    'e2etest-ob2li-1729500000000@example.com',
    't8smoke-2@rsn-e2e.invalid',
    'E2ETEST-X@EXAMPLE.COM',
  ])('%s: no bell for anyone, and no agent is run for them', async (email) => {
    arm(email);
    expect(await notifyMatchesOfNewUser('u-new')).toBe(0);
    expect(bellsWritten()).toEqual([]);
    expect(mockScoreNewcomer).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a newcomer on a real address still bells the members whose search they answer, and their agents\' owners', async () => {
    arm('iqbal@gmail.com');
    expect(await notifyMatchesOfNewUser('u-new')).toBe(2);
    expect(mockScoreNewcomer).toHaveBeenCalledWith('u-new');
    expect(bellsWritten().map((c) => (c[1] as unknown[])[0])).toEqual(['u-owner', 'u-member']);
    expect(mockEmit).toHaveBeenCalledTimes(2);
  });

  it('reads the address in the same query as the visibility, so it costs no extra read', async () => {
    arm('iqbal@gmail.com');
    await notifyMatchesOfNewUser('u-new');
    const lookups = mockQuery.mock.calls.map((c) => String(c[0])).filter((s) => /FROM users WHERE id = \$1/.test(s));
    expect(lookups).toHaveLength(1);
    expect(lookups[0]).toMatch(/SELECT profile_visible, email FROM users WHERE id = \$1/);
  });
});
