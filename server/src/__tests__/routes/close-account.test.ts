// ─── Close one's own account (Part 3 Task 2, 11 Nov 2026) ──────────────────────────────────────────────────────────
//
// A fresh close_account proof, then the same close an admin's DELETE /users/:id makes (deleteUser: out of every pod and
// event, every session revoked, the account deactivated), on record as the member's own act. And the three member routes
// are closed to event guests (none is in GUEST_ROUTES).
//
// Through express with the real routers, services, middleware and limiters; the database is an in-memory world.

import request from 'supertest';

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
import { app, as, freshBuckets, grantFor, person } from '../fixtures/account-security-app';
import { generateTokenPair, getUserById } from '../../services/identity/identity.service';
import { sendEmailChangeCodeEmail, sendReauthCodeEmail } from '../../services/email/email.service';
import * as fanout from '../../realtime/fanout';

const ANA = person(1);
const BO = person(2);
const GUEST = person(3, { accountKind: 'event_guest', email: 'guest3@reason-members.org' });

beforeEach(() => {
  resetWorld([ANA, BO, GUEST]);
  freshBuckets([ANA, BO, GUEST], ['guest.new@reason-members.org']);
  jest.clearAllMocks();
});

const userOf = (id: string) => world.users.find((u) => u.id === id)!;

describe('POST /api/users/me/close', () => {
  it('without a fresh close_account proof it is 403 REAUTH_REQUIRED, and the account stays open', async () => {
    const none = await as(ANA).post('/api/users/me/close', {});
    expect(none.status).toBe(403);
    expect(none.body.error).toMatchObject({ code: 'REAUTH_REQUIRED', details: { scope: 'close_account' } });
    const wrongKind = await as(ANA).post('/api/users/me/close', { reauthToken: await grantFor(ANA, 'change_email') });
    expect(wrongKind.status).toBe(403);
    expect(userOf(ANA.id).status).toBe('active');
    expect(world.audit).toEqual([]);
  });

  it('with one, closes the account as deleteUser does, revokes every session, records it, and tells everyone around', async () => {
    const phone = await generateTokenPair(await getUserById(ANA.id));
    const order: string[] = [];
    (fanout.accountAudience as jest.Mock).mockImplementation(async () => {
      order.push(`audience while ${userOf(ANA.id).status}`);
      return { podIds: ['pod-1'], events: [], people: ['friend-1'], groupIds: [], circleIds: [] };
    });
    (fanout.fanoutAccountAudience as jest.Mock).mockImplementation(async () => { order.push(`told while ${userOf(ANA.id).status}`); });

    const res = await as(ANA).post('/api/users/me/close', { reauthToken: await grantFor(ANA, 'close_account') });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ closed: true });
    expect(userOf(ANA.id).status).toBe('deactivated');
    expect(world.refresh.filter((r) => r.user_id === ANA.id && !r.revoked_at)).toEqual([]);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: phone.refreshToken })).status).toBe(401);
    expect(world.statements).toEqual(expect.arrayContaining([
      expect.stringMatching(/^UPDATE pod_members SET status = 'removed'/),
      expect.stringMatching(/^UPDATE session_participants SET status = 'removed'/),
    ]));
    expect(world.audit).toEqual([expect.objectContaining({ actor_id: ANA.id, action: 'user.closed_self', entity_type: 'user', entity_id: ANA.id })]);
    expect(order).toEqual(['audience while active', 'told while deactivated']);
    expect(fanout.fanoutAccountAudience).toHaveBeenCalledWith(expect.objectContaining({ podIds: ['pod-1'] }), ANA.id);
    expect(fanout.fanoutUserEntity).toHaveBeenCalledWith(ANA.id);
    expect(fanout.fanoutAdminEntities).toHaveBeenCalledWith('users');
    // The next signed-in call is refused: the account is closed.
    const next = await as(ANA).get('/api/users/me');
    expect(next.status).toBe(401);
  });

  it('closes only the caller: Bo is untouched', async () => {
    await as(ANA).post('/api/users/me/close', { reauthToken: await grantFor(ANA, 'close_account') });
    expect(userOf(BO.id).status).toBe('active');
  });
});

describe('an event guest gets 403 GUEST_MEMBERSHIP_REQUIRED on all three member routes, and nothing is written', () => {
  it.each([
    ['/api/users/me/email/code', { newEmail: 'guest.new@reason-members.org', reauthToken: 'x' }],
    ['/api/users/me/email/verify', { code: '123456' }],
    ['/api/users/me/close', { reauthToken: 'x' }],
  ])('POST %s', async (path, body) => {
    const res = await as(GUEST).post(path, body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('GUEST_MEMBERSHIP_REQUIRED');
    expect(world.statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s))).toEqual([]);
    expect(userOf(GUEST.id)).toMatchObject({ status: 'active', email: GUEST.email });
    expect(sendEmailChangeCodeEmail).not.toHaveBeenCalled();
    expect(sendReauthCodeEmail).not.toHaveBeenCalled();
  });
});
