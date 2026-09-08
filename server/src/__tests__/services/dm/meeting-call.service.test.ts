// ─── 1:1 meeting calls: gate + request flow (8–9 Sep 2026) ──────────────────
//
// Calls unlock only after the pair's first scheduled meeting has happened
// (both joined the room inside its window). Then calls go request → accept
// with a caller-typed duration. Tokens only for the two participants, never
// when blocked.

const mockQuery = jest.fn<any, any[]>();
const mockIssue = jest.fn((..._a: any[]) => Promise.resolve({ token: 'tok-123' }));
const mockAreBlocked = jest.fn((..._a: any[]) => Promise.resolve(false));
const mockIsActive = jest.fn((..._a: any[]) => Promise.resolve<boolean | null>(true));
const mockFetchSockets = jest.fn((..._a: any[]) => Promise.resolve([] as unknown[]));
const mockEmit = jest.fn();
const mockSendBroadcast = jest.fn((..._a: any[]) => Promise.resolve({ conversationId: 'conv-1', message: { id: 'm1' } }));
const mockBroadcastDm = jest.fn((..._a: any[]) => Promise.resolve(undefined));
const mockEmitEntities = jest.fn((..._a: any[]) => Promise.resolve(undefined));

jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));
jest.mock('../../../config', () => ({ __esModule: true, default: { livekit: { host: 'wss://lk.example' } } }));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../services/video/video.service', () => ({
  __esModule: true,
  getVideoProvider: () => ({ issueJoinToken: (...a: unknown[]) => mockIssue(...a) }),
}));
jest.mock('../../../services/block/block.service', () => ({
  __esModule: true, areBlocked: (...a: unknown[]) => mockAreBlocked(...a),
}));
jest.mock('../../../services/presence/presence.service', () => ({
  __esModule: true, isActive: (...a: unknown[]) => mockIsActive(...a),
}));
jest.mock('../../../index', () => ({
  __esModule: true,
  io: {
    in: () => ({ fetchSockets: () => mockFetchSockets() }),
    to: () => ({ emit: (...a: unknown[]) => mockEmit(...a) }),
  },
}));
jest.mock('../../../services/dm/dm.service', () => ({
  __esModule: true, sendBroadcastMessage: (...a: unknown[]) => mockSendBroadcast(...a),
}));
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({
  __esModule: true, broadcastDmMessage: (...a: unknown[]) => mockBroadcastDm(...a),
}));
jest.mock('../../../realtime/emit', () => ({ __esModule: true, emitEntities: (...a: unknown[]) => mockEmitEntities(...a) }));
jest.mock('../../../realtime/entities', () => ({
  __esModule: true,
  E: { userNotifications: (id: string) => `user:${id}:notifications`, dmConversation: (id: string) => `dm-conversation:${id}` },
}));

import {
  callRoomId, getCallToken, isPartnerOnline, requestCall, acceptCallRequest,
  declineCallRequest, cancelCallRequest, clampDuration, CALL_REQUEST_TTL_MS,
} from '../../../services/dm/meeting-call.service';

const NOW = Date.now();
// A conversation with a meeting scheduled for right now (inside the window).
const baseConv = () => ({
  id: 'conv-1', user_a_id: 'u-a', user_b_id: 'u-b',
  calls_unlocked_at: null as Date | null,
  meeting_start_at: new Date(NOW) as Date | null,
  meeting_duration_min: 30,
});
let conv = baseConv();
// State of the per-side attendance stamps the UPDATE … RETURNING reports back.
let stamps: { a: Date | null; b: Date | null } = { a: null, b: null };
let request: any = null;

function arm() {
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [conv] });
    if (/SELECT display_name FROM users/.test(sql)) return Promise.resolve({ rows: [{ display_name: 'Ana' }] });
    if (/SET meeting_joined_[ab]_at/.test(sql)) {
      if (/joined_a_at = COALESCE/.test(sql)) stamps.a = stamps.a ?? new Date();
      if (/joined_b_at = COALESCE/.test(sql)) stamps.b = stamps.b ?? new Date();
      return Promise.resolve({ rows: [{ a: stamps.a, b: stamps.b }] });
    }
    if (/INSERT INTO call_requests/.test(sql)) {
      request = { id: 'rq-1', conversation_id: params![0], from_user_id: params![1], to_user_id: params![2], kind: params![3], duration_min: params![4], status: 'pending', created_at: new Date() };
      return Promise.resolve({ rows: [{ id: 'rq-1', created_at: request.created_at }] });
    }
    if (/FROM call_requests WHERE id/.test(sql)) return Promise.resolve({ rows: request ? [request] : [] });
    if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'n1', created_at: new Date() }] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  conv = baseConv(); stamps = { a: null, b: null }; request = null;
  mockQuery.mockReset(); mockIssue.mockClear(); mockEmit.mockClear();
  mockSendBroadcast.mockClear(); mockBroadcastDm.mockClear(); mockEmitEntities.mockClear();
  mockAreBlocked.mockReset(); mockAreBlocked.mockResolvedValue(false);
  mockIsActive.mockReset(); mockIsActive.mockResolvedValue(true);
  mockFetchSockets.mockReset(); mockFetchSockets.mockResolvedValue([]);
  arm();
});

describe('callRoomId', () => {
  it('is stable per conversation so a scheduled join and a later call share a room', () => {
    expect(callRoomId('conv-1')).toBe('dm-conv-1');
  });
});

describe('getCallToken', () => {
  it('mints a token for the conversation room with the LiveKit host', async () => {
    const t = await getCallToken('conv-1', 'u-a', 'video');
    expect(t).toEqual({ token: 'tok-123', url: 'wss://lk.example', roomName: 'dm-conv-1', kind: 'video' });
    expect(mockIssue).toHaveBeenCalledWith('u-a', 'dm-conv-1', 'Ana', expect.any(Number));
  });
  it('refuses when the two people have blocked each other', async () => {
    mockAreBlocked.mockResolvedValue(true);
    await expect(getCallToken('conv-1', 'u-a', 'video')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('refuses a stranger to the conversation', async () => {
    await expect(getCallToken('conv-1', 'u-stranger', 'video')).rejects.toMatchObject({ statusCode: 403 });
  });

  // ── The gate: attending the scheduled meeting unlocks calls ───────────────
  it('entering the scheduled meeting inside its window stamps my attendance', async () => {
    await getCallToken('conv-1', 'u-a', 'video');
    const stamp = mockQuery.mock.calls.find(c => /SET meeting_joined_a_at = COALESCE/.test(c[0] as string));
    expect(stamp).toBeTruthy();
    // Only one side has joined → not unlocked yet.
    expect(mockQuery.mock.calls.some(c => /SET calls_unlocked_at/.test(c[0] as string))).toBe(false);
  });
  it('once BOTH have joined, calls unlock and both clients are told', async () => {
    stamps.a = new Date(); // A already attended
    await getCallToken('conv-1', 'u-b', 'video');
    expect(mockQuery.mock.calls.some(c => /SET calls_unlocked_at = COALESCE/.test(c[0] as string))).toBe(true);
    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), ['u-a', 'u-b'], ['dm-conversation:conv-1']);
  });
  it('a room token fetched OUTSIDE the meeting window does not count as attending', async () => {
    conv.meeting_start_at = new Date(NOW + 3 * 60 * 60 * 1000); // 3h away
    await getCallToken('conv-1', 'u-a', 'video');
    expect(mockQuery.mock.calls.some(c => /SET meeting_joined/.test(c[0] as string))).toBe(false);
  });
  it('with no scheduled meeting there is nothing to attend', async () => {
    conv.meeting_start_at = null;
    await getCallToken('conv-1', 'u-a', 'video');
    expect(mockQuery.mock.calls.some(c => /SET meeting_joined/.test(c[0] as string))).toBe(false);
  });
  it('does not re-stamp once calls are already unlocked', async () => {
    conv.calls_unlocked_at = new Date();
    await getCallToken('conv-1', 'u-a', 'video');
    expect(mockQuery.mock.calls.some(c => /SET meeting_joined/.test(c[0] as string))).toBe(false);
  });
});

describe('isPartnerOnline', () => {
  it('uses the presence heartbeat', async () => {
    mockIsActive.mockResolvedValue(true);
    expect(await isPartnerOnline('conv-1', 'u-a')).toBe(true);
    mockIsActive.mockResolvedValue(false);
    expect(await isPartnerOnline('conv-1', 'u-a')).toBe(false);
  });
  it('falls back to a live socket check when Redis is unavailable', async () => {
    mockIsActive.mockResolvedValue(null);
    mockFetchSockets.mockResolvedValue([{ id: 's1' }]);
    expect(await isPartnerOnline('conv-1', 'u-a')).toBe(true);
  });
});

describe('clampDuration', () => {
  it('accepts any typed number of minutes within 5–240', () => {
    expect(clampDuration(15)).toBe(15);
    expect(clampDuration(7.6)).toBe(8);
    expect(clampDuration(1)).toBe(5);
    expect(clampDuration(999)).toBe(240);
    expect(clampDuration(NaN)).toBe(30);
  });
});

describe('requestCall', () => {
  it('is refused until the first meeting has happened (calls locked)', async () => {
    conv.calls_unlocked_at = null;
    await expect(requestCall('conv-1', 'u-a', 'video', 15)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockQuery.mock.calls.some(c => /INSERT INTO call_requests/.test(c[0] as string))).toBe(false);
  });
  it('is refused with 409 when the partner is offline', async () => {
    conv.calls_unlocked_at = new Date();
    mockIsActive.mockResolvedValue(false);
    await expect(requestCall('conv-1', 'u-a', 'video', 15)).rejects.toMatchObject({ statusCode: 409 });
  });
  it('when unlocked and online: stores the request with the typed duration and rings the partner', async () => {
    conv.calls_unlocked_at = new Date();
    const rq = await requestCall('conv-1', 'u-a', 'audio', 20);
    expect(rq).toMatchObject({ id: 'rq-1', fromUserId: 'u-a', toUserId: 'u-b', kind: 'audio', durationMin: 20, status: 'pending' });
    const ins = mockQuery.mock.calls.find(c => /INSERT INTO call_requests/.test(c[0] as string))!;
    expect(ins[1]).toEqual(['conv-1', 'u-a', 'u-b', 'audio', 20]);
    // A line in the thread, a bell, and the live request event.
    expect(mockSendBroadcast).toHaveBeenCalledWith('u-a', 'u-b', expect.stringMatching(/20-min audio call/));
    const notif = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(c[0] as string))!;
    expect(String(notif[0])).toMatch(/'incoming_call'/);
    const events = mockEmit.mock.calls.map(c => c[0]);
    expect(events).toContain('call:request');
    const payload = mockEmit.mock.calls.find(c => c[0] === 'call:request')![1];
    expect(payload).toMatchObject({ requestId: 'rq-1', conversationId: 'conv-1', fromUserId: 'u-a', kind: 'audio', durationMin: 20 });
  });
  it('clamps an out-of-range duration rather than rejecting it', async () => {
    conv.calls_unlocked_at = new Date();
    const rq = await requestCall('conv-1', 'u-a', 'video', 2);
    expect(rq.durationMin).toBe(5);
  });
});

describe('acceptCallRequest', () => {
  beforeEach(async () => { conv.calls_unlocked_at = new Date(); await requestCall('conv-1', 'u-a', 'video', 15); mockEmit.mockClear(); });

  it('only the callee can accept', async () => {
    await expect(acceptCallRequest('rq-1', 'u-a')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('accepting marks it accepted, tells the caller, and returns the callee a room token', async () => {
    const r = await acceptCallRequest('rq-1', 'u-b');
    expect(mockQuery.mock.calls.some(c => /SET status = 'accepted'/.test(c[0] as string))).toBe(true);
    const ev = mockEmit.mock.calls.find(c => c[0] === 'call:accepted')!;
    expect(ev[1]).toMatchObject({ requestId: 'rq-1', conversationId: 'conv-1', kind: 'video', durationMin: 15 });
    expect(r).toMatchObject({ token: 'tok-123', conversationId: 'conv-1', kind: 'video' });
  });
  it('an expired request cannot be accepted and is marked expired', async () => {
    request.created_at = new Date(Date.now() - CALL_REQUEST_TTL_MS - 1000);
    await expect(acceptCallRequest('rq-1', 'u-b')).rejects.toMatchObject({ statusCode: 409 });
    expect(mockQuery.mock.calls.some(c => /SET status = 'expired'/.test(c[0] as string))).toBe(true);
  });
  it('an already-answered request cannot be accepted again', async () => {
    request.status = 'declined';
    await expect(acceptCallRequest('rq-1', 'u-b')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('declineCallRequest / cancelCallRequest', () => {
  beforeEach(async () => { conv.calls_unlocked_at = new Date(); await requestCall('conv-1', 'u-a', 'video', 15); mockEmit.mockClear(); });

  it('the callee declining tells the caller who declined', async () => {
    await declineCallRequest('rq-1', 'u-b');
    expect(mockQuery.mock.calls.some(c => /SET status = 'declined'/.test(c[0] as string))).toBe(true);
    const ev = mockEmit.mock.calls.find(c => c[0] === 'call:declined')!;
    expect(ev[1]).toMatchObject({ requestId: 'rq-1', conversationId: 'conv-1', byName: 'Ana' });
  });
  it('only the callee can decline', async () => {
    await expect(declineCallRequest('rq-1', 'u-a')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('the caller cancelling tells the callee', async () => {
    await cancelCallRequest('rq-1', 'u-a');
    expect(mockQuery.mock.calls.some(c => /SET status = 'cancelled'/.test(c[0] as string))).toBe(true);
    expect(mockEmit.mock.calls.map(c => c[0])).toContain('call:cancelled');
  });
  it('only the caller can cancel', async () => {
    await expect(cancelCallRequest('rq-1', 'u-b')).rejects.toMatchObject({ statusCode: 403 });
  });
});
