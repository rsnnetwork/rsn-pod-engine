// ─── A pod inside a members-only main pod, on every way in through pod.service.ts (22 Nov 2026) ─────────────────────
//
// Stefan: whether people must be in the main pod first is "dependent on choice of pod owner". While the main pod's
// director has it on, nobody becomes an active or pending member of a pod inside it without being an active member of
// the main pod: not by joining a public pod, asking to join an approval pod, being added by a director or host,
// accepting an invite, or being approved on an ask made before the setting was on. Platform admins are exempt. Nobody
// already in is ever turned away or taken out, and a stand-alone pod reads nothing more. Read against a stand-in for
// the rows that answers the service's own statements, with the real gate (pod-parent-gate.ts).

interface Member { pod_id: string; user_id: string; role: string; status: string }
interface PodRow { id: string; name: string; visibility: string; parent_pod_id: string | null; members_only: boolean }
let pods: PodRow[];
let members: Member[];
const platformAdmins = new Set<string>();
const sqlSeen: string[] = [];

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const podOf = (id: unknown) => pods.find((p) => p.id === id);
const memberOf = (podId: unknown, userId: unknown) => members.find((m) => m.pod_id === podId && m.user_id === userId);

function answer(sql: string, params: unknown[] = []) {
  const s = flat(sql);
  sqlSeen.push(s);
  if (/FROM pods WHERE id = \$1 FOR UPDATE$/.test(s) || /FROM pods LEFT JOIN/.test(s)) {
    const p = podOf(params[0]);
    return { rows: p ? [{ id: p.id, name: p.name, visibility: p.visibility, status: 'active', maxMembers: null, parentPodId: p.parent_pod_id }] : [] };
  }
  if (s.includes('FROM pods child JOIN pods parent ON parent.id = child.parent_pod_id')) {
    const child = podOf(params[0]);
    const parent = child?.parent_pod_id ? podOf(child.parent_pod_id) : undefined;
    const inMain = parent && memberOf(parent.id, params[1])?.status === 'active';
    if (!parent || !parent.members_only || inMain || platformAdmins.has(String(params[1]))) return { rows: [] };
    return { rows: [{ id: parent.id, name: parent.name, visibility: parent.visibility }] };
  }
  if (s === 'SELECT id, status, removal_kind, left_at FROM pod_members WHERE pod_id = $1 AND user_id = $2') {
    const m = memberOf(params[0], params[1]);
    return { rows: m ? [{ id: 'row', status: m.status, removal_kind: null, left_at: null }] : [] };
  }
  if (s.startsWith('UPDATE pod_members SET role = $1, status = $2, joined_at = NOW(),')) {
    const m = memberOf(params[2], params[3])!;
    m.role = String(params[0]); m.status = String(params[1]);
    return { rows: [{ ...m }], rowCount: 1 };
  }
  if (s.startsWith('INSERT INTO pod_members')) {
    members.push({ pod_id: String(params[0]), user_id: String(params[1]), role: String(params[2]), status: String(params[3]) });
    return { rows: [{ podId: params[0], userId: params[1], status: params[3] }], rowCount: 1 };
  }
  if (s === "SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'") {
    const m = memberOf(params[0], params[1]);
    return { rows: m?.status === 'active' ? [{ role: m.role }] : [] };
  }
  if (s.startsWith("UPDATE pod_members SET status = 'active', joined_at = NOW(), left_at = NULL, removal_kind = NULL")) {
    const m = memberOf(params[0], params[1]);
    if (!m || m.status !== 'pending_approval') return { rows: [], rowCount: 0 };
    m.status = 'active';
    return { rows: [{ ...m }], rowCount: 1 };
  }
  if (s.includes('FROM circle_pods cp JOIN circles c')) return { rows: [] };
  if (s.startsWith('SELECT display_name, email FROM users') || s.startsWith('INSERT INTO notifications')) return { rows: [], rowCount: 0 };
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

import { ErrorCodes, PodMemberRole, PodMemberStatus, UserRole } from '@rsn/shared';
import { addMember, approveMember, joinPod, requestToJoin } from '../../../services/pod/pod.service';

const REFUSAL_SELF = 'Join Founders first. Its pods are for its members.';
const REFUSAL_ORGANISER = 'This person is not a member of Founders, and its pods are for its members. They join Founders first.';
const statusIn = (podId: string, userId: string) => memberOf(podId, userId)?.status;
const invite = { by: 'invite' as const, invite: { inviterId: 'dir', inviteeEmail: 'ana@rsn-e2e.invalid', maxUses: 1, createdAt: new Date() } };

beforeEach(() => {
  pods = [
    { id: 'main', name: 'Founders', visibility: 'public', parent_pod_id: null, members_only: true },
    { id: 'inner', name: 'Design', visibility: 'public', parent_pod_id: 'main', members_only: false },
    { id: 'askpod', name: 'Ask first', visibility: 'public_with_approval', parent_pod_id: 'main', members_only: false },
    { id: 'alone', name: 'Alone', visibility: 'public', parent_pod_id: null, members_only: false },
  ];
  members = [
    { pod_id: 'main', user_id: 'dir', role: 'director', status: 'active' },
    { pod_id: 'inner', user_id: 'dir', role: 'director', status: 'active' },
    { pod_id: 'askpod', user_id: 'dir', role: 'director', status: 'active' },
    { pod_id: 'main', user_id: 'insider', role: 'member', status: 'active' },
    { pod_id: 'main', user_id: 'leaver', role: 'member', status: 'left' },
  ];
  platformAdmins.clear(); platformAdmins.add('stefan');
  sqlSeen.length = 0;
});

const refusedWith = async (p: Promise<unknown>, message: string) => {
  await expect(p).rejects.toMatchObject({ statusCode: 403, code: ErrorCodes.MAIN_POD_MEMBERS_ONLY, message });
};

describe('while the main pod\'s pods are for its members', () => {
  it('joining a public pod inside it is refused to an outsider, and nothing is written', async () => {
    await refusedWith(joinPod('inner', 'ana', UserRole.MEMBER), REFUSAL_SELF);
    expect(statusIn('inner', 'ana')).toBeUndefined();
  });

  it('someone who left the main pod is an outsider too (an active membership is what counts)', async () => {
    await refusedWith(joinPod('inner', 'leaver', UserRole.MEMBER), REFUSAL_SELF);
  });

  it('asking to join an approval pod inside it is refused, so its organisers are never asked to let in an outsider', async () => {
    await refusedWith(requestToJoin('askpod', 'ana'), REFUSAL_SELF);
    expect(statusIn('askpod', 'ana')).toBeUndefined();
  });

  it('a director or host adding an outsider is refused, in the organiser\'s words', async () => {
    await refusedWith(addMember('inner', 'ana', PodMemberRole.MEMBER), REFUSAL_ORGANISER);
    expect(statusIn('inner', 'ana')).toBeUndefined();
  });

  it('accepting an invite to a pod inside it is refused to an outsider (an event invite reaches the pod the same way)', async () => {
    await refusedWith(addMember('inner', 'ana', undefined, undefined, invite), REFUSAL_SELF);
    expect(statusIn('inner', 'ana')).toBeUndefined();
  });

  it('an ask made before the setting was turned on is not approved until they are in the main pod', async () => {
    members.push({ pod_id: 'askpod', user_id: 'ana', role: 'member', status: 'pending_approval' });
    await refusedWith(approveMember('askpod', 'ana', 'dir', UserRole.MEMBER), REFUSAL_ORGANISER);
    expect(statusIn('askpod', 'ana')).toBe('pending_approval');
    members.push({ pod_id: 'main', user_id: 'ana', role: 'member', status: 'active' });
    await approveMember('askpod', 'ana', 'dir', UserRole.MEMBER);
    expect(statusIn('askpod', 'ana')).toBe('active');
  });

  it('an active member of the main pod joins, asks and is added as before', async () => {
    await joinPod('inner', 'insider', UserRole.MEMBER);
    expect(statusIn('inner', 'insider')).toBe('active');
    await requestToJoin('askpod', 'insider');
    expect(statusIn('askpod', 'insider')).toBe(PodMemberStatus.PENDING_APPROVAL);
  });

  it('a platform admin is exempt, joining as themselves', async () => {
    await joinPod('inner', 'stefan', UserRole.ADMIN);
    expect(statusIn('inner', 'stefan')).toBe('active');
  });

  it('someone already in the pod is answered as before (already a member), never turned away by the setting', async () => {
    members.push({ pod_id: 'inner', user_id: 'old-member', role: 'member', status: 'active' });
    await expect(addMember('inner', 'old-member', PodMemberRole.MEMBER, PodMemberStatus.ACTIVE, invite))
      .rejects.toMatchObject({ code: 'POD_MEMBER_EXISTS' });
    expect(statusIn('inner', 'old-member')).toBe('active');
  });
});

describe('when the setting is off, or the pod stands alone', () => {
  it('an outsider joins a pod inside a main pod whose director left it off (Stefan\'s default: "no")', async () => {
    pods[0].members_only = false;
    await joinPod('inner', 'ana', UserRole.MEMBER);
    expect(statusIn('inner', 'ana')).toBe('active');
  });

  it('a stand-alone pod reads nothing more: the gate is not asked', async () => {
    await joinPod('alone', 'ana', UserRole.MEMBER);
    expect(statusIn('alone', 'ana')).toBe('active');
    expect(sqlSeen.some((s) => s.includes('FROM pods child JOIN pods parent'))).toBe(false);
  });
});
