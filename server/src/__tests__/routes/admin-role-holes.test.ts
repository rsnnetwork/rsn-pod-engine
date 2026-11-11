// ─── Who may change whose role or status, and the proof an admin role change needs (Part 3 Task 2) ────────────────
//
// Two holes closed on the server (audit-5 §2.3): an admin could make anyone a super admin through the bulk
// route, and could demote, suspend or ban a super admin through either route. Now only a super admin grants or removes
// admin or super_admin, or acts on a super admin; such a role change also needs a fresh admin_role proof; member tiers
// need none. Every role change is on record with the role before and after.
//
// Through express with the real users and admin routers, the real identity service, guard and middleware; the database
// is an in-memory world.

jest.mock('../../config', () => {
  const cfg = {
    jwtSecret: 'test-jwt-secret', jwtAccessExpiry: '15m', jwtRefreshExpiry: '7d',
    magicLinkSecret: 's', magicLinkExpiryMinutes: 60,
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.test',
    googleClientId: '', googleClientSecret: '',
    rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000,
    env: 'test', isDev: false, isProd: false, isTest: true,
  };
  return { default: cfg, config: cfg, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => {
  const w = jest.requireActual('../fixtures/account-security-world');
  const run = (sql: string, params?: unknown[]) => Promise.resolve().then(() => w.answer(sql, params));
  return { query: run, transaction: (cb: (c: unknown) => Promise<unknown>) => cb({ query: run }), __esModule: true };
});
jest.mock('../../services/email/email.service', () => ({
  sendMagicLinkEmail: jest.fn().mockResolvedValue(undefined),
  sendReauthCodeEmail: jest.fn().mockResolvedValue(undefined),
  sendEmailChangeCodeEmail: jest.fn().mockResolvedValue(undefined),
  sendEmailChangedNoticeEmail: jest.fn().mockResolvedValue({ sent: true }),
  __esModule: true,
}));
jest.mock('../../realtime/fanout', () => ({
  __esModule: true,
  accountAudience: jest.fn(async () => ({ podIds: [], events: [], people: [], groupIds: [], circleIds: [] })),
  fanoutAccountAudience: jest.fn(async () => {}),
  fanoutAccountStatusChange: jest.fn(async () => {}),
  fanoutAdminEntities: jest.fn(async () => {}),
  fanoutPodEntities: jest.fn(async () => {}),
  fanoutProfileChange: jest.fn(async () => {}),
  fanoutUserBlocks: jest.fn(async () => {}),
  fanoutUserEntity: jest.fn(async () => {}),
}));
jest.mock('../../services/onboarding/avatar.service', () => ({ __esModule: true, getAvatarBlob: jest.fn(), captureAvatar: jest.fn(), hasAvatar: jest.fn(), tryGravatar: jest.fn() }));
jest.mock('../../services/user/user-search.service', () => ({ __esModule: true, searchMembers: jest.fn() }));
jest.mock('../../services/invite/connected-users', () => ({ __esModule: true, searchConnectedUsers: jest.fn() }));

import { resetWorld, world } from '../fixtures/account-security-world';
import { as, freshBuckets, grantFor, person } from '../fixtures/account-security-app';

const SUPER = person(1, { role: 'super_admin' });
const OTHER_SUPER = person(2, { role: 'super_admin' });
const ADMIN = person(3, { role: 'admin' });
const OTHER_ADMIN = person(4, { role: 'admin' });
const MEMBER = person(5);
const MEMBER_TWO = person(6);

beforeEach(() => {
  resetWorld([SUPER, OTHER_SUPER, ADMIN, OTHER_ADMIN, MEMBER, MEMBER_TWO]);
  freshBuckets([SUPER, OTHER_SUPER, ADMIN, OTHER_ADMIN, MEMBER, MEMBER_TWO]);
  jest.clearAllMocks();
});

const roleOf = (id: string) => world.users.find((u) => u.id === id)!.role;
const statusOf = (id: string) => world.users.find((u) => u.id === id)!.status;
const roleRecords = () => world.audit.filter((a) => a.action === 'user.role_changed');
const bulk = (actor: typeof ADMIN, body: object) => as(actor).post('/api/admin/users/bulk-action', body);
const liveGrants = () => world.links.filter((l) => l.purpose === 'reauth' && l.used_at && l.expires_at.getTime() > Date.now());

describe('an admin can no longer mint or touch a super admin', () => {
  it("an admin's bulk change_role to super_admin (themselves included) is 403, and nobody's role changes", async () => {
    const res = await bulk(ADMIN, { userIds: [ADMIN.id, MEMBER.id], action: 'change_role', value: 'super_admin' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only a super admin can grant or remove an admin role.');
    expect([roleOf(ADMIN.id), roleOf(MEMBER.id)]).toEqual(['admin', 'member']);
    expect(roleRecords()).toEqual([]);
  });

  it("an admin's bulk change_role to admin, or of an admin down to member, is 403", async () => {
    expect((await bulk(ADMIN, { userIds: [MEMBER.id], action: 'change_role', value: 'admin' })).status).toBe(403);
    expect((await bulk(ADMIN, { userIds: [OTHER_ADMIN.id], action: 'change_role', value: 'member' })).status).toBe(403);
    expect([roleOf(MEMBER.id), roleOf(OTHER_ADMIN.id)]).toEqual(['member', 'admin']);
  });

  it("an admin changing a super admin's role or status is 403, through either route", async () => {
    const said = 'Only a super admin can change another super admin.';
    const role = await as(ADMIN).put(`/api/users/${SUPER.id}/role`, { role: 'member' });
    expect(role.status).toBe(403);
    expect(role.body.error.message).toBe(said);
    for (const status of ['suspended', 'banned', 'deactivated']) {
      const res = await as(ADMIN).put(`/api/users/${SUPER.id}/status`, { status });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe(said);
    }
    for (const action of ['suspend', 'ban', 'delete']) {
      const res = await bulk(ADMIN, { userIds: [MEMBER.id, SUPER.id], action });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe(said);
    }
    expect([roleOf(SUPER.id), statusOf(SUPER.id), statusOf(MEMBER.id)]).toEqual(['super_admin', 'active', 'active']);
    expect(world.audit).toEqual([]);
  });

  it('an admin granting admin through PUT /users/:id/role is still 403', async () => {
    const res = await as(ADMIN).put(`/api/users/${MEMBER.id}/role`, { role: 'admin' });
    expect(res.status).toBe(403);
    expect(roleOf(MEMBER.id)).toBe('member');
  });

  it('an admin still moderates members and moves them between member tiers with no proof, and the role change is on record', async () => {
    const suspended = await bulk(ADMIN, { userIds: [MEMBER.id], action: 'suspend' });
    expect(suspended.status).toBe(200);
    expect(statusOf(MEMBER.id)).toBe('suspended');
    const host = await as(ADMIN).put(`/api/users/${MEMBER_TWO.id}/role`, { role: 'host' });
    expect(host.status).toBe(200);
    expect(roleOf(MEMBER_TWO.id)).toBe('host');
    expect(roleRecords()).toEqual([expect.objectContaining({
      actor_id: ADMIN.id, entity_id: MEMBER_TWO.id, details: JSON.stringify({ from: 'member', to: 'host' }),
    })]);
  });
});

describe('a super admin changing an admin role needs a fresh admin_role proof', () => {
  it('granting admin without one is 403 REAUTH_REQUIRED; with one it is done and on record; the proof works once', async () => {
    const without = await as(SUPER).put(`/api/users/${MEMBER.id}/role`, { role: 'admin' });
    expect(without.status).toBe(403);
    expect(without.body.error).toMatchObject({ code: 'REAUTH_REQUIRED', details: { scope: 'admin_role' } });
    expect(roleOf(MEMBER.id)).toBe('member');

    const token = await grantFor(SUPER, 'admin_role');
    const granted = await as(SUPER).put(`/api/users/${MEMBER.id}/role`, { role: 'admin', reauthToken: token });
    expect(granted.status).toBe(200);
    expect(granted.body.data.role).toBe('admin');
    expect(roleOf(MEMBER.id)).toBe('admin');
    expect(roleRecords()).toEqual([expect.objectContaining({
      actor_id: SUPER.id, entity_type: 'user', entity_id: MEMBER.id, details: JSON.stringify({ from: 'member', to: 'admin' }),
    })]);

    const replay = await as(SUPER).put(`/api/users/${MEMBER_TWO.id}/role`, { role: 'admin', reauthToken: token });
    expect(replay.status).toBe(403);
    expect(replay.body.error.code).toBe('REAUTH_REQUIRED');
    expect(roleOf(MEMBER_TWO.id)).toBe('member');
  });

  it('removing admin (an admin down to member) needs one too', async () => {
    expect((await as(SUPER).put(`/api/users/${ADMIN.id}/role`, { role: 'member' })).body.error.code).toBe('REAUTH_REQUIRED');
    const res = await as(SUPER).put(`/api/users/${ADMIN.id}/role`, { role: 'member', reauthToken: await grantFor(SUPER, 'admin_role') });
    expect(res.status).toBe(200);
    expect(roleOf(ADMIN.id)).toBe('member');
  });

  it('a proof for another kind of change is refused for an admin role', async () => {
    const res = await as(SUPER).put(`/api/users/${MEMBER.id}/role`, { role: 'admin', reauthToken: await grantFor(SUPER, 'change_email') });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REAUTH_REQUIRED');
  });

  it('the bulk route: without a proof 403; with one every account moves and each is on record', async () => {
    const body = { userIds: [MEMBER.id, MEMBER_TWO.id], action: 'change_role', value: 'admin' };
    expect((await bulk(SUPER, body)).body.error.code).toBe('REAUTH_REQUIRED');
    expect(roleOf(MEMBER.id)).toBe('member');
    const res = await bulk(SUPER, { ...body, reauthToken: await grantFor(SUPER, 'admin_role') });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ affected: 2 });
    expect([roleOf(MEMBER.id), roleOf(MEMBER_TWO.id)]).toEqual(['admin', 'admin']);
    expect(roleRecords().map((r) => [r.entity_id, JSON.parse(r.details)]).sort()).toEqual([
      [MEMBER.id, { from: 'member', to: 'admin', bulk: true }],
      [MEMBER_TWO.id, { from: 'member', to: 'admin', bulk: true }],
    ].sort());
  });

  it('a super admin may act on another super admin, with the proof a role change needs', async () => {
    expect((await as(SUPER).put(`/api/users/${OTHER_SUPER.id}/status`, { status: 'suspended' })).status).toBe(200);
    const res = await as(SUPER).put(`/api/users/${OTHER_SUPER.id}/role`, { role: 'admin', reauthToken: await grantFor(SUPER, 'admin_role') });
    expect(res.status).toBe(200);
    expect(roleOf(OTHER_SUPER.id)).toBe('admin');
  });

  it('granting a member tier (host, pro) needs no proof', async () => {
    expect((await as(SUPER).put(`/api/users/${MEMBER.id}/role`, { role: 'host' })).status).toBe(200);
    expect((await as(SUPER).put(`/api/users/${MEMBER_TWO.id}/role`, { role: 'pro' })).status).toBe(200);
    expect([roleOf(MEMBER.id), roleOf(MEMBER_TWO.id)]).toEqual(['host', 'pro']);
  });

  it('a role that does not exist is still the plain 400, before any proof is spent', async () => {
    const token = await grantFor(SUPER, 'admin_role');
    expect((await as(SUPER).put(`/api/users/${MEMBER.id}/role`, { role: 'emperor', reauthToken: token })).status).toBe(400);
    expect((await bulk(SUPER, { userIds: [MEMBER.id], action: 'change_role', value: 'host', reauthToken: token })).status).toBe(400);
    expect((await as(SUPER).put(`/api/users/${MEMBER.id}/role`, { role: 'admin', reauthToken: token })).status).toBe(200);
  });

  it('a refused change never spends the proof: an admin is refused before the proof is read', async () => {
    const token = await grantFor(ADMIN, 'admin_role');
    expect((await as(ADMIN).put(`/api/users/${MEMBER.id}/role`, { role: 'admin', reauthToken: token })).status).toBe(403);
    expect(liveGrants()).toHaveLength(1);
  });
});

describe('resolving a report with a suspend or ban follows the same rule', () => {
  const VIOLATION = '7a000000-0000-4000-8000-000000000001';
  const REPORT = '7a000000-0000-4000-8000-000000000002';
  const resolve = (actor: typeof ADMIN, id: string, body: object) => as(actor).post(`/api/admin/violations/${id}/resolve`, body);

  it("an admin resolving a violation against a super admin with suspend or ban is 403, and nothing is written", async () => {
    world.violations.push({ id: VIOLATION, reported_user_id: SUPER.id, status: 'open' });
    world.reports.push({ id: REPORT, reported_id: SUPER.id });
    for (const action of ['suspend', 'ban']) {
      const res = await resolve(ADMIN, VIOLATION, { action });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Only a super admin can change another super admin.');
      const viaReport = await resolve(ADMIN, REPORT, { action, source: 'report' });
      expect(viaReport.status).toBe(403);
    }
    expect(statusOf(SUPER.id)).toBe('active');
    expect(world.violations[0].status).toBe('open');
    expect(world.statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toEqual([]);
  });

  it('a super admin may suspend a super admin through a violation, and an admin still bans a member', async () => {
    world.violations.push({ id: VIOLATION, reported_user_id: OTHER_SUPER.id, status: 'open' });
    const res = await resolve(SUPER, VIOLATION, { action: 'suspend', adminNotes: 'Spam' });
    expect(res.status).toBe(200);
    expect(statusOf(OTHER_SUPER.id)).toBe('suspended');
    expect(world.violations[0].status).toBe('actioned');

    world.violations.push({ id: REPORT, reported_user_id: MEMBER.id, status: 'open' });
    expect((await resolve(ADMIN, REPORT, { action: 'ban' })).status).toBe(200);
    expect(statusOf(MEMBER.id)).toBe('banned');
  });

  it('an admin may still dismiss or warn on a report against a super admin: nothing about the account changes', async () => {
    world.violations.push({ id: VIOLATION, reported_user_id: SUPER.id, status: 'open' });
    expect((await resolve(ADMIN, VIOLATION, { action: 'warn' })).status).toBe(200);
    expect(world.violations[0].status).toBe('actioned');
    expect(statusOf(SUPER.id)).toBe('active');
  });
});
