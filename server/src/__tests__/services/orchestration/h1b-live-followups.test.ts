// ─── Live-event follow-ups after the room gate (H1b, 26 Oct 2026) ─────────────────────────────────────
//
// Found by the H1 reviews and the meeting-room work, each on production's live path:
//   1. A host's fresh personal invite re-admitted a kicked member in the database, but the in-memory state machine
//      still said REMOVED (REMOVED has no exits) and the 30-second reconciler wrote `removed` back: the member was
//      thrown out again within half a minute of coming back.
//   2. registerParticipant's re-register write had no removal guard. An invite accept and the REST register run
//      outside the event's guard, so a kick landing between its read and its write was undone.
//   Fix round 1: a personal invite lifts only a removal made before the host made it (an older invite, one the kick's
//   withdrawal missed or one accepted again, never undoes a later kick); memory follows the database after the
//   invite's writes, whatever the registration answered; a kick writes a removed row for someone who had none.
//   3. presence:room_joined accepted a match that had ended: a late signal for the room a member was moved out of
//      put them back in it, and their room chat went to the room they had left.
//   4. A running video meeting's chat and reactions waited for the director: a guest's message was refused with
//      "Chat is available once the host joins" the moment the director stepped out.
//
// The real kick, invite accept, registration, join, leave, move-to-room, room claim, chat, reaction, reconciler,
// video token and matching eligibility run here over a fake database (events, pods, members, participants, invites,
// matches, chat) and a fake Socket.IO server that delivers only to the sockets in a room.

// A row of the fake database. `any` because it stands for rows of several tables, each read back by its own column names.
type Row = Record<string, any>;

const world = {
  sessions: new Map<string, Row>(),
  pods: new Map<string, Row>(),
  podMembers: [] as Row[],
  participants: [] as Row[],
  cohosts: [] as Row[],
  users: new Map<string, Row>(),
  invites: [] as Row[],
  messages: [] as Row[],
  matches: [] as Row[],
};

/**
 * Runs once right after the first query that matches answers: a kick that lands between two statements. Its writes
 * are another transaction's, already committed: a rollback of the transaction it landed in keeps them.
 */
const after: { match: ((sql: string, params: unknown[]) => boolean) | null; then: () => void } = { match: null, then: () => {} };
/** The same, run once right before the first query that matches is answered (it then reads the kick's writes). */
const before: { match: ((sql: string, params: unknown[]) => boolean) | null; then: () => void } = { match: null, then: () => {} };
/** Writes committed by another transaction while one was open (see `after`). */
let committedElsewhere: Array<() => void> = [];
/** Makes the first status write that matches throw, as a dropped connection would. */
const failOnce: { match: ((sql: string, params: unknown[]) => boolean) | null } = { match: null };

async function fakeQuery(sql: string, params: unknown[] = []) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  if (failOnce.match?.(flat, params)) { failOnce.match = null; throw new Error('Connection terminated unexpectedly'); }
  if (before.match?.(flat, params)) { before.match = null; before.then(); }
  const result = answer(flat, params);
  if (after.match?.(flat, params)) {
    after.match = null;
    after.then();
    committedElsewhere.push(after.then);
  }
  return result;
}
const mockQuery = jest.fn(fakeQuery);
/** The tables a transaction can change; a transaction that throws leaves them as they were, as Postgres does. */
const snapshot = () => ({
  podMembers: world.podMembers.map((r) => ({ ...r })),
  participants: world.participants.map((r) => ({ ...r })),
  matches: world.matches.map((r) => ({ ...r })),
});
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  transaction: async (cb: (client: unknown) => unknown) => {
    const saved = snapshot();
    committedElsewhere = [];
    try {
      return await cb({ query: (sql: string, params?: unknown[]) => mockQuery(sql, params) });
    } catch (err) {
      Object.assign(world, saved);
      for (const write of committedElsewhere) write();
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
  createMatchRoom: jest.fn(async () => ({})),
  evictFromRoom: jest.fn(async () => {}),
  listParticipants: jest.fn(async () => []),
  lobbyRoomId: (sid: string) => `lobby-${sid}`,
  matchRoomId: (sid: string, round: number, slug: string) => `match-${sid}-r${round}-${slug}`,
  __esModule: true,
}));
const mockRepairFutureRounds = jest.fn(async () => ({ regeneratedRounds: [] as number[] }));
// Matching eligibility is the real one (the single source of truth the algorithm and the host's count use).
jest.mock('../../../services/matching/matching.service', () => ({
  ...jest.requireActual('../../../services/matching/matching.service'),
  getMatchesByRound: jest.fn(async () => []),
  repairFutureRounds: (...args: unknown[]) => (mockRepairFutureRounds as jest.Mock)(...args),
  __esModule: true,
}));
jest.mock('../../../services/rating/rating.service', () => ({
  finalizeSessionEncounters: jest.fn(async () => {}),
  __esModule: true,
}));
// Who may act as host: the event's director.
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: jest.fn(async (userId: string, _role: string, sessionId: string) => {
    const allowed = world.sessions.get(sessionId)?.host_user_id === userId;
    return { allowed, effectiveRole: allowed ? 'host' : 'participant' };
  }),
  __esModule: true,
}));
// A pod invite's or event invite's membership step: an active member is already in (production's ConflictError code).
jest.mock('../../../services/pod/pod.service', () => ({
  addMember: jest.fn(async (podId: string, userId: string) => {
    const m = world.podMembers.find((r) => r.pod_id === podId && r.user_id === userId);
    if (m?.status === 'active') throw Object.assign(new Error('Already a member'), { code: 'POD_MEMBER_EXISTS' });
    if (m) m.status = 'active';
    else world.podMembers.push({ pod_id: podId, user_id: userId, role: 'member', status: 'active' });
    return {};
  }),
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({ sendInviteEmail: jest.fn(), __esModule: true }));
jest.mock('../../../services/circle/circle.service', () => ({ joinCircle: jest.fn(), __esModule: true }));
// A video token is signed by LiveKit's SDK; here it only needs to be made.
jest.mock('livekit-server-sdk', () => ({
  AccessToken: class {
    addGrant(): void { /* the grant is not read here */ }
    async toJwt(): Promise<string> { return 'livekit-token'; }
  },
  __esModule: true,
}));

import { randomUUID } from 'crypto';
import type { Server as SocketServer, Socket } from 'socket.io';
import { ParticipantStatus } from '@rsn/shared';
import {
  activeSessions, disconnectTimeouts, sessionRoom, userRoom,
} from '../../../services/orchestration/state/session-state';
import {
  handleJoinSession, handleLeaveSession, handleRoomJoined, setRoomAssignment,
} from '../../../services/orchestration/handlers/participant-flow';
import { handleChatSend, handleReactionSend } from '../../../services/orchestration/handlers/chat-handlers';
import { handleHostRemoveParticipant, handleHostMoveToRoom } from '../../../services/orchestration/handlers/host-actions';
import { reconcileSessionStates } from '../../../services/orchestration/state/participant-state-machine';
import * as sessionService from '../../../services/session/session.service';
import { acceptInvite } from '../../../services/invite/invite.service';
import { getEligibleParticipants } from '../../../services/matching/matching.service';

// ── The fake database ────────────────────────────────────────────────────────

type Answer = { rows: Row[]; rowCount?: number };

function participant(sessionId: unknown, userId: unknown): Row | undefined {
  return world.participants.find((p) => p.session_id === sessionId && p.user_id === userId);
}
const inMatch = (m: Row, userId: unknown) => [m.a, m.b, m.c].includes(userId);

/** An invite as INVITE_COLUMNS reads it. */
function inviteRow(i: Row): Row {
  return {
    id: i.id, code: i.code, type: i.type, inviterId: i.inviter_id, inviteeEmail: i.invitee_email, podId: i.pod_id,
    sessionId: i.session_id, circleId: null, status: i.status, maxUses: i.max_uses, useCount: i.use_count,
    expiresAt: i.expires_at, acceptedByUserId: i.accepted_by_user_id, acceptedAt: i.accepted_at,
    createdAt: i.created_at, updatedAt: i.created_at,
  };
}

function answer(sql: string, params: unknown[]): Answer {
  const [a, b] = params;
  if (sql === 'SELECT display_name FROM users WHERE id = $1') {
    const u = world.users.get(a as string);
    return { rows: u ? [{ display_name: u.display_name }] : [] };
  }
  if (sql === 'SELECT role::text AS role FROM users WHERE id = $1') {
    const u = world.users.get(a as string);
    return { rows: u ? [{ role: u.role }] : [] };
  }
  if (sql === 'SELECT id, display_name FROM users WHERE id = ANY($1)') {
    return { rows: (a as string[]).map((id) => world.users.get(id)).filter(Boolean).map((u) => ({ id: u!.id, display_name: u!.display_name })) };
  }
  // getSessionById and the registration's own read of the event (SESSION_COLUMNS).
  if (/pod_id AS "podId"/.test(sql) && /FROM sessions WHERE id = \$1$/.test(sql) && /hostUserId/.test(sql)) {
    const s = world.sessions.get(a as string);
    return {
      rows: s ? [{
        id: s.id, podId: s.pod_id, title: 'H1b event', description: null, status: s.status, currentRound: s.current_round,
        config: s.config, hostUserId: s.host_user_id, lobbyRoomId: null, hostVisibilityMode: null, format: s.event_format,
        startedAt: new Date(),
      }] : [],
    };
  }
  if (sql === 'SELECT host_user_id FROM sessions WHERE id = $1') {
    const s = world.sessions.get(a as string);
    return { rows: s ? [{ host_user_id: s.host_user_id }] : [] };
  }
  if (sql === 'SELECT status FROM sessions WHERE id = $1') {
    const s = world.sessions.get(a as string);
    return { rows: s ? [{ status: s.status }] : [] };
  }
  if (sql === 'SELECT pod_id AS "podId" FROM sessions WHERE id = $1') {
    const s = world.sessions.get(a as string);
    return { rows: s ? [{ podId: s.pod_id }] : [] };
  }
  if (sql === 'SELECT visibility FROM pods WHERE id = $1') {
    const p = world.pods.get(a as string);
    return { rows: p ? [{ visibility: p.visibility }] : [] };
  }
  if (sql === "SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active'") {
    return { rows: world.podMembers.filter((m) => m.pod_id === a && m.user_id === b && m.status === 'active') };
  }
  if (sql === "SELECT COUNT(*) as count FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left')") {
    return { rows: [{ count: String(world.participants.filter((p) => p.session_id === a && !['removed', 'left'].includes(p.status)).length) }] };
  }
  if (sql === "SELECT COUNT(*) as count FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')") {
    return { rows: [{ count: String(world.participants.filter((p) => p.session_id === a && !['removed', 'left', 'no_show'].includes(p.status)).length) }] };
  }
  // The registration's read of the person's row (with when a removal of theirs was made), and the plain re-read.
  if (sql === 'SELECT id, status, left_at FROM session_participants WHERE session_id = $1 AND user_id = $2'
      || sql === 'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    const p = participant(a, b);
    return { rows: p ? [{ id: p.id, status: p.status, left_at: p.left_at ?? null }] : [] };
  }
  // The video token's read of the person's row.
  if (sql === 'SELECT * FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    const p = participant(a, b);
    return { rows: p ? [{ ...p }] : [] };
  }
  // A status write: the state machine's, the legacy fallback's and the reconciler's all start this way. One that
  // carries the removal guard leaves a removed row as it is, as Postgres would. A removal or a leave is stamped with
  // the time of the write (NOW()) or the time it is given (the reconciler finishing a kick passes the kick's own, $2).
  if (sql.startsWith('UPDATE session_participants SET status = $1')) {
    const p = participant(params[params.length - 2], params[params.length - 1]);
    if (!p || (sql.includes("status <> 'removed'") && p.status === 'removed')) return { rows: [], rowCount: 0 };
    p.status = params[0];
    if (['in_lobby', 'checked_in'].includes(p.status) && !p.joined_at) p.joined_at = new Date();
    if (sql.includes('left_at = NOW()')) p.left_at = new Date();
    else if (sql.includes('left_at = $2')) p.left_at = params[1];
    else if (sql.includes('left_at = NULL')) p.left_at = null;
    return { rows: [], rowCount: 1 };
  }
  // The registration's re-register write, its guard as Postgres evaluates it against the row at write time: a removed
  // row is written only for a host's personal invite ($3) made after its removal (a removal with no time on it, any).
  if (sql.startsWith("UPDATE session_participants SET status = 'registered', left_at = NULL, is_no_show = FALSE")) {
    const p = participant(a, b);
    if (!p) return { rows: [], rowCount: 0 };
    const invitedAt = params[2] as Date | null;
    if (p.status === 'removed' && !(invitedAt && (!p.left_at || p.left_at < invitedAt))) return { rows: [], rowCount: 0 };
    p.status = 'registered';
    p.left_at = null;
    return { rows: [{ ...p }], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO session_participants (session_id, user_id, status, acting_as_host)')) {
    if (participant(a, b)) return { rows: [], rowCount: 0 };
    const p = { id: randomUUID(), session_id: a, user_id: b, status: 'registered', joined_at: null, left_at: null };
    world.participants.push(p);
    return { rows: [{ ...p }], rowCount: 1 };
  }
  // The invite accept's insert for a row that vanished meanwhile. A personal invite's ($3) lifts a removed row whose
  // removal was made before the invite; a shared link's leaves it.
  if (sql.startsWith("INSERT INTO session_participants (session_id, user_id, status) VALUES ($1, $2, 'registered')")) {
    const p = participant(a, b);
    if (!p) {
      world.participants.push({ id: randomUUID(), session_id: a, user_id: b, status: 'registered', joined_at: null, left_at: null });
      return { rows: [], rowCount: 1 };
    }
    const invitedAt = params[2] as Date | undefined;
    if (/DO UPDATE SET status = 'registered'/.test(sql) && p.status === 'removed' && invitedAt && (!p.left_at || p.left_at < invitedAt)) {
      p.status = 'registered';
      p.left_at = null;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  // The kick's removed row for someone the event let in without one (a row that exists is left as it is).
  if (sql.startsWith("INSERT INTO session_participants (session_id, user_id, status, left_at) VALUES ($1, $2, 'removed', NOW())")) {
    if (participant(a, b)) return { rows: [], rowCount: 0 };
    world.participants.push({ id: randomUUID(), session_id: a, user_id: b, status: 'removed', joined_at: null, left_at: new Date() });
    return { rows: [], rowCount: 1 };
  }
  // The reconciler reads every row of the event, to write memory into it.
  if (sql === 'SELECT user_id, status, joined_at FROM session_participants WHERE session_id = $1') {
    return { rows: world.participants.filter((p) => p.session_id === a).map((p) => ({ user_id: p.user_id, status: p.status, joined_at: p.joined_at })) };
  }
  if (sql === "SELECT user_id FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')") {
    return { rows: world.participants.filter((p) => p.session_id === a && !['removed', 'left', 'no_show'].includes(p.status)).map((p) => ({ user_id: p.user_id })) };
  }
  // Matching eligibility (getEligibleParticipants), with or without the people it leaves out.
  if (sql.startsWith('SELECT sp.user_id FROM session_participants sp WHERE sp.session_id = $1 AND sp.status NOT IN')) {
    const excluded = sql.includes('!= ALL($2::uuid[])') ? (b as string[]) : [];
    return {
      rows: world.participants
        .filter((p) => p.session_id === a && !['removed', 'left', 'no_show', 'disconnected'].includes(p.status))
        .filter((p) => !excluded.includes(p.user_id))
        .filter((p) => !world.matches.some((m) => m.session_id === a && m.status === 'active' && inMatch(m, p.user_id)))
        .map((p) => ({ user_id: p.user_id })),
    };
  }
  // Who may say they are in a breakout room (presence:room_joined): the match, its event and the caller. The
  // match's status is read as the real query reads it.
  if (/FROM matches m JOIN sessions s ON s\.id = m\.session_id/.test(sql)) {
    const [matchId, sessionId, who, roomId] = params;
    const m = world.matches.find((r) => r.id === matchId && r.session_id === sessionId && r.room_id === roomId
      && (!sql.includes("m.status = 'active'") || r.status === 'active'));
    if (!m) return { rows: [] };
    return {
      rows: [{
        in_match: inMatch(m, who),
        is_host: world.sessions.get(sessionId as string)?.host_user_id === who,
        is_cohost: world.cohosts.some((c) => c.session_id === sessionId && c.user_id === who),
        participant_status: participant(sessionId, who)?.status ?? null,
      }],
    };
  }
  // The kick's look for the member's active match.
  if (sql.startsWith('SELECT id, participant_a_id, participant_b_id, participant_c_id, room_id FROM matches WHERE session_id = $1 AND status = \'active\'')) {
    const m = world.matches.find((r) => r.session_id === a && r.status === 'active' && inMatch(r, b));
    return { rows: m ? [{ id: m.id, participant_a_id: m.a, participant_b_id: m.b, participant_c_id: m.c, room_id: m.room_id }] : [] };
  }
  // Move-to-room: the member's current match in this round, then the target room's.
  if (sql.startsWith('SELECT id, participant_a_id, participant_b_id, room_id FROM matches WHERE session_id = $1 AND round_number = $2 AND status = \'active\'')) {
    const m = world.matches.find((r) => r.session_id === a && r.round === b && r.status === 'active' && (r.a === params[2] || r.b === params[2]));
    return { rows: m ? [{ id: m.id, participant_a_id: m.a, participant_b_id: m.b, room_id: m.room_id }] : [] };
  }
  if (sql === "SELECT id, participant_a_id, participant_b_id, room_id FROM matches WHERE id = $1 AND session_id = $2 AND status = 'active'") {
    const m = world.matches.find((r) => r.id === a && r.session_id === b && r.status === 'active');
    return { rows: m ? [{ id: m.id, participant_a_id: m.a, participant_b_id: m.b, room_id: m.room_id }] : [] };
  }
  if (sql === "UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1") {
    const m = world.matches.find((r) => r.id === a);
    if (m) m.status = 'completed';
    return { rows: [], rowCount: m ? 1 : 0 };
  }
  if (sql.startsWith('INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at, is_override)')) {
    const m = { id: randomUUID(), session_id: a, round: b, a: params[2], b: params[3], c: params[4], room_id: params[5], status: 'active' };
    world.matches.push(m);
    return { rows: [{ id: m.id }], rowCount: 1 };
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
  if (sql === 'SELECT user_id FROM session_cohosts WHERE session_id = $1 AND user_id = $2') {
    return { rows: world.cohosts.filter((c) => c.session_id === a && c.user_id === b).map((c) => ({ user_id: c.user_id })) };
  }
  // Invites: the kick withdraws the member's personal ones; the accept locks, checks and takes one.
  if (sql.startsWith("UPDATE invites SET status = 'revoked' WHERE session_id = $1 AND invitee_email = lower((SELECT email FROM users WHERE id = $2))")) {
    const email = world.users.get(b as string)?.email?.toLowerCase();
    let n = 0;
    for (const i of world.invites) {
      if (i.session_id === a && i.invitee_email === email && ['pending', 'accepted'].includes(i.status)) { i.status = 'revoked'; n++; }
    }
    return { rows: [], rowCount: n };
  }
  if (/FROM invites WHERE code = \$1 FOR UPDATE$/.test(sql)) {
    const i = world.invites.find((r) => r.code === a);
    return { rows: i ? [inviteRow(i)] : [] };
  }
  if (sql.startsWith('UPDATE invites SET use_count = use_count + 1')) {
    const i = world.invites.find((r) => r.id === b && r.use_count < r.max_uses && !['revoked', 'expired'].includes(r.status));
    if (!i) return { rows: [], rowCount: 0 };
    i.use_count++; i.status = 'accepted'; i.accepted_by_user_id ??= a; i.accepted_at ??= new Date();
    return { rows: [inviteRow(i)], rowCount: 1 };
  }
  if (/FROM invites WHERE id = \$1$/.test(sql)) {
    const i = world.invites.find((r) => r.id === a);
    return { rows: i ? [inviteRow(i)] : [] };
  }
  // The chat store and its history read.
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
const errorsOf = (s: FakeSocket) => s.got.filter((g) => g.event === 'error').map((g) => g.payload);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
/** Until the clock has moved on: the reconciler's next tick always reads later than what happened before it. */
const aMomentLater = async () => { const now = Date.now(); while (Date.now() <= now) await new Promise((r) => setImmediate(r)); };

// ── The people and the events ─────────────────────────────────────────────────

function person(name: string, role = 'member'): string {
  const id = randomUUID();
  world.users.set(id, { id, display_name: name, email: `${name.toLowerCase()}-${id.slice(0, 6)}@rsn-e2e.invalid`, role });
  return id;
}
const emailOf = (userId: string) => world.users.get(userId)!.email as string;

/** An event in a private pod; the host is the pod's director and registered, as createSession does. */
function event(opts: { status?: string; format?: string; maxParticipants?: number } = {}) {
  const podId = randomUUID();
  const sessionId = randomUUID();
  const host = person('Host');
  world.pods.set(podId, { id: podId, visibility: 'private' });
  world.podMembers.push({ pod_id: podId, user_id: host, role: 'director', status: 'active' });
  world.sessions.set(sessionId, {
    id: sessionId, pod_id: podId, host_user_id: host, status: opts.status ?? 'lobby_open', current_round: 1,
    config: opts.maxParticipants ? { maxParticipants: opts.maxParticipants } : {}, event_format: opts.format ?? 'speed_networking',
  });
  register(sessionId, host);
  return { podId, sessionId, host };
}
function podMember(podId: string, userId: string) {
  world.podMembers.push({ pod_id: podId, user_id: userId, role: 'member', status: 'active' });
}
function register(sessionId: string, userId: string, status = 'registered') {
  world.participants.push({
    id: randomUUID(), session_id: sessionId, user_id: userId, status,
    joined_at: status === 'registered' ? null : new Date(), left_at: null,
  });
}

/** An invite the host sends: personal (to the member's address) or a shared link (no address). */
function invite(sessionId: string, inviterId: string, inviteeEmail: string | null): string {
  const code = `C${randomUUID().slice(0, 8)}`;
  world.invites.push({
    id: randomUUID(), code, type: 'session', inviter_id: inviterId, invitee_email: inviteeEmail?.toLowerCase() ?? null,
    pod_id: null, session_id: sessionId, status: 'pending', max_uses: inviteeEmail ? 1 : 50, use_count: 0,
    expires_at: new Date(Date.now() + 86_400_000), accepted_by_user_id: null, accepted_at: null, created_at: new Date(),
  });
  return code;
}

async function join(s: FakeSocket, sessionId: string) {
  await handleJoinSession(io, asSocket(s), { sessionId });
  await flush();
}

const inRoom = (s: FakeSocket, sessionId: string) => s.rooms.has(sessionRoom(sessionId));
const statusOf = (sessionId: string, userId: string) => participant(sessionId, userId)?.status ?? null;
const memoryOf = (sessionId: string, userId: string) => activeSessions.get(sessionId)?.participantStates?.get(userId)?.state ?? null;
const presentSet = (sessionId: string) => new Set(activeSessions.get(sessionId)?.presenceMap.keys() ?? []);
const EVICTED = { event: 'session:evicted', payload: { reason: 'removed_from_event' } };

function expectAdmitted(s: FakeSocket, sessionId: string) {
  expect(inRoom(s, sessionId)).toBe(true);
  expect(events(s)).toContain('session:state');
  expect(events(s)).not.toContain('error');
  expect(events(s)).not.toContain('session:evicted');
}

/** A running private event: its host, a member and a partner are in the main room. */
async function liveEvent(opts: { status?: string; format?: string; maxParticipants?: number } = {}) {
  const ev = event(opts);
  const member = person('Member');
  const partner = person('Partner');
  for (const u of [member, partner]) { podMember(ev.podId, u); register(ev.sessionId, u); }
  const hostSock = connect(ev.host);
  const memberSock = connect(member);
  const partnerSock = connect(partner);
  await join(hostSock, ev.sessionId);
  await join(memberSock, ev.sessionId);
  await join(partnerSock, ev.sessionId);
  return { ...ev, member, partner, hostSock, memberSock, partnerSock };
}

/** The host kicks someone (host:remove_participant). */
async function kick(t: { sessionId: string; hostSock: FakeSocket }, userId: string) {
  await handleHostRemoveParticipant(io, asSocket(t.hostSock), { sessionId: t.sessionId, userId, reason: 'h1b' });
  await flush();
}

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['Date', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance'] });
});
afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  world.sessions.clear(); world.pods.clear(); world.users.clear();
  world.podMembers = []; world.participants = []; world.cohosts = []; world.invites = []; world.messages = []; world.matches = [];
  sockets.clear();
  activeSessions.clear();
  disconnectTimeouts.clear();
  mockRepairFutureRounds.mockClear();
  mockQuery.mockImplementation(fakeQuery);
  after.match = null;
  before.match = null;
  committedElsewhere = [];
  failOnce.match = null;
});

afterEach(() => {
  jest.clearAllTimers();
  activeSessions.clear();
});

// ── 1. A host's fresh personal invite brings a kicked member back, and they stay back ────────────────

describe('1. a kicked member re-admitted by a fresh personal invite stays in (the reconciler no longer undoes it)', () => {
  it('kick, fresh personal invite, accept, join, reconciler tick: still in, a video token, matchable, not bounced', async () => {
    const t = await liveEvent();
    await kick(t, t.member);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    expect(memoryOf(t.sessionId, t.member)).toBe('removed');
    expect(t.memberSock.got).toContainEqual({ event: 'host:participant_removed', payload: { userId: t.member, reason: 'h1b' } });

    // The host invites them back afterwards (a moment later: the invite is newer than the removal).
    await aMomentLater();
    const code = invite(t.sessionId, t.host, emailOf(t.member));
    const accepted = await acceptInvite(code, t.member, emailOf(t.member));
    expect(accepted.participantStatus).toBe('registered');
    // Memory follows the database: the state machine's one way out of REMOVED.
    expect(memoryOf(t.sessionId, t.member)).toBe('registered');

    const back = connect(t.member);
    await join(back, t.sessionId);
    expectAdmitted(back, t.sessionId);
    expect(statusOf(t.sessionId, t.member)).toBe('in_lobby');
    expect(memoryOf(t.sessionId, t.member)).toBe('in_main_room');

    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('in_lobby');
    expect(memoryOf(t.sessionId, t.member)).toBe('in_main_room');

    await expect(sessionService.generateLiveKitToken(t.sessionId, t.member)).resolves.toMatchObject({ token: 'livekit-token' });
    expect(await getEligibleParticipants(t.sessionId, [t.host], presentSet(t.sessionId))).toEqual(expect.arrayContaining([t.member, t.partner]));

    // Their page asks again on focus and on every reconnect: let in, never bounced.
    back.got = [];
    await join(back, t.sessionId);
    expectAdmitted(back, t.sessionId);
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('in_lobby');

    // And they are in the conversation both ways.
    t.partnerSock.got = [];
    await handleChatSend(io, asSocket(back), { sessionId: t.sessionId, message: 'Back again', scope: 'lobby' });
    await handleChatSend(io, asSocket(t.hostSock), { sessionId: t.sessionId, message: 'Welcome back', scope: 'lobby' });
    expect(chatTexts(t.partnerSock)).toEqual(['Back again', 'Welcome back']);
    expect(chatTexts(back)).toEqual(['Back again', 'Welcome back']);
  });

  it('re-admitted before they open the event page, they are still let in after a reconciler tick', async () => {
    const t = await liveEvent();
    await kick(t, t.member);
    await aMomentLater();
    await acceptInvite(invite(t.sessionId, t.host, emailOf(t.member)), t.member, emailOf(t.member));
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('registered');
    const back = connect(t.member);
    await join(back, t.sessionId);
    expectAdmitted(back, t.sessionId);
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('in_lobby');
  });

  it('the kick is still final for everything else: the old personal invite (withdrawn by the kick) and a shared link do not re-admit', async () => {
    const t = await liveEvent();
    const oldCode = invite(t.sessionId, t.host, emailOf(t.member));
    await kick(t, t.member);
    await expect(acceptInvite(oldCode, t.member, emailOf(t.member))).rejects.toMatchObject({ code: 'INVITE_REVOKED' });
    const shared = invite(t.sessionId, t.host, null);
    await expect(acceptInvite(shared, t.member, emailOf(t.member))).rejects.toMatchObject({ code: 'REMOVED_FROM_EVENT' });
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    expect(memoryOf(t.sessionId, t.member)).toBe('removed');
    const back = connect(t.member);
    await join(back, t.sessionId);
    expect(back.got).toEqual([EVICTED]);
    await expect(sessionService.generateLiveKitToken(t.sessionId, t.member)).rejects.toThrow('User is not a participant in this event');
  });

  it('a re-admission memory did not see (another instance, a restart) is followed at the next tick, not undone', async () => {
    const t = await liveEvent();
    await kick(t, t.member);
    // The database has them back; this process's memory still says REMOVED.
    participant(t.sessionId, t.member)!.status = 'registered';
    await aMomentLater();
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('registered');
    expect(memoryOf(t.sessionId, t.member)).toBe('registered');
    const back = connect(t.member);
    await join(back, t.sessionId);
    expectAdmitted(back, t.sessionId);
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('in_lobby');
  });

  it('a kick that lands during the accept, after the invite was made, stands: the invite\'s own insert leaves it', async () => {
    const t = await liveEvent();
    await kick(t, t.member);
    await aMomentLater();
    const code = invite(t.sessionId, t.host, emailOf(t.member));
    await aMomentLater();
    // registerParticipant takes them back (the first kick is older than the invite); then the host kicks them again,
    // right before the invite's own insert. That kick is newer than the invite: the insert must not lift it.
    before.match = (sql) => sql.startsWith("INSERT INTO session_participants (session_id, user_id, status) VALUES ($1, $2, 'registered')");
    before.then = () => {
      const p = participant(t.sessionId, t.member)!;
      p.status = 'removed';
      p.left_at = new Date();
      activeSessions.get(t.sessionId)!.participantStates!.set(t.member, { state: 'removed', currentRoomId: null, updatedAt: new Date() });
    };
    const accepted = await acceptInvite(code, t.member, emailOf(t.member));
    expect(accepted.participantStatus).toBe('removed');
    expect(memoryOf(t.sessionId, t.member)).toBe('removed');

    const back = connect(t.member);
    await join(back, t.sessionId);
    expect(back.got).toEqual([EVICTED]);
    await aMomentLater();
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    expect(memoryOf(t.sessionId, t.member)).toBe('removed');
    await expect(sessionService.generateLiveKitToken(t.sessionId, t.member)).rejects.toThrow('User is not a participant in this event');
  });

  it('a personal invite made before the kick never undoes it: accepted after it (its withdrawal failed), or accepted again', async () => {
    const t = await liveEvent();
    // Two personal invites the host made before the kick: one the member came in through, and one still pending.
    const usedCode = invite(t.sessionId, t.host, emailOf(t.member));
    Object.assign(world.invites.find((i) => i.code === usedCode)!, { status: 'accepted', use_count: 1, accepted_by_user_id: t.member, accepted_at: new Date() });
    const pendingCode = invite(t.sessionId, t.host, emailOf(t.member));
    await aMomentLater();
    // The kick's withdrawal of their personal invites fails (it is best-effort): both stay usable.
    failOnce.match = (sql) => sql.startsWith("UPDATE invites SET status = 'revoked'");
    await kick(t, t.member);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    expect(world.invites.filter((i) => i.session_id === t.sessionId && i.invitee_email).map((i) => i.status)).toEqual(['accepted', 'pending']);

    await expect(acceptInvite(pendingCode, t.member, emailOf(t.member))).rejects.toMatchObject({ code: 'REMOVED_FROM_EVENT' });
    // Accepted again and again (the idempotent re-accept a script can loop): never lifts it.
    for (let i = 0; i < 3; i++) {
      await expect(acceptInvite(usedCode, t.member, emailOf(t.member))).rejects.toMatchObject({ code: 'REMOVED_FROM_EVENT' });
    }
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    expect(memoryOf(t.sessionId, t.member)).toBe('removed');
    await aMomentLater();
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    const back = connect(t.member);
    await join(back, t.sessionId);
    expect(back.got).toEqual([EVICTED]);

    // An invite the host makes after the kick is the one way back.
    const freshCode = invite(t.sessionId, t.host, emailOf(t.member));
    expect((await acceptInvite(freshCode, t.member, emailOf(t.member))).participantStatus).toBe('registered');
    expect(memoryOf(t.sessionId, t.member)).toBe('registered');
    const again = connect(t.member);
    await join(again, t.sessionId);
    expectAdmitted(again, t.sessionId);
  });

  it('a kick whose own database write failed is still written by the reconciler, with the kick\'s own time', async () => {
    const t = await liveEvent();
    failOnce.match = (sql, params) => sql.startsWith('UPDATE session_participants SET status = $1') && params[0] === 'removed';
    await kick(t, t.member);
    expect(memoryOf(t.sessionId, t.member)).toBe('removed');
    expect(statusOf(t.sessionId, t.member)).toBe('in_lobby');
    const kickedAt = activeSessions.get(t.sessionId)!.unsavedRemovals!.get(t.member)!;
    await aMomentLater();
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    // Stamped with the kick's time, not the reconciler's: an invite the host made in between is newer than the removal.
    expect(participant(t.sessionId, t.member)!.left_at.getTime()).toBe(kickedAt);
    const back = connect(t.member);
    await join(back, t.sessionId);
    expect(back.got).toEqual([EVICTED]);
  });

  for (const row of ['in_lobby', 'in_round'] as const) {
    it(`a kick whose own write failed (row still ${row}), then a personal invite made after it: back in, the removal never written over them`, async () => {
      const t = await liveEvent();
      participant(t.sessionId, t.member)!.status = row;
      failOnce.match = (sql, params) => sql.startsWith('UPDATE session_participants SET status = $1') && params[0] === 'removed';
      await kick(t, t.member);
      expect(statusOf(t.sessionId, t.member)).toBe(row);
      expect(memoryOf(t.sessionId, t.member)).toBe('removed');
      await aMomentLater();
      // (Made directly: the invite form turns away someone whose row is live, but nothing on the accept relies on it.)
      const code = invite(t.sessionId, t.host, emailOf(t.member));
      // Their row was never removed, so the registration answers "already registered", which the accept passes on.
      await expect(acceptInvite(code, t.member, emailOf(t.member))).rejects.toMatchObject({ code: 'SESSION_ALREADY_REGISTERED' });
      // Memory follows the database anyway: nothing of the kick is left to write.
      expect(memoryOf(t.sessionId, t.member)).toBe(row === 'in_lobby' ? 'in_main_room' : 'in_breakout');
      expect(activeSessions.get(t.sessionId)!.unsavedRemovals?.has(t.member) ?? false).toBe(false);
      await aMomentLater();
      await reconcileSessionStates(t.sessionId, io);
      expect(statusOf(t.sessionId, t.member)).toBe(row);
      expect(memoryOf(t.sessionId, t.member)).not.toBe('removed');
    });
  }

  it('a full event: someone let in without a row is kicked, gets a removed row, is refused, and a personal invite made after the kick takes them back in', async () => {
    const t = await liveEvent({ maxParticipants: 3 }); // the host, the member and the partner fill it
    const extra = person('Extra');
    podMember(t.podId, extra);
    const extraSock = connect(extra);
    await join(extraSock, t.sessionId);
    expectAdmitted(extraSock, t.sessionId);
    expect(statusOf(t.sessionId, extra)).toBeNull(); // in the room, refused a row only because the event is full

    await kick(t, extra);
    expect(statusOf(t.sessionId, extra)).toBe('removed');
    const refused = connect(extra);
    await join(refused, t.sessionId);
    expect(refused.got).toEqual([EVICTED]);
    await expect(sessionService.generateLiveKitToken(t.sessionId, extra)).rejects.toThrow('User is not a participant in this event');

    await aMomentLater();
    const accepted = await acceptInvite(invite(t.sessionId, t.host, emailOf(extra)), extra, emailOf(extra));
    expect(accepted.participantStatus).toBe('registered');
    expect(memoryOf(t.sessionId, extra)).toBe('registered');
    const back = connect(extra);
    await join(back, t.sessionId);
    expectAdmitted(back, t.sessionId);
    await aMomentLater();
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, extra)).toBe('in_lobby');
    expect(memoryOf(t.sessionId, extra)).toBe('in_main_room');
    await expect(sessionService.generateLiveKitToken(t.sessionId, extra)).resolves.toMatchObject({ token: 'livekit-token' });
  });
});

// ── 2. A kick that lands between the registration's read and its write ─────────────────────────────────

describe('2. registerParticipant\'s re-register write keeps a removal the host makes while it runs', () => {
  /** A member who left the event; the host's kick will land right after the registration reads their row. */
  async function leftMemberKickedMidRegistration() {
    const t = await liveEvent();
    await handleLeaveSession(io, asSocket(t.memberSock), { sessionId: t.sessionId });
    expect(statusOf(t.sessionId, t.member)).toBe('left');
    after.match = (sql, params) => sql === 'SELECT id, status, left_at FROM session_participants WHERE session_id = $1 AND user_id = $2' && params[1] === t.member;
    after.then = () => {
      // The kick's own writes, committed between the two statements (it holds the event's guard; this does not).
      const p = participant(t.sessionId, t.member)!;
      p.status = 'removed';
      p.left_at = new Date();
      activeSessions.get(t.sessionId)!.participantStates!.set(t.member, { state: 'removed', currentRoomId: null, updatedAt: new Date() });
    };
    return t;
  }

  it('a re-registration from the page (the REST register, a join) leaves them removed, refused as removed', async () => {
    const t = await leftMemberKickedMidRegistration();
    await expect(sessionService.registerParticipant(t.sessionId, t.member)).rejects.toMatchObject({ code: 'REMOVED_FROM_EVENT' });
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
  });

  it('a shared invite link accepted at that moment leaves them removed, and the accept is refused', async () => {
    const t = await leftMemberKickedMidRegistration();
    const shared = invite(t.sessionId, t.host, null);
    await expect(acceptInvite(shared, t.member, emailOf(t.member))).rejects.toMatchObject({ code: 'REMOVED_FROM_EVENT' });
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    const back = connect(t.member);
    await join(back, t.sessionId);
    expect(back.got).toEqual([EVICTED]);
  });

  it('a personal invite made before a kick that lands at that moment does not undo it: the kick is the newer decision', async () => {
    const t = await leftMemberKickedMidRegistration();
    const code = invite(t.sessionId, t.host, emailOf(t.member));
    await aMomentLater();
    await expect(acceptInvite(code, t.member, emailOf(t.member))).rejects.toMatchObject({ code: 'REMOVED_FROM_EVENT' });
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    expect(memoryOf(t.sessionId, t.member)).toBe('removed');
    await aMomentLater();
    await reconcileSessionStates(t.sessionId, io);
    expect(statusOf(t.sessionId, t.member)).toBe('removed');
    const back = connect(t.member);
    await join(back, t.sessionId);
    expect(back.got).toEqual([EVICTED]);
  });

  it('the write itself carries the rule: a removed row is written only when its removal predates a personal invite', async () => {
    const t = await liveEvent();
    await handleLeaveSession(io, asSocket(t.memberSock), { sessionId: t.sessionId });
    await handleLeaveSession(io, asSocket(t.partnerSock), { sessionId: t.sessionId });
    mockQuery.mockClear();
    const invitedAt = new Date();
    await sessionService.registerParticipant(t.sessionId, t.member);
    await sessionService.registerParticipant(t.sessionId, t.partner, undefined, { personalInviteCreatedAt: invitedAt });
    const writes = mockQuery.mock.calls
      .map(([sql, params]) => ({ sql: String(sql).replace(/\s+/g, ' '), params: params as unknown[] }))
      .filter((c) => c.sql.includes("UPDATE session_participants SET status = 'registered', left_at = NULL"));
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.sql).toContain("WHERE session_id = $1 AND user_id = $2 AND (status <> 'removed' OR ($3::timestamptz IS NOT NULL AND (left_at IS NULL OR left_at < $3::timestamptz)))");
    }
    expect(writes.map((w) => w.params)).toEqual([[t.sessionId, t.member, null], [t.sessionId, t.partner, invitedAt]]);
  });
});

// ── 3. A room claim needs the room's match to be running ───────────────────────────────────────────────

describe('3. presence:room_joined for a room whose match has ended is ignored', () => {
  /** Round 1 running: the member and the partner in room R1, two others in room R2. */
  async function roundWithTwoRooms() {
    const t = await liveEvent({ status: 'round_active' });
    const others = [person('Third'), person('Fourth')];
    const otherSocks: FakeSocket[] = [];
    for (const u of others) {
      podMember(t.podId, u); register(t.sessionId, u);
      const s = connect(u); await join(s, t.sessionId); otherSocks.push(s);
    }
    const r1 = { id: randomUUID(), session_id: t.sessionId, round: 1, a: t.member, b: t.partner, c: null, room_id: `match-${t.sessionId}-r1-one`, status: 'active' };
    const r2 = { id: randomUUID(), session_id: t.sessionId, round: 1, a: others[0], b: others[1], c: null, room_id: `match-${t.sessionId}-r1-two`, status: 'active' };
    world.matches.push(r1, r2);
    setRoomAssignment(t.sessionId, r1.id, r1.room_id, [t.member, t.partner]);
    setRoomAssignment(t.sessionId, r2.id, r2.room_id, others);
    return { ...t, others, otherSocks, r1, r2 };
  }
  const roomOf = (sessionId: string, userId: string) => activeSessions.get(sessionId)?.roomParticipants?.get(userId)?.roomId ?? null;

  it('the host moves the member to another room; their late signal for the old room does not put them back in it', async () => {
    const t = await roundWithTwoRooms();
    await handleHostMoveToRoom(io, asSocket(t.hostSock), { sessionId: t.sessionId, userId: t.member, targetMatchId: t.r2.id });
    await flush();
    const moved = world.matches.find((m) => m.status === 'active' && inMatch(m, t.member))!;
    expect(moved).toBeDefined();
    expect(roomOf(t.sessionId, t.member)).toBe(moved.room_id);
    expect(world.matches.find((m) => m.id === t.r1.id)?.status).toBe('completed');

    // The member's LiveKit connect to the old room resolves late and its page says so.
    await handleRoomJoined(io, asSocket(t.memberSock), { sessionId: t.sessionId, matchId: t.r1.id, roomId: t.r1.room_id });
    expect(roomOf(t.sessionId, t.member)).toBe(moved.room_id);

    // Their room message goes to the room they are in, not to the partner they left.
    for (const s of [t.partnerSock, ...t.otherSocks]) s.got = [];
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Hello new room', scope: 'room' });
    for (const s of t.otherSocks) expect(chatTexts(s)).toEqual(['Hello new room']);
    expect(chatTexts(t.partnerSock)).toEqual([]);
  });

  it('a claim for a match that ended is ignored; a claim for the running one still counts, for its people and a visiting host', async () => {
    const t = await roundWithTwoRooms();
    t.r1.status = 'completed';
    activeSessions.get(t.sessionId)!.roomParticipants!.delete(t.partner);
    await handleRoomJoined(io, asSocket(t.partnerSock), { sessionId: t.sessionId, matchId: t.r1.id, roomId: t.r1.room_id });
    expect(roomOf(t.sessionId, t.partner)).toBeNull();
    activeSessions.get(t.sessionId)!.roomParticipants!.delete(t.others[0]);
    await handleRoomJoined(io, asSocket(t.otherSocks[0]), { sessionId: t.sessionId, matchId: t.r2.id, roomId: t.r2.room_id });
    expect(roomOf(t.sessionId, t.others[0])).toBe(t.r2.room_id);
    await handleRoomJoined(io, asSocket(t.hostSock), { sessionId: t.sessionId, matchId: t.r2.id, roomId: t.r2.room_id });
    expect(roomOf(t.sessionId, t.host)).toBe(t.r2.room_id);
  });
});

// ── 4. A running meeting's chat and reactions do not wait for the director ─────────────────────────────

describe('4. chat and reactions in a running video meeting while the director is out', () => {
  /** The director stepped out (Leave, or their page closed): no longer present. */
  async function directorOut(t: { sessionId: string; hostSock: FakeSocket; host: string }) {
    await handleLeaveSession(io, asSocket(t.hostSock), { sessionId: t.sessionId });
    expect(activeSessions.get(t.sessionId)!.presenceMap.has(t.host)).toBe(false);
  }

  it('a guest\'s message is stored and reaches the other guests, and their reaction too', async () => {
    const t = await liveEvent({ format: 'video_meeting' });
    await directorOut(t);
    t.memberSock.got = []; t.partnerSock.got = [];
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Shall we start without them?', scope: 'lobby' });
    expect(errorsOf(t.memberSock)).toEqual([]);
    expect(chatTexts(t.partnerSock)).toEqual(['Shall we start without them?']);
    expect(chatTexts(t.memberSock)).toEqual(['Shall we start without them?']);
    expect(world.messages.map((m) => m.content)).toEqual(['Shall we start without them?']);

    await handleReactionSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, type: 'wave' });
    expect(t.partnerSock.got.filter((g) => g.event === 'reaction:received').map((g) => g.payload.type)).toEqual(['wave']);
  });

  it('a new client\'s acknowledgement says it was sent', async () => {
    const t = await liveEvent({ format: 'video_meeting' });
    await directorOut(t);
    const ack = jest.fn();
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Anyone here?', scope: 'lobby', clientId: randomUUID() }, ack);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('speed networking keeps its lobby gate exactly as now: refused with the sentence, the reaction dropped', async () => {
    const t = await liveEvent({ format: 'speed_networking' });
    await directorOut(t);
    t.memberSock.got = []; t.partnerSock.got = [];
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Hello?', scope: 'lobby' });
    expect(errorsOf(t.memberSock)).toEqual([{ code: 'CHAT_DISABLED', message: 'Chat is available once the host joins' }]);
    expect(chatTexts(t.partnerSock)).toEqual([]);
    expect(world.messages).toEqual([]);
    await handleReactionSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, type: 'wave' });
    expect(events(t.partnerSock)).not.toContain('reaction:received');
  });

  it('a meeting the director has not started yet waits for the director, as before', async () => {
    const t = await liveEvent({ format: 'video_meeting', status: 'scheduled' });
    await directorOut(t);
    t.memberSock.got = [];
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Early', scope: 'lobby' });
    expect(errorsOf(t.memberSock)).toEqual([{ code: 'CHAT_DISABLED', message: 'Chat is available once the host joins' }]);
    await handleReactionSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, type: 'wave' });
    expect(events(t.partnerSock)).not.toContain('reaction:received');
  });

  it('with the director in the meeting, nothing changes', async () => {
    const t = await liveEvent({ format: 'video_meeting' });
    t.partnerSock.got = [];
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'Hi all', scope: 'lobby' });
    expect(chatTexts(t.partnerSock)).toEqual(['Hi all']);
    expect(chatTexts(t.hostSock)).toContain('Hi all');
  });

  it('the meeting\'s status, not the guest, decides: a stranger outside the room is still refused', async () => {
    const t = await liveEvent({ format: 'video_meeting' });
    await directorOut(t);
    const stranger = connect(person('Stranger'));
    await handleChatSend(io, asSocket(stranger), { sessionId: t.sessionId, message: 'let me in', scope: 'lobby' });
    expect(errorsOf(stranger)).toEqual([{ code: 'NOT_IN_SESSION', message: 'You are not in this event.' }]);
    expect(world.messages).toEqual([]);
  });

  it('a removed guest is not let back into the conversation by it', async () => {
    const t = await liveEvent({ format: 'video_meeting' });
    await kick(t, t.member);
    await directorOut(t);
    await handleChatSend(io, asSocket(t.memberSock), { sessionId: t.sessionId, message: 'still here?', scope: 'lobby' });
    expect(errorsOf(t.memberSock)).toEqual([{ code: 'NOT_IN_SESSION', message: 'You are not in this event.' }]);
    expect(world.messages).toEqual([]);
    expect(statusOf(t.sessionId, t.member)).toBe(ParticipantStatus.REMOVED);
  });
});
