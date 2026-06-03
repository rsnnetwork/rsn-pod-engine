// Canonical-100% Ship B — read-path flips to canonical connState (fail-open),
// chat room-routing via canonical location, boot-restore participantStates,
// and the Phase-4 LiveKit sweep (positive heal).
import { SessionStatus } from '@rsn/shared';

const store = new Map<string, string>();
const fakeRedis = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  setex: jest.fn(async (k: string, _t: number, v: string) => { store.set(k, v); return 'OK'; }),
};
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => fakeRedis }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const queryMock = jest.fn(async (..._args: any[]) => ({ rows: [] as any[] }));
jest.mock('../../../db', () => ({ query: (...args: any[]) => queryMock(...args) }));
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: jest.fn(async () => ({ hostUserId: 'h', lobbyRoomId: 'lobby-1' })),
}));

import {
  writeCanonical, readCanonical, getCanonicalConnectedSet,
} from '../../../services/orchestration/state/canonical-state';
import {
  setPresence, transitionParticipant, warmParticipantStatesOnRestore, ParticipantState,
} from '../../../services/orchestration/state/participant-state-machine';
import {
  reconcileRoomRoster, healParticipantConnState,
} from '../../../services/orchestration/state/livekit-sweep';
import { activeSessions, sessionRoom } from '../../../services/orchestration/state/session-state';
import { handleChatSend } from '../../../services/orchestration/handlers/chat-handlers';

const flush = () => new Promise(r => setImmediate(r));

const docBase = (seq: number, participants: any) => ({
  sessionId: 's8', status: SessionStatus.ROUND_ACTIVE, currentRound: 1, seq,
  hostUserId: 'h', timer: null, participants,
});
const cp = (connState: string, location: any = { type: 'main' }) => ({
  role: 'participant', connState, location, lastSeenAt: 1, userSeq: 1,
});

function seedSession(over: Partial<any> = {}) {
  activeSessions.set('s8', {
    sessionId: 's8', hostUserId: 'h', config: { numberOfRounds: 3 } as any,
    currentRound: 1, status: SessionStatus.ROUND_ACTIVE, timer: null, timerSyncInterval: null,
    timerEndsAt: null, isPaused: false, pausedTimeRemaining: null,
    presenceMap: new Map(), pendingRoundNumber: null, manuallyLeftRound: new Set(),
    ...over,
  } as any);
}

beforeEach(() => {
  store.clear();
  queryMock.mockReset();
  queryMock.mockImplementation(async () => ({ rows: [] }));
});
afterEach(() => { activeSessions.delete('s8'); });

// ── 1. getCanonicalConnectedSet (the fail-open flip helper) ──────────────────

describe('Ship B — getCanonicalConnectedSet', () => {
  it('returns null when the canonical doc is missing (fail-open signal)', async () => {
    expect(await getCanonicalConnectedSet('s8')).toBeNull();
  });

  it('returns null when the doc has no participants (indistinguishable from unprojected)', async () => {
    await writeCanonical(docBase(1, {}) as any);
    expect(await getCanonicalConnectedSet('s8')).toBeNull();
  });

  it('returns only connected userIds', async () => {
    await writeCanonical(docBase(2, {
      u1: cp('connected'), u2: cp('disconnected'), u3: cp('removed'),
      u4: cp('connected', { type: 'breakout', roomId: 'r1', matchId: 'm1' }),
    }) as any);
    const set = await getCanonicalConnectedSet('s8');
    expect(set).not.toBeNull();
    expect(Array.from(set!).sort()).toEqual(['u1', 'u4']);
  });
});

// ── 2. setPresence(null) mirrors a guarded disconnect into canonical ─────────

describe('Ship B — setPresence(null) canonical mirror', () => {
  it('flips a connected participant to disconnected WITHOUT touching location', async () => {
    seedSession({ presenceMap: new Map([['u1', { lastHeartbeat: new Date(), socketId: 'x' }]]) });
    await writeCanonical(docBase(3, {
      u1: cp('connected', { type: 'breakout', roomId: 'r5', matchId: 'm5' }),
    }) as any);
    setPresence('s8', 'u1', null);
    await flush(); await flush();
    const doc = await readCanonical('s8');
    expect(doc!.participants.u1.connState).toBe('disconnected');
    expect(doc!.participants.u1.location).toEqual({ type: 'breakout', roomId: 'r5', matchId: 'm5' });
  });

  it('never stomps a terminal connState (removed stays removed)', async () => {
    seedSession({ presenceMap: new Map([['u2', { lastHeartbeat: new Date(), socketId: 'y' }]]) });
    await writeCanonical(docBase(4, { u2: cp('removed') }) as any);
    setPresence('s8', 'u2', null);
    await flush(); await flush();
    const doc = await readCanonical('s8');
    expect(doc!.participants.u2.connState).toBe('removed');
  });
});

// ── 3. transitionParticipant: presence owns 'connected' (no ghost resurrection) ─

describe('Ship B — transitionParticipant connected-guard', () => {
  it('round-end reset of an absent user does NOT write connected to canonical', async () => {
    seedSession({
      presenceMap: new Map(), // u1 silently died — not heartbeating
      participantStates: new Map([['u1', { state: ParticipantState.DISCONNECTED, currentRoomId: null, updatedAt: new Date() }]]),
    });
    await writeCanonical(docBase(5, { u1: cp('disconnected') }) as any);
    await transitionParticipant('s8', 'u1', ParticipantState.IN_MAIN_ROOM, { persistToDb: false });
    await flush(); await flush();
    const doc = await readCanonical('s8');
    expect(doc!.participants.u1.connState).toBe('disconnected'); // NOT resurrected
  });

  it('the same transition for a heartbeating user DOES write connected', async () => {
    seedSession({
      presenceMap: new Map([['u2', { lastHeartbeat: new Date(), socketId: 'z' }]]),
      participantStates: new Map([['u2', { state: ParticipantState.DISCONNECTED, currentRoomId: null, updatedAt: new Date() }]]),
    });
    await writeCanonical(docBase(6, { u2: cp('disconnected') }) as any);
    await transitionParticipant('s8', 'u2', ParticipantState.IN_MAIN_ROOM, { persistToDb: false });
    await flush(); await flush();
    const doc = await readCanonical('s8');
    expect(doc!.participants.u2.connState).toBe('connected');
  });

  it('terminal transitions still write their connState regardless of presence', async () => {
    seedSession({
      presenceMap: new Map(),
      participantStates: new Map([['u3', { state: ParticipantState.IN_MAIN_ROOM, currentRoomId: null, updatedAt: new Date() }]]),
    });
    await writeCanonical(docBase(7, { u3: cp('connected') }) as any);
    await transitionParticipant('s8', 'u3', ParticipantState.LEFT, { persistToDb: false });
    await flush(); await flush();
    const doc = await readCanonical('s8');
    expect(doc!.participants.u3.connState).toBe('left');
  });
});

// ── 4. LiveKit sweep — positive heal only ────────────────────────────────────

describe('Ship B — reconcileRoomRoster (Phase-4 sweep heal)', () => {
  it('heals a roster member whose canonical connState is disconnected (missed join webhook)', async () => {
    await writeCanonical(docBase(8, {
      u1: cp('disconnected', { type: 'breakout', roomId: 'r1', matchId: 'm1' }),
    }) as any);
    const healed = await reconcileRoomRoster('s8', 'r1', [{ userId: 'u1' } as any]);
    expect(healed).toBe(1);
    const doc = await readCanonical('s8');
    expect(doc!.participants.u1.connState).toBe('connected');
  });

  it('never resurrects a removed (kicked) user', async () => {
    await writeCanonical(docBase(9, { u2: cp('removed') }) as any);
    const healed = await reconcileRoomRoster('s8', 'lobby-1', [{ userId: 'u2' } as any]);
    expect(healed).toBe(0);
    expect((await readCanonical('s8'))!.participants.u2.connState).toBe('removed');
  });

  it('does NO negative heal — a connected participant absent from the roster stays connected', async () => {
    await writeCanonical(docBase(10, { u3: cp('connected') }) as any);
    await reconcileRoomRoster('s8', 'lobby-1', []);
    expect((await readCanonical('s8'))!.participants.u3.connState).toBe('connected');
  });

  it('healParticipantConnState writes the given state (shared by webhook + sweep)', async () => {
    await writeCanonical(docBase(11, { u4: cp('connected') }) as any);
    await healParticipantConnState('s8', 'u4', 'disconnected');
    expect((await readCanonical('s8'))!.participants.u4.connState).toBe('disconnected');
  });
});

// ── 5. Boot restore — warm participantStates from DB + canonical overlay ────

describe('Ship B — warmParticipantStatesOnRestore', () => {
  it('lifts states from session_participants rows and prefers canonical where present', async () => {
    seedSession();
    queryMock.mockImplementationOnce(async () => ({
      rows: [
        { user_id: 'u1', status: 'in_lobby', current_room_id: null },
        { user_id: 'u2', status: 'in_round', current_room_id: 'r-db' },
        { user_id: 'u3', status: 'checked_in', current_room_id: null },
      ],
    }));
    await writeCanonical(docBase(12, {
      u1: cp('disconnected'), // canonical knows u1 dropped — DB row is stale
      u2: cp('connected', { type: 'breakout', roomId: 'r-canon', matchId: 'm9' }),
      // u3 absent from canonical → DB lift stands
    }) as any);

    await warmParticipantStatesOnRestore('s8');

    const states = activeSessions.get('s8')!.participantStates!;
    expect(states.get('u1')!.state).toBe(ParticipantState.DISCONNECTED);
    expect(states.get('u2')!.state).toBe(ParticipantState.IN_BREAKOUT);
    expect(states.get('u2')!.currentRoomId).toBe('r-canon'); // canonical wins over DB
    expect(states.get('u3')!.state).toBe(ParticipantState.CHECKED_IN);
  });

  it('is a no-op (DB lift only) when canonical is unavailable', async () => {
    seedSession();
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ user_id: 'u1', status: 'in_lobby', current_room_id: null }],
    }));
    await warmParticipantStatesOnRestore('s8');
    expect(activeSessions.get('s8')!.participantStates!.get('u1')!.state)
      .toBe(ParticipantState.IN_MAIN_ROOM);
  });
});

// ── 6. Chat room-routing via canonical location ──────────────────────────────

describe('Ship B — chat routes by canonical location (primary)', () => {
  function makeSocket(userId: string) {
    return {
      data: { userId, displayName: 'U' },
      rooms: new Set([sessionRoom('s8')]),
      emit: jest.fn(),
    } as any;
  }
  function makeIo(emits: { room: string; event: string; payload: any }[]) {
    return {
      to: (room: string) => ({ emit: (event: string, payload: any) => emits.push({ room, event, payload }) }),
      in: () => ({ fetchSockets: async () => [] }),
    } as any;
  }

  it('delivers a room-scope message to canonical roommates without touching roomParticipants or the DB fallback', async () => {
    seedSession(); // NO roomParticipants map at all
    await writeCanonical(docBase(13, {
      u1: cp('connected', { type: 'breakout', roomId: 'r1', matchId: 'm1' }),
      u2: cp('connected', { type: 'breakout', roomId: 'r1', matchId: 'm1' }),
      u3: cp('connected', { type: 'breakout', roomId: 'r2', matchId: 'm2' }),
      u4: cp('connected'),
    }) as any);
    const emits: any[] = [];
    await handleChatSend(makeIo(emits), makeSocket('u1'),
      { sessionId: 's8', message: 'hi', scope: 'room' });

    const recipients = emits.filter(e => e.event === 'chat:message').map(e => e.room).sort();
    expect(recipients).toEqual(['user:u1', 'user:u2']);
    expect(emits[0].payload.roomId).toBe('r1');
    // The matches-table fallback must not have been consulted.
    const matchQueries = queryMock.mock.calls.filter(c => String(c[0]).includes('FROM matches'));
    expect(matchQueries).toHaveLength(0);
  });

  it('falls through to the legacy path when canonical says main', async () => {
    seedSession();
    await writeCanonical(docBase(14, { u1: cp('connected') }) as any);
    const emits: any[] = [];
    const socket = makeSocket('u1');
    await handleChatSend(makeIo(emits), socket,
      { sessionId: 's8', message: 'hi', scope: 'room' });
    // canonical 'main' → legacy resolution (no roomParticipants, empty DB) → sender echo
    expect(socket.emit).toHaveBeenCalledWith('chat:message', expect.anything());
  });
});

// ── Source invariants — flip sites + sweep wiring ────────────────────────────
import * as fs from 'fs';
import * as path from 'path';
const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');

describe('Ship B — flip-site + wiring invariants', () => {
  it('getPresentUserIds unions canonical connected as a 4th signal (and keeps the legacy three)', () => {
    const src = readSrc('services/orchestration/handlers/matching-flow.ts');
    const i = src.indexOf('export async function getPresentUserIds');
    const block = src.slice(i, i + 2600);
    expect(block).toMatch(/getCanonicalConnectedSet/);
    expect(block).toMatch(/presenceMap\.keys\(\)/);       // legacy heartbeat union stays
    expect(block).toMatch(/present\.add\(p\.userId\)/);   // LiveKit roster union stays
  });

  it('emitHostDashboardImmediate derives its presence set canonical-first with presenceMap fallback', () => {
    const src = readSrc('services/orchestration/handlers/matching-flow.ts');
    const i = src.indexOf('async function emitHostDashboardImmediate');
    const block = src.slice(i, i + 3500);
    expect(block).toMatch(/getCanonicalConnectedSet/);
    expect(block).toMatch(/\?\?\s*new Set\(activeSession\.presenceMap\.keys\(\)\)/);
  });

  it('host-actions: plan-presence, isolated-checks and bulk-mute flip canonical-first', () => {
    const src = readSrc('services/orchestration/handlers/host-actions.ts');
    expect(src.match(/getCanonicalConnectedSet/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('host kick deliberately stays on presenceMap (socketId lookup, not a presence gate)', () => {
    const src = readSrc('services/orchestration/handlers/host-actions.ts');
    const i = src.indexOf('export async function handleHostRemoveParticipant');
    const block = src.slice(i, i + 2400);
    expect(block).toMatch(/presenceMap\.get\(data\.userId\)/);
    expect(block).toMatch(/deliberately|socketId/i); // documented decision
  });

  it('detectNoShows isPresent = canonical-else-presenceMap ∪ live sockets', () => {
    const src = readSrc('services/orchestration/handlers/round-lifecycle.ts');
    const i = src.indexOf('export async function detectNoShows');
    const block = src.slice(i, i + 2600);
    expect(block).toMatch(/getCanonicalConnectedSet/);
    expect(block).toMatch(/liveSocketUserIds\.has\(uid\)/);
  });

  it('GET /:id/plan bye-count gate flips canonical-first', () => {
    const src = readSrc('routes/sessions.ts');
    expect(src).toMatch(/getCanonicalConnectedSet/);
  });

  it('recoverActiveSessions warms participantStates in BOTH the Redis and DB paths', () => {
    const src = readSrc('services/orchestration/handlers/round-lifecycle.ts');
    const i = src.indexOf('export async function recoverActiveSessions');
    const block = src.slice(i, i + 6000);
    expect(block.match(/warmParticipantStatesOnRestore/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('webhooks share the heal with the sweep (healParticipantConnState)', () => {
    const src = readSrc('routes/webhooks.ts');
    expect(src).toMatch(/healParticipantConnState/);
  });

  it('orchestration bootstrap starts the 15s LiveKit sweep', () => {
    const src = readSrc('services/orchestration/orchestration.service.ts');
    expect(src).toMatch(/startLiveKitSweep/);
    const sweep = readSrc('services/orchestration/state/livekit-sweep.ts');
    expect(sweep).toMatch(/15_000/);
    // Sweep enumerates lobby + ALL active match rooms (not only manual ones).
    expect(sweep).toMatch(/status = 'active'/);
    expect(sweep).not.toMatch(/is_manual/);
    // Hotfix invariant: a stale in-memory session whose DB row is gone is
    // skipped silently (getSessionById throws NotFound for those — pre-fix
    // the sweep warn-spammed every 15s per stale session).
    expect(sweep).toMatch(/getSessionById\(sessionId\)\.catch\(\(\) => null\)/);
    expect(sweep).toMatch(/if \(!session\) continue/);
  });

  it('chat reactions also resolve recipients canonical-first', () => {
    const src = readSrc('services/orchestration/handlers/chat-handlers.ts');
    const i = src.indexOf('export async function handleReactionSend');
    const block = src.slice(i, i + 3200);
    expect(block).toMatch(/getCanonicalConnectedSet|readCanonical|canonicalRoommates/);
  });
});
