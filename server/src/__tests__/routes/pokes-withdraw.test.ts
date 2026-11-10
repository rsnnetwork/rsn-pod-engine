// server/src/__tests__/routes/pokes-withdraw.test.ts
// POST /pokes/:id/withdraw (10 Nov 2026): the sender takes a waiting meeting request back.
import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

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
const mockWithdraw = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/poke/poke.service', () => ({
  withdrawPoke: (...a: unknown[]) => mockWithdraw(...a),
  __esModule: true,
}));
jest.mock('../../realtime/fanout', () => ({ fanoutUserEntity: jest.fn().mockResolvedValue(undefined), __esModule: true }));

import pokesRoutes from '../../routes/pokes';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { ConflictError, ForbiddenError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/pokes', pokesRoutes);
app.use(notFoundHandler);
app.use(errorHandler);
const auth = { Authorization: `Bearer ${jwt.sign({ sub: 'u-a', email: 'a@example.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` };
const REQUEST_ID = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

describe('POST /pokes/:id/withdraw', () => {
  beforeEach(() => mockWithdraw.mockReset().mockResolvedValue(undefined));

  it('withdraws the request as the signed-in member, and says it is cancelled', async () => {
    const res = await request(app).post(`/pokes/${REQUEST_ID}/withdraw`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: REQUEST_ID, status: 'cancelled' });
    expect(mockWithdraw).toHaveBeenCalledWith(REQUEST_ID, 'u-a');
  });

  it('needs a signed-in member', async () => {
    const res = await request(app).post(`/pokes/${REQUEST_ID}/withdraw`);
    expect(res.status).toBe(401);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a request id with a 400, before the service', async () => {
    const res = await request(app).post('/pokes/not-a-uuid/withdraw').set(auth);
    expect(res.status).toBe(400);
    expect(mockWithdraw).not.toHaveBeenCalled();
  });

  it("passes the service's refusals through: 403 for someone else's, 409 with the status when it is no longer waiting", async () => {
    mockWithdraw.mockRejectedValueOnce(new ForbiddenError('Only the person who sent this meeting request can withdraw it.'));
    const forbidden = await request(app).post(`/pokes/${REQUEST_ID}/withdraw`).set(auth);
    expect(forbidden.status).toBe(403);

    mockWithdraw.mockRejectedValueOnce(
      new ConflictError(ErrorCodes.MEETING_REQUEST_ALREADY_ANSWERED, 'You already withdrew this request.', { status: 'cancelled' }));
    const twice = await request(app).post(`/pokes/${REQUEST_ID}/withdraw`).set(auth);
    expect(twice.status).toBe(409);
    expect(twice.body.error).toMatchObject({ code: 'MEETING_REQUEST_ALREADY_ANSWERED', message: 'You already withdrew this request.' });
  });

  it('is rate limited by its own limiter, which counts only withdrawals that happened', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../../routes/pokes.ts'), 'utf8').replace(/\s+/g, ' ');
    expect(routes).toContain("'/:id/withdraw', authenticate, requestWithdrawLimiter, validate(requestParams, 'params')");
    const limiter = fs.readFileSync(path.join(__dirname, '../../middleware/rateLimit.ts'), 'utf8').replace(/\s+/g, ' ');
    expect(limiter).toMatch(/export const requestWithdrawLimiter = rateLimit\(\{ windowMs: 60 \* 60 \* 1000, max: 20, skipFailedRequests: true,/);
    expect(limiter).toContain("store: buildStore('request-withdraw')");
  });
});
