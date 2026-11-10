// ─── The lifecycle routes (Part 2 foundation, Task 2) ──────────────────────────────────────────────
//
// POST /sessions/:id/publish, /unpublish, /cancel { reason? }, /archive, DELETE /sessions/:id/archive and
// POST /sessions/:id/delete-permanently { confirmTitle }: signed in, counted (lifecycleWriteLimiter, 20 a minute per
// member), a well-formed event id and body, then the service with the signed-in person as the actor.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../config', () => {
  const config = { jwtSecret: 'test-jwt-secret', clientUrl: 'http://localhost:5173', env: 'test', isTest: true };
  return { config, default: config, __esModule: true };
});
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({
  query: jest.fn(async () => ({ rows: [{ status: 'active' }] })),
  transaction: jest.fn(),
  __esModule: true,
}));

const mockSteps = {
  publishEvent: jest.fn(), unpublishEvent: jest.fn(), cancelEvent: jest.fn(), archiveEvent: jest.fn(),
  unarchiveEvent: jest.fn(), deleteEventPermanently: jest.fn(),
};
jest.mock('../../services/session/event-lifecycle.service', () => ({
  ...mockSteps,
  DELETE_TITLE_MISMATCH: "Type the event's name to delete it.",
  __esModule: true,
}));

import lifecycleRoutes from '../../routes/event-lifecycle';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const EVENT = '5e550000-0000-4000-8000-0000000000c1';
const ME = '05e70000-0000-4000-8000-0000000000a1';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/sessions', lifecycleRoutes);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}
const auth = `Bearer ${jwt.sign({ sub: ME, email: 'me@example.org', role: 'member', sessionId: 's' }, 'test-jwt-secret', { expiresIn: '15m' })}`;

beforeEach(() => {
  for (const fn of Object.values(mockSteps)) fn.mockReset().mockResolvedValue(undefined);
  mockSteps.cancelEvent.mockResolvedValue({ notified: 3 });
});

describe('the lifecycle routes', () => {
  it.each([
    ['post', 'publish', 'publishEvent', { publication: 'published' }],
    ['post', 'unpublish', 'unpublishEvent', { publication: 'draft' }],
    ['post', 'archive', 'archiveEvent', { archived: true }],
    ['delete', 'archive', 'unarchiveEvent', { archived: false }],
  ] as const)('%s /:id/%s takes the step as the signed-in member', async (method, step, fn, data) => {
    const res = await request(app())[method](`/sessions/${EVENT}/${step}`).set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data });
    expect(mockSteps[fn]).toHaveBeenCalledWith(EVENT, { userId: ME, role: 'member' });
  });

  it('cancel passes the reason, trimmed, and answers how many were told', async () => {
    const res = await request(app()).post(`/sessions/${EVENT}/cancel`).set('Authorization', auth).send({ reason: '  Venue closed ' });
    expect(res.body).toEqual({ success: true, data: { notified: 3 } });
    expect(mockSteps.cancelEvent).toHaveBeenCalledWith(EVENT, { userId: ME, role: 'member' }, 'Venue closed');
    await request(app()).post(`/sessions/${EVENT}/cancel`).set('Authorization', auth).send({});
    expect(mockSteps.cancelEvent).toHaveBeenLastCalledWith(EVENT, { userId: ME, role: 'member' }, null);
  });

  it('a reason over 500 characters is 400 in words, and nothing is cancelled', async () => {
    const res = await request(app()).post(`/sessions/${EVENT}/cancel`).set('Authorization', auth).send({ reason: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Keep the reason to 500 characters.');
    expect(mockSteps.cancelEvent).not.toHaveBeenCalled();
  });

  it('delete-permanently passes the typed name; with none it is 400 in words', async () => {
    const ok = await request(app()).post(`/sessions/${EVENT}/delete-permanently`).set('Authorization', auth).send({ confirmTitle: 'Breakfast' });
    expect(ok.body).toEqual({ success: true, data: { deleted: true } });
    expect(mockSteps.deleteEventPermanently).toHaveBeenCalledWith(EVENT, { userId: ME, role: 'member' }, 'Breakfast');
    const none = await request(app()).post(`/sessions/${EVENT}/delete-permanently`).set('Authorization', auth).send({});
    expect(none.status).toBe(400);
    expect(none.body.error.message).toBe("Type the event's name to delete it.");
  });

  it('a malformed id is 400 in a member\'s words; no token is 401', async () => {
    const bad = await request(app()).post('/sessions/not-an-id/publish').set('Authorization', auth);
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toBe("We couldn't find that event.");
    const anon = await request(app()).post(`/sessions/${EVENT}/publish`);
    expect(anon.status).toBe(401);
    expect(mockSteps.publishEvent).not.toHaveBeenCalled();
  });

  it('every route is counted by lifecycleWriteLimiter (20 a minute per member), and the router is mounted at /api/sessions', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../../routes/event-lifecycle.ts'), 'utf8');
    expect(routes).toContain("authenticate, lifecycleWriteLimiter, uuidInPath('id', PATH_REFUSALS.event)");
    const limiter = fs.readFileSync(path.join(__dirname, '../../middleware/rateLimit.ts'), 'utf8');
    expect(limiter).toMatch(/export const lifecycleWriteLimiter = rateLimit\(\{\s+windowMs: 60 \* 1000,\s+max: 20,/);
    const index = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
    expect(index).toContain("app.use('/api/sessions', eventLifecycleRoutes);");
  });
});
