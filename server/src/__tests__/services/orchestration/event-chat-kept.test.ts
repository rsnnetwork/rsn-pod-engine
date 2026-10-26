// ─── The event chat survives a restart, and the end of an event tells every open page (26 Oct 2026) ──
//
// 25 Oct: the chat of a finished event was gone. It lived in one process's memory; a restart or deploy in
// the middle of an event (Render redeploys on every push to main) lost it, and the end of the event deleted
// it. Here the real handlers and the real event-chat service run over a fake database that keeps what is
// written to it: messages are sent, the server "restarts" (everything held in memory is dropped), and both
// ways a client gets the history back (asking for it, and joining again) still return every message, read
// from the database. Then the host ends the event, and a participant who had already left is told, with the
// chat tag among the rest.

const store = {
  messages: [] as Record<string, any>[],
  status: 'round_active',
  participants: new Map<string, { status: string; joined: boolean }>(),
  podMembers: [] as string[],
  /** The order the end-of-event sweep and the completion fan-out reached the database in. */
  timeline: [] as string[],
};
const mockRegister = jest.fn();

const mockQuery = jest.fn(async (sql: string, params: unknown[] = []) => answer(sql.replace(/\s+/g, ' ').trim(), params));
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb({ query: (sql: string, params?: unknown[]) => mockQuery(sql, params) })),
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
  updateSessionStatus: jest.fn(async () => ({})),
  updateParticipantStatus: jest.fn(async () => {}),
  getParticipantCount: jest.fn(async () => 2),
  registerParticipant: (...args: unknown[]) => mockRegister(...args),
  __esModule: true,
}));
jest.mock('../../../services/video/video.service', () => ({
  closeLobbyRoom: jest.fn(async () => {}),
  closeMatchRoom: jest.fn(async () => {}),
  listParticipants: jest.fn(async () => []),
  lobbyRoomId: (sid: string) => `session-${sid}`,
  __esModule: true,
}));
jest.mock('../../../services/matching/matching.service', () => ({
  getMatchesByRound: jest.fn(async () => []),
  repairFutureRounds: jest.fn(async () => ({ regeneratedRounds: [] })),
  __esModule: true,
}));
jest.mock('../../../services/rating/rating.service', () => ({
  finalizeSessionEncounters: jest.fn(async () => {}),
  __esModule: true,
}));

import { randomUUID } from 'crypto';
import { SessionStatus } from '@rsn/shared';
import { activeSessions, sessionRoom, userRoom } from '../../../services/orchestration/state/session-state';
import { handleChatSend, handleChatRequestHistory } from '../../../services/orchestration/handlers/chat-handlers';
import { handleJoinSession } from '../../../services/orchestration/handlers/participant-flow';
import { completeSession } from '../../../services/orchestration/handlers/round-lifecycle';
import { setRealtimeIo } from '../../../realtime/emit';

const EVENT = '5e1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const POD = '6f2b3c4d-5e6f-4a71-8b8c-0d1e2f3a4b5c';
const HOST = '7a3c4d5e-6f70-4b82-9c9d-1e2f3a4b5c6d';
const STEFAN = '8b4d5e6f-7081-4c93-8dae-2f3a4b5c6d7e';
const CLAUS = '9c5e6f70-8192-4da4-9ebf-3a4b5c6d7e8f';
const NEWCOMER = 'ad6f7081-92a3-4eb5-8fc0-4b5c6d7e8f90';
const STRANGER = 'be708192-a3b4-4fc6-90d1-5c6d7e8f9001';

type Answer = { rows: any[]; rowCount?: number };

/** The fake database: what each query this flow makes would return, from what was written. */
function answer(sql: string, params: unknown[]): Answer | Promise<Answer> {
  if (sql.startsWith('INSERT INTO event_chat_messages')) {
    if (store.status === 'completed' || store.status === 'cancelled') return { rows: [] };
    const row = {
      id: randomUUID(), session_id: params[0], sender_id: params[1], sender_name: params[2], sender_is_host: params[3],
      scope: params[4], room_id: params[5], audience_ids: params[7], content: params[8],
      created_at: new Date(Date.UTC(2026, 9, 25, 11, 52, 0, store.messages.length)), deleted_at: null,
    };
    store.messages.push(row);
    return { rows: [{ id: row.id, created_at: row.created_at }], rowCount: 1 };
  }
  if (/FROM event_chat_messages m LEFT JOIN users u/.test(sql) && /ORDER BY m\.created_at DESC, m\.id DESC/.test(sql)) {
    const [sessionId, viewer, withRooms] = params;
    const rows = store.messages
      .filter((m) => m.session_id === sessionId && !m.deleted_at)
      .filter((m) => m.scope === 'lobby' || (withRooms && (m.audience_ids as string[]).includes(viewer as string)))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, params[params.length - 1] as number)
      .map((m) => ({ ...m, sender_status: 'active', reactions: {} }));
    return { rows };
  }
  if (/FROM sessions s LEFT JOIN session_participants p/.test(sql)) {
    const p = store.participants.get(params[1] as string);
    return { rows: [{ status: store.status, is_host: params[1] === HOST, is_cohost: false, participant_status: p?.status ?? null, joined: p?.joined ?? false }] };
  }
  if (/^UPDATE sessions SET status = 'completed', ended_at = NOW\(\)/.test(sql)) {
    store.status = 'completed';
    return { rows: [{ id: EVENT, event_format: 'speed_networking' }] };
  }
  // The end-of-event sweep takes a moment, as a real UPDATE does, and marks everyone still there left.
  if (/^UPDATE session_participants SET status = 'left'/.test(sql)) {
    store.timeline.push('sweep:start');
    return (async () => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      for (const p of store.participants.values()) if (!['left', 'removed', 'no_show'].includes(p.status)) p.status = 'left';
      store.timeline.push('sweep:done');
      return { rows: [], rowCount: store.participants.size };
    })();
  }
  if (sql === 'SELECT pod_id FROM sessions WHERE id = $1') {
    store.timeline.push('fanout:start');
    return { rows: [{ pod_id: POD }] };
  }
  if (/FROM session_participants WHERE session_id = \$1 AND \(joined_at IS NOT NULL OR status <> 'removed'\)/.test(sql)) {
    const rows = [...store.participants]
      .filter(([, p]) => p.joined || p.status !== 'removed')
      .map(([user_id]) => ({ user_id }));
    return { rows: [...rows, { user_id: HOST }, ...store.podMembers.map((user_id) => ({ user_id }))] };
  }
  return { rows: [], rowCount: 0 };
}

const sent: { to: string; event: string; payload: any }[] = [];

function socketFor(userId: string, name: string) {
  return {
    id: `socket-${userId}`,
    data: { userId, role: 'member', displayName: name },
    rooms: new Set<string>(),
    emit: jest.fn((event: string, payload: unknown) => { sent.push({ to: `socket:${userId}`, event, payload }); }),
    join(room: string) { this.rooms.add(room); },
    leave(room: string) { this.rooms.delete(room); },
  } as any;
}

const io: any = {
  to: (room: string) => ({ emit: (event: string, payload: unknown) => { sent.push({ to: room, event, payload }); } }),
  in: () => ({ fetchSockets: async () => [] }),
  sockets: { sockets: new Map() },
};

const flush = () => new Promise((r) => setImmediate(r));

function liveEvent() {
  activeSessions.set(EVENT, {
    sessionId: EVENT, hostUserId: HOST, config: {} as any, currentRound: 1, status: SessionStatus.LOBBY_OPEN,
    timer: null, timerSyncInterval: null, timerEndsAt: null, isPaused: false, pausedTimeRemaining: null,
    presenceMap: new Map([[HOST, { lastHeartbeat: new Date(), socketId: `socket-${HOST}` }]]),
    pendingRoundNumber: null, manuallyLeftRound: new Set(),
  } as any);
}

// The join schedules a 300 ms participant-list broadcast; fake timers keep it inside each test.
beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['Date', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance'] });
});
afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  store.messages = [];
  store.status = 'lobby_open';
  store.participants = new Map([
    [STEFAN, { status: 'in_lobby', joined: true }],
    [CLAUS, { status: 'in_lobby', joined: true }],
  ]);
  store.podMembers = [];
  store.timeline = [];
  sent.length = 0;
  activeSessions.clear();
  mockGetSessionById.mockResolvedValue({ id: EVENT, podId: POD, hostUserId: HOST, status: 'lobby_open', config: {} });
  mockRegister.mockReset();
  mockRegister.mockResolvedValue({ isNewRegistration: false });
});

afterEach(() => {
  jest.clearAllTimers();
  activeSessions.clear();
});

describe('a restart in the middle of an event loses nothing', () => {
  async function chatThenRestart() {
    liveEvent();
    const claus = socketFor(CLAUS, 'Claus'); claus.join(sessionRoom(EVENT));
    const stefan = socketFor(STEFAN, 'Stefan'); stefan.join(sessionRoom(EVENT));
    await handleChatSend(io, claus, { sessionId: EVENT, message: 'Welcome to the test event', scope: 'lobby' });
    await handleChatSend(io, stefan, { sessionId: EVENT, message: 'Glad to be here', scope: 'lobby' });
    expect(store.messages).toHaveLength(2);
    // The process restarts: everything it held in memory is gone.
    activeSessions.clear();
    sent.length = 0;
  }

  it('asking for the history afterwards returns every message, read from the database, oldest first', async () => {
    await chatThenRestart();
    const back = socketFor(STEFAN, 'Stefan'); back.join(sessionRoom(EVENT));
    await handleChatRequestHistory(io, back, { sessionId: EVENT });
    const history = sent.find((s) => s.event === 'chat:history');
    expect(history?.payload.messages.map((m: any) => [m.displayName, m.message, m.id])).toEqual([
      ['Claus', 'Welcome to the test event', store.messages[0].id],
      ['Stefan', 'Glad to be here', store.messages[1].id],
    ]);
  });

  it('joining again afterwards sends every message too', async () => {
    await chatThenRestart();
    const back = socketFor(CLAUS, 'Claus');
    await handleJoinSession(io, back, { sessionId: EVENT });
    await flush(); await flush(); await flush();
    const history = sent.find((s) => s.to === `socket:${CLAUS}` && s.event === 'chat:history');
    expect(history?.payload.messages.map((m: any) => m.message)).toEqual(['Welcome to the test event', 'Glad to be here']);
  });
});

// Fix round 1 (26 Oct 2026).
describe('entering an event', () => {
  async function clausSaysWelcome() {
    liveEvent();
    const claus = socketFor(CLAUS, 'Claus'); claus.join(sessionRoom(EVENT));
    await handleChatSend(io, claus, { sessionId: EVENT, message: 'Welcome', scope: 'lobby' });
    sent.length = 0;
  }

  // Production's chat panel asks for the history when it mounts, before the page's session:join reaches the
  // server. That first ask must not turn into a red toast; the join sends the history a moment later.
  it('a registered member\'s first visit: the early ask is answered with silence, then the join sends the history', async () => {
    await clausSaysWelcome();
    store.participants.set(NEWCOMER, { status: 'registered', joined: false });
    const newcomer = socketFor(NEWCOMER, 'Newcomer');
    await handleChatRequestHistory(io, newcomer, { sessionId: EVENT });
    expect(sent).toEqual([]);
    await handleJoinSession(io, newcomer, { sessionId: EVENT });
    await flush(); await flush(); await flush();
    const history = sent.find((s) => s.to === `socket:${NEWCOMER}` && s.event === 'chat:history');
    expect(history?.payload.messages.map((m: any) => m.message)).toEqual(['Welcome']);
    expect(sent.filter((s) => s.event === 'error')).toEqual([]);
  });

  // H1 (26 Oct 2026): the join no longer puts a stranger in the event's room (it decides first, see
  // h1-event-room-gate.test.ts), so they are refused once, in words, and asking for the history still answers
  // nothing at all.
  it('a stranger whose registration is refused is not let into the room, and gets no history by joining or asking', async () => {
    await clausSaysWelcome();
    mockRegister.mockRejectedValueOnce(Object.assign(new Error('You must be a pod member to register for sessions in a private pod'), { code: 'AUTH_FORBIDDEN' }));
    const stranger = socketFor(STRANGER, 'Stranger');
    await handleJoinSession(io, stranger, { sessionId: EVENT });
    await flush(); await flush(); await flush();
    expect(stranger.rooms.has(sessionRoom(EVENT))).toBe(false);
    await handleChatRequestHistory(io, stranger, { sessionId: EVENT });
    const toStranger = sent.filter((s) => s.to === `socket:${STRANGER}`);
    expect(toStranger).toEqual([{
      to: `socket:${STRANGER}`, event: 'error',
      payload: { code: 'AUTH_FORBIDDEN', message: 'This event is only open to its pod\'s members.' },
    }]);
  });
});

describe('the end of an event', () => {
  it('the completion fan-out runs once the sweep has marked everyone left, so a refetch reads the final roster', async () => {
    liveEvent();
    setRealtimeIo(io);
    await completeSession(io, EVENT);
    expect(store.timeline).toEqual(['sweep:start', 'sweep:done', 'fanout:start']);
  });

  it('tells a participant who had already left, among everyone, with the event, its people and its chat', async () => {
    liveEvent();
    store.participants.set(STEFAN, { status: 'left', joined: true }); // left before the end, as on 25 Oct
    setRealtimeIo(io);
    await completeSession(io, EVENT);
    const toStefan = sent.filter((s) => s.to === userRoom(STEFAN) && s.event === 'entity:changed');
    expect(toStefan).toHaveLength(1);
    expect(toStefan[0].payload.entities).toEqual(expect.arrayContaining([
      `session:${EVENT}`, `session:${EVENT}:participants`, `session:${EVENT}:chat`, `pod:${POD}:sessions`,
      `user:${STEFAN}:sessions`, `user:${STEFAN}:pods`,
    ]));
    expect(sent.some((s) => s.to === userRoom(HOST) && s.event === 'entity:changed')).toBe(true);
  });

  it('after the end the chat is still there, and a message sent then is refused, not stored', async () => {
    liveEvent();
    const claus = socketFor(CLAUS, 'Claus'); claus.join(sessionRoom(EVENT));
    await handleChatSend(io, claus, { sessionId: EVENT, message: 'Thanks all', scope: 'lobby' });
    setRealtimeIo(io);
    await completeSession(io, EVENT);
    mockGetSessionById.mockResolvedValue({ id: EVENT, podId: POD, hostUserId: HOST, status: 'completed', config: {} });
    sent.length = 0;
    await handleChatSend(io, claus, { sessionId: EVENT, message: 'Anyone still here?', scope: 'lobby' });
    expect(store.messages.map((m) => m.content)).toEqual(['Thanks all']);
    expect(sent).toEqual([{ to: `socket:${CLAUS}`, event: 'error', payload: { code: 'EVENT_ENDED', message: 'This event has ended, so its chat is closed.' } }]);
    // Someone who took part reads it afterwards, from outside the live room.
    sent.length = 0;
    await handleChatRequestHistory(io, socketFor(STEFAN, 'Stefan'), { sessionId: EVENT });
    expect(sent[0].payload.messages.map((m: any) => m.message)).toEqual(['Thanks all']);
  });
});
