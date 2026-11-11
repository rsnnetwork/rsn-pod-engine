// ─── A round's ratings tell the organisers' event report once (10 Nov 2026 spec, Part 3 Task 4) ─────────────────
//
// endRatingWindow writes the round's meeting_records (finalizeRoundRatings) and then, once, sends
// session:<id>:ratings to the people running the event (fanoutSessionRatings), never before the round is finalized
// and never for a stale round. The real endRatingWindow runs here with its collaborators stood in.

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../services/redis/redis.client', () => ({ getRedisClient: () => null, __esModule: true }));
jest.mock('../../../services/orchestration/state/canonical-shadow');
jest.mock('../../../services/orchestration/state/canonical-state');
jest.mock('../../../services/orchestration/state/state-snapshot');
jest.mock('../../../services/orchestration/state/participant-state-machine');
jest.mock('../../../services/orchestration/handlers/timer-manager');
jest.mock('../../../services/session/session.service', () => ({
  updateSessionStatus: jest.fn().mockResolvedValue(undefined),
  getSessionById: jest.fn().mockResolvedValue({ id: 's', lobbyRoomId: null }),
  __esModule: true,
}));
jest.mock('../../../services/matching/matching.service');
jest.mock('../../../services/schedule/schedule-live.service');
jest.mock('../../../services/video/video.service');
jest.mock('../../../services/email/email.service');
jest.mock('../../../realtime/fanout');
jest.mock('../../../realtime/emit', () => ({ emitEntities: jest.fn().mockResolvedValue(undefined), getRealtimeIo: () => null, __esModule: true }));
const order: string[] = [];
const mockFinalize = jest.fn(async () => { order.push('finalize'); return { totalMatches: 1, ratedMatches: 1, mutualConnections: 0 }; });
jest.mock('../../../services/rating/rating.service', () => ({ finalizeRoundRatings: (...a: unknown[]) => mockFinalize(...(a as [])), __esModule: true }));
const mockFanoutRatings = jest.fn(async () => { order.push('fanout'); });
jest.mock('../../../services/session/event-report.service', () => ({
  fanoutSessionRatings: (...a: unknown[]) => mockFanoutRatings(...(a as [])),
  __esModule: true,
}));

import { SessionStatus } from '@rsn/shared';
import { activeSessions } from '../../../services/orchestration/state/session-state';
import { endRatingWindow } from '../../../services/orchestration/handlers/round-lifecycle';

const SESSION = 'e0000000-0000-4000-8000-000000000001';
const io = { to: () => ({ emit: jest.fn() }), in: () => ({ fetchSockets: async () => [] }) };

function live(round: number, status = SessionStatus.ROUND_RATING): void {
  activeSessions.set(SESSION, {
    sessionId: SESSION, status, currentRound: round, endRequested: false,
    config: { numberOfRounds: 5 }, roomParticipants: new Map(),
  } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  activeSessions.clear();
});

describe('endRatingWindow and the event report', () => {
  it('finalizes the round, then sends session:<id>:ratings once', async () => {
    live(2);
    await endRatingWindow(io as never, SESSION, 2);
    expect(mockFinalize).toHaveBeenCalledWith(SESSION, 2);
    expect(mockFanoutRatings).toHaveBeenCalledTimes(1);
    expect(mockFanoutRatings).toHaveBeenCalledWith(SESSION);
    expect(order).toEqual(['finalize', 'fanout']);
  });

  it('sends nothing for a stale round or outside the rating window', async () => {
    live(3);
    await endRatingWindow(io as never, SESSION, 2);
    live(2, SessionStatus.ROUND_ACTIVE);
    await endRatingWindow(io as never, SESSION, 2);
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(mockFanoutRatings).not.toHaveBeenCalled();
  });
});
