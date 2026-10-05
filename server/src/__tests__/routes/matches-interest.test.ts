// server/src/__tests__/routes/matches-interest.test.ts
import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active before any route runs.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockInterest = jest.fn().mockResolvedValue({ id: 'p1' });
jest.mock('../../services/matching/platform-match.service', () => ({
  getPlatformMatches: jest.fn(),
  expressInterest: (...a: unknown[]) => mockInterest(...a),
  __esModule: true,
}));

import matchesRoutes from '../../routes/matches';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/matches', matchesRoutes);
app.use(notFoundHandler);
app.use(errorHandler);
const auth = { Authorization: `Bearer ${jwt.sign({ sub: 'u-a', email: 'a@example.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` };
const TARGET = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

describe('POST /matches/platform/:userId/interest', () => {
  beforeEach(() => mockInterest.mockClear());

  it('still works with no body (today\'s callers)', async () => {
    const res = await request(app).post(`/matches/platform/${TARGET}/interest`).set(auth);
    expect(res.status).toBe(201);
    expect(mockInterest).toHaveBeenCalledWith('u-a', TARGET, undefined, { note: undefined, format: undefined });
  });

  it('passes a note and format through', async () => {
    const res = await request(app).post(`/matches/platform/${TARGET}/interest`).set(auth).send({ note: 'Hi', format: 'video_20' });
    expect(res.status).toBe(201);
    expect(mockInterest).toHaveBeenCalledWith('u-a', TARGET, undefined, { note: 'Hi', format: 'video_20' });
  });

  it('rejects an unknown format and an over-long note', async () => {
    expect((await request(app).post(`/matches/platform/${TARGET}/interest`).set(auth).send({ format: 'dinner' })).status).toBe(400);
    expect((await request(app).post(`/matches/platform/${TARGET}/interest`).set(auth).send({ note: 'x'.repeat(301) })).status).toBe(400);
    expect(mockInterest).not.toHaveBeenCalled();
  });

  it('hands the service the member id in lower case, however it was typed', async () => {
    // Postgres reads an upper-case uuid as the same member; the service compares plain strings.
    const res = await request(app).post(`/matches/platform/${TARGET.toUpperCase()}/interest`).set(auth).send({ note: 'Hi' });
    expect(res.status).toBe(201);
    expect(mockInterest).toHaveBeenCalledWith('u-a', TARGET, undefined, { note: 'Hi', format: undefined });
  });

  it('rejects an id that is not a member id before anything reaches the database', async () => {
    const res = await request(app).post('/matches/platform/not-a-uuid/interest').set(auth).send({ note: 'Hi' });
    expect(res.status).toBe(400);
    expect(mockInterest).not.toHaveBeenCalled();
    // Authentication still comes first: no token is a 401, whatever the id looks like.
    expect((await request(app).post('/matches/platform/not-a-uuid/interest')).status).toBe(401);
  });
});
