// T0-3 — session-state-snapshot helper
//
// Single source of truth for the "what's the current state of this session?"
// payload, reused by both the new GET /api/sessions/:id/state REST endpoint
// AND the existing session:state socket emit. Tests pin the contract so
// neither path can silently drift from the other.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockGetSessionById = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  __esModule: true,
}));

import { activeSessions } from '../../../services/orchestration/state/session-state';

const SESSION_ID = '00000000-0000-0000-0000-000000000abc';

import { buildSessionStateSnapshot } from '../../../services/session/session-state-snapshot.service';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    podId: 'pod-1',
    title: 'Test Session',
    status: 'lobby_open',
    currentRound: 0,
    hostUserId: 'host-1',
    config: {
      numberOfRounds: 5,
      timerVisibility: 'last_10s',
    },
    ...overrides,
  };
}

function makeIo(connectedUsers: Array<{ userId: string; displayName: string }>) {
  return {
    in: () => ({
      fetchSockets: async () => connectedUsers.map(u => ({ data: u })),
    }),
  } as any;
}

describe('T0-3 — buildSessionStateSnapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeSessions.clear();
  });

  it('returns null when session does not exist', async () => {
    mockGetSessionById.mockResolvedValue(null);
    const result = await buildSessionStateSnapshot('nope', null);
    expect(result).toBeNull();
  });

  it('falls back to DB session when activeSessions has no entry', async () => {
    mockGetSessionById.mockResolvedValue(makeSession({ status: 'completed', currentRound: 3 }));
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });           // cohosts
    // T1-4: registered is now SELECT user_id (not COUNT) so we can compute active too
    mockQuery.mockResolvedValueOnce({
      rows: Array.from({ length: 8 }, (_, i) => ({ user_id: `u-${i}` })),
      rowCount: 8,
    });

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, null);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.sessionStatus).toBe('completed');
    expect(snapshot!.currentRound).toBe(3);
    // No activeSession overlay → no timer info
    expect(snapshot!.timerEndsAt).toBeNull();
    expect(snapshot!.isPaused).toBe(false);
    expect(snapshot!.pendingRoundNumber).toBeNull();
  });

  it('overlays activeSession state when present (timer + paused + pendingRound)', async () => {
    mockGetSessionById.mockResolvedValue(makeSession({ status: 'lobby_open', currentRound: 1 }));
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [{ c: '5' }], rowCount: 1 });

    const ends = new Date(Date.now() + 60_000);
    activeSessions.set(SESSION_ID, {
      sessionId: SESSION_ID,
      hostUserId: 'host-1',
      status: 'round_active' as any,
      currentRound: 2,
      config: { numberOfRounds: 5 } as any,
      timer: null,
      timerSyncInterval: null,
      timerEndsAt: ends,
      isPaused: false,
      pausedTimeRemaining: null,
      presenceMap: new Map(),
      pendingRoundNumber: 3,
      manuallyLeftRound: new Set(),
    });

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, null);

    // activeSession wins over DB on these fields:
    expect(snapshot!.sessionStatus).toBe('round_active');
    expect(snapshot!.currentRound).toBe(2);
    expect(snapshot!.timerEndsAt).toBe(ends.toISOString());
    expect(snapshot!.pendingRoundNumber).toBe(3);
  });

  it('reports pausedTimeRemainingMs when activeSession is paused', async () => {
    mockGetSessionById.mockResolvedValue(makeSession());
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [{ c: '5' }], rowCount: 1 });

    activeSessions.set(SESSION_ID, {
      sessionId: SESSION_ID,
      hostUserId: 'host-1',
      status: 'round_active' as any,
      currentRound: 1,
      config: { numberOfRounds: 5 } as any,
      timer: null,
      timerSyncInterval: null,
      timerEndsAt: null,
      isPaused: true,
      pausedTimeRemaining: 45_000,
      presenceMap: new Map(),
      pendingRoundNumber: null,
      manuallyLeftRound: new Set(),
    });

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, null);
    expect(snapshot!.isPaused).toBe(true);
    expect(snapshot!.pausedTimeRemainingMs).toBe(45_000);
    expect(snapshot!.timerEndsAt).toBeNull();
  });

  it('counts socket presence from io, excludes host from headline counts (T1-4)', async () => {
    mockGetSessionById.mockResolvedValue(makeSession({ hostUserId: 'host-1' }));
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // T1-4: registered query returns rows of {user_id} not {c} count
    mockQuery.mockResolvedValueOnce({
      rows: [
        { user_id: 'host-1' },  // host present in DB but excluded from registered count
        { user_id: 'user-2' },
        { user_id: 'user-3' },
        { user_id: 'user-4' },
        { user_id: 'user-5' },
      ],
      rowCount: 5,
    });

    const io = makeIo([
      { userId: 'host-1', displayName: 'Host' },
      { userId: 'user-2', displayName: 'User Two' },
      { userId: 'user-3', displayName: 'User Three' },
    ]);

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, io);

    // Raw connected list still includes host (UI may need it for "host present" badge)
    expect(snapshot!.connectedParticipants).toHaveLength(3);
    expect(snapshot!.connectedParticipants[0].userId).toBe('host-1');
    expect(snapshot!.hostInLobby).toBe(true);
    // T1-4: headline counts EXCLUDE host
    expect(snapshot!.participantCounts.connected).toBe(2);  // user-2, user-3 (host excluded)
    expect(snapshot!.participantCounts.registered).toBe(4); // 5 - host = 4
    expect(snapshot!.participantCounts.active).toBe(2);     // intersection: user-2, user-3
    expect(snapshot!.participantCounts.hostConnected).toBe(true);
    expect(snapshot!.participantCounts.ghostFiltered).toBe(true);
  });

  it('returns hostInLobby=false when host socket is not in the room', async () => {
    mockGetSessionById.mockResolvedValue(makeSession({ hostUserId: 'host-1' }));
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [{ c: '2' }], rowCount: 1 });

    const io = makeIo([
      { userId: 'user-2', displayName: 'User Two' },
    ]);

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, io);
    expect(snapshot!.hostInLobby).toBe(false);
  });

  it('lists co-hosts from session_cohosts table', async () => {
    mockGetSessionById.mockResolvedValue(makeSession());
    mockQuery
      .mockResolvedValueOnce({ rows: [{ user_id: 'cohost-1' }, { user_id: 'cohost-2' }], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ c: '5' }], rowCount: 1 });

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, null);
    expect(snapshot!.cohosts).toEqual(['cohost-1', 'cohost-2']);
  });

  it('filters registered list for ghost statuses + loadtest accounts (T1-4)', async () => {
    mockGetSessionById.mockResolvedValue(makeSession());
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await buildSessionStateSnapshot(SESSION_ID, null);

    const registeredQuery = mockQuery.mock.calls[1][0] as string;
    // Status filter
    expect(registeredQuery).toMatch(/status\s+NOT\s+IN\s*\(\s*'removed'\s*,\s*'left'\s*,\s*'no_show'\s*\)/i);
    // T1-4: also filters loadtest/test accounts via email pattern
    expect(registeredQuery).toMatch(/email\s+NOT\s+LIKE\s+'loadtest_%@rsn-test\.invalid'/i);
  });

  it('reports ghostFiltered=true on the new participantCounts shape', async () => {
    mockGetSessionById.mockResolvedValue(makeSession());
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, null);
    expect(snapshot!.participantCounts.ghostFiltered).toBe(true);
  });

  it('participantCounts has connected/registered/active/hostConnected/ghostFiltered fields', async () => {
    mockGetSessionById.mockResolvedValue(makeSession());
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, null);
    expect(snapshot!.participantCounts).toEqual({
      connected: expect.any(Number),
      registered: expect.any(Number),
      active: expect.any(Number),
      hostConnected: expect.any(Boolean),
      ghostFiltered: true,
    });
  });

  it('reads numberOfRounds from session config (string-encoded fallback)', async () => {
    // Some session rows have config stored as a JSON string instead of jsonb
    mockGetSessionById.mockResolvedValue(makeSession({
      config: JSON.stringify({ numberOfRounds: 7, timerVisibility: 'always' }),
    }));
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [{ c: '5' }], rowCount: 1 });

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, null);
    expect(snapshot!.totalRounds).toBe(7);
    expect(snapshot!.timerVisibility).toBe('always');
  });

  it('connected counts default to 0 when io is null (REST callers always pass io)', async () => {
    mockGetSessionById.mockResolvedValue(makeSession());
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ c: '5' }], rowCount: 1 });

    const snapshot = await buildSessionStateSnapshot(SESSION_ID, null);
    expect(snapshot!.connectedParticipants).toEqual([]);
    expect(snapshot!.participantCounts.connected).toBe(0);
    expect(snapshot!.hostInLobby).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Source-pattern test: GET /api/sessions/:id/state route is wired and gated
// ───────────────────────────────────────────────────────────────────────────

describe('T0-3 wiring — GET /api/sessions/:id/state', () => {
  it('routes/sessions.ts registers the /state endpoint', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../routes/sessions.ts'),
      'utf8',
    );
    expect(src).toMatch(/router\.get\(\s*['"]\/:id\/state['"]/);
  });

  it('endpoint is gated by authenticate + canViewSession', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../routes/sessions.ts'),
      'utf8',
    );
    const stateIdx = src.indexOf("'/:id/state'");
    const block = src.slice(stateIdx, stateIdx + 1500);
    expect(block).toMatch(/authenticate/);
    expect(block).toMatch(/canViewSession/);
  });

  it('endpoint reads io from req.app.get and calls buildSessionStateSnapshot', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../routes/sessions.ts'),
      'utf8',
    );
    const stateIdx = src.indexOf("'/:id/state'");
    const block = src.slice(stateIdx, stateIdx + 1500);
    expect(block).toMatch(/req\.app\.get\(['"]io['"]\)/);
    expect(block).toMatch(/buildSessionStateSnapshot/);
  });

  it('index.ts sets io on the express app via app.set("io", io)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../index.ts'),
      'utf8',
    );
    expect(src).toMatch(/app\.set\(['"]io['"]\s*,\s*io\)/);
  });
});
