// ─── Ringing a person, and the live call wherever the app is (1 Nov 2026, 30 Oct review item 4) ───
//
// POST /api/calls/user/:userId rings a connection for a video call from a screen that knows a person, not a
// conversation (the profile). Its body is optional: { kind?: 'video', durationMin? }, 30 minutes when it says
// nothing (the preview's dialog sends the 15 it offers). It is limited to 10 rings per 10 minutes per member,
// shared with the thread's own call request, so a runaway client cannot ring someone over and over.
// GET /api/dm/call/requests/incoming and /outgoing restore the banner and the "Calling…" card after a refresh.
//
// These go through express with the real routers and the real limiter; sign-in and the service are stand-ins.

import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

jest.mock('../../config', () => ({
  default: { clientUrl: 'https://app.rsn.network', jwtSecret: 'test-secret', rateLimitWindowMs: 60_000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
let mockUser = 'aaaaaaaa-0000-4000-8000-000000000001';
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { userId: mockUser, email: 'ana@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));
const mockToUser = jest.fn();
const mockRequest = jest.fn();
const mockIncoming = jest.fn();
const mockOutgoing = jest.fn();
jest.mock('../../services/dm/meeting-call.service', () => ({
  __esModule: true,
  requestCallToUser: (...a: unknown[]) => mockToUser(...a),
  requestCall: (...a: unknown[]) => mockRequest(...a),
  getIncomingCallRequest: (...a: unknown[]) => mockIncoming(...a),
  getOutgoingCallRequest: (...a: unknown[]) => mockOutgoing(...a),
}));
jest.mock('../../services/dm/meeting-windows.service', () => ({ __esModule: true }));
jest.mock('../../services/presence/presence.service', () => ({ areActive: jest.fn(), __esModule: true }));
jest.mock('../../db', () => ({ query: jest.fn(), transaction: jest.fn(), __esModule: true }));

import callsRoutes from '../../routes/calls';
import meetingRoutes from '../../routes/meeting';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';
import { ConflictError, ForbiddenError } from '../../middleware/errors';
import { ErrorCodes } from '@rsn/shared';

const app = express();
app.use(express.json());
app.use('/calls', callsRoutes);
app.use('/dm', meetingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONV = 'cccccccc-0000-4000-8000-000000000003';
const RQ = { id: 'rq-1', conversationId: CONV, fromUserId: mockUser, toUserId: B, kind: 'video', durationMin: 30, status: 'pending', createdAt: '2026-11-01T10:00:00.000Z' };
let n = 0;
/**
 * A fresh member per test, so each test has its own bucket: the limiter keys a request on the member its signed
 * token names (userOrIpKey), so each "member" here is a token signed with the test secret.
 */
const someone = () => `Bearer ${jwt.sign({ sub: `member-${++n}` }, 'test-secret')}`;

beforeEach(() => {
  mockToUser.mockReset().mockResolvedValue(RQ);
  mockRequest.mockReset().mockResolvedValue(RQ);
  mockIncoming.mockReset().mockResolvedValue(null);
  mockOutgoing.mockReset().mockResolvedValue(null);
});

describe('POST /calls/user/:userId', () => {
  it('rings with the defaults when the body says nothing: video, 30 minutes', async () => {
    const res = await request(app).post(`/calls/user/${B}`).set('authorization', someone()).send({});
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: RQ });
    expect(mockToUser).toHaveBeenCalledWith(mockUser, B, 30);
  });

  it('takes the length the dialog sends', async () => {
    await request(app).post(`/calls/user/${B}`).set('authorization', someone()).send({ kind: 'video', durationMin: 15 });
    expect(mockToUser).toHaveBeenCalledWith(mockUser, B, 15);
  });

  it('takes no body at all', async () => {
    const res = await request(app).post(`/calls/user/${B}`).set('authorization', someone());
    expect(res.status).toBe(201);
  });

  it.each([
    ['an audio call (the profile rings video only)', { kind: 'audio' }],
    ['a length under 5 minutes', { durationMin: 4 }],
    ['a length over 240 minutes', { durationMin: 241 }],
    ['a length that is not whole minutes', { durationMin: 12.5 }],
    ['a length written as text', { durationMin: '15' }],
  ])('refuses %s before anything rings', async (_label, body) => {
    const res = await request(app).post(`/calls/user/${B}`).set('authorization', someone()).send(body);
    expect(res.status).toBe(400);
    expect(mockToUser).not.toHaveBeenCalled();
  });

  it.each(['undefined', 'not-a-uuid'])('refuses a person id that is not one (%s) with a sentence', async (bad) => {
    const res = await request(app).post(`/calls/user/${bad}`).set('authorization', someone()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("We couldn't find that member.");
    expect(mockToUser).not.toHaveBeenCalled();
  });

  it.each([
    [403, new ForbiddenError('You can call the people you are connected with. Send a meeting request first.')],
    [403, new ForbiddenError('You cannot call this member.')],
    [403, new ForbiddenError('This person is no longer a member of REASON, so they cannot be called.')],
    [409, new ConflictError(ErrorCodes.CALL_PARTNER_OFFLINE, "Bo isn't online right now. Send a message instead.")],
  ])('passes the service\'s refusal on as it is (%s)', async (status, err) => {
    mockToUser.mockRejectedValue(err);
    const res = await request(app).post(`/calls/user/${B}`).set('authorization', someone()).send({});
    expect(res.status).toBe(status);
    expect(res.body.error.message).toBe(err.message);
  });

  it('rings at most 10 times in 10 minutes per member; refusals do not count', async () => {
    const me = someone();
    mockToUser.mockRejectedValueOnce(new ConflictError(ErrorCodes.CALL_PARTNER_OFFLINE, "Bo isn't online right now. Send a message instead."));
    expect((await request(app).post(`/calls/user/${B}`).set('authorization', me).send({})).status).toBe(409);
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app).post(`/calls/user/${B}`).set('authorization', me).send({})).status).toBe(201);
    }
    const eleventh = await request(app).post(`/calls/user/${B}`).set('authorization', me).send({});
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.message).toBe('You have rung a lot of calls in the last few minutes. Try again in a little while.');
    // Someone else's bucket is their own.
    expect((await request(app).post(`/calls/user/${B}`).set('authorization', someone()).send({})).status).toBe(201);
  });

  it('the thread\'s own call request shares the same bucket', async () => {
    const me = someone();
    for (let i = 0; i < 10; i += 1) {
      await request(app).post(`/calls/user/${B}`).set('authorization', me).send({});
    }
    const res = await request(app).post(`/dm/conversations/${CONV}/call/request`).set('authorization', me).send({ kind: 'video', durationMin: 15 });
    expect(res.status).toBe(429);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('GET /dm/call/requests/incoming and /outgoing', () => {
  const live = { id: 'rq-1', conversationId: CONV, fromUserId: B, toUserId: mockUser, partnerName: 'Bo', kind: 'video', durationMin: 15, createdAt: '2026-11-01T10:00:00.000Z', expiresAt: '2026-11-01T10:02:00.000Z' };

  it('incoming answers the call ringing me, or null', async () => {
    mockIncoming.mockResolvedValue(live);
    const res = await request(app).get('/dm/call/requests/incoming').set('authorization', someone());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: live });
    expect(mockIncoming).toHaveBeenCalledWith(mockUser);
    mockIncoming.mockResolvedValue(null);
    expect((await request(app).get('/dm/call/requests/incoming').set('authorization', someone())).body).toEqual({ success: true, data: null });
  });

  it('outgoing answers the call I rang that is still waiting, or null', async () => {
    mockOutgoing.mockResolvedValue({ ...live, fromUserId: mockUser, toUserId: B });
    const res = await request(app).get('/dm/call/requests/outgoing').set('authorization', someone());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'rq-1', toUserId: B });
    expect(mockOutgoing).toHaveBeenCalledWith(mockUser);
  });

  it('is not mistaken for a request id by the accept/decline/cancel paths', async () => {
    const res = await request(app).post('/dm/call/requests/incoming/accept').set('authorization', someone());
    expect(res.status).toBe(400);
  });
});
