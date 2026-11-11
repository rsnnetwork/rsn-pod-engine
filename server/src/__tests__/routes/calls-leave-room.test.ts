// ─── Leaving a 1:1 call also takes you out of the room on the server (2 Nov 2026, leave fix round 3) ─────────────
//
// On LiveKit Cloud the person still in a 1:1 call was sometimes told nothing for over 30 s after the other pressed
// leave (preview rr4): neither the goodbye on the call's data channel nor LiveKit's own leave reached the room, and
// LiveKit kept the leaver listed until their connection timed out. The leaver's app now also asks our server, over its
// own connection to us, to take that very connection (its participant sid) out of the room: LiveKit then tells the
// other person at once. POST /dm/conversations/:id/call/leave { sid }.
//   - Only a member of the conversation may ask, and only for themselves (the identity is theirs, from the token).
//   - A LiveKit failure never fails the leave: the person has left either way.
//   - Production's client (origin/main) never calls it; its MeetPage's call-token request is unchanged (last test).

import express from 'express';
import request from 'supertest';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'eeeeeeee-0000-4000-8000-000000000005';
const CONV = 'cccccccc-0000-4000-8000-000000000003';

jest.mock('../../config', () => ({
  default: { clientUrl: 'https://app.rsn.network', jwtSecret: 'test-secret', rateLimitWindowMs: 60_000, rateLimitMaxRequests: 1000, livekit: { host: 'wss://lk.example' } },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../middleware/auth', () => ({
  authenticate: (req: { user?: unknown; headers: Record<string, string> }, _res: unknown, next: () => void) => {
    req.user = { userId: req.headers['x-as'], email: 'x@example.com', role: 'member', sessionId: 's-1' };
    next();
  },
  __esModule: true,
}));
const mockQuery = jest.fn();
jest.mock('../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
const mockRemoveIfSession = jest.fn();
jest.mock('../../services/video/video.service', () => ({
  __esModule: true,
  getVideoProvider: () => ({
    issueJoinToken: () => Promise.resolve({ token: 'tok-1' }),
    removeParticipantIfSession: (...a: unknown[]) => mockRemoveIfSession(...a),
  }),
}));
jest.mock('../../services/presence/presence.service', () => ({
  __esModule: true, presenceState: () => Promise.resolve('online'), presenceOf: () => Promise.resolve({}),
}));
jest.mock('../../services/block/block.service', () => ({ __esModule: true, areBlocked: () => Promise.resolve(false) }));
jest.mock('../../index', () => ({
  __esModule: true, io: { in: () => ({ fetchSockets: () => Promise.resolve([]) }), to: () => ({ emit: jest.fn() }) },
}));
jest.mock('../../realtime/emit', () => ({ __esModule: true, emitEntities: () => Promise.resolve(undefined) }));

import meetingRoutes from '../../routes/meeting';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/dm', meetingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const conv = {
  id: CONV, user_a_id: A, user_b_id: B, calls_unlocked_at: new Date(Date.now() - 86_400_000),
  meeting_start_at: null, meeting_duration_min: null, current_meeting_id: null,
};

beforeEach(() => {
  mockQuery.mockReset();
  mockRemoveIfSession.mockReset();
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (/FROM dm_conversations WHERE id/.test(s)) return Promise.resolve({ rows: [conv] });
    if (/AND \(source = 'instant' OR id = \$2\)/.test(s)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
});

const leave = (as: string, body: unknown, id = CONV) =>
  request(app).post(`/dm/conversations/${id}/call/leave`).set('x-as', as).send(body as object);

describe('POST /dm/conversations/:id/call/leave', () => {
  it('takes that very connection of the member out of the conversation\'s room, and says whether it did', async () => {
    mockRemoveIfSession.mockResolvedValueOnce(true);
    const res = await leave(A, { sid: 'PA_HtMCbTXUxAmX' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { removed: true } });
    expect(mockRemoveIfSession).toHaveBeenCalledWith(`dm-${CONV}`, A, 'PA_HtMCbTXUxAmX');
  });

  it('answers removed: false when that connection is no longer the one in the room', async () => {
    mockRemoveIfSession.mockResolvedValueOnce(false);
    const res = await leave(B, { sid: 'PA_old' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ removed: false });
    expect(mockRemoveIfSession).toHaveBeenCalledWith(`dm-${CONV}`, B, 'PA_old');
  });

  it('never fails the leave when LiveKit cannot be reached', async () => {
    mockRemoveIfSession.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    const res = await leave(A, { sid: 'PA_x1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ removed: false });
  });

  it('refuses someone who is not in the conversation, and touches no room', async () => {
    const res = await leave(C, { sid: 'PA_x1' });
    expect(res.status).toBe(403);
    expect(mockRemoveIfSession).not.toHaveBeenCalled();
  });

  it('refuses a conversation that does not exist', async () => {
    mockQuery.mockImplementation(() => Promise.resolve({ rows: [] }));
    const res = await leave(A, { sid: 'PA_x1' });
    expect(res.status).toBe(404);
    expect(mockRemoveIfSession).not.toHaveBeenCalled();
  });

  it.each([
    ['no sid', {}],
    ['an empty sid', { sid: '' }],
    ['something that is not a participant sid', { sid: 'u-ana' }],
    ['a sid far too long', { sid: `PA_${'x'.repeat(80)}` }],
  ])('refuses %s with a 400, and touches no room', async (_what, body) => {
    const res = await leave(A, body);
    expect(res.status).toBe(400);
    expect(mockRemoveIfSession).not.toHaveBeenCalled();
  });
});

describe('production\'s MeetPage (origin/main) is unchanged', () => {
  it('still mints its room token with POST /dm/conversations/:id/call-token { kind }', async () => {
    const res = await request(app).post(`/dm/conversations/${CONV}/call-token`).set('x-as', A).send({ kind: 'audio' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ token: 'tok-1', roomName: `dm-${CONV}`, kind: 'audio' });
  });
});
