// ─── The member's first matching agents, made at the end of onboarding ──────
//
// 13 Aug 2026 meeting: "First agent isn't auto-creating after onboarding as it
// should." It never did. Migration 087 seeded agents for members who already
// existed, one per designation they named; nothing on the onboarding path
// creates one for someone new. A member who finishes the chat today lands on
// an empty Suggestions page having just described exactly who they want.
//
// The service mirrors 087's convention so new and old members look the same:
// one agent per designation the member named, a single "People I want to meet"
// agent when they named none, and never a duplicate of something they have.
//
// 4 Sep 2026 (Ali): one MAIN agent searches at once; the other kinds of
// person named become paused drafts the member can resume.

const mockCreate = jest.fn<any, any[]>();
const mockList = jest.fn<any, any[]>();
const mockRecompute = jest.fn<any, any[]>();

jest.mock('../../../services/matching/agent.repo', () => ({
  createAgent: (...a: unknown[]) => mockCreate(...a),
  listAgents: (...a: unknown[]) => mockList(...a),
  __esModule: true,
}));
jest.mock('../../../services/matching/agent-matching.service', () => ({
  recomputeAgent: (...a: unknown[]) => mockRecompute(...a),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { createFirstAgents } from '../../../services/matching/first-agent.service';

let seq = 0;
beforeEach(() => {
  seq = 0;
  mockCreate.mockReset();
  mockCreate.mockImplementation(async (userId: string, input: { label: string; wantText: string; status?: string }) => ({
    id: `a-${++seq}`, userId, label: input.label, wantText: input.wantText, status: input.status ?? 'active',
  }));
  mockList.mockReset();
  mockList.mockResolvedValue([]);
  mockRecompute.mockReset();
  mockRecompute.mockResolvedValue(2);
});

const created = () => mockCreate.mock.calls.map(([, input]) => input as { label: string; wantText: string; status: 'active' | 'paused' });

describe('createFirstAgents', () => {
  it('creates one agent from what the member said they want, keeping their words', async () => {
    const agents = await createFirstAgents('u-1', {
      whoText: 'react developers who can build my product',
      whyText: 'I need help shipping',
    });
    expect(agents).toHaveLength(1);
    const [userId] = mockCreate.mock.calls[0];
    expect(userId).toBe('u-1');
    // One designation named: the label is that designation, and the want text
    // is the member's own sentence, so "react" still counts when scoring.
    expect(created()[0].label).toBe('Developers and engineers');
    expect(created()[0].wantText).toBe('react developers who can build my product');
    expect(created()[0].status).toBe('active');
  });

  it('splits several named designations into one agent each, like migration 087', async () => {
    const agents = await createFirstAgents('u-1', {
      whoText: 'founders and investors in climate tech',
      whyText: '',
    });
    expect(agents).toHaveLength(2);
    expect(created().map(c => c.label)).toEqual(['Founders', 'Investors']);
    // Each agent searches for exactly one kind of person; the combined sentence
    // would let a stray word pull the Founders agent toward investors.
    expect(created()[0].wantText).toBe('founders');
    expect(created()[1].wantText).toBe('investors');
    // The first kind they named is the main agent; the second is a draft.
    expect(created().map(c => c.status)).toEqual(['active', 'paused']);
    expect(agents.map(a => a.status)).toEqual(['active', 'paused']);
  });

  it('falls back to a single generic agent when no known designation is named', async () => {
    await createFirstAgents('u-1', { whoText: 'interesting people in Copenhagen', whyText: '' });
    expect(created()).toEqual([
      { label: 'People I want to meet', wantText: 'interesting people in Copenhagen', status: 'active' },
    ]);
  });

  it('uses why they came when they did not say who', async () => {
    await createFirstAgents('u-1', { whoText: '   ', whyText: 'looking for a technical co-founder' });
    expect(created()).toHaveLength(1);
    expect(created()[0].label).toBe('Founders');
    expect(created()[0].wantText).toBe('looking for a technical co-founder');
  });

  it('ignores a why that names nobody — a self-description must not become a search', async () => {
    // "I am an entrepreneur and builder" describes the member, not who they
    // want. Searching with it would find people LIKE them — the blob mistake
    // migration 087 undid. Better no agent than a wrong one.
    const agents = await createFirstAgents('u-1', {
      whoText: '',
      whyText: 'I am very much an entrepreneur, builder and tech generalist',
    });
    expect(agents).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('names agents in the order the member said them, and keeps the first four', async () => {
    await createFirstAgents('u-1', {
      whoText: 'business owners, founders, HR professionals, marketers and investors',
      whyText: '',
    });
    // Taxonomy order would have put Founders and Investors first and dropped
    // Business owners — the very first thing the member asked for.
    expect(created().map(c => c.label)).toEqual([
      'Business owners', 'Founders', 'HR and people leads', 'Marketing people',
    ]);
    // One searches; three wait as drafts.
    expect(created().map(c => c.status)).toEqual(['active', 'paused', 'paused', 'paused']);
  });

  it('searches the main agent immediately, so the member does not land on an empty page; drafts wait for resume', async () => {
    await createFirstAgents('u-1', { whoText: 'founders and investors', whyText: '' });
    expect(mockRecompute).toHaveBeenCalledTimes(1);
    expect(mockRecompute.mock.calls[0][0]).toMatchObject({ id: 'a-1', label: 'Founders', status: 'active' });
  });

  it('a member who already holds agents gets their first new one active and the rest as drafts', async () => {
    mockList.mockResolvedValue([{ id: 'old', label: 'Founders', status: 'active' }]);
    await createFirstAgents('u-1', { whoText: 'founders, investors, developers and designers', whyText: '' });
    expect(created().map(c => [c.label, c.status])).toEqual([
      ['Investors', 'active'], ['Developers and engineers', 'paused'], ['Designers', 'paused'],
    ]);
  });

  it('creates nothing when the member said nothing searchable', async () => {
    const agents = await createFirstAgents('u-1', { whoText: '   ', whyText: '' });
    expect(agents).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('never duplicates an agent a re-onboarding member already has', async () => {
    // A member routed back through onboarding (migration 083) who already got
    // a Founders agent from 087 must not end up with two of them.
    mockList.mockResolvedValue([{ id: 'old', label: 'Founders', status: 'active' }]);
    await createFirstAgents('u-1', { whoText: 'founders and investors', whyText: '' });
    expect(created().map(c => c.label)).toEqual(['Investors']);
  });

  it('adds no generic agent to a member who already has agents', async () => {
    mockList.mockResolvedValue([{ id: 'old', label: 'People I want to meet', status: 'active' }]);
    const agents = await createFirstAgents('u-1', { whoText: 'interesting people', whyText: '' });
    expect(agents).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('caps how many agents one sentence can spawn', async () => {
    await createFirstAgents('u-1', {
      whoText: 'founders, investors, developers, designers, marketers, sales people and consultants',
      whyText: '',
    });
    expect(created().length).toBeLessThanOrEqual(4);
  });

  it('never throws — it runs on the onboarding completion path', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));
    await expect(createFirstAgents('u-1', { whoText: 'founders', whyText: '' })).resolves.toEqual([]);
  });

  it('a scoring failure does not lose the agent that was created', async () => {
    mockRecompute.mockRejectedValue(new Error('scoring hiccup'));
    const agents = await createFirstAgents('u-1', { whoText: 'founders', whyText: '' });
    expect(agents).toHaveLength(1);
  });
});
