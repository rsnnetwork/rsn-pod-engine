// ─── Pods inside pods: the service (Stefan, 22 Nov 2026) ────────────────────────────────────────────────────────
//
// Who may do what: a pod's active director (or a platform admin) makes pods inside it; someone who directs both pods (or
// an admin) puts one inside the other; the director of either pod (or an admin) takes one out; the main pod's director
// (or an admin) chooses whether its pods are for its members. A pod the viewer may not see is a 404, never named. The
// pods inside are listed as the pods list shows pods: one people may find (when active), one the viewer is an active
// member of, or any for an admin. Read against a stand-in for the rows that answers the service's own statements.

interface PodRow { id: string; name: string; visibility: string; status: string; parent_pod_id: string | null; members_only: boolean }
interface Member { pod_id: string; user_id: string; role: string; status: string }
let pods: PodRow[];
let members: Member[];
const writes: string[] = [];
const seen: Array<[string, unknown[]]> = [];

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const podOf = (id: unknown) => pods.find((p) => p.id === id);
const active = (podId: unknown, userId: unknown) => members.find((m) => m.pod_id === podId && m.user_id === userId && m.status === 'active');
const discoverable = (v: string) => v === 'public' || v === 'public_with_approval';

function answer(sql: string, params: unknown[] = []) {
  const s = flat(sql);
  seen.push([s, params]);
  // canViewPod
  if (s.startsWith('SELECT p.visibility::text AS visibility, EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = p.id AND pm.user_id = $2')) {
    const p = podOf(params[0]);
    return { rows: p ? [{ visibility: p.visibility, active_member: !!active(p.id, params[1]) }] : [] };
  }
  if (s === 'SELECT 1 FROM pods WHERE id = $1') return { rows: podOf(params[0]) ? [{}] : [] };
  if (s.startsWith('SELECT pod_id, role FROM pod_members WHERE pod_id = ANY($1::uuid[]) AND user_id = $2')) {
    const ids = params[0] as string[];
    return { rows: members.filter((m) => ids.includes(m.pod_id) && m.user_id === params[1] && m.status === 'active').map((m) => ({ pod_id: m.pod_id, role: m.role })) };
  }
  if (s.startsWith('SELECT pod_id FROM pod_members WHERE pod_id = ANY($1::uuid[]) AND user_id = $2 AND status = \'active\' AND role = \'director\'')) {
    const ids = params[0] as string[];
    return { rows: members.filter((m) => ids.includes(m.pod_id) && m.user_id === params[1] && m.status === 'active' && m.role === 'director') };
  }
  if (s.startsWith('SELECT id, name, status, parent_pod_id FROM pods WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE')) {
    const ids = params[0] as string[];
    return { rows: pods.filter((p) => ids.includes(p.id)).sort((a, b) => a.id.localeCompare(b.id)) };
  }
  if (s.startsWith('SELECT parent_pod_id, COUNT(*)::int AS cnt FROM pods WHERE parent_pod_id = ANY')) {
    const ids = params[0] as string[];
    return { rows: ids.map((id) => ({ parent_pod_id: id, cnt: pods.filter((p) => p.parent_pod_id === id).length })).filter((r) => r.cnt > 0) };
  }
  if (s.startsWith('UPDATE pods SET parent_pod_id = $1, updated_at = NOW() WHERE id = $2')) {
    writes.push(s); podOf(params[1])!.parent_pod_id = String(params[0]); return { rows: [], rowCount: 1 };
  }
  if (s.startsWith('UPDATE pods SET parent_pod_id = NULL')) {
    writes.push(s); podOf(params[0])!.parent_pod_id = null; return { rows: [], rowCount: 1 };
  }
  if (s.startsWith('SELECT inner_pods_members_only AS members_only FROM pods WHERE id = $1')) {
    return { rows: [{ members_only: podOf(params[0])!.members_only }] };
  }
  if (s.startsWith('UPDATE pods SET inner_pods_members_only = $2')) {
    writes.push(s); podOf(params[0])!.members_only = params[1] as boolean; return { rows: [], rowCount: 1 };
  }
  // readPodNesting: the main pod as the viewer may see it
  if (s.startsWith('SELECT p.id, p.name, p.visibility::text AS visibility, EXISTS')) {
    const p = podOf(params[0]);
    return { rows: p ? [{ id: p.id, name: p.name, visibility: p.visibility, member: !!active(p.id, params[1]) }] : [] };
  }
  if (s.includes('FROM pods child JOIN pods parent ON parent.id = child.parent_pod_id')) {
    const parent = podOf(podOf(params[0])?.parent_pod_id);
    if (!parent || !parent.members_only || active(parent.id, params[1]) || params[1] === 'admin') return { rows: [] };
    return { rows: [{ id: parent.id, name: parent.name, visibility: parent.visibility }] };
  }
  const listed = (p: PodRow, viewer: unknown, admin: unknown) =>
    !!admin || !!active(p.id, viewer) || (discoverable(p.visibility) && p.status === 'active');
  if (s.startsWith('SELECT COUNT(*)::int AS cnt FROM pods p WHERE p.parent_pod_id = $1')) {
    return { rows: [{ cnt: pods.filter((p) => p.parent_pod_id === params[0] && listed(p, params[1], params[2])).length }] };
  }
  if (s.startsWith('SELECT p.id, p.name, p.description,')) {
    return {
      rows: pods.filter((p) => p.parent_pod_id === params[0] && listed(p, params[1], params[2])).map((p) => ({
        id: p.id, name: p.name, description: null, visibility: p.visibility, status: p.status, memberCount: 1, sessionCount: 0,
        memberRole: active(p.id, params[1])?.role ?? null,
        directsIt: active(p.id, params[1])?.role === 'director',
        directsMain: active(params[0], params[1])?.role === 'director',
      })),
    };
  }
  if (s.startsWith('SELECT parent_pod_id, status FROM pods WHERE id = $1')) {
    const p = podOf(params[0]);
    return { rows: p ? [{ parent_pod_id: p.parent_pod_id, status: p.status }] : [] };
  }
  if (s.startsWith('SELECT p.id, p.name, (SELECT COUNT(*)')) {
    return {
      rows: pods.filter((p) => p.id !== params[0] && !p.parent_pod_id && p.status !== 'archived'
        && !pods.some((c) => c.parent_pod_id === p.id) && active(p.id, params[1])?.role === 'director')
        .map((p) => ({ id: p.id, name: p.name, memberCount: 1 })),
    };
  }
  throw new Error(`unmodelled: ${s.slice(0, 140)}`);
}

jest.mock('../../../db', () => ({
  query: (sql: string, params: unknown[]) => Promise.resolve(answer(sql, params)),
  transaction: (cb: (c: { query: (s: string, p: unknown[]) => unknown }) => unknown) =>
    cb({ query: (sql: string, params: unknown[]) => Promise.resolve(answer(sql, params)) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import {
  NESTING_PERMISSION, assertDirectsPod, listInnerPodCandidates, listInnerPods, putPodInside, readPodNesting,
  setInnerPodsMembersOnly, takePodOut,
} from '../../../services/pod/nested-pods.service';
import { NESTING_REFUSAL } from '../../../services/pod/nested-pods-rules';

const as = (userId: string, role = 'member') => ({ userId, role });
const ADMIN = as('admin', 'admin');

beforeEach(() => {
  pods = [
    { id: 'main', name: 'Founders', visibility: 'public', status: 'active', parent_pod_id: null, members_only: false },
    { id: 'inner-open', name: 'Design', visibility: 'public', status: 'active', parent_pod_id: 'main', members_only: false },
    { id: 'inner-secret', name: 'Secret', visibility: 'private', status: 'active', parent_pod_id: 'main', members_only: false },
    { id: 'mine', name: 'My pod', visibility: 'private', status: 'active', parent_pod_id: null, members_only: false },
    { id: 'privmain', name: 'Hidden main', visibility: 'private', status: 'active', parent_pod_id: null, members_only: false },
    { id: 'under-hidden', name: 'Under hidden', visibility: 'public', status: 'active', parent_pod_id: 'privmain', members_only: false },
  ];
  members = [
    { pod_id: 'main', user_id: 'dir', role: 'director', status: 'active' },
    { pod_id: 'mine', user_id: 'dir', role: 'director', status: 'active' },
    { pod_id: 'inner-open', user_id: 'dir2', role: 'director', status: 'active' },
    { pod_id: 'inner-secret', user_id: 'dir', role: 'director', status: 'active' },
    { pod_id: 'mine', user_id: 'host', role: 'host', status: 'active' },
    { pod_id: 'main', user_id: 'host', role: 'host', status: 'active' },
    { pod_id: 'privmain', user_id: 'pdir', role: 'director', status: 'active' },
  ];
  writes.length = 0;
  seen.length = 0;
});

describe('who directs a pod', () => {
  it('its active director and a platform admin; a host is refused (403), and a pod they may not see is a 404', async () => {
    await expect(assertDirectsPod('main', as('dir'), NESTING_PERMISSION.make)).resolves.toBeUndefined();
    await expect(assertDirectsPod('main', ADMIN, NESTING_PERMISSION.make)).resolves.toBeUndefined();
    await expect(assertDirectsPod('main', as('host'), NESTING_PERMISSION.make)).rejects.toMatchObject({ statusCode: 403, message: NESTING_PERMISSION.make });
    await expect(assertDirectsPod('privmain', as('stranger'), NESTING_PERMISSION.make)).rejects.toMatchObject({ statusCode: 404 });
    await expect(assertDirectsPod('nowhere', ADMIN, NESTING_PERMISSION.make)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('where a pod sits, as its page reads it', () => {
  it('a pod inside a main pod people may find names it; a stand-alone pod may hold pods and counts only those the viewer may see', async () => {
    expect(await readPodNesting({ id: 'inner-open', parentPodId: 'main' }, as('stranger'))).toEqual({
      parentPod: { id: 'main', name: 'Founders' }, parentPodHidden: false, innerPodCount: 0, joinNeedsMainPod: false, mayHoldPods: false,
    });
    // The private pod inside is not counted for a stranger; its director and an admin count it.
    expect((await readPodNesting({ id: 'main', parentPodId: null }, as('stranger'))).innerPodCount).toBe(1);
    expect((await readPodNesting({ id: 'main', parentPodId: null }, as('dir'))).innerPodCount).toBe(2);
    expect((await readPodNesting({ id: 'main', parentPodId: null }, ADMIN))).toMatchObject({ innerPodCount: 2, mayHoldPods: true, parentPod: null });
  });

  it('a private main pod the viewer is not in is never named: "hidden" instead', async () => {
    expect(await readPodNesting({ id: 'under-hidden', parentPodId: 'privmain' }, as('stranger'))).toMatchObject({
      parentPod: null, parentPodHidden: true,
    });
    expect((await readPodNesting({ id: 'under-hidden', parentPodId: 'privmain' }, as('pdir'))).parentPod).toEqual({ id: 'privmain', name: 'Hidden main' });
  });

  it('says when joining needs the main pod first, through the same gate as every join', async () => {
    pods[0].members_only = true;
    expect((await readPodNesting({ id: 'inner-open', parentPodId: 'main' }, as('stranger'))).joinNeedsMainPod).toBe(true);
    expect((await readPodNesting({ id: 'inner-open', parentPodId: 'main' }, as('host'))).joinNeedsMainPod).toBe(false);
  });
});

describe('the pods inside, listed for the viewer', () => {
  it('leaves out a private pod the viewer is not in, and lets its director or the main pod\'s director take one out', async () => {
    const forStranger = await listInnerPods('main', as('stranger'));
    expect(forStranger.map((p) => p.id)).toEqual(['inner-open']);
    expect(forStranger[0].mayTakeOut).toBe(false);
    const forDirector = await listInnerPods('main', as('dir'));
    expect(forDirector.map((p) => [p.id, p.mayTakeOut])).toEqual([['inner-open', true], ['inner-secret', true]]);
    const forInnerDirector = await listInnerPods('main', as('dir2'));
    expect(forInnerDirector.map((p) => [p.id, p.mayTakeOut])).toEqual([['inner-open', true]]);
    expect((await listInnerPods('main', ADMIN)).every((p) => p.mayTakeOut)).toBe(true);
  });

  it('reads them as the pods list does: an archived pod only for its members, at most a bounded page', async () => {
    await listInnerPods('main', as('stranger'));
    const [sql] = seen.find(([s]) => s.startsWith('SELECT p.id, p.name, p.description,'))!;
    expect(sql).toContain("OR (p.visibility::text IN ('public', 'public_with_approval') AND p.status = 'active'))");
    expect(sql).toContain("OR EXISTS (SELECT 1 FROM pod_members seen WHERE seen.pod_id = p.id AND seen.user_id = $2 AND seen.status = 'active')");
    expect(sql).toMatch(/LIMIT 200$/);
  });

  it('offers the director only pods that could go inside, and none when the pod may not hold pods', async () => {
    expect((await listInnerPodCandidates('main', as('dir'))).map((p) => p.id)).toEqual(['mine']);
    expect(await listInnerPodCandidates('inner-open', as('dir2'))).toEqual([]);
  });
});

describe('putting a pod inside', () => {
  it('someone who directs both puts it inside; the pods\' rows are locked first', async () => {
    const move = await putPodInside('main', 'mine', as('dir'));
    expect(move).toEqual({ changed: true, parentPodId: 'main', previousParentPodId: null });
    expect(podOf('mine')!.parent_pod_id).toBe('main');
    const lockAt = seen.findIndex(([s]) => s.includes('FOR UPDATE'));
    const writeAt = seen.findIndex(([s]) => s.startsWith('UPDATE pods SET parent_pod_id = $1'));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(writeAt);
  });

  it('a second press changes nothing (already inside)', async () => {
    await putPodInside('main', 'mine', as('dir'));
    expect(await putPodInside('main', 'mine', as('dir'))).toEqual({ changed: false, parentPodId: 'main', previousParentPodId: 'main' });
    expect(writes).toHaveLength(1);
  });

  it('a host of both, or a director of only one, is refused (403), and nothing is written', async () => {
    await expect(putPodInside('main', 'mine', as('host'))).rejects.toMatchObject({ statusCode: 403, message: NESTING_PERMISSION.put });
    await expect(putPodInside('main', 'inner-open', as('dir'))).rejects.toMatchObject({ statusCode: 403 });
    expect(writes).toEqual([]);
  });

  it('one level only: nothing goes inside a pod that is inside another, and a pod holding pods goes inside nothing', async () => {
    await expect(putPodInside('inner-open', 'mine', ADMIN)).rejects.toMatchObject({ statusCode: 409, code: 'POD_NESTING_REFUSED', message: NESTING_REFUSAL.parentIsInner('Design') });
    await expect(putPodInside('mine', 'main', ADMIN)).rejects.toMatchObject({ statusCode: 409, message: NESTING_REFUSAL.childHoldsPods('Founders') });
    await expect(putPodInside('privmain', 'inner-open', ADMIN)).rejects.toMatchObject({ statusCode: 409, message: NESTING_REFUSAL.childInOther('Design') });
    await expect(putPodInside('main', 'main', ADMIN)).rejects.toMatchObject({ statusCode: 409, message: NESTING_REFUSAL.self });
    expect(writes).toEqual([]);
  });

  it('never inside an archived pod', async () => {
    pods[0].status = 'archived';
    await expect(putPodInside('main', 'mine', as('dir'))).rejects.toMatchObject({ statusCode: 409, message: NESTING_REFUSAL.archived('Founders') });
  });

  it('a pod the viewer may not see is a 404, never named', async () => {
    await expect(putPodInside('privmain', 'mine', as('dir'))).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('taking a pod out', () => {
  it('the inner pod\'s director, the main pod\'s director or an admin takes it out; it stands alone and nothing else changes', async () => {
    expect(await takePodOut('inner-open', as('dir2'))).toEqual({ changed: true, parentPodId: null, previousParentPodId: 'main' });
    expect(podOf('inner-open')!.parent_pod_id).toBeNull();
    pods[1].parent_pod_id = 'main';
    expect((await takePodOut('inner-open', as('dir'))).changed).toBe(true);
    pods[1].parent_pod_id = 'main';
    expect((await takePodOut('inner-open', ADMIN)).changed).toBe(true);
    expect(members.filter((m) => m.pod_id === 'inner-open')).toHaveLength(1);
  });

  it('anyone else is refused (403); a pod that stands alone already changes nothing', async () => {
    await expect(takePodOut('inner-open', as('host'))).rejects.toMatchObject({ statusCode: 403, message: NESTING_PERMISSION.takeOut });
    expect(await takePodOut('mine', as('dir'))).toEqual({ changed: false, parentPodId: null, previousParentPodId: null });
    expect(writes).toEqual([]);
  });
});

describe('the main pod\'s members-only choice', () => {
  it('its director turns it on and off; the same choice again changes nothing', async () => {
    expect(await setInnerPodsMembersOnly('main', true, as('dir'))).toEqual({ innerPodsMembersOnly: true, changed: true });
    expect(podOf('main')!.members_only).toBe(true);
    expect(await setInnerPodsMembersOnly('main', true, as('dir'))).toEqual({ innerPodsMembersOnly: true, changed: false });
    expect(await setInnerPodsMembersOnly('main', false, ADMIN)).toEqual({ innerPodsMembersOnly: false, changed: true });
  });

  it('a host is refused (403); a pod inside another holds no pods, so the choice is not for it (409)', async () => {
    await expect(setInnerPodsMembersOnly('main', true, as('host'))).rejects.toMatchObject({ statusCode: 403, message: NESTING_PERMISSION.setting });
    await expect(setInnerPodsMembersOnly('inner-open', true, as('dir2'))).rejects.toMatchObject({ statusCode: 409, message: NESTING_REFUSAL.settingOnInner });
    expect(writes).toEqual([]);
  });

  it('never takes anyone out of a pod inside (no membership is written)', async () => {
    await setInnerPodsMembersOnly('main', true, as('dir'));
    expect(seen.some(([s]) => /pod_members/.test(s) && /^(UPDATE|DELETE|INSERT)/.test(s))).toBe(false);
  });
});
