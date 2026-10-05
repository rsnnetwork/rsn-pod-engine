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
const mockSet = jest.fn().mockResolvedValue(undefined);
const mockClear = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/people/person-response.service', () => ({
  setResponse: (...a: unknown[]) => mockSet(...a),
  clearResponse: (...a: unknown[]) => mockClear(...a),
  getResponse: jest.fn(),
  __esModule: true,
}));
const mockRecord = jest.fn().mockResolvedValue({ id: 'o1', worthContinuing: 'yes', outcomes: ['advice'], createdAt: '2026-09-30T10:00:00.000Z' });
jest.mock('../../services/people/meeting-outcome.service', () => ({ recordOutcome: (...a: unknown[]) => mockRecord(...a), __esModule: true }));
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({ fanoutUserEntity: (...a: unknown[]) => mockFanout(...a), __esModule: true }));

import { query } from '../../db';
import peopleRoutes from '../../routes/people';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { peopleWriteLimiter } from '../../middleware/rateLimit';
import { ConflictError, NotFoundError } from '../../middleware/errors';
import { ErrorCodes, OUTCOME_KEYS } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/people', peopleRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub = 'u-viewer') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const TARGET = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const dbQuery = query as jest.Mock;

describe('PUT/DELETE /people/:userId/response', () => {
  beforeEach(() => { mockSet.mockClear(); mockClear.mockClear(); mockFanout.mockClear(); });

  it('saves, then tells the member\'s own screens to refresh', async () => {
    const res = await request(app).put(`/people/${TARGET}/response`).set('Authorization', `Bearer ${token()}`).send({ response: 'saved' });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('u-viewer', TARGET, 'saved');
    expect(mockFanout).toHaveBeenCalledWith('u-viewer');
  });

  it('rejects an unknown response, a bad id, and a missing token', async () => {
    const bad = await request(app).put(`/people/${TARGET}/response`).set('Authorization', `Bearer ${token()}`).send({ response: 'like' });
    expect(bad.status).toBe(400);
    const badId = await request(app).put('/people/not-a-uuid/response').set('Authorization', `Bearer ${token()}`).send({ response: 'saved' });
    expect(badId.status).toBe(400);
    const anon = await request(app).put(`/people/${TARGET}/response`).send({ response: 'saved' });
    expect(anon.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('undoes', async () => {
    const res = await request(app).delete(`/people/${TARGET}/response`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(mockClear).toHaveBeenCalledWith('u-viewer', TARGET);
    expect(mockFanout).toHaveBeenCalledWith('u-viewer');
  });

  it('answers 404 when the person does not exist, and tells no screens', async () => {
    mockSet.mockRejectedValueOnce(new NotFoundError('User', TARGET));
    const res = await request(app).put(`/people/${TARGET}/response`).set('Authorization', `Bearer ${token()}`).send({ response: 'saved' });
    expect(res.status).toBe(404);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('a failed undo tells no screens either', async () => {
    mockClear.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).delete(`/people/${TARGET}/response`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(500);
    expect(mockFanout).not.toHaveBeenCalled();
  });
});

describe('POST /people/:userId/outcome', () => {
  beforeEach(() => { mockRecord.mockClear(); mockFanout.mockClear(); });

  it('records and returns 201', async () => {
    const res = await request(app).post(`/people/${TARGET}/outcome`).set('Authorization', `Bearer ${token()}`)
      .send({ worthContinuing: 'yes', outcomes: ['advice'] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { id: 'o1', worthContinuing: 'yes', outcomes: ['advice'], createdAt: '2026-09-30T10:00:00.000Z' } });
    expect(mockRecord).toHaveBeenCalledWith('u-viewer', TARGET, 'yes', ['advice']);
  });
  it('rejects answers outside the Foundation list', async () => {
    const res = await request(app).post(`/people/${TARGET}/outcome`).set('Authorization', `Bearer ${token()}`)
      .send({ worthContinuing: 'definitely', outcomes: ['marriage'] });
    expect(res.status).toBe(400);
  });

  it('tells the member\'s own screens to refresh once it is saved', async () => {
    const res = await request(app).post(`/people/${TARGET}/outcome`).set('Authorization', `Bearer ${token()}`)
      .send({ worthContinuing: 'maybe', outcomes: [] });
    expect(res.status).toBe(201);
    expect(mockFanout).toHaveBeenCalledWith('u-viewer');
  });

  it('answers 409 when the two are not connected yet, and tells no screens', async () => {
    const message = 'You can record what happened once you two are connected.';
    mockRecord.mockRejectedValueOnce(new ConflictError(ErrorCodes.VALIDATION_ERROR, message));
    const res = await request(app).post(`/people/${TARGET}/outcome`).set('Authorization', `Bearer ${token()}`)
      .send({ worthContinuing: 'yes', outcomes: [] });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(message);
    expect(mockFanout).not.toHaveBeenCalled();
  });

  it('treats a missing outcomes list as none, and refuses more than the Foundation answers', async () => {
    const none = await request(app).post(`/people/${TARGET}/outcome`).set('Authorization', `Bearer ${token()}`)
      .send({ worthContinuing: 'no' });
    expect(none.status).toBe(201);
    expect(mockRecord).toHaveBeenCalledWith('u-viewer', TARGET, 'no', []);
    mockRecord.mockClear();
    const tooMany = await request(app).post(`/people/${TARGET}/outcome`).set('Authorization', `Bearer ${token()}`)
      .send({ worthContinuing: 'yes', outcomes: Array(OUTCOME_KEYS.length + 1).fill('advice') });
    expect(tooMany.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects a bad id and a missing token without touching the service', async () => {
    const badId = await request(app).post('/people/not-a-uuid/outcome').set('Authorization', `Bearer ${token()}`)
      .send({ worthContinuing: 'yes', outcomes: [] });
    expect(badId.status).toBe(400);
    const anon = await request(app).post(`/people/${TARGET}/outcome`).send({ worthContinuing: 'yes', outcomes: [] });
    expect(anon.status).toBe(401);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

// Postgres reads an upper-case uuid as the same member; the services compare plain
// strings. The routes lower-case the id first, so what the services compare is what
// the database means (5 Oct 2026).
describe('member ids typed in capitals', () => {
  const CAPS = TARGET.toUpperCase();
  const OWN = '9b2d5c1e-3f4a-4b6c-8d7e-0a1b2c3d4e5f';
  const auth = { Authorization: `Bearer ${token()}` };
  beforeEach(() => { mockSet.mockClear(); mockClear.mockClear(); mockRecord.mockClear(); });
  // Rows are what Postgres returns for any lookup; the one rule it adds is the
  // table's CHECK (user_id <> target_user_id), which ignores letter case.
  afterEach(() => { dbQuery.mockReset(); dbQuery.mockResolvedValue({ rows: [{ status: 'active' }] }); });

  it('reach the service lower-cased on Save, Pass and undo', async () => {
    const put = await request(app).put(`/people/${CAPS}/response`).set(auth).send({ response: 'passed' });
    expect(put.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('u-viewer', TARGET, 'passed');
    const del = await request(app).delete(`/people/${CAPS}/response`).set(auth);
    expect(del.status).toBe(200);
    expect(mockClear).toHaveBeenCalledWith('u-viewer', TARGET);
  });

  it('reach the service lower-cased when recording what happened, so the ordered pair cannot flip', async () => {
    const res = await request(app).post(`/people/${CAPS}/outcome`).set(auth).send({ worthContinuing: 'yes', outcomes: [] });
    expect(res.status).toBe(201);
    expect(mockRecord).toHaveBeenCalledWith('u-viewer', TARGET, 'yes', []);
  });

  it('your own id in capitals is still you: a 400, not a database error', async () => {
    // The real service, with a database stand-in that applies the CHECK the way Postgres does.
    const people = jest.requireActual<typeof import('../../services/people/person-response.service')>(
      '../../services/people/person-response.service',
    );
    mockSet.mockImplementationOnce((...a: Parameters<typeof people.setResponse>) => people.setResponse(...a));
    dbQuery.mockImplementation((sql: string, params: string[] = []) => (
      /INSERT INTO person_responses/.test(sql) && params[0].toLowerCase() === params[1].toLowerCase()
        ? Promise.reject(Object.assign(new Error('new row violates check constraint'), { code: '23514' }))
        : Promise.resolve({ rows: [{ id: params[0], status: 'active' }] })
    ));
    const res = await request(app).put(`/people/${OWN.toUpperCase()}/response`)
      .set({ Authorization: `Bearer ${token(OWN)}` }).send({ response: 'saved' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('You cannot save or pass yourself');
    expect(dbQuery.mock.calls.some(c => /INSERT INTO person_responses/.test(String(c[0])))).toBe(false);
    expect(mockFanout).not.toHaveBeenCalled();
  });
});

describe('a refused request calls no service and tells no screens', () => {
  const bearer = `Bearer ${token()}`;
  const answer = { worthContinuing: 'yes', outcomes: [] };
  const cases: Array<{ name: string; send: () => PromiseLike<{ status: number }>; status: number }> = [
    { name: 'Save with an unknown response', status: 400, send: () => request(app).put(`/people/${TARGET}/response`).set('Authorization', bearer).send({ response: 'like' }) },
    { name: 'Save with no response at all', status: 400, send: () => request(app).put(`/people/${TARGET}/response`).set('Authorization', bearer).send({}) },
    { name: 'Save for an id that is not a member id', status: 400, send: () => request(app).put('/people/not-a-uuid/response').set('Authorization', bearer).send({ response: 'saved' }) },
    { name: 'Save with no token', status: 401, send: () => request(app).put(`/people/${TARGET}/response`).send({ response: 'saved' }) },
    { name: 'undo for an id that is not a member id', status: 400, send: () => request(app).delete('/people/not-a-uuid/response').set('Authorization', bearer) },
    { name: 'undo with no token', status: 401, send: () => request(app).delete(`/people/${TARGET}/response`) },
    { name: 'recording with an answer outside the list', status: 400, send: () => request(app).post(`/people/${TARGET}/outcome`).set('Authorization', bearer).send({ worthContinuing: 'definitely', outcomes: ['marriage'] }) },
    { name: 'recording for an id that is not a member id', status: 400, send: () => request(app).post('/people/not-a-uuid/outcome').set('Authorization', bearer).send(answer) },
    { name: 'recording with no token', status: 401, send: () => request(app).post(`/people/${TARGET}/outcome`).send(answer) },
  ];

  it.each(cases)('$name', async ({ send, status }) => {
    const res = await send();
    expect(res.status).toBe(status);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockFanout).not.toHaveBeenCalled();
  });
});

describe('the write routes are rate limited', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } };
  // What a route runs, in order, read from the router itself.
  const handlersOf = (method: string, path: string) =>
    (peopleRoutes as unknown as { stack: Layer[] }).stack
      .filter((layer) => layer.route?.path === path && layer.route.methods[method])
      .flatMap((layer) => layer.route!.stack.map((s) => s.handle));

  it.each([
    ['put', '/:userId/response'],
    ['delete', '/:userId/response'],
    ['post', '/:userId/outcome'],
  ])('%s %s carries peopleWriteLimiter, ahead of its handler', (method, path) => {
    const handlers = handlersOf(method, path);
    expect(handlers.length).toBeGreaterThan(1); // the route exists
    const at = handlers.indexOf(peopleWriteLimiter);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(handlers.length - 1);
  });
});
