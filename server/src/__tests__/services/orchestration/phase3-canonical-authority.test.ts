// server/src/__tests__/services/orchestration/phase3-canonical-authority.test.ts
import { SessionStatus } from '@rsn/shared';
const store = new Map<string,string>();
const fakeRedis = {
  get: jest.fn(async (k:string)=>store.get(k)??null),
  setex: jest.fn(async (k:string,_t:number,v:string)=>{store.set(k,v);return 'OK';}),
};
let handle:any = fakeRedis;
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => handle }));
jest.mock('../../../db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../../../services/session/session.service', () => ({
  updateSessionStatus: jest.fn(async () => {}),
  getSessionById: jest.fn(async () => ({ lobbyRoomId: null })),
  incrementRoundsCompletedBatch: jest.fn(async () => {}),
  updateParticipantStatus: jest.fn(async () => {}),
}));
jest.mock('../../../services/matching/matching.service', () => ({
  getMatchesByRound: jest.fn(async () => []),
}));
// Suppress the Phase-1 shadow projection so the only path that can move the
// canonical *status* in these tests is the Phase-3 direct write. Keep the real
// activeSessions singleton + everything else intact.
jest.mock('../../../services/orchestration/state/session-state', () => ({
  ...jest.requireActual('../../../services/orchestration/state/session-state'),
  persistSessionState: jest.fn(async () => {}),
  clearPersistedState: jest.fn(async () => {}),
}));
import { writeCanonical, readCanonical, updateCanonicalParticipant, updateCanonicalSessionStatus, CanonicalSessionState } from '../../../services/orchestration/state/canonical-state';
import { activeSessions } from '../../../services/orchestration/state/session-state';
import { transitionParticipant, setPresence, reconcileSessionStates, ParticipantState } from '../../../services/orchestration/state/participant-state-machine';
import { query } from '../../../db';
import { SessionStatus as SS } from '@rsn/shared';

const base: CanonicalSessionState = { sessionId:'s3', status:SessionStatus.ROUND_ACTIVE, currentRound:1, seq:1, hostUserId:'h', timer:null, participants:{ u1:{role:'participant',connState:'connected',location:{type:'main'},lastSeenAt:1,userSeq:1} } };
beforeEach(()=>{ store.clear(); handle=fakeRedis; jest.clearAllMocks(); });

describe('Phase 3 — canonical mutators', () => {
  it('updateCanonicalParticipant patches one participant and bumps seq', async () => {
    await writeCanonical(base);
    await updateCanonicalParticipant('s3','u1',{ location:{type:'breakout',roomId:'r1',matchId:'m1'}, connState:'connected' });
    const doc = await readCanonical('s3');
    expect(doc!.participants.u1.location).toEqual({type:'breakout',roomId:'r1',matchId:'m1'});
    expect(doc!.seq).toBe(2);
  });
  it('updateCanonicalParticipant inserts a not-yet-present participant', async () => {
    await writeCanonical(base);
    await updateCanonicalParticipant('s3','u2',{ connState:'connected', location:{type:'main'}, role:'participant' });
    const doc = await readCanonical('s3');
    expect(doc!.participants.u2.connState).toBe('connected');
  });
  it('updateCanonicalSessionStatus sets status + bumps seq', async () => {
    await writeCanonical(base);
    await updateCanonicalSessionStatus('s3', SessionStatus.ROUND_RATING);
    expect((await readCanonical('s3'))!.status).toBe(SessionStatus.ROUND_RATING);
  });
  it('no-ops when the doc does not exist yet (shadow projection will create it)', async () => {
    await expect(updateCanonicalParticipant('nope','u1',{connState:'left'})).resolves.toBeUndefined();
  });
});

function seedActiveSession() {
  activeSessions.set('s3', {
    sessionId: 's3', hostUserId: 'h', config: { numberOfRounds: 3 } as any,
    currentRound: 1, status: SS.ROUND_ACTIVE, timer: null, timerSyncInterval: null,
    timerEndsAt: null, isPaused: false, pausedTimeRemaining: null,
    presenceMap: new Map(), pendingRoundNumber: null, manuallyLeftRound: new Set(),
    participantStates: new Map([['u1', { state: ParticipantState.IN_MAIN_ROOM, currentRoomId: null, updatedAt: new Date() }]]),
  } as any);
}

describe('Phase 3 — transitionParticipant writes canonical (M1)', () => {
  beforeEach(() => { store.clear(); handle = fakeRedis; seedActiveSession(); });
  afterEach(() => { activeSessions.delete('s3'); });

  it('IN_BREAKOUT writes canonical location {breakout, roomId}', async () => {
    await writeCanonical(base);
    await transitionParticipant('s3', 'u1', ParticipantState.IN_BREAKOUT, { currentRoomId: 'r1' });
    await new Promise(r => setImmediate(r));
    const doc = await readCanonical('s3');
    expect(doc!.participants.u1.location.type).toBe('breakout');
    expect((doc!.participants.u1.location as any).roomId).toBe('r1');
  });

  it('LEFT writes canonical connState left', async () => {
    await writeCanonical(base);
    await transitionParticipant('s3', 'u1', ParticipantState.LEFT);
    await new Promise(r => setImmediate(r));
    const doc = await readCanonical('s3');
    expect(doc!.participants.u1.connState).toBe('left');
  });

  it('setPresence marks canonical connState connected', async () => {
    await writeCanonical(base);
    setPresence('s3', 'u1', { lastHeartbeat: new Date(), socketId: 'x' });
    await new Promise(r => setImmediate(r));
    const doc = await readCanonical('s3');
    expect(doc!.participants.u1.connState).toBe('connected');
  });
});

describe('Phase 3 — lifecycle transitions write canonical status (M1)', () => {
  const io: any = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) };
  beforeEach(() => { store.clear(); handle = fakeRedis; seedActiveSession(); });
  afterEach(() => { activeSessions.delete('s3'); });

  it('endRound sets canonical status round_rating', async () => {
    const { endRound } = await import('../../../services/orchestration/handlers/round-lifecycle');
    await writeCanonical(base);
    await endRound(io, 's3', 1);
    await new Promise(r => setImmediate(r));
    const doc = await readCanonical('s3');
    expect(doc!.status).toBe(SS.ROUND_RATING);
  });
});

describe('Phase 3 — reconciler re-checks live presence before LEFT (C4)', () => {
  beforeEach(() => {
    handle = fakeRedis;
    activeSessions.set('s3', {
      sessionId: 's3', hostUserId: 'h', config: { numberOfRounds: 3 } as any,
      currentRound: 1, status: SS.ROUND_ACTIVE, timer: null, timerSyncInterval: null,
      timerEndsAt: null, isPaused: false, pausedTimeRemaining: null,
      // u1 reconnected: present in presenceMap AND in-memory IN_MAIN_ROOM.
      presenceMap: new Map([['u1', { lastHeartbeat: new Date(), socketId: 'x' }]]),
      pendingRoundNumber: null, manuallyLeftRound: new Set(),
      participantStates: new Map([['u1', { state: ParticipantState.IN_MAIN_ROOM, currentRoomId: null, updatedAt: new Date() }]]),
    } as any);
  });
  afterEach(() => { activeSessions.delete('s3'); });

  it('does NOT escalate a stale-DISCONNECTED user who has reconnected', async () => {
    // Divergence SELECT → empty; stale-DISCONNECTED SELECT → returns u1.
    (query as jest.Mock).mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes("'disconnected'") && sql.includes("90 seconds")) {
        return { rows: [{ user_id: 'u1' }] };
      }
      return { rows: [] };
    });
    const res = await reconcileSessionStates('s3');
    expect(res.staleEscalated).toBe(0);
  });
});

describe('Phase 3 — host participant view reads canonical with fallback (M1)', () => {
  // The host-view SQL is a single SELECT; return both participants.
  const participantRows = {
    rows: [
      { user_id: 'u1', display_name: 'U One', email: 'u1@x.com', status: 'in_lobby',
        joined_at: new Date(0), is_cohost: false, acting_as_host: null, user_role: 'user' },
      { user_id: 'u2', display_name: 'U Two', email: 'u2@x.com', status: 'in_lobby',
        joined_at: new Date(0), is_cohost: false, acting_as_host: null, user_role: 'user' },
    ],
  };
  beforeEach(() => {
    store.clear();
    handle = fakeRedis;
    (query as jest.Mock).mockImplementation(async () => participantRows);
  });

  it('canonical wins: breakout→in_room, disconnected→disconnected (legacy would disagree)', async () => {
    const { buildHostParticipantsView } = await import('../../../services/orchestration/handlers/host-participants-view');
    await writeCanonical({
      sessionId: 's3', status: SS.ROUND_ACTIVE, currentRound: 1, seq: 1, hostUserId: 'h', timer: null,
      participants: {
        u1: { role: 'participant', connState: 'connected', location: { type: 'breakout', roomId: 'r1', matchId: 'm1' }, lastSeenAt: 1, userSeq: 1 },
        u2: { role: 'participant', connState: 'disconnected', location: { type: 'main' }, lastSeenAt: 1, userSeq: 1 },
      },
    } as any);
    // Legacy would say: u1 in presenceMap, no active match → in_main_room;
    // u2 in presenceMap → in_main_room. Canonical must override both.
    const view = await buildHostParticipantsView({
      sessionId: 's3', hostUserId: 'h',
      presenceMap: new Map([['u1', {}], ['u2', {}]]),
      activeMatches: [],
    });
    const byId = Object.fromEntries(view.map(v => [v.userId, v.state]));
    expect(byId.u1).toBe('in_room');
    expect(byId.u2).toBe('disconnected');
  });

  it('fallback when no canonical doc: identical to legacy derivation', async () => {
    handle = null; // getRedisClient() → null → readCanonical null → fallback path
    const { buildHostParticipantsView } = await import('../../../services/orchestration/handlers/host-participants-view');
    const view = await buildHostParticipantsView({
      sessionId: 's3', hostUserId: 'h',
      presenceMap: new Map([['u1', {}]]), // u1 present → in_main_room; u2 absent → disconnected
      activeMatches: [],
    });
    const byId = Object.fromEntries(view.map(v => [v.userId, v.state]));
    expect(byId.u1).toBe('in_main_room');
    expect(byId.u2).toBe('disconnected');
  });
});
