// ─── Shirley pilot S2 (11 Nov 2026): the community routes, by role ─────────────────────────────────────────────────
// The real circle, pod and invite routes and the real gates (assertCircleManager, assertCircleOwner, canViewPod), on a
// fake database that holds one circle and one private pod and answers the gates' own statements. The services behind
// the gates are stand-ins (their rules: circle-roles.service.test.ts, circle-s2-pods-leave.test.ts,
// pod-access.test.ts; the same statements run on Postgres in the task's PGlite harness).
//
// People: OWNER (the circle's owner, Shirley), MOD (a moderator), MEMBER (in the circle), PENDING (asked to join, not
// in), INVITED (invited, not in), REMOVED and LEFT (no circle row; removed from / left the private pod), STRANGER, and
// STEFAN (a super admin in nothing). In the private pod: DIRECTOR (OWNER), HOST, PMEMBER, and the rows of REMOVED and
// LEFT, which are no longer active.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: {
    jwtSecret: JWT_SECRET, jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d', magicLinkSecret: 'm', magicLinkExpiryMinutes: 15,
    clientUrl: 'http://localhost:5173', apiBaseUrl: 'http://localhost:3001', rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockDb = jest.fn();
jest.mock('../../db', () => ({ query: (...args: unknown[]) => mockDb(...args), transaction: jest.fn(), __esModule: true }));
jest.mock('../../services/circle/circle.service');
jest.mock('../../services/circle/circle-join.service');
jest.mock('../../services/circle/circle-wall.service');
jest.mock('../../services/circle/circle-entities.service');
jest.mock('../../services/circle/circle-roles.service');
jest.mock('../../services/pod/pod.service');
jest.mock('../../middleware/audit', () => ({ auditMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(), __esModule: true }));
jest.mock('../../services/invite/invite.service', () => {
  const actual = jest.requireActual('../../services/invite/invite.service');
  return {
    ...(jest.createMockFromModule('../../services/invite/invite.service') as Record<string, unknown>),
    isAdminRole: actual.isAdminRole,
    maskEmail: actual.maskEmail,
  };
});
jest.mock('../../services/invite/invite-candidates.service', () => ({
  listInviteCandidates: jest.fn(), createInvitesBatch: jest.fn(), declinedAddresses: jest.fn(), BATCH_MAX: 50, __esModule: true,
}));
jest.mock('../../services/invite/invite-reminders.service', () => ({
  reminderAllowance: jest.fn(), claimReminders: jest.fn(), releaseReminders: jest.fn(), countRemindersSent: jest.fn(), __esModule: true,
}));
const mockIo = { name: 'the socket server' };
const mockEmitEntities = jest.fn();
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => mockIo,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));

import circleRoutes from '../../routes/circles';
import podRoutes from '../../routes/pods';
import inviteRoutes from '../../routes/invites';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import * as circleService from '../../services/circle/circle.service';
import * as joinService from '../../services/circle/circle-join.service';
import * as roleService from '../../services/circle/circle-roles.service';
import * as podService from '../../services/pod/pod.service';
import * as inviteService from '../../services/invite/invite.service';
import { E } from '../../realtime/entities';
import { PodMemberRole } from '@rsn/shared';

const CIRCLE = '0431b73a-70d1-4d7f-b8f0-bae146f0c4b6';
const PRIVATE_POD = '2b1e2609-2867-4563-ba51-ec8fe26c15d5';
const APPROVAL_POD = '8e8394c3-a33f-4fca-aee4-3a6a60405802';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(1); const MOD = id(2); const MEMBER = id(3); const PENDING = id(4); const INVITED = id(5);
const REMOVED = id(6); const LEFT = id(7); const STRANGER = id(8); const STEFAN = id(9); const HOST = id(10); const PMEMBER = id(11);

const circleRoles: Record<string, string> = { [OWNER]: 'owner', [MOD]: 'moderator', [MEMBER]: 'member' };
const podRows: Record<string, Record<string, { role: string; status: string }>> = {
  [PRIVATE_POD]: {
    [OWNER]: { role: 'director', status: 'active' }, [HOST]: { role: 'host', status: 'active' },
    [PMEMBER]: { role: 'member', status: 'active' }, [REMOVED]: { role: 'member', status: 'removed' },
    [LEFT]: { role: 'member', status: 'left' },
  },
  [APPROVAL_POD]: { [OWNER]: { role: 'director', status: 'active' }, [PENDING]: { role: 'member', status: 'pending_approval' } },
};
const podVisibility: Record<string, string> = { [PRIVATE_POD]: 'private', [APPROVAL_POD]: 'public_with_approval' };

const app = express();
app.use(express.json());
app.use('/circles', circleRoutes);
app.use('/pods', podRoutes);
app.use('/invites', inviteRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const as = (sub: string, role = 'member') =>
  ({ Authorization: `Bearer ${jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const who = (user: string) => (user === STEFAN ? as(STEFAN, 'super_admin') : as(user));

beforeEach(() => {
  jest.clearAllMocks();
  mockEmitEntities.mockResolvedValue(undefined);
  mockDb.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/SELECT status, account_kind FROM users/.test(text)) return { rows: [{ status: 'active', account_kind: 'member' }] };
    if (/^SELECT id, name, join_policy FROM circles WHERE id = \$1 AND archived_at IS NULL$/.test(text)) {
      return { rows: params[0] === CIRCLE ? [{ id: CIRCLE, name: 'Curious Humans', join_policy: 'open' }] : [] };
    }
    if (/^SELECT 1 FROM circle_members m WHERE m\.circle_id = \$1 AND m\.user_id = \$2 AND m\.role IN \('owner', 'moderator'\)$/.test(text)) {
      return { rows: ['owner', 'moderator'].includes(circleRoles[String(params[1])]) ? [{}] : [] };
    }
    if (/^SELECT role FROM circle_members WHERE circle_id = \$1 AND user_id = \$2$/.test(text)) {
      const role = circleRoles[String(params[1])];
      return { rows: role ? [{ role }] : [] };
    }
    if (/^SELECT p\.visibility::text AS visibility, EXISTS/.test(text)) {
      const pod = String(params[0]);
      if (!podVisibility[pod]) return { rows: [] };
      return { rows: [{ visibility: podVisibility[pod], active_member: podRows[pod]?.[String(params[1])]?.status === 'active' }] };
    }
    if (/^SELECT role FROM pod_members WHERE pod_id = \$1 AND user_id = \$2 AND status = 'active'$/.test(text)) {
      const row = podRows[String(params[0])]?.[String(params[1])];
      return { rows: row?.status === 'active' ? [{ role: row.role }] : [] };
    }
    return { rows: [] };
  });
  jest.mocked(podService.getMemberRole).mockImplementation(async (podId: string, userId: string) => {
    const row = podRows[podId]?.[userId];
    return row?.status === 'active' ? (row.role as PodMemberRole) : null;
  });
  jest.mocked(podService.getPodById).mockResolvedValue({ id: PRIVATE_POD } as never);
  jest.mocked(podService.getSessionCountForPod).mockResolvedValue(2);
  jest.mocked(podService.getJoinConfig).mockResolvedValue({ rulesText: 'Be kind' });
  jest.mocked(podService.getPodMembers).mockResolvedValue([]);
  jest.mocked(podService.getMemberStatusCounts).mockResolvedValue({} as never);
  jest.mocked(podService.addMember).mockResolvedValue({ id: 'm' } as never);
  jest.mocked(circleService.updateCircle).mockResolvedValue({ approvedUserIds: [] });
  jest.mocked(circleService.attachPod).mockResolvedValue(undefined);
  jest.mocked(circleService.detachPod).mockResolvedValue({ detached: true });
  jest.mocked(circleService.listCirclesOfPod).mockResolvedValue([{ id: CIRCLE, name: 'Curious Humans' }]);
  jest.mocked(joinService.ringApproved).mockResolvedValue(undefined);
  jest.mocked(joinService.ringNewOwner).mockResolvedValue(undefined);
  jest.mocked(roleService.setCircleMemberRole).mockResolvedValue({ changed: true, circleName: 'Curious Humans', from: 'member', to: 'moderator' });
  jest.mocked(roleService.transferCircleOwnership).mockResolvedValue({ circleName: 'Curious Humans', previousOwnerId: OWNER });
  jest.mocked(inviteService.listCircleInvites).mockResolvedValue([]);
});

// ── Circles: the role × action matrix at the routes' own gates ────────────────────────────────────────────────────

const PEOPLE = [
  ['owner', OWNER], ['moderator', MOD], ['member', MEMBER], ['non-member', STRANGER], ['invited', INVITED],
  ['pending request', PENDING], ['super admin', STEFAN], ['removed', REMOVED], ['left', LEFT],
] as const;
const runs = new Set<string>([OWNER, MOD, STEFAN]);
const owns = new Set<string>([OWNER, STEFAN]);

describe('the circle routes, by role (S2, D3)', () => {
  it.each(PEOPLE)('edit details (name, description): %s', async (_who, user) => {
    const res = await request(app).patch(`/circles/${CIRCLE}`).set(who(user)).send({ name: 'Curious Humans', description: 'A broad, open circle' });
    expect(res.status).toBe(runs.has(user) ? 200 : 403);
    expect(jest.mocked(circleService.updateCircle).mock.calls.length).toBe(runs.has(user) ? 1 : 0);
  });

  it.each(PEOPLE)('choose who can join: %s (the owner\'s alone, and platform admins)', async (_who, user) => {
    const res = await request(app).patch(`/circles/${CIRCLE}`).set(who(user)).send({ joinPolicy: 'closed' });
    expect(res.status).toBe(owns.has(user) ? 200 : 403);
    if (!owns.has(user)) expect(res.body.error.message).toBe("Only the circle's owner can choose who can join.");
  });

  it.each(PEOPLE)('see the invitations list: %s', async (_who, user) => {
    const res = await request(app).get(`/invites/circle/${CIRCLE}`).set(who(user));
    expect(res.status).toBe(runs.has(user) ? 200 : 403);
    if (runs.has(user)) {
      expect(inviteService.listCircleInvites).toHaveBeenCalledWith(CIRCLE, { userId: user, isAdmin: user === STEFAN });
    }
  });

  it.each(PEOPLE)('attach a pod: %s', async (_who, user) => {
    const res = await request(app).post(`/circles/${CIRCLE}/pods`).set(who(user)).send({ podId: PRIVATE_POD });
    expect(res.status).toBe(runs.has(user) ? 201 : 403);
  });

  it('the invitations list of a missing circle is a 404; a malformed id a 400 in words', async () => {
    expect((await request(app).get(`/invites/circle/${id(99)}`).set(who(OWNER))).status).toBe(404);
    expect((await request(app).get('/invites/circle/not-an-id').set(who(OWNER))).status).toBe(400);
  });
});

describe('PATCH /circles/:id/members/:userId/role and POST /circles/:id/transfer (S2)', () => {
  it('a role change goes to the service with the actor; the changed person and the circle are told', async () => {
    const res = await request(app).patch(`/circles/${CIRCLE}/members/${MEMBER.toUpperCase()}/role`).set(who(OWNER)).send({ role: 'moderator' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ role: 'moderator', changed: true });
    expect(roleService.setCircleMemberRole).toHaveBeenCalledWith(CIRCLE, MEMBER, 'moderator', { userId: OWNER, role: 'member' });
    await settle();
    const tags = mockEmitEntities.mock.calls.filter(([, to]) => (to as string[]).includes(MEMBER)).flatMap(([, , t]) => t as string[]);
    expect(tags).toEqual(expect.arrayContaining([E.circle(CIRCLE), E.circleMembers(CIRCLE), E.userCircles(MEMBER)]));
  });

  it('a change that changed nothing tells nobody', async () => {
    jest.mocked(roleService.setCircleMemberRole).mockResolvedValueOnce({ changed: false, circleName: 'C', from: 'moderator', to: 'moderator' });
    expect((await request(app).patch(`/circles/${CIRCLE}/members/${MOD}/role`).set(who(OWNER)).send({ role: 'moderator' })).status).toBe(200);
    await settle();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it.each([[{ role: 'owner' }], [{ role: 'director' }], [{}], [{ role: 'MODERATOR' }]])('the role must be moderator or member: %j is a 400 in words', async (body) => {
    const res = await request(app).patch(`/circles/${CIRCLE}/members/${MEMBER}/role`).set(who(OWNER)).send(body);
    expect(res.status).toBe(400);
    expect(roleService.setCircleMemberRole).not.toHaveBeenCalled();
  });

  it('a malformed member or circle id is a 400, never reaching the service', async () => {
    expect((await request(app).patch(`/circles/${CIRCLE}/members/nope/role`).set(who(OWNER)).send({ role: 'member' })).status).toBe(400);
    expect((await request(app).post('/circles/nope/transfer').set(who(OWNER)).send({ toUserId: MEMBER })).status).toBe(400);
    expect((await request(app).post(`/circles/${CIRCLE}/transfer`).set(who(OWNER)).send({ toUserId: 'nope' })).status).toBe(400);
    expect(roleService.transferCircleOwnership).not.toHaveBeenCalled();
  });

  it('a service refusal (403, 409, 400) is the answer, and nobody is told or rung', async () => {
    const { AppError } = jest.requireActual('../../middleware/errors');
    jest.mocked(roleService.transferCircleOwnership).mockRejectedValueOnce(new AppError(403, 'AUTH_FORBIDDEN', "Only the circle's owner can do that."));
    const res = await request(app).post(`/circles/${CIRCLE}/transfer`).set(who(MOD)).send({ toUserId: MEMBER });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("Only the circle's owner can do that.");
    await settle();
    expect(mockEmitEntities).not.toHaveBeenCalled();
    expect(joinService.ringNewOwner).not.toHaveBeenCalled();
  });

  it('a handover tells both people (each their own circles list) and everyone in the circle, and rings the new owner', async () => {
    const res = await request(app).post(`/circles/${CIRCLE}/transfer`).set(who(OWNER)).send({ toUserId: MEMBER });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ownerId: MEMBER, previousOwnerId: OWNER });
    expect(roleService.transferCircleOwnership).toHaveBeenCalledWith(CIRCLE, MEMBER, { userId: OWNER, role: 'member' });
    await settle();
    expect(joinService.ringNewOwner).toHaveBeenCalledWith(CIRCLE, 'Curious Humans', MEMBER);
    for (const person of [MEMBER, OWNER]) {
      const tags = mockEmitEntities.mock.calls.filter(([, to]) => (to as string[]).includes(person)).flatMap(([, , t]) => t as string[]);
      expect(tags).toEqual(expect.arrayContaining([E.circle(CIRCLE), E.circleMembers(CIRCLE), E.userCircles(MEMBER), E.userCircles(OWNER)]));
    }
  });

  it('both are rate limited with the circle write allowance', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../routes/circles.ts'), 'utf8');
    expect(src).toMatch(/router\.patch\('\/:id\/members\/:userId\/role', authenticate, circleWriteLimiter,/);
    expect(src).toMatch(/router\.post\('\/:id\/transfer', authenticate, circleWriteLimiter,/);
  });
});

// ── Pods: a removed or left member, and everyone else, on every read route ──────────────────────────────────────

describe('a private pod\'s read routes, by who asks (S2)', () => {
  const READS: Array<[string, string, number]> = [
    // route, the path, what an outsider (removed, left, stranger, invited, circle member) gets
    ['overview', `/pods/${PRIVATE_POD}`, 404],
    ['events count', `/pods/${PRIVATE_POD}/session-count`, 404],
    ['joining rules', `/pods/${PRIVATE_POD}/join-config`, 404],
    ['circles it is in', `/circles/of-pod/${PRIVATE_POD}`, 404],
    ['members', `/pods/${PRIVATE_POD}/members`, 403],
    ['live event', `/pods/${PRIVATE_POD}/active-session`, 403],
    ['member counts', `/pods/${PRIVATE_POD}/member-counts`, 403],
    ['invitations', `/invites/pod/${PRIVATE_POD}`, 403],
  ];
  const OUTSIDERS = [['removed', REMOVED], ['left', LEFT], ['non-member', STRANGER], ['invited (not accepted)', INVITED], ['circle member only', MEMBER], ['circle moderator', MOD]] as const;

  for (const [route, url, outsider] of READS) {
    it.each(OUTSIDERS)(`${route}: %s is refused (${outsider})`, async (_who, user) => {
      const res = await request(app).get(url).set(who(user));
      expect(res.status).toBe(outsider);
    });
  }

  it.each(READS.slice(0, 4))('%s: an active member (director, host, member) and a super admin read it', async (_route, url) => {
    for (const user of [OWNER, HOST, PMEMBER, STEFAN]) {
      expect((await request(app).get(url).set(who(user))).status).toBe(200);
    }
  });

  it('an approval pod\'s overview and events count stay discoverable to anyone; its member list stays members-only', async () => {
    for (const user of [STRANGER, REMOVED, PENDING]) {
      expect((await request(app).get(`/pods/${APPROVAL_POD}`).set(who(user))).status).toBe(200);
      expect((await request(app).get(`/pods/${APPROVAL_POD}/session-count`).set(who(user))).status).toBe(200);
      expect((await request(app).get(`/pods/${APPROVAL_POD}/members`).set(who(user))).status).toBe(403);
    }
  });

  it('a missing pod reads as 404 on the gated routes; a malformed id is a 400 in words', async () => {
    expect((await request(app).get(`/pods/${id(77)}/session-count`).set(who(OWNER))).status).toBe(404);
    expect((await request(app).get('/pods/nope/join-config').set(who(OWNER))).status).toBe(400);
  });
});

describe('a pod\'s director stays the only director (S2)', () => {
  // Fix round 1 (controller ruling: super admin powers unchanged): a platform admin may still add a director.
  it('the director and a host cannot add a director (403 in words); a super admin can', async () => {
    for (const user of [OWNER, HOST, PMEMBER]) {
      const res = await request(app).post(`/pods/${PRIVATE_POD}/members`).set(who(user)).send({ userId: STRANGER, role: 'director' });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Only a platform admin can add a director.');
    }
    expect(podService.addMember).not.toHaveBeenCalled();
    const admin = await request(app).post(`/pods/${PRIVATE_POD}/members`).set(who(STEFAN)).send({ userId: STRANGER, role: 'director' });
    expect(admin.status).toBe(201);
    expect(podService.addMember).toHaveBeenCalledWith(PRIVATE_POD, STRANGER, PodMemberRole.DIRECTOR);
  });

  it('any other role word is a 400 in words', async () => {
    expect((await request(app).post(`/pods/${PRIVATE_POD}/members`).set(who(OWNER)).send({ userId: STRANGER, role: 'owner' })).status).toBe(400);
  });

  it('a host adds a member, but not a host (403 in words); the director adds a host', async () => {
    expect((await request(app).post(`/pods/${PRIVATE_POD}/members`).set(who(HOST)).send({ userId: STRANGER })).status).toBe(201);
    expect(podService.addMember).toHaveBeenLastCalledWith(PRIVATE_POD, STRANGER, PodMemberRole.MEMBER);
    const refused = await request(app).post(`/pods/${PRIVATE_POD}/members`).set(who(HOST)).send({ userId: STRANGER, role: 'host' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe("Only the pod's director can add a host.");
    expect((await request(app).post(`/pods/${PRIVATE_POD}/members`).set(who(OWNER)).send({ userId: STRANGER, role: 'host' })).status).toBe(201);
    expect(podService.addMember).toHaveBeenLastCalledWith(PRIVATE_POD, STRANGER, PodMemberRole.HOST);
  });

  it('a member, someone removed and a stranger add nobody (403)', async () => {
    for (const user of [PMEMBER, REMOVED, STRANGER]) {
      expect((await request(app).post(`/pods/${PRIVATE_POD}/members`).set(who(user)).send({ userId: id(50) })).status).toBe(403);
    }
  });
});

describe('the pod settings (S2, D2)', () => {
  // Fix round 1: an "invite only" that still arrives (an old client, a request mid-deploy) is stored as Private.
  it('"invite_only" is accepted and stored as private, when making and when editing a pod', async () => {
    jest.mocked(podService.createPod).mockResolvedValueOnce({ id: PRIVATE_POD } as never);
    jest.mocked(podService.updatePod).mockResolvedValueOnce({ id: PRIVATE_POD } as never);
    expect((await request(app).post('/pods').set(who(OWNER)).send({ name: 'Curious 12', visibility: 'invite_only' })).status).toBe(201);
    expect(jest.mocked(podService.createPod).mock.calls[0][1]).toMatchObject({ visibility: 'private' });
    expect((await request(app).put(`/pods/${PRIVATE_POD}`).set(who(OWNER)).send({ visibility: 'invite_only' })).status).toBe(200);
    expect(jest.mocked(podService.updatePod).mock.calls[0][2]).toMatchObject({ visibility: 'private' });
  });

  it.each(['request_to_join', 'secret'])('"%s" is refused when making or editing a pod (400 in words)', async (visibility) => {
    const made = await request(app).post('/pods').set(who(OWNER)).send({ name: 'Curious 12', visibility });
    expect(made.status).toBe(400);
    const edited = await request(app).put(`/pods/${PRIVATE_POD}`).set(who(OWNER)).send({ visibility });
    expect(edited.status).toBe(400);
    expect(podService.createPod).not.toHaveBeenCalled();
    expect(podService.updatePod).not.toHaveBeenCalled();
  });

  it.each(['private', 'public_with_approval', 'public'])('"%s" is accepted', async (visibility) => {
    jest.mocked(podService.createPod).mockResolvedValueOnce({ id: PRIVATE_POD } as never);
    expect((await request(app).post('/pods').set(who(OWNER)).send({ name: 'Curious 12', visibility })).status).toBe(201);
  });

  it('a pod made private (or renamed, archived) tells the circles it is in', async () => {
    jest.mocked(podService.updatePod).mockResolvedValueOnce({ id: PRIVATE_POD } as never);
    mockDb.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql).replace(/\s+/g, ' ');
      if (/SELECT status, account_kind FROM users/.test(text)) return { rows: [{ status: 'active', account_kind: 'member' }] };
      if (/SELECT cp\.circle_id FROM circle_pods cp JOIN circles c/.test(text)) return { rows: params[0] === PRIVATE_POD ? [{ circle_id: CIRCLE }] : [] };
      if (/SELECT user_id FROM circle_members WHERE circle_id = \$1 UNION/.test(text)) return { rows: [{ user_id: MEMBER }] };
      return { rows: [] };
    });
    expect((await request(app).put(`/pods/${PRIVATE_POD}`).set(who(OWNER)).send({ visibility: 'private' })).status).toBe(200);
    await settle();
    const told = mockEmitEntities.mock.calls.filter(([, to]) => (to as string[]).includes(MEMBER)).flatMap(([, , t]) => t as string[]);
    expect(told).toContain(E.circle(CIRCLE));
  });
});

describe('every pod route is rate limited (S2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../routes/pods.ts'), 'utf8');
  const blocks = src.split(/\n(?=router\.(?:get|post|put|patch|delete)\()/).filter((b) => /^router\./.test(b));

  it('each route carries podReadLimiter (reads) or podWriteLimiter (writes) right after authenticate', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(23);
    for (const block of blocks) {
      const method = block.match(/^router\.(\w+)\(/)![1];
      expect(block).toMatch(new RegExp(`authenticate,\\s*${method === 'get' ? 'podReadLimiter' : 'podWriteLimiter'},`));
    }
  });
});
