// ─── Agent matching engine (Wave 2 core, 3 Aug 2026) ─────────────────────────

const mockQuery = jest.fn<any, any[]>();
const mockReplaceMatches = jest.fn<any, any[]>();
const mockListAgents = jest.fn<any, any[]>();
const mockListActive = jest.fn<any, any[]>();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/matching/agent.repo', () => ({
  replaceMatches: (...a: unknown[]) => mockReplaceMatches(...a),
  listAgents: (...a: unknown[]) => mockListAgents(...a),
  listActiveAgentsForMatching: (...a: unknown[]) => mockListActive(...a),
  __esModule: true,
}));

import { recomputeAgent, scoreNewcomerAgainstAgents } from '../../../services/matching/agent-matching.service';

const candidate = (over: Record<string, unknown> = {}) => ({
  id: 'u-dev', displayName: 'Dana', avatarUrl: null,
  professionalRole: ['Developer'], jobTitle: 'Senior Engineer', company: 'Acme',
  expertiseText: 'react typescript node', whatICanHelpWith: 'building web apps',
  whatICareAbout: null, goals: null, interests: null, myIntent: null,
  whoIWantToMeet: null, whyIWantToMeet: null,
  ...over,
});

const AGENT = { id: 'a-1', userId: 'u-owner', wantText: 'react developers to build my product', label: 'Developers' };

beforeEach(() => {
  mockQuery.mockReset(); mockReplaceMatches.mockReset();
  mockListAgents.mockReset(); mockListActive.mockReset();
  mockReplaceMatches.mockResolvedValue(undefined);
});

describe('recomputeAgent', () => {
  it('stores the people who fit what THIS agent is looking for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate(), candidate({ id: 'u-chef', professionalRole: ['Chef'], jobTitle: 'Pastry Chef', expertiseText: 'pastry', whatICanHelpWith: 'baking' })] });
    const n = await recomputeAgent(AGENT);
    expect(n).toBe(1);
    const [agentId, matches] = mockReplaceMatches.mock.calls[0];
    expect(agentId).toBe('a-1');
    expect(matches).toHaveLength(1);
    expect(matches[0].candidateUserId).toBe('u-dev');
    expect(matches[0].reason).toBeTruthy();
  });

  // Was: dropped anyone already introduced through this agent. That is what
  // made a person disappear from the agent that found them the moment you
  // asked to meet them (Ali, 5 Aug). Being asked is not an answer — they stay
  // in the pool and the UI badges them. A DECLINE is an answer, and is the one
  // thing that removes someone, in either direction.
  it('keeps someone you have merely asked, and drops only a decline', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await recomputeAgent(AGENT);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/user_pokes/);
    expect(sql).toMatch(/p\.status = 'declined'/);
    expect(sql).not.toMatch(/p\.agent_id/);
    // Both directions of the pair, so a decline sticks whoever sent it.
    expect(sql).toMatch(/p\.sender_id = \$1 AND p\.recipient_id = u\.id/);
    expect(sql).toMatch(/p\.sender_id = u\.id AND p\.recipient_id = \$1/);
    expect(params).toEqual(['u-owner']);
  });

  it('still excludes people already met and blocks, which are global facts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await recomputeAgent(AGENT);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/encounter_history/);
    expect(sql).toMatch(/user_blocks/);
  });

  it('an agent with no want text stores nothing rather than matching everyone', async () => {
    const n = await recomputeAgent({ ...AGENT, wantText: '   ' });
    expect(n).toBe(0);
    expect(mockReplaceMatches).toHaveBeenCalledWith('a-1', []);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('never throws when scoring fails — callers are fire and forget', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    await expect(recomputeAgent(AGENT)).resolves.toBe(0);
  });

  it('clears previous results so a count cannot go stale', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate({ id: 'u-chef', professionalRole: ['Chef'], expertiseText: 'pastry', whatICanHelpWith: 'baking', jobTitle: 'Baker' })] });
    await recomputeAgent(AGENT);
    expect(mockReplaceMatches).toHaveBeenCalledWith('a-1', []);
  });
});

describe('scoreNewcomerAgainstAgents', () => {
  it('adds a newcomer to every active agent that was looking for them', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [candidate()] })      // the newcomer's profile
      .mockResolvedValueOnce({ rows: [{ ok: true }] })     // not blocked / not met
      .mockResolvedValueOnce({ rows: [] });                // the upsert
    mockListActive.mockResolvedValueOnce([
      { id: 'a-1', userId: 'u-owner', wantText: 'react developers', label: 'Developers', status: 'active' },
    ]);

    const gained = await scoreNewcomerAgainstAgents('u-dev');
    expect(gained).toHaveLength(1);
    expect(gained[0]).toMatchObject({ agentId: 'a-1', ownerId: 'u-owner', label: 'Developers' });
    const upsert = mockQuery.mock.calls.find(c => /INSERT INTO agent_matches/i.test(String(c[0])));
    expect(upsert).toBeTruthy();
  });

  it('never matches an agent to its own owner', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate({ id: 'u-owner' })] });
    mockListActive.mockResolvedValueOnce([
      { id: 'a-1', userId: 'u-owner', wantText: 'react developers', label: 'Developers', status: 'active' },
    ]);
    const gained = await scoreNewcomerAgainstAgents('u-owner');
    expect(gained).toEqual([]);
  });

  it('skips agents the newcomer does not fit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [candidate({ professionalRole: ['Chef'], expertiseText: 'pastry', whatICanHelpWith: 'baking', jobTitle: 'Baker' })] });
    mockListActive.mockResolvedValueOnce([
      { id: 'a-1', userId: 'u-owner', wantText: 'react developers', label: 'Developers', status: 'active' },
    ]);
    const gained = await scoreNewcomerAgainstAgents('u-chef');
    expect(gained).toEqual([]);
  });

  it('never throws — it runs off the onboarding completion path', async () => {
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    await expect(scoreNewcomerAgainstAgents('u-x')).resolves.toEqual([]);
  });
});
