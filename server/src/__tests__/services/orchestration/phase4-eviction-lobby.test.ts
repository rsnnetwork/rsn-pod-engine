// ─── Phase 4 — evictMatchedFromLobby tests ───────────────────────────────────
// mock config + logger + video.service BEFORE any imports so round-lifecycle
// can be loaded without a real DB/Redis/pino.

let mockRoomEvictionEnabled = false;

jest.mock('../../../config', () => {
  const cfg: any = {};
  Object.defineProperty(cfg, 'roomEvictionEnabled', { get: () => mockRoomEvictionEnabled, enumerable: true });
  cfg.livekit = { apiKey: '', apiSecret: '', host: '' };
  cfg.logLevel = 'silent';
  cfg.isDev = false;
  cfg.isProd = false;
  cfg.isTest = true;
  cfg.env = 'test';
  cfg.port = 3001;
  return { __esModule: true, default: cfg, config: cfg };
});

jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    debug: jest.fn(), fatal: jest.fn(), trace: jest.fn(),
    child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  },
}));

// Mock all heavy transitive deps that round-lifecycle pulls in
jest.mock('../../../db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../../../services/session/session.service', () => ({
  updateSessionStatus: jest.fn(async () => {}),
  getSessionById: jest.fn(async () => ({ lobbyRoomId: null })),
  updateParticipantStatus: jest.fn(async () => {}),
  incrementRoundsCompletedBatch: jest.fn(async () => {}),
}));
jest.mock('../../../services/matching/matching.service', () => ({
  getMatchesByRound: jest.fn(async () => []),
  generateSingleRound: jest.fn(async () => {}),
}));
jest.mock('../../../services/rating/rating.service', () => ({
  finalizeRoundRatings: jest.fn(async () => {}),
}));
jest.mock('../../../services/email/email.service', () => ({
  sendRecapEmail: jest.fn(async () => {}),
}));
jest.mock('../../../realtime/emit', () => ({ emitEntities: jest.fn(async () => {}) }));
jest.mock('../../../realtime/entities', () => ({ E: new Proxy({}, { get: (_t, k) => (..._a: any[]) => k }) }));
jest.mock('../../../services/orchestration/state/session-state', () => ({
  activeSessions: new Map(),
  sessionRoom: (id: string) => `session:${id}`,
  userRoom: (id: string) => `user:${id}`,
  persistSessionState: jest.fn(async () => {}),
  clearPersistedState: jest.fn(async () => {}),
  cleanupChatMessages: jest.fn(),
  disconnectTimeouts: new Map(),
  sessionLocks: new Map(),
  chatMessages: new Map(),
  MAX_CHAT_MESSAGES: 50,
}));
jest.mock('../../../services/orchestration/state/session-fsm', () => ({
  canTransitionSession: jest.fn(() => true),
}));
jest.mock('../../../services/orchestration/state/participant-state-machine', () => ({
  transitionParticipant: jest.fn(async () => {}),
  ParticipantState: { IN_MAIN_ROOM: 'IN_MAIN_ROOM', IN_BREAKOUT: 'IN_BREAKOUT' },
}));
jest.mock('../../../services/orchestration/state/canonical-state', () => ({
  updateCanonicalSessionStatus: jest.fn(async () => {}),
  updateCanonicalParticipant: jest.fn(async () => {}),
}));
jest.mock('../../../services/orchestration/state/canonical-shadow', () => ({
  shadowWriteCanonical: jest.fn(async () => {}),
}));
jest.mock('../../../services/orchestration/handlers/timer-manager', () => ({
  startSegmentTimer: jest.fn(),
  clearSessionTimers: jest.fn(),
  getTimerCallbackForState: jest.fn(() => jest.fn()),
  TimerCallbacks: {},
}));
jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: jest.fn(() => null),
  initRedis: jest.fn(async () => null),
  duplicateClient: jest.fn(() => null),
}));

const evictCalls: Array<[string, string]> = [];

jest.mock('../../../services/video/video.service', () => ({
  lobbyRoomId: (sessionId: string) => `lobby-${sessionId}`,
  matchRoomId: (sessionId: string, round: number, short: string) => `match-${sessionId}-r${round}-${short}`,
  evictFromRoom: jest.fn(async (userId: string, roomId: string) => {
    evictCalls.push([userId, roomId]);
  }),
  createMatchRoom: jest.fn(async () => ({})),
  issueJoinToken: jest.fn(async () => ({ token: 't', roomId: 'r', userId: 'u', expiresAt: new Date() })),
  listParticipants: jest.fn(async () => []),
  roomExists: jest.fn(async () => true),
  getVideoProvider: jest.fn(() => ({
    removeParticipant: jest.fn(async () => {}),
  })),
  setVideoProvider: jest.fn(),
  setParticipantCanPublishAudio: jest.fn(async () => {}),
}));

describe('Phase 4 — evictMatchedFromLobby', () => {
  beforeEach(() => {
    evictCalls.length = 0;
  });

  it('evicts each matched user from lobby-{sessionId} when flag is ON', async () => {
    mockRoomEvictionEnabled = true;
    const { evictMatchedFromLobby } = await import('../../../services/orchestration/handlers/round-lifecycle');
    await evictMatchedFromLobby('sess1', ['u1', 'u2', 'u3']);
    expect(evictCalls).toEqual(
      expect.arrayContaining([
        ['u1', 'lobby-sess1'],
        ['u2', 'lobby-sess1'],
        ['u3', 'lobby-sess1'],
      ])
    );
    expect(evictCalls).toHaveLength(3);
  });

  it('does NOT evict when flag is OFF', async () => {
    mockRoomEvictionEnabled = false;
    const { evictMatchedFromLobby } = await import('../../../services/orchestration/handlers/round-lifecycle');
    await evictMatchedFromLobby('sess1', ['u1', 'u2']);
    expect(evictCalls).toHaveLength(0);
  });
});
