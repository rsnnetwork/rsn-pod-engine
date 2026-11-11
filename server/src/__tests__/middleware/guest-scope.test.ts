// ─── An event guest reaches only what guest-scope.ts lists (Part 2, Task 3, 10 Nov 2026) ─────────────────────
//
// Review focus 1: a guest (users.account_kind = 'event_guest') must never reach a member surface. These go through
// Express with EVERY real router mounted exactly where index.ts mounts it, and the real authenticate, which reads the
// caller's status and kind from the database stand-in below (never from the token). A guest is refused with 403
// GUEST_MEMBERSHIP_REQUIRED on one route under every member-only prefix; no allowlisted route refuses them; a member is
// never refused; a guest promoted to member is let in once their cached kind is dropped; and an outage never lets a
// guest in. Then the dm:* socket guard, and the SQL of every discovery list.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const SECRET = 'guest-scope-test-secret';
const GUEST = '9e570000-0000-4000-8000-000000000001';
const MEMBER = '9e570000-0000-4000-8000-000000000002';
const OTHER = '9e570000-0000-4000-8000-000000000003';
const EVENT = '9e570000-0000-4000-8000-0000000000e1';

jest.mock('../../config', () => ({
  default: {
    jwtSecret: 'guest-scope-test-secret', clientUrl: 'https://app.rsn.network', env: 'test', isTest: true,
    rateLimitWindowMs: 60_000, rateLimitMaxRequests: 100_000,
  },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), fatal: jest.fn(), child: jest.fn() },
  __esModule: true,
}));
jest.mock('../../services/redis/redis.client', () => ({
  getRedisClient: () => null, initRedis: async () => null, duplicateClient: () => null, __esModule: true,
}));
jest.mock('../../services/email/email.service');
jest.mock('../../realtime/fanout');
jest.mock('../../realtime/emit');

/** Each account's users row, as the database stand-in answers authenticate's read. */
const accounts = new Map<string, { status: string; account_kind: string }>();
let databaseDown = false;
const mockQuery = jest.fn(async (sql: string, params: unknown[] = []) => {
  if (/^SELECT status, account_kind FROM users WHERE id = \$1$/.test(String(sql).trim())) {
    if (databaseDown) throw new Error('connection terminated');
    const row = accounts.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  // getUserById, for GET /auth/session: the account itself, with its kind.
  if (String(sql).includes('account_kind AS "accountKind"')) {
    const row = accounts.get(String(params[0]));
    return row
      ? { rows: [{ id: params[0], email: 'x@example.com', displayName: 'X', role: 'member', status: row.status, accountKind: row.account_kind }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
});
jest.mock('../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: { query: typeof mockQuery }) => unknown) => cb({ query: mockQuery }),
  pool: { query: jest.fn(), connect: jest.fn() },
  __esModule: true,
}));

import { forgetAccountGate, readAccountGate, __test__ as authCache } from '../../middleware/auth';
import { GUEST_ROUTES, isGuestAllowed } from '../../middleware/guest-scope';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import authRoutes from '../../routes/auth';
import userRoutes from '../../routes/users';
import accountSecurityRoutes from '../../routes/account-security';
import onboardingRoutes from '../../routes/onboarding';
import onboardingV2Routes from '../../routes/onboarding-v2';
import podRoutes from '../../routes/pods';
import podWallRoutes from '../../routes/pod-wall';
import sessionRoutes from '../../routes/sessions';
import inviteRoutes from '../../routes/invites';
import ratingRoutes from '../../routes/ratings';
import hostRoutes from '../../routes/host';
import joinRequestRoutes from '../../routes/join-requests';
import adminRoutes from '../../routes/admin';
import adminActionRoutes from '../../routes/admin-actions';
import adminInspectRoutes from '../../routes/admin-inspect';
import adminFeedbackRoutes from '../../routes/admin-feedback';
import notificationRoutes from '../../routes/notifications';
import dmRoutes from '../../routes/dm';
import pokeRoutes from '../../routes/pokes';
import matchesRoutes from '../../routes/matches';
import peopleRoutes from '../../routes/people';
import agentRoutes from '../../routes/agents';
import meetingRoutes from '../../routes/meeting';
import meetingsRoutes from '../../routes/meetings';
import callsRoutes from '../../routes/calls';
import circleRoutes from '../../routes/circles';
import entityRoutes from '../../routes/entities';
import reportRoutes from '../../routes/reports';
import groupRoutes from '../../routes/groups';
import notificationPrefsRoutes from '../../routes/notification-prefs';
import postEventMessageRoutes from '../../routes/post-event-message';
import eventChatRoutes from '../../routes/event-chat';
import eventAuditRoutes from '../../routes/event-audit';
import eventLifecycleRoutes from '../../routes/event-lifecycle';
import eventGroupRoutes from '../../routes/event-groups';
import eventQuestionRoutes from '../../routes/event-questions';
import eventAdmissionRoutes from '../../routes/event-admission';
import eventWaitlistRoutes from '../../routes/event-waitlist';
import callLinkRoutes, { sessionCallLinkRoutes } from '../../routes/call-links';
import publicProfileRoutes, { publicLinkRoutes } from '../../routes/public-profiles';
import scheduleRoutes from '../../routes/schedule';
import eventImageRoutes from '../../routes/event-image';
import eventReportRoutes from '../../routes/event-report';

// The API exactly as index.ts mounts it, in the same order (the last test below holds the two lists together).
const MOUNTS: Array<[string, express.Router]> = [
  ['/api/auth', authRoutes],
  ['/api/users/me/public-link', publicLinkRoutes],
  ['/api/users/me', accountSecurityRoutes],
  ['/api/users', userRoutes],
  ['/api/onboarding/v2', onboardingV2Routes],
  ['/api/onboarding', onboardingRoutes],
  ['/api/pods', podRoutes],
  ['/api/pods', podWallRoutes],
  ['/api/sessions', sessionRoutes],
  ['/api/invites', inviteRoutes],
  ['/api/ratings', ratingRoutes],
  ['/api/sessions', hostRoutes],
  ['/api/sessions', postEventMessageRoutes],
  ['/api/sessions', eventChatRoutes],
  ['/api/sessions', eventAuditRoutes],
  ['/api/sessions', eventLifecycleRoutes],
  ['/api/sessions', eventGroupRoutes],
  ['/api/sessions', eventQuestionRoutes],
  ['/api/sessions', eventAdmissionRoutes],
  ['/api/sessions', eventWaitlistRoutes],
  ['/api/sessions', sessionCallLinkRoutes],
  ['/api/call-links', callLinkRoutes],
  ['/api/public/profiles', publicProfileRoutes],
  ['/api/sessions', scheduleRoutes],
  ['/api/sessions', eventImageRoutes],
  ['/api/sessions', eventReportRoutes],
  ['/api/join-requests', joinRequestRoutes],
  ['/api/admin', adminRoutes],
  ['/api/admin', adminInspectRoutes],
  ['/api/admin', adminFeedbackRoutes],
  ['/api/admin/join-request-action', adminActionRoutes],
  ['/api/notifications', notificationRoutes],
  ['/api/dm', dmRoutes],
  ['/api/dm', meetingRoutes],
  ['/api/calls', callsRoutes],
  ['/api/meetings', meetingsRoutes],
  ['/api/pokes', pokeRoutes],
  ['/api/matches', matchesRoutes],
  ['/api/people', peopleRoutes],
  ['/api/agents', agentRoutes],
  ['/api/circles', circleRoutes],
  ['/api/entities', entityRoutes],
  ['/api/reports', reportRoutes],
  ['/api/groups', groupRoutes],
  ['/api/notification-prefs', notificationPrefsRoutes],
];

const app = express();
app.use(express.json());
for (const [path, router] of MOUNTS) app.use(path, router);
app.use(notFoundHandler);
app.use(errorHandler);

const tokenFor = (sub: string) =>
  jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', displayName: 'Someone', sessionId: 's-1' }, SECRET, { expiresIn: '1h' });

type Verb = 'get' | 'post' | 'put' | 'delete' | 'patch';
const call = (verb: Verb, path: string, sub: string) =>
  request(app)[verb](path).set('Authorization', `Bearer ${tokenFor(sub)}`).send({});

const GUEST_CODE = 'GUEST_MEMBERSHIP_REQUIRED';

// One route under every member-only prefix (review focus 1), and the member-only routes beside the guest's own ones.
const MEMBER_ONLY: Array<[Verb, string]> = [
  ['get', '/api/people/everyone'],
  ['get', '/api/people/connections'],
  ['get', '/api/people/me/card'],
  ['get', '/api/dm/conversations'],
  ['post', '/api/dm/messages'],
  ['get', `/api/dm/can-message/${OTHER}`],
  ['get', '/api/pods'],
  ['get', `/api/pods/${OTHER}`],
  ['get', `/api/pods/${OTHER}/wall/posts`],
  ['get', '/api/circles'],
  ['get', '/api/matches/platform'],
  ['get', '/api/agents'],
  ['get', '/api/pokes/received'],
  ['post', '/api/pokes'],
  ['get', '/api/entities'],
  ['get', '/api/groups'],
  ['get', '/api/meetings'],
  ['post', `/api/calls/user/${OTHER}`],
  ['get', '/api/users/search?q=claus'],
  ['get', '/api/users/find?q=claus'],
  ['get', '/api/users/connected?q=claus'],
  ['get', `/api/users/${OTHER}`],
  ['get', '/api/users/blocked'],
  ['put', '/api/users/me/banner'],
  // Part 3 Task 2: changing the sign-in email and closing the account are members' own (a guest's address is them).
  ['post', '/api/users/me/email/code'],
  ['post', '/api/users/me/email/verify'],
  ['post', '/api/users/me/close'],
  ['get', '/api/sessions'],
  ['post', '/api/sessions'],
  ['post', `/api/sessions/${EVENT}/register`],
  ['post', `/api/sessions/${EVENT}/host/start`],
  ['get', `/api/sessions/${EVENT}/post-event-message/eligibility`],
  ['delete', `/api/sessions/${EVENT}/chat/${OTHER}`],
  ['get', `/api/sessions/${EVENT}/feedback`],
  ['get', `/api/sessions/${EVENT}/audit`],
  // Part 3 Task 5: only an organiser saves the event's matching questions (a guest answers their own only).
  ['put', `/api/sessions/${EVENT}/questions`],
  // Part 3 Task 4: the event report and its CSVs are its organisers' (members only).
  ['get', `/api/sessions/${EVENT}/report`],
  ['get', `/api/sessions/${EVENT}/report?format=csv&section=attendance`],
  // Part 2 Task 2: an event's lifecycle steps are its organisers' (members only).
  ['post', `/api/sessions/${EVENT}/publish`],
  ['post', `/api/sessions/${EVENT}/unpublish`],
  ['post', `/api/sessions/${EVENT}/cancel`],
  ['post', `/api/sessions/${EVENT}/archive`],
  ['delete', `/api/sessions/${EVENT}/archive`],
  ['post', `/api/sessions/${EVENT}/delete-permanently`],
  // Part 2 Task 8: the matching board is its organisers' private draft (members only).
  ['get', `/api/sessions/${EVENT}/schedule`],
  ['post', `/api/sessions/${EVENT}/schedule/generate`],
  ['post', `/api/sessions/${EVENT}/schedule/ops`],
  ['post', `/api/pokes/${OTHER}/withdraw`],
  ['get', `/api/sessions/${EVENT}/admission`],
  ['post', `/api/sessions/${EVENT}/admission/redeem`],
  ['get', '/api/invites/candidates'],
  ['get', '/api/admin/stats'],
  ['get', '/api/onboarding/status'],
  ['get', '/api/reports/open'],
];

// Every allowlisted route (GUEST_ROUTES), as a guest's screens call them.
const GUEST_OPEN: Array<[Verb, string]> = [
  ['get', '/api/auth/session'],
  ['post', '/api/auth/logout'],
  ['get', '/api/call-links/abcdefghjk'],
  ['get', '/api/users/me'],
  ['put', '/api/users/me'],
  ['put', '/api/users/me/avatar'],
  ['delete', '/api/users/me/avatar'],
  ['get', `/api/users/${OTHER}/avatar`],
  ['get', '/api/notifications'],
  ['post', '/api/notifications/read-all'],
  ['get', '/api/notification-prefs'],
  ['put', '/api/notification-prefs'],
  ['get', `/api/sessions/${EVENT}`],
  ['get', `/api/sessions/${EVENT}/state`],
  ['post', `/api/sessions/${EVENT}/token`],
  ['delete', `/api/sessions/${EVENT}/register`],
  // Part 3 Task 3: leaving the waiting list a guest joined through the call link.
  ['delete', `/api/sessions/${EVENT}/waitlist/mine`],
  ['post', `/api/sessions/${EVENT}/intention`],
  ['get', `/api/sessions/${EVENT}/participants`],
  ['get', `/api/sessions/${EVENT}/participant-counts`],
  ['get', `/api/sessions/${EVENT}/chat`],
  ['post', `/api/sessions/${EVENT}/feedback`],
  ['get', `/api/sessions/${EVENT}/schedule/mine`],
  ['get', `/api/sessions/${EVENT}/groups`],
  // Part 3 Task 5: the event's matching questions, and answering them for themselves.
  ['get', `/api/sessions/${EVENT}/questions`],
  ['put', `/api/sessions/${EVENT}/questions/mine`],
  ['post', '/api/ratings'],
  ['get', '/api/ratings/unrated'],
  ['get', `/api/ratings/match/${OTHER}`],
  ['post', '/api/reports'],
];

beforeEach(() => {
  authCache.clearAll();
  databaseDown = false;
  accounts.clear();
  accounts.set(GUEST, { status: 'active', account_kind: 'event_guest' });
  accounts.set(MEMBER, { status: 'active', account_kind: 'member' });
  mockQuery.mockClear();
});

describe('a guest is refused on every member-only route (403 GUEST_MEMBERSHIP_REQUIRED)', () => {
  it.each(MEMBER_ONLY)('%s %s', async (verb, path) => {
    const res = await call(verb, path, GUEST);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: GUEST_CODE,
      message: 'This part of RSN is for members. You can become a member from your event page.',
    });
  });

  it('nothing past authenticate runs for them: the only read is their own status and kind', async () => {
    for (const [verb, path] of MEMBER_ONLY) await call(verb, path, GUEST);
    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls.every((sql) => sql === 'SELECT status, account_kind FROM users WHERE id = $1')).toBe(true);
  });
});

describe('a guest is let through on every allowlisted route', () => {
  it.each(GUEST_OPEN)('%s %s', async (verb, path) => {
    const res = await call(verb, path, GUEST);
    expect(res.body?.error?.code).not.toBe(GUEST_CODE);
  });

  it('every allowlisted route is exercised above', () => {
    for (const route of GUEST_ROUTES) {
      const hit = GUEST_OPEN.some(([verb, path]) =>
        (route.method === '*' || route.method === verb.toUpperCase()) && route.pattern.test(path.split('?')[0]));
      expect({ route: `${route.method} ${route.pattern}`, hit }).toEqual({ route: `${route.method} ${route.pattern}`, hit: true });
    }
  });
});

describe('a member is never refused by the guest check', () => {
  it.each([...MEMBER_ONLY, ...GUEST_OPEN])('%s %s', async (verb, path) => {
    const res = await call(verb, path, MEMBER);
    expect(res.body?.error?.code).not.toBe(GUEST_CODE);
  });
});

describe('the kind comes from the database, through the 60-second cache', () => {
  it('a guest promoted to member is let in once their cached kind is dropped (forgetAccountGate)', async () => {
    expect((await call('get', '/api/people/everyone', GUEST)).status).toBe(403);
    accounts.set(GUEST, { status: 'active', account_kind: 'member' }); // approval flipped the row
    // Still cached as a guest on this instance: refused, and no extra read of the database.
    expect((await call('get', '/api/people/everyone', GUEST)).body.error.code).toBe(GUEST_CODE);
    expect(mockQuery.mock.calls.filter(([sql]) => /account_kind FROM users/.test(String(sql)))).toHaveLength(1);
    forgetAccountGate(GUEST);
    const res = await call('get', '/api/people/everyone', GUEST);
    expect(res.body?.error?.code).not.toBe(GUEST_CODE);
  });

  it('a token cannot claim to be a member: a guest token carrying accountKind member is still a guest', async () => {
    const forged = jwt.sign({ sub: GUEST, email: 'g@example.com', role: 'admin', accountKind: 'member' }, SECRET, { expiresIn: '1h' });
    const res = await request(app).get('/api/people/everyone').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(GUEST_CODE);
  });

  it('one read per account per minute, for the status and the kind together', async () => {
    await call('get', '/api/users/me', MEMBER);
    await call('get', '/api/pods', MEMBER);
    await call('get', '/api/people/everyone', MEMBER);
    const reads = mockQuery.mock.calls.filter(([sql]) => String(sql) === 'SELECT status, account_kind FROM users WHERE id = $1');
    expect(reads).toHaveLength(1);
  });

  it('a database outage with nothing cached answers member-only routes with a retryable 503, never the guest code', async () => {
    databaseDown = true;
    await expect(readAccountGate(MEMBER)).resolves.toEqual({ status: 'active', kind: 'event_guest', kindUnknown: true });
    for (const who of [GUEST, MEMBER]) {
      const res = await call('get', '/api/people/everyone', who);
      expect(res.status).toBe(503);
      expect(res.body.error).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'We could not reach RSN just now. Please try again in a moment.' });
    }
    // Nothing member-only ran for either (the kind still fails closed).
    expect(mockQuery.mock.calls.every(([sql]) => String(sql) === 'SELECT status, account_kind FROM users WHERE id = $1')).toBe(true);
    // A route open to everyone still answers (fail-open status).
    const me = await call('get', '/api/users/me', MEMBER);
    expect([me.status, me.body?.error?.code]).not.toContain(503);
    // Once the database answers, the member is let in at once: an unknown kind is never cached.
    databaseDown = false;
    expect((await call('get', '/api/people/everyone', MEMBER)).body?.error?.code).toBeUndefined();
  });

  it('a database outage keeps the cached kind: a member stays a member, a guest stays a guest', async () => {
    await readAccountGate(MEMBER);
    await readAccountGate(GUEST);
    // Expire both entries, then fail the next read.
    for (const id of [MEMBER, GUEST]) {
      const entry = authCache.getCached(id);
      if (entry) entry.cachedAt -= 61_000;
    }
    databaseDown = true;
    await expect(readAccountGate(MEMBER)).resolves.toEqual({ status: 'active', kind: 'member' });
    await expect(readAccountGate(GUEST)).resolves.toEqual({ status: 'active', kind: 'event_guest' });
  });

  it('a row with no kind it knows opens nothing and is not told it is a guest (503); a deactivated guest is 401', async () => {
    accounts.set(OTHER, { status: 'active', account_kind: 'something_new' });
    await expect(readAccountGate(OTHER)).resolves.toEqual({ status: 'active', kind: 'event_guest', kindUnknown: true });
    expect((await call('get', '/api/people/everyone', OTHER)).status).toBe(503);
    accounts.set(GUEST, { status: 'deactivated', account_kind: 'event_guest' });
    expect((await call('get', '/api/users/me', GUEST)).status).toBe(401);
  });
});

describe('GET /auth/session says which kind of account it is', () => {
  it.each([[GUEST, 'event_guest'], [MEMBER, 'member']])('%s is %s', async (who, kind) => {
    const res = await call('get', '/api/auth/session', who);
    expect(res.status).toBe(200);
    expect(res.body.data.user.accountKind).toBe(kind);
  });
});

describe('isGuestAllowed matches the routed path whole', () => {
  it.each([
    ['GET', `/api/sessions/${EVENT}`, true],
    ['GET', `/api/sessions/${EVENT}/`, true],
    ['GET', `/api/sessions/${EVENT.toUpperCase()}/chat`, true],
    ['get', `/api/sessions/${EVENT}/state`, true],
    ['POST', `/api/sessions/${EVENT}/chat`, false],
    ['GET', '/api/sessions', false],
    ['GET', '/api/sessions/', false],
    ['GET', `/api/sessions/${EVENT}/../people`, false],
    ['GET', `/api/sessions/${EVENT}/../../people/everyone`, false],
    ['GET', `/api/sessions/${EVENT}/participants/extra`, false],
    ['GET', `/api/sessions/${EVENT}/host/state`, false],
    ['GET', '/api/sessions/not-an-id', false],
    ['GET', `/api/sessions/${EVENT}x`, false],
    ['GET', '/api/auth/../people/everyone', false],
    ['GET', '/api/auth/%2e%2e/people', false],
    ['GET', '/api/auth//people', false],
    ['GET', '/api/ratings/./x', false],
    ['GET', '/api/auth/session', true],
    ['POST', '/api/auth/magic-link/code', true],
    ['GET', '/api/users/me', true],
    ['DELETE', '/api/users/me', false],
    ['PUT', '/api/users/me/banner', false],
    ['GET', `/api/users/${OTHER}`, false],
    ['GET', `/api/users/${OTHER}/avatar`, true],
    ['GET', `/api/users/${OTHER}/banner`, false],
    ['GET', '/api/users/search', false],
    ['GET', '/api/notifications-evil', false],
    ['GET', '/api/people', false],
    ['GET', '/api/peoplex', false],
    ['GET', '', false],
    ['', `/api/sessions/${EVENT}`, false],
    ['HEAD', `/api/sessions/${EVENT}`, false],
    ['POST', '/api/reports', true],
    ['POST', '/api/reports/', true],
    ['GET', '/api/reports', false],
    ['GET', '/api/reports/open', false],
    ['POST', `/api/reports/${OTHER}/resolve`, false],
    ['POST', `/api/reports/${OTHER}/dismiss`, false],
  ] as Array<[string, string, boolean]>)('%s %s → %s', (method, path, allowed) => {
    expect(isGuestAllowed(method, path)).toBe(allowed);
  });

  it('a path that climbs out of an allowlisted prefix never reaches another router for a guest', async () => {
    const res = await request(app)
      .get(`/api/sessions/${EVENT}/../people/everyone`)
      .set('Authorization', `Bearer ${tokenFor(GUEST)}`);
    expect([403, 404]).toContain(res.status);
    expect(res.body?.data).toBeUndefined();
  });
});

describe('the mount table here is the one index.ts serves', () => {
  it('every /api router index.ts mounts behind authenticate is mounted here at the same path', () => {
    const src = nodeFs.readFileSync(nodePath.join(__dirname, '../../index.ts'), 'utf8');
    const served = [...src.matchAll(/app\.use\('(\/api\/[^']+)',\s*([A-Za-z0-9]+)\)/g)]
      .map((m) => `${m[1]} ${m[2]}`)
      .filter((line) => !line.startsWith('/api/webhooks'));
    const mountedHere = MOUNTS.map(([path]) => path);
    expect(served.map((line) => line.split(' ')[0]).sort()).toEqual([...mountedHere].sort());
  });
});

// ─── The dm:* socket events (guest-socket-guard.ts) ─────────────────────────────────────────────────────────

import { handleDmSend, handleDmRead, handleDmReact, handleDmUnreact } from '../../services/orchestration/handlers/dm-handlers';
import { runMemberDmEvent } from '../../services/orchestration/handlers/guest-socket-guard';

type FakeSocket = { data: Record<string, unknown>; emit: jest.Mock };
const socketOf = (userId: string, accountKind?: string): FakeSocket => ({ data: { userId, accountKind }, emit: jest.fn() });
const fakeIo = { to: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(), emit: jest.fn(), fetchSockets: jest.fn().mockResolvedValue([]) };
// The real handlers take a socket.io Server and Socket; these stand-ins carry only what the guard and handlers read.
const asIo = fakeIo as unknown as Parameters<typeof runMemberDmEvent>[0];
const asSocket = (s: FakeSocket) => s as unknown as Parameters<typeof runMemberDmEvent>[1];
type DmHandler = Parameters<typeof runMemberDmEvent>[3];

describe('dm:* from a guest socket answers GUEST_MEMBERSHIP_REQUIRED and does nothing', () => {
  it.each([
    ['dm:send', handleDmSend as DmHandler, { toUserId: MEMBER, content: 'hello' }],
    ['dm:read', handleDmRead as DmHandler, { conversationId: OTHER }],
    ['dm:react', handleDmReact as DmHandler, { messageId: OTHER, emoji: 'heart' }],
    ['dm:unreact', handleDmUnreact as DmHandler, { messageId: OTHER, emoji: 'heart' }],
  ] as Array<[string, DmHandler, Record<string, unknown>]>)(
    '%s writes nothing and reads nothing past the account gate', async (_event, handler, data) => {
      const socket = socketOf(GUEST, 'event_guest');
      await runMemberDmEvent(asIo, asSocket(socket), data, handler);
      expect(socket.emit).toHaveBeenCalledWith('error', {
        code: GUEST_CODE, message: 'This part of RSN is for members. You can become a member from your event page.',
      });
      const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
      expect(sqls.filter((sql) => /INSERT|UPDATE|DELETE/i.test(sql))).toEqual([]);
      expect(sqls.every((sql) => sql === 'SELECT status, account_kind FROM users WHERE id = $1')).toBe(true);
      expect(fakeIo.emit).not.toHaveBeenCalled();
    });

  it('a member socket runs the handler', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const socket = socketOf(MEMBER, 'member');
    await runMemberDmEvent(asIo, asSocket(socket), { toUserId: GUEST, content: 'hi' }, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled(); // the handshake's kind stands; nothing is read
  });

  it('a socket opened as a guest who has since become a member is let through, and remembered as one', async () => {
    accounts.set(GUEST, { status: 'active', account_kind: 'member' });
    const handler = jest.fn().mockResolvedValue(undefined);
    const socket = socketOf(GUEST, 'event_guest');
    await runMemberDmEvent(asIo, asSocket(socket), { conversationId: OTHER }, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(socket.data.accountKind).toBe('member');
  });

  it('a socket whose kind cannot be read (the database down, nothing cached) is told to try again, not that it is a guest', async () => {
    databaseDown = true;
    const handler = jest.fn().mockResolvedValue(undefined);
    const socket = socketOf(MEMBER);
    await runMemberDmEvent(asIo, asSocket(socket), { conversationId: OTHER }, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', {
      code: 'SERVICE_UNAVAILABLE', message: 'We could not reach RSN just now. Please try again in a moment.',
    });
  });

  it('a socket with no kind recorded is asked about, never assumed a member', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const socket = socketOf(GUEST);
    await runMemberDmEvent(asIo, asSocket(socket), { conversationId: OTHER }, handler);
    expect(handler).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: GUEST_CODE }));
  });

  it('every dm:* event the server listens to goes through the guard, and the handshake records the kind', () => {
    const orchestration = nodeFs.readFileSync(nodePath.join(__dirname, '../../services/orchestration/orchestration.service.ts'), 'utf8');
    const dmEvents = [...orchestration.matchAll(/socket\.on\('(dm:[a-z_]+)'/g)].map((m) => m[1]);
    expect(dmEvents.sort()).toEqual(['dm:react', 'dm:read', 'dm:send', 'dm:unreact']);
    const wiring: Array<[string, string]> = [
      ['dm:send', 'handleDmSend'], ['dm:read', 'handleDmRead'], ['dm:react', 'handleDmReact'], ['dm:unreact', 'handleDmUnreact'],
    ];
    for (const [event, handler] of wiring) {
      const at = orchestration.indexOf(`socket.on('${event}'`);
      const body = orchestration.slice(at, orchestration.indexOf('});', at));
      expect(body).toContain(`runMemberDmEvent(io, socket, data, ${handler})`);
    }
    const index = nodeFs.readFileSync(nodePath.join(__dirname, '../../index.ts'), 'utf8');
    expect(index).toContain('socket.data.accountKind = member.accountKind;');
  });
});

// ─── Every discovery list keeps members only ────────────────────────────────────────────────────────────────
//
// Defence in depth beside onboarding_completed and profile_visible: a guest row that wrongly had both set would still
// never be listed. Run for real against Postgres in the read-only probe (task report); here, the SQL each list sends.

import { listEveryone } from '../../services/people/everyone.service';
import { searchMembers } from '../../services/user/user-search.service';
import { searchConnectedUsers } from '../../services/invite/connected-users';

const source = (rel: string) => nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8').replace(/\r\n/g, '\n');
const between = (src: string, from: string, to: string): string => {
  const at = src.indexOf(from);
  if (at < 0) throw new Error(`not found: ${from}`);
  return src.slice(at, src.indexOf(to, at + from.length));
};
const MEMBERS_ONLY = /\bu\.account_kind = 'member'/;
const sentSql = () => mockQuery.mock.calls.map(([sql]) => String(sql)).filter((sql) => /FROM users u/.test(sql));

describe('discovery lists ask for members only', () => {
  it('Everyone', async () => {
    await listEveryone(MEMBER, {});
    expect(sentSql()).toHaveLength(1);
    expect(sentSql()[0]).toMatch(MEMBERS_ONLY);
  });

  it('member search (GET /users/find)', async () => {
    await searchMembers(MEMBER, 'claus', 10);
    expect(sentSql()).toHaveLength(1);
    expect(sentSql()[0]).toMatch(MEMBERS_ONLY);
  });

  it('the old invite search (GET /users/connected)', async () => {
    await searchConnectedUsers(MEMBER, 'claus', 10);
    expect(sentSql()).toHaveLength(1);
    expect(sentSql()[0]).toMatch(MEMBERS_ONLY);
  });

  it.each([
    ['For You candidates', 'services/matching/platform-match.service.ts', 'async function loadCandidates(', '\n}\n'],
    ['"someone new matches" recipients', 'services/matching/platform-match.service.ts', 'const existing = await query<IntentProfile>(', '[newUserId],'],
    ['the candidates of a standing search', 'services/matching/agent-matching.service.ts', 'async function loadCandidatesFor(', '\n}\n'],
    ['invite candidates: your connections', 'services/invite/invite-candidates.service.ts', 'function connectionsSql(', '\n}\n'],
    ['invite candidates: the members of the event pod', 'services/invite/invite-candidates.service.ts', 'function podMembersSql(', '\n}\n'],
    ['invite everyone in the pod', 'services/invite/invite-candidates.service.ts', 'async function availablePodMembers(', '\n}\n'],
  ])('%s', (_name, file, from, to) => {
    expect(between(source(file), from, to)).toMatch(MEMBERS_ONLY);
  });

  it('a meeting request cannot be sent to a guest', () => {
    expect(between(source('services/poke/poke.service.ts'), 'const recipientExists', ');'))
      .toContain("AND account_kind = 'member'");
  });
});
