// ─── Onboarding v2: the standing searches its answers describe ───────────────
//
// One search per kind of person ticked, plus one for "in my own words" in the
// member's own words. De-duplicated by the KEY each search was made for
// (intent.meetKey), never by its label, which a member may reword. When the
// answers change, a search onboarding made whose key is gone is paused, never
// deleted, and comes back when the key does.
//
// Fix round 1 (21 Oct 2026): only a search onboarding itself paused comes back.
// Members pause searches themselves (the agents page, For You), and a confirm
// that changed nothing about them must leave their pause alone.

const mockList = jest.fn();
const mockCreate = jest.fn();
const mockSetStatus = jest.fn();
const mockReword = jest.fn();
const mockPause = jest.fn();
const mockRecompute = jest.fn();
jest.mock('../../../services/matching/agent.repo', () => ({
  __esModule: true,
  listOnboardingAgents: (...a: unknown[]) => mockList(...a),
  createAgent: (...a: unknown[]) => mockCreate(...a),
  setStatus: (...a: unknown[]) => mockSetStatus(...a),
  rewordAgent: (...a: unknown[]) => mockReword(...a),
  pauseForOnboarding: (...a: unknown[]) => mockPause(...a),
  listAgents: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../services/matching/agent-matching.service', () => ({
  __esModule: true,
  recomputeAgent: (...a: unknown[]) => mockRecompute(...a),
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { planSearchesFromV2Answers, syncSearchesFromV2Answers } from '../../../services/matching/first-agent.service';
import type { OnboardingAgentRef } from '../../../services/matching/agent.repo';
import { MEET_V2_SIGNALS } from '../../../services/matching/option-signals';

const agent = (over: Partial<OnboardingAgentRef>): OnboardingAgentRef => ({
  id: 'a-x', label: 'Something', wantText: 'something', status: 'active', intent: {}, ...over,
});

describe('planSearchesFromV2Answers', () => {
  it('a new member: one search per kind ticked, all searching, in their order', () => {
    const plan = planSearchesFromV2Answers(['meet_specialists', 'meet_investors'], null, []);
    expect(plan.create.map(p => [p.label, p.status])).toEqual([
      [MEET_V2_SIGNALS.meet_specialists.agentLabel, 'active'],
      [MEET_V2_SIGNALS.meet_investors.agentLabel, 'active'],
    ]);
    expect(plan.create[0]).toMatchObject({
      wantText: MEET_V2_SIGNALS.meet_specialists.wantText,
      intent: { source: 'onboarding_v2', meetKey: 'meet_specialists' },
    });
    expect(plan.create[0].matchingTags.length).toBeGreaterThan(0);
    expect(plan).toMatchObject({ resume: [], reword: [], pause: [] });
  });

  it('"in my own words" is a search in their own words', () => {
    const plan = planSearchesFromV2Answers(['meet_other'], 'bakers who sell online in Vienna', []);
    expect(plan.create).toEqual([expect.objectContaining({
      label: 'Bakers who sell online in Vienna',
      wantText: 'bakers who sell online in Vienna',
      status: 'active',
      intent: { source: 'onboarding_v2', meetKey: 'meet_other', text: 'bakers who sell online in Vienna' },
    })]);
  });

  it('a long own-words search name is cut between words to fit its column', () => {
    const words = 'people who have exported handmade furniture to Japan and know the customs rules there well';
    const [p] = planSearchesFromV2Answers(['meet_other'], words, []).create;
    expect(p.label.length).toBeLessThanOrEqual(80);
    expect(p.label.endsWith('…')).toBe(true);
    expect(p.wantText).toBe(words);
  });

  it('never makes a second search for a key that has one, whatever its label now says', () => {
    const plan = planSearchesFromV2Answers(['meet_investors'], null, [
      agent({ id: 'a-1', label: 'My money people', intent: { source: 'onboarding_v2', meetKey: 'meet_investors' } }),
    ]);
    expect(plan.create).toEqual([]);
    expect(plan.pause).toEqual([]);
  });

  it('a label alone never stops a search being made', () => {
    // A hand-made search that happens to share the name is not the onboarding one.
    const plan = planSearchesFromV2Answers(['meet_investors'], null, [
      agent({ id: 'a-1', label: MEET_V2_SIGNALS.meet_investors.agentLabel, intent: {} }),
    ]);
    expect(plan.create).toHaveLength(1);
  });

  it('a search version 1 made counts for the v2 kind it maps to', () => {
    const plan = planSearchesFromV2Answers(['meet_investors', 'meet_specialists'], null, [
      agent({ id: 'v1-inv', label: 'Investors & VCs', intent: { source: 'tickbox_v1', meetKey: 'investors' } }),
      agent({ id: 'v1-dev', label: 'Developers & technical people', intent: { source: 'tickbox_v1', meetKey: 'developers_technical' } }),
    ]);
    expect(plan.create).toEqual([]);
    expect(plan.pause).toEqual([]);
  });

  it('pauses a search onboarding made whose kind is no longer ticked, v1 ones included', () => {
    const plan = planSearchesFromV2Answers(['meet_investors'], null, [
      agent({ id: 'a-inv', intent: { source: 'onboarding_v2', meetKey: 'meet_investors' } }),
      agent({ id: 'a-stu', intent: { source: 'onboarding_v2', meetKey: 'meet_students_early_career' } }),
      agent({ id: 'v1-com', intent: { source: 'tickbox_v1', meetKey: 'event_community' } }),
      agent({ id: 'a-done', status: 'paused', intent: { source: 'onboarding_v2', meetKey: 'meet_specialists' } }),
    ]);
    expect(plan.pause.sort()).toEqual(['a-stu', 'v1-com']);
  });

  it('brings back a search onboarding paused when its kind is ticked again, instead of making another', () => {
    const plan = planSearchesFromV2Answers(['meet_students_early_career'], null, [
      agent({ id: 'a-stu', status: 'paused', intent: { source: 'onboarding_v2', meetKey: 'meet_students_early_career', pausedBy: 'onboarding' } }),
    ]);
    expect(plan.resume).toEqual(['a-stu']);
    expect(plan.create).toEqual([]);
  });

  it('a search the member paused, whose kind stayed ticked, stays paused', () => {
    const plan = planSearchesFromV2Answers(['meet_investors', 'meet_students_early_career'], null, [
      agent({ id: 'a-inv', status: 'paused', intent: { source: 'onboarding_v2', meetKey: 'meet_investors' } }),
    ]);
    expect(plan.resume).toEqual([]);
    // And it still stands for its kind: no second search is made.
    expect(plan.create.map(p => p.intent?.meetKey)).toEqual(['meet_students_early_career']);
  });

  it("a v1 member's first v2 confirm leaves the v1 searches they paused paused", () => {
    const plan = planSearchesFromV2Answers(['meet_investors'], null, [
      agent({ id: 'v1-inv', status: 'paused', intent: { source: 'tickbox_v1', meetKey: 'investors' } }),
    ]);
    expect(plan).toMatchObject({ create: [], resume: [], pause: [] });
  });

  it('new words for an own-words search the member paused: reworded, still paused', () => {
    const plan = planSearchesFromV2Answers(['meet_other'], 'potters in Graz', [
      agent({ id: 'a-own', status: 'paused', intent: { source: 'onboarding_v2', meetKey: 'meet_other', text: 'bakers in Vienna' } }),
    ]);
    expect(plan.reword.map(r => r.id)).toEqual(['a-own']);
    expect(plan.resume).toEqual([]);
  });

  it('leaves an archived search archived: the member put it away themselves', () => {
    const plan = planSearchesFromV2Answers(['meet_investors'], null, [
      agent({ id: 'a-inv', status: 'archived', intent: { source: 'onboarding_v2', meetKey: 'meet_investors' } }),
    ]);
    expect(plan).toMatchObject({ create: [], resume: [], pause: [] });
  });

  it('new words for "in my own words" reword that search', () => {
    const plan = planSearchesFromV2Answers(['meet_other'], 'potters in Graz', [
      agent({ id: 'a-own', label: 'Bakers in Vienna', wantText: 'bakers in Vienna', intent: { source: 'onboarding_v2', meetKey: 'meet_other', text: 'bakers in Vienna' } }),
    ]);
    expect(plan.create).toEqual([]);
    expect(plan.reword).toEqual([{
      id: 'a-own', label: 'Potters in Graz', wantText: 'potters in Graz',
      intent: { source: 'onboarding_v2', meetKey: 'meet_other', text: 'potters in Graz' },
    }]);
  });

  it('the same words leave it alone', () => {
    const plan = planSearchesFromV2Answers(['meet_other'], 'bakers in Vienna', [
      agent({ id: 'a-own', intent: { source: 'onboarding_v2', meetKey: 'meet_other', text: 'bakers in Vienna' } }),
    ]);
    expect(plan).toMatchObject({ create: [], resume: [], reword: [], pause: [] });
  });

  it('never touches a search the member made themselves', () => {
    const plan = planSearchesFromV2Answers(['meet_investors'], null, [
      agent({ id: 'mine', intent: {} }),
      agent({ id: 'seeded', intent: { source: 'react developers', seeded: true } }),
    ]);
    expect(plan.pause).toEqual([]);
  });
});

describe('syncSearchesFromV2Answers', () => {
  let seq = 0;
  beforeEach(() => {
    jest.clearAllMocks();
    seq = 0;
    mockList.mockResolvedValue([]);
    mockCreate.mockImplementation(async (userId: string, p: { label: string; wantText: string; status: string }) => ({
      id: `new-${++seq}`, userId, label: p.label, wantText: p.wantText, matchingTags: [], status: p.status,
    }));
    mockSetStatus.mockImplementation(async (id: string, userId: string, status: string) => ({
      id, userId, label: `L-${id}`, wantText: 'w', matchingTags: [], status,
    }));
    mockReword.mockImplementation(async (id: string, userId: string, r: { label: string; wantText: string }) => ({
      id, userId, label: r.label, wantText: r.wantText, matchingTags: [], status: 'active',
    }));
    mockPause.mockImplementation(async (id: string, userId: string) => ({
      id, userId, label: `L-${id}`, wantText: 'w', matchingTags: [], status: 'paused',
    }));
    mockRecompute.mockResolvedValue(3);
  });

  it('makes the searches and scores each one straight away', async () => {
    const out = await syncSearchesFromV2Answers('u-1', ['meet_investors', 'meet_other'], 'bakers in Vienna');
    expect(out.map(c => c.change)).toEqual(['created', 'created']);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockRecompute).toHaveBeenCalledTimes(2);
  });

  it('pauses without deleting, marks it as paused by onboarding, and does not score it', async () => {
    mockList.mockResolvedValue([agent({ id: 'a-stu', intent: { source: 'onboarding_v2', meetKey: 'meet_students_early_career' } })]);
    const out = await syncSearchesFromV2Answers('u-1', ['meet_investors'], null);
    expect(mockPause).toHaveBeenCalledWith('a-stu', 'u-1');
    expect(mockSetStatus).not.toHaveBeenCalledWith('a-stu', 'u-1', 'paused');
    expect(out.find(c => c.agent.id === 'a-stu')?.change).toBe('paused');
    expect(mockRecompute).toHaveBeenCalledTimes(1);
  });

  it('resumes and rescores a search whose kind came back', async () => {
    mockList.mockResolvedValue([agent({ id: 'a-inv', status: 'paused', intent: { source: 'onboarding_v2', meetKey: 'meet_investors', pausedBy: 'onboarding' } })]);
    const out = await syncSearchesFromV2Answers('u-1', ['meet_investors'], null);
    expect(mockSetStatus).toHaveBeenCalledWith('a-inv', 'u-1', 'active');
    expect(out).toEqual([expect.objectContaining({ change: 'resumed' })]);
    expect(mockRecompute).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-inv' }));
  });

  it('a search both reworded and brought back is reported once', async () => {
    mockList.mockResolvedValue([agent({
      id: 'a-own', status: 'paused', intent: { source: 'onboarding_v2', meetKey: 'meet_other', text: 'bakers', pausedBy: 'onboarding' },
    })]);
    const out = await syncSearchesFromV2Answers('u-1', ['meet_other'], 'potters');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ change: 'updated', agent: { id: 'a-own', status: 'active' } });
  });

  it('a search the member paused is left alone: no status change, nothing reported', async () => {
    mockList.mockResolvedValue([agent({ id: 'a-inv', status: 'paused', intent: { source: 'onboarding_v2', meetKey: 'meet_investors' } })]);
    const out = await syncSearchesFromV2Answers('u-1', ['meet_investors'], null);
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockPause).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it('new words for a search the member paused: reworded, reported, still paused and not scored', async () => {
    mockList.mockResolvedValue([agent({ id: 'a-own', status: 'paused', intent: { source: 'onboarding_v2', meetKey: 'meet_other', text: 'bakers' } })]);
    mockReword.mockImplementation(async (id: string, userId: string, r: { label: string; wantText: string }) => ({
      id, userId, label: r.label, wantText: r.wantText, matchingTags: [], status: 'paused',
    }));
    const out = await syncSearchesFromV2Answers('u-1', ['meet_other'], 'potters');
    expect(out).toEqual([expect.objectContaining({ change: 'updated', agent: expect.objectContaining({ status: 'paused' }) })]);
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockRecompute).not.toHaveBeenCalled();
  });

  it('never throws: the member keeps the onboarding they just finished', async () => {
    mockList.mockRejectedValue(new Error('db down'));
    await expect(syncSearchesFromV2Answers('u-1', ['meet_investors'], null)).resolves.toEqual([]);
  });

  it('a scoring failure does not lose the search', async () => {
    mockRecompute.mockRejectedValue(new Error('slow'));
    const out = await syncSearchesFromV2Answers('u-1', ['meet_investors'], null);
    expect(out).toHaveLength(1);
  });
});
