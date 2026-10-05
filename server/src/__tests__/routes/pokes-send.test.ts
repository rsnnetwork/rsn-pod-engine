// server/src/__tests__/routes/pokes-send.test.ts
// POST /pokes: the member the request is for is named in the body.
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
const mockSendPoke = jest.fn().mockResolvedValue({ id: 'p1' });
jest.mock('../../services/poke/poke.service', () => ({
  sendPoke: (...a: unknown[]) => mockSendPoke(...a),
  __esModule: true,
}));
jest.mock('../../realtime/fanout', () => ({ fanoutUserEntity: jest.fn().mockResolvedValue(undefined), __esModule: true }));

import pokesRoutes from '../../routes/pokes';
import { REQUEST_MESSAGE_MAX } from '../../services/poke/request-message';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/pokes', pokesRoutes);
app.use(notFoundHandler);
app.use(errorHandler);
const auth = { Authorization: `Bearer ${jwt.sign({ sub: 'u-a', email: 'a@example.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` };
const TARGET = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

describe('POST /pokes', () => {
  beforeEach(() => mockSendPoke.mockClear());

  it('sends the request to the member named, with the message', async () => {
    const res = await request(app).post('/pokes').set(auth).send({ recipientId: TARGET, message: 'Hello' });
    expect(res.status).toBe(201);
    expect(mockSendPoke).toHaveBeenCalledWith('u-a', TARGET, 'Hello');
  });

  it('hands the service the recipient id in lower case, however it was typed', async () => {
    // Postgres reads an upper-case uuid as the same member; the service compares plain strings
    // (yourself, blocked, already declined), so it must always be given the lower-case form.
    const res = await request(app).post('/pokes').set(auth).send({ recipientId: TARGET.toUpperCase() });
    expect(res.status).toBe(201);
    expect(mockSendPoke).toHaveBeenCalledWith('u-a', TARGET, undefined);
  });

  it('takes a message of exactly the request cap, and refuses one character more', async () => {
    // The cap is the one the service stores and the reason budget is measured against.
    const atTheCap = 'x'.repeat(REQUEST_MESSAGE_MAX);
    const taken = await request(app).post('/pokes').set(auth).send({ recipientId: TARGET, message: atTheCap });
    expect(taken.status).toBe(201);
    expect(mockSendPoke).toHaveBeenCalledWith('u-a', TARGET, atTheCap);

    mockSendPoke.mockClear();
    const refused = await request(app).post('/pokes').set(auth).send({ recipientId: TARGET, message: `${atTheCap}x` });
    expect(refused.status).toBe(400);
    expect(mockSendPoke).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a member id, and a missing token, before anything is sent', async () => {
    expect((await request(app).post('/pokes').set(auth).send({ recipientId: 'not-a-uuid' })).status).toBe(400);
    expect((await request(app).post('/pokes').send({ recipientId: TARGET })).status).toBe(401);
    expect(mockSendPoke).not.toHaveBeenCalled();
  });
});
