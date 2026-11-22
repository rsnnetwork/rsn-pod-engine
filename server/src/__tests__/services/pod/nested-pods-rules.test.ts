// ─── Pods inside pods: where a pod may go (Stefan, 22 Nov 2026) ─────────────────────────────────────────────────
//
// One level only (ONE_LEVEL_ONLY): a main pod holds pods; a pod inside a main pod holds none; a pod that holds pods
// cannot go inside another. A pod is never inside itself, is taken out of one main pod before it goes inside another,
// and an archived pod neither takes pods nor goes inside one. The rows are locked in id order and the counts read
// under the lock, so two requests can never both pass the one-level rule.

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  NESTING_REFUSAL, ONE_LEVEL_ONLY, lockNestingFacts, lockParentForNewInnerPod, mayHoldPods, nestingRefusal,
  type NestingFacts,
} from '../../../services/pod/nested-pods-rules';

const pod = (id: string, over: Partial<NestingFacts> = {}): NestingFacts => ({
  id, name: id.toUpperCase(), status: 'active', parentPodId: null, innerPodCount: 0, ...over,
});

describe('the one-level rule and its neighbours', () => {
  it('is one level today', () => {
    expect(ONE_LEVEL_ONLY).toBe(true);
  });

  it('lets a stand-alone pod go inside a stand-alone pod, and a new pod be made inside one', () => {
    expect(nestingRefusal(pod('main'), pod('child'))).toBeNull();
    expect(nestingRefusal(pod('main', { innerPodCount: 3 }), pod('child'))).toBeNull();
    expect(nestingRefusal(pod('main'), null)).toBeNull();
  });

  it('a pod inside a main pod holds no pods: nothing goes inside it, nothing is made inside it', () => {
    const inner = pod('inner', { parentPodId: 'main' });
    expect(nestingRefusal(inner, pod('child'))).toBe(NESTING_REFUSAL.parentIsInner('INNER'));
    expect(nestingRefusal(inner, null)).toBe(NESTING_REFUSAL.parentIsInner('INNER'));
    expect(mayHoldPods(inner)).toBe(false);
    expect(mayHoldPods(pod('main'))).toBe(true);
  });

  it('a pod that holds pods cannot go inside another', () => {
    expect(nestingRefusal(pod('main'), pod('child', { innerPodCount: 1 }))).toBe(NESTING_REFUSAL.childHoldsPods('CHILD'));
  });

  it('never inside itself', () => {
    expect(nestingRefusal(pod('same'), pod('same'))).toBe(NESTING_REFUSAL.self);
  });

  it('out of one main pod before it goes inside another; already inside this one is not refused (nothing to change)', () => {
    expect(nestingRefusal(pod('main'), pod('child', { parentPodId: 'other' }))).toBe(NESTING_REFUSAL.childInOther('CHILD'));
    expect(nestingRefusal(pod('main'), pod('child', { parentPodId: 'main' }))).toBeNull();
  });

  it('an archived pod neither takes pods nor goes inside one', () => {
    expect(nestingRefusal(pod('main', { status: 'archived' }), pod('child'))).toBe(NESTING_REFUSAL.archived('MAIN'));
    expect(nestingRefusal(pod('main', { status: 'archived' }), null)).toBe(NESTING_REFUSAL.archived('MAIN'));
    expect(nestingRefusal(pod('main'), pod('child', { status: 'archived' }))).toBe(NESTING_REFUSAL.archived('CHILD'));
  });

  it('says each refusal in plain words', () => {
    expect(NESTING_REFUSAL.parentIsInner('Founders')).toBe('Founders is inside another pod, so it cannot hold pods of its own.');
    expect(NESTING_REFUSAL.childHoldsPods('Design')).toBe('Design holds pods of its own, so it cannot go inside another pod.');
    expect(NESTING_REFUSAL.childInOther('Design')).toBe('Design is inside another pod already. Take it out of that pod first.');
    expect(NESTING_REFUSAL.archived('Design')).toBe('Design is archived. Reactivate it first.');
  });
});

describe('the locked read', () => {
  const calls: Array<[string, unknown[]]> = [];
  const db = (rows: Record<string, unknown>[], counts: Record<string, unknown>[]) => ({
    query: jest.fn(async (sql: string, params: unknown[]) => {
      calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      return { rows: /FOR UPDATE/.test(sql) ? rows : counts };
    }),
  });
  beforeEach(() => { calls.length = 0; });

  it('locks the rows in id order (so two requests on one pair never wait on each other) and counts inner pods under the lock', async () => {
    const facts = await lockNestingFacts(db(
      [{ id: 'a', name: 'A', status: 'active', parent_pod_id: null }, { id: 'b', name: 'B', status: 'active', parent_pod_id: null }],
      [{ parent_pod_id: 'b', cnt: 2 }],
    ) as never, ['b', 'a', 'b']);
    expect(calls[0][0]).toBe('SELECT id, name, status, parent_pod_id FROM pods WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE');
    expect(calls[0][1]).toEqual([['a', 'b']]);
    expect(calls[1][0]).toBe('SELECT parent_pod_id, COUNT(*)::int AS cnt FROM pods WHERE parent_pod_id = ANY($1::uuid[]) GROUP BY parent_pod_id');
    expect(facts.get('a')!.innerPodCount).toBe(0);
    expect(facts.get('b')!.innerPodCount).toBe(2);
  });

  it('a missing pod is a 404', async () => {
    await expect(lockNestingFacts(db([], []) as never, ['gone'])).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a new pod inside a pod that is itself inside another is refused (409 POD_NESTING_REFUSED) under the lock', async () => {
    await expect(lockParentForNewInnerPod(db(
      [{ id: 'inner', name: 'Inner', status: 'active', parent_pod_id: 'main' }], [],
    ) as never, 'inner')).rejects.toMatchObject({ statusCode: 409, code: 'POD_NESTING_REFUSED', message: NESTING_REFUSAL.parentIsInner('Inner') });
  });

  it('a new pod inside a stand-alone active pod is let through', async () => {
    await expect(lockParentForNewInnerPod(db(
      [{ id: 'main', name: 'Main', status: 'active', parent_pod_id: null }], [],
    ) as never, 'main')).resolves.toMatchObject({ id: 'main' });
  });
});
