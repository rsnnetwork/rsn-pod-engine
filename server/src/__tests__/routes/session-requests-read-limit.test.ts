// ─── The event's Requests list is rate limited (final fix wave SM4, 2 Nov 2026) ─────────────────────────────────
//
// GET /sessions/:id/requests (T11) had only the API limiter in front of every route. Any event's requests can be asked
// for by id, so the list is counted like the event's other per-event read, its kept chat: 60 a minute per member, in
// the same allowance (eventChatReadLimiter). The organisers' card reads it again on every request tag, so a busy
// minute of asks stays far under it. These go through express with the real sessions router; sign-in, the database
// and the request service are stand-ins.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

jest.mock('../../config', () => ({
  default: { jwtSecret: 'test-jwt-secret', clientUrl: 'https://app.rsn.network', rateLimitWindowMs: 60_000, rateLimitMaxRequests: 10_000, env: 'test', isTest: true },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../middleware/auth', () => ({
  // The limiter keys on the signed-in member's token, so each test member carries a real one.
  authenticate: (req: { user?: unknown; headers: Record<string, string> }, _res: unknown, next: () => void) => {
    const sub = (jest.requireActual('jsonwebtoken') as typeof import('jsonwebtoken')).decode(req.headers.authorization.slice(7)) as { sub: string };
    req.user = { userId: sub.sub, email: 'host@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  optionalAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  __esModule: true,
}));
jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), transaction: jest.fn(), __esModule: true }));
jest.mock('../../realtime/fanout');
jest.mock('../../services/session/session.service');
jest.mock('../../services/session/session-access');
jest.mock('../../services/session/session-state-snapshot.service');
jest.mock('../../services/session/event-requests.service');
jest.mock('../../services/email/email.service');

import * as eventRequests from '../../services/session/event-requests.service';
import sessionRoutes from '../../routes/sessions';
import { authenticate } from '../../middleware/auth';
import { eventChatReadLimiter } from '../../middleware/rateLimit';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/sessions', sessionRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const EVENT = 'cccccccc-0000-4000-8000-0000000000aa';
const as = (sub: string) => ({ Authorization: `Bearer ${jwt.sign({ sub, role: 'member' }, 'test-jwt-secret', { expiresIn: '1h' })}` });

beforeEach(() => {
  jest.mocked(eventRequests.listRequests).mockReset().mockResolvedValue([]);
});

describe('GET /sessions/:id/requests', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  const handlers = () => (sessionRoutes as unknown as { stack: Layer[] }).stack
    .filter((layer) => layer.route?.path === '/:id/requests' && layer.route.methods.get)
    .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it('signs in first, then counts the read against the event read allowance, then answers', () => {
    const list = handlers();
    expect(list.indexOf(authenticate)).toBe(0);
    expect(list.indexOf(eventChatReadLimiter)).toBeGreaterThan(0);
    expect(list.indexOf(eventChatReadLimiter)).toBeLessThan(list.length - 1);
  });

  it('answers 60 reads a minute for one member, then tells them to slow down in words; another member is not held back', async () => {
    const host = as('aaaaaaaa-0000-4000-8000-0000000000b1');
    for (let i = 0; i < 60; i += 1) {
      expect((await request(app).get(`/sessions/${EVENT}/requests`).set(host)).status).toBe(200);
    }
    const refused = await request(app).get(`/sessions/${EVENT}/requests`).set(host);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } });
    const other = await request(app).get(`/sessions/${EVENT}/requests`).set(as('aaaaaaaa-0000-4000-8000-0000000000b2'));
    expect(other.status).toBe(200);
  });

  it("keeps its answer and the pending default (the preview's card; production's client never calls it)", async () => {
    jest.mocked(eventRequests.listRequests).mockResolvedValueOnce([{ userId: 'u-1' }] as never);
    const res = await request(app).get(`/sessions/${EVENT}/requests`).set(as('aaaaaaaa-0000-4000-8000-0000000000b3'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ userId: 'u-1' }] });
    expect(eventRequests.listRequests).toHaveBeenCalledWith(EVENT, 'aaaaaaaa-0000-4000-8000-0000000000b3', 'member', 'pending');
  });
});
