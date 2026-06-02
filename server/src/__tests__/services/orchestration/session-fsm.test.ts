// server/src/__tests__/services/orchestration/session-fsm.test.ts
import { SessionStatus } from '@rsn/shared';
import {
  SESSION_LEGAL_TRANSITIONS,
  canTransitionSession,
  isIdempotentSessionTransition,
} from '../../../services/orchestration/state/session-fsm';

describe('session-status FSM', () => {
  it('transition table is exhaustive over SessionStatus', () => {
    for (const status of Object.values(SessionStatus)) {
      expect(SESSION_LEGAL_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('allows the happy-path lifecycle transitions', () => {
    expect(canTransitionSession(SessionStatus.SCHEDULED, SessionStatus.LOBBY_OPEN)).toBe(true);
    expect(canTransitionSession(SessionStatus.LOBBY_OPEN, SessionStatus.ROUND_ACTIVE)).toBe(true);
    expect(canTransitionSession(SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_RATING)).toBe(true);
    expect(canTransitionSession(SessionStatus.ROUND_RATING, SessionStatus.ROUND_TRANSITION)).toBe(true);
    expect(canTransitionSession(SessionStatus.ROUND_TRANSITION, SessionStatus.ROUND_ACTIVE)).toBe(true);
    expect(canTransitionSession(SessionStatus.CLOSING_LOBBY, SessionStatus.COMPLETED)).toBe(true);
  });

  it('rejects the C1/C2 double-fire transition (RATING is not reachable from RATING via endRound)', () => {
    // endRound = ROUND_ACTIVE -> ROUND_RATING. A duplicate fire when already
    // in ROUND_RATING must be rejected (not legal), so the caller no-ops.
    expect(canTransitionSession(SessionStatus.ROUND_RATING, SessionStatus.ROUND_RATING)).toBe(false);
    expect(canTransitionSession(SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_ACTIVE)).toBe(false);
  });

  it('flags a self-transition as idempotent', () => {
    expect(isIdempotentSessionTransition(SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_ACTIVE)).toBe(true);
    expect(isIdempotentSessionTransition(SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_RATING)).toBe(false);
  });

  it('allows CANCELLED from any non-terminal state and treats it as terminal', () => {
    expect(canTransitionSession(SessionStatus.LOBBY_OPEN, SessionStatus.CANCELLED)).toBe(true);
    expect(canTransitionSession(SessionStatus.ROUND_ACTIVE, SessionStatus.CANCELLED)).toBe(true);
    expect(SESSION_LEGAL_TRANSITIONS[SessionStatus.CANCELLED]).toEqual([]);
    expect(SESSION_LEGAL_TRANSITIONS[SessionStatus.COMPLETED]).toEqual([]);
  });
});
