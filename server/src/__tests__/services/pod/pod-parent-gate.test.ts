// ─── "People must be members of <main pod> to join its pods" (Stefan, 22 Nov 2026) ─────────────────────────────────
//
// The one rule every way into a pod asks (pod-parent-gate.ts): while the main pod's director has it on, someone who is
// not an ACTIVE member of the main pod is refused (403 MAIN_POD_MEMBERS_ONLY). Platform admins are exempt. A main pod
// people may find is named; a private one is not. A caller that holds the pod's row passes its parentPodId, and a
// stand-alone pod reads nothing more.

import { ErrorCodes } from '@rsn/shared';
import { assertMayJoinInnerPod, mainPodKeepingOut, mainPodRefusal } from '../../../services/pods/pod-parent-gate';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const dbAnswering = (rows: Record<string, unknown>[]) => ({ query: jest.fn(async () => ({ rows })) });

describe('the gate query', () => {
  it('reads the main pod only while its choice is on, and only for someone who is neither its active member nor a platform admin', async () => {
    const db = dbAnswering([]);
    await mainPodKeepingOut(db as never, 'pod-1', 'user-1');
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(['pod-1', 'user-1']);
    const f = flat(sql);
    expect(f).toContain('FROM pods child JOIN pods parent ON parent.id = child.parent_pod_id WHERE child.id = $1');
    expect(f).toContain('AND parent.inner_pods_members_only');
    expect(f).toContain("AND NOT EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = parent.id AND pm.user_id = $2 AND pm.status = 'active')");
    expect(f).toContain("AND NOT EXISTS (SELECT 1 FROM users a WHERE a.id = $2 AND a.role IN ('admin', 'super_admin'))");
    // An archived main pod keeps its director's choice: no status term.
    expect(f).not.toMatch(/parent\.status/);
  });
});

describe('the refusal', () => {
  it('names a main pod people may find, in the words of whoever reads it', () => {
    const main = { name: 'Founders', visibility: 'public' };
    expect(mainPodRefusal(main)).toBe('Join Founders first. Its pods are for its members.');
    expect(mainPodRefusal(main, 'event')).toBe('This event belongs to a pod inside Founders. Join Founders first. Its pods are for its members.');
    expect(mainPodRefusal(main, 'organiser')).toBe('This person is not a member of Founders, and its pods are for its members. They join Founders first.');
    expect(mainPodRefusal({ name: 'Founders', visibility: 'public_with_approval' })).toBe('Join Founders first. Its pods are for its members.');
  });

  it('never names a private main pod (or an old invite-only one)', () => {
    for (const visibility of ['private', 'invite_only']) {
      for (const voice of ['self', 'event', 'organiser'] as const) {
        expect(mainPodRefusal({ name: 'Secret club', visibility }, voice)).not.toContain('Secret club');
      }
    }
    expect(mainPodRefusal({ name: 'x', visibility: 'private' })).toBe("This pod is for the members of the pod it is part of. Ask that pod's director for an invitation.");
  });

  it('is a 403 MAIN_POD_MEMBERS_ONLY carrying the main pod only when it may be named', async () => {
    await expect(assertMayJoinInnerPod(dbAnswering([{ id: 'main-1', name: 'Founders', visibility: 'public' }]) as never, 'pod-1', 'u'))
      .rejects.toMatchObject({ statusCode: 403, code: ErrorCodes.MAIN_POD_MEMBERS_ONLY, details: { mainPod: { id: 'main-1', name: 'Founders' } } });
    await expect(assertMayJoinInnerPod(dbAnswering([{ id: 'main-1', name: 'Secret', visibility: 'private' }]) as never, 'pod-1', 'u'))
      .rejects.toMatchObject({ statusCode: 403, code: ErrorCodes.MAIN_POD_MEMBERS_ONLY, details: undefined });
  });

  it('lets them in when nothing keeps them out', async () => {
    await expect(assertMayJoinInnerPod(dbAnswering([]) as never, 'pod-1', 'u')).resolves.toBeUndefined();
  });

  it('reads nothing for a pod its caller knows stands alone, and reads it when the caller does not know', async () => {
    const db = dbAnswering([]);
    await assertMayJoinInnerPod(db as never, 'pod-1', 'u', 'self', null);
    expect(db.query).not.toHaveBeenCalled();
    await assertMayJoinInnerPod(db as never, 'pod-1', 'u', 'self', 'main-1');
    await assertMayJoinInnerPod(db as never, 'pod-1', 'u');
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});
