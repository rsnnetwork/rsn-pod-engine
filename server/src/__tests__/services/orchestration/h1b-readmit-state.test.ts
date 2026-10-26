// ─── The state machine's one way out of REMOVED, and who writes a removal (H1b, 26 Oct 2026) ──────────
//
// A host's fresh personal invite is the one way back from a kick. The database takes it in registerParticipant;
// readmitParticipant makes memory and the canonical doc (Redis) follow, and the reconciler follows a row the
// database has lifted instead of writing the removal back. A removal is written by the kick alone, every time: the
// reconciler writes one from memory only to finish a kick whose own write did not reach the database (it failed, or
// found no row). Rows read while a kick's write was still on its way, or before the kick was made, are never taken as
// lifting it. A removal that both sides agree on is left exactly as it is.
//
// The state machine and the canonical doc are the real ones, over a fake database (participant rows) and a fake Redis.

const store = new Map<string, string>();
const fakeRedis = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  setex: jest.fn(async (k: string, _ttl: number, v: string) => { store.set(k, v); return 'OK'; }),
};
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => fakeRedis, __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

type Row = { user_id: string; status: string; joined_at: Date | null };
const rows = new Map<string, Row>();
let failNextWrite = false;
/** The fake database: each answer is worked out when the query arrives, as Postgres reads its snapshot then. */
async function fakeQuery(sql: string, params: unknown[] = []) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  if (flat.startsWith('UPDATE session_participants SET status = $1')) {
    if (failNextWrite) { failNextWrite = false; throw new Error('Connection terminated unexpectedly'); }
    const r = rows.get(params[params.length - 1] as string);
    if (!r || (flat.includes("status <> 'removed'") && r.status === 'removed')) return { rows: [], rowCount: 0 };
    r.status = params[0] as string;
    return { rows: [], rowCount: 1 };
  }
  if (flat === 'SELECT user_id, status, joined_at FROM session_participants WHERE session_id = $1') {
    return { rows: [...rows.values()].map((r) => ({ ...r })), rowCount: rows.size };
  }
  return { rows: [], rowCount: 0 };
}
const mockQuery = jest.fn(fakeQuery);
jest.mock('../../../db', () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  __esModule: true,
}));

import { SessionStatus } from '@rsn/shared';
import { activeSessions, type ActiveSession } from '../../../services/orchestration/state/session-state';
import {
  ParticipantState, readmitParticipant, reconcileSessionStates, transitionParticipant,
} from '../../../services/orchestration/state/participant-state-machine';
import { readCanonical, updateCanonicalParticipant, writeCanonical, liftCanonicalRemoval } from '../../../services/orchestration/state/canonical-state';

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
const memory = (userId: string) => activeSessions.get(EVENT)?.participantStates?.get(userId)?.state ?? null;
/** What memory holds for someone, recorded at `at` (now unless said). */
const setMemory = (userId: string, state: ParticipantState, at = new Date()) =>
  activeSessions.get(EVENT)!.participantStates!.set(userId, { state, currentRoomId: null, updatedAt: at });
const unsaved = (userId: string) => activeSessions.get(EVENT)?.unsavedRemovals?.has(userId) ?? false;
const connStateOf = async (userId: string) => (await readCanonical(EVENT))?.participants[userId]?.connState ?? null;
const writesIn = (calls: unknown[][]) => calls.filter(([sql]) => /^UPDATE/.test(String(sql).trim()));
/** Let the canonical doc's fire-and-forget writes finish. */
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
  it('a removed member is registered again in memory, and the canonical doc stops calling them removed', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED);
    await canonicalWith({ [MEMBER]: 'removed' });
    expect(readmitParticipant(EVENT, MEMBER)).toBe(true);
    expect(memory(MEMBER)).toBe(ParticipantState.REGISTERED);
    await settle();
    expect(await connStateOf(MEMBER)).toBe('disconnected');
  });

  it('changes nothing for someone memory does not hold as removed (a leaver re-registered by a personal invite)', async () => {
    event();
    setMemory(MEMBER, ParticipantState.LEFT);
    await canonicalWith({ [MEMBER]: 'left' });
    expect(readmitParticipant(EVENT, MEMBER)).toBe(false);
    expect(memory(MEMBER)).toBe(ParticipantState.LEFT);
    await settle();
    expect(await connStateOf(MEMBER)).toBe('left');
  });

  it('given a moment, it lifts only a removal recorded before it: one recorded since then stays, with its canonical doc', async () => {
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

describe('the kick writes every removal, and keeps one the database has not taken', () => {
  it('a kick whose write landed leaves nothing to finish', async () => {
    event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, { user_id: MEMBER, status: 'in_lobby', joined_at: new Date() });
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(unsaved(MEMBER)).toBe(false);
  });

  it('a kick of someone memory already holds as removed is written all the same (memory may hold a lifted removal)', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED, A_MINUTE_AGO());
    rows.set(MEMBER, { user_id: MEMBER, status: 'registered', joined_at: null });
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

  it('a kick whose own write failed is remembered, and the reconciler finishes it once (then nothing more)', async () => {
    const s = event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, { user_id: MEMBER, status: 'in_lobby', joined_at: new Date() });
    failNextWrite = true;
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    expect(rows.get(MEMBER)!.status).toBe('in_lobby');
    expect(s.unsavedRemovals?.has(MEMBER)).toBe(true);
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(s.unsavedRemovals?.has(MEMBER)).toBe(false);
    mockQuery.mockClear();
    await reconcileSessionStates(EVENT);
    expect(writesIn(mockQuery.mock.calls)).toEqual([]);
  });

  it('a kick that found no row is written by the reconciler once a row appears (a later registration)', async () => {
    event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    expect(unsaved(MEMBER)).toBe(true);
    rows.set(MEMBER, { user_id: MEMBER, status: 'registered', joined_at: null });
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('removed');
    expect(memory(MEMBER)).toBe(ParticipantState.REMOVED);
    expect(unsaved(MEMBER)).toBe(false);
  });
});

describe('the reconciler writes no removal of its own, and follows one the database lifted', () => {
  it('a row the database lifted is followed: memory and the canonical doc take the row\'s state, nothing is written', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED, A_MINUTE_AGO());
    rows.set(MEMBER, { user_id: MEMBER, status: 'in_lobby', joined_at: new Date() });
    await canonicalWith({ [MEMBER]: 'removed' });
    mockQuery.mockClear();
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('in_lobby');
    expect(memory(MEMBER)).toBe(ParticipantState.IN_MAIN_ROOM);
    expect(writesIn(mockQuery.mock.calls)).toEqual([]);
    await settle();
    expect(await connStateOf(MEMBER)).toBe('disconnected');
  });

  it('a removal both sides hold is left exactly as it is, the canonical doc included', async () => {
    event();
    setMemory(MEMBER, ParticipantState.REMOVED, A_MINUTE_AGO());
    rows.set(MEMBER, { user_id: MEMBER, status: 'removed', joined_at: new Date() });
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
    rows.set(MEMBER, { user_id: MEMBER, status: 'in_lobby', joined_at: new Date() });
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
    rows.set(MEMBER, { user_id: MEMBER, status: 'in_lobby', joined_at: new Date() });
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
    (s.unsavedRemovals ??= new Set()).add(MEMBER);
    rows.set(MEMBER, { user_id: MEMBER, status: 'removed', joined_at: new Date() });
    await reconcileSessionStates(EVENT);
    expect(unsaved(MEMBER)).toBe(false);
    // The database takes them back where memory does not see it (the invite's own insert after a racing kick).
    rows.get(MEMBER)!.status = 'registered';
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('registered');
    expect(memory(MEMBER)).toBe(ParticipantState.REGISTERED);
  });

  it('a host\'s fresh personal invite after a kick whose write failed wins: the re-admission drops the unfinished removal', async () => {
    const s = event();
    setMemory(MEMBER, ParticipantState.IN_MAIN_ROOM);
    rows.set(MEMBER, { user_id: MEMBER, status: 'left', joined_at: new Date() });
    failNextWrite = true;
    await transitionParticipant(EVENT, MEMBER, ParticipantState.REMOVED);
    expect(s.unsavedRemovals?.has(MEMBER)).toBe(true);
    // registerParticipant re-registered them for the personal invite, then re-admitted them in memory.
    rows.get(MEMBER)!.status = 'registered';
    readmitParticipant(EVENT, MEMBER);
    await reconcileSessionStates(EVENT);
    expect(rows.get(MEMBER)!.status).toBe('registered');
    expect(memory(MEMBER)).toBe(ParticipantState.REGISTERED);
    expect(s.unsavedRemovals?.has(MEMBER)).toBe(false);
  });
});
