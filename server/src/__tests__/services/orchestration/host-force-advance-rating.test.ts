// #4 (26 May live test) — host force-advance from a stuck ROUND_RATING.
//
// Before the fix the host had no escape hatch from ROUND_RATING: "Start Round"
// (handleHostStartRound) only accepted LOBBY_OPEN / ROUND_TRANSITION /
// CLOSING_LOBBY and otherwise emitted "Can only start a round from the lobby,
// transition, or closing phase". So when the all-rated early-close never fired
// (skips/leavers/re-match), the event sat there until the 180s backstop.
//
// Fix: when the host triggers the next-round / end action during ROUND_RATING,
// close the rating window first (endRatingWindow → ROUND_TRANSITION, or
// completeSession when endRequested), then proceed. The normal ROUND_TRANSITION
// → start flow is unchanged.

const hMockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => hMockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

// verifyHost → canActAsHost: always allow in these tests.
jest.mock('../../../services/roles/effective-role.service', () => ({
  canActAsHost: jest.fn(async () => ({ allowed: true, effectiveRole: 'host' })),
  __esModule: true,
}));

import { SessionStatus } from '@rsn/shared';
import { activeSessions } from '../../../services/orchestration/state/session-state';
import {
  handleHostStartRound,
  handleHostEnd,
  injectHostActionDeps,
} from '../../../services/orchestration/handlers/host-actions';

const SID = 'host-force-advance-session';
const HOST = 'host-user';

let transitionToRoundSpy: jest.Mock;
let endRoundSpy: jest.Mock;
let completeSessionSpy: jest.Mock;
let endRatingWindowSpy: jest.Mock;

function fakeSocket() {
  return {
    data: { userId: HOST, role: 'host' },
    emit: jest.fn(),
  } as any;
}

function makeSession(status: SessionStatus, currentRound: number) {
  const session: any = {
    sessionId: SID,
    hostUserId: HOST,
    config: { numberOfRounds: 3, ratingWindowSeconds: 30 },
    currentRound,
    status,
    timer: null,
    timerSyncInterval: null,
    timerEndsAt: null,
    isPaused: false,
    pausedTimeRemaining: null,
    presenceMap: new Map<string, any>(),
    pendingRoundNumber: null,
    manuallyLeftRound: new Set<string>(),
  };
  activeSessions.set(SID, session);
  return session;
}

beforeEach(() => {
  hMockQuery.mockReset();
  // handleHostStartRound's participant-count query → plenty of participants.
  hMockQuery.mockResolvedValue({ rows: [{ count: '4' }] });

  transitionToRoundSpy = jest.fn(async () => true); // LCY-4: contract now returns true on a successful start
  endRoundSpy = jest.fn(async () => {});
  completeSessionSpy = jest.fn(async () => {});
  // The injected endRatingWindow stands in for the real one. To mirror the real
  // state transition (ROUND_RATING → ROUND_TRANSITION for non-last rounds), it
  // flips the session status so the subsequent start-round path proceeds.
  endRatingWindowSpy = jest.fn(async (_sid: string, _round: number) => {
    const s = activeSessions.get(SID);
    if (s && s.status === SessionStatus.ROUND_RATING) {
      s.status = SessionStatus.ROUND_TRANSITION;
    }
  });

  injectHostActionDeps({
    transitionToRound: (_io: any, sid: string, round: number) => transitionToRoundSpy(sid, round),
    completeSession: (_io: any, sid: string) => completeSessionSpy(sid),
    endRound: (_io: any, sid: string, round: number) => endRoundSpy(sid, round),
    // #4 — direct (non-guard-wrapped) endRatingWindow the host force-advance uses.
    endRatingWindow: (_io: any, sid: string, round: number) => endRatingWindowSpy(sid, round),
    emitHostDashboard: async () => {},
    timerCallbacks: {
      transitionToRound: async () => {},
      endRound: async () => {},
      endRatingWindow: async () => {},
      completeSession: async () => {},
    },
  } as any);
});

afterEach(() => {
  activeSessions.delete(SID);
  jest.clearAllMocks();
});

const io: any = { to: () => ({ emit: () => {} }), in: () => ({ fetchSockets: async () => [] }) };

describe('#4 host force-advance — Start Round from ROUND_RATING', () => {
  it('closes the rating window then starts the next round (no INVALID_STATE error)', async () => {
    makeSession(SessionStatus.ROUND_RATING, 2);
    const socket = fakeSocket();

    await handleHostStartRound(io, socket, { sessionId: SID });

    // Rating window was closed for the current round (2)
    expect(endRatingWindowSpy).toHaveBeenCalledWith(SID, 2);
    // Then the next round (3) is started
    expect(transitionToRoundSpy).toHaveBeenCalledWith(SID, 3);
    // No "can only start a round from..." error frame
    const errorCalls = socket.emit.mock.calls.filter((c: any[]) => c[0] === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('does NOT close the rating window in the normal ROUND_TRANSITION flow', async () => {
    makeSession(SessionStatus.ROUND_TRANSITION, 1);
    const socket = fakeSocket();

    await handleHostStartRound(io, socket, { sessionId: SID });

    expect(endRatingWindowSpy).not.toHaveBeenCalled();
    expect(transitionToRoundSpy).toHaveBeenCalledWith(SID, 2);
  });

  it('still starts round 1 from LOBBY_OPEN (no regression)', async () => {
    makeSession(SessionStatus.LOBBY_OPEN, 0);
    const socket = fakeSocket();

    await handleHostStartRound(io, socket, { sessionId: SID });

    expect(endRatingWindowSpy).not.toHaveBeenCalled();
    expect(transitionToRoundSpy).toHaveBeenCalledWith(SID, 1);
  });
});

describe('#4 host force-advance — End Event from ROUND_RATING', () => {
  it('End Event during rating closes the window with endRequested set (completes the event)', async () => {
    const s = makeSession(SessionStatus.ROUND_RATING, 3);
    const socket = fakeSocket();

    await handleHostEnd(io, socket, { sessionId: SID, endEvent: true });

    // endRequested must be set so endRatingWindow completes the event in one press
    expect(s.endRequested).toBe(true);
    // The rating window close was triggered for the current round
    expect(endRatingWindowSpy).toHaveBeenCalledWith(SID, 3);
    const errorCalls = socket.emit.mock.calls.filter((c: any[]) => c[0] === 'error');
    expect(errorCalls).toHaveLength(0);
  });
});
