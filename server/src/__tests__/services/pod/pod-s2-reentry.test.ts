// ─── Removed is not turned down (Shirley pilot S2 fix round 1, controller ruling) ──────────────────────────────────
// Someone a pod's organiser REMOVED cannot come back by themselves: their own join of a Public open pod, or their own
// "request" there (which joins at once), is refused in words. On a Public with approval pod they may ask again, and the
// organiser decides. Someone whose request was DECLINED may ask again (and join a public pod). Someone who LEFT may come
// back. Only an organiser's own add or approval, or an organiser's personal invite made after the removal, readmits a
// removed person; a shared link or a plain member's invite does not. A pod's director is never removed, and a host
// removes members only. Read against a stand-in for the pod's rows that answers the service's own statements.

interface Row { user_id: string; role: string; status: string; removal_kind: string | null; left_at: Date | null }
let rows: Row[];
let podVisibility: string;
const organisers = new Set<string>();
const platformAdmins = new Set<string>();

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
function answer(sql: string, params: unknown[] = []) {
  const s = flat(sql);
  const row = (u: unknown) => rows.find((r) => r.user_id === u);
  if (/FROM pods WHERE id = \$1 FOR UPDATE$/.test(s) || /FROM pods LEFT JOIN/.test(s)) {
    return { rows: [{ id: 'p1', name: 'Curious 12', visibility: podVisibility, status: 'active', maxMembers: null }] };
  }
  if (s === 'SELECT id, status, removal_kind, left_at FROM pod_members WHERE pod_id = $1 AND user_id = $2') {
    const r = row(params[1]);
    return { rows: r ? [{ id: 'row', status: r.status, removal_kind: r.removal_kind, left_at: r.left_at }] : [] };
  }
  if (s.startsWith('UPDATE pod_members SET role = $1, status = $2, joined_at = NOW(),')) {
    const r = row(params[3])!;
    r.role = String(params[0]); r.status = String(params[1]);
    if (r.status === 'active') { r.removal_kind = null; r.left_at = null; }
    return { rows: [{ ...r }], rowCount: 1 };
  }
  if (s.startsWith('INSERT INTO pod_members')) {
    rows.push({ user_id: String(params[1]), role: String(params[2]), status: String(params[3]), removal_kind: null, left_at: null });
    return { rows: [{ userId: params[1], status: params[3] }], rowCount: 1 };
  }
  if (s.startsWith('SELECT (EXISTS (SELECT 1 FROM users a WHERE a.id = $2')) {
    return { rows: [{ runs: platformAdmins.has(String(params[1])) || organisers.has(String(params[1])) }] };
  }
  if (s === "SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'") {
    const r = row(params[1]);
    return { rows: r && r.status === 'active' ? [{ role: r.role }] : [] };
  }
  if (s.startsWith("UPDATE pod_members SET status = 'removed', removal_kind = 'removed'")) {
    const r = row(params[1]);
    if (!r || r.status !== 'active') return { rows: [], rowCount: 0 };
    r.status = 'removed'; r.removal_kind = 'removed'; r.left_at = new Date();
    return { rows: [], rowCount: 1 };
  }
  if (s.startsWith("UPDATE pod_members SET status = 'removed', left_at = NOW(), removal_kind = COALESCE(removal_kind, 'rejected')")) {
    const r = row(params[1]);
    if (!r || r.status !== 'pending_approval') return { rows: [], rowCount: 0 };
    r.status = 'removed'; r.removal_kind = r.removal_kind ?? 'rejected'; r.left_at = new Date();
    return { rows: [], rowCount: 1 };
  }
  if (s.startsWith("UPDATE pod_members SET status = 'active', joined_at = NOW(), left_at = NULL, removal_kind = NULL")) {
    const r = row(params[1]);
    if (!r || r.status !== 'pending_approval') return { rows: [], rowCount: 0 };
    r.status = 'active'; r.removal_kind = null; r.left_at = null;
    return { rows: [{ ...r }], rowCount: 1 };
  }
  if (s.startsWith("UPDATE pod_members SET status = 'left'")) {
    const r = row(params[1])!; r.status = 'left'; r.left_at = new Date();
    return { rows: [], rowCount: 1 };
  }
  if (s.startsWith('SELECT email FROM users') || s.startsWith('UPDATE invites') || s.startsWith('SELECT display_name, email FROM users')) {
    return { rows: [], rowCount: 0 };
  }
  if (s.startsWith('INSERT INTO notifications')) return { rows: [], rowCount: 0 };
  throw new Error(`unmodelled: ${s.slice(0, 120)}`);
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

import { PodMemberRole, PodMemberStatus, UserRole } from '@rsn/shared';
import {
  DIRECTOR_NOT_REMOVED, ONLY_DIRECTOR_REMOVES_HOSTS, REMOVED_FROM_POD,
  addMember, approveMember, joinPod, leavePod, rejectMember, removeMember, requestToJoin,
} from '../../../services/pod/pod.service';

const statusOf = (u: string) => rows.find((r) => r.user_id === u);
const M = UserRole.MEMBER;
const hourAgo = () => new Date(Date.now() - 3600_000);
const invite = (inviterId: string, over: Record<string, unknown> = {}) =>
  ({ by: 'invite' as const, invite: { inviterId, inviteeEmail: 'ana@rsn-e2e.invalid', maxUses: 1, createdAt: new Date(Date.now() + 1000), ...over } });

beforeEach(() => {
  rows = [
    { user_id: 'dir', role: 'director', status: 'active', removal_kind: null, left_at: null },
    { user_id: 'host', role: 'host', status: 'active', removal_kind: null, left_at: null },
    { user_id: 'host2', role: 'host', status: 'active', removal_kind: null, left_at: null },
    { user_id: 'ana', role: 'member', status: 'active', removal_kind: null, left_at: null },
    { user_id: 'mem', role: 'member', status: 'active', removal_kind: null, left_at: null },
  ];
  podVisibility = 'public';
  organisers.clear(); organisers.add('dir'); organisers.add('host');
  platformAdmins.clear(); platformAdmins.add('stefan');
});

describe('removed by an organiser: no way back by themselves', () => {
  it('a removal is marked as one (removal_kind removed)', async () => {
    await removeMember('p1', 'ana', 'dir', M);
    expect(statusOf('ana')).toMatchObject({ status: 'removed', removal_kind: 'removed' });
  });

  it('a public open pod: their own join, and their own request (which would join at once), are refused in words', async () => {
    await removeMember('p1', 'ana', 'dir', M);
    await expect(joinPod('p1', 'ana', M)).rejects.toMatchObject({ statusCode: 403, message: REMOVED_FROM_POD });
    await expect(requestToJoin('p1', 'ana')).rejects.toMatchObject({ statusCode: 403, message: REMOVED_FROM_POD });
    expect(statusOf('ana')!.status).toBe('removed');
  });

  it('an approval pod: they may ask again; the request waits, still marked removed, until the organiser decides', async () => {
    await removeMember('p1', 'ana', 'dir', M);
    podVisibility = 'public_with_approval';
    await requestToJoin('p1', 'ana');
    expect(statusOf('ana')).toMatchObject({ status: 'pending_approval', removal_kind: 'removed' });
    // If the pod is then opened, the waiting request does not let them join by themselves.
    podVisibility = 'public';
    await expect(joinPod('p1', 'ana', M)).rejects.toMatchObject({ message: REMOVED_FROM_POD });
    // Turning the request down keeps the removal (it never launders into "rejected").
    podVisibility = 'public_with_approval';
    await rejectMember('p1', 'ana', 'dir', M);
    expect(statusOf('ana')).toMatchObject({ status: 'removed', removal_kind: 'removed' });
  });

  it('the organiser approving the new request lets them back in (and clears the mark)', async () => {
    await removeMember('p1', 'ana', 'dir', M);
    podVisibility = 'public_with_approval';
    await requestToJoin('p1', 'ana');
    await approveMember('p1', 'ana', 'dir', M);
    expect(statusOf('ana')).toMatchObject({ status: 'active', removal_kind: null, left_at: null }); // fix round 2: left_at cleared too
  });

  it('the organiser adding them again lets them back in (an organiser decision)', async () => {
    await removeMember('p1', 'ana', 'dir', M);
    await addMember('p1', 'ana');
    expect(statusOf('ana')).toMatchObject({ status: 'active', removal_kind: null });
  });

  it('a platform admin joining (as themselves) is unchanged', async () => {
    rows.push({ user_id: 'stefan', role: 'member', status: 'removed', removal_kind: 'removed', left_at: hourAgo() });
    await joinPod('p1', 'stefan', UserRole.SUPER_ADMIN);
    expect(statusOf('stefan')!.status).toBe('active');
  });
});

describe('turned down, or left: may come back', () => {
  it('a declined request is marked rejected and may ask again (approval) or join (public)', async () => {
    rows.push({ user_id: 'bo', role: 'member', status: 'pending_approval', removal_kind: null, left_at: null });
    await rejectMember('p1', 'bo', 'dir', M);
    expect(statusOf('bo')).toMatchObject({ status: 'removed', removal_kind: 'rejected' });
    podVisibility = 'public_with_approval';
    await requestToJoin('p1', 'bo');
    expect(statusOf('bo')!.status).toBe('pending_approval');
    await rejectMember('p1', 'bo', 'dir', M);
    podVisibility = 'public';
    await joinPod('p1', 'bo', M);
    expect(statusOf('bo')!.status).toBe('active');
  });

  it('someone who left a public pod rejoins by themselves', async () => {
    await leavePod('p1', 'ana');
    await joinPod('p1', 'ana', M);
    expect(statusOf('ana')!.status).toBe('active');
  });

  // Fix round 2: an account closure (deleteUser) marks its rows 'closed', not 'removed': once the account is reopened,
  // the member comes back to a public pod by themselves and the mark clears.
  it('a reopened account whose pod rows the closure removed rejoins a public pod by themselves', async () => {
    rows.push({ user_id: 'reopened', role: 'member', status: 'removed', removal_kind: 'closed', left_at: hourAgo() });
    await joinPod('p1', 'reopened', M);
    expect(statusOf('reopened')).toMatchObject({ status: 'active', removal_kind: null });
  });

  it('account closure writes removal_kind closed (never removed) on every active pod row', () => {
    const fsx = jest.requireActual('fs') as typeof import('fs');
    const pathx = jest.requireActual('path') as typeof import('path');
    const src = fsx.readFileSync(pathx.join(__dirname, '../../../services/identity/identity.service.ts'), 'utf8');
    expect(src).toContain("UPDATE pod_members SET status = 'removed', removal_kind = 'closed', left_at = NOW() WHERE user_id = $1 AND status = 'active'");
  });
});

describe('invites cannot undo a removal unless an organiser decided it', () => {
  beforeEach(async () => { await removeMember('p1', 'ana', 'dir', M); statusOf('ana')!.left_at = hourAgo(); });

  it('a shared link (no address, or many uses) is refused', async () => {
    await expect(addMember('p1', 'ana', PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, invite('dir', { inviteeEmail: null, maxUses: 50 })))
      .rejects.toMatchObject({ statusCode: 403, message: REMOVED_FROM_POD });
    await expect(addMember('p1', 'ana', PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, invite('dir', { maxUses: 5 })))
      .rejects.toMatchObject({ message: REMOVED_FROM_POD });
  });

  it('a plain member\'s personal invite is refused', async () => {
    await expect(addMember('p1', 'ana', PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, invite('mem')))
      .rejects.toMatchObject({ message: REMOVED_FROM_POD });
  });

  it('an organiser\'s personal invite made BEFORE the removal is refused (the removal is the newer decision)', async () => {
    await expect(addMember('p1', 'ana', PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, invite('dir', { createdAt: new Date(Date.now() - 7200_000) })))
      .rejects.toMatchObject({ message: REMOVED_FROM_POD });
  });

  it('an organiser\'s (director\'s or host\'s) personal invite made after the removal readmits them', async () => {
    await addMember('p1', 'ana', PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, invite('host'));
    expect(statusOf('ana')).toMatchObject({ status: 'active', removal_kind: null });
  });

  it('a platform admin\'s personal invite made after the removal readmits them', async () => {
    await addMember('p1', 'ana', PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, invite('stefan'));
    expect(statusOf('ana')!.status).toBe('active');
  });

  it('someone never removed is let in by any invite, as before', async () => {
    await addMember('p1', 'newcomer', PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, invite('mem', { inviteeEmail: null, maxUses: 50 }));
    expect(statusOf('newcomer')!.status).toBe('active');
  });
});

describe('who may remove whom (S2 fix round 1)', () => {
  it('nobody but a platform admin removes the director', async () => {
    await expect(removeMember('p1', 'dir', 'host', M)).rejects.toMatchObject({ statusCode: 403, message: DIRECTOR_NOT_REMOVED });
    await expect(removeMember('p1', 'dir', 'dir', M)).rejects.toMatchObject({ statusCode: 403, message: DIRECTOR_NOT_REMOVED });
    expect(statusOf('dir')!.status).toBe('active');
  });

  it('a host removes members, not another host; the director removes a host', async () => {
    await expect(removeMember('p1', 'host2', 'host', M)).rejects.toMatchObject({ statusCode: 403, message: ONLY_DIRECTOR_REMOVES_HOSTS });
    await removeMember('p1', 'mem', 'host', M);
    expect(statusOf('mem')!.status).toBe('removed');
    await removeMember('p1', 'host2', 'dir', M);
    expect(statusOf('host2')!.status).toBe('removed');
  });

  it('a platform admin keeps the power to remove anyone, the director included', async () => {
    await removeMember('p1', 'dir', 'stefan', UserRole.ADMIN);
    expect(statusOf('dir')!.status).toBe('removed');
  });
});
