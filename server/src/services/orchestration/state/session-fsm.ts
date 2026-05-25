// server/src/services/orchestration/state/session-fsm.ts
// ─── Session-Status FSM ──────────────────────────────────────────────────────
// Canonical-room-state Phase 1. The session lifecycle had no transition guard
// (status was assigned, never validated — audit C2). This table is the seam
// applyTransition (Phase 2) validates against, so a duplicate timer fire after
// a host already advanced the round becomes a no-op (audit C1).

import { SessionStatus } from '@rsn/shared';

export const SESSION_LEGAL_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  [SessionStatus.SCHEDULED]:        [SessionStatus.LOBBY_OPEN, SessionStatus.CANCELLED],
  [SessionStatus.LOBBY_OPEN]:       [SessionStatus.ROUND_ACTIVE, SessionStatus.CLOSING_LOBBY, SessionStatus.CANCELLED],
  [SessionStatus.ROUND_ACTIVE]:     [SessionStatus.ROUND_RATING, SessionStatus.CLOSING_LOBBY, SessionStatus.CANCELLED],
  [SessionStatus.ROUND_RATING]:     [SessionStatus.ROUND_TRANSITION, SessionStatus.CLOSING_LOBBY, SessionStatus.CANCELLED],
  [SessionStatus.ROUND_TRANSITION]: [SessionStatus.ROUND_ACTIVE, SessionStatus.CLOSING_LOBBY, SessionStatus.CANCELLED],
  [SessionStatus.CLOSING_LOBBY]:    [SessionStatus.COMPLETED, SessionStatus.CANCELLED],
  [SessionStatus.COMPLETED]:        [],
  [SessionStatus.CANCELLED]:        [],
};

/** True when `to` is a legal next status from `from`. Self-transitions are NOT
 *  legal (use isIdempotentSessionTransition to no-op those at the call site). */
export function canTransitionSession(from: SessionStatus, to: SessionStatus): boolean {
  return (SESSION_LEGAL_TRANSITIONS[from] || []).includes(to);
}

/** True when the requested transition is a self-transition (no-op). */
export function isIdempotentSessionTransition(from: SessionStatus, to: SessionStatus): boolean {
  return from === to;
}
