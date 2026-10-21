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
  created_at: new Date(), updated_at: new Date(), match_count: 3, asked_count: 1,
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

  it('orders active agents first, then newest — the member\'s latest agent is on top (7 Sep review)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await repo.listAgents('u-1');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/status = 'active'\)\s+DESC/);
    expect(sql).toMatch(/created_at DESC/);
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

  // 21 Sep 2026: naming `intent` in the INSERT and binding null for an agent a
  // member typed themselves took every hand-made agent down with a 500 —
  // `intent` is NOT NULL DEFAULT '{}', and an explicit null beats the default.
  // A mocked pool cannot enforce a constraint, so pin the bound value instead.
  it('never binds null for intent — an agent with no recorded origin is {}', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await repo.createAgent('u-1', { label: 'Developers', wantText: 'react developers' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).not.toContain(null);
    expect(params[5]).toBe('{}');
    // And the column keeps its default even if some future caller does pass null.
    expect(sql).toMatch(/COALESCE\(\$6::jsonb, '\{\}'::jsonb\)/);
  });

  it('records where a tick-box agent came from, as JSON', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await repo.createAgent('u-1', {
      label: 'Investors', wantText: 'seed investors',
      intent: { source: 'tickbox_v1', meetKey: 'investors' },
    });
    const [, params] = mockQuery.mock.calls[0];
    expect(JSON.parse(params[5] as string)).toEqual({ source: 'tickbox_v1', meetKey: 'investors' });
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
    // 22 Sep 2026: "already asked" is PER PERSON. Per-agent could not be told
    // the truth — only one pending request may exist per pair (migration 047),
    // so a second search calling the same person fresh handed them a button
    // that answered 409. The lookup is no longer scoped to one search.
    expect(sql).not.toMatch(/pk\.agent_id = a\.id/);
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

// A rescore replaces the stored set. Anyone the member already acted on must
// survive that sweep, whatever dropped them out of the candidate pool.
describe('a rescore never evicts someone you already asked', () => {
  it('spares matches that have a live introduction', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await repo.replaceMatches('a-1', []);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM agent_matches am/);
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM user_pokes p/);
    expect(sql).toMatch(/p\.status <> 'declined'/);
    // STICKINESS stays per-agent, and is the only thing that still is (22 Sep
    // 2026). State and counts became per-person because you cannot ask the same
    // person twice; where a person SITS is a different question — someone found
    // by the Developers search keeps their place on it, and does not get pinned
    // onto every other search as well.
    expect(sql).toMatch(/p\.agent_id = a\.id/);
  });

  it('still clears everyone else, so a stale match cannot linger', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await repo.replaceMatches('a-1', []);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE am\.agent_id = \$1/);
    expect(params).toEqual(['a-1']);
  });
});

// Ali, 6 Aug: "agent shows 1 still, but there were actually 2 inside". The card
// summarises the agent, so one number could not describe it honestly.
describe('an agent card accounts for everyone inside it', () => {
  it('reports both the outstanding and the already-asked counts', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] });
    const [a] = await repo.listAgents('u-1');
    expect(a.matchCount).toBe(3);
    expect(a.askedCount).toBe(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/AS match_count/);
    expect(sql).toMatch(/AS asked_count/);
  });

  it('splits on the same introduction test, so nobody is counted twice or lost', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] });
    await repo.listAgents('u-1');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM user_pokes p/);
    expect(sql).toMatch(/AND EXISTS \(\s*SELECT 1 FROM user_pokes p/);
    // A decline hides the person entirely, so it counts on neither side.
    expect((sql.match(/p\.status <> 'declined'/g) ?? []).length).toBe(2);
    // 22 Sep 2026 — neither side is scoped to one search's pokes any more, so
    // "already asked" means the same thing on every search a person appears on.
    expect((sql.match(/p\.agent_id = a\.id/g) ?? []).length).toBe(0);
  });

  it('carries both counts back from a status change too', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ status: 'paused' })] });
    const a = await repo.setStatus('a-1', 'u-1', 'paused');
    expect(a?.askedCount).toBe(1);
  });
});

describe('the searches onboarding made (onboarding v2, 21 Oct 2026)', () => {
  it('lists only the member\'s own, and only the ones onboarding made, with where each came from', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row({ id: 'a-1', intent: { source: 'onboarding_v2', meetKey: 'meet_investors' } }),
      row({ id: 'a-2', intent: { source: 'tickbox_v1', meetKey: 'investors' }, status: 'paused' }),
    ] });
    const agents = await repo.listOnboardingAgents('u-1');
    expect(agents).toEqual([
      { id: 'a-1', label: 'Developers', wantText: 'senior react developers', status: 'active', intent: { source: 'onboarding_v2', meetKey: 'meet_investors' } },
      { id: 'a-2', label: 'Developers', wantText: 'senior react developers', status: 'paused', intent: { source: 'tickbox_v1', meetKey: 'investors' } },
    ]);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE user_id = \$1/);
    expect(sql).toMatch(/intent->>'source' IN \('tickbox_v1', 'onboarding_v2'\)/);
    expect(params).toEqual(['u-1']);
  });

  it('a missing origin reads as none', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ intent: null })] });
    const [a] = await repo.listOnboardingAgents('u-1');
    expect(a.intent).toEqual({});
  });

  it('rewords one search, its origin included, and only the caller\'s own', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ label: 'Potters in Graz', want_text: 'potters in Graz' })] });
    const a = await repo.rewordAgent('a-1', 'u-1', {
      label: 'Potters in Graz', wantText: 'potters in Graz',
      intent: { source: 'onboarding_v2', meetKey: 'meet_other', text: 'potters in Graz' },
    });
    expect(a?.label).toBe('Potters in Graz');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(sql).toMatch(/intent = \$5::jsonb/);
    expect(params.slice(0, 4)).toEqual(['a-1', 'u-1', 'Potters in Graz', 'potters in Graz']);
    expect(JSON.parse(params[4] as string)).toEqual({ source: 'onboarding_v2', meetKey: 'meet_other', text: 'potters in Graz' });
  });

  it('rewording someone else\'s search finds nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.rewordAgent('a-1', 'u-2', { label: 'x', wantText: 'x', intent: {} })).toBeNull();
  });
});

describe('who paused a search (fix round 1, 21 Oct 2026)', () => {
  it('onboarding pausing a search marks it as paused by onboarding, and only pauses one that is searching', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ status: 'paused' })] });
    const a = await repo.pauseForOnboarding('a-1', 'u-1');
    expect(a?.status).toBe('paused');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET status = 'paused'/);
    expect(sql).toMatch(/intent = COALESCE\(intent, '\{\}'::jsonb\) \|\| '\{"pausedBy":"onboarding"\}'::jsonb/);
    expect(sql).toMatch(/WHERE id = \$1 AND user_id = \$2 AND status = 'active'/);
    expect(params).toEqual(['a-1', 'u-1']);
  });

  it('a search that was not searching is not paused by onboarding', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await repo.pauseForOnboarding('a-1', 'u-1')).toBeNull();
  });

  it('any other status change, the member\'s own included, clears that mark', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row({ status: 'paused' })] });
    await repo.setStatus('a-1', 'u-1', 'paused');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/intent = COALESCE\(intent, '\{\}'::jsonb\) - 'pausedBy'/);
  });
});

describe('rewording keeps who paused it', () => {
  it('the pausedBy mark survives new words', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    await repo.rewordAgent('a-1', 'u-1', { label: 'x', wantText: 'x', intent: { source: 'onboarding_v2', meetKey: 'meet_other', text: 'x' } });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/CASE WHEN intent \? 'pausedBy'/);
  });
});
