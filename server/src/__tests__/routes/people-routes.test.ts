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

import peopleRoutes from '../../routes/people';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { ConflictError } from '../../middleware/errors';
import { ErrorCodes, OUTCOME_KEYS } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/people', peopleRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub = 'u-viewer') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const TARGET = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

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
