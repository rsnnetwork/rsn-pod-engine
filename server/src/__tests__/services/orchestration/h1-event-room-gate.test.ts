// ─── Only the people an event admits join its live room (H1, 26 Oct 2026) ───────────────────────────
//
// Found by the S5 reviews: handleJoinSession put the socket in the event's room (`session:<id>`) and marked
// the person present BEFORE it tried to register them, then swallowed every refusal but REMOVED_FROM_EVENT.
// So anyone signed in who knew a private pod's event id received its live chat, reactions, presence and
// round events, showed up on everyone's participant list, and could post into the chat. A heartbeat put them
// back in the presence map even when the join had not.
//
// Now the join decides first, with one positive check after the registration attempt: the host, a co-host
// or moderator, a platform admin or super admin, or someone whose participant row is not removed (left,
// dropped, refreshed, a second tab, a late joiner the registration has just admitted). Only then does the
// socket join the room and the person become present. A removed row is the same terminal bounce as before.
// A person refused only because the event is full keeps today's behaviour, on purpose.
//
// The real join, the real registration (session.service), the real chat, reaction and heartbeat handlers run
// here over a fake database that holds the events, pods, pod members, participants and co-hosts, and a fake
// Socket.IO server that delivers a message only to the sockets actually in its room.

// A row of the fake database. `any` because it stands for rows of several tables, each read back by its own column names.
type Row = Record<string, any>;

const world = {
  sessions: new Map<string, Row>(),
  pods: new Map<string, Row>(),
  podMembers: [] as Row[],
  participants: [] as Row[],
  cohosts: [] as Row[],
  users: new Map<string, Row>(),
  messages: [] as Row[],
  matches: [] as Row[],
};

/** Holds one query until released, so a test can act while a join is still being decided. */
const hold: { match: ((sql: string, params: unknown[]) => boolean) | null; released: Promise<void> } = { match: null, released: Promise.resolve() };

async function fakeQuery(sql: string, params: unknown[] = []) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  if (hold.match?.(flat, params)) { hold.match = null; await hold.released; }
  return answer(flat, params);
}
const mockQuery = jest.fn(fakeQuery);

/** The database fails the admission check `times` times (and answers everything else). */
function failTheAdmissionCheck(times = Infinity) {
  let failures = 0;
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/^SELECT s\.host_user_id = \$2 AS is_host/.test(sql.replace(/\s+/g, ' ').trim()) && failures < times) {
      failures++;
      throw new Error('connection terminated unexpectedly');
    }
    return fakeQuery(sql, params);
  });
}
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  // A transaction that throws leaves nothing behind, as Postgres does (registration adds a public pod's
  // member, then can still refuse a full event).
  transaction: async (cb: (client: unknown) => unknown) => {
    const saved = { podMembers: world.podMembers.map((r) => ({ ...r })), participants: world.participants.map((r) => ({ ...r })) };
    try {
      return await cb({ query: (sql: string, params?: unknown[]) => mockQuery(sql, params) });
    } catch (err) {
      world.podMembers = saved.podMembers;
      world.participants = saved.participants;
      throw err;
    }
  },
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));
// session.service is the real one (registration, event reads, status writes, LiveKit tokens), over the fake database.
jest.mock('../../../services/session/session-state-snapshot.service', () => ({
  buildSessionStateSnapshot: jest.fn(async (sessionId: string) => ({
    connectedParticipants: [], sessionStatus: world.sessions.get(sessionId)?.status, hostInLobby: true,
    hostUserId: world.sessions.get(sessionId)?.host_user_id, currentRound: 1, totalRounds: 3, cohosts: [],
    participantCounts: {},
  })),
  __esModule: true,
}));
jest.mock('../../../services/video/video.service', () => ({
  closeLobbyRoom: jest.fn(async () => {}),
  closeMatchRoom: jest.fn(async () => {}),
  listParticipants: jest.fn(async () => []),
  lobbyRoomId: (sid: string) => `lobby-${sid}`,
  __esModule: true,
}));
const mockRepairFutureRounds = jest.fn(async () => ({ regeneratedRounds: [] as number[] }));
jest.mock('../../../services/matching/matching.service', () => ({
  getMatchesByRound: jest.fn(async () => []),
  repairFutureRounds: (...args: unknown[]) => (mockRepairFutureRounds as jest.Mock)(...args),
  __esModule: true,
}));
jest.mock('../../../services/rating/rating.service', () => ({
  finalizeSessionEncounters: jest.fn(async () => {}),
  __esModule: true,
}));

import { randomUUID } from 'crypto';
import type { Server as SocketServer, Socket } from 'socket.io';
import { ParticipantStatus } from '@rsn/shared';
import {
  activeSessions, disconnectTimeouts, sessionRoom, userRoom,
} from '../../../services/orchestration/state/session-state';
import {
  handleJoinSession, handleHeartbeat, handleLeaveSession, handleReady, handleRoomJoined,
} from '../../../services/orchestration/handlers/participant-flow';
import {
  handleChatSend, handleChatRequestHistory, handleReactionSend,
} from '../../../services/orchestration/handlers/chat-handlers';
import { reconcileSessionStates, setPresence } from '../../../services/orchestration/state/participant-state-machine';
import * as sessionService from '../../../services/session/session.service';

// ── The fake database ────────────────────────────────────────────────────────

type Answer = { rows: Row[]; rowCount?: number };

function participant(sessionId: unknown, userId: unknown): Row | undefined {
  return world.participants.find((p) => p.session_id === sessionId && p.user_id === userId);
}

function answer(sql: string, params: unknown[]): Answer {
  const [a, b] = params;
  if (sql === 'SELECT display_name FROM users WHERE id = $1') {
    const u = world.users.get(a as string);
    return { rows: u ? [{ display_name: u.display_name }] : [] };
  }
  // getSessionById and the registration's own read of the event (SESSION_COLUMNS).
  if (/pod_id AS "podId"/.test(sql) && /FROM sessions WHERE id = \$1$/.test(sql)) {
    const s = world.sessions.get(a as string);
    return {
      rows: s ? [{
        id: s.id, podId: s.pod_id, title: 'H1 event', description: null, status: s.status, currentRound: s.current_round,
        config: s.config, hostUserId: s.host_user_id, lobbyRoomId: null, hostVisibilityMode: null, format: s.event_format,
      }] : [],
    };
  }
  if (sql === 'SELECT visibility FROM pods WHERE id = $1') {
    const p = world.pods.get(a as string);
    return { rows: p ? [{ visibility: p.visibility }] : [] };
  }
  if (sql === "SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'") {
    return { rows: world.podMembers.filter((m) => m.pod_id === a && m.user_id === b && m.status === 'active') };
  }
  if (sql.startsWith('INSERT INTO pod_members')) {
    const m = world.podMembers.find((r) => r.pod_id === a && r.user_id === b);
    if (m) m.status = 'active';
    else world.podMembers.push({ pod_id: a, user_id: b, role: 'member', status: 'active' });
    return { rows: [], rowCount: 1 };
  }
  if (sql === "SELECT COUNT(*) as count FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left')") {
    return { rows: [{ count: String(world.participants.filter((p) => p.session_id === a && !['removed', 'left'].includes(p.status)).length) }] };
  }
  if (sql === "SELECT COUNT(*) as count FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')") {
    return { rows: [{ count: String(world.participants.filter((p) => p.session_id === a && !['removed', 'left', 'no_show'].includes(p.status)).length) }] };
  }
  if (sql === 'SELECT id, status FROM session_participants WHERE session_id = $1 AND user_id = $2'
      || sql === 'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    const p = participant(a, b);
    return { rows: p ? [{ id: p.id, status: p.status }] : [] };
  }
  // A status write: the state machine's, the legacy fallback's and the reconciler's all start this way. One that
  // carries the removal guard leaves a removed row as it is, as Postgres would.
  if (sql.startsWith('UPDATE session_participants SET status = $1')) {
    const p = participant(params[params.length - 2], params[params.length - 1]);
    if (!p || (sql.includes("status <> 'removed'") && p.status === 'removed')) return { rows: [], rowCount: 0 };
    p.status = params[0];
    return { rows: [], rowCount: 1 };
  }
  // The reconciler reads every row of the event, to write memory into it.
  if (sql === 'SELECT user_id, status, joined_at FROM session_participants WHERE session_id = $1') {
    return { rows: world.participants.filter((p) => p.session_id === a).map((p) => ({ user_id: p.user_id, status: p.status, joined_at: p.joined_at })) };
  }
  // Who may say they are in a breakout room (presence:room_joined).
  if (/FROM matches m JOIN sessions s ON s\.id = m\.session_id/.test(sql)) {
    const [matchId, sessionId, who, roomId] = params;
    const m = world.matches.find((r) => r.id === matchId && r.session_id === sessionId && r.room_id === roomId);
    if (!m) return { rows: [] };
    return {
      rows: [{
        in_match: [m.a, m.b, m.c].includes(who),
        is_host: world.sessions.get(sessionId as string)?.host_user_id === who,
        is_cohost: world.cohosts.some((c) => c.session_id === sessionId && c.user_id === who),
        participant_status: participant(sessionId, who)?.status ?? null,
      }],
    };
  }
  if (sql.startsWith("UPDATE session_participants SET status = 'registered', left_at = NULL, is_no_show = FALSE")) {
    const p = participant(a, b)!;
    p.status = 'registered';
    return { rows: [{ ...p }], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO session_participants (session_id, user_id, status, acting_as_host)')) {
    if (participant(a, b)) return { rows: [], rowCount: 0 };
    const p = { id: randomUUID(), session_id: a, user_id: b, status: 'registered', joined_at: null };
    world.participants.push(p);
    return { rows: [{ ...p }], rowCount: 1 };
  }
  // The admission check and the chat's access check read the same facts.
  if (/FROM sessions s LEFT JOIN session_participants p/.test(sql)) {
    const s = world.sessions.get(a as string);
    if (!s) return { rows: [] };
    const p = participant(a, b);
    return {
      rows: [{
        status: s.status,
        is_host: s.host_user_id === b,
        is_cohost: world.cohosts.some((c) => c.session_id === a && c.user_id === b),
        participant_status: p?.status ?? null,
        joined: !!p?.joined_at,
      }],
    };
  }
  if (sql === "SELECT user_id FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')") {
    return { rows: world.participants.filter((p) => p.session_id === a && !['removed', 'left', 'no_show'].includes(p.status)).map((p) => ({ user_id: p.user_id })) };
  }
  if (sql === 'SELECT user_id FROM session_cohosts WHERE session_id = $1 AND user_id = $2') {
    return { rows: world.cohosts.filter((c) => c.session_id === a && c.user_id === b).map((c) => ({ user_id: c.user_id })) };
  }
  if (sql.startsWith('INSERT INTO event_chat_messages')) {
    const s = world.sessions.get(a as string);
    if (!s || ['completed', 'cancelled'].includes(s.status)) return { rows: [] };
    const row = {
      id: randomUUID(), session_id: a, sender_id: b, sender_name: params[2], sender_is_host: params[3],
      scope: params[4], room_id: params[5], audience_ids: params[7], content: params[8],
      created_at: new Date(Date.UTC(2026, 9, 26, 12, 0, 0, world.messages.length)), deleted_at: null,
    };
    world.messages.push(row);
    return { rows: [{ id: row.id, created_at: row.created_at }], rowCount: 1 };
  }
  if (/FROM event_chat_messages m LEFT JOIN users u/.test(sql) && /ORDER BY m\.created_at DESC, m\.id DESC/.test(sql)) {
    const [sessionId, viewer, withRooms] = params;
    const rows = world.messages
      .filter((m) => m.session_id === sessionId && !m.deleted_at)
      .filter((m) => m.scope === 'lobby' || (withRooms && (m.audience_ids as string[]).includes(viewer as string)))
      .sort((x, y) => y.created_at - x.created_at)
      .slice(0, params[params.length - 1] as number)
      .map((m) => ({ ...m, sender_status: 'active', reactions: {} }));
    return { rows };
  }
  return { rows: [], rowCount: 0 };
}

// ── The fake Socket.IO server: a message reaches only the sockets in its room ──

// `any`: each event carries its own payload shape, read by name in the assertions.
type Got = { event: string; payload: any };
type FakeSocket = {
  id: string; data: { userId: string; role: string; displayName: string }; rooms: Set<string>; got: Got[];
  emit: (event: string, payload?: unknown) => boolean; join: (room: string) => void; leave: (room: string) => void;
  disconnect: () => void;
};

const sockets = new Map<string, FakeSocket>();

/** A signed-in socket, already in its person's own room as the connection handler puts it. */
function connect(userId: string, role = 'member'): FakeSocket {
  const s: FakeSocket = {
    id: `socket-${randomUUID()}`,
    data: { userId, role, displayName: world.users.get(userId)?.display_name ?? 'Someone' },
    rooms: new Set([userRoom(userId)]),
    got: [],
    emit(event, payload) { this.got.push({ event, payload }); return true; },
    join(room) { this.rooms.add(room); },
    leave(room) { this.rooms.delete(room); },
    disconnect() { this.rooms.clear(); sockets.delete(this.id); },
  };
  sockets.set(s.id, s);
  return s;
}

const io = {
  to: (room: string) => ({
    emit: (event: string, payload: unknown) => { for (const s of sockets.values()) if (s.rooms.has(room)) s.got.push({ event, payload }); },
  }),
  in: (room: string) => ({ fetchSockets: async () => [...sockets.values()].filter((s) => s.rooms.has(room)) }),
  sockets: { sockets },
} as unknown as SocketServer;

/** A fake socket where the handlers expect Socket.IO's. */
const asSocket = (s: FakeSocket): Socket => s as unknown as Socket;

const events = (s: FakeSocket) => s.got.map((g) => g.event);
const chatTexts = (s: FakeSocket) => s.got.filter((g) => g.event === 'chat:message').map((g) => g.payload.message);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

// ── The people and the events ─────────────────────────────────────────────────

function person(name: string): string {
  const id = randomUUID();
  world.users.set(id, { id, display_name: name, email: `${name.toLowerCase()}@rsn-e2e.invalid` });
  return id;
}

/** An event in a pod of the given visibility; the host is the pod's director and registered, as createSession does. */
function event(opts: { visibility: string; status?: string; maxParticipants?: number }) {
  const podId = randomUUID();
  const sessionId = randomUUID();
  const host = person('Host');
  world.pods.set(podId, { id: podId, visibility: opts.visibility });
  world.podMembers.push({ pod_id: podId, user_id: host, role: 'director', status: 'active' });
  world.sessions.set(sessionId, {
    id: sessionId, pod_id: podId, host_user_id: host, status: opts.status ?? 'lobby_open', current_round: 1,
    config: opts.maxParticipants ? { maxParticipants: opts.maxParticipants } : {}, event_format: 'speed_networking',
  });
  register(sessionId, host);
  return { podId, sessionId, host };
}

function podMember(podId: string, userId: string, status = 'active') {
  world.podMembers.push({ pod_id: podId, user_id: userId, role: 'member', status });
}
function register(sessionId: string, userId: string, status = 'registered') {
  world.participants.push({ id: randomUUID(), session_id: sessionId, user_id: userId, status, joined_at: status === 'registered' ? null : new Date() });
}

async function join(s: FakeSocket, sessionId: string) {
  await handleJoinSession(io, asSocket(s), { sessionId });
  await flush();
}

const inRoom = (s: FakeSocket, sessionId: string) => s.rooms.has(sessionRoom(sessionId));
const present = (sessionId: string, userId: string) => activeSessions.get(sessionId)?.presenceMap.has(userId) ?? false;

/** Everything an admitted join sends the joiner, minus the history (sent only when there is chat). */
function expectAdmitted(s: FakeSocket, sessionId: string) {
  expect(inRoom(s, sessionId)).toBe(true);
  expect(events(s)).toContain('session:state');
  expect(events(s)).not.toContain('error');
  expect(events(s)).not.toContain('session:evicted');
}

/** A refusal: one `error` with the sentence, nothing about the event, not in its room, not present. */
function expectRefused(s: FakeSocket, sessionId: string, refusal: { code: string; message: string }) {
  expect(inRoom(s, sessionId)).toBe(false);
  expect(present(sessionId, s.data.userId)).toBe(false);
  expect(s.got).toEqual([{ event: 'error', payload: refusal }]);
}

const POD_ONLY = { code: 'AUTH_FORBIDDEN', message: 'This event is only open to its pod\'s members.' };
const RETRY = { code: 'JOIN_FAILED', message: 'You could not join this event. Refresh the page to try again.' };
const statusOf = (sessionId: string, userId: string) => participant(sessionId, userId)?.status ?? null;

/** A running private event: its host and a registered member are in; a stranger has a socket. */
async function privateEventWithMemberChatting() {
  const ev = event({ visibility: 'private' });
  const member = person('Member');
  podMember(ev.podId, member);
  register(ev.sessionId, member);
  const hostSock = connect(ev.host);
  const memberSock = connect(member);
  await join(hostSock, ev.sessionId);
  await join(memberSock, ev.sessionId);
  const stranger = person('Stranger');
  const strangerSock = connect(stranger);
  return { ...ev, member, hostSock, memberSock, stranger, strangerSock };
}

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['Date', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance'] });
});
afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  world.sessions.clear(); world.pods.clear(); world.users.clear();
  world.podMembers = []; world.participants = []; world.cohosts = []; world.messages = []; world.matches = [];
  sockets.clear();
  activeSessions.clear();
  disconnectTimeouts.clear();
  mockRepairFutureRounds.mockClear();
  mockQuery.mockImplementation(fakeQuery);
  hold.match = null;
});

afterEach(() => {
  jest.clearAllTimers();
  activeSessions.clear();
});

// ── Refused ──────────────────────────────────────────────────────────────────

describe('a stranger to a private pod\'s running event', () => {
  it('is refused with one sentence: not in the room, not present, no state, no history, nobody told they came', async () => {
    const t = await privateEventWithMemberChatting();
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Welcome all', scope: 'lobby' });
    t.hostSock.got = []; t.memberSock.got = [];

    await join(t.strangerSock, t.sessionId);

    expectRefused(t.strangerSock, t.sessionId, POD_ONLY);
    expect(world.participants.some((p) => p.user_id === t.stranger)).toBe(false);
    for (const s of [t.hostSock, t.memberSock]) {
      expect(s.got.filter((g) => g.event === 'participant:joined')).toEqual([]);
      expect(events(s)).not.toContain('roster:changed');
    }
  });

  it('is never in the room or present while their join is being decided: a message sent meanwhile does not reach them', async () => {
    const t = await privateEventWithMemberChatting();
    let release!: () => void;
    hold.released = new Promise<void>((r) => { release = r; });
    hold.match = (sql, params) => sql.startsWith('SELECT role FROM pod_members') && params[1] === t.stranger;
    const joining = handleJoinSession(io, asSocket(t.strangerSock), { sessionId: t.sessionId });
    await flush();
    expect(hold.match).toBeNull(); // the registration is waiting on the database
    expect(inRoom(t.strangerSock, t.sessionId)).toBe(false);
    expect(present(t.sessionId, t.stranger)).toBe(false);
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Said mid-join', scope: 'lobby' });
    release();
    await joining;
    await flush();
    expect(chatTexts(t.hostSock)).toContain('Said mid-join');
    expect(t.strangerSock.got).toEqual([{ event: 'error', payload: POD_ONLY }]);
  });

  it('receives none of the chat while they sit there, and the debounced participant list does not reach them', async () => {
    const t = await privateEventWithMemberChatting();
    await join(t.strangerSock, t.sessionId);
    t.hostSock.got = []; t.memberSock.got = []; t.strangerSock.got = [];

    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Hello host', scope: 'lobby' });
    await handleChatSend(io, asSocket(t.hostSock), { sessionId: t.sessionId, message: 'Hello member', scope: 'lobby' });
    await handleReactionSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, type: 'heart' });
    jest.advanceTimersByTime(400);
    await flush();

    expect(chatTexts(t.hostSock)).toEqual(['Hello host', 'Hello member']);
    expect(chatTexts(t.memberSock)).toEqual(['Hello host', 'Hello member']);
    expect(events(t.memberSock)).toContain('session:state');
    expect(events(t.memberSock)).toContain('reaction:received');
    expect(t.strangerSock.got).toEqual([]);
  });

  it('cannot post, react or read the history, and their heartbeats never make them present', async () => {
    const t = await privateEventWithMemberChatting();
    await join(t.strangerSock, t.sessionId);
    t.hostSock.got = []; t.memberSock.got = []; t.strangerSock.got = [];

    await handleChatSend(io, asSocket(t.strangerSock), { sessionId: t.sessionId, message: 'let me in', scope: 'lobby' });
    await handleReactionSend(io, asSocket(t.strangerSock), { sessionId: t.sessionId, type: 'heart' });
    await handleChatRequestHistory(io, asSocket(t.strangerSock), { sessionId: t.sessionId });
    handleHeartbeat(asSocket(t.strangerSock), { sessionId: t.sessionId });
    handleHeartbeat(asSocket(t.strangerSock), { sessionId: t.sessionId });
    await flush();

    expect(t.strangerSock.got).toEqual([{ event: 'error', payload: { code: 'NOT_IN_SESSION', message: 'You are not in this event.' } }]);
    expect(world.messages).toEqual([]);
    expect(t.hostSock.got).toEqual([]);
    expect(t.memberSock.got).toEqual([]);
    expect(present(t.sessionId, t.stranger)).toBe(false);
  });

  it('asking again from the same page (it does on load and on every focus return) is refused without a second sentence; a new page is told once', async () => {
    const t = await privateEventWithMemberChatting();
    await join(t.strangerSock, t.sessionId);
    await join(t.strangerSock, t.sessionId);
    await join(t.strangerSock, t.sessionId);
    expect(inRoom(t.strangerSock, t.sessionId)).toBe(false);
    expect(present(t.sessionId, t.stranger)).toBe(false);
    expect(t.strangerSock.got).toEqual([{ event: 'error', payload: POD_ONLY }]);
    const refreshed = connect(t.stranger);
    await join(refreshed, t.sessionId);
    expectRefused(refreshed, t.sessionId, POD_ONLY);
    // Their refused pages never evicted the member's.
    expect(inRoom(t.memberSock, t.sessionId)).toBe(true);
  });

  it('a page refused for one reason is still told a different one (a failed check, then the pod)', async () => {
    const t = await privateEventWithMemberChatting();
    failTheAdmissionCheck();
    await join(t.strangerSock, t.sessionId);
    mockQuery.mockImplementation(fakeQuery);
    await join(t.strangerSock, t.sessionId);
    expect(t.strangerSock.got).toEqual([
      { event: 'error', payload: { code: 'JOIN_FAILED', message: 'You could not join this event. Refresh the page to try again.' } },
      { event: 'error', payload: POD_ONLY },
    ]);
  });

  it('someone whose request to join the pod is still waiting for approval is refused the same way', async () => {
    const ev = event({ visibility: 'invite_only' });
    const applicant = person('Applicant');
    podMember(ev.podId, applicant, 'pending_approval');
    const s = connect(applicant);
    await join(s, ev.sessionId);
    expectRefused(s, ev.sessionId, POD_ONLY);
  });

  it('someone who left the pod is refused the same way', async () => {
    const ev = event({ visibility: 'private' });
    const former = person('Former');
    podMember(ev.podId, former, 'left');
    const s = connect(former);
    await join(s, ev.sessionId);
    expectRefused(s, ev.sessionId, POD_ONLY);
  });

  it('a socket let in earlier and no longer admitted (a co-host stood down, with no participant row) is taken out of the room', async () => {
    const ev = event({ visibility: 'private' });
    const helper = person('Helper');
    world.cohosts.push({ session_id: ev.sessionId, user_id: helper, role: 'co_host' });
    const s = connect(helper);
    await join(s, ev.sessionId);
    expect(inRoom(s, ev.sessionId)).toBe(true);
    world.cohosts = [];
    s.got = [];
    await join(s, ev.sessionId);
    expect(inRoom(s, ev.sessionId)).toBe(false);
    expect(s.got).toEqual([{ event: 'error', payload: POD_ONLY }]);
  });
});

describe('when the admission read fails (fix round 1: one pool or Neon error must never drop a member)', () => {
  it('a registered member opening the page is let in: the registration proved their row', async () => {
    const ev = event({ visibility: 'private' });
    const member = person('Member');
    podMember(ev.podId, member);
    register(ev.sessionId, member);
    failTheAdmissionCheck();
    const s = connect(member);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(present(ev.sessionId, member)).toBe(true);
  });

  it('a member already in the room stays in it when their page asks again (a focus, visibility or network return)', async () => {
    const t = await privateEventWithMemberChatting();
    failTheAdmissionCheck();
    t.memberSock.got = [];
    await join(t.memberSock, t.sessionId);
    expect(inRoom(t.memberSock, t.sessionId)).toBe(true);
    expect(present(t.sessionId, t.member)).toBe(true);
    expect(events(t.memberSock)).not.toContain('error');
  });

  it('a co-host with no participant row, already in the room, is not taken out of it either', async () => {
    const ev = event({ visibility: 'private' });
    const helper = person('Helper');
    world.cohosts.push({ session_id: ev.sessionId, user_id: helper, role: 'co_host' });
    const s = connect(helper);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    failTheAdmissionCheck();
    s.got = [];
    await join(s, ev.sessionId);
    expect(inRoom(s, ev.sessionId)).toBe(true);
    expect(events(s)).not.toContain('error');
  });

  it('within the reconnect grace: a member who dropped comes back on a new socket and is let in, the grace cancelled', async () => {
    const ev = event({ visibility: 'private', status: 'round_active' });
    const member = person('Member');
    podMember(ev.podId, member);
    register(ev.sessionId, member, 'disconnected');
    const graceExpired = jest.fn();
    disconnectTimeouts.set(`${ev.sessionId}:${member}`, setTimeout(graceExpired, 15_000));
    failTheAdmissionCheck();
    const s = connect(member);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(disconnectTimeouts.has(`${ev.sessionId}:${member}`)).toBe(false);
    jest.advanceTimersByTime(16_000);
    expect(graceExpired).not.toHaveBeenCalled();
    expect(present(ev.sessionId, member)).toBe(true);
  });

  it('a stranger is still refused: asked once more, then told to refresh', async () => {
    const t = await privateEventWithMemberChatting();
    failTheAdmissionCheck();
    await join(t.strangerSock, t.sessionId);
    expectRefused(t.strangerSock, t.sessionId, RETRY);
  });

  it('a stranger whose second read comes back is refused as not a member', async () => {
    const t = await privateEventWithMemberChatting();
    failTheAdmissionCheck(1);
    await join(t.strangerSock, t.sessionId);
    expectRefused(t.strangerSock, t.sessionId, POD_ONLY);
  });
});

describe('a removal is terminal: nothing a removed person sends undoes it (fix round 1)', () => {
  /** A member who was in the event, then kicked: the kick's own writes (the status, the room, the presence). */
  async function kickedMember() {
    const t = await privateEventWithMemberChatting();
    await sessionService.updateParticipantStatus(t.sessionId, t.member, ParticipantStatus.REMOVED);
    t.memberSock.leave(sessionRoom(t.sessionId));
    setPresence(t.sessionId, t.member, null);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    return t;
  }
  const EVICTED = [{ event: 'session:evicted', payload: { reason: 'removed_from_event' } }];

  it('their page leaving (production\'s client sends session:leave when they click away from the recap) leaves them removed', async () => {
    const t = await kickedMember();
    await handleLeaveSession(io, asSocket(t.memberSock), { sessionId: t.sessionId });
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    const back = connect(t.member);
    await join(back, t.sessionId);
    expect(back.got).toEqual(EVICTED);
    await expect(sessionService.generateLiveKitToken(t.sessionId, t.member)).rejects.toThrow('User is not a participant in this event');
  });

  it('presence:ready (crafted; production\'s client never sends it) changes nothing', async () => {
    const t = await kickedMember();
    await handleReady(io, asSocket(t.memberSock), { sessionId: t.sessionId });
    await handleReady(io, asSocket(connect(t.member)), { sessionId: t.sessionId });
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    const back = connect(t.member);
    await join(back, t.sessionId);
    expect(back.got).toEqual(EVICTED);
    await expect(sessionService.generateLiveKitToken(t.sessionId, t.member)).rejects.toThrow('User is not a participant in this event');
  });

  it('no status write moves a removed row: not the state machine\'s fallback, not its own write, not the reconciler', async () => {
    const t = await kickedMember();
    // The state machine refuses every move out of REMOVED and used to fall back to a plain write.
    for (const st of [ParticipantStatus.LEFT, ParticipantStatus.IN_LOBBY, ParticipantStatus.DISCONNECTED, ParticipantStatus.CHECKED_IN]) {
      await sessionService.updateParticipantStatus(t.sessionId, t.member, st);
    }
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    // With nothing held in memory for them (after a restart, or a kick on another instance) the transition writes.
    activeSessions.get(t.sessionId)!.participantStates?.delete(t.member);
    await sessionService.updateParticipantStatus(t.sessionId, t.member, ParticipantStatus.LEFT);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    // That left memory saying LEFT; the reconciler writes memory into the database.
    expect(activeSessions.get(t.sessionId)!.participantStates?.get(t.member)?.state).toBe('left');
    await reconcileSessionStates(t.sessionId);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    expect(activeSessions.get(t.sessionId)!.participantStates?.get(t.member)?.state).toBe('removed');
    // With no event held in memory at all, the legacy write runs.
    activeSessions.delete(t.sessionId);
    await sessionService.updateParticipantStatus(t.sessionId, t.member, ParticipantStatus.LEFT);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
  });

  it('a fresh personal invite still re-admits them (the registration\'s own write), and they come back in', async () => {
    const t = await kickedMember();
    await sessionService.registerParticipant(t.sessionId, t.member, undefined, { allowRemovedReadmit: true });
    expect(statusOf(t.sessionId, t.member)).toBe('registered');
    const back = connect(t.member);
    await join(back, t.sessionId);
    expectAdmitted(back, t.sessionId);
    expect(statusOf(t.sessionId, t.member)).toBe('in_lobby');
  });

  it('a stranger\'s presence:ready leaves no trace of them in the event', async () => {
    const t = await privateEventWithMemberChatting();
    await handleReady(io, asSocket(t.strangerSock), { sessionId: t.sessionId });
    expect(activeSessions.get(t.sessionId)!.participantStates?.has(t.stranger) ?? false).toBe(false);
  });
});

describe('Leave Event from a page the event never let in (fix round 1)', () => {
  it('does nothing beyond leaving: no status write, nobody told, nothing held for them', async () => {
    const t = await privateEventWithMemberChatting();
    await join(t.strangerSock, t.sessionId);
    // The member's own join scheduled a list broadcast: let it go out before the stranger leaves.
    jest.advanceTimersByTime(400);
    await flush();
    t.hostSock.got = []; t.memberSock.got = [];
    const statusWrites = jest.spyOn(sessionService, 'updateParticipantStatus');
    await handleLeaveSession(io, asSocket(t.strangerSock), { sessionId: t.sessionId });
    jest.advanceTimersByTime(400);
    await flush();
    expect(statusWrites).not.toHaveBeenCalled();
    expect(t.hostSock.got).toEqual([]);
    expect(t.memberSock.got).toEqual([]);
    expect(activeSessions.get(t.sessionId)!.participantStates?.has(t.stranger) ?? false).toBe(false);
  });

  it('a member\'s Leave Event still marks them left and tells the room', async () => {
    const t = await privateEventWithMemberChatting();
    t.hostSock.got = [];
    await handleLeaveSession(io, asSocket(t.memberSock), { sessionId: t.sessionId });
    expect(statusOf(t.sessionId, t.member)).toBe('left');
    expect(t.hostSock.got).toContainEqual({ event: 'participant:left', payload: { userId: t.member, isHost: false } });
  });
});

describe('presence:room_joined (fix round 1): only someone in that match, or a host visiting it, is put in its room', () => {
  async function roundWithOneRoom() {
    const t = await privateEventWithMemberChatting();
    const partner = person('Partner');
    podMember(t.podId, partner);
    register(t.sessionId, partner);
    const partnerSock = connect(partner);
    await join(partnerSock, t.sessionId);
    const matchId = randomUUID();
    const roomId = `match-${t.sessionId}-r1-${matchId.slice(0, 8)}`;
    world.matches.push({ id: matchId, session_id: t.sessionId, room_id: roomId, a: t.member, b: partner, c: null, status: 'active' });
    return { ...t, partner, partnerSock, matchId, roomId };
  }
  const roomOf = (sessionId: string, userId: string) => activeSessions.get(sessionId)?.roomParticipants?.get(userId)?.roomId ?? null;

  it('the two in the match are put in its room; a stranger naming it is not, and receives none of its chat', async () => {
    const t = await roundWithOneRoom();
    const claim = { sessionId: t.sessionId, matchId: t.matchId, roomId: t.roomId };
    await handleRoomJoined(io, asSocket(t.memberSock), claim);
    await handleRoomJoined(io, asSocket(t.partnerSock), claim);
    await handleRoomJoined(io, asSocket(t.strangerSock), claim);
    expect(roomOf(t.sessionId, t.member)).toBe(t.roomId);
    expect(roomOf(t.sessionId, t.partner)).toBe(t.roomId);
    expect(roomOf(t.sessionId, t.stranger)).toBeNull();
    t.strangerSock.got = [];
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Just us two', scope: 'room' });
    expect(chatTexts(t.partnerSock)).toContain('Just us two');
    expect(t.strangerSock.got).toEqual([]);
  });

  it('someone else in the event, a wrong room id, and a removed person are not put in it', async () => {
    const t = await roundWithOneRoom();
    const other = person('Other');
    podMember(t.podId, other);
    register(t.sessionId, other);
    const otherSock = connect(other);
    await join(otherSock, t.sessionId);
    await handleRoomJoined(io, asSocket(otherSock), { sessionId: t.sessionId, matchId: t.matchId, roomId: t.roomId });
    await handleRoomJoined(io, asSocket(t.memberSock), { sessionId: t.sessionId, matchId: t.matchId, roomId: 'some-other-room' });
    await sessionService.updateParticipantStatus(t.sessionId, t.partner, ParticipantStatus.REMOVED);
    await handleRoomJoined(io, asSocket(t.partnerSock), { sessionId: t.sessionId, matchId: t.matchId, roomId: t.roomId });
    expect(roomOf(t.sessionId, other)).toBeNull();
    expect(roomOf(t.sessionId, t.member)).toBeNull();
    expect(roomOf(t.sessionId, t.partner)).toBeNull();
  });

  it('the host visiting the room is put in it', async () => {
    const t = await roundWithOneRoom();
    await handleRoomJoined(io, asSocket(t.hostSock), { sessionId: t.sessionId, matchId: t.matchId, roomId: t.roomId });
    expect(roomOf(t.sessionId, t.host)).toBe(t.roomId);
  });
});

describe('a person never invited to an invite-only pod\'s event', () => {
  it('is refused, before the event starts and while it runs', async () => {
    for (const status of ['scheduled', 'round_active']) {
      const ev = event({ visibility: 'invite_only', status });
      const outsider = connect(person('Outsider'));
      await join(outsider, ev.sessionId);
      expectRefused(outsider, ev.sessionId, POD_ONLY);
    }
  });
});

describe('an event that is over', () => {
  it('someone who never took part is told it has ended (or was cancelled), and does not join its room', async () => {
    const ended = event({ visibility: 'public', status: 'completed' });
    const a = connect(person('Visitor'));
    await join(a, ended.sessionId);
    expectRefused(a, ended.sessionId, { code: 'EVENT_ENDED', message: 'This event has ended.' });

    const cancelled = event({ visibility: 'public', status: 'cancelled' });
    const b = connect(person('Visitor'));
    await join(b, cancelled.sessionId);
    expectRefused(b, cancelled.sessionId, { code: 'EVENT_ENDED', message: 'This event was cancelled.' });
  });

  it('someone who took part (and left at the end) still opens it', async () => {
    const ev = event({ visibility: 'private', status: 'completed' });
    const took = person('TookPart');
    podMember(ev.podId, took);
    register(ev.sessionId, took, 'left');
    const s = connect(took);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
  });
});

// ── Removed: the bounce is exactly as it was ────────────────────────────────

describe('a removed participant', () => {
  it('is evicted exactly as before: session:evicted removed_from_event, nothing else, not in the room', async () => {
    const ev = event({ visibility: 'private' });
    const kicked = person('Kicked');
    podMember(ev.podId, kicked);
    register(ev.sessionId, kicked, 'removed');
    const s = connect(kicked);
    await join(s, ev.sessionId);
    expect(s.got).toEqual([{ event: 'session:evicted', payload: { reason: 'removed_from_event' } }]);
    expect(inRoom(s, ev.sessionId)).toBe(false);
    expect(present(ev.sessionId, kicked)).toBe(false);
  });

  it('gets the same bounce when the event is full (the registration says SESSION_FULL before it looks at their row)', async () => {
    const ev = event({ visibility: 'public', maxParticipants: 2 });
    const other = person('Other');
    register(ev.sessionId, other);
    const kicked = person('Kicked');
    register(ev.sessionId, kicked, 'removed');
    const s = connect(kicked);
    await join(s, ev.sessionId);
    expect(s.got).toEqual([{ event: 'session:evicted', payload: { reason: 'removed_from_event' } }]);
    expect(inRoom(s, ev.sessionId)).toBe(false);
  });

  it('gets the same bounce from an event that is over, or after leaving its pod', async () => {
    const ended = event({ visibility: 'public', status: 'completed' });
    const k1 = person('Kicked');
    register(ended.sessionId, k1, 'removed');
    const s1 = connect(k1);
    await join(s1, ended.sessionId);
    expect(s1.got).toEqual([{ event: 'session:evicted', payload: { reason: 'removed_from_event' } }]);

    const priv = event({ visibility: 'private' });
    const k2 = person('Kicked');
    register(priv.sessionId, k2, 'removed');
    const s2 = connect(k2);
    await join(s2, priv.sessionId);
    expect(s2.got).toEqual([{ event: 'session:evicted', payload: { reason: 'removed_from_event' } }]);
    expect(inRoom(s2, priv.sessionId)).toBe(false);
  });
});

// ── Admitted: everyone the event lets in still gets in ─────────────────────

describe('the people an event admits', () => {
  it('the host, even when they are not a member of the private pod and have no participant row', async () => {
    const ev = event({ visibility: 'private' });
    world.podMembers = world.podMembers.filter((m) => m.user_id !== ev.host);
    world.participants = world.participants.filter((p) => p.user_id !== ev.host);
    const s = connect(ev.host);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(present(ev.sessionId, ev.host)).toBe(true);
  });

  it('a co-host and a moderator who are not members of the private pod', async () => {
    for (const role of ['co_host', 'moderator']) {
      const ev = event({ visibility: 'private' });
      const helper = person('Helper');
      world.cohosts.push({ session_id: ev.sessionId, user_id: helper, role });
      const s = connect(helper);
      await join(s, ev.sessionId);
      expectAdmitted(s, ev.sessionId);
      expect(present(ev.sessionId, helper)).toBe(true);
    }
  });

  it('an admin or super admin acting as host on a pod they are not in, and on an event that is over', async () => {
    for (const role of ['admin', 'super_admin']) {
      const live = event({ visibility: 'private' });
      const a = person('Admin');
      const s = connect(a, role);
      await join(s, live.sessionId);
      expectAdmitted(s, live.sessionId);

      const ended = event({ visibility: 'private', status: 'completed' });
      const s2 = connect(a, role);
      await join(s2, ended.sessionId);
      expectAdmitted(s2, ended.sessionId);
    }
  });

  it('a registered participant, who receives the chat so far and the chat from then on', async () => {
    const ev = event({ visibility: 'private' });
    const hostSock = connect(ev.host);
    await join(hostSock, ev.sessionId);
    await handleChatSend(io, asSocket(hostSock), { sessionId: ev.sessionId, message: 'Welcome', scope: 'lobby' });
    const member = person('Member');
    podMember(ev.podId, member);
    register(ev.sessionId, member);
    const s = connect(member);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(s.got.find((g) => g.event === 'chat:history')?.payload.messages.map((m: { message: string }) => m.message)).toEqual(['Welcome']);
    await handleChatSend(io, asSocket(s), { sessionId: ev.sessionId, message: 'Thanks', scope: 'lobby' });
    expect(chatTexts(hostSock)).toEqual(['Welcome', 'Thanks']);
  });

  it('a participant who left comes back in, and is in the main room again', async () => {
    const ev = event({ visibility: 'private' });
    const leaver = person('Leaver');
    podMember(ev.podId, leaver);
    register(ev.sessionId, leaver, 'left');
    const s = connect(leaver);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(present(ev.sessionId, leaver)).toBe(true);
    expect(world.participants.find((p) => p.user_id === leaver)?.status).toBe('in_lobby');
  });

  it('a participant who left comes back in even when the event has filled up since', async () => {
    const ev = event({ visibility: 'public', maxParticipants: 2 });
    register(ev.sessionId, person('Other'));
    const leaver = person('Leaver');
    register(ev.sessionId, leaver, 'left');
    const s = connect(leaver);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
  });

  it('a participant reconnecting within the disconnect grace: the grace is cancelled and they are present again', async () => {
    const ev = event({ visibility: 'private', status: 'round_active' });
    const member = person('Member');
    podMember(ev.podId, member);
    register(ev.sessionId, member, 'disconnected');
    const graceExpired = jest.fn();
    disconnectTimeouts.set(`${ev.sessionId}:${member}`, setTimeout(graceExpired, 15_000));
    const s = connect(member);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(disconnectTimeouts.has(`${ev.sessionId}:${member}`)).toBe(false);
    jest.advanceTimersByTime(16_000);
    expect(graceExpired).not.toHaveBeenCalled();
    expect(present(ev.sessionId, member)).toBe(true);
  });

  it('a refresh or a second tab: the new socket is let in and the old one is told it moved', async () => {
    const ev = event({ visibility: 'private' });
    const member = person('Member');
    podMember(ev.podId, member);
    register(ev.sessionId, member, 'in_lobby');
    const first = connect(member);
    await join(first, ev.sessionId);
    const second = connect(member);
    await join(second, ev.sessionId);
    expectAdmitted(second, ev.sessionId);
    expect(first.got).toContainEqual({ event: 'session:evicted', payload: { reason: 'Connected from another tab or device' } });
    expect(activeSessions.get(ev.sessionId)!.presenceMap.get(member)?.socketId).toBe(second.id);
  });

  it('a late joiner: an active member of the private pod is registered on this join, let in, and the plan repaired', async () => {
    const ev = event({ visibility: 'private', status: 'round_active' });
    const late = person('Late');
    podMember(ev.podId, late);
    const s = connect(late);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(world.participants.find((p) => p.user_id === late)?.status).toBe('in_lobby');
    expect(mockRepairFutureRounds).toHaveBeenCalledWith(ev.sessionId, 2, 'late_joiner', expect.any(Set));
  });

  it('a member of a PUBLIC pod is added to the pod, registered and let in', async () => {
    const ev = event({ visibility: 'public' });
    const visitor = person('Visitor');
    const s = connect(visitor);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(world.podMembers.find((m) => m.user_id === visitor)?.status).toBe('active');
    expect(world.participants.find((p) => p.user_id === visitor)?.status).toBe('in_lobby');
  });

  it('an active member of an INVITE-ONLY pod is registered and let in', async () => {
    const ev = event({ visibility: 'invite_only' });
    const member = person('Member');
    podMember(ev.podId, member);
    const s = connect(member);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(present(ev.sessionId, member)).toBe(true);
  });

  it('their heartbeats keep them present; one that arrives before their own join is dropped, then the join marks them', async () => {
    const ev = event({ visibility: 'private' });
    const member = person('Member');
    podMember(ev.podId, member);
    register(ev.sessionId, member);
    const s = connect(member);
    const host = connect(ev.host);
    await join(host, ev.sessionId);
    handleHeartbeat(asSocket(s), { sessionId: ev.sessionId });
    expect(present(ev.sessionId, member)).toBe(false);
    await join(s, ev.sessionId);
    expect(present(ev.sessionId, member)).toBe(true);
    activeSessions.get(ev.sessionId)!.presenceMap.delete(member);
    handleHeartbeat(asSocket(s), { sessionId: ev.sessionId });
    expect(activeSessions.get(ev.sessionId)!.presenceMap.get(member)?.socketId).toBe(s.id);
  });
});

// ── Full: unchanged on purpose ──────────────────────────────────────────────

describe('a person refused only because the event is full keeps today\'s behaviour', () => {
  it('joins the room as before: state, presence and the lobby chat, but no registration', async () => {
    const ev = event({ visibility: 'public', maxParticipants: 2 });
    const member = person('Member');
    register(ev.sessionId, member);
    const memberSock = connect(member);
    const hostSock = connect(ev.host);
    await join(hostSock, ev.sessionId);
    await join(memberSock, ev.sessionId);
    const over = person('OverCapacity');
    const s = connect(over);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
    expect(present(ev.sessionId, over)).toBe(true);
    expect(world.participants.some((p) => p.user_id === over)).toBe(false);
    await handleChatSend(io, asSocket(memberSock), { sessionId: ev.sessionId, message: 'Busy one', scope: 'lobby' });
    expect(chatTexts(s)).toEqual(['Busy one']);
  });

  it('a registered participant of a full event is let in as before', async () => {
    const ev = event({ visibility: 'private', maxParticipants: 2 });
    const member = person('Member');
    podMember(ev.podId, member);
    register(ev.sessionId, member);
    const s = connect(member);
    await join(s, ev.sessionId);
    expectAdmitted(s, ev.sessionId);
  });
});

// ── A refused join changes nothing elsewhere ────────────────────────────────

describe('a refused join leaves the person\'s other event alone', () => {
  it('a member present in one event who opens a private event they are not admitted to stays present in the first', async () => {
    const mine = event({ visibility: 'private' });
    const me = person('Member');
    podMember(mine.podId, me);
    register(mine.sessionId, me);
    const tab1 = connect(me);
    await join(tab1, mine.sessionId);
    expect(present(mine.sessionId, me)).toBe(true);

    const theirs = event({ visibility: 'private' });
    const tab2 = connect(me);
    await join(tab2, theirs.sessionId);
    expectRefused(tab2, theirs.sessionId, POD_ONLY);
    expect(present(mine.sessionId, me)).toBe(true);
    expect(inRoom(tab1, mine.sessionId)).toBe(true);
  });

  it('an admitted join to another event still moves them, as before', async () => {
    const first = event({ visibility: 'private' });
    const me = person('Member');
    podMember(first.podId, me);
    register(first.sessionId, me);
    const tab1 = connect(me);
    await join(tab1, first.sessionId);

    const second = event({ visibility: 'public' });
    const tab2 = connect(me);
    await join(tab2, second.sessionId);
    expectAdmitted(tab2, second.sessionId);
    expect(present(first.sessionId, me)).toBe(false);
    expect(present(second.sessionId, me)).toBe(true);
  });
});
