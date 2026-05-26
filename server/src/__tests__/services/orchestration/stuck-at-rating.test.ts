// #4 (26 May live test) — "stuck at rating" after the last round.
//
// Root cause: checkAllRatingsCompleteByUserId computed
//   expectedRatings = Σ pCount*(pCount-1) over the round's completed matches
// assuming EVERY participant rates EVERY partner. It ignored:
//   - skips        (activeSession.ratingSkips has `${userId}:${matchId}`)
//   - leavers      (participants no longer present don't rate)
//   - re-match dupes (a round with churn has BOTH the superseded match and the
//                     new one in completedMatches, inflating expectedRatings)
// so totalRatings < expectedRatings forever → the early-close never fired and
// the event sat on the 180s silent backstop.
//
// Fix: a present participant is "done" when, for each partner in their LATEST
// (most-recently-created, non-superseded) match this round, they have EITHER
// submitted a rating OR skipped it. Close the rating window (3s grace →
// endRatingWindow) once all present, rated-eligible participants are done.
// Leavers (not in presenceMap) never block. Re-matches count only the latest
// match per participant, never the superseded one.
//
// These are BEHAVIORAL tests: they drive the real checkAllRatingsCompleteByUserId
// with a mocked DB + injected endRatingWindow and assert the close fires (or not).

const srMockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => srMockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const srGetMatchesByRound = jest.fn();
jest.mock('../../../services/matching/matching.service', () => ({
  getMatchesByRound: (...args: unknown[]) => srGetMatchesByRound(...args),
  __esModule: true,
}));

import { SessionStatus } from '@rsn/shared';
import { activeSessions } from '../../../services/orchestration/state/session-state';
import {
  checkAllRatingsCompleteByUserId,
  injectDependencies,
} from '../../../services/orchestration/handlers/participant-flow';

const SID = 'stuck-rating-session';

// Injected close spy — endRatingWindow is fire-and-forget from participant-flow.
let endRatingWindowSpy: jest.Mock;

function makeRatingSession(opts: {
  presentUserIds: string[];
  ratingSkips?: string[]; // `${userId}:${matchId}`
}) {
  const session: any = {
    sessionId: SID,
    hostUserId: 'host',
    config: { numberOfRounds: 3, ratingWindowSeconds: 30 },
    currentRound: 3,
    status: SessionStatus.ROUND_RATING,
    timer: null,
    timerSyncInterval: null,
    timerEndsAt: null,
    isPaused: false,
    pausedTimeRemaining: null,
    presenceMap: new Map<string, any>(),
    pendingRoundNumber: null,
    manuallyLeftRound: new Set<string>(),
    ratingSkips: new Set<string>(opts.ratingSkips ?? []),
  };
  for (const uid of opts.presentUserIds) {
    session.presenceMap.set(uid, { lastHeartbeat: new Date(), socketId: `sock-${uid}` });
  }
  activeSessions.set(SID, session);
  return session;
}

// A round's rating edges: maps `${from}:${to}` → present. The mocked DB query
// returns the DISTINCT (from_user_id, to_user_id) edges for this round.
function mockRatingEdges(edges: string[]) {
  srMockQuery.mockImplementation(async () => ({
    rows: edges.map(e => {
      const [from_user_id, to_user_id] = e.split(':');
      return { from_user_id, to_user_id };
    }),
  }));
}

beforeEach(() => {
  jest.useFakeTimers();
  srMockQuery.mockReset();
  srGetMatchesByRound.mockReset();
  endRatingWindowSpy = jest.fn(async () => {});
  injectDependencies({ endRatingWindow: endRatingWindowSpy } as any);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  activeSessions.delete(SID);
});

describe('#4 stuck-at-rating — robust early-close', () => {
  it('closes the window once every present participant rated their partner (golden path)', async () => {
    // Two pairs: (A,B) and (C,D). All present. All four rated their partner.
    makeRatingSession({ presentUserIds: ['A', 'B', 'C', 'D'] });
    srGetMatchesByRound.mockResolvedValue([
      { id: 'm1', participantAId: 'A', participantBId: 'B', participantCId: null, status: 'completed', createdAt: new Date(1000) },
      { id: 'm2', participantAId: 'C', participantBId: 'D', participantCId: null, status: 'completed', createdAt: new Date(1000) },
    ]);
    mockRatingEdges(['A:B', 'B:A', 'C:D', 'D:C']);

    await checkAllRatingsCompleteByUserId('A');

    // A close is pending (3s grace timer armed)
    const s = activeSessions.get(SID)!;
    expect(s.timer).not.toBeNull();
    jest.advanceTimersByTime(3000);
    expect(endRatingWindowSpy).toHaveBeenCalledWith(SID, 3);
  });

  it('does NOT close while a present participant still owes a rating', async () => {
    // (A,B) and (C,D) present. A, B, C rated; D has NOT rated C yet.
    makeRatingSession({ presentUserIds: ['A', 'B', 'C', 'D'] });
    srGetMatchesByRound.mockResolvedValue([
      { id: 'm1', participantAId: 'A', participantBId: 'B', participantCId: null, status: 'completed', createdAt: new Date(1000) },
      { id: 'm2', participantAId: 'C', participantBId: 'D', participantCId: null, status: 'completed', createdAt: new Date(1000) },
    ]);
    mockRatingEdges(['A:B', 'B:A', 'C:D']); // D→C missing

    await checkAllRatingsCompleteByUserId('A');

    const s = activeSessions.get(SID)!;
    expect(s.timer).toBeNull();
    jest.advanceTimersByTime(5000);
    expect(endRatingWindowSpy).not.toHaveBeenCalled();
  });

  it('a SKIP counts as done — a skipper does not block the close', async () => {
    // (A,B): A rated B; B SKIPPED the rating (no B→A row). Should still close.
    makeRatingSession({ presentUserIds: ['A', 'B'], ratingSkips: ['B:m1'] });
    srGetMatchesByRound.mockResolvedValue([
      { id: 'm1', participantAId: 'A', participantBId: 'B', participantCId: null, status: 'completed', createdAt: new Date(1000) },
    ]);
    mockRatingEdges(['A:B']); // B→A absent (B skipped)

    await checkAllRatingsCompleteByUserId('A');

    const s = activeSessions.get(SID)!;
    expect(s.timer).not.toBeNull();
    jest.advanceTimersByTime(3000);
    expect(endRatingWindowSpy).toHaveBeenCalledWith(SID, 3);
  });

  it('a LEAVER (not present) does not block the close', async () => {
    // (A,B): A present and rated B; B LEFT (absent from presenceMap) and never
    // rated. Raw expectedRatings would be 2 but only A is present, so close.
    makeRatingSession({ presentUserIds: ['A'] });
    srGetMatchesByRound.mockResolvedValue([
      { id: 'm1', participantAId: 'A', participantBId: 'B', participantCId: null, status: 'completed', createdAt: new Date(1000) },
    ]);
    mockRatingEdges(['A:B']); // B never rated A (left)

    await checkAllRatingsCompleteByUserId('A');

    const s = activeSessions.get(SID)!;
    expect(s.timer).not.toBeNull();
    jest.advanceTimersByTime(3000);
    expect(endRatingWindowSpy).toHaveBeenCalledWith(SID, 3);
  });

  it('a re-match (superseded match) does not inflate the requirement', async () => {
    // Round-3 churn: A was first paired with B (match m1, then superseded →
    // status 'reassigned'); B left; A was re-matched with C (match m2,
    // 'completed', created LATER). A's LATEST match is m2 (A↔C). A only needs
    // to finish their latest match (rate C) — NOT also rate B from the
    // superseded m1. Both A and C present and rated each other.
    //
    // The OLD code summed expectedRatings over BOTH m1 and m2 → it expected a
    // B→A and A→B edge that can never arrive (B left) → permanently stuck.
    makeRatingSession({ presentUserIds: ['A', 'C'] });
    srGetMatchesByRound.mockResolvedValue([
      // superseded A↔B (created earlier) — must be ignored for A (A's latest is m2)
      { id: 'm1', participantAId: 'A', participantBId: 'B', participantCId: null, status: 'reassigned', createdAt: new Date(1000) },
      // re-match A↔C (created later) — A's and C's LATEST match
      { id: 'm2', participantAId: 'A', participantBId: 'C', participantCId: null, status: 'completed', createdAt: new Date(2000) },
    ]);
    // A↔C rated each other on the latest match. No A↔B edges exist (B left).
    mockRatingEdges(['A:C', 'C:A']);

    await checkAllRatingsCompleteByUserId('A');

    const s = activeSessions.get(SID)!;
    expect(s.timer).not.toBeNull();
    jest.advanceTimersByTime(3000);
    expect(endRatingWindowSpy).toHaveBeenCalledWith(SID, 3);
  });

  it('a no_show latest match does not block — no rating form opens for it', async () => {
    // (A,B) completed and both rated. (C,D) is a no_show (D never connected) —
    // endRound only opens the rating form for 'completed' matches, so C never
    // gets a form and can't rate. C (present) must NOT block the close.
    makeRatingSession({ presentUserIds: ['A', 'B', 'C'] });
    srGetMatchesByRound.mockResolvedValue([
      { id: 'm1', participantAId: 'A', participantBId: 'B', participantCId: null, status: 'completed', createdAt: new Date(1000) },
      { id: 'm2', participantAId: 'C', participantBId: 'D', participantCId: null, status: 'no_show', createdAt: new Date(1000) },
    ]);
    mockRatingEdges(['A:B', 'B:A']); // C has nothing to rate (no form opened)

    await checkAllRatingsCompleteByUserId('A');

    const s = activeSessions.get(SID)!;
    expect(s.timer).not.toBeNull();
    jest.advanceTimersByTime(3000);
    expect(endRatingWindowSpy).toHaveBeenCalledWith(SID, 3);
  });

  it('is a no-op when the session is not in ROUND_RATING', async () => {
    const s = makeRatingSession({ presentUserIds: ['A', 'B'] });
    s.status = SessionStatus.ROUND_ACTIVE;
    srGetMatchesByRound.mockResolvedValue([
      { id: 'm1', participantAId: 'A', participantBId: 'B', participantCId: null, status: 'completed', createdAt: new Date(1000) },
    ]);
    mockRatingEdges(['A:B', 'B:A']);

    await checkAllRatingsCompleteByUserId('A');

    expect(s.timer).toBeNull();
    jest.advanceTimersByTime(5000);
    expect(endRatingWindowSpy).not.toHaveBeenCalled();
  });
});
