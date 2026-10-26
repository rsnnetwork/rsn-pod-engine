// ─── /api/meetings: the routes (26 Oct 2026, CON-04/05) ──────────────────────
//
// What each route accepts, what it answers, that every one needs a signed-in member, and the limits:
// reads sit under the API limiter that covers every /api route, and cancel has an allowance of its
// own, 10 an hour per member. The service is a stand-in (its rules are in
// services/meetings/meeting.service.test.ts); the router, the sign-in check and the limiters are real.

import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active before any route runs.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockList = jest.fn();
const mockSummary = jest.fn();
const mockGet = jest.fn();
const mockCancel = jest.fn();
jest.mock('../../services/meetings/meeting.service', () => ({
  listMeetings: (...a: unknown[]) => mockList(...a),
  getMeetingSummary: (...a: unknown[]) => mockSummary(...a),
  getMeeting: (...a: unknown[]) => mockGet(...a),
  cancelMeeting: (...a: unknown[]) => mockCancel(...a),
  __esModule: true,
}));

import meetingsRoutes from '../../routes/meetings';
import { authenticate } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { apiLimiter, meetingCancelLimiter } from '../../middleware/rateLimit';
import { ConflictError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/meetings', meetingsRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

// Each describe signs in as its own member, so no block of tests uses up another's allowance.
const token = (sub: string) => jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string) => ({ Authorization: `Bearer ${token(sub)}` });
const ID = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

const meeting = (extra: Record<string, unknown> = {}) => ({
  id: ID, conversationId: 'conv-1', partner: { userId: 'u-b', displayName: 'Bo', avatarUrl: null },
  startAt: '2026-11-05T17:00:00.000Z', durationMin: 30, kind: 'video', status: 'scheduled', phase: 'upcoming',
  context: null, joinPath: '/meet/conv-1?scheduled=1&kind=video', attended: { me: false, them: false }, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue({ items: [meeting()], nextBefore: null });
  mockSummary.mockResolvedValue({ upcomingCount: 1, liveNow: false, next: { id: ID, startAt: '2026-11-05T17:00:00.000Z', partnerName: 'Bo' } });
  mockGet.mockResolvedValue(meeting());
  mockCancel.mockResolvedValue(meeting({ status: 'cancelled', phase: 'cancelled' }));
});

describe('GET /meetings', () => {
  const me = as('u-list');

  it('lists the member\'s upcoming meetings, 20 to a page, when nothing is asked for', async () => {
    const res = await request(app).get('/meetings').set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { items: [meeting()], nextBefore: null } });
    expect(mockList).toHaveBeenCalledWith('u-list', { scope: 'upcoming', limit: 20, before: undefined });
  });

  it('passes the scope, the page size and the cursor on', async () => {
    await request(app).get('/meetings').query({ scope: 'past', limit: '5', before: '2026-11-01T09:00:00.000Z' }).set(me);
    expect(mockList).toHaveBeenCalledWith('u-list', { scope: 'past', limit: 5, before: '2026-11-01T09:00:00.000Z' });
    await request(app).get('/meetings').query({ scope: 'cancelled', limit: '50' }).set(me);
    expect(mockList).toHaveBeenLastCalledWith('u-list', { scope: 'cancelled', limit: 50, before: undefined });
  });

  it.each([
    ['a scope that does not exist', { scope: 'all' }],
    ['a page size of 0', { limit: '0' }],
    ['a page size over 50', { limit: '51' }],
    ['a page size that is not a whole number', { limit: '2.5' }],
    ['a page size that is not a number', { limit: 'lots' }],
    ['a cursor that is not a time', { before: 'yesterday' }],
  ])('refuses %s with a 400 and reads nothing', async (_label, q) => {
    const res = await request(app).get('/meetings').query(q).set(me);
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('GET /meetings/summary', () => {
  it('answers the count Events shows, whether one can be joined now, and the next meeting', async () => {
    const res = await request(app).get('/meetings/summary').set(as('u-summary'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ upcomingCount: 1, liveNow: false, next: { id: ID, startAt: '2026-11-05T17:00:00.000Z', partnerName: 'Bo' } });
    expect(mockSummary).toHaveBeenCalledWith('u-summary');
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('GET /meetings/:id', () => {
  const me = as('u-one');

  it('answers the meeting, read for this member (an upper-case id reads as the same meeting)', async () => {
    const res = await request(app).get(`/meetings/${ID.toUpperCase()}`).set(me);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(meeting());
    expect(mockGet).toHaveBeenCalledWith('u-one', ID);
  });

  it('is a 404 for anyone who is not one of the two', async () => {
    mockGet.mockRejectedValueOnce(new NotFoundError('Meeting', undefined, "We couldn't find that meeting."));
    const res = await request(app).get(`/meetings/${ID}`).set(me);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'MEETING_NOT_FOUND', message: "We couldn't find that meeting." });
  });

  it('refuses an id that is not one with a 400', async () => {
    expect((await request(app).get('/meetings/not-a-meeting').set(me)).status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('POST /meetings/:id/cancel', () => {
  const me = as('u-cancel');

  it('cancels, and answers with the meeting as it now stands', async () => {
    const res = await request(app).post(`/meetings/${ID}/cancel`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: meeting({ status: 'cancelled', phase: 'cancelled' }) });
    expect(mockCancel).toHaveBeenCalledWith('u-cancel', ID);
  });

  it('a meeting already cancelled answers 200 again, as it stands', async () => {
    await request(app).post(`/meetings/${ID}/cancel`).set(me);
    const again = await request(app).post(`/meetings/${ID}/cancel`).set(me);
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('cancelled');
  });

  it('a meeting that has ended is a 409 MEETING_ALREADY_ENDED, said in words', async () => {
    mockCancel.mockRejectedValueOnce(new ConflictError(ErrorCodes.MEETING_ALREADY_ENDED, 'This meeting has already ended.'));
    const res = await request(app).post(`/meetings/${ID}/cancel`).set(me);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'MEETING_ALREADY_ENDED', message: 'This meeting has already ended.' });
  });

  it('a meeting under way is a 409 MEETING_ALREADY_STARTED, said in words (26 Oct 2026)', async () => {
    mockCancel.mockRejectedValueOnce(new ConflictError(
      ErrorCodes.MEETING_ALREADY_STARTED, 'This meeting has already started, so it can no longer be cancelled.',
    ));
    const res = await request(app).post(`/meetings/${ID}/cancel`).set(me);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'MEETING_ALREADY_STARTED', message: 'This meeting has already started, so it can no longer be cancelled.',
    });
  });

  it('someone else\'s meeting is a 404, and a malformed id a 400', async () => {
    mockCancel.mockRejectedValueOnce(new NotFoundError('Meeting', undefined, "We couldn't find that meeting."));
    expect((await request(app).post(`/meetings/${ID}/cancel`).set(me)).status).toBe(404);
    mockCancel.mockClear();
    expect((await request(app).post('/meetings/12345/cancel').set(me)).status).toBe(400);
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe('every meetings route needs a signed-in member', () => {
  it.each([
    ['get', '/meetings'],
    ['get', '/meetings/summary'],
    ['get', `/meetings/${ID}`],
    ['post', `/meetings/${ID}/cancel`],
  ])('%s %s answers 401 without one, and reads or writes nothing', async (method, url) => {
    const res = await (method === 'get' ? request(app).get(url) : request(app).post(url));
    expect(res.status).toBe(401);
    for (const m of [mockList, mockSummary, mockGet, mockCancel]) expect(m).not.toHaveBeenCalled();
  });
});

describe('the routes are rate limited', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const handlersOf = (method: string, routePath: string) =>
    (meetingsRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === routePath && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it('cancel carries its own allowance, after authenticate and ahead of its handler', () => {
    const handlers = handlersOf('post', '/:id/cancel');
    const signedIn = handlers.indexOf(authenticate);
    const at = handlers.indexOf(meetingCancelLimiter);
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(signedIn);
    expect(at).toBeLessThan(handlers.length - 1);
  });

  it('the reads are held by the API limiter every /api route sits under (counting them twice would halve it)', () => {
    for (const routePath of ['/', '/summary', '/:id']) {
      const handlers = handlersOf('get', routePath);
      expect(handlers.length).toBeGreaterThan(1);
      expect(handlers).not.toContain(apiLimiter);
    }
    const index = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
    const limiter = index.indexOf("app.use('/api', apiLimiter);");
    const mounted = index.indexOf("app.use('/api/meetings', meetingsRoutes);");
    expect(limiter).toBeGreaterThan(0);
    expect(mounted).toBeGreaterThan(limiter);
  });

  it('refuses the 11th cancel in an hour with a friendly 429, for that member only', async () => {
    const busy = as('u-busy');
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).post(`/meetings/${ID}/cancel`).set(busy)).status).toBe(200);
    }
    mockCancel.mockClear();
    const refused = await request(app).post(`/meetings/${ID}/cancel`).set(busy);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'You have cancelled a lot of meetings this hour. Try again later.' } });
    expect(mockCancel).not.toHaveBeenCalled();
    // Someone else can still cancel, and this member can still read their meetings.
    expect((await request(app).post(`/meetings/${ID}/cancel`).set(as('u-calm'))).status).toBe(200);
    expect((await request(app).get('/meetings').set(busy)).status).toBe(200);
  });

  it('a cancel that is refused (not found, already ended) uses none of the allowance', async () => {
    const tester = as('u-refused');
    for (let i = 0; i < 12; i += 1) {
      mockCancel.mockRejectedValueOnce(new ConflictError(ErrorCodes.MEETING_ALREADY_ENDED, 'This meeting has already ended.'));
      expect((await request(app).post(`/meetings/${ID}/cancel`).set(tester)).status).toBe(409);
    }
    expect((await request(app).post(`/meetings/${ID}/cancel`).set(tester)).status).toBe(200);
  });
});

describe('the server', () => {
  const index = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');

  it('mounts the meetings routes at /api/meetings', () => {
    expect(index).toMatch(/import meetingsRoutes from '\.\/routes\/meetings';/);
    expect(index).toContain("app.use('/api/meetings', meetingsRoutes);");
  });

  it('runs the reminder worker every 60 seconds, beside the post-event message worker', () => {
    expect(index).toMatch(/import \{ processMeetingReminders \} from '\.\/services\/meetings\/meeting-reminder\.worker';/);
    const pending = index.indexOf('processPendingJobs(io)');
    const reminders = index.indexOf('processMeetingReminders()');
    expect(pending).toBeGreaterThan(0);
    expect(reminders).toBeGreaterThan(pending);
    expect(index).toMatch(/const MEETING_REMINDER_INTERVAL = 60_000;/);
    expect(index.slice(reminders, reminders + 300)).toMatch(/MEETING_REMINDER_INTERVAL\);/);
  });
});
