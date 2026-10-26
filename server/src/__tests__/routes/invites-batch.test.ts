// ─── Invite routes: candidates, batch and what had to keep working (26 Oct 2026) ───────────────────
//
// GET /invites/candidates and POST /invites/batch are the connections picker's two server calls. This reads the
// ROUTE contract through Express, with the services stood in: what is refused before a service is asked (the
// validation), who is let in, how fast, what the screens are told and when, and that production's own client,
// which still posts /invites, /invites/bulk and reads /users/connected, is served exactly as before.
// The service rules (who may invite, one invite per person) are in invite-candidates.test.ts.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

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
jest.mock('../../db', () => ({
  query: (...args: unknown[]) => mockDb(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
// The invite service is stood in, except for the small pure helpers the routes lean on (who is an admin, how an address
// is hidden, the one sentence for a person who cannot be invited): those are the real ones.
jest.mock('../../services/invite/invite.service', () => {
  const actual = jest.requireActual('../../services/invite/invite.service');
  return {
    ...(jest.createMockFromModule('../../services/invite/invite.service') as Record<string, unknown>),
    isAdminRole: actual.isAdminRole,
    maskEmail: actual.maskEmail,
    hideOthersAddresses: actual.hideOthersAddresses,
    CANNOT_BE_INVITED: actual.CANNOT_BE_INVITED,
    // A reminder is worded by the same two functions as the first invite (fix round 2): they are the real ones here, so
    // the tests read the email the member would get. They ask the stand-in database and the stand-in mail service.
    buildInviteContext: actual.buildInviteContext,
    emailInvite: actual.emailInvite,
  };
});
const mockSendInviteEmail = jest.fn();
jest.mock('../../services/email/email.service', () => ({
  sendInviteEmail: (...args: unknown[]) => mockSendInviteEmail(...args),
  __esModule: true,
}));

const mockCandidates = jest.fn();
const mockBatch = jest.fn();
const mockDeclined = jest.fn();
jest.mock('../../services/invite/invite-candidates.service', () => ({
  listInviteCandidates: (...args: unknown[]) => mockCandidates(...args),
  createInvitesBatch: (...args: unknown[]) => mockBatch(...args),
  declinedAddresses: (...args: unknown[]) => mockDeclined(...args),
  BATCH_MAX: 50,
  __esModule: true,
}));

const mockFanoutPod = jest.fn().mockResolvedValue(undefined);
const mockFanoutSession = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  fanoutPodEntities: (...args: unknown[]) => mockFanoutPod(...args),
  fanoutSessionEntities: (...args: unknown[]) => mockFanoutSession(...args),
  __esModule: true,
}));
const mockEmitEntities = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/emit', () => ({
  emitEntities: (...args: unknown[]) => mockEmitEntities(...args),
  getRealtimeIo: () => ({ fake: 'io' }),
  __esModule: true,
}));

import * as inviteService from '../../services/invite/invite.service';
import inviteRoutes from '../../routes/invites';
import { authenticate } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { inviteBatchLimiter, inviteReminderLimiter, peopleReadLimiter } from '../../middleware/rateLimit';
import { AppError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { InviteType, InviteStatus } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/invites', inviteRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub = 'u-organiser', role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const auth = (sub?: string, role?: string) => ({ Authorization: `Bearer ${token(sub, role)}` });

const POD = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const EVENT = '7a1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8';
const EVENT_POD = '8b2e3d4f-5061-4b72-9c83-a4b5c6d7e8f9';
const CIRCLE = '9c3f4e50-6172-4c83-8d94-b5c6d7e8f900';
const PERSON =(n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  mockDb.mockReset();
  // authenticate() checks the member is still active before any route runs.
  mockDb.mockResolvedValue({ rows: [{ status: 'active' }], rowCount: 1 });
  mockCandidates.mockReset();
  mockBatch.mockReset();
  mockDeclined.mockReset();
  // Nobody has declined, until a test says otherwise.
  mockDeclined.mockResolvedValue(new Set<string>());
  mockFanoutPod.mockClear();
  mockFanoutSession.mockClear();
  mockEmitEntities.mockClear();
  mockSendInviteEmail.mockReset();
  mockSendInviteEmail.mockResolvedValue(undefined);
  (inviteService.createInvite as jest.Mock).mockReset();
  (inviteService.assertMayInviteToSession as jest.Mock).mockReset();
  (inviteService.getInviteByCode as jest.Mock).mockReset();
  (inviteService.inviteeAddressFor as jest.Mock).mockReset();
  (inviteService.markInviteAccepted as jest.Mock).mockReset();
  // Who runs an event's or a pod's invites: an admin, and nobody else, until a test says otherwise.
  (inviteService.eventInviteRole as jest.Mock).mockReset();
  (inviteService.eventInviteRole as jest.Mock).mockImplementation(async (_sessionId: string, _userId: string, isAdmin: boolean) => (isAdmin ? 'admin' : null));
  (inviteService.mayRunPodInvites as jest.Mock).mockReset();
  (inviteService.mayRunPodInvites as jest.Mock).mockImplementation(async (_podId: string, _userId: string, isAdmin: boolean) => isAdmin);
  (inviteService.unreachableAddresses as jest.Mock).mockReset();
  (inviteService.unreachableAddresses as jest.Mock).mockResolvedValue(new Set<string>());
});

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
const stack = (inviteRoutes as unknown as { stack: Layer[] }).stack;
const handlersOf = (method: string, path: string) =>
  stack.filter((layer) => layer.route?.path === path && layer.route.methods[method]).flatMap((layer) => layer.route!.stack.map((s) => s.handle));
const registeredPaths = (method: string) => stack.flatMap((layer) => (layer.route && layer.route.methods[method] ? [layer.route.path] : []));

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// GET /invites/candidates
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /invites/candidates', () => {
  const page = {
    items: [{ userId: PERSON(1), displayName: 'Claus', avatarUrl: null, jobTitle: 'Founder', company: 'Harbor', how: 'met', since: '2026-10-20T10:00:00.000Z', state: 'available' }],
    nextBefore: '2026-10-20T10:00:00.000Z',
  };

  it('answers with the service\'s page under data, for the member who asks, 30 people from their connections unless asked otherwise', async () => {
    mockCandidates.mockResolvedValueOnce(page);
    const res = await request(app).get(`/invites/candidates?podId=${POD}`).set(auth('u-ann', 'member'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: page });
    expect(mockCandidates).toHaveBeenCalledWith(
      { userId: 'u-ann', role: 'member' },
      { podId: POD, sessionId: undefined, source: 'connections', q: undefined, before: null, limit: 30 },
    );
  });

  it('passes the event, the pod list, the search, the cursor and the page size on as asked', async () => {
    const before = '2026-10-01T09:30:00.000Z';
    mockCandidates.mockResolvedValueOnce(page);
    const res = await request(app).get(`/invites/candidates?sessionId=${EVENT}&source=pod&q=%20cla%20&before=${encodeURIComponent(before)}&limit=10`).set(auth());
    expect(res.status).toBe(200);
    expect(mockCandidates).toHaveBeenCalledWith(
      { userId: 'u-organiser', role: 'member' },
      { podId: undefined, sessionId: EVENT, source: 'pod', q: 'cla', before, limit: 10 },
    );
  });

  it('takes a cursor with an offset as well as one in UTC, and an upper-case id as the same id', async () => {
    mockCandidates.mockResolvedValueOnce(page);
    const res = await request(app).get(`/invites/candidates?podId=${POD.toUpperCase()}&before=${encodeURIComponent('2026-10-01T11:30:00.000+02:00')}`).set(auth());
    expect(res.status).toBe(200);
    expect(mockCandidates.mock.calls[0][1]).toMatchObject({ podId: POD, before: '2026-10-01T11:30:00.000+02:00' });
  });

  it('never gives more than 50 at a time: a bigger page is cut to 50', async () => {
    mockCandidates.mockResolvedValueOnce(page);
    await request(app).get(`/invites/candidates?podId=${POD}&limit=500`).set(auth());
    expect(mockCandidates.mock.calls[0][1]).toMatchObject({ limit: 50 });
  });

  it.each([
    ['no pod and no event', ''],
    ['both a pod and an event', `podId=${POD}&sessionId=${EVENT}`],
    ['an id that is not an id', 'podId=not-an-id'],
    ['the pod list for a pod', `podId=${POD}&source=pod`],
    ['a source nobody offers', `podId=${POD}&source=everyone`],
    ['a page of none', `podId=${POD}&limit=0`],
    ['a negative page', `podId=${POD}&limit=-3`],
    ['a page that is not a number', `podId=${POD}&limit=lots`],
    ['part of a person', `podId=${POD}&limit=2.5`],
    ['two page sizes', `podId=${POD}&limit=2&limit=3`],
    ['a cursor that is not a time', `podId=${POD}&before=yesterday`],
    ['a date with no time', `podId=${POD}&before=2026-10-01`],
    ['an empty cursor', `podId=${POD}&before=`],
    ['a search too long to be a search', `podId=${POD}&q=${'x'.repeat(101)}`],
    ['two searches', `podId=${POD}&q=a&q=b`],
  ])('refuses %s with a 400, before the service is asked', async (_what, qs) => {
    const res = await request(app).get(`/invites/candidates?${qs}`).set(auth());
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(mockCandidates).not.toHaveBeenCalled();
  });

  it('refuses a member who is not signed in', async () => {
    expect((await request(app).get(`/invites/candidates?podId=${POD}`)).status).toBe(401);
    expect(mockCandidates).not.toHaveBeenCalled();
  });

  it('passes a refusal on as it is: 403 for someone who may not invite here, with nothing else in the answer', async () => {
    mockCandidates.mockRejectedValueOnce(new ForbiddenError('Only pod directors and hosts can send pod invites'));
    const res = await request(app).get(`/invites/candidates?podId=${POD}`).set(auth());
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeUndefined();
    expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('a pod or an event that does not exist is a 404', async () => {
    mockCandidates.mockRejectedValueOnce(new NotFoundError('Pod', POD));
    expect((await request(app).get(`/invites/candidates?podId=${POD}`).set(auth())).status).toBe(404);
  });

  it('is a read: it tells no screens anything', async () => {
    mockCandidates.mockResolvedValueOnce(page);
    await request(app).get(`/invites/candidates?podId=${POD}`).set(auth());
    expect(mockFanoutPod).not.toHaveBeenCalled();
    expect(mockFanoutSession).not.toHaveBeenCalled();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('is registered before GET /:code, so "candidates" is never taken for an invite code', async () => {
    const paths = registeredPaths('get');
    expect(paths.indexOf('/candidates')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/candidates')).toBeLessThan(paths.indexOf('/:code'));
    mockCandidates.mockResolvedValueOnce(page);
    await request(app).get(`/invites/candidates?podId=${POD}`).set(auth());
    expect(mockCandidates).toHaveBeenCalledTimes(1);
    expect(inviteService.getInviteByCode).not.toHaveBeenCalled();
  });

  it('GET /invites/:code still answers for a real code', async () => {
    (inviteService.getInviteByCode as jest.Mock).mockResolvedValue({
      id: 'i1', code: 'ABC123XYZ', type: InviteType.POD, inviterId: 'u-x', inviteeEmail: null, podId: POD, sessionId: null, circleId: null,
      status: InviteStatus.PENDING, maxUses: 1, useCount: 0, expiresAt: null,
    });
    mockDb.mockImplementation(async (sql: string) =>
      /SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [{ displayName: 'Host', name: 'Pod', description: null }] });
    const res = await request(app).get('/invites/ABC123XYZ').set(auth());
    expect(res.status).toBe(200);
    expect(inviteService.getInviteByCode).toHaveBeenCalledWith('ABC123XYZ');
    expect(mockCandidates).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// POST /invites/batch
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /invites/batch', () => {
  const counts = (over: Record<string, number> = {}) =>
    ({ invited: 0, already_member: 0, already_going: 0, already_invited: 0, declined: 0, not_allowed: 0, failed: 0, ...over });
  const summary = (over: Record<string, unknown> = {}) => ({
    results: [{ userId: PERSON(1), outcome: 'invited', inviteId: 'inv-1' }],
    counts: counts({ invited: 1 }),
    target: { podId: POD, sessionId: null },
    delivery: Promise.resolve(),
    ...over,
  });
  // A batch is limited to 20 an hour per member, refused ones included, so each request here is a member of its own.
  let senders = 0;
  const send = (body: unknown, headers = auth(`u-sender-${(senders += 1)}`)) => request(app).post('/invites/batch').set(headers).send(body as object);

  it('answers with each person\'s outcome and the counts under data, and nothing else of the service\'s', async () => {
    mockBatch.mockResolvedValueOnce(summary());
    const res = await send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { results: [{ userId: PERSON(1), outcome: 'invited', inviteId: 'inv-1' }], counts: counts({ invited: 1 }) },
    });
  });

  it('answers without waiting for the emails (they go out after the answer), and sends none of the service\'s bookkeeping', async () => {
    mockBatch.mockResolvedValueOnce(summary({ delivery: new Promise<void>(() => { /* never settles */ }) }));
    const res = await send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)] });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['counts', 'results']);
  });

  it('tells the outcome of someone who declined, as the service says it', async () => {
    mockBatch.mockResolvedValueOnce(summary({
      results: [{ userId: PERSON(1), outcome: 'declined', inviteId: 'inv-old' }],
      counts: counts({ declined: 1 }),
    }));
    const res = await send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)] });
    expect(res.body.data.results).toEqual([{ userId: PERSON(1), outcome: 'declined', inviteId: 'inv-old' }]);
    expect(res.body.data.counts.declined).toBe(1);
    // Nobody was invited, so no screen is told anything.
    expect(mockFanoutPod).not.toHaveBeenCalled();
  });

  it('asks the service as the member who is signed in, with the ids in lower case', async () => {
    mockBatch.mockResolvedValueOnce(summary());
    await send({ type: 'pod', podId: POD.toUpperCase(), inviteeUserIds: [PERSON(1).toUpperCase(), PERSON(2)] }, auth('u-ann', 'member'));
    expect(mockBatch).toHaveBeenCalledWith(
      { userId: 'u-ann', role: 'member' },
      { type: 'pod', podId: POD, inviteeUserIds: [PERSON(1), PERSON(2)] },
    );
  });

  it('accepts an event, and "everyone in the pod" with nobody named', async () => {
    mockBatch.mockResolvedValueOnce(summary({ remaining: 7, target: { podId: EVENT_POD, sessionId: EVENT } }));
    const res = await send({ type: 'session', sessionId: EVENT, allPodMembers: true });
    expect(res.status).toBe(200);
    expect(mockBatch.mock.calls[0][1]).toEqual({ type: 'session', sessionId: EVENT, inviteeUserIds: [], allPodMembers: true });
    // How many more could still be invited is part of the answer only when the pod was asked for.
    expect(res.body.data.remaining).toBe(7);
  });

  it('accepts exactly 50 people', async () => {
    mockBatch.mockResolvedValueOnce(summary());
    const res = await send({ type: 'pod', podId: POD, inviteeUserIds: Array.from({ length: 50 }, (_, i) => PERSON(i + 1)) });
    expect(res.status).toBe(200);
  });

  it.each([
    ['nobody', { type: 'pod', podId: POD, inviteeUserIds: [] }],
    ['no list at all', { type: 'pod', podId: POD }],
    ['51 people', { type: 'pod', podId: POD, inviteeUserIds: Array.from({ length: 51 }, (_, i) => PERSON(i + 1)) }],
    ['an id that is not an id', { type: 'pod', podId: POD, inviteeUserIds: ['not-an-id'] }],
    ['an email where an id belongs', { type: 'pod', podId: POD, inviteeUserIds: ['guest@example.com'] }],
    ['a type nobody offers', { type: 'circle', podId: POD, inviteeUserIds: [PERSON(1)] }],
    ['no type', { podId: POD, inviteeUserIds: [PERSON(1)] }],
    ['a pod invite with no pod', { type: 'pod', inviteeUserIds: [PERSON(1)] }],
    ['an event invite with no event', { type: 'session', inviteeUserIds: [PERSON(1)] }],
    ['a pod id that is not an id', { type: 'pod', podId: 'x', inviteeUserIds: [PERSON(1)] }],
    ['"everyone in the pod" for a pod', { type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)], allPodMembers: true }],
    ['"everyone in the pod" that is not a yes or a no', { type: 'session', sessionId: EVENT, inviteeUserIds: [], allPodMembers: 'yes' }],
    ['ids that are not a list', { type: 'pod', podId: POD, inviteeUserIds: PERSON(1) }],
  ])('refuses %s with a 400 and a reason at the field, before the service is asked', async (_what, body) => {
    const res = await send(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockBatch).not.toHaveBeenCalled();
    expect(mockFanoutPod).not.toHaveBeenCalled();
    expect(mockFanoutSession).not.toHaveBeenCalled();
  });

  it('refuses a member who is not signed in', async () => {
    const res = await request(app).post('/invites/batch').send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)] });
    expect(res.status).toBe(401);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('passes a refusal on: 403 for someone who may not invite here, and no screen is told anything', async () => {
    mockBatch.mockRejectedValueOnce(new ForbiddenError('Only pod directors and hosts can send pod invites'));
    const res = await send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)] });
    expect(res.status).toBe(403);
    expect(mockFanoutPod).not.toHaveBeenCalled();
    expect(mockFanoutSession).not.toHaveBeenCalled();
  });

  it('says the daily limit in a sentence, with a 429', async () => {
    mockBatch.mockRejectedValueOnce(new AppError(429, 'INVITE_LIMIT_REACHED', 'You can send up to 100 invites per day. Try again tomorrow.'));
    const res = await send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)] });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toBe('You can send up to 100 invites per day. Try again tomorrow.');
  });

  // ── Real time: one fan-out for the whole batch ─────────────────────────────────────────────────
  describe('tells the screens that show the pod or the event, once for the whole batch', () => {
    it('a pod: fanoutPodEntities, once, however many were invited', async () => {
      mockBatch.mockResolvedValueOnce(summary({
        results: Array.from({ length: 12 }, (_, i) => ({ userId: PERSON(i + 1), outcome: 'invited', inviteId: `inv-${i}` })),
        counts: counts({ invited: 12 }),
      }));
      await send({ type: 'pod', podId: POD, inviteeUserIds: Array.from({ length: 12 }, (_, i) => PERSON(i + 1)) });
      expect(mockFanoutPod).toHaveBeenCalledTimes(1);
      expect(mockFanoutPod).toHaveBeenCalledWith(POD);
      expect(mockFanoutSession).not.toHaveBeenCalled();
    });

    it('an event: fanoutSessionEntities with its pod and the event\'s invites tag, once', async () => {
      mockBatch.mockResolvedValueOnce(summary({
        results: [{ userId: PERSON(1), outcome: 'invited', inviteId: 'a' }, { userId: PERSON(2), outcome: 'invited', inviteId: 'b' }],
        counts: counts({ invited: 2 }),
        target: { podId: EVENT_POD, sessionId: EVENT },
      }));
      await send({ type: 'session', sessionId: EVENT, inviteeUserIds: [PERSON(1), PERSON(2)] });
      expect(mockFanoutSession).toHaveBeenCalledTimes(1);
      expect(mockFanoutSession).toHaveBeenCalledWith(EVENT_POD, EVENT, [`session:${EVENT}:invites`]);
      expect(mockFanoutPod).not.toHaveBeenCalled();
    });

    it('nothing changed (everyone was already in, invited or not allowed): nobody is told anything', async () => {
      mockBatch.mockResolvedValueOnce(summary({
        results: [{ userId: PERSON(1), outcome: 'already_member' }, { userId: PERSON(2), outcome: 'not_allowed' }],
        counts: counts({ already_member: 1, not_allowed: 1 }),
      }));
      const res = await send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1), PERSON(2)] });
      expect(res.status).toBe(200);
      expect(mockFanoutPod).not.toHaveBeenCalled();
      expect(mockFanoutSession).not.toHaveBeenCalled();
    });

    it('a batch where only some were invited still tells them', async () => {
      mockBatch.mockResolvedValueOnce(summary({
        results: [{ userId: PERSON(1), outcome: 'invited', inviteId: 'a' }, { userId: PERSON(2), outcome: 'failed' }],
        counts: counts({ invited: 1, failed: 1 }),
      }));
      await send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1), PERSON(2)] });
      expect(mockFanoutPod).toHaveBeenCalledTimes(1);
    });

    it('a screen that cannot be reached does not fail the request', async () => {
      mockBatch.mockResolvedValueOnce(summary());
      mockFanoutPod.mockRejectedValueOnce(new Error('socket server is down'));
      expect((await send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)] })).status).toBe(200);
    });
  });

  // ── Speed ───────────────────────────────────────────────────────────────────────────────────────
  describe('is rate limited', () => {
    it.each([
      ['post', '/batch', inviteBatchLimiter],
      ['get', '/candidates', peopleReadLimiter],
    ])('%s %s carries its limiter, after authenticate and ahead of its handler', (method, path, limiter) => {
      const handlers = handlersOf(method, path);
      expect(handlers.length).toBeGreaterThan(2);
      const at = handlers.indexOf(limiter);
      const signedIn = handlers.indexOf(authenticate);
      expect(signedIn).toBeGreaterThanOrEqual(0);
      expect(at).toBeGreaterThan(signedIn);
      expect(at).toBeLessThan(handlers.length - 1);
    });

    it('refuses the 21st batch in an hour with a friendly 429, for that member only', async () => {
      mockBatch.mockResolvedValue(summary());
      const heavy = auth('u-heavy-sender');
      const body = { type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)] };
      for (let i = 0; i < 20; i += 1) expect((await send(body, heavy)).status).toBe(200);
      mockBatch.mockClear();
      const refused = await send(body, heavy);
      expect(refused.status).toBe(429);
      expect(refused.body.success).toBe(false);
      expect(refused.body.error.message).toMatch(/^[A-Z].*\.$/);
      expect(refused.body.error.message).not.toMatch(/RATE_LIMIT|exceeded/i);
      expect(mockBatch).not.toHaveBeenCalled();
      // Someone else is not held up.
      expect((await send(body, auth('u-other-sender'))).status).toBe(200);
    });

    it('the batch allowance is its own: reading candidates is not counted against it', async () => {
      mockCandidates.mockResolvedValue({ items: [], nextBefore: null });
      const reader = auth('u-heavy-reader');
      for (let i = 0; i < 25; i += 1) expect((await request(app).get(`/invites/candidates?podId=${POD}`).set(reader)).status).toBe(200);
      mockBatch.mockResolvedValue(summary());
      expect((await send({ type: 'pod', podId: POD, inviteeUserIds: [PERSON(1)] }, reader)).status).toBe(200);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// What production's own client still does
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('the calls production\'s client makes, unchanged', () => {
  it('POST /invites still creates one invite and tells the pod', async () => {
    (inviteService.createInvite as jest.Mock).mockResolvedValue({ id: 'i1', code: 'C', podId: POD, sessionId: null });
    const res = await request(app).post('/invites').set(auth()).send({ type: 'pod', podId: POD, maxUses: 1, inviteeUserId: PERSON(1), expiresInHours: 168 });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe('C');
    expect(inviteService.createInvite).toHaveBeenCalledWith('u-organiser', expect.objectContaining({ type: 'pod', podId: POD, inviteeUserId: PERSON(1) }), 'member');
    expect(mockFanoutPod).toHaveBeenCalledWith(POD);
  });

  it('POST /invites tells the person a pending invite already exists, as a 409 with the same code', async () => {
    (inviteService.createInvite as jest.Mock).mockRejectedValue(new AppError(409, 'DUPLICATE_INVITE', 'A pending invite already exists for this user'));
    const res = await request(app).post('/invites').set(auth()).send({ type: 'pod', podId: POD, inviteeUserId: PERSON(1) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_INVITE');
  });

  it('POST /invites refuses a closed account or a block (either way) with a 409 and one neutral sentence, and tells no screen', async () => {
    (inviteService.createInvite as jest.Mock).mockRejectedValue(new AppError(409, 'INVITE_NOT_PERMITTED', "This person can't be invited."));
    const res = await request(app).post('/invites').set(auth()).send({ type: 'pod', podId: POD, inviteeEmail: 'guest@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'INVITE_NOT_PERMITTED', message: "This person can't be invited." });
    expect(mockFanoutPod).not.toHaveBeenCalled();
    expect(mockFanoutSession).not.toHaveBeenCalled();
  });

  describe('POST /invites/bulk', () => {
    const emails = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com'];
    const bulk = () => request(app).post('/invites/bulk').set(auth()).send({ sessionId: EVENT, emails });

    it('sends the invites it can', async () => {
      (inviteService.createInvite as jest.Mock).mockResolvedValue({ id: 'i' });
      mockDb.mockImplementation(async (sql: string) =>
        /SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [{ pod_id: EVENT_POD }] });
      const res = await bulk();
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ sent: 5, skipped: 0, errors: 0 });
    });

    it('counts a person who already has a pending invite, is already going, or is already in the pod as skipped, not as an error', async () => {
      const refusal = (code: string) => new AppError(409, code as never, 'x');
      (inviteService.createInvite as jest.Mock)
        .mockRejectedValueOnce(refusal('DUPLICATE_INVITE'))
        .mockRejectedValueOnce(refusal('SESSION_ALREADY_REGISTERED'))
        .mockRejectedValueOnce(refusal('POD_MEMBER_EXISTS'))
        .mockResolvedValueOnce({ id: 'i' })
        .mockRejectedValueOnce(new AppError(403, 'AUTH_FORBIDDEN', 'no'));
      mockDb.mockImplementation(async (sql: string) =>
        /SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [{ pod_id: EVENT_POD }] });
      const res = await bulk();
      expect(res.body.data).toEqual({ sent: 1, skipped: 3, errors: 1 });
    });

    // Fix round 1 (ruling): a closed account or a block (either way) is never invited. The pod member list that feeds
    // "Invite All" does not filter blocks, so the invite itself refuses, and the bulk call skips them without a word
    // about why: a block is never revealed.
    it('counts a person who cannot be invited (closed, or blocked either way) as skipped, with nothing in the answer to say why', async () => {
      (inviteService.createInvite as jest.Mock)
        .mockRejectedValueOnce(new AppError(409, 'INVITE_NOT_PERMITTED', "This person can't be invited."))
        .mockRejectedValueOnce(new AppError(409, 'INVITE_NOT_PERMITTED', "This person can't be invited."))
        .mockResolvedValue({ id: 'i' });
      mockDb.mockImplementation(async (sql: string) =>
        /SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [{ pod_id: EVENT_POD }] });
      const res = await bulk();
      expect(res.body.data).toEqual({ sent: 3, skipped: 2, errors: 0 });
      expect(Object.keys(res.body.data).sort()).toEqual(['errors', 'sent', 'skipped']);
    });

    it('tells the event\'s screens once if anything went out', async () => {
      (inviteService.createInvite as jest.Mock).mockResolvedValue({ id: 'i' });
      mockDb.mockImplementation(async (sql: string) =>
        /SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [{ pod_id: EVENT_POD }] });
      await bulk();
      expect(mockFanoutSession).toHaveBeenCalledTimes(1);
      expect(mockFanoutSession).toHaveBeenCalledWith(EVENT_POD, EVENT, [`session:${EVENT}:invites`]);
    });

    // Fix round 2 (ruling): "Invite All" never asks again someone who said no to this event. Production's page reads
    // `Invited ${sent} pod members!${skipped ? ` ${skipped} already invited.` : ''}`, so a decliner is part of the
    // skipped count and nothing else in the answer changes. The single Invite per member is unchanged.
    describe('someone who declined this event is not invited again', () => {
      const quiet = () => mockDb.mockImplementation(async (sql: string) =>
        /SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [{ pod_id: EVENT_POD }] });

      it('is counted as skipped, no invite is made for them, and the others still go', async () => {
        mockDeclined.mockResolvedValue(new Set(['b@example.com', 'd@example.com']));
        (inviteService.createInvite as jest.Mock).mockResolvedValue({ id: 'i' });
        quiet();
        const res = await bulk();
        expect(res.body.data).toEqual({ sent: 3, skipped: 2, errors: 0 });
        const invited = (inviteService.createInvite as jest.Mock).mock.calls.map((call) => call[1].inviteeEmail);
        expect(invited).toEqual(['a@example.com', 'c@example.com', 'e@example.com']);
      });

      it('is asked once for the whole list, about this event, with the addresses as given', async () => {
        (inviteService.createInvite as jest.Mock).mockResolvedValue({ id: 'i' });
        quiet();
        await bulk();
        expect(mockDeclined).toHaveBeenCalledTimes(1);
        expect(mockDeclined).toHaveBeenCalledWith('session', EVENT, emails);
      });

      it('is matched whatever the case of the address in the list', async () => {
        mockDeclined.mockResolvedValue(new Set(['b@example.com']));
        (inviteService.createInvite as jest.Mock).mockResolvedValue({ id: 'i' });
        quiet();
        const res = await request(app).post('/invites/bulk').set(auth()).send({ sessionId: EVENT, emails: ['A@Example.com', 'B@Example.COM'] });
        expect(res.body.data).toEqual({ sent: 1, skipped: 1, errors: 0 });
      });

      it('everyone having declined is all skipped, nothing is sent and no screen is told', async () => {
        mockDeclined.mockResolvedValue(new Set(emails));
        quiet();
        const res = await bulk();
        expect(res.body.data).toEqual({ sent: 0, skipped: 5, errors: 0 });
        expect(inviteService.createInvite).not.toHaveBeenCalled();
        expect(mockFanoutSession).not.toHaveBeenCalled();
      });

      it('says nothing more than it did: the same three counts', async () => {
        mockDeclined.mockResolvedValue(new Set(['b@example.com']));
        (inviteService.createInvite as jest.Mock).mockResolvedValue({ id: 'i' });
        quiet();
        const res = await bulk();
        expect(Object.keys(res.body.data).sort()).toEqual(['errors', 'sent', 'skipped']);
      });

      it('a question that cannot be answered is an error for the whole call, with nobody invited on a guess', async () => {
        mockDeclined.mockRejectedValue(new Error('database hiccup'));
        quiet();
        const res = await bulk();
        expect(res.status).toBe(500);
        expect(inviteService.createInvite).not.toHaveBeenCalled();
      });

      // Without this, anyone could post an address and read from skipped-or-error whether that person had declined.
      it('is asked only for someone who may invite to this event: for anyone else the answer cannot tell who declined', async () => {
        (inviteService.assertMayInviteToSession as jest.Mock).mockRejectedValue(new AppError(403, 'AUTH_FORBIDDEN', 'Only the host can invite'));
        mockDeclined.mockResolvedValue(new Set(emails));
        (inviteService.createInvite as jest.Mock).mockRejectedValue(new AppError(403, 'AUTH_FORBIDDEN', 'Only the host can invite'));
        quiet();
        const res = await bulk();
        expect(mockDeclined).not.toHaveBeenCalled();
        // What they always got: every address refused by the invite itself, as an error.
        expect(res.body.data).toEqual({ sent: 0, skipped: 0, errors: 5 });
        expect(inviteService.assertMayInviteToSession).toHaveBeenCalledWith(EVENT, 'u-organiser', false);
      });
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Declined is not withdrawn, and co-hosts see the list they send to
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('declining and withdrawing tell the invite list of the event too', () => {
  it('a decline of an event invite tells the event\'s invites tag, so an organiser sees "declined" without a refresh', async () => {
    mockDb.mockImplementation(async (sql: string) =>
      /SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [{ email: 'guest@example.com' }] });
    (inviteService.declineInvite as jest.Mock).mockResolvedValue({ podId: null, sessionId: EVENT });
    const res = await request(app).post('/invites/CODE123/decline').set(auth('u-guest'));
    expect(res.status).toBe(200);
    expect(mockFanoutSession).toHaveBeenCalledWith(null, EVENT, [`session:${EVENT}:invites`]);
  });

  it('a decline of a pod invite tells the pod, whose fan-out already carries its invites tag', async () => {
    mockDb.mockImplementation(async (sql: string) =>
      /SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [{ email: 'guest@example.com' }] });
    (inviteService.declineInvite as jest.Mock).mockResolvedValue({ podId: POD, sessionId: null });
    await request(app).post('/invites/CODE123/decline').set(auth('u-guest'));
    expect(mockFanoutPod).toHaveBeenCalledWith(POD);
  });

  it('withdrawing an event invite tells the event\'s invites tag as well', async () => {
    (inviteService.revokeInvite as jest.Mock).mockResolvedValue({ podId: null, sessionId: EVENT });
    const res = await request(app).delete('/invites/11111111-1111-4111-8111-111111111111').set(auth());
    expect(res.status).toBe(200);
    expect(mockFanoutSession).toHaveBeenCalledWith(null, EVENT, [`session:${EVENT}:invites`]);
  });
});

describe('GET /invites/session/:sessionId: who may read the list of an event\'s invites', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'i1', code: 'c1', inviteeEmail: 'anna.smith@example.com', inviteeName: null, inviteeUserId: null, inviterId: 'u-host',
    status: 'pending', createdAt: '2026-10-21T08:00:00.000Z', declinedAt: null, maxUses: 1, useCount: 0, expiresAt: null, ...over,
  });
  const listAs = (sub: string, role: string, relation: 'host' | 'cohost' | null, rows: unknown[] = [row({})], eventExists = true) => {
    mockDb.mockImplementation(async (sql: string) => {
      if (/SELECT status FROM users/.test(sql)) return { rows: [{ status: 'active' }] };
      if (/SELECT host_user_id FROM sessions/.test(sql)) return { rows: eventExists ? [{ host_user_id: 'u-host' }] : [] };
      return { rows: [] };
    });
    (inviteService.eventInviteRole as jest.Mock).mockImplementation(async (_s: string, _u: string, isAdmin: boolean) => (isAdmin ? 'admin' : relation));
    (inviteService.listSessionInvites as jest.Mock).mockResolvedValue(rows);
    return request(app).get(`/invites/session/${EVENT}?status=pending`).set(auth(sub, role));
  };

  it('the host reads it, with every address', async () => {
    const res = await listAs('u-host', 'member', 'host', [row({ inviterId: 'u-cohost' }), row({ id: 'i2', inviteeEmail: 'bob@example.com' })]);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { inviteeEmail: string }) => r.inviteeEmail)).toEqual(['anna.smith@example.com', 'bob@example.com']);
    expect(inviteService.listSessionInvites).toHaveBeenCalledWith(EVENT, 'pending');
  });

  it('an admin reads it, with every address', async () => {
    const res = await listAs('u-admin', 'admin', null, [row({ inviterId: 'u-cohost' })]);
    expect(res.status).toBe(200);
    expect(res.body.data[0].inviteeEmail).toBe('anna.smith@example.com');
  });

  // Fix round 1 (ruling): the platform's member lists carry no emails; a co-host sees an address only on the invites
  // they sent themselves.
  it('a co-host reads it, with their own invites\' addresses and a label in place of everyone else\'s', async () => {
    const res = await listAs('u-cohost', 'member', 'cohost', [
      row({ id: 'mine', inviterId: 'u-cohost', inviteeEmail: 'mine@example.com' }),
      row({ id: 'members', inviteeEmail: 'anna.smith@example.com', inviteeName: 'Anna Smith', inviteeUserId: PERSON(1) }),
      row({ id: 'guest', inviteeEmail: 'bob@mail.example.org' }),
      row({ id: 'link', inviteeEmail: null, code: 'OPENLINK' }),
    ]);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.map((r: { id: string }) => [r.id, r]));
    expect(byId.mine.inviteeEmail).toBe('mine@example.com');
    expect(byId.members.inviteeEmail).toBe('Anna Smith');
    expect(byId.guest.inviteeEmail).toBe('b•••@mail.example.org');
    // An open link is still told apart from a personal invite by having no address (the live-event Invite modal reuses it).
    expect(byId.link.inviteeEmail).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/anna\.smith@|bob@/);
  });

  // Fix round 2: a code opens the invite whole (GET /invites/:code), so the rows whose address is hidden carry none.
  // Production's pages act on `id` and read `code` only from an open link (HostControls).
  it('a co-host is given no code on the invites whose address is hidden, so no address can be got back with one: only their own invites and the open links keep theirs', async () => {
    const res = await listAs('u-cohost', 'member', 'cohost', [
      row({ id: 'mine', inviterId: 'u-cohost', inviteeEmail: 'mine@example.com', code: 'MINE-CODE' }),
      row({ id: 'members', code: 'SECRET-MEMBER-CODE', inviteeEmail: 'anna.smith@example.com', inviteeName: 'Anna Smith', inviteeUserId: PERSON(1) }),
      row({ id: 'guest', code: 'SECRET-GUEST-CODE', inviteeEmail: 'bob@mail.example.org' }),
      row({ id: 'link', inviteeEmail: null, code: 'OPENLINK' }),
    ]);
    const byId = Object.fromEntries(res.body.data.map((r: { id: string }) => [r.id, r]));
    expect(byId.mine.code).toBe('MINE-CODE');
    expect(byId.link.code).toBe('OPENLINK');
    expect(byId.members.code).toBe('');
    expect(byId.guest.code).toBe('');
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET/);
    // The page still has what it acts on.
    expect(byId.guest.id).toBe('guest');
  });

  it('the host and an admin are given every code, as they always were: they run the invites', async () => {
    const rows = [row({ id: 'a', code: 'CODE-A', inviterId: 'u-cohost' }), row({ id: 'b', code: 'CODE-B', inviteeEmail: 'bob@example.com' })];
    const asHost = await listAs('u-host', 'member', 'host', rows);
    expect(asHost.body.data.map((r: { code: string }) => r.code)).toEqual(['CODE-A', 'CODE-B']);
    const asAdmin = await listAs('u-admin', 'admin', null, rows);
    expect(asAdmin.body.data.map((r: { code: string }) => r.code)).toEqual(['CODE-A', 'CODE-B']);
  });

  it('a co-host\'s answer still carries what the new screens need: who answered, who the member is, who sent it', async () => {
    const res = await listAs('u-cohost', 'member', 'cohost', [
      row({ inviterId: 'u-host', status: 'revoked', declinedAt: '2026-10-21T09:00:00.000Z', inviteeUserId: PERSON(1), inviteeName: 'Anna Smith' }),
    ]);
    expect(res.body.data[0]).toMatchObject({ declinedAt: '2026-10-21T09:00:00.000Z', inviteeUserId: PERSON(1), inviterId: 'u-host', inviteeName: 'Anna Smith' });
  });

  it('anyone else is refused, in the words an event\'s organiser reads, and nothing is listed', async () => {
    const res = await listAs('u-stranger', 'member', null);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the host or a co-host can view this event\'s invites');
    expect(inviteService.listSessionInvites).not.toHaveBeenCalled();
  });

  it('an event that does not exist is a 404 that says event', async () => {
    const res = await listAs('u-host', 'member', 'host', [], false);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Event not found');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Fix round 1: whoever runs an event's invites can remind and withdraw any of them
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('POST /invites/:id/remind', () => {
  const INVITE = '11111111-1111-4111-8111-111111111111';
  const inviteRow = (over: Record<string, unknown> = {}) => ({
    id: INVITE, invitee_email: 'guest@example.com', session_id: EVENT, pod_id: null, circle_id: null, type: 'session', inviter_id: 'u-host',
    status: 'pending', code: 'CODE1', expires_at: null, ...over,
  });
  const given = (row: Record<string, unknown> | null) => {
    mockDb.mockImplementation(async (sql: string) => {
      if (/SELECT status FROM users/.test(sql)) return { rows: [{ status: 'active' }] };
      if (/FROM invites WHERE id = \$1/.test(sql)) return { rows: row ? [row] : [] };
      if (/display_name AS "displayName"/.test(sql)) return { rows: [{ displayName: 'Organiser' }] };
      if (/SELECT title, scheduled_at, host_user_id, config, event_format FROM sessions/.test(sql)) {
        return { rows: [{ title: 'Kickoff', scheduled_at: null, host_user_id: 'u-host', config: {}, event_format: 'video_meeting' }] };
      }
      if (/SELECT name FROM pods WHERE id = \$1/.test(sql)) return { rows: [{ name: 'Reason circle' }] };
      if (/SELECT name FROM circles WHERE id = \$1/.test(sql)) return { rows: [{ name: 'Book club' }] };
      return { rows: [] };
    });
  };
  const eventRole = (role: 'host' | 'cohost' | null) =>
    (inviteService.eventInviteRole as jest.Mock).mockImplementation(async (_s: string, _u: string, isAdmin: boolean) => (isAdmin ? 'admin' : role));
  const remind = (sub = 'u-organiser', role = 'member') => request(app).post(`/invites/${INVITE}/remind`).set(auth(sub, role));

  it.each([['the host', 'host'], ['a co-host', 'cohost']] as const)('%s reminds an invite to their event, whoever sent it', async (_who, relation) => {
    given(inviteRow());
    eventRole(relation);
    const res = await remind('u-someone');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ reminded: true });
    expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
    expect(mockSendInviteEmail.mock.calls[0][0]).toBe('guest@example.com');
  });

  it('an admin reminds any event\'s', async () => {
    given(inviteRow());
    const res = await remind('u-admin', 'admin');
    expect(res.status).toBe(200);
    expect(inviteService.eventInviteRole).toHaveBeenCalledWith(EVENT, 'u-admin', true);
  });

  it('the role is asked about the event the INVITE belongs to: a co-host of another event, or an ordinary member, is refused and nothing is sent', async () => {
    given(inviteRow());
    eventRole(null);
    const res = await remind('u-cohost-of-another-event');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the host or a co-host can send reminders');
    expect(inviteService.eventInviteRole).toHaveBeenCalledWith(EVENT, 'u-cohost-of-another-event', false);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('is refused for someone who may not, before it says anything about the invite (not whether it is still pending)', async () => {
    given(inviteRow({ status: 'accepted' }));
    eventRole(null);
    expect((await remind('u-ordinary')).status).toBe(403);
  });

  it('an invite that is no longer pending is a 400', async () => {
    given(inviteRow({ status: 'revoked' }));
    eventRole('host');
    const res = await remind('u-host');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVITE_NOT_PENDING');
  });

  it('an invite whose expiry has passed is not reminded: the link in the email would be dead', async () => {
    given(inviteRow({ expires_at: new Date(Date.now() - 60_000).toISOString() }));
    eventRole('host');
    const res = await remind('u-host');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INVITE_EXPIRED', message: 'This invite has expired' });
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('an invite that still has time is reminded', async () => {
    given(inviteRow({ expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
    eventRole('host');
    expect((await remind('u-host')).status).toBe(200);
  });

  it('a person who cannot be invited (closed, or blocked either way) is not emailed: 409 and the one neutral sentence', async () => {
    given(inviteRow());
    eventRole('host');
    (inviteService.unreachableAddresses as jest.Mock).mockResolvedValue(new Set(['guest@example.com']));
    const res = await remind('u-host');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'INVITE_NOT_PERMITTED', message: "This person can't be invited." });
    expect(inviteService.unreachableAddresses).toHaveBeenCalledWith('u-host', ['guest@example.com']);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('an invite that does not exist is a 404', async () => {
    given(null);
    expect((await remind('u-host')).status).toBe(404);
  });

  describe('a pod\'s invite', () => {
    it.each([['a director or host', true, 200], ['an ordinary member', false, 403]] as const)('%s: %i', async (_who, mayRun, status) => {
      given(inviteRow({ session_id: null, pod_id: POD, type: 'pod' }));
      (inviteService.mayRunPodInvites as jest.Mock).mockResolvedValue(mayRun);
      const res = await remind('u-someone');
      expect(res.status).toBe(status);
      expect(inviteService.mayRunPodInvites).toHaveBeenCalledWith(POD, 'u-someone', false);
      if (status === 403) expect(res.body.error.message).toBe('Only pod directors can send reminders');
    });
  });

  // Fix round 2: every reminder used to be sent as an event invite ("has invited you to join an event"), with no name
  // at all for a pod, a circle or the platform. It is now worded like the first invite: the same two functions build it.
  // The calls are production's: the pod page's Remind and Remind All (one request per pending invite) and the event page's Remind.
  describe('says what the invite was for', () => {
    const sentEmail = () => {
      expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
      return mockSendInviteEmail.mock.calls[0][1];
    };

    it('a pod invite is a pod invite, with the pod\'s name, and the link of that invite', async () => {
      given(inviteRow({ session_id: null, pod_id: POD, type: 'pod', code: 'POD-CODE' }));
      (inviteService.mayRunPodInvites as jest.Mock).mockResolvedValue(true);
      const res = await remind('u-director');
      expect(res.status).toBe(200);
      expect(sentEmail()).toMatchObject({ type: 'pod', targetName: 'Reason circle', inviterName: 'Organiser', inviteUrl: 'http://localhost:5173/invite/POD-CODE' });
      expect(sentEmail().calendarEvent).toBeUndefined();
      expect(mockSendInviteEmail.mock.calls[0][0]).toBe('guest@example.com');
    });

    it('an event invite is still an event invite, with the event\'s title', async () => {
      given(inviteRow());
      eventRole('host');
      await remind('u-host');
      expect(sentEmail()).toMatchObject({ type: 'session', targetName: 'Kickoff' });
    });

    it('a circle invite names the circle, and a platform invite is an invitation to REASON with no name', async () => {
      given(inviteRow({ session_id: null, pod_id: null, circle_id: CIRCLE, type: 'circle', inviter_id: 'u-sender' }));
      await remind('u-sender');
      expect(sentEmail()).toMatchObject({ type: 'circle', targetName: 'Book club' });
      mockSendInviteEmail.mockClear();
      given(inviteRow({ session_id: null, pod_id: null, type: 'platform', inviter_id: 'u-sender' }));
      await remind('u-sender');
      expect(sentEmail()).toMatchObject({ type: 'platform' });
      expect(sentEmail().targetName).toBeUndefined();
    });
  });

  // Fix round 2: the rule for a platform or circle invite (nobody runs them; the sender or an admin reminds) had no test.
  describe('a platform or circle invite is reminded by the person who sent it or by an admin', () => {
    const platform = (over: Record<string, unknown> = {}) => inviteRow({ session_id: null, pod_id: null, type: 'platform', inviter_id: 'u-sender', ...over });

    it('the sender reminds their own', async () => {
      given(platform());
      const res = await remind('u-sender');
      expect(res.status).toBe(200);
      expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
    });

    it('an admin reminds anyone\'s', async () => {
      given(platform());
      expect((await remind('u-admin', 'admin')).status).toBe(200);
    });

    it('anyone else is refused in the sentence for it, and nothing is sent, even for a member of the circle', async () => {
      given(platform({ type: 'circle', circle_id: CIRCLE }));
      const res = await remind('u-other-member');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'AUTH_FORBIDDEN', message: 'Only the person who sent an invite can send reminders for it' });
      expect(mockSendInviteEmail).not.toHaveBeenCalled();
      // Nobody runs this invite, so neither the event's nor the pod's roles are asked.
      expect(inviteService.eventInviteRole).not.toHaveBeenCalled();
      expect(inviteService.mayRunPodInvites).not.toHaveBeenCalled();
    });
  });
});

describe('POST /invites/remind-all/:sessionId', () => {
  const pending = [
    { id: 'a', invitee_email: 'a@example.com', code: 'CA' },
    { id: 'b', invitee_email: 'b@example.com', code: 'CB' },
    { id: 'c', invitee_email: 'c@example.com', code: 'CC' },
  ];
  let pendingSql = '';
  const given = (opts: { eventExists?: boolean; rows?: typeof pending } = {}) => {
    pendingSql = '';
    mockDb.mockImplementation(async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/SELECT status FROM users/.test(text)) return { rows: [{ status: 'active' }] };
      if (/FROM sessions WHERE id = \$1/.test(text) && /host_user_id, title/.test(text)) {
        return { rows: opts.eventExists === false ? [] : [{ host_user_id: 'u-host', title: 'Kickoff', scheduled_at: null, config: {}, event_format: 'video_meeting' }] };
      }
      if (/FROM invites WHERE session_id = \$1/.test(text)) { pendingSql = text; return { rows: opts.rows ?? pending }; }
      if (/display_name AS "displayName"/.test(text)) return { rows: [{ displayName: 'Organiser' }] };
      return { rows: [] };
    });
  };
  const eventRole = (role: 'host' | 'cohost' | null) =>
    (inviteService.eventInviteRole as jest.Mock).mockImplementation(async (_s: string, _u: string, isAdmin: boolean) => (isAdmin ? 'admin' : role));
  const remindAll = (sub = 'u-organiser', role = 'member') => request(app).post(`/invites/remind-all/${EVENT}`).set(auth(sub, role));

  it.each([['the host', 'host'], ['a co-host', 'cohost']] as const)('%s reminds everyone with a live pending invite', async (_who, relation) => {
    given();
    eventRole(relation);
    const res = await remindAll('u-someone');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ reminded: 3, total: 3 });
    expect(mockSendInviteEmail).toHaveBeenCalledTimes(3);
  });

  it('an admin may', async () => {
    given();
    expect((await remindAll('u-admin', 'admin')).status).toBe(200);
    expect(inviteService.eventInviteRole).toHaveBeenCalledWith(EVENT, 'u-admin', true);
  });

  it('an ordinary member, or a co-host of another event, may not, and nothing is sent', async () => {
    given();
    eventRole(null);
    const res = await remindAll('u-cohost-of-another-event');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Only the host or a co-host can send reminders');
    expect(inviteService.eventInviteRole).toHaveBeenCalledWith(EVENT, 'u-cohost-of-another-event', false);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('leaves out the invites whose expiry has passed, in the query itself', async () => {
    given();
    eventRole('host');
    await remindAll('u-host');
    expect(pendingSql).toContain("status = 'pending'");
    expect(pendingSql).toContain('(expires_at IS NULL OR expires_at > NOW())');
  });

  it('leaves out, without a word, anyone who cannot be invited (closed, or blocked either way): they are not emailed and not counted', async () => {
    given();
    eventRole('host');
    (inviteService.unreachableAddresses as jest.Mock).mockResolvedValue(new Set(['b@example.com']));
    const res = await remindAll('u-host');
    expect(res.body.data).toEqual({ reminded: 2, total: 2 });
    expect(mockSendInviteEmail.mock.calls.map((call) => call[0]).sort()).toEqual(['a@example.com', 'c@example.com']);
    expect(inviteService.unreachableAddresses).toHaveBeenCalledWith('u-host', ['a@example.com', 'b@example.com', 'c@example.com']);
  });

  // Fix round 2: production's event page reads `{ reminded, total }` and toasts "Reminders sent to ${reminded}/${total}
  // pending invites"; with no total it said "0/undefined". Both are always there.
  it('nobody to remind is 0 of 0, and not an error: the answer always has both numbers production\'s toast reads', async () => {
    given({ rows: [] });
    eventRole('host');
    const res = await remindAll('u-host');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ reminded: 0, total: 0 });
  });

  it('everyone left out because they cannot be invited is 0 of 0 too, with the same two numbers', async () => {
    given();
    eventRole('host');
    (inviteService.unreachableAddresses as jest.Mock).mockResolvedValue(new Set(['a@example.com', 'b@example.com', 'c@example.com']));
    const res = await remindAll('u-host');
    expect(res.body.data).toEqual({ reminded: 0, total: 0 });
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it('an event that does not exist is a 404 that says event', async () => {
    given({ eventExists: false });
    eventRole('host');
    const res = await remindAll('u-host');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Event not found');
  });
});

describe('DELETE /invites/:id: whoever runs the event or the pod withdraws any of its invites', () => {
  const INVITE = '11111111-1111-4111-8111-111111111111';

  it('asks the service as the member who is signed in, with their role, and tells the event\'s invites tag', async () => {
    (inviteService.revokeInvite as jest.Mock).mockResolvedValue({ podId: null, sessionId: EVENT });
    const res = await request(app).delete(`/invites/${INVITE}`).set(auth('u-host', 'member'));
    expect(res.status).toBe(200);
    expect(inviteService.revokeInvite).toHaveBeenCalledWith(INVITE, 'u-host', 'member');
    expect(mockFanoutSession).toHaveBeenCalledWith(null, EVENT, [`session:${EVENT}:invites`]);
  });

  it('passes an admin\'s role on', async () => {
    (inviteService.revokeInvite as jest.Mock).mockResolvedValue({ podId: POD, sessionId: null });
    await request(app).delete(`/invites/${INVITE}`).set(auth('u-admin', 'admin'));
    expect(inviteService.revokeInvite).toHaveBeenCalledWith(INVITE, 'u-admin', 'admin');
    expect(mockFanoutPod).toHaveBeenCalledWith(POD);
  });

  it('for someone who may not, the service says not found and that is the answer: nothing is told to any screen', async () => {
    (inviteService.revokeInvite as jest.Mock).mockRejectedValue(new NotFoundError('Invite', INVITE));
    const res = await request(app).delete(`/invites/${INVITE}`).set(auth('u-ordinary'));
    expect(res.status).toBe(404);
    expect(mockFanoutPod).not.toHaveBeenCalled();
    expect(mockFanoutSession).not.toHaveBeenCalled();
  });

  // Fix round 2: an admin withdraws a platform or circle invite too, as they remind it. Nothing to tell any screen.
  it('a platform or circle invite has no pod or event behind it, so withdrawing it tells no screen', async () => {
    (inviteService.revokeInvite as jest.Mock).mockResolvedValue({ podId: null, sessionId: null });
    const res = await request(app).delete(`/invites/${INVITE}`).set(auth('u-admin', 'admin'));
    expect(res.status).toBe(200);
    expect(inviteService.revokeInvite).toHaveBeenCalledWith(INVITE, 'u-admin', 'admin');
    expect(mockFanoutPod).not.toHaveBeenCalled();
    expect(mockFanoutSession).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Fix round 2: the address on an invite found by its code, and mark-accepted
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /invites/:code: the address on the invite', () => {
  const invite = {
    id: 'i1', code: 'CODE', type: 'session', inviterId: 'u-cohost', inviteeEmail: 'anna.smith@example.com', podId: null, sessionId: EVENT,
    circleId: null, status: 'pending', maxUses: 1, useCount: 0, expiresAt: null, acceptedByUserId: null,
  };
  const given = (over: Record<string, unknown> = {}) => {
    mockDb.mockImplementation(async (sql: string) => {
      if (/SELECT status FROM users/.test(sql)) return { rows: [{ status: 'active' }] };
      if (/display_name AS "displayName"/.test(sql)) return { rows: [{ displayName: 'Casey Cohost' }] };
      if (/FROM sessions WHERE id = \$1/.test(sql)) return { rows: [{ title: 'Kickoff', scheduledAt: '2026-11-01T12:00:00.000Z', description: 'About it', status: 'scheduled' }] };
      return { rows: [] };
    });
    (inviteService.getInviteByCode as jest.Mock).mockResolvedValue({ ...invite, ...over });
  };
  const addressFor = inviteService.inviteeAddressFor as jest.Mock;

  it('a signed-in caller is shown the address the service says they may read: masked for someone who has no business with it', async () => {
    given();
    addressFor.mockResolvedValue('a•••@example.com');
    const res = await request(app).get('/invites/CODE').set(auth('u-stranger'));
    expect(res.status).toBe(200);
    expect(res.body.data.inviteeEmail).toBe('a•••@example.com');
    expect(JSON.stringify(res.body)).not.toContain('anna.smith@example.com');
  });

  it('...whole for the invitee, the one who sent it, an organiser or an admin (the service says so)', async () => {
    given();
    addressFor.mockResolvedValue('anna.smith@example.com');
    const res = await request(app).get('/invites/CODE').set(auth('u-anna'));
    expect(res.body.data.inviteeEmail).toBe('anna.smith@example.com');
  });

  it('asks as the member who is signed in: their id, the address of their account and their role', async () => {
    given();
    addressFor.mockResolvedValue('a•••@example.com');
    await request(app).get('/invites/CODE').set(auth('u-someone', 'admin'));
    expect(addressFor).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CODE', inviteeEmail: 'anna.smith@example.com', inviterId: 'u-cohost' }),
      { userId: 'u-someone', email: 'u-someone@example.com', role: 'admin' },
    );
  });

  it('an open link still has no address', async () => {
    given({ inviteeEmail: null });
    addressFor.mockResolvedValue(null);
    const res = await request(app).get('/invites/CODE').set(auth('u-any'));
    expect(res.body.data.inviteeEmail).toBeNull();
  });

  it('everything else is as it was: the invite, and the context production\'s accept page shows (who invited you, and to what)', async () => {
    given();
    addressFor.mockResolvedValue('a•••@example.com');
    const res = await request(app).get('/invites/CODE').set(auth('u-stranger'));
    expect(res.body.data).toMatchObject({
      id: 'i1', code: 'CODE', type: 'session', status: 'pending', sessionId: EVENT, inviterId: 'u-cohost',
      inviterName: 'Casey Cohost', sessionTitle: 'Kickoff', sessionDescription: 'About it', sessionStatus: 'scheduled',
    });
  });

  it('someone who is not signed in gets the limited answer, which never had an address, and the service is not even asked', async () => {
    given();
    const res = await request(app).get('/invites/CODE');
    expect(res.status).toBe(200);
    expect(addressFor).not.toHaveBeenCalled();
    expect('inviteeEmail' in res.body.data).toBe(false);
    expect(res.body.data).toMatchObject({ code: 'CODE', type: 'session', sessionId: EVENT, sessionTitle: 'Kickoff' });
    expect(JSON.stringify(res.body)).not.toContain('anna.smith');
  });

  it('an unknown code is a 404', async () => {
    (inviteService.getInviteByCode as jest.Mock).mockRejectedValue(new NotFoundError('Invite'));
    expect((await request(app).get('/invites/NOPE').set(auth())).status).toBe(404);
  });
});

describe('POST /invites/:code/mark-accepted', () => {
  const mark = inviteService.markInviteAccepted as jest.Mock;
  const quiet = () => mockDb.mockImplementation(async (sql: string) => (/SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [] }));

  it('needs someone signed in, and asks the service nothing otherwise', async () => {
    const res = await request(app).post('/invites/CODE/mark-accepted');
    expect(res.status).toBe(401);
    expect(mark).not.toHaveBeenCalled();
  });

  it('asks the service as the member who is signed in: their id and the address of their account', async () => {
    quiet();
    mark.mockResolvedValue({ podId: null, sessionId: null });
    const res = await request(app).post('/invites/CODE/mark-accepted').set(auth('u-guest'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { marked: true } });
    expect(mark).toHaveBeenCalledWith('CODE', 'u-guest', 'u-guest@example.com');
  });

  it('tells the member\'s own invites, and the lists of the pod or event the invite was for, as an accept does', async () => {
    quiet();
    mark.mockResolvedValue({ podId: POD, sessionId: EVENT });
    await request(app).post('/invites/CODE/mark-accepted').set(auth('u-guest'));
    expect(mockFanoutPod).toHaveBeenCalledWith(POD, ['user:u-guest:pods']);
    expect(mockFanoutSession).toHaveBeenCalledWith(POD, EVENT, ['user:u-guest:sessions']);
    expect(mockEmitEntities).toHaveBeenCalledWith({ fake: 'io' }, ['u-guest'], ['user:u-guest:invites']);
  });

  it.each([
    ['a withdrawn or declined invite', new AppError(400, 'INVITE_REVOKED', 'This invite has been revoked'), 400, 'INVITE_REVOKED'],
    ['an expired one', new AppError(400, 'INVITE_EXPIRED', 'This invite has expired'), 400, 'INVITE_EXPIRED'],
    ['one used up by someone else', new AppError(400, 'INVITE_ALREADY_USED', 'This invite has reached its maximum uses'), 400, 'INVITE_ALREADY_USED'],
    ['one sent to another address', new AppError(403, 'IDENTITY_MISMATCH', 'This invite was sent to g•••@example.com, but you\'re logged in as x@example.com. Sign in to the right account to accept.'), 403, 'IDENTITY_MISMATCH'],
    ['one that does not exist', new NotFoundError('Invite'), 404, 'INVITE_NOT_FOUND'],
  ])('%s is refused with what the service says, and no screen is told', async (_what, refusal, status, code) => {
    quiet();
    mark.mockRejectedValue(refusal);
    const res = await request(app).post('/invites/CODE/mark-accepted').set(auth('u-stranger'));
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(mockFanoutPod).not.toHaveBeenCalled();
    expect(mockFanoutSession).not.toHaveBeenCalled();
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('the refusal for another address names the invited one masked, never whole', async () => {
    quiet();
    mark.mockRejectedValue(new AppError(403, 'IDENTITY_MISMATCH', 'This invite was sent to g•••@example.com, but you\'re logged in as x@example.com. Sign in to the right account to accept.'));
    const res = await request(app).post('/invites/CODE/mark-accepted').set(auth('u-stranger'));
    expect(res.body.error.message).toContain('g•••@example.com');
    expect(res.body.error.message).not.toContain('guest@example.com');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Fix round 2: reminders are rate limited
// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('reminders are rate limited', () => {
  const INVITE = '11111111-1111-4111-8111-111111111111';
  const world = () => {
    mockDb.mockImplementation(async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (/SELECT status FROM users/.test(text)) return { rows: [{ status: 'active' }] };
      if (/FROM invites WHERE id = \$1/.test(text)) {
        return { rows: [{ id: INVITE, invitee_email: 'guest@example.com', session_id: EVENT, pod_id: null, circle_id: null, type: 'session', inviter_id: 'u-host', status: 'pending', code: 'CODE1', expires_at: null }] };
      }
      if (/^SELECT host_user_id, title/.test(text)) return { rows: [{ host_user_id: 'u-host', title: 'Kickoff', scheduled_at: null, config: {}, event_format: 'video_meeting' }] };
      if (/^SELECT title, scheduled_at, host_user_id/.test(text)) return { rows: [{ title: 'Kickoff', scheduled_at: null, host_user_id: 'u-host', config: {}, event_format: 'video_meeting' }] };
      if (/FROM invites WHERE session_id = \$1/.test(text)) {
        return { rows: [{ id: 'a', invitee_email: 'a@example.com', code: 'CA' }, { id: 'b', invitee_email: 'b@example.com', code: 'CB' }, { id: 'c', invitee_email: 'c@example.com', code: 'CC' }] };
      }
      if (/display_name AS "displayName"/.test(text)) return { rows: [{ displayName: 'Organiser' }] };
      return { rows: [] };
    });
    (inviteService.eventInviteRole as jest.Mock).mockResolvedValue('host');
  };
  const remindOne = (who: string) => request(app).post(`/invites/${INVITE}/remind`).set(auth(who));
  const remindAll = (who: string) => request(app).post(`/invites/remind-all/${EVENT}`).set(auth(who));

  it.each([
    ['post', '/:id/remind'],
    ['post', '/remind-all/:sessionId'],
  ])('%s %s carries the reminder limiter, after authenticate and ahead of its handler', (method, path) => {
    const handlers = handlersOf(method, path);
    const at = handlers.indexOf(inviteReminderLimiter);
    const signedIn = handlers.indexOf(authenticate);
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(signedIn);
    expect(at).toBeLessThan(handlers.length - 1);
  });

  // Production's pod page sends one request per pending invite for its Remind All, and says "Sent 20 reminders, 5
  // failed" when some are refused. So the allowance is roomy: 60 an hour.
  it('refuses the 61st reminder in an hour with a friendly 429, for that member only, and sends nothing', async () => {
    world();
    const heavy = 'u-heavy-reminder';
    for (let i = 0; i < 60; i += 1) expect((await remindOne(heavy)).status).toBe(200);
    mockSendInviteEmail.mockClear();
    const refused = await remindOne(heavy);
    expect(refused.status).toBe(429);
    expect(refused.body.success).toBe(false);
    expect(refused.body.error.message).toMatch(/^[A-Z].*\.$/);
    expect(refused.body.error.message).not.toMatch(/RATE_LIMIT|exceeded/i);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
    expect((await remindOne('u-light-reminder')).status).toBe(200);
  });

  it('Remind All counts as one, however many people it reminds', async () => {
    world();
    const host = 'u-remind-all-host';
    const first = await remindAll(host);
    expect(first.body.data).toEqual({ reminded: 3, total: 3 });
    for (let i = 0; i < 59; i += 1) expect((await remindOne(host)).status).toBe(200);
    expect((await remindOne(host)).status).toBe(429);
    expect((await remindAll(host)).status).toBe(429);
  });
});
