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
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({ fanoutUserEntity: (...a: unknown[]) => mockFanout(...a), __esModule: true }));

import peopleRoutes from '../../routes/people';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

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
