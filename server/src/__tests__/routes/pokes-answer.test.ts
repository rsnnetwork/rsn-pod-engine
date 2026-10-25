// server/src/__tests__/routes/pokes-answer.test.ts
// POST /pokes/:id/accept and /pokes/:id/decline (25 Oct 2026). Answering a request changes the
// bell of both people: the recipient's row for it is marked read and now reads Accepted or
// Declined, and an accept rings the sender. So both are sent their own notifications tag, on top of
// the user and invites tags they already got. A request answered the other way is a 409 that says
// which answer it has, and an id that is not a request id never reaches the database.
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
const mockAcceptPoke = jest.fn();
const mockDeclinePoke = jest.fn();
jest.mock('../../services/poke/poke.service', () => ({
  acceptPoke: (...a: unknown[]) => mockAcceptPoke(...a),
  declinePoke: (...a: unknown[]) => mockDeclinePoke(...a),
  __esModule: true,
}));
const mockFanoutUserEntity = jest.fn();
jest.mock('../../realtime/fanout', () => ({
  fanoutUserEntity: (...a: unknown[]) => mockFanoutUserEntity(...a),
  __esModule: true,
}));

import pokesRoutes from '../../routes/pokes';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { ConflictError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/pokes', pokesRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const ME = 'u-recipient';
const SENDER = 'u-sender';
const POKE = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';
const auth = { Authorization: `Bearer ${jwt.sign({ sub: ME, email: 'r@example.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` };

const request_ = { id: POKE, senderId: SENDER, recipientId: ME, message: null, respondedAt: null, createdAt: new Date().toISOString(), preferredFormat: null };

beforeEach(() => {
  mockAcceptPoke.mockReset().mockResolvedValue({ poke: { ...request_, status: 'accepted' }, conversationId: 'conv-1' });
  mockDeclinePoke.mockReset().mockResolvedValue({ ...request_, status: 'declined' });
  mockFanoutUserEntity.mockReset().mockResolvedValue(undefined);
});

/** The extra tags each person was sent (fanoutUserEntity adds their user tag itself). */
const tagsSentTo = (userId: string) => mockFanoutUserEntity.mock.calls
  .filter(([u]) => u === userId)
  .flatMap(([, tags]) => tags as string[]);

describe.each([
  ['accept', mockAcceptPoke],
  ['decline', mockDeclinePoke],
] as const)('POST /pokes/:id/%s', (action, service) => {
  it('answers the request for the member signed in, and tells both people\'s screens and bells', async () => {
    const res = await request(app).post(`/pokes/${POKE}/${action}`).set(auth);

    expect(res.status).toBe(200);
    expect(service).toHaveBeenCalledWith(POKE, ME);
    for (const userId of [SENDER, ME]) {
      expect(tagsSentTo(userId)).toEqual(expect.arrayContaining([`user:${userId}:invites`, `user:${userId}:notifications`]));
    }
  });

  it('refuses an id that is not a request id before anything is answered', async () => {
    const res = await request(app).post(`/pokes/not-a-request/${action}`).set(auth);

    expect(res.status).toBe(400);
    expect(service).not.toHaveBeenCalled();
    expect(mockFanoutUserEntity).not.toHaveBeenCalled();
  });
});

describe('a request answered the other way', () => {
  it('is a 409 that carries the code, the member\'s sentence and the answer it already has', async () => {
    mockAcceptPoke.mockRejectedValue(new ConflictError(
      ErrorCodes.MEETING_REQUEST_ALREADY_ANSWERED, 'You already declined this request.', { status: 'declined' },
    ));

    const res = await request(app).post(`/pokes/${POKE}/accept`).set(auth);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'MEETING_REQUEST_ALREADY_ANSWERED',
      message: 'You already declined this request.',
      details: { status: 'declined' },
    });
  });

  it('answering again the same way is a 200 with the request as it stands, so a stale bell lands in the thread', async () => {
    const res = await request(app).post(`/pokes/${POKE}/accept`).set(auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ poke: { status: 'accepted' }, conversationId: 'conv-1' });
  });
});
