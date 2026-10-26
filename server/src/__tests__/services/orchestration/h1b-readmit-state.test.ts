// ─── The state machine's one way out of REMOVED, and who writes a removal (H1b, 26 Oct 2026) ──────────
//
// A host's personal invite made after a kick is the one way back from it. The database takes it in the invite
// accept; readmitParticipant makes memory and the canonical doc (Redis) follow, and the reconciler follows a row the
// database has lifted instead of writing the removal back. A removal is written by the kick alone, every time: the
// reconciler writes one from memory only to finish a kick whose own write did not reach the database (it failed, or
// found no row), stamped with the kick's own time, and keeps it until that write has changed a row. Rows read while a
// kick's write was still on its way, or before the kick was made, are never taken as lifting it. What is left to
// finish is saved with the event and restored after a restart. A removal both sides agree on is left as it is.
//
// The state machine, the canonical doc and the restart's restore are the real ones, over a fake database
// (participant rows) and a fake Redis.

const store = new Map<string, string>();
const fakeRedis = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; }),
  keys: jest.fn(async (pattern: string) => [...store.keys()].filter((k) => k.startsWith(pattern.replace(/\*$/, '')))),
  del: jest.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
};
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => fakeRedis, __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../services/email/email.service', () => ({ __esModule: true }));

type Row = { user_id: string; status: string; joined_at: Date | null; left_at: Date | null };
const rows = new Map<string, Row>();
let failNextWrite = false;
/** The fake database: each answer is worked out when the query arrives, as Postgres reads its snapshot then. */
async function fakeQuery(sql: string, params: unknown[] = []) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  // A status write (the state machine's, and the reconciler's). The userId is always the last parameter.
  if (flat.startsWith('UPDATE session_participants SET status = $1')) {
    if (failNextWrite) { failNextWrite = false; throw new Error('Connection terminated unexpectedly'); }
    const r = rows.get(params[params.length - 1] as string);
    if (!r || (flat.includes("status <> 'removed'") && r.status === 'removed')) return { rows: [], rowCount: 0 };
    r.status = params[0] as string;
    if (flat.includes('left_at = NOW()')) r.left_at = new Date();
    else if (flat.includes('left_at = $2')) r.left_at = params[1] as Date;
    return { rows: [], rowCount: 1 };
  }
  if (flat === 'SELECT user_id, status, joined_at FROM session_participants WHERE session_id = $1') {
    return { rows: [...rows.values()].map((r) => ({ user_id: r.user_id, status: r.status, joined_at: r.joined_at })), rowCount: rows.size };
  }
  // The restart's warm-up of memory from the rows (fix round 2: with when a removal was made).
  if (flat === 'SELECT user_id, status, current_room_id, left_at FROM session_participants WHERE session_id = $1') {
    return { rows: [...rows.values()].map((r) => ({ user_id: r.user_id, status: r.status, current_room_id: null, left_at: r.left_at })), rowCount: rows.size };
  }
  if (flat === 'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2') {
    const r = rows.get(params[1] as string);
    return { rows: r ? [{ status: r.status }] : [], rowCount: r ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
}
const mockQuery = jest.fn(fakeQuery);
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  __esModule: true,
}));

import type { Server as SocketServer } from 'socket.io';
import { SessionStatus } from '@rsn/shared';
import { activeSessions, persistSessionState, type ActiveSession } from '../../../services/orchestration/state/session-state';
import {
  ParticipantState, readmitAfterPersonalInvite, readmitParticipant, reconcileSessionStates, transitionParticipant,
} from '../../../services/orchestration/state/participant-state-machine';
import { readCanonical, updateCanonicalParticipant, writeCanonical, liftCanonicalRemoval } from '../../../services/orchestration/state/canonical-state';
import { recoverActiveSessions } from '../../../services/orchestration/handlers/round-lifecycle';

const EVENT = 'event-h1b';
const MEMBER = 'member-1';
const OTHER = 'member-2';
const A_MINUTE_AGO = () => new Date(Date.now() - 60_000);

function event(): ActiveSession {
  const s = {
    sessionId: EVENT, hostUserId: 'host-1', config: {}, currentRound: 1, status: SessionStatus.LOBBY_OPEN,
    timer: null, timerSyncInterval: null, timerEndsAt: null, isPaused: false, pausedTimeRemaining: null,
    presenceMap: new Map(), pendingRoundNumber: null, manuallyLeftRound: new Set<string>(), participantStates: new Map(),
  } as unknown as ActiveSession;
  activeSessions.set(EVENT, s);
  return s;
}
const row = (userId: string, status: string, leftAt: Date | null = null): Row =>
  ({ user_id: userId, status, joined_at: status === 'registered' ? null : new Date(), left_at: leftAt });
const memory = (userId: string) => activeSessions.get(EVENT)?.participantStates?.get(userId)?.state ?? null;
/** What memory holds for someone, recorded at `at` (now unless said). */
const setMemory = (userId: string, state: ParticipantState, at = new Date()) =>
  activeSessions.get(EVENT)!.participantStates!.set(userId, { state, currentRoomId: null, updatedAt: at });
const unsaved = (userId: string) => activeSessions.get(EVENT)?.unsavedRemovals?.has(userId) ?? false;
const connStateOf = async (userId: string) => (await readCanonical(EVENT))?.participants[userId]?.connState ?? null;
/** The writes to participant rows among the calls (the event's own saves are not counted). */
const participantWrites = (calls: unknown[][]) => calls.filter(([sql]) => /^UPDATE session_participants/.test(String(sql).trim()));
/** Let the fire-and-forget writes (canonical doc, the event's save) finish. */
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
/** Until the clock has moved on, so what happens next is strictly later than what happened before. */
const aMomentLater = async () => { const now = Date.now(); while (Date.now() <= now) await new Promise((r) => setImmediate(r)); };
/** A promise and the function that settles it. */
function later(): { done: Promise<void>; release: () => void } {
  let release!: () => void;
  const done = new Promise<void>((r) => { release = r; });
  return { done, release };
}

async function canonicalWith(connStates: Record<string, string>) {
  const participants: Record<string, unknown> = {};
  for (const [uid, connState] of Object.entries(connStates)) {
    participants[uid] = { role: 'participant', connState, location: { type: 'main' }, lastSeenAt: 0, userSeq: 1 };
  }
  await writeCanonical({
    sessionId: EVENT, status: SessionStatus.LOBBY_OPEN, currentRound: 1, seq: 1, hostUserId: 'host-1', timer: null,
    participants,
  } as unknown as Parameters<typeof writeCanonical>[0]);
}

beforeEach(() => {
  store.clear();
  rows.clear();
  activeSessions.clear();
  failNextWrite = false;
  mockQuery.mockReset();
  mockQuery.mockImplementation(fakeQuery);
});
afterEach(() => activeSessions.clear());

describe('readmitParticipant: the one way out of REMOVED', () => {
  it('a removal from before the moment given is lifted, in memory and in the canonical doc', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED, A_MINUTE_AGO());
    await canonicalWith({ [MEMBER]: 'removed' });
    expect(readmitParticipant(EVENT, MEMBER, ParticipantState.REGISTERED, Date.now())).toBe(true);
    expect(memory(MEMBER)).toBe(ParticipantState.REGISTERED);
    await settle();
    expect(await connStateOf(MEMBER)).toBe('disconnected');
  });

  it('changes nothing for someone memory does not hold as removed (a leaver re-registered by a personal invite)', async () => {
    event();
    setMemory(MEMBER, ParticipantState.LEFT, A_MINUTE_AGO());
    await canonicalWith({ [MEMBER]: 'left' });
    expect(readmitParticipant(EVENT, MEMBER, ParticipantState.REGISTERED, Date.now())).toBe(false);
    expect(memory(MEMBER)).toBe(ParticipantState.LEFT);
    await settle();
    expect(await connStateOf(MEMBER)).toBe('left');
  });

  it('lifts only a removal recorded before the moment given: one recorded since then stays, with its canonical doc', async () => {
    event();
    const readAt = Date.now();
    setMemory(MEMBER, ParticipantState.REMOVED, new Date(readAt - 1));
    setMemory(OTHER, ParticipantState.REMOVED, new Date(readAt));
    await canonicalWith({ [MEMBER]: 'removed', [OTHER]: 'removed' });
    expect(readmitParticipant(EVENT, MEMBER, ParticipantState.IN_MAIN_ROOM, readAt)).toBe(true);
    expect(readmitParticipant(EVENT, OTHER, ParticipantState.IN_MAIN_ROOM, readAt)).toBe(false);
    expect(memory(MEMBER)).toBe(ParticipantState.IN_MAIN_ROOM);
    expect(memory(OTHER)).toBe(ParticipantState.REMOVED);
    await settle();
    expect(await connStateOf(MEMBER)).toBe('disconnected');
    expect(await connStateOf(OTHER)).toBe('removed');
  });

  it('the transition table still gives REMOVED no exits: only this function lifts it', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED);
    for (const to of [ParticipantState.REGISTERED, ParticipantState.IN_MAIN_ROOM, ParticipantState.LEFT]) {
      expect(await transitionParticipant(EVENT, MEMBER, to, { persistToDb: false })).toMatchObject({ ok: false, reason: 'ILLEGAL_TRANSITION' });
    }
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
  });

  it('the canonical lift never overwrites the connection the person\'s join wrote first', async () => {
    event();
    await canonicalWith({ [MEMBER]: 'removed' });
    void updateCanonicalParticipant(EVENT, MEMBER, { connState: 'connected' });
    await liftCanonicalRemoval(EVENT, MEMBER);
    expect(await connStateOf(MEMBER)).toBe('connected');
    await canonicalWith({ [OTHER]: 'removed' });
    void liftCanonicalRemoval(EVENT, OTHER);
    await updateCanonicalParticipant(EVENT, OTHER, { connState: 'connected' });
    expect(await connStateOf(OTHER)).toBe('connected');
  });
});

describe('readmitAfterPersonalInvite: memory follows the database once a personal invite has been accepted', () => {
  it('a removal from before the invite is lifted when the database has them in the event, to the row\'s own state', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED, A_MINUTE_AGO());
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    expect(await readmitAfterPersonalInvite(EVENT, MEMBER, new Date())).toBe(true);
    expect(memory(MEMBER)).toBe(ParticipantState.IN_MAIN_ROOM);
  });

  it('a removal made after the invite stands, and so does one the database still has', async () => {
    event();
    const invitedAt = A_MINUTE_AGO();
    setMemory(MEMBER, ParticipantState.REMOVED, new Date());
    rows.set(MEMBER, row(MEMBER, 'registered'));
    expect(await readmitAfterPersonalInvite(EVENT, MEMBER, invitedAt)).toBe(false);
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    setMemory(OTHER, ParticipantState.REMOVED, A_MINUTE_AGO());
    rows.set(OTHER, row(OTHER, 'removed', A_MINUTE_AGO()));
    expect(await readmitAfterPersonalInvite(EVENT, OTHER, new Date())).toBe(false);
    expect(memory(OTHER)).toBe(ParticipantState.REMOVED);
  });

  it('an event this process does not hold reads nothing', async () => {
    expect(await readmitAfterPersonalInvite(EVENT, MEMBER, new Date())).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('the kick writes every removal, and keeps one the database has not taken', () => {
  it('a kick whose write landed leaves nothing to finish', async () => {
    event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(unsaved(MEMBER)).toBe(false);
  });

  it('a kick of someone memory already holds as removed is written all the same (memory may hold a lifted removal)', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED, A_MINUTE_AGO());
    rows.set(MEMBER, row(MEMBER, 'registered'));
    expect(await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED)).toMatchObject({ ok: true });
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    expect(unsaved(MEMBER)).toBe(false);
    // Kicking a removed row again changes nothing in the database, and the reconciler has nothing left to finish.
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(unsaved(MEMBER)).toBe(false);
  });

  it('a kick whose own write failed is finished by the reconciler once, stamped with the kick\'s own time', async () => {
    const s = event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    failNextWrite = true;
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    expect(rows.get(MEMBER)!.status).toBe('in_lobby');
    const kickedAt = s.unsavedRemovals!.get(MEMBER)!;
    expect(kickedAt).toBe(s.participantStates!.get(MEMBER)!.updatedAt.getTime());
    await aMomentLater();
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(rows.get(MEMBER)!.left_at!.getTime()).toBe(kickedAt);
    expect(unsaved(MEMBER)).toBe(false);
    mockQuery.mockClear();
    await reconcileSessionStates(EVENT);
    expect(participantWrites(mockQuery.mock.calls)).toEqual([]);
  });

  it('a kick that found no row is written by the reconciler once a row appears (a later registration)', async () => {
    event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    expect(unsaved(MEMBER)).toBe(true);
    rows.set(MEMBER, row(MEMBER, 'registered'));
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    expect(unsaved(MEMBER)).toBe(false);
  });

  it('the reconciler keeps an unfinished kick when its write changed no row (the row went away meanwhile)', async () => {
    event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    failNextWrite = true;
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    // The reconciler reads the row; it is deleted (an unregister) before the reconciler writes it.
    mockQuery.mockImplementationOnce(async (sql: string, params?: unknown[]) => {
      const read = await fakeQuery(sql, params);
      rows.delete(MEMBER);
      return read;
    });
    await reconcileSessionStates(EVENT);
    expect(unsaved(MEMBER)).toBe(true);
    // When the person registers again, the kick is finished.
    rows.set(MEMBER, row(MEMBER, 'registered'));
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(unsaved(MEMBER)).toBe(false);
  });

  it('an unfinished kick is saved with the event and restored after a restart, then finished, not lifted', async () => {
    const s = event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    await canonicalWith({ [MEMBER]: 'connected' });
    failNextWrite = true;
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    const kickedAt = s.unsavedRemovals!.get(MEMBER)!;
    await persistSessionState(EVENT, s);
    await settle();
    expect(JSON.parse(store.get(`rsn:session:${EVENT}`)!).unsavedRemovals).toEqual({ [MEMBER]: kickedAt });

    // The restart: memory comes back from Redis, the rows and the canonical doc (which says removed).
    activeSessions.clear();
    await recoverActiveSessions({} as SocketServer);
    const restored = activeSessions.get(EVENT)!;
    expect([...restored.unsavedRemovals!.entries()]).toEqual([[MEMBER, kickedAt]]);
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    await aMomentLater();
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(rows.get(MEMBER)!.left_at!.getTime()).toBe(kickedAt);
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
  });

  // Fix round 2 (26 Oct 2026, re-review): a restart used to stamp every removal memory holds with the restart's time, so
  // a personal invite made before the restart was refused in memory, and an unfinished kick restored from Redis was
  // written back over the person the host had just invited back.
  it('after a restart, memory\'s record of a removal carries the kick\'s time from the row: a personal invite made after the kick, before the restart, lifts it at once', async () => {
    const kickedAt = new Date(Date.now() - 120_000);
    rows.set(MEMBER, row(MEMBER, 'removed', kickedAt));
    const s = event();
    await persistSessionState(EVENT, s);
    await settle();
    activeSessions.clear();
    await recoverActiveSessions({} as SocketServer);
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    expect(activeSessions.get(EVENT)!.participantStates!.get(MEMBER)!.updatedAt.getTime()).toBe(kickedAt.getTime());
    // The host's invite was made a minute ago; its accept lifted the row, and memory follows the database at once.
    rows.set(MEMBER, row(MEMBER, 'registered'));
    expect(await readmitAfterPersonalInvite(EVENT, MEMBER, new Date(Date.now() - 60_000))).toBe(true);
    expect(memory(MEMBER)).toBe(ParticipantState.REGISTERED);
  });

  it('an unfinished kick restored after a restart keeps the kick\'s own time as the bound: a personal invite made after the kick lifts it, and the tick leaves them in', async () => {
    const s = event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    await canonicalWith({ [MEMBER]: 'connected' });
    failNextWrite = true;
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    const kickedAt = s.unsavedRemovals!.get(MEMBER)!;
    expect(rows.get(MEMBER)!.status).toBe('in_lobby');
    await aMomentLater();
    const invitedAt = new Date();
    await aMomentLater();
    await persistSessionState(EVENT, s);
    await settle();
    activeSessions.clear();
    await recoverActiveSessions({} as SocketServer);
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    expect(activeSessions.get(EVENT)!.unsavedRemovals!.get(MEMBER)).toBe(kickedAt);
    // The invite's accept answered "already registered" (the row was never removed); memory follows the database.
    expect(await readmitAfterPersonalInvite(EVENT, MEMBER, invitedAt)).toBe(true);
    expect(activeSessions.get(EVENT)!.unsavedRemovals?.has(MEMBER) ?? false).toBe(false);
    await aMomentLater();
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('in_lobby');
    expect(memory(MEMBER)).toBe(ParticipantState.IN_MAIN_ROOM);
  });
});

describe('the reconciler writes no removal of its own, and follows one the database lifted', () => {
  it('a row the database lifted is followed: memory and the canonical doc take the row\'s state, nothing is written', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED, A_MINUTE_AGO());
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    await canonicalWith({ [MEMBER]: 'removed' });
    mockQuery.mockClear();
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('in_lobby');
    expect(memory(MEMBER)).toBe(ParticipantState.IN_MAIN_ROOM);
    expect(participantWrites(mockQuery.mock.calls)).toEqual([]);
    await settle();
    expect(await connStateOf(MEMBER)).toBe('disconnected');
  });

  it('a removal both sides hold is left exactly as it is, the canonical doc included', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED, A_MINUTE_AGO());
    rows.set(MEMBER, row(MEMBER, 'removed', A_MINUTE_AGO()));
    await canonicalWith({ [MEMBER]: 'removed' });
    await reconcileSessionStates(EVENT);
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    await settle();
    expect(await connStateOf(MEMBER)).toBe('removed');
  });

  it('a kick still being written when the rows were read is not lifted by them, though its write lands first', async () => {
    event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    // The kick's write is on its way: it lands when committed.
    const commit = later();
    mockQuery.mockImplementationOnce(async (sql: string, params?: unknown[]) => { await commit.done; return fakeQuery(sql, params); });
    const kicking = transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    // A moment later (the removal is older than the read), the reconciler reads the rows, from before the commit;
    // its answer reaches it after the kick's.
    await aMomentLater();
    const answer = later();
    mockQuery.mockImplementationOnce(async (sql: string, params?: unknown[]) => { const rowsRead = await fakeQuery(sql, params); await answer.done; return rowsRead; });
    const reconciling = reconcileSessionStates(EVENT);
    commit.release();
    await kicking;
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(unsaved(MEMBER)).toBe(false);
    answer.release();
    await reconciling;
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    expect(rows.get(MEMBER)!.status).toBe('removed');
  });

  it('a kick made after the rows were read is not lifted by them, though its write lands before they arrive', async () => {
    event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    const answer = later();
    mockQuery.mockImplementationOnce(async (sql: string, params?: unknown[]) => { const rowsRead = await fakeQuery(sql, params); await answer.done; return rowsRead; });
    const reconciling = reconcileSessionStates(EVENT);
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    answer.release();
    await reconciling;
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    // The next tick reads the removal and keeps it.
    await reconcileSessionStates(EVENT);
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    expect(rows.get(MEMBER)!.status).toBe('removed');
  });

  it('a removal the database has is not left to finish, so a later lift of the row is followed, not undone', async () => {
    const s = event();
    // The kick's write reached the database, but its answer was lost: memory still counts it as unsaved.
    setMemory(MEMBER, ParticipantState.REMOVED, A_MINUTE_AGO());
    (s.unsavedRemovals ??= new Map()).set(MEMBER, Date.now() - 60_000);
    rows.set(MEMBER, row(MEMBER, 'removed', A_MINUTE_AGO()));
    await reconcileSessionStates(EVENT);
    expect(unsaved(MEMBER)).toBe(false);
    // The database takes them back where memory does not see it (a restart, another process).
    rows.get(MEMBER)!.status = 'registered';
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('registered');
    expect(memory(MEMBER)).toBe(ParticipantState.REGISTERED);
  });

  it('a personal invite made after a kick whose write failed wins: following the database drops the unfinished removal', async () => {
    const s = event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, row(MEMBER, 'in_lobby'));
    failNextWrite = true;
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    expect(s.unsavedRemovals?.has(MEMBER)).toBe(true);
    await aMomentLater();
    // The invite's accept: the row was never removed ("already registered"), and memory follows it afterwards.
    expect(await readmitAfterPersonalInvite(EVENT, MEMBER, new Date())).toBe(true);
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('in_lobby');
    expect(memory(MEMBER)).toBe(ParticipantState.IN_MAIN_ROOM);
    expect(s.unsavedRemovals?.has(MEMBER)).toBe(false);
  });
});
