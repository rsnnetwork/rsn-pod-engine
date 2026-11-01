// ─── Production's own call screens after direct calls ship (1 Nov 2026, Review Focus 1) ─────────────
//
// app.rsn.network's client (origin/main) calls the 9 Sep routes exactly as below. This drives each one with that
// client's request shape, through the real routers and the real call and scheduling services, with only the
// database, sockets, presence and LiveKit stood in, and checks it answers as it did:
//   - MessagesPage: POST /dm/conversations/:id/call/request { kind, durationMin } → 201 with the request;
//     GET …/call/pending; POST /dm/call/requests/:id/cancel.
//   - IncomingCallBanner and the thread's card: POST /dm/call/requests/:id/accept | decline.
//   - MeetPage: POST /dm/conversations/:id/call-token { kind } on mount, early or not.
//   - The thread and ThreadMeetingBanner: GET …/scheduling, whose callsUnlocked hides the scheduler once true.

import express from 'express';
import request from 'supertest';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONV = 'cccccccc-0000-4000-8000-000000000003';
const RQ = 'dddddddd-0000-4000-8000-000000000004';

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
jest.mock('../../services/video/video.service', () => ({
  __esModule: true, getVideoProvider: () => ({ issueJoinToken: () => Promise.resolve({ token: 'tok-1' }) }),
}));
jest.mock('../../services/presence/presence.service', () => ({
  __esModule: true, isActive: () => Promise.resolve(true), areActive: () => Promise.resolve({}),
}));
jest.mock('../../services/block/block.service', () => ({ __esModule: true, areBlocked: () => Promise.resolve(false) }));
jest.mock('../../index', () => ({
  __esModule: true, io: { in: () => ({ fetchSockets: () => Promise.resolve([]) }), to: () => ({ emit: jest.fn() }) },
}));
jest.mock('../../realtime/emit', () => ({ __esModule: true, emitEntities: () => Promise.resolve(undefined) }));
jest.mock('../../services/orchestration/handlers/dm-handlers', () => ({ __esModule: true, broadcastDmMessage: () => Promise.resolve(undefined) }));
jest.mock('../../services/dm/dm.service', () => ({
  __esModule: true,
  sendBroadcastMessage: () => Promise.resolve({ conversationId: CONV, message: { id: 'm1' } }),
  canMessage: () => Promise.resolve({ allowed: true }),
}));

import meetingRoutes from '../../routes/meeting';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/dm', meetingRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const NOW = Date.now();
let conv: Record<string, unknown>;
let rq: Record<string, unknown> | null;
let meetingWritten = false;
// Whether the pair has a real mutual connection (call-eligibility.ts MUTUAL_CONNECTION_SQL), as the database answers.
let mutual = true;

function arm() {
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (/FROM dm_conversations WHERE id/.test(s)) return Promise.resolve({ rows: [conv] });
    if (/FROM meeting_availability/.test(s)) return Promise.resolve({ rows: [] });
    if (/AS connected FROM users t/.test(s)) {
      return Promise.resolve({ rows: [{ my_active: true, they_active: true, their_name: 'Meet Bo', blocked: false, connected: mutual }] });
    }
    if (/SELECT display_name FROM users/.test(s)) return Promise.resolve({ rows: [{ display_name: 'Meet Ana' }] });
    if (/AND \(source = 'instant' OR id = \$2\)/.test(s)) return Promise.resolve({ rows: meetingWritten ? [{ id: 'mtg-1', source: 'instant' }] : [] });
    if (/INSERT INTO call_requests/.test(s)) {
      rq = { id: RQ, conversation_id: params![0], from_user_id: params![1], to_user_id: params![2], kind: params![3], duration_min: params![4], status: 'pending', created_at: new Date() };
      return Promise.resolve({ rows: [{ id: RQ, created_at: rq.created_at }] });
    }
    if (/FROM call_requests WHERE id/.test(s)) return Promise.resolve({ rows: rq ? [rq] : [] });
    if (/FROM call_requests WHERE conversation_id/.test(s)) return Promise.resolve({ rows: rq && rq.status === 'pending' ? [rq] : [] });
    if (/SET status = 'accepted'/.test(s)) {
      if (!rq || rq.status !== 'pending') return Promise.resolve({ rows: [] });
      rq.status = 'accepted';
      return Promise.resolve({ rows: [{ id: RQ }] });
    }
    if (/SET status = 'declined'/.test(s) && rq) rq.status = 'declined';
    if (/SET status = 'cancelled'/.test(s) && rq) rq.status = 'cancelled';
    if (/INSERT INTO meetings/.test(s)) { meetingWritten = true; return Promise.resolve({ rows: [{ id: 'mtg-1' }] }); }
    if (/INSERT INTO notifications/.test(s)) return Promise.resolve({ rows: [{ id: 'n1', created_at: new Date() }] });
    return Promise.resolve({ rows: [] });
  });
}

const unlockedPair = () => ({
  id: CONV, user_a_id: A, user_b_id: B, calls_unlocked_at: new Date('2026-10-30T16:40:00Z'),
  meeting_start_at: null, meeting_duration_min: null, current_meeting_id: null,
  meeting_confirmed_window: null, meeting_confirmed_by: null, meeting_confirmed_at: null, meeting_type: null,
  avail_updated_at_a: null, avail_updated_at_b: null, scheduler_seen_at_a: null, scheduler_seen_at_b: null,
});

beforeEach(() => {
  conv = unlockedPair();
  rq = null;
  meetingWritten = false;
  mutual = true;
  mockQuery.mockReset();
  arm();
});

describe('production\'s call screens, for a pair whose calls are unlocked', () => {
  it.each(['video', 'audio'] as const)('MessagesPage rings a %s call with { kind, durationMin } and reads the request as before', async (kind) => {
    const res = await request(app).post(`/dm/conversations/${CONV}/call/request`).set('x-as', A).send({ kind, durationMin: 20 });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: RQ, kind, durationMin: 20 });
    expect(typeof res.body.data.createdAt).toBe('string');
  });

  it('the thread restores the request from call/pending as { id, fromUserId, kind, durationMin, createdAt }', async () => {
    await request(app).post(`/dm/conversations/${CONV}/call/request`).set('x-as', A).send({ kind: 'video', durationMin: 15 });
    const res = await request(app).get(`/dm/conversations/${CONV}/call/pending`).set('x-as', B);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: RQ, fromUserId: A, kind: 'video', durationMin: 15 });
  });

  it('the banner\'s Accept answers 200, and the callee\'s MeetPage then gets its token', async () => {
    await request(app).post(`/dm/conversations/${CONV}/call/request`).set('x-as', A).send({ kind: 'video', durationMin: 15 });
    const accepted = await request(app).post(`/dm/call/requests/${RQ}/accept`).set('x-as', B);
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ token: 'tok-1', conversationId: CONV, kind: 'video' });
    const token = await request(app).post(`/dm/conversations/${CONV}/call-token`).set('x-as', A).send({ kind: 'video' });
    expect(token.status).toBe(200);
    expect(token.body.data).toMatchObject({ token: 'tok-1', roomName: `dm-${CONV}` });
  });

  it('the banner\'s Decline and the caller\'s Cancel answer { ok: true }', async () => {
    await request(app).post(`/dm/conversations/${CONV}/call/request`).set('x-as', A).send({ kind: 'video', durationMin: 15 });
    expect((await request(app).post(`/dm/call/requests/${RQ}/decline`).set('x-as', B)).body).toEqual({ success: true, data: { ok: true } });
    rq = null;
    await request(app).post(`/dm/conversations/${CONV}/call/request`).set('x-as', A).send({ kind: 'video', durationMin: 15 });
    // The cancel adds what it ended as beside ok (fix round 1); production's client reads only ok.
    const cancelled = await request(app).post(`/dm/call/requests/${RQ}/cancel`).set('x-as', A);
    expect(cancelled.body).toEqual({ success: true, data: { ok: true, status: 'cancelled', conversationId: CONV, kind: 'video' } });
  });

  // Fix round 1 (L12): audio keeps production's rule exactly, calls unlocked; it never asks for the video call's
  // mutual connection, so a pair production lets call today can still call.
  it('an unlocked pair still rings for AUDIO on the old route, whatever the video connection says', async () => {
    mutual = false;
    const res = await request(app).post(`/dm/conversations/${CONV}/call/request`).set('x-as', A).send({ kind: 'audio', durationMin: 20 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'audio' });
  });

  it('a locked pair is refused AUDIO in the same words as before', async () => {
    conv = { ...unlockedPair(), calls_unlocked_at: null };
    const res = await request(app).post(`/dm/conversations/${CONV}/call/request`).set('x-as', A).send({ kind: 'audio', durationMin: 20 });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Calls unlock after your first scheduled meeting together.');
  });

  it('a pair with only a conversation (an admin\'s or a broadcast\'s thread) is refused VIDEO on the old route too', async () => {
    conv = { ...unlockedPair(), calls_unlocked_at: null };
    mutual = false;
    const res = await request(app).post(`/dm/conversations/${CONV}/call/request`).set('x-as', A).send({ kind: 'video', durationMin: 20 });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('You can call the people you are connected with. Send a meeting request first.');
    expect((await request(app).get(`/dm/conversations/${CONV}/scheduling`).set('x-as', A)).body.data.canCall).toBe(false);
  });
});

describe('production\'s thread reads callsUnlocked exactly as before', () => {
  it('true for a pair with calls_unlocked_at set', async () => {
    const res = await request(app).get(`/dm/conversations/${CONV}/scheduling`).set('x-as', A);
    expect(res.status).toBe(200);
    expect(res.body.data.callsUnlocked).toBe(true);
    expect(res.body.data.canCall).toBe(true); // added beside it; production ignores it
  });

  it('false for a pair that never held a meeting, although they can now ring each other for video', async () => {
    conv = { ...unlockedPair(), calls_unlocked_at: null };
    const res = await request(app).get(`/dm/conversations/${CONV}/scheduling`).set('x-as', A);
    expect(res.body.data).toMatchObject({ callsUnlocked: false, canCall: true });
  });

  it('an answered call never sets it: the pair\'s scheduler stays in production\'s thread', async () => {
    conv = { ...unlockedPair(), calls_unlocked_at: null };
    await request(app).post(`/dm/conversations/${CONV}/call/request`).set('x-as', A).send({ kind: 'video', durationMin: 15 });
    await request(app).post(`/dm/call/requests/${RQ}/accept`).set('x-as', B);
    expect(mockQuery.mock.calls.some((c) => /calls_unlocked_at = COALESCE/.test(String(c[0])))).toBe(false);
    expect((await request(app).get(`/dm/conversations/${CONV}/scheduling`).set('x-as', A)).body.data.callsUnlocked).toBe(false);
  });
});

describe('production\'s MeetPage mints its token on mount, early or not (the 26 Oct rule)', () => {
  it('a scheduled meeting hours away still gets a token: the early join is never refused', async () => {
    conv = { ...unlockedPair(), calls_unlocked_at: null, meeting_start_at: new Date(NOW + 5 * 60 * 60_000), meeting_duration_min: 30 };
    const res = await request(app).post(`/dm/conversations/${CONV}/call-token`).set('x-as', A).send({ kind: 'video' });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBe('tok-1');
  });

  it('with no meeting and calls locked it still says, in words, that there is no meeting to join', async () => {
    conv = { ...unlockedPair(), calls_unlocked_at: null };
    const res = await request(app).post(`/dm/conversations/${CONV}/call-token`).set('x-as', A).send({ kind: 'video' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe("There's no meeting to join right now. Pick a time to meet in your chat.");
  });
});
