// ─── 1:1 meeting calls: gate + request flow (8–9 Sep 2026; direct video calls 1 Nov 2026) ──────────
//
// 9 Sep: calls unlocked only after the pair's first scheduled meeting had happened (both joined the room
// inside its window), then went request → accept with a caller-typed duration. 1 Nov (30 Oct review item 4,
// L12): a VIDEO call needs a connection, not a held meeting (call-eligibility.ts); audio keeps the unlock.
// An answered call is a meetings row with source 'instant', written with the accept, and its window lets
// both people into the room. Tokens only for the two participants, never when blocked.

const mockQuery = jest.fn<any, any[]>();
const mockIssue = jest.fn((..._a: any[]) => Promise.resolve({ token: 'tok-123' }));
const mockAreBlocked = jest.fn((..._a: any[]) => Promise.resolve(false));
// 11 Nov 2026 (RSN 07): where the callee is (online, away, offline), or null when the read could not tell.
const mockPresenceState = jest.fn((..._a: any[]) => Promise.resolve<'online' | 'away' | 'offline' | null>('online'));
const mockRemoveParticipant = jest.fn((..._a: any[]) => Promise.resolve(undefined));
const mockCloseRoom = jest.fn((..._a: any[]) => Promise.resolve(undefined));
const mockFetchSockets = jest.fn((..._a: any[]) => Promise.resolve([] as unknown[]));
const mockEmit = jest.fn();
const mockSendBroadcast = jest.fn((..._a: any[]) => Promise.resolve({ conversationId: 'conv-1', message: { id: 'm1' } }));
const mockBroadcastDm = jest.fn((..._a: any[]) => Promise.resolve(undefined));
const mockEmitEntities = jest.fn((..._a: any[]) => Promise.resolve(undefined));
const mockRequireConnection = jest.fn((..._a: any[]) => Promise.resolve({ name: 'Bo Brandt' }));
const mockRequireMembers = jest.fn((..._a: any[]) => Promise.resolve({ name: 'Bo Brandt' }));
// Fix round 1: may the two message each other already? (dm.service canMessage, asked both ways)
const mockCanMessage = jest.fn((..._a: any[]) => Promise.resolve({ allowed: true } as { allowed: boolean; reason?: string }));
const mockFindOrCreate = jest.fn((..._a: any[]) => Promise.resolve('conv-1'));
const mockOrder: string[] = [];
// Which user room each socket event went to, in the order they were sent.
const mockRooms: Array<{ room: string; event: string; payload: unknown }> = [];

// 26 Oct 2026: attendance stamps the meeting row and the conversation together, in one transaction.
const mockTxSql: string[] = [];
jest.mock('../../../db', () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => { mockTxSql.push(a[0] as string); return mockQuery(...a); } }),
  __esModule: true,
}));
jest.mock('../../../config', () => ({ __esModule: true, default: { livekit: { host: 'wss://lk.example' } } }));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../services/video/video.service', () => ({
  __esModule: true,
  getVideoProvider: () => ({
    issueJoinToken: (...a: unknown[]) => mockIssue(...a),
    removeParticipant: (...a: unknown[]) => mockRemoveParticipant(...a),
    closeRoom: (...a: unknown[]) => mockCloseRoom(...a),
  }),
}));
jest.mock('../../../services/block/block.service', () => ({
  __esModule: true, areBlocked: (...a: unknown[]) => mockAreBlocked(...a),
}));
jest.mock('../../../services/presence/presence.service', () => ({
  __esModule: true, presenceState: (...a: unknown[]) => mockPresenceState(...a),
}));
jest.mock('../../../index', () => ({
  __esModule: true,
  io: {
    in: () => ({ fetchSockets: () => mockFetchSockets() }),
    to: (room: string) => ({
      emit: (...a: unknown[]) => { mockRooms.push({ room, event: a[0] as string, payload: a[1] }); return mockEmit(...a); },
    }),
  },
}));
jest.mock('../../../services/dm/dm.service', () => ({
  __esModule: true, sendBroadcastMessage: (...a: unknown[]) => mockSendBroadcast(...a),
  canMessage: (...a: unknown[]) => mockCanMessage(...a),
  findOrCreateConversation: (...a: unknown[]) => { mockOrder.push('conversation'); return mockFindOrCreate(...a); },
}));
jest.mock('../../../services/orchestration/handlers/dm-handlers', () => ({
  __esModule: true, broadcastDmMessage: (...a: unknown[]) => mockBroadcastDm(...a),
}));
jest.mock('../../../services/dm/call-eligibility', () => ({
  __esModule: true, requireConnection: (...a: unknown[]) => { mockOrder.push('connection'); return mockRequireConnection(...a); },
  requireMembers: (...a: unknown[]) => mockRequireMembers(...a),
}));
jest.mock('../../../realtime/emit', () => ({ __esModule: true, emitEntities: (...a: unknown[]) => mockEmitEntities(...a) }));
jest.mock('../../../realtime/entities', () => ({
  __esModule: true,
  E: {
    userNotifications: (id: string) => `user:${id}:notifications`, dmConversation: (id: string) => `dm-conversation:${id}`,
    userMeetings: (id: string) => `user:${id}:meetings`, meeting: (id: string) => `meeting:${id}`,
    userCalls: (id: string) => `user:${id}:calls`,
  },
}));

import {
  callRoomId, getCallToken, partnerPresence, requestCall, acceptCallRequest, endCallsOnBlock, CLOSE_AGAIN_AFTER_MS,
  declineCallRequest, cancelCallRequest, clampDuration, CALL_REQUEST_TTL_MS,
  getIncomingCallRequest, getOutgoingCallRequest, requestCallToUser,
} from '../../../services/dm/meeting-call.service';

const NOW = Date.now();
// A conversation with a meeting scheduled for right now (inside the window).
const baseConv = () => ({
  id: 'conv-1', user_a_id: 'u-a', user_b_id: 'u-b',
  calls_unlocked_at: null as Date | null,
  meeting_start_at: new Date(NOW) as Date | null,
  meeting_duration_min: 30,
  current_meeting_id: null as string | null,
});
let conv = baseConv();
// State of the per-side attendance stamps the UPDATE … RETURNING reports back.
let stamps: { a: Date | null; b: Date | null } = { a: null, b: null };
let request: any = null;
// The meetings row's own stamps (26 Oct 2026), and the status of the pair's latest meeting.
let meetingStamps: { a: boolean; b: boolean } = { a: false, b: false };
let lastMeetingStatus: string | null = null;
// An answered call's meetings row (1 Nov 2026): what the accept wrote, and whether one stands now.
let instantRow: { id: string; source: 'instant' } | null = null;
let insertedMeeting: unknown[] | null = null;
// The live requests the incoming/outgoing reads find.
let liveRows: Array<Record<string, unknown>> = [];

/**
 * What the standing-meeting read finds: the scheduled meeting the conversation names while its window
 * (start − 5 min … end + 30 min) holds, first; otherwise an answered call's row, while one stands.
 */
function standingRows(currentId: unknown): Array<{ id: string; source: string }> {
  const start = conv.meeting_start_at?.getTime();
  const now = Date.now();
  if (currentId && start !== undefined && now >= start - 5 * 60_000 && now <= start + (conv.meeting_duration_min + 30) * 60_000) {
    return [{ id: String(currentId), source: 'scheduled' }];
  }
  return instantRow ? [instantRow] : [];
}

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ');
const calls = (re: RegExp) => mockQuery.mock.calls.filter(c => re.test(flat(c[0])));

function arm() {
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [conv] });
    if (/SELECT display_name FROM users/.test(sql)) return Promise.resolve({ rows: [{ display_name: 'Ana' }] });
    if (/AND \(source = 'instant' OR id = \$2\)/.test(flat(sql))) return Promise.resolve({ rows: standingRows(params![1]) });
    if (/INSERT INTO meetings/.test(sql)) {
      insertedMeeting = params!;
      instantRow = { id: 'mtg-instant', source: 'instant' };
      return Promise.resolve({ rows: [{ id: 'mtg-instant' }] });
    }
    if (/SET status = 'accepted'/.test(sql)) {
      if (!request || request.status !== 'pending') return Promise.resolve({ rows: [] });
      request.status = 'accepted';
      return Promise.resolve({ rows: [{ id: request.id }] });
    }
    if (/FROM call_requests r/.test(sql)) return Promise.resolve({ rows: liveRows });
    for (const answer of ['declined', 'cancelled'] as const) {
      if (new RegExp(`SET status = '${answer}'`).test(sql)) {
        if (!request || request.status !== 'pending') return Promise.resolve({ rows: [] });
        request.status = answer;
        return Promise.resolve({ rows: [{ id: request.id }] });
      }
    }
    if (/UPDATE meetings SET joined_[ab]_at/.test(sql)) {
      const side = /joined_a_at/.test(sql) ? 'a' : 'b';
      if (meetingStamps[side]) return Promise.resolve({ rows: [] });
      meetingStamps[side] = true;
      return Promise.resolve({ rows: [{ id: params![0] }] });
    }
    if (/FROM meetings WHERE conversation_id/.test(sql)) {
      return Promise.resolve({ rows: lastMeetingStatus ? [{ status: lastMeetingStatus }] : [] });
    }
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
  meetingStamps = { a: false, b: false }; lastMeetingStatus = null; mockTxSql.length = 0;
  instantRow = null; insertedMeeting = null; liveRows = []; mockRooms.length = 0;
  mockQuery.mockReset(); mockIssue.mockClear(); mockEmit.mockClear();
  mockSendBroadcast.mockClear(); mockBroadcastDm.mockClear(); mockEmitEntities.mockClear();
  mockAreBlocked.mockReset(); mockAreBlocked.mockResolvedValue(false);
  mockPresenceState.mockReset(); mockPresenceState.mockResolvedValue('online');
  mockRemoveParticipant.mockReset(); mockRemoveParticipant.mockResolvedValue(undefined);
  mockCloseRoom.mockReset(); mockCloseRoom.mockResolvedValue(undefined);
  mockFetchSockets.mockReset(); mockFetchSockets.mockResolvedValue([]);
  mockRequireConnection.mockReset(); mockRequireConnection.mockResolvedValue({ name: 'Bo Brandt' });
  mockRequireMembers.mockReset(); mockRequireMembers.mockResolvedValue({ name: 'Bo Brandt' });
  mockCanMessage.mockReset(); mockCanMessage.mockResolvedValue({ allowed: true });
  mockFindOrCreate.mockReset(); mockFindOrCreate.mockResolvedValue('conv-1'); mockOrder.length = 0;
  arm();
});

/** The tags each emitEntities call sent, joined, so a test can ask whether one went to someone. */
const tagsSentTo = (userId: string): string[] =>
  mockEmitEntities.mock.calls.filter(c => (c[1] as string[]).includes(userId)).flatMap(c => c[2] as string[]);

describe('callRoomId', () => {
  it('is stable per conversation so a scheduled join and a later call share a room', () => {
    expect(callRoomId('conv-1')).toBe('dm-conv-1');
  });
});

describe('getCallToken', () => {
  it('mints a token for the conversation room with the LiveKit host', async () => {
    const t = await getCallToken('conv-1', 'u-a', 'video');
    expect(t).toEqual({ token: 'tok-123', url: 'wss://lk.example', roomName: 'dm-conv-1', kind: 'video', meetingId: null });
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
  // 26 Oct 2026: the server never refuses an EARLY join. Production's MeetPage mints this token on
  // mount and draws its own countdown over it, so a refusal would replace the countdown with an error.
  it('an early join is never refused: a meeting hours away still gets a token, and counts as nothing yet', async () => {
    conv.meeting_start_at = new Date(NOW + 5 * 60 * 60 * 1000);
    conv.current_meeting_id = 'mtg-1';
    await expect(getCallToken('conv-1', 'u-a', 'video')).resolves.toMatchObject({ token: 'tok-123', roomName: 'dm-conv-1' });
    expect(mockQuery.mock.calls.some(c => /joined_[ab]_at/.test(c[0] as string))).toBe(false);
  });

  // A token is refused only when calls are still locked AND no scheduled meeting stands that has not
  // ended AND no answered call stands. The words land on production's call screen, above its "Back to chat".
  it('with no meeting and calls still locked, the token is refused in words the call screen can show', async () => {
    conv.meeting_start_at = null;
    await expect(getCallToken('conv-1', 'u-a', 'video')).rejects.toMatchObject({
      statusCode: 403, message: "There's no meeting to join right now. Pick a time to meet in your chat.",
    });
    expect(mockIssue).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some(c => /SET meeting_joined/.test(c[0] as string))).toBe(false);
  });

  it('a meeting that has ended (30 minutes past its end) while calls are still locked is refused the same way', async () => {
    conv.meeting_start_at = new Date(NOW - 2 * 60 * 60 * 1000);
    await expect(getCallToken('conv-1', 'u-a', 'video')).rejects.toMatchObject({ statusCode: 403 });
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it('a meeting still inside its 30 minutes after the end can be entered', async () => {
    conv.meeting_start_at = new Date(NOW - 50 * 60 * 1000); // 30 minutes long: ended 20 minutes ago
    await expect(getCallToken('conv-1', 'u-a', 'video')).resolves.toMatchObject({ token: 'tok-123' });
  });

  it('after a cancel, the old Join in production\'s thread lands on "This meeting was cancelled"', async () => {
    conv.meeting_start_at = null; // a cancel clears the conversation's meeting
    lastMeetingStatus = 'cancelled';
    await expect(getCallToken('conv-1', 'u-a', 'video')).rejects.toMatchObject({
      statusCode: 403, message: 'This meeting was cancelled. Pick a new time to meet in your chat.',
    });
    const lookup = mockQuery.mock.calls.find(c => /FROM meetings WHERE conversation_id/.test(c[0] as string))!;
    expect(String(lookup[0]).replace(/\s+/g, ' ')).toMatch(/SELECT status FROM meetings WHERE conversation_id = \$1 ORDER BY updated_at DESC LIMIT 1/);
    expect(lookup[1]).toEqual(['conv-1']);
  });

  it('once calls are unlocked a token needs no meeting at all', async () => {
    conv.calls_unlocked_at = new Date();
    conv.meeting_start_at = null;
    await expect(getCallToken('conv-1', 'u-a', 'video')).resolves.toMatchObject({ token: 'tok-123' });
  });

  // ── Attendance on the meeting row (26 Oct 2026) ───────────────────────────
  it('entering inside the window stamps the meeting row and the conversation together, in one transaction, and tells both screens', async () => {
    conv.current_meeting_id = 'mtg-1';
    await getCallToken('conv-1', 'u-b', 'video');
    const meetingStamp = mockQuery.mock.calls.find(c => /UPDATE meetings SET joined_b_at/.test(c[0] as string))!;
    expect(meetingStamp[1]).toEqual(['mtg-1']);
    expect(mockTxSql.some(s => /UPDATE meetings SET joined_b_at/.test(s))).toBe(true);
    expect(mockTxSql.some(s => /SET meeting_joined_b_at = COALESCE/.test(s))).toBe(true);
    // The conversation is stamped before the meeting row: the order every booking locks them in.
    expect(mockTxSql.findIndex(s => /SET meeting_joined_b_at/.test(s)))
      .toBeLessThan(mockTxSql.findIndex(s => /UPDATE meetings SET joined_b_at/.test(s)));
    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), ['u-a'], ['user:u-a:meetings', 'meeting:mtg-1']);
    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), ['u-b'], ['user:u-b:meetings', 'meeting:mtg-1']);
  });

  it('joining again (a reconnect) stamps nothing new and tells nobody again', async () => {
    conv.current_meeting_id = 'mtg-1';
    meetingStamps.a = true;
    await getCallToken('conv-1', 'u-a', 'video');
    expect(mockEmitEntities.mock.calls.filter(c => (c[2] as string[]).includes('meeting:mtg-1'))).toEqual([]);
  });

  it('after calls unlock, a later meeting still records who attended it, on the meeting row only', async () => {
    conv.calls_unlocked_at = new Date();
    conv.current_meeting_id = 'mtg-2';
    await getCallToken('conv-1', 'u-a', 'video');
    expect(mockQuery.mock.calls.find(c => /UPDATE meetings SET joined_a_at/.test(c[0] as string))?.[1]).toEqual(['mtg-2']);
    expect(mockQuery.mock.calls.some(c => /SET meeting_joined/.test(c[0] as string))).toBe(false);
  });

  it('does not re-stamp the conversation once calls are already unlocked', async () => {
    conv.calls_unlocked_at = new Date();
    await getCallToken('conv-1', 'u-a', 'video');
    expect(mockQuery.mock.calls.some(c => /SET meeting_joined/.test(c[0] as string))).toBe(false);
  });

  // 26 Oct 2026 (H2a): the old server can leave the pointer at a row that no longer describes the
  // conversation's meeting (one already over when it booked the next, say); attendance is never
  // stamped on such a row.
  it('reads the conversation\'s meeting through the guard: the pointer counts only while its row is scheduled at the conversation\'s time', async () => {
    await getCallToken('conv-1', 'u-a', 'video');
    const read = mockQuery.mock.calls.map(c => String(c[0]).replace(/\s+/g, ' ')).find(s => /FROM dm_conversations WHERE id = \$1/.test(s))!;
    expect(read).toMatch(/\(SELECT m\.id FROM meetings m WHERE m\.id = dm_conversations\.current_meeting_id AND m\.status = 'scheduled' AND m\.start_at = dm_conversations\.meeting_start_at\) AS current_meeting_id/);
  });

  // ── An answered call stands as a meeting (1 Nov 2026) ─────────────────────
  it('reads the standing meeting from the meetings rows: the conversation\'s own scheduled one, or an answered call, inside start − 5 min … end + 30 min', async () => {
    conv.current_meeting_id = 'mtg-1';
    await getCallToken('conv-1', 'u-a', 'video');
    const [read] = calls(/AND \(source = 'instant' OR id = \$2\)/);
    expect(read[1]).toEqual(['conv-1', 'mtg-1']);
    const sql = flat(read[0]);
    expect(sql).toMatch(/FROM meetings WHERE conversation_id = \$1 AND status = 'scheduled'/);
    expect(sql).toMatch(/start_at - INTERVAL '5 minutes' <= NOW\(\)/);
    expect(sql).toMatch(/NOW\(\) <= start_at \+ \(duration_min \+ 30\) \* INTERVAL '1 minute'/);
    // The scheduled meeting wins when both stand: entering in its window is attending it.
    expect(sql).toMatch(/ORDER BY \(source = 'scheduled'\) DESC, start_at DESC LIMIT 1/);
  });

  it('a locked pair with an answered call standing gets a token, stamps the call\'s row and never the conversation or the unlock', async () => {
    conv.meeting_start_at = null;
    instantRow = { id: 'mtg-instant', source: 'instant' };
    // The token names the call's meeting, so leaving the room asks how it went (5 Nov 2026).
    await expect(getCallToken('conv-1', 'u-b', 'video'))
      .resolves.toMatchObject({ token: 'tok-123', roomName: 'dm-conv-1', meetingId: 'mtg-instant' });
    expect(calls(/UPDATE meetings SET joined_b_at/)[0][1]).toEqual(['mtg-instant']);
    expect(mockQuery.mock.calls.some(c => /SET meeting_joined|SET calls_unlocked_at/.test(c[0] as string))).toBe(false);
    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), ['u-b'], ['user:u-b:meetings', 'meeting:mtg-instant']);
  });

  it('a call answered while a scheduled meeting is hours away still stamps the call, and the meeting\'s early join is untouched', async () => {
    conv.meeting_start_at = new Date(NOW + 5 * 60 * 60 * 1000);
    conv.current_meeting_id = 'mtg-1';
    instantRow = { id: 'mtg-instant', source: 'instant' };
    await getCallToken('conv-1', 'u-a', 'video');
    expect(calls(/UPDATE meetings SET joined_a_at/).map(c => c[1])).toEqual([['mtg-instant']]);
    expect(mockQuery.mock.calls.some(c => /SET meeting_joined/.test(c[0] as string))).toBe(false);
  });
});

describe('partnerPresence (11 Nov 2026, RSN 07)', () => {
  it('is the other person\'s state: online, away, offline, or null when the read could not tell', async () => {
    for (const state of ['online', 'away', 'offline', null] as const) {
      mockPresenceState.mockResolvedValue(state);
      expect(await partnerPresence('conv-1', 'u-a')).toBe(state);
    }
    expect(mockPresenceState).toHaveBeenLastCalledWith('u-b');
  });
  it('is refused across a block, as a call is', async () => {
    mockAreBlocked.mockResolvedValue(true);
    await expect(partnerPresence('conv-1', 'u-a')).rejects.toMatchObject({ statusCode: 403 });
    expect(mockPresenceState).not.toHaveBeenCalled();
  });
  it('is refused to someone outside the conversation', async () => {
    await expect(partnerPresence('conv-1', 'u-stranger')).rejects.toMatchObject({ statusCode: 403 });
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
  // 1 Nov 2026: a video call needs a connection, not a held meeting.
  it('a connection can ring for VIDEO without ever having held a meeting', async () => {
    conv.calls_unlocked_at = null;
    conv.meeting_start_at = null;
    const rq = await requestCall('conv-1', 'u-a', 'video', 15);
    expect(rq).toMatchObject({ id: 'rq-1', fromUserId: 'u-a', toUserId: 'u-b', kind: 'video', durationMin: 15, status: 'pending' });
    expect(mockRequireConnection).toHaveBeenCalledWith('u-a', 'u-b');
    expect(mockEmit.mock.calls.map(c => c[0])).toContain('call:request');
  });

  it('AUDIO keeps the 9 Sep rule: refused until the first meeting has happened', async () => {
    conv.calls_unlocked_at = null;
    await expect(requestCall('conv-1', 'u-a', 'audio', 15)).rejects.toMatchObject({
      statusCode: 403, message: 'Calls unlock after your first scheduled meeting together.',
    });
    expect(mockQuery.mock.calls.some(c => /INSERT INTO call_requests/.test(c[0] as string))).toBe(false);
  });

  it.each([
    ['a non-connection', 'You can call the people you are connected with. Send a meeting request first.'],
    ['a removed or suspended person', 'This person is no longer a member of REASON, so they cannot be called.'],
  ])('refuses %s with the sentence the connection check gives, and rings nobody', async (_label, message) => {
    const { ForbiddenError } = jest.requireActual('../../../middleware/errors');
    mockRequireConnection.mockRejectedValue(new ForbiddenError(message));
    await expect(requestCall('conv-1', 'u-a', 'video', 15)).rejects.toMatchObject({ statusCode: 403, message });
    expect(mockQuery.mock.calls.some(c => /INSERT INTO call_requests|INSERT INTO notifications/.test(c[0] as string))).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('an unlocked pair ringing for audio is also checked: a removed partner is never rung', async () => {
    conv.calls_unlocked_at = new Date();
    const { ForbiddenError } = jest.requireActual('../../../middleware/errors');
    mockRequireMembers.mockRejectedValue(new ForbiddenError('This person is no longer a member of REASON, so they cannot be called.'));
    await expect(requestCall('conv-1', 'u-a', 'audio', 15)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // Fix round 1: audio keeps production's rule exactly: calls unlocked, and only the block and the two accounts
  // besides; it never asks for the video call's mutual connection.
  it('AUDIO for an unlocked pair asks only that both are members, never the video connection', async () => {
    conv.calls_unlocked_at = new Date();
    const { ForbiddenError } = jest.requireActual('../../../middleware/errors');
    mockRequireConnection.mockRejectedValue(new ForbiddenError('You can call the people you are connected with. Send a meeting request first.'));
    await expect(requestCall('conv-1', 'u-a', 'audio', 15)).resolves.toMatchObject({ kind: 'audio', status: 'pending' });
    expect(mockRequireMembers).toHaveBeenCalledWith('u-a', 'u-b');
    expect(mockRequireConnection).not.toHaveBeenCalled();
  });

  it('VIDEO asks the mutual connection, never the audio check', async () => {
    await requestCall('conv-1', 'u-a', 'video', 15);
    expect(mockRequireConnection).toHaveBeenCalledWith('u-a', 'u-b');
    expect(mockRequireMembers).not.toHaveBeenCalled();
  });

  // Fix round 1: a ring must not open messaging. Its line in the thread is a message, and one message is enough for
  // dm.service canMessage to let both people write freely (the grandfather rule). So the line is written only where
  // both may already message each other; otherwise the ring still rings, with its bell, and leaves no line.
  it('writes the "Requested a call" line only when both may already message each other', async () => {
    await requestCall('conv-1', 'u-a', 'video', 15);
    expect(mockCanMessage.mock.calls).toEqual(expect.arrayContaining([['u-a', 'u-b'], ['u-b', 'u-a']]));
    expect(mockSendBroadcast).toHaveBeenCalledWith('u-a', 'u-b', expect.stringMatching(/15-min video call/));
  });

  it.each([
    ['the caller may not message the callee', [{ allowed: false, reason: 'not_mutual' }, { allowed: true }]],
    ['the callee may not message the caller (an admin rings: only the admin may write)', [{ allowed: true }, { allowed: false, reason: 'not_mutual' }]],
  ])('writes no line in the thread when %s, and still rings with the bell', async (_label, answers) => {
    mockCanMessage.mockImplementation((from: unknown) => Promise.resolve(from === 'u-a' ? answers[0] : answers[1]));
    await requestCall('conv-1', 'u-a', 'video', 15);
    expect(mockSendBroadcast).not.toHaveBeenCalled();
    expect(mockBroadcastDm).not.toHaveBeenCalled();
    expect(mockEmit.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining(['call:request', 'notification:new']));
  });

  it('a blocked pair is refused before anything else, and no banner is ever sent to the blocked callee', async () => {
    mockAreBlocked.mockResolvedValue(true);
    await expect(requestCall('conv-1', 'u-a', 'video', 15)).rejects.toMatchObject({ statusCode: 403, message: 'You cannot call this member' });
    expect(mockRooms).toEqual([]);
    expect(mockQuery.mock.calls.some(c => /INSERT INTO call_requests/.test(c[0] as string))).toBe(false);
  });

  it('an offline callee is a 409 with exactly the plan\'s sentence, and no ring and no bell', async () => {
    mockPresenceState.mockResolvedValue('offline');
    await expect(requestCall('conv-1', 'u-a', 'video', 15)).rejects.toMatchObject({
      statusCode: 409, code: 'CALL_PARTNER_OFFLINE', message: "Bo Brandt isn't online right now. Send a message instead.",
      // 11 Nov 2026: named, so the screen can offer Try again, Find a time and Send a message.
      details: { partnerName: 'Bo Brandt' },
    });
    expect(mockQuery.mock.calls.some(c => /INSERT INTO call_requests|INSERT INTO notifications/.test(c[0] as string))).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // 11 Nov 2026 (RSN 07): only "offline" is refused. Someone away still gets the banner and the bell, and a read that
  // could not tell lets the ring go rather than say offline wrongly.
  it.each(['away', null] as const)('a callee who is %s is rung', async (state) => {
    mockPresenceState.mockResolvedValue(state);
    const rq = await requestCall('conv-1', 'u-a', 'video', 15);
    expect(rq).toMatchObject({ status: 'pending', toUserId: 'u-b' });
    expect(mockEmit.mock.calls.map(c => c[0])).toContain('call:request');
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

  it('tells both people\'s screens: the conversation and each one\'s own calls', async () => {
    await requestCall('conv-1', 'u-a', 'video', 15);
    for (const id of ['u-a', 'u-b']) expect(tagsSentTo(id)).toEqual(expect.arrayContaining(['dm-conversation:conv-1', `user:${id}:calls`]));
  });

  it('clamps an out-of-range duration rather than rejecting it', async () => {
    conv.calls_unlocked_at = new Date();
    const rq = await requestCall('conv-1', 'u-a', 'video', 2);
    expect(rq.durationMin).toBe(5);
  });

  it('a second ring while one waits, from either side, is a 409 the client can tell apart', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [conv] });
      if (/INSERT INTO call_requests/.test(sql)) return Promise.reject(Object.assign(new Error('dup'), { code: '23505' }));
      return Promise.resolve({ rows: [] });
    });
    await expect(requestCall('conv-1', 'u-b', 'video', 15)).rejects.toMatchObject({
      statusCode: 409, code: 'CALL_ALREADY_WAITING', message: 'A call request is already waiting for an answer.',
    });
  });
});

describe('acceptCallRequest', () => {
  beforeEach(async () => { conv.calls_unlocked_at = new Date(); await requestCall('conv-1', 'u-a', 'video', 15); mockEmit.mockClear(); mockRooms.length = 0; mockEmitEntities.mockClear(); });

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
  it('an expired request cannot be accepted and is marked expired, and both screens are told', async () => {
    request.created_at = new Date(Date.now() - CALL_REQUEST_TTL_MS - 1000);
    await expect(acceptCallRequest('rq-1', 'u-b')).rejects.toMatchObject({ statusCode: 409 });
    expect(mockQuery.mock.calls.some(c => /SET status = 'expired'/.test(c[0] as string))).toBe(true);
    expect(insertedMeeting).toBeNull();
    for (const id of ['u-a', 'u-b']) expect(tagsSentTo(id)).toContain('dm-conversation:conv-1');
  });
  it('an already-answered request cannot be accepted again', async () => {
    request.status = 'declined';
    await expect(acceptCallRequest('rq-1', 'u-b')).rejects.toMatchObject({ statusCode: 409 });
    expect(insertedMeeting).toBeNull();
  });

  // ── An answered call is a meeting (1 Nov 2026) ─────────────────────────────
  it('writes ONE meetings row, source instant, starting now, already reminded, booked by the caller, in the same transaction as the claim', async () => {
    await acceptCallRequest('rq-1', 'u-b');
    const claim = mockTxSql.findIndex(s => /UPDATE call_requests SET status = 'accepted'/.test(s));
    const insert = mockTxSql.findIndex(s => /INSERT INTO meetings/.test(s));
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(claim);
    expect(flat(mockTxSql[claim])).toMatch(/WHERE id = \$1 AND status = 'pending' RETURNING id/);
    const sql = flat(mockTxSql[insert]);
    expect(sql).toMatch(/\(conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, source, confirmed_by, reminder_sent_at\)/);
    expect(sql).toMatch(/VALUES \(\$1, \$2, \$3, NOW\(\), \$4, \$5, 'instant', \$6, NOW\(\)\)/);
    expect(insertedMeeting).toEqual(['conv-1', 'u-a', 'u-b', 15, 'video', 'u-a']);
    expect(calls(/INSERT INTO meetings/)).toHaveLength(1);
  });

  it('never touches the conversation\'s meeting columns, its pointer or the unlock', async () => {
    conv.calls_unlocked_at = null;
    conv.meeting_start_at = null;
    await acceptCallRequest('rq-1', 'u-b');
    expect(mockQuery.mock.calls.some(c => /UPDATE dm_conversations/.test(c[0] as string))).toBe(false);
  });

  it('a locked pair\'s answered video call lets the callee straight into the room, attended on the call\'s row', async () => {
    conv.calls_unlocked_at = null;
    conv.meeting_start_at = null;
    await expect(acceptCallRequest('rq-1', 'u-b')).resolves.toMatchObject({ token: 'tok-123', conversationId: 'conv-1' });
    expect(calls(/UPDATE meetings SET joined_b_at/)[0][1]).toEqual(['mtg-instant']);
  });

  it('a second accept (another device, a double press) writes nothing and says what happened', async () => {
    await acceptCallRequest('rq-1', 'u-b');
    request.status = 'pending'; // read as still pending, but the claim finds it taken
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM call_requests WHERE id/.test(sql)) return Promise.resolve({ rows: [{ ...request, status: /SET status/.test(sql) ? 'accepted' : request.status }] });
      if (/SET status = 'accepted'/.test(sql)) { request.status = 'accepted'; return Promise.resolve({ rows: [] }); }
      if (/FROM dm_conversations WHERE id/.test(sql)) return Promise.resolve({ rows: [conv] });
      return Promise.resolve({ rows: [] });
    });
    insertedMeeting = null;
    await expect(acceptCallRequest('rq-1', 'u-b')).rejects.toMatchObject({ statusCode: 409, message: 'This call request was accepted.' });
    expect(insertedMeeting).toBeNull();
  });

  it('tells the caller, closes the banner on the callee\'s other devices, and redraws both people\'s screens and meetings', async () => {
    await acceptCallRequest('rq-1', 'u-b');
    expect(mockRooms).toEqual(expect.arrayContaining([
      { room: 'user:u-a', event: 'call:accepted', payload: expect.objectContaining({ requestId: 'rq-1' }) },
      { room: 'user:u-b', event: 'call:cancelled', payload: { requestId: 'rq-1', conversationId: 'conv-1' } },
    ]));
    for (const id of ['u-a', 'u-b']) {
      expect(tagsSentTo(id)).toEqual(expect.arrayContaining(['dm-conversation:conv-1', `user:${id}:calls`, `user:${id}:meetings`, 'meeting:mtg-instant']));
    }
  });

  it('is refused once the two are no longer connected (blocked or removed since it rang), writing nothing', async () => {
    const { ForbiddenError } = jest.requireActual('../../../middleware/errors');
    mockRequireConnection.mockRejectedValue(new ForbiddenError('This person is no longer a member of REASON, so they cannot be called.'));
    await expect(acceptCallRequest('rq-1', 'u-b')).rejects.toMatchObject({ statusCode: 403 });
    expect(insertedMeeting).toBeNull();
    expect(mockRooms.some(r => r.event === 'call:accepted')).toBe(false);
  });
});

describe('declineCallRequest / cancelCallRequest', () => {
  beforeEach(async () => { conv.calls_unlocked_at = new Date(); await requestCall('conv-1', 'u-a', 'video', 15); mockEmit.mockClear(); mockRooms.length = 0; mockEmitEntities.mockClear(); });

  it('the callee declining tells the caller who declined', async () => {
    await declineCallRequest('rq-1', 'u-b');
    expect(mockQuery.mock.calls.some(c => /SET status = 'declined'/.test(c[0] as string))).toBe(true);
    const ev = mockEmit.mock.calls.find(c => c[0] === 'call:declined')!;
    expect(ev[1]).toMatchObject({ requestId: 'rq-1', conversationId: 'conv-1', byName: 'Ana' });
  });
  it('a decline closes the banner on the callee\'s other devices and redraws both screens, writing no meeting', async () => {
    await declineCallRequest('rq-1', 'u-b');
    expect(mockRooms).toEqual(expect.arrayContaining([
      { room: 'user:u-a', event: 'call:declined', payload: expect.objectContaining({ requestId: 'rq-1' }) },
      { room: 'user:u-b', event: 'call:cancelled', payload: { requestId: 'rq-1', conversationId: 'conv-1' } },
    ]));
    for (const id of ['u-a', 'u-b']) expect(tagsSentTo(id)).toEqual(expect.arrayContaining(['dm-conversation:conv-1', `user:${id}:calls`]));
    expect(insertedMeeting).toBeNull();
  });
  it('only the callee can decline', async () => {
    await expect(declineCallRequest('rq-1', 'u-a')).rejects.toMatchObject({ statusCode: 403 });
  });
  it('the caller cancelling tells the callee, and redraws both screens', async () => {
    await cancelCallRequest('rq-1', 'u-a');
    expect(mockQuery.mock.calls.some(c => /SET status = 'cancelled'/.test(c[0] as string))).toBe(true);
    expect(mockRooms).toEqual(expect.arrayContaining([{ room: 'user:u-b', event: 'call:cancelled', payload: { requestId: 'rq-1', conversationId: 'conv-1' } }]));
    for (const id of ['u-a', 'u-b']) expect(tagsSentTo(id)).toContain('dm-conversation:conv-1');
  });
  it('only the caller can cancel', async () => {
    await expect(cancelCallRequest('rq-1', 'u-b')).rejects.toMatchObject({ statusCode: 403 });
  });

  // Fix round 1: decline and cancel are claims, like the accept. Each changes the request only while it still waits
  // (AND status = 'pending' RETURNING id) and tells people only when it did.
  it('both are claims on a request still waiting', async () => {
    await cancelCallRequest('rq-1', 'u-a');
    expect(flat(calls(/SET status = 'cancelled'/)[0][0])).toMatch(/WHERE id = \$1 AND status = 'pending' RETURNING id/);
    request.status = 'pending';
    await declineCallRequest('rq-1', 'u-b');
    expect(flat(calls(/SET status = 'declined'/)[0][0])).toMatch(/WHERE id = \$1 AND status = 'pending' RETURNING id/);
  });

  it('a cancel answers what happened: cancelled, with the conversation and kind', async () => {
    await expect(cancelCallRequest('rq-1', 'u-a')).resolves.toEqual({ status: 'cancelled', conversationId: 'conv-1', kind: 'video' });
  });

  /** The answer lands between the read and the claim: the read saw it waiting, the claim finds it taken. */
  function acceptLandsDuringClaim(answer: 'cancelled' | 'declined') {
    const base = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      if (new RegExp(`SET status = '${answer}'`).test(sql)) {
        request.status = 'accepted'; // the accept committed first
        return Promise.resolve({ rows: [] });
      }
      return base(sql, params);
    });
  }

  it('a cancel that lost to an accept changes nothing, tells nobody, and answers accepted so the caller goes into the room', async () => {
    acceptLandsDuringClaim('cancelled');
    await expect(cancelCallRequest('rq-1', 'u-a')).resolves.toEqual({ status: 'accepted', conversationId: 'conv-1', kind: 'video' });
    expect(request.status).toBe('accepted');
    expect(mockRooms).toEqual([]);
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('a decline from the callee\'s other tab that lost to an accept changes nothing and tells nobody', async () => {
    acceptLandsDuringClaim('declined');
    await declineCallRequest('rq-1', 'u-b');
    expect(request.status).toBe('accepted');
    expect(mockRooms.some(r => r.event === 'call:declined' || r.event === 'call:cancelled')).toBe(false);
    expect(mockEmitEntities).not.toHaveBeenCalled();
  });

  it('a cancel of a request already answered answers its status and repeats nothing', async () => {
    request.status = 'declined';
    await expect(cancelCallRequest('rq-1', 'u-a')).resolves.toMatchObject({ status: 'declined' });
    expect(mockRooms).toEqual([]);
  });
});

describe('the live request, wherever the app is opened (incoming and outgoing)', () => {
  const live = (over: Record<string, unknown> = {}) => ({
    id: 'rq-9', conversation_id: 'conv-9', from_user_id: 'u-a', to_user_id: 'u-b', kind: 'video', duration_min: 15,
    created_at: new Date('2026-11-01T10:00:00Z'), partner_name: 'Ana Arendt', ...over,
  });

  it('incoming: the newest unanswered, unexpired request to me, from a member who is not blocked either way, with their name', async () => {
    liveRows = [live()];
    await expect(getIncomingCallRequest('u-b')).resolves.toEqual({
      id: 'rq-9', conversationId: 'conv-9', fromUserId: 'u-a', toUserId: 'u-b', partnerName: 'Ana Arendt', kind: 'video',
      durationMin: 15, createdAt: '2026-11-01T10:00:00.000Z', expiresAt: '2026-11-01T10:02:00.000Z',
    });
    const [sql, params] = calls(/FROM call_requests r/)[0];
    expect(params).toEqual(['u-b']);
    const text = flat(sql);
    expect(text).toMatch(/JOIN users p ON p\.id = r\.from_user_id/);
    expect(text).toMatch(/WHERE r\.to_user_id = \$1 AND r\.status = 'pending' AND r\.created_at >= NOW\(\) - INTERVAL '2 minutes'/);
    expect(text).toMatch(/AND p\.status = 'active'/);
    expect(text).toMatch(/NOT EXISTS \(SELECT 1 FROM user_blocks b/);
    expect(text).toMatch(/ORDER BY r\.created_at DESC LIMIT 1/);
  });

  it('outgoing: my own unanswered request, named after the person I rang', async () => {
    liveRows = [live({ partner_name: 'Bo Brandt' })];
    await expect(getOutgoingCallRequest('u-a')).resolves.toMatchObject({ id: 'rq-9', partnerName: 'Bo Brandt', toUserId: 'u-b' });
    const text = flat(calls(/FROM call_requests r/)[0][0]);
    expect(text).toMatch(/JOIN users p ON p\.id = r\.to_user_id/);
    expect(text).toMatch(/WHERE r\.from_user_id = \$1 AND r\.status = 'pending'/);
  });

  it('none is null, and a member with no name reads as Member', async () => {
    await expect(getIncomingCallRequest('u-b')).resolves.toBeNull();
    liveRows = [live({ partner_name: '  ' })];
    await expect(getIncomingCallRequest('u-b')).resolves.toMatchObject({ partnerName: 'Member' });
  });
});

describe('requestCallToUser (the profile rings a person, not a conversation)', () => {
  it('checks the connection FIRST, then finds or makes the pair\'s conversation, then rings a video call there', async () => {
    const rq = await requestCallToUser('u-a', 'u-b', 30);
    expect(mockOrder.slice(0, 2)).toEqual(['connection', 'conversation']);
    expect(mockFindOrCreate).toHaveBeenCalledWith('u-a', 'u-b');
    expect(rq).toMatchObject({ conversationId: 'conv-1', fromUserId: 'u-a', toUserId: 'u-b', kind: 'video', durationMin: 30 });
    expect(mockRooms.find(r => r.event === 'call:request')).toMatchObject({ room: 'user:u-b' });
  });

  it('a non-connection never gets a conversation made (that would make them a connection), and nobody is rung', async () => {
    const { ForbiddenError } = jest.requireActual('../../../middleware/errors');
    mockRequireConnection.mockRejectedValue(new ForbiddenError('You can call the people you are connected with. Send a meeting request first.'));
    await expect(requestCallToUser('u-a', 'u-x', 30)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockFindOrCreate).not.toHaveBeenCalled();
    expect(mockRooms).toEqual([]);
  });

  it('an offline connection is told the plan\'s sentence', async () => {
    mockPresenceState.mockResolvedValue('offline');
    await expect(requestCallToUser('u-a', 'u-b', 15)).rejects.toMatchObject({
      statusCode: 409, message: "Bo Brandt isn't online right now. Send a message instead.",
    });
  });
});

// 11 Nov 2026 (Shirley Palmer's item 16; fix round 1, the controller's ruling): a block in the middle of a call ends it
// for BOTH sides, and a token minted before the block can never reach the pair again.
describe('endCallsOnBlock', () => {
  // The close right away only; the later closes (CLOSE_AGAIN_AFTER_MS) have their own test below.
  const NOW_ONLY = { closeAgainAfterMs: [] as number[] };
  const armBlock = (opts: { conversation: boolean; ringing: boolean; epoch?: number }) => {
    mockQuery.mockImplementation((sql: string) => {
      const q = String(sql).replace(/\s+/g, ' ');
      if (/UPDATE dm_conversations SET call_room_epoch = call_room_epoch \+ 1/.test(q)) {
        return Promise.resolve({ rows: opts.conversation ? [{ id: 'conv-1', call_room_epoch: opts.epoch ?? 1 }] : [] });
      }
      if (/UPDATE call_requests SET status = 'cancelled'/.test(q)) {
        return Promise.resolve({ rows: opts.ringing ? [{ id: 'rq-9', conversation_id: 'conv-1', from_user_id: 'u-b', to_user_id: 'u-a', kind: 'video', duration_min: 15, status: 'cancelled', created_at: new Date() }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  };

  it('moves the pair to a new call room and CLOSES the old one, so both are put out and an old token reaches nobody', async () => {
    armBlock({ conversation: true, ringing: false, epoch: 1 });
    await endCallsOnBlock('u-a', 'u-b', NOW_ONLY);
    const move = mockQuery.mock.calls.find(c => /SET call_room_epoch = call_room_epoch \+ 1/.test(String(c[0])))!;
    expect(String(move[0]).replace(/\s+/g, ' ')).toContain('WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid) RETURNING id, call_room_epoch');
    expect(move[1]).toEqual(['u-a', 'u-b']);
    expect(mockCloseRoom).toHaveBeenCalledWith('dm-conv-1');
    expect(mockRemoveParticipant).not.toHaveBeenCalled();
  });

  it('a second block (epoch 2) closes the room the pair had moved to (dm-<id>-1)', async () => {
    armBlock({ conversation: true, ringing: false, epoch: 2 });
    await endCallsOnBlock('u-b', 'u-a', NOW_ONLY);
    expect(mockCloseRoom).toHaveBeenCalledWith('dm-conv-1-1');
  });

  it('withdraws a call still ringing between the two, closes the callee\'s banner and tells both', async () => {
    armBlock({ conversation: true, ringing: true });
    await endCallsOnBlock('u-a', 'u-b', NOW_ONLY);
    const withdraw = mockQuery.mock.calls.find(c => /UPDATE call_requests SET status = 'cancelled'/.test(String(c[0])))!;
    expect(String(withdraw[0])).toMatch(/WHERE conversation_id = \$1 AND status = 'pending'/);
    expect(withdraw[1]).toEqual(['conv-1']);
    expect(mockRooms).toContainEqual({ room: 'user:u-a', event: 'call:cancelled', payload: { requestId: 'rq-9', conversationId: 'conv-1' } });
    expect(tagsSentTo('u-a')).toEqual(expect.arrayContaining(['user:u-a:calls', 'dm-conversation:conv-1']));
    expect(tagsSentTo('u-b')).toEqual(expect.arrayContaining(['user:u-b:calls', 'dm-conversation:conv-1']));
  });

  it('with nothing ringing tells nobody, and still closes the room', async () => {
    armBlock({ conversation: true, ringing: false });
    await endCallsOnBlock('u-a', 'u-b', NOW_ONLY);
    expect(mockRooms).toEqual([]);
    expect(mockEmitEntities).not.toHaveBeenCalled();
    expect(mockCloseRoom).toHaveBeenCalledTimes(1);
  });

  it('LiveKit refusing the close never fails the block', async () => {
    armBlock({ conversation: true, ringing: false });
    mockCloseRoom.mockRejectedValue(new Error('livekit down'));
    await expect(endCallsOnBlock('u-a', 'u-b', NOW_ONLY)).resolves.toBeUndefined();
  });

  // S5 fix 6 (12 Nov 2026): on production LiveKit answered "room not found" for a room started half a second before the
  // block (read as already closed), and both stayed in the call. The old room is closed again a little later.
  it('closes the old room again later, a failed close included, and only the old room', async () => {
    armBlock({ conversation: true, ringing: false, epoch: 2 });
    mockCloseRoom.mockRejectedValueOnce(new Error('livekit down'));
    await endCallsOnBlock('u-a', 'u-b', { closeAgainAfterMs: [0, 0] });
    expect(mockCloseRoom.mock.calls).toEqual([['dm-conv-1-1'], ['dm-conv-1-1'], ['dm-conv-1-1']]);
    expect(CLOSE_AGAIN_AFTER_MS).toEqual([2_000, 6_000]);
  });

  it('a pair with no conversation has nothing to end', async () => {
    armBlock({ conversation: false, ringing: true });
    await endCallsOnBlock('u-a', 'u-b', NOW_ONLY);
    expect(mockQuery.mock.calls.some(c => /UPDATE call_requests/.test(String(c[0])))).toBe(false);
    expect(mockCloseRoom).not.toHaveBeenCalled();
  });

  it('after a block the pair\'s tokens are minted for the NEW room', async () => {
    (conv as Record<string, unknown>).call_room_epoch = 1;
    conv.calls_unlocked_at = new Date();
    const t = await getCallToken('conv-1', 'u-a', 'video');
    expect(t.roomName).toBe('dm-conv-1-1');
    expect(mockIssue.mock.calls[0][1]).toBe('dm-conv-1-1');
  });
});
