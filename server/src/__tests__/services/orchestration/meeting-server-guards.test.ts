// ─── A video meeting runs as one room until the director ends it (26 Oct 2026) ───────────────────
//
// 25 Oct walkthrough: Claus's "Video Meeting" got a round plan at Go Live, round controls and a ratings
// recap. The live engine now reads the event's format (ActiveSession.format, set wherever an ActiveSession
// is made) and, for a meeting:
//   - Go Live opens the main room and plans nothing (no generateSessionSchedule);
//   - every round, matching and breakout action is refused with NOT_A_ROUNDS_EVENT;
//   - a join or a leave repairs no plan;
//   - End Event (director or super_admin, unchanged) completes it, and no ratings recap email is sent.
// Speed networking is unchanged on every one of these paths, and a session recovered without a format (a
// Redis entry written before formats existed) runs as speed networking.

const gMockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => gMockQuery(...args),
  transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb({ query: gMockQuery })),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: jest.fn(async () => ({ allowed: true, effectiveRole: 'host' })),
  __esModule: true,
}));

const mockGetSessionById = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  updateSessionStatus: jest.fn(async () => ({})),
  updateParticipantStatus: jest.fn(async () => {}),
  getParticipantCount: jest.fn(async () => 1),
  registerParticipant: jest.fn(async () => ({ isNewRegistration: false })),
  __esModule: true,
}));

jest.mock('../../../services/video/video.service', () => ({
  createLobbyRoom: jest.fn(async (sid: string) => ({ roomId: `session-${sid}` })),
  closeLobbyRoom: jest.fn(async () => {}),
  closeMatchRoom: jest.fn(async () => {}),
  listParticipants: jest.fn(async () => []),
  lobbyRoomId: (sid: string) => `session-${sid}`,
  __esModule: true,
}));

const mockGenerateSessionSchedule = jest.fn(async () => ({ rounds: [], durationMs: 1 }));
const mockRepairFutureRounds = jest.fn(async () => ({ regeneratedRounds: [] as number[] }));
const mockGetMatchesByRound = jest.fn(async () => []);
const mockGenerateSingleRound = jest.fn(async () => ({}));
jest.mock('../../../services/matching/matching.service', () => ({
  generateSessionSchedule: (...args: unknown[]) => (mockGenerateSessionSchedule as jest.Mock)(...args),
  repairFutureRounds: (...args: unknown[]) => (mockRepairFutureRounds as jest.Mock)(...args),
  getMatchesByRound: (...args: unknown[]) => (mockGetMatchesByRound as jest.Mock)(...args),
  generateSingleRound: (...args: unknown[]) => (mockGenerateSingleRound as jest.Mock)(...args),
  __esModule: true,
}));

jest.mock('../../../services/rating/rating.service', () => ({
  finalizeSessionEncounters: jest.fn(async () => {}),
  __esModule: true,
}));

const mockRedis = { client: null as null | Record<string, jest.Mock> };
jest.mock('../../../services/redis/redis.client', () => ({
  getRedisClient: () => mockRedis.client,
  __esModule: true,
}));

import { SessionStatus } from '@rsn/shared';
import { activeSessions, ActiveSession } from '../../../services/orchestration/state/session-state';
import {
  handleHostStart, handleHostStartRound, handleHostEnd, handleHostCreateBreakout, handleHostMoveToRoom,
  injectHostActionDeps,
} from '../../../services/orchestration/handlers/host-actions';
import {
  handleHostGenerateMatches, handleHostConfirmRound, handleHostSwapMatch, handleHostExcludeFromRound,
  handleHostRegenerateMatches, handleHostCancelPreview, handleHostConfirmMatches,
} from '../../../services/orchestration/handlers/matching-flow';
import { handleHostCreateBreakoutBulk, handleHostAddToRoom } from '../../../services/orchestration/handlers/breakout-bulk';
import { handleLeaveSession, handleJoinSession } from '../../../services/orchestration/handlers/participant-flow';
import { completeSession, recoverActiveSessions } from '../../../services/orchestration/handlers/round-lifecycle';

const HOST = 'host-user';
const GUEST = 'guest-user';
const REFUSAL = {
  code: 'NOT_A_ROUNDS_EVENT',
  message: 'This is a video meeting, so there are no rounds. Everyone stays in the main room.',
};

const transitionToRoundSpy = jest.fn(async () => true);
const completeSessionSpy = jest.fn(async () => {});

const io: any = {
  to: () => ({ emit: () => {} }),
  in: () => ({ fetchSockets: async () => [] }),
  sockets: { sockets: new Map() },
};

function fakeSocket(userId = HOST) {
  return {
    id: `socket-${userId}`,
    data: { userId, role: 'member', displayName: userId },
    rooms: new Set<string>(),
    emit: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
  } as any;
}

function live(sessionId: string, format: ActiveSession['format'], overrides: Partial<ActiveSession> = {}): ActiveSession {
  const s: ActiveSession = {
    sessionId,
    hostUserId: HOST,
    config: { numberOfRounds: 3 } as any,
    currentRound: 0,
    status: SessionStatus.LOBBY_OPEN,
    timer: null,
    timerSyncInterval: null,
    timerEndsAt: null,
    isPaused: false,
    pausedTimeRemaining: null,
    presenceMap: new Map(),
    pendingRoundNumber: 1,
    manuallyLeftRound: new Set(),
    ...(format ? { format } : {}),
    ...overrides,
  };
  activeSessions.set(sessionId, s);
  return s;
}

function refused(socket: { emit: jest.Mock }): boolean {
  return socket.emit.mock.calls.some(([event, payload]) => event === 'error' && payload?.code === 'NOT_A_ROUNDS_EVENT');
}

const flush = () => new Promise((r) => setImmediate(r));

// The join and leave handlers schedule a 300 ms participant-list broadcast whose callback imports the
// snapshot module. On real timers it fired after this suite was torn down ("You are trying to `import` a
// file after the Jest environment has been torn down", then a worker that would not exit). Fake timers keep
// every handler timer inside the test, and each test clears them; setImmediate (the flushes) and Date stay real.
beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['Date', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance'] });
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  gMockQuery.mockReset();
  gMockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockGetSessionById.mockReset();
  mockGenerateSessionSchedule.mockClear();
  mockRepairFutureRounds.mockClear();
  mockGetMatchesByRound.mockClear();
  mockGenerateSingleRound.mockClear();
  transitionToRoundSpy.mockClear();
  completeSessionSpy.mockClear();
  mockRedis.client = null;
  activeSessions.clear();
  injectHostActionDeps({
    transitionToRound: (_io: any, sid: string, round: number) => (transitionToRoundSpy as jest.Mock)(sid, round),
    completeSession: (_io: any, sid: string) => (completeSessionSpy as jest.Mock)(sid),
    endRound: async () => {},
    endRatingWindow: async () => {},
    emitHostDashboard: async () => {},
    timerCallbacks: {
      transitionToRound: async () => {}, endRound: async () => {}, endRatingWindow: async () => {}, completeSession: async () => {},
    },
  } as any);
});

afterEach(() => {
  jest.clearAllTimers();
  activeSessions.clear();
});

describe('Go Live', () => {
  function scheduled(sessionId: string, format: string) {
    mockGetSessionById.mockResolvedValue({
      id: sessionId, status: 'scheduled', hostUserId: HOST, format,
      config: format === 'video_meeting' ? { durationMinutes: 60, eventType: format } : { numberOfRounds: 3, eventType: format },
    });
  }

  it('a video meeting opens the main room and plans no rounds', async () => {
    scheduled('start-meeting', 'video_meeting');
    const socket = fakeSocket();
    await handleHostStart(io, socket, { sessionId: 'start-meeting' });
    expect(mockGenerateSessionSchedule).not.toHaveBeenCalled();
    expect(activeSessions.get('start-meeting')).toMatchObject({ status: SessionStatus.LOBBY_OPEN, format: 'video_meeting' });
    expect(socket.emit).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('speed networking still plans every round at Go Live', async () => {
    scheduled('start-speed', 'speed_networking');
    await handleHostStart(io, fakeSocket(), { sessionId: 'start-speed' });
    expect(mockGenerateSessionSchedule).toHaveBeenCalledTimes(1);
    expect(activeSessions.get('start-speed')!.format).toBe('speed_networking');
  });
});

describe('round, matching and breakout actions on a video meeting', () => {
  const cases: Array<[string, (sid: string, socket: any) => Promise<void>]> = [
    ['host:start_round', (sid, s) => handleHostStartRound(io, s, { sessionId: sid })],
    ['host:generate_matches', (sid, s) => handleHostGenerateMatches(io, s, { sessionId: sid })],
    ['host:confirm_round', (sid, s) => handleHostConfirmRound(io, s, { sessionId: sid })],
    ['host:swap_match', (sid, s) => handleHostSwapMatch(io, s, { sessionId: sid, userA: 'a', userB: 'b' })],
    ['host:exclude_from_round', (sid, s) => handleHostExcludeFromRound(io, s, { sessionId: sid, userId: 'a' })],
    ['host:regenerate_matches', (sid, s) => handleHostRegenerateMatches(io, s, { sessionId: sid })],
    ['host:cancel_preview', (sid, s) => handleHostCancelPreview(io, s, { sessionId: sid })],
    ['host:confirm_matches', (sid, s) => handleHostConfirmMatches(io, s, { sessionId: sid })],
    ['host:create_breakout', (sid, s) => handleHostCreateBreakout(io, s, { sessionId: sid, participantIds: ['a', 'b'] })],
    ['host:create_breakout_bulk', (sid, s) => handleHostCreateBreakoutBulk(io, s, {
      sessionId: sid, rooms: [{ participantIds: ['a', 'b'] }], sharedDurationSeconds: 300,
    })],
    ['host:move_to_room', (sid, s) => handleHostMoveToRoom(io, s, { sessionId: sid, userId: 'a', targetMatchId: 'm' })],
    ['host:add_to_room', (sid, s) => handleHostAddToRoom(io, s, { sessionId: sid, userId: 'a', matchId: 'm' })],
  ];

  it.each(cases)('%s is refused with NOT_A_ROUNDS_EVENT and changes nothing', async (_name, run) => {
    live('meeting', 'video_meeting');
    const socket = fakeSocket();
    await run('meeting', socket);
    expect(socket.emit).toHaveBeenCalledWith('error', REFUSAL);
    expect(transitionToRoundSpy).not.toHaveBeenCalled();
    expect(mockGenerateSingleRound).not.toHaveBeenCalled();
    expect(mockGetMatchesByRound).not.toHaveBeenCalled();
    const writes = gMockQuery.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql as string));
    expect(writes).toEqual([]);
  });

  it.each(cases)('%s is not refused in speed networking', async (_name, run) => {
    live('speed', 'speed_networking');
    const socket = fakeSocket();
    await run('speed', socket);
    expect(refused(socket)).toBe(false);
  });

  it.each(cases)('%s is not refused for a session recovered without a format (speed networking)', async (_name, run) => {
    live('legacy', undefined);
    const socket = fakeSocket();
    await run('legacy', socket);
    expect(refused(socket)).toBe(false);
  });

  it('speed networking still starts its round', async () => {
    live('speed-round', 'speed_networking');
    gMockQuery.mockResolvedValue({ rows: [{ count: '4' }] });
    await handleHostStartRound(io, fakeSocket(), { sessionId: 'speed-round' });
    expect(transitionToRoundSpy).toHaveBeenCalledWith('speed-round', 1);
  });
});

describe('the plan is not repaired when someone leaves a meeting', () => {
  function leaving(sessionId: string, format: ActiveSession['format']) {
    live(sessionId, format);
    mockGetSessionById.mockResolvedValue({ id: sessionId, status: 'lobby_open', hostUserId: HOST, format, config: {} });
    // The guest is a participant of the event (H1: a page the event never let in has nothing to leave).
    gMockQuery.mockImplementation(async (sql: string) => (
      /^\s*SELECT s\.host_user_id = \$2 AS is_host/.test(sql)
        ? { rows: [{ is_host: false, is_cohost: false, participant_status: 'in_lobby' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    ));
  }

  it('a meeting repairs nothing', async () => {
    leaving('leave-meeting', 'video_meeting');
    await handleLeaveSession(io, fakeSocket(GUEST), { sessionId: 'leave-meeting' });
    await flush(); await flush();
    expect(mockRepairFutureRounds).not.toHaveBeenCalled();
  });

  it('speed networking repairs its future rounds as before', async () => {
    leaving('leave-speed', 'speed_networking');
    await handleLeaveSession(io, fakeSocket(GUEST), { sessionId: 'leave-speed' });
    for (let i = 0; i < 6 && mockRepairFutureRounds.mock.calls.length === 0; i++) await flush();
    expect(mockRepairFutureRounds).toHaveBeenCalledTimes(1);
  });
});

describe('ending a meeting', () => {
  it('End Event from the main room completes it (director only, unchanged)', async () => {
    live('end-meeting', 'video_meeting');
    await handleHostEnd(io, fakeSocket(HOST), { sessionId: 'end-meeting', endEvent: true });
    expect(completeSessionSpy).toHaveBeenCalledWith('end-meeting');
  });

  it('a co-host still cannot end it', async () => {
    live('end-cohost', 'video_meeting');
    const socket = fakeSocket('cohost-user');
    await handleHostEnd(io, socket, { sessionId: 'end-cohost', endEvent: true });
    expect(completeSessionSpy).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'DIRECTOR_ONLY' }));
  });

  function recapQueried(): boolean {
    return gMockQuery.mock.calls.some(([sql]) => /SELECT title, host_user_id AS "hostUserId" FROM sessions/.test(sql as string));
  }

  function claim(sessionId: string, eventFormat: string | undefined) {
    gMockQuery.mockImplementation(async (sql: string) => {
      if (/UPDATE sessions SET status = 'completed', ended_at = NOW\(\)\s+WHERE id = \$1 AND status NOT IN/.test(sql)) {
        return { rows: [{ id: sessionId, ...(eventFormat ? { event_format: eventFormat } : {}) }] };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  it('completing a meeting sends no ratings recap email', async () => {
    live('complete-meeting', 'video_meeting');
    claim('complete-meeting', 'video_meeting');
    await completeSession(io, 'complete-meeting');
    await flush(); await flush();
    expect(recapQueried()).toBe(false);
    expect(activeSessions.has('complete-meeting')).toBe(false);
  });

  it('a meeting the server no longer holds in memory (the reaper ends it) also sends no recap', async () => {
    claim('reaped-meeting', 'video_meeting');
    await completeSession(io, 'reaped-meeting');
    await flush(); await flush();
    expect(recapQueried()).toBe(false);
  });

  it('completing speed networking still sends the recap emails', async () => {
    live('complete-speed', 'speed_networking');
    claim('complete-speed', 'speed_networking');
    await completeSession(io, 'complete-speed');
    await flush(); await flush();
    expect(recapQueried()).toBe(true);
  });

  it('an event whose row gives no format (written before migration 111 was read) is treated as speed networking', async () => {
    claim('complete-old', undefined);
    await completeSession(io, 'complete-old');
    await flush(); await flush();
    expect(recapQueried()).toBe(true);
  });
});

describe('every place that makes an ActiveSession knows the format', () => {
  it('a Redis entry without a format recovers as speed networking; one with a format keeps it', async () => {
    const entries: Record<string, unknown> = {
      'rsn:session:redis-old': { sessionId: 'redis-old', hostUserId: HOST, config: { eventType: 'video_meeting' }, currentRound: 0, status: 'lobby_open' },
      'rsn:session:redis-meeting': { sessionId: 'redis-meeting', hostUserId: HOST, config: {}, currentRound: 0, status: 'lobby_open', format: 'video_meeting' },
    };
    mockRedis.client = {
      keys: jest.fn(async () => Object.keys(entries)),
      get: jest.fn(async (k: string) => JSON.stringify(entries[k])),
      setex: jest.fn(async () => 'OK'),
      del: jest.fn(async () => 1),
    };
    await recoverActiveSessions(io);
    expect(activeSessions.get('redis-old')!.format ?? 'speed_networking').toBe('speed_networking');
    expect(activeSessions.get('redis-meeting')!.format).toBe('video_meeting');
  });

  it('the database fallback reads the column', async () => {
    gMockQuery.mockImplementation(async (sql: string) => {
      if (/FROM sessions WHERE status = ANY\(\$1\) AND active_state IS NOT NULL/.test(sql)) {
        expect(sql).toMatch(/event_format/);
        return { rows: [
          { id: 'db-meeting', status: 'lobby_open', host_user_id: HOST, config: {}, current_round: 0, active_state: {}, lobby_room_id: null, event_format: 'video_meeting' },
          { id: 'db-speed', status: 'lobby_open', host_user_id: HOST, config: {}, current_round: 0, active_state: {}, lobby_room_id: null, event_format: 'speed_networking' },
        ] };
      }
      return { rows: [], rowCount: 0 };
    });
    await recoverActiveSessions(io);
    expect(activeSessions.get('db-meeting')!.format).toBe('video_meeting');
    expect(activeSessions.get('db-speed')!.format).toBe('speed_networking');
  });

  it('the on-the-fly recovery on join reads it from the event row', async () => {
    mockGetSessionById.mockResolvedValue({
      id: 'join-meeting', status: 'lobby_open', hostUserId: HOST, format: 'video_meeting', currentRound: 0,
      config: { durationMinutes: 60, eventType: 'video_meeting' },
    });
    await handleJoinSession(io, fakeSocket(GUEST), { sessionId: 'join-meeting' });
    expect(activeSessions.get('join-meeting')!.format).toBe('video_meeting');
  });
});
