// ─── The live chat handlers on a kept chat (26 Oct 2026) ─────────────────────
//
// Every message is stored before anyone receives it (lobby, room and sender-only), a store that fails or an
// event that has ended sends nothing to anyone, a member sends at most 10 messages in 10 seconds, a retried
// clientId is stored and sent once, blocked people are skipped, and the chat history is read from the
// database only by people allowed to read it (closing X3: any signed-in socket could read any live event's
// lobby chat by id).
//
// The event-chat service is replaced at its boundary (its rules are tested in
// services/event-chat/event-chat.service.test.ts); its real limiter, constants and helpers stay. A timeline
// records the store and every emit, so "stored first" is checked by order.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));
const mockGetSessionById = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  __esModule: true,
}));
const mockReadCanonical = jest.fn();
jest.mock('../../../services/orchestration/state/canonical-state', () => ({
  readCanonical: (...args: unknown[]) => mockReadCanonical(...args),
  __esModule: true,
}));

const timeline: string[] = [];
const mockPersist = jest.fn();
const mockCanRead = jest.fn();
const mockHistory = jest.fn();
const mockToggle = jest.fn();
const mockBlocked = jest.fn();
jest.mock('../../../services/event-chat/event-chat.service', () => {
  const actual = jest.requireActual('../../../services/event-chat/event-chat.service');
  return {
    ...actual,
    persistEventChatMessage: (...a: unknown[]) => { timeline.push('persist'); return mockPersist(...a); },
    canReadEventChat: (...a: unknown[]) => mockCanRead(...a),
    listLiveChatHistory: (...a: unknown[]) => mockHistory(...a),
    toggleEventChatReaction: (...a: unknown[]) => mockToggle(...a),
    chatBlockedUserIds: (...a: unknown[]) => mockBlocked(...a),
    __esModule: true,
  };
});

import { SessionStatus, ErrorCodes } from '@rsn/shared';
import { AppError } from '../../../middleware/errors';
import { activeSessions, sessionRoom } from '../../../services/orchestration/state/session-state';
import {
  handleChatSend, handleChatRequestHistory, handleChatReact, sendJoinChatHistory,
} from '../../../services/orchestration/handlers/chat-handlers';

const EVENT = '11111111-1111-4111-8111-111111111111';
const MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const HOST = 'u-host';
const CLOSED = 'This event has ended, so its chat is closed.';
const FORBIDDEN = 'Only people who took part in this event can read its chat.';

type Sent = { to: string; event: string; payload: any };
let sent: Sent[] = [];

function socketFor(userId: string, opts: { inRoom?: boolean; role?: string } = {}) {
  const socket = {
    id: `socket-${userId}`,
    data: { userId, role: opts.role ?? 'member', displayName: `Name ${userId}` },
    rooms: new Set(opts.inRoom === false ? [] : [sessionRoom(EVENT)]),
    emit: jest.fn((event: string, payload: unknown) => {
      timeline.push(`emit:${event}`);
      sent.push({ to: `socket:${userId}`, event, payload });
    }),
  };
  return socket as any;
}

/** The socket server: io.to(room).emit and the sockets in the event's room (each a member). */
function ioWith(roomMembers: string[] = []) {
  return {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        timeline.push(`emit:${event}`);
        sent.push({ to: room, event, payload });
      },
    }),
    in: () => ({
      fetchSockets: async () => roomMembers.map((uid) => ({
        data: { userId: uid },
        emit: (event: string, payload: unknown) => {
          timeline.push(`emit:${event}`);
          sent.push({ to: `socket:${uid}`, event, payload });
        },
      })),
    }),
  } as any;
}

function liveEvent(over: Record<string, unknown> = {}) {
  activeSessions.set(EVENT, {
    sessionId: EVENT, hostUserId: HOST, config: {} as any, currentRound: 1, status: SessionStatus.ROUND_ACTIVE,
    timer: null, timerSyncInterval: null, timerEndsAt: null, isPaused: false, pausedTimeRemaining: null,
    presenceMap: new Map([[HOST, { lastHeartbeat: new Date(), socketId: 'socket-u-host' }]]),
    pendingRoundNumber: null, manuallyLeftRound: new Set(), ...over,
  } as any);
}

/** What persistEventChatMessage would return for a stored message. */
function storedAs(input: any, id = MSG) {
  return {
    created: true,
    message: {
      id, userId: input.senderId, displayName: input.senderName, message: input.content,
      timestamp: '2026-10-25T11:52:00.000Z', scope: input.scope, isHost: input.senderIsHost,
      ...(input.roomId ? { roomId: input.roomId } : {}), reactions: {},
    },
  };
}

/** The database the handler itself asks: co-hosts, who is in a breakout, the matches fallback. */
function armDatabase(opts: { inBreakout?: string[]; fallbackMatch?: Record<string, unknown> | null } = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/unnest\(ARRAY\[participant_a_id/.test(sql)) return { rows: (opts.inBreakout ?? []).map((pid) => ({ pid })) };
    if (/FROM matches/.test(sql) && opts.fallbackMatch) return { rows: [opts.fallbackMatch] };
    return { rows: [] };
  });
}

const chatMessages = () => sent.filter((s) => s.event === 'chat:message');
const errors = () => sent.filter((s) => s.event === 'error');
const firstEmitAfterPersist = () => {
  const p = timeline.indexOf('persist');
  const e = timeline.findIndex((t) => t === 'emit:chat:message');
  return { p, e };
};

let nextUser = 0;
/** A member of their own, so no test uses up another's send allowance. */
const freshUser = () => `u-member-${++nextUser}`;

beforeEach(() => {
  jest.clearAllMocks();
  timeline.length = 0;
  sent = [];
  activeSessions.clear();
  mockGetSessionById.mockResolvedValue({ id: EVENT, hostUserId: HOST, status: 'round_active' });
  mockReadCanonical.mockResolvedValue(null);
  mockBlocked.mockResolvedValue(new Set());
  mockPersist.mockImplementation(async (input: any) => storedAs(input));
  armDatabase();
});

afterEach(() => activeSessions.clear());

// ── Sending ──────────────────────────────────────────────────────────────────

describe('handleChatSend: stored first, then sent', () => {
  it('lobby: stores the message, then sends the stored message to everyone in the main room', async () => {
    liveEvent();
    const me = freshUser();
    armDatabase({ inBreakout: ['u-in-room'] });
    await handleChatSend(ioWith([me, HOST, 'u-in-room', 'u-other']), socketFor(me), { sessionId: EVENT, message: '  Hello all  ', scope: 'lobby' });

    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist.mock.calls[0][0]).toEqual({
      sessionId: EVENT, senderId: me, senderName: `Name ${me}`, senderIsHost: false, scope: 'lobby',
      content: 'Hello all', clientId: null,
    });
    const { p, e } = firstEmitAfterPersist();
    expect(p).toBeGreaterThanOrEqual(0);
    expect(e).toBeGreaterThan(p);
    expect(chatMessages().map((s) => s.to).sort()).toEqual([`socket:${HOST}`, `socket:${me}`, 'socket:u-other'].sort());
    for (const s of chatMessages()) expect(s.payload).toMatchObject({ id: MSG, message: 'Hello all', scope: 'lobby' });
  });

  it('room: stores who it reached (the room, less anyone blocked), then sends it to exactly them', async () => {
    const me = freshUser();
    liveEvent({
      roomParticipants: new Map([
        [me, { matchId: 'm-7', roomId: 'room-7', joinedAt: new Date() }],
        ['u-roommate', { matchId: 'm-7', roomId: 'room-7', joinedAt: new Date() }],
        ['u-blocked', { matchId: 'm-7', roomId: 'room-7', joinedAt: new Date() }],
        ['u-elsewhere', { matchId: 'm-8', roomId: 'room-8', joinedAt: new Date() }],
      ]),
    });
    mockBlocked.mockResolvedValue(new Set(['u-blocked']));
    await handleChatSend(ioWith(), socketFor(me), { sessionId: EVENT, message: 'Just us', scope: 'room' });

    const stored = mockPersist.mock.calls[0][0];
    expect(stored).toMatchObject({ scope: 'room', roomId: 'room-7', matchId: 'm-7' });
    expect([...stored.audienceIds].sort()).toEqual([me, 'u-roommate'].sort());
    const { p, e } = firstEmitAfterPersist();
    expect(e).toBeGreaterThan(p);
    expect(chatMessages().map((s) => s.to).sort()).toEqual([`user:${me}`, 'user:u-roommate'].sort());
    expect(chatMessages()[0].payload).toMatchObject({ id: MSG, roomId: 'room-7' });
  });

  it('room: the matches fallback is still asked after the in-memory rooms, and its match is stored', async () => {
    const me = freshUser();
    liveEvent();
    armDatabase({ fallbackMatch: { id: 'm-9', participant_a_id: me, participant_b_id: 'u-partner', participant_c_id: null, room_id: 'room-9' } });
    await handleChatSend(ioWith(), socketFor(me), { sessionId: EVENT, message: 'Hi partner', scope: 'room' });
    expect(mockPersist.mock.calls[0][0]).toMatchObject({ roomId: 'room-9', matchId: 'm-9' });
    expect(chatMessages().map((s) => s.to).sort()).toEqual([`user:${me}`, 'user:u-partner'].sort());
  });

  it('sender-only: in no room the server tracks, the message is stored for the sender and shown to them alone', async () => {
    const me = freshUser();
    liveEvent();
    await handleChatSend(ioWith([me, 'u-other']), socketFor(me), { sessionId: EVENT, message: 'Anyone?', scope: 'room' });
    expect(mockPersist.mock.calls[0][0]).toMatchObject({ scope: 'room', audienceIds: [me] });
    expect(mockPersist.mock.calls[0][0].roomId).toBeUndefined();
    const { p, e } = firstEmitAfterPersist();
    expect(e).toBeGreaterThan(p);
    expect(chatMessages()).toEqual([{ to: `socket:${me}`, event: 'chat:message', payload: expect.objectContaining({ id: MSG }) }]);
  });

  it('lobby: people blocked either way are skipped', async () => {
    const me = freshUser();
    liveEvent();
    mockBlocked.mockResolvedValue(new Set(['u-blocked']));
    await handleChatSend(ioWith([me, HOST, 'u-blocked']), socketFor(me), { sessionId: EVENT, message: 'Hi', scope: 'lobby' });
    expect(chatMessages().map((s) => s.to).sort()).toEqual([`socket:${HOST}`, `socket:${me}`].sort());
  });

  it('a store that fails sends nothing to anyone and tells the sender, in words', async () => {
    const me = freshUser();
    liveEvent();
    mockPersist.mockRejectedValueOnce(new Error('connection terminated'));
    const socket = socketFor(me);
    await handleChatSend(ioWith([me, HOST]), socket, { sessionId: EVENT, message: 'Lost?', scope: 'lobby' });
    expect(chatMessages()).toHaveLength(0);
    expect(errors()).toEqual([{ to: `socket:${me}`, event: 'error', payload: { code: 'CHAT_FAILED', message: 'Your message could not be sent. Try again.' } }]);
  });

  it('a room store that fails sends nothing either', async () => {
    const me = freshUser();
    liveEvent({ roomParticipants: new Map([[me, { matchId: 'm-7', roomId: 'room-7', joinedAt: new Date() }]]) });
    mockPersist.mockRejectedValueOnce(new Error('connection terminated'));
    await handleChatSend(ioWith(), socketFor(me), { sessionId: EVENT, message: 'Lost?', scope: 'room' });
    expect(chatMessages()).toHaveLength(0);
    expect(errors()[0].payload.code).toBe('CHAT_FAILED');
  });

  it('a send after the event has ended is refused and sends nothing (found when storing)', async () => {
    const me = freshUser();
    liveEvent();
    mockPersist.mockRejectedValueOnce(new AppError(409, ErrorCodes.EVENT_ENDED, CLOSED));
    await handleChatSend(ioWith([me, HOST]), socketFor(me), { sessionId: EVENT, message: 'Too late', scope: 'lobby' });
    expect(chatMessages()).toHaveLength(0);
    expect(errors()[0].payload).toEqual({ code: ErrorCodes.EVENT_ENDED, message: CLOSED });
  });

  it('a send to an event already completed is refused before anything is resolved or stored', async () => {
    const me = freshUser();
    mockGetSessionById.mockResolvedValue({ id: EVENT, hostUserId: HOST, status: 'completed' });
    await handleChatSend(ioWith([me]), socketFor(me), { sessionId: EVENT, message: 'Too late', scope: 'lobby' });
    expect(mockPersist).not.toHaveBeenCalled();
    expect(chatMessages()).toHaveLength(0);
    expect(errors()[0].payload).toEqual({ code: ErrorCodes.EVENT_ENDED, message: CLOSED });
  });

  it('the 11th message in 10 seconds is refused, in words, and not stored', async () => {
    const me = freshUser();
    liveEvent();
    const socket = socketFor(me);
    for (let i = 0; i < 10; i++) {
      await handleChatSend(ioWith([me]), socket, { sessionId: EVENT, message: `m${i}`, scope: 'lobby' });
    }
    expect(mockPersist).toHaveBeenCalledTimes(10);
    expect(errors()).toHaveLength(0);
    await handleChatSend(ioWith([me]), socket, { sessionId: EVENT, message: 'm10', scope: 'lobby' });
    expect(mockPersist).toHaveBeenCalledTimes(10);
    expect(errors()).toEqual([{
      to: `socket:${me}`, event: 'error',
      payload: { code: ErrorCodes.RATE_LIMIT_EXCEEDED, message: 'You are sending messages too quickly. Wait a few seconds, then try again.' },
    }]);
    // Another member is not slowed down by them.
    const other = freshUser();
    await handleChatSend(ioWith([other]), socketFor(other), { sessionId: EVENT, message: 'hi', scope: 'lobby' });
    expect(mockPersist).toHaveBeenCalledTimes(11);
  });

  it('a socket not in the event is refused and nothing is stored', async () => {
    const me = freshUser();
    liveEvent();
    await handleChatSend(ioWith(), socketFor(me, { inRoom: false }), { sessionId: EVENT, message: 'Hi', scope: 'lobby' });
    expect(mockPersist).not.toHaveBeenCalled();
    expect(errors()[0].payload).toEqual({ code: 'NOT_IN_SESSION', message: 'You are not in this event.' });
  });

  it('the lobby still waits for the host: a guest\'s message before the host arrives is refused, not stored', async () => {
    const me = freshUser();
    liveEvent({ presenceMap: new Map() });
    await handleChatSend(ioWith([me]), socketFor(me), { sessionId: EVENT, message: 'Hello?', scope: 'lobby' });
    expect(mockPersist).not.toHaveBeenCalled();
    expect(errors()[0].payload.code).toBe('CHAT_DISABLED');
  });

  it('an empty message is ignored: nothing stored, no error for production\'s client to show', async () => {
    const me = freshUser();
    liveEvent();
    await handleChatSend(ioWith([me]), socketFor(me), { sessionId: EVENT, message: '   ', scope: 'lobby' });
    expect(mockPersist).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe('handleChatSend: clientId and the acknowledgement', () => {
  it('passes the clientId to the store and answers the acknowledgement with the stored id', async () => {
    const me = freshUser();
    liveEvent();
    const ack = jest.fn();
    await handleChatSend(ioWith([me]), socketFor(me), { sessionId: EVENT, message: 'Hi', scope: 'lobby', clientId: KEY }, ack);
    expect(mockPersist.mock.calls[0][0].clientId).toBe(KEY);
    expect(ack).toHaveBeenCalledWith({ ok: true, id: MSG, duplicate: false });
    expect(chatMessages()).toHaveLength(1);
  });

  it('the same clientId again sends nothing to anyone and tells the sender it was already stored', async () => {
    const me = freshUser();
    liveEvent();
    mockPersist.mockImplementationOnce(async (input: any) => ({ ...storedAs(input), created: false }));
    const ack = jest.fn();
    await handleChatSend(ioWith([me, HOST]), socketFor(me), { sessionId: EVENT, message: 'Hi', scope: 'lobby', clientId: KEY }, ack);
    expect(chatMessages()).toHaveLength(0);
    expect(ack).toHaveBeenCalledWith({ ok: true, id: MSG, duplicate: true });
  });

  it('with an acknowledgement, a refusal arrives there and not as an error event', async () => {
    const me = freshUser();
    mockGetSessionById.mockResolvedValue({ id: EVENT, hostUserId: HOST, status: 'completed' });
    const ack = jest.fn();
    await handleChatSend(ioWith([me]), socketFor(me), { sessionId: EVENT, message: 'Late', scope: 'lobby' }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, code: ErrorCodes.EVENT_ENDED, message: CLOSED });
    expect(errors()).toHaveLength(0);
  });

  it('a clientId that is not a uuid is refused and nothing is stored', async () => {
    const me = freshUser();
    liveEvent();
    const ack = jest.fn();
    await handleChatSend(ioWith([me]), socketFor(me), { sessionId: EVENT, message: 'Hi', scope: 'lobby', clientId: 'abc' }, ack);
    expect(mockPersist).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: ErrorCodes.VALIDATION_ERROR }));
  });

  it('an empty message with an acknowledgement is answered with a refusal', async () => {
    const me = freshUser();
    liveEvent();
    const ack = jest.fn();
    await handleChatSend(ioWith([me]), socketFor(me), { sessionId: EVENT, message: '', scope: 'lobby' }, ack);
    expect(mockPersist).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: ErrorCodes.VALIDATION_ERROR }));
  });
});

// ── History ──────────────────────────────────────────────────────────────────

describe('handleChatRequestHistory (X3)', () => {
  const history = [{ id: MSG, userId: 'u-a', displayName: 'A', message: 'hi', timestamp: '2026-10-25T11:52:00.000Z', scope: 'lobby', isHost: false, reactions: {} }];

  it('refuses a socket that is not in the event and may not read its chat, and reads nothing', async () => {
    mockCanRead.mockResolvedValueOnce(null);
    const socket = socketFor('u-stranger', { inRoom: false });
    await handleChatRequestHistory(ioWith(), socket, { sessionId: EVENT });
    expect(mockCanRead).toHaveBeenCalledWith('u-stranger', 'member', EVENT, { inSessionRoom: false });
    expect(mockHistory).not.toHaveBeenCalled();
    expect(sent).toEqual([{ to: 'socket:u-stranger', event: 'error', payload: { code: ErrorCodes.AUTH_FORBIDDEN, message: FORBIDDEN } }]);
  });

  it('a socket in the event reads the history from the database', async () => {
    mockCanRead.mockResolvedValueOnce('all');
    mockHistory.mockResolvedValueOnce(history);
    const socket = socketFor('u-a');
    await handleChatRequestHistory(ioWith(), socket, { sessionId: EVENT, matchId: 'm-1' });
    expect(mockCanRead).toHaveBeenCalledWith('u-a', 'member', EVENT, { inSessionRoom: true });
    expect(mockHistory).toHaveBeenCalledWith(EVENT, 'u-a', 'all');
    expect(sent).toEqual([{ to: 'socket:u-a', event: 'chat:history', payload: { messages: history } }]);
  });

  it('someone who took part, asking from outside the room, reads it too', async () => {
    mockCanRead.mockResolvedValueOnce('all');
    mockHistory.mockResolvedValueOnce(history);
    await handleChatRequestHistory(ioWith(), socketFor('u-left', { inRoom: false }), { sessionId: EVENT });
    expect(sent[0].event).toBe('chat:history');
  });

  it('a platform admin outside the event reads lobby messages only', async () => {
    mockCanRead.mockResolvedValueOnce('lobby');
    mockHistory.mockResolvedValueOnce([]);
    await handleChatRequestHistory(ioWith(), socketFor('u-admin', { inRoom: false, role: 'admin' }), { sessionId: EVENT });
    expect(mockCanRead).toHaveBeenCalledWith('u-admin', 'admin', EVENT, { inSessionRoom: false });
    expect(mockHistory).toHaveBeenCalledWith(EVENT, 'u-admin', 'lobby');
  });

  it('an id that is not an event id reads nothing', async () => {
    await handleChatRequestHistory(ioWith(), socketFor('u-a'), { sessionId: 'not-an-event' });
    expect(mockCanRead).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('an event that does not exist answers nothing', async () => {
    mockCanRead.mockRejectedValueOnce(new AppError(404, 'SESSION_NOT_FOUND' as any, 'This event could not be found.'));
    await handleChatRequestHistory(ioWith(), socketFor('u-a'), { sessionId: EVENT });
    expect(sent).toHaveLength(0);
  });
});

describe('sendJoinChatHistory (on joining an event)', () => {
  const history = [{ id: MSG, userId: 'u-a', displayName: 'A', message: 'hi', timestamp: '2026-10-25T11:52:00.000Z', scope: 'lobby', isHost: false, reactions: {} }];

  it('sends the history from the database to someone who has just joined the room', async () => {
    mockCanRead.mockResolvedValueOnce('all');
    mockHistory.mockResolvedValueOnce(history);
    await sendJoinChatHistory(socketFor('u-a'), EVENT, 'u-a');
    expect(mockCanRead).toHaveBeenCalledWith('u-a', 'member', EVENT, { inSessionRoom: true });
    expect(sent).toEqual([{ to: 'socket:u-a', event: 'chat:history', payload: { messages: history } }]);
  });

  it('sends nothing when there is no history (production\'s client keeps what it has)', async () => {
    mockCanRead.mockResolvedValueOnce('all');
    mockHistory.mockResolvedValueOnce([]);
    await sendJoinChatHistory(socketFor('u-a'), EVENT, 'u-a');
    expect(sent).toHaveLength(0);
  });

  it('sends nothing to someone who may not read it, such as a stranger opening an ended event\'s live page', async () => {
    mockCanRead.mockResolvedValueOnce(null);
    await sendJoinChatHistory(socketFor('u-stranger'), EVENT, 'u-stranger');
    expect(mockHistory).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('a failed read never breaks the join', async () => {
    mockCanRead.mockRejectedValueOnce(new Error('database is down'));
    await expect(sendJoinChatHistory(socketFor('u-a'), EVENT, 'u-a')).resolves.toBeUndefined();
  });
});

// ── Reactions ────────────────────────────────────────────────────────────────

describe('handleChatReact', () => {
  it('a reaction on a room message goes to the people the message reached, from the database', async () => {
    mockToggle.mockResolvedValueOnce({ scope: 'room', audienceIds: ['u-a', 'u-b'], reactions: { heart: ['u-a'] } });
    await handleChatReact(ioWith(), socketFor('u-a'), { sessionId: EVENT, messageId: MSG, emoji: 'heart' });
    expect(mockToggle).toHaveBeenCalledWith({ sessionId: EVENT, messageId: MSG, userId: 'u-a', emoji: 'heart' });
    expect(sent).toEqual([
      { to: 'user:u-a', event: 'chat:reaction_update', payload: { messageId: MSG, reactions: { heart: ['u-a'] } } },
      { to: 'user:u-b', event: 'chat:reaction_update', payload: { messageId: MSG, reactions: { heart: ['u-a'] } } },
    ]);
  });

  it('a reaction on a lobby message goes to the whole event', async () => {
    mockToggle.mockResolvedValueOnce({ scope: 'lobby', audienceIds: null, reactions: { clap: ['u-a', 'u-b'] } });
    await handleChatReact(ioWith(), socketFor('u-a'), { sessionId: EVENT, messageId: MSG, emoji: 'clap' });
    expect(sent).toEqual([
      { to: sessionRoom(EVENT), event: 'chat:reaction_update', payload: { messageId: MSG, reactions: { clap: ['u-a', 'u-b'] } } },
    ]);
  });

  it('a message the member cannot react to sends nothing', async () => {
    mockToggle.mockResolvedValueOnce(null);
    await handleChatReact(ioWith(), socketFor('u-a'), { sessionId: EVENT, messageId: MSG, emoji: 'heart' });
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['from a socket not in the event', socketFor('u-a', { inRoom: false }), { sessionId: EVENT, messageId: MSG, emoji: 'heart' }],
    ['on a message id from before messages were kept', socketFor('u-a'), { sessionId: EVENT, messageId: '1730000000-abc123', emoji: 'heart' }],
    ['with a reaction the chat does not offer', socketFor('u-a'), { sessionId: EVENT, messageId: MSG, emoji: 'fire' }],
  ])('ignores a reaction %s without touching the database', async (_what, socket, data) => {
    await handleChatReact(ioWith(), socket, data);
    expect(mockToggle).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});
