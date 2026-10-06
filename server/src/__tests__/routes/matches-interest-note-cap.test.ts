// server/src/__tests__/routes/matches-interest-note-cap.test.ts
// The Meet note's cap is MEET_NOTE_MAX from @rsn/shared, the number the Meet sheet counts against.
// matches-interest.test.ts pins the real value (300 in, 301 out). This one swaps the shared number
// for 7, so the route can only pass if it READS it instead of carrying a 300 of its own.
import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('@rsn/shared', () => ({ ...jest.requireActual('@rsn/shared'), MEET_NOTE_MAX: 7 }));
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));
jest.mock('../../db', () => ({
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

describe('POST /matches/platform/:userId/interest: the note cap is the shared one', () => {
  beforeEach(() => mockInterest.mockClear());

  it('takes a note of exactly the shared cap', async () => {
    const res = await request(app).post(`/matches/platform/${TARGET}/interest`).set(auth).send({ note: 'x'.repeat(7) });
    expect(res.status).toBe(201);
    expect(mockInterest).toHaveBeenCalledWith('u-a', TARGET, undefined, { note: 'x'.repeat(7), format: undefined });
  });

  it('refuses one character more, and the message names the shared number', async () => {
    const res = await request(app).post(`/matches/platform/${TARGET}/interest`).set(auth).send({ note: 'x'.repeat(8) });
    expect(res.status).toBe(400);
    expect(res.body.error.details.note).toEqual(['Keep the note to 7 characters or fewer.']);
    expect(mockInterest).not.toHaveBeenCalled();
  });
});
