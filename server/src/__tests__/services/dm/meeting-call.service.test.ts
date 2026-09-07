// ─── 1:1 meeting calls (W-meet, 8 Sep 2026) ─────────────────────────────────
//
// The call service mints LiveKit tokens for the two people in a conversation,
// gates "Meet now" on the partner actually being online, and refuses when
// either side has blocked the other.

const mockQuery = jest.fn();
const mockIssue = jest.fn((..._a: any[]) => Promise.resolve({ token: 'tok-123' }));
const mockAreBlocked = jest.fn((..._a: any[]) => Promise.resolve(false));
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
  __esModule: true,
  areBlocked: (...a: unknown[]) => mockAreBlocked(...a),
}));
jest.mock('../../../index', () => ({
  __esModule: true,
  io: {
    in: () => ({ fetchSockets: () => mockFetchSockets() }),
    to: () => ({ emit: (...a: unknown[]) => mockEmit(...a) }),
  },
}));
jest.mock('../../../services/dm/dm.service', () => ({
  __esModule: true,
  sendBroadcastMessage: (...a: unknown[]) => mockSendBroadcast(...a),
}));
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({
  __esModule: true,
  broadcastDmMessage: (...a: unknown[]) => mockBroadcastDm(...a),
}));
jest.mock('../../../realtime/emit', () => ({ __esModule: true, emitEntities: (...a: unknown[]) => mockEmitEntities(...a) }));
jest.mock('../../../realtime/entities', () => ({
  __esModule: true,
  E: { userNotifications: (id: string) => `user:${id}:notifications`, dmConversation: (id: string) => `dm-conversation:${id}` },
}));

import { callRoomId, getCallToken, isPartnerOnline, startCall } from '../../../services/dm/meeting-call.service';

const CONV = { id: 'conv-1', user_a_id: 'u-a', user_b_id: 'u-b' };

function armQuery() {
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [CONV] });
    if (/SELECT display_name FROM users/.test(sql)) return Promise.resolve({ rows: [{ display_name: 'Ana' }] });
    if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'n1', created_at: new Date() }] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockIssue.mockClear();
  mockAreBlocked.mockReset(); mockAreBlocked.mockResolvedValue(false);
  mockFetchSockets.mockReset(); mockFetchSockets.mockResolvedValue([]);
  mockEmit.mockClear();
  mockSendBroadcast.mockClear();
  mockBroadcastDm.mockClear();
  mockEmitEntities.mockClear();
  armQuery();
});

describe('callRoomId', () => {
  it('is stable per conversation so scheduled + instant joins share a room', () => {
    expect(callRoomId('conv-1')).toBe('dm-conv-1');
  });
});

describe('getCallToken', () => {
  it('mints a token for the conversation room with the LiveKit host', async () => {
    const t = await getCallToken('conv-1', 'u-a', 'video');
    expect(t).toEqual({ token: 'tok-123', url: 'wss://lk.example', roomName: 'dm-conv-1', kind: 'video' });
    expect(mockIssue).toHaveBeenCalledWith('u-a', 'dm-conv-1', 'Ana', expect.any(Number));
  });

  it('carries the audio kind through', async () => {
    const t = await getCallToken('conv-1', 'u-a', 'audio');
    expect(t.kind).toBe('audio');
  });

  it('refuses when the two people have blocked each other', async () => {
    mockAreBlocked.mockResolvedValue(true);
    await expect(getCallToken('conv-1', 'u-a', 'video')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a stranger to the conversation', async () => {
    await expect(getCallToken('conv-1', 'u-stranger', 'video')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('isPartnerOnline', () => {
  it('is true when the partner has a live socket', async () => {
    mockFetchSockets.mockResolvedValue([{ id: 's1' }]);
    expect(await isPartnerOnline('conv-1', 'u-a')).toBe(true);
  });
  it('is false when the partner has no live socket', async () => {
    mockFetchSockets.mockResolvedValue([]);
    expect(await isPartnerOnline('conv-1', 'u-a')).toBe(false);
  });
});

describe('startCall', () => {
  it('refuses with 409 when the partner is offline (told to schedule instead)', async () => {
    mockFetchSockets.mockResolvedValue([]);
    await expect(startCall('conv-1', 'u-a', 'video')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('when the partner is online: returns a token AND rings them (bell + call:incoming)', async () => {
    mockFetchSockets.mockResolvedValue([{ id: 's1' }]);
    const t = await startCall('conv-1', 'u-a', 'video');
    expect(t.token).toBe('tok-123');
    // A system line lands in the thread history.
    expect(mockSendBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcastDm).toHaveBeenCalledTimes(1);
    // The partner is rung on the live socket.
    const events = mockEmit.mock.calls.map(c => c[0]);
    expect(events).toContain('call:incoming');
    expect(events).toContain('notification:new');
    // A durable bell notification is written for the partner.
    const notif = mockQuery.mock.calls.find(c => /INSERT INTO notifications/.test(c[0] as string))!;
    expect(String(notif[0])).toMatch(/'incoming_call'/);
    expect((notif[1] as unknown[])[0]).toBe('u-b');
  });
});
