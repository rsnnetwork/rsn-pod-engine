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
jest.mock('../../services/invite/invite.service');

const mockCandidates = jest.fn();
const mockBatch = jest.fn();
jest.mock('../../services/invite/invite-candidates.service', () => ({
  listInviteCandidates: (...args: unknown[]) => mockCandidates(...args),
  createInvitesBatch: (...args: unknown[]) => mockBatch(...args),
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
import { inviteBatchLimiter, peopleReadLimiter } from '../../middleware/rateLimit';
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
const PERSON = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeEach(() => {
  mockDb.mockReset();
  // authenticate() checks the member is still active before any route runs.
  mockDb.mockResolvedValue({ rows: [{ status: 'active' }], rowCount: 1 });
  mockCandidates.mockReset();
  mockBatch.mockReset();
  mockFanoutPod.mockClear();
  mockFanoutSession.mockClear();
  mockEmitEntities.mockClear();
  (inviteService.createInvite as jest.Mock).mockReset();
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
    ({ invited: 0, already_member: 0, already_going: 0, already_invited: 0, not_allowed: 0, failed: 0, ...over });
  const summary = (over: Record<string, unknown> = {}) => ({
    results: [{ userId: PERSON(1), outcome: 'invited', inviteId: 'inv-1' }],
    counts: counts({ invited: 1 }),
    target: { podId: POD, sessionId: null },
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

    it('tells the event\'s screens once if anything went out', async () => {
      (inviteService.createInvite as jest.Mock).mockResolvedValue({ id: 'i' });
      mockDb.mockImplementation(async (sql: string) =>
        /SELECT status FROM users/.test(sql) ? { rows: [{ status: 'active' }] } : { rows: [{ pod_id: EVENT_POD }] });
      await bulk();
      expect(mockFanoutSession).toHaveBeenCalledTimes(1);
      expect(mockFanoutSession).toHaveBeenCalledWith(EVENT_POD, EVENT, [`session:${EVENT}:invites`]);
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
  const listAs = (sub: string, role: string, answers: { host: string; cohost: boolean }) => {
    mockDb.mockImplementation(async (sql: string) => {
      if (/SELECT status FROM users/.test(sql)) return { rows: [{ status: 'active' }] };
      if (/SELECT host_user_id FROM sessions/.test(sql)) return { rows: [{ host_user_id: answers.host }] };
      if (/FROM session_cohosts/.test(sql)) return { rows: answers.cohost ? [{ '?column?': 1 }] : [] };
      return { rows: [] };
    });
    (inviteService.listSessionInvites as jest.Mock).mockResolvedValue([{ id: 'i1', status: 'revoked', declinedAt: '2026-10-21T08:00:00.000Z', inviteeUserId: PERSON(1) }]);
    return request(app).get(`/invites/session/${EVENT}?status=revoked`).set(auth(sub, role));
  };

  it('the host reads it', async () => {
    expect((await listAs('u-host', 'member', { host: 'u-host', cohost: false })).status).toBe(200);
  });

  it('a co-host reads it: they send the invites, so they see who answered', async () => {
    const res = await listAs('u-cohost', 'member', { host: 'u-host', cohost: true });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ declinedAt: '2026-10-21T08:00:00.000Z', inviteeUserId: PERSON(1) });
  });

  it('an admin reads it', async () => {
    expect((await listAs('u-admin', 'admin', { host: 'u-host', cohost: false })).status).toBe(200);
  });

  it('anyone else is refused', async () => {
    const res = await listAs('u-stranger', 'member', { host: 'u-host', cohost: false });
    expect(res.status).toBe(403);
    expect(inviteService.listSessionInvites).not.toHaveBeenCalled();
  });
});
