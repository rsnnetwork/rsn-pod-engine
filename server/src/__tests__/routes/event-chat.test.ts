// ─── /api/sessions/:id/chat: the event chat routes (26 Oct 2026) ────────────
// What each route accepts, what it answers, and that taking a message down tells the chat's readers only once
// it has happened. The service is a stand-in: who may read and delete is tested in
// services/event-chat/event-chat.service.test.ts, the readers' audience in realtime/fanout-session-completed.test.ts.

import express from 'express';
import request from 'supertest';
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
const mockDelete = jest.fn();
jest.mock('../../services/event-chat/event-chat.service', () => ({
  listEventChat: (...a: unknown[]) => mockList(...a),
  deleteEventChatMessage: (...a: unknown[]) => mockDelete(...a),
  __esModule: true,
}));
const mockFanoutChat = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({
  fanoutSessionChat: (...a: unknown[]) => mockFanoutChat(...a),
  __esModule: true,
}));

import eventChatRoutes from '../../routes/event-chat';
import { authenticate } from '../../middleware/auth';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { eventChatReadLimiter, eventChatWriteLimiter } from '../../middleware/rateLimit';
import { ForbiddenError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/sessions', eventChatRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

// Each describe signs in as its own member, so no block of tests uses up another's allowance.
const token = (sub: string, role = 'member') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role, sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const as = (sub: string, role = 'member') => ({ Authorization: `Bearer ${token(sub, role)}` });

const EVENT = '3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22';
const MSG = '9b3e6d21-7c4a-4f18-a2d5-0e8f1c6b4a77';
const FORBIDDEN = 'Only people who took part in this event can read its chat.';

const page = {
  messages: [{
    id: MSG, senderId: 'u-2', senderName: 'Stefan', senderIsHost: false, scope: 'lobby',
    content: 'Here I can see what we chatted about', createdAt: '2026-10-25T11:53:00.000Z', reactions: { heart: 1 },
  }],
  nextCursor: `1761393180000_${MSG}`,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue(page);
  mockDelete.mockResolvedValue({ deleted: true });
});

describe('GET /sessions/:id/chat', () => {
  const me = as('u-reader');

  it('answers a page of the chat for the signed-in viewer, and tells no screens (a read changes nothing)', async () => {
    const res = await request(app).get(`/sessions/${EVENT}/chat`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: page });
    expect(mockList).toHaveBeenCalledWith(EVENT, { id: 'u-reader', role: 'member' }, { cursor: undefined, limit: undefined });
    expect(mockFanoutChat).not.toHaveBeenCalled();
  });

  it('passes the cursor and the page size on, and an admin\'s role with them', async () => {
    const cursor = `1761393180000_${MSG}`;
    await request(app).get(`/sessions/${EVENT}/chat`).query({ cursor, limit: '30' }).set(as('u-admin', 'admin'));
    expect(mockList).toHaveBeenCalledWith(EVENT, { id: 'u-admin', role: 'admin' }, { cursor, limit: 30 });
  });

  it('reads an upper-case event id as the same event', async () => {
    await request(app).get(`/sessions/${EVENT.toUpperCase()}/chat`).set(me);
    expect(mockList.mock.calls[0][0]).toBe(EVENT);
  });

  it.each([
    ['a cursor that is not <epochMs>_<id>', { cursor: 'yesterday' }],
    ['a cursor with no id', { cursor: '1761393180000' }],
    ['a page size of 0', { limit: '0' }],
    ['a page size over 100', { limit: '101' }],
    ['a page size that is not a number', { limit: 'lots' }],
    ['two cursors', `cursor=1_${MSG}&cursor=2_${MSG}`],
  ])('refuses %s with a 400 and reads nothing', async (_what, q) => {
    const res = await request(app).get(`/sessions/${EVENT}/chat`).query(q).set(me);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('refuses an id that is not an event id with a 400', async () => {
    const res = await request(app).get('/sessions/not-an-event/chat').set(me);
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('says why when the viewer did not take part (403, the sentence the page shows)', async () => {
    mockList.mockRejectedValueOnce(new ForbiddenError(FORBIDDEN));
    const res = await request(app).get(`/sessions/${EVENT}/chat`).set(me);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: ErrorCodes.AUTH_FORBIDDEN, message: FORBIDDEN });
  });

  it('answers 404 for an event that does not exist', async () => {
    mockList.mockRejectedValueOnce(new NotFoundError('Session', EVENT, 'This event could not be found.'));
    const res = await request(app).get(`/sessions/${EVENT}/chat`).set(me);
    expect(res.status).toBe(404);
  });

  it('needs a signed-in member', async () => {
    expect((await request(app).get(`/sessions/${EVENT}/chat`)).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('refuses the 61st read in a minute with a friendly 429, for that member only', async () => {
    const busy = as('u-busy-reader');
    for (let i = 0; i < 60; i += 1) {
      expect((await request(app).get(`/sessions/${EVENT}/chat`).set(busy)).status).toBe(200);
    }
    mockList.mockClear();
    const refused = await request(app).get(`/sessions/${EVENT}/chat`).set(busy);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } });
    expect(mockList).not.toHaveBeenCalled();
    expect((await request(app).get(`/sessions/${EVENT}/chat`).set(as('u-calm-reader'))).status).toBe(200);
  });
});

describe('every event chat route', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] } };
  const handlersOf = (method: string, path: string) =>
    (eventChatRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it.each([
    ['get', '/:id/chat', eventChatReadLimiter],
    ['delete', '/:id/chat/:messageId', eventChatWriteLimiter],
  ])('%s %s carries its limiter, after authenticate and ahead of its handler', (method, path, limiter) => {
    const handlers = handlersOf(method, path);
    expect(handlers.length).toBeGreaterThan(2); // the route exists
    const signedIn = handlers.indexOf(authenticate);
    const at = handlers.indexOf(limiter);
    expect(signedIn).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(signedIn);
    expect(at).toBeLessThan(handlers.length - 1);
  });
});

describe('DELETE /sessions/:id/chat/:messageId', () => {
  const me = as('u-mod', 'admin');

  it('takes the message down, answers ok, and then tells the chat\'s readers', async () => {
    const res = await request(app).delete(`/sessions/${EVENT}/chat/${MSG}`).set(me);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
    expect(mockDelete).toHaveBeenCalledWith(EVENT, MSG, { id: 'u-mod', role: 'admin' });
    expect(mockFanoutChat).toHaveBeenCalledWith(EVENT, 'u-mod');
    expect(mockDelete.mock.invocationCallOrder[0]).toBeLessThan(mockFanoutChat.mock.invocationCallOrder[0]);
  });

  it('a message already taken down answers ok and tells nobody (nothing changed)', async () => {
    mockDelete.mockResolvedValueOnce({ deleted: false });
    const res = await request(app).delete(`/sessions/${EVENT}/chat/${MSG}`).set(me);
    expect(res.status).toBe(200);
    expect(mockFanoutChat).not.toHaveBeenCalled();
  });

  it('a refusal tells nobody', async () => {
    mockDelete.mockRejectedValueOnce(new ForbiddenError('Only the person who wrote this message, a host of this event or an admin can delete it.'));
    const res = await request(app).delete(`/sessions/${EVENT}/chat/${MSG}`).set(as('u-other'));
    expect(res.status).toBe(403);
    expect(mockFanoutChat).not.toHaveBeenCalled();
  });

  it('refuses a message id that is not one, without asking the service', async () => {
    const res = await request(app).delete(`/sessions/${EVENT}/chat/1730000000-abc123`).set(me);
    expect(res.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('needs a signed-in member', async () => {
    expect((await request(app).delete(`/sessions/${EVENT}/chat/${MSG}`)).status).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
