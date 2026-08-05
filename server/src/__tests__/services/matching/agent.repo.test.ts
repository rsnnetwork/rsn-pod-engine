// ─── Matching Agents repo (Wave 2 core, 3 Aug 2026) ──────────────────────────
//
// Plan: docs/superpowers/plans/2026-08-03-wave2-matching-agents.md
// A member has MANY agents (matching_agents.user_id is deliberately not unique),
// each an active reason to meet people, each with its own stored matches so the
// dashboard can show a real count instead of re-scoring the network per render.

const mockQuery = jest.fn<any, any[]>();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import * as repo from '../../../services/matching/agent.repo';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'a-1', user_id: 'u-1', label: 'Developers', want_text: 'senior react developers',
  intent: {}, matching_tags: ['react'], status: 'active',
  last_matched_at: null, archived_at: null,
  created_at: new Date(), updated_at: new Date(), match_count: 3,
  ...over,
});

beforeEach(() => mockQuery.mockReset());

describe('listAgents', () => {
  it('returns a member\'s agents with their stored match counts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row(), row({ id: 'a-2', label: 'Investors', match_count: 0 })] });
    const agents = await repo.listAgents('u-1');
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ id: 'a-1', label: 'Developers', matchCount: 3 });
    expect(agents[1]).toMatchObject({ label: 'Investors', matchCount: 0 });
    // The count must come from the stored table, never a live re-score.
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/agent_matches/);
  });

  it('excludes archived agents by default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await repo.listAgents('u-1');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/status <> 'archived'|status IN \('active', ?'paused'\)/);
  });
});

describe('createAgent', () => {
  it('inserts an active agent for the user and returns it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ label: 'Investors', want_text: 'seed investors' })] });
    const agent = await repo.createAgent('u-1', { label: 'Investors', wantText: 'seed investors' });
    expect(agent.label).toBe('Investors');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO matching_agents/i);
    expect(params).toEqual(expect.arrayContaining(['u-1', 'Investors', 'seed investors']));
  });
});

describe('updateAgent', () => {
  it('only updates the caller\'s own agent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ label: 'Renamed' })] });
    await repo.updateAgent('a-1', 'u-1', { label: 'Renamed' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(params[0]).toBe('a-1');
    expect(params[1]).toBe('u-1');
  });

  it('returns null when the agent is not the caller\'s', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(repo.updateAgent('a-1', 'someone-else', { label: 'x' })).resolves.toBeNull();
  });
});

describe('setStatus', () => {
  it('pauses, resumes and archives', async () => {
    for (const status of ['paused', 'active', 'archived'] as const) {
      mockQuery.mockReset();
      mockQuery.mockResolvedValueOnce({ rows: [row({ status })] });
      const a = await repo.setStatus('a-1', 'u-1', status);
      expect(a?.status).toBe(status);
      const [, params] = mockQuery.mock.calls[0];
      expect(params).toContain(status);
    }
  });

  it('stamps archived_at when archiving so nothing is hard deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ status: 'archived' })] });
    await repo.setStatus('a-1', 'u-1', 'archived');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/archived_at/);
  });
});

describe('replaceMatches', () => {
  it('writes the freshly scored set and clears what no longer fits', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await repo.replaceMatches('a-1', [
      { candidateUserId: 'u-2', score: 0.82, reason: 'they are a developer' },
      { candidateUserId: 'u-3', score: 0.51, reason: 'overlap' },
    ]);
    const sqls = mockQuery.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => /DELETE FROM agent_matches/i.test(s))).toBe(true);
    expect(sqls.some(s => /INSERT INTO agent_matches/i.test(s))).toBe(true);
  });

  it('clears the table when nothing matches, so a stale count cannot linger', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await repo.replaceMatches('a-1', []);
    const sqls = mockQuery.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => /DELETE FROM agent_matches/i.test(s))).toBe(true);
    expect(sqls.some(s => /INSERT INTO agent_matches/i.test(s))).toBe(false);
  });
});

describe('listActiveAgentsForMatching', () => {
  it('walks only active agents, never paused or archived ones', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await repo.listActiveAgentsForMatching();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/status = 'active'/);
  });
});

// ─── Someone you already asked stays on the agent (5 Aug 2026) ───────────────
//
// Ali asked jack rajaa to meet through his Developers agent and jack vanished
// from it. Deleting the match was deliberate (decision D3) and reads as a bug
// every time: nothing distinguishes "never matched" from "asked an hour ago".
describe('already-asked people keep their place, badged', () => {
  it('reports where the introduction got to, and who sent it', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await repo.listMatches('a-1');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/"pokeStatus"/);
    expect(sql).toMatch(/"pokeSentByOwner"/);
    // Newest poke wins, so a re-ask does not report a stale state.
    expect(sql).toMatch(/ORDER BY pk\.created_at DESC/);
  });

  it('hides a declined introduction — that one IS an answer', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await repo.listMatches('a-1');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/p\.status IS NULL OR p\.status <> 'declined'/);
  });

  it('counts only people still worth acting on', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] });
    await repo.listAgents('u-1');
    const [sql] = mockQuery.mock.calls[0];
    // Already asked: not outstanding, so not in the headline number.
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM user_pokes/);
    // Deactivated members were counted but never listed, so the dashboard and
    // the agent screen could disagree on the same agent.
    expect(sql).toMatch(/cu\.status = 'active'/);
  });

  it('applies the same count when an agent is paused or archived', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ status: 'archived' })] });
    await repo.setStatus('a-1', 'u-1', 'archived');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM user_pokes/);
  });
});
