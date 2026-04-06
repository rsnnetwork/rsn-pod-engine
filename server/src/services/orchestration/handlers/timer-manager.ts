// ─── Timer Manager ─────────────────────────────────────────────────────────
// Extracted from orchestration.service.ts — timer lifecycle, sync broadcasts,
// and cleanup for session segment timers.

import { Server as SocketIOServer } from 'socket.io';
import { SessionStatus } from '@rsn/shared';
import logger from '../../../config/logger';
import {
  ActiveSession,
  activeSessions,
  sessionRoom,
} from '../state/session-state';

// ─── Timer Callback Interface ──────────────────────────────────────────────
// Callbacks are injected from the entry point so this module stays decoupled
// from round-lifecycle and session-lifecycle modules.

export interface TimerCallbacks {
  transitionToRound: (sessionId: string, roundNumber: number) => Promise<void>;
  endRound: (sessionId: string, roundNumber: number) => Promise<void>;
  endRatingWindow: (sessionId: string, roundNumber: number) => Promise<void>;
  completeSession: (sessionId: string) => Promise<void>;
}

// ─── Core Timer Functions ──────────────────────────────────────────────────

/**
 * Clear both the main segment timer and the 5-second sync interval for a session.
 */
export function clearSessionTimers(sessionId: string): void {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  if (activeSession.timer) {
    clearTimeout(activeSession.timer);
    activeSession.timer = null;
  }

  if (activeSession.timerSyncInterval) {
    clearInterval(activeSession.timerSyncInterval);
    activeSession.timerSyncInterval = null;
  }
}

/**
 * Start a segment timer that fires `callback` after `durationSeconds`.
 * Also sets up a 5-second sync interval that broadcasts remaining time.
 *
 * FIX 5D: Stores the sync interval on activeSession.timerSyncInterval so it
 * can be cleaned up deterministically (instead of only self-clearing).
 */
export function startSegmentTimer(
  io: SocketIOServer,
  sessionId: string,
  durationSeconds: number,
  callback: () => void,
): void {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  // Clear any existing timer AND sync interval before starting new ones
  clearSessionTimers(sessionId);

  const durationMs = durationSeconds * 1000;
  activeSession.timerEndsAt = new Date(Date.now() + durationMs);

  // Main segment timeout
  activeSession.timer = setTimeout(() => {
    activeSession.timer = null;
    activeSession.timerEndsAt = null;
    // Also clear the sync interval when the timer fires
    if (activeSession.timerSyncInterval) {
      clearInterval(activeSession.timerSyncInterval);
      activeSession.timerSyncInterval = null;
    }
    callback();
  }, durationMs);

  // Periodic timer sync broadcasts (every 5 seconds)
  const syncInterval = setInterval(() => {
    const session = activeSessions.get(sessionId);

    // Safety check: self-clear if session no longer exists
    if (!session) {
      clearInterval(syncInterval);
      return;
    }

    if (!session.timerEndsAt || session.isPaused) {
      clearInterval(syncInterval);
      session.timerSyncInterval = null;
      return;
    }

    const remainingMs = session.timerEndsAt.getTime() - Date.now();
    if (remainingMs <= 0) {
      clearInterval(syncInterval);
      session.timerSyncInterval = null;
      return;
    }

    io.to(sessionRoom(sessionId)).emit('timer:sync', {
      segmentType: session.status,
      secondsRemaining: Math.ceil(remainingMs / 1000),
      totalSeconds: durationSeconds,
    });
  }, 5000);

  // Store sync interval on session for deterministic cleanup
  activeSession.timerSyncInterval = syncInterval;
}

/**
 * Return the appropriate timer callback for the current session status.
 * Callbacks are injected so this module doesn't depend on round/session lifecycle.
 */
export function getTimerCallbackForState(
  sessionId: string,
  activeSession: ActiveSession,
  callbacks: TimerCallbacks,
): () => void {
  switch (activeSession.status) {
    case SessionStatus.LOBBY_OPEN:
      return () => { callbacks.transitionToRound(sessionId, 1); };
    case SessionStatus.ROUND_ACTIVE:
      return () => { callbacks.endRound(sessionId, activeSession.currentRound); };
    case SessionStatus.ROUND_RATING:
      return () => { callbacks.endRatingWindow(sessionId, activeSession.currentRound); };
    case SessionStatus.ROUND_TRANSITION:
      return () => { callbacks.transitionToRound(sessionId, activeSession.currentRound + 1); };
    case SessionStatus.CLOSING_LOBBY:
      return () => { callbacks.completeSession(sessionId); };
    default:
      logger.warn({ sessionId, status: activeSession.status }, 'getTimerCallbackForState: no handler for status');
      return () => {};
  }
}
