// ─── One newcomer bell per member, however many of their searches answer (25 Oct 2026) ───
//
// The 25 Oct review (ONB-01) lifted the limits: a member can now tick every kind of person, and each kind is
// a running search. A newcomer who answers three of one member's searches used to ring their bell three
// times, "Your … agent found someone" once per search. Now they hear once, from the search that fits the
// newcomer best; the others still hold the newcomer among their matches. Each search keeps its own 24-hour
// quiet time, so a member running several searches can still hear about several different people in a day.

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
const mockTo = jest.fn((_room: string) => ({ emit: (...a: unknown[]) => mockEmit(...a) }));
jest.mock('../../../index', () => ({ io: { to: (room: string) => mockTo(room) }, __esModule: true }));
const mockScoreNewcomer = jest.fn();
jest.mock('../../../services/matching/agent-matching.service', () => ({
  scoreNewcomerAgainstAgents: (...a: unknown[]) => mockScoreNewcomer(...a),
  __esModule: true,
}));

import { notifyMatchesOfNewUser } from '../../../services/matching/platform-match.service';

// An investor joins on a real address. Nobody else is an existing member, so only the searches can bell.
const NEWCOMER = {
  id: 'u-new', displayName: 'Iqbal', avatarUrl: null, professionalRole: ['Angel Investor'], jobTitle: null, company: null,
  expertiseText: 'early stage SaaS investing', whatICanHelpWith: null, whatICareAbout: null, goals: null, interests: null,
  myIntent: null, whoIWantToMeet: null, whyIWantToMeet: null, onboardingCompleted: true,
};

const gained = (agentId: string, ownerId: string, label: string, score: number) =>
  ({ agentId, ownerId, label, score, reason: `You're looking to meet ${label.toLowerCase()}` });

/** `belledToday`: the agent links that already rang their owner's bell in the last 24 hours. */
function arm(belledToday: string[] = []) {
  mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
    if (/FROM users u WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [NEWCOMER] });
    if (/SELECT profile_visible\b[\s\S]*?FROM users WHERE id = \$1/.test(sql)) {
      return Promise.resolve({ rows: [{ profile_visible: true, email: 'iqbal@gmail.com' }] });
    }
    if (/WHERE u\.id <> \$1/.test(sql)) return Promise.resolve({ rows: [] });
    if (/SELECT id FROM notifications/.test(sql)) {
      const link = params[1] as string | undefined;
      return Promise.resolve({ rows: link && belledToday.includes(link) ? [{ id: 'earlier' }] : [] });
    }
    if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: `n-${mockQuery.mock.calls.length}`, created_at: new Date() }] });
    return Promise.resolve({ rows: [] });
  });
}

/** [recipient, title, body, link] of every bell written. */
const bells = () => mockQuery.mock.calls
  .filter((c) => /INSERT INTO notifications/.test(String(c[0])))
  .map((c) => c[1] as unknown[]);

beforeEach(() => { mockQuery.mockReset(); mockEmit.mockReset(); mockTo.mockClear(); mockScoreNewcomer.mockReset(); });

describe('a newcomer who answers several of one member\'s searches', () => {
  it('rings that member\'s bell once, from the search that fits the newcomer best', async () => {
    arm();
    mockScoreNewcomer.mockResolvedValue([
      gained('a-founders', 'u-owner', 'Founders & business owners', 0.62),
      gained('a-investors', 'u-owner', 'Investors', 0.91),
      gained('a-advisors', 'u-owner', 'Advisors & mentors', 0.7),
    ]);
    expect(await notifyMatchesOfNewUser('u-new')).toBe(1);
    expect(bells()).toEqual([
      ['u-owner', 'Your Investors agent found someone', "You're looking to meet investors", '/agents/a-investors'],
    ]);
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockTo).toHaveBeenCalledWith('user:u-owner');
  });

  it('two members whose searches both answer each hear once', async () => {
    arm();
    mockScoreNewcomer.mockResolvedValue([
      gained('a-1', 'u-ana', 'Investors', 0.8),
      gained('a-2', 'u-bo', 'Investors', 0.75),
      gained('a-3', 'u-ana', 'Advisors & mentors', 0.6),
      gained('a-4', 'u-bo', 'Founders & business owners', 0.9),
    ]);
    expect(await notifyMatchesOfNewUser('u-new')).toBe(2);
    expect(bells().map((b) => [b[0], b[3]])).toEqual([
      ['u-ana', '/agents/a-1'],
      ['u-bo', '/agents/a-4'],
    ]);
  });

  it('when the best search already rang today, the next one that has not rings instead: still once', async () => {
    arm(['/agents/a-investors']);
    mockScoreNewcomer.mockResolvedValue([
      gained('a-investors', 'u-owner', 'Investors', 0.91),
      gained('a-advisors', 'u-owner', 'Advisors & mentors', 0.7),
      gained('a-founders', 'u-owner', 'Founders & business owners', 0.62),
    ]);
    expect(await notifyMatchesOfNewUser('u-new')).toBe(1);
    expect(bells().map((b) => b[3])).toEqual(['/agents/a-advisors']);
  });

  it('when every one of their searches already rang today, they are not belled again', async () => {
    arm(['/agents/a-investors', '/agents/a-advisors']);
    mockScoreNewcomer.mockResolvedValue([
      gained('a-investors', 'u-owner', 'Investors', 0.91),
      gained('a-advisors', 'u-owner', 'Advisors & mentors', 0.7),
    ]);
    expect(await notifyMatchesOfNewUser('u-new')).toBe(0);
    expect(bells()).toEqual([]);
  });
});
