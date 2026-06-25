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
  transitionToRound: (sessionId: string, roundNumber: number) => Promise<boolean>; // LCY-4: true iff round reached ROUND_ACTIVE
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
    // M2 (Phase 6) — re-fetch the live session by id rather than mutating the
    // ActiveSession reference captured at arm time. If the object was replaced
    // in the map (e.g. recreated on reconnect when missing), the captured ref
    // is orphaned and clearing its fields would leak this timer on the new
    // object. Operate on the current object; fall back to the captured ref so
    // a removed session still has its timer fields cleared.
    const s = activeSessions.get(sessionId) ?? activeSession;
    s.timer = null;
    s.timerEndsAt = null;
    // Also clear the sync interval when the timer fires
    if (s.timerSyncInterval) {
      clearInterval(s.timerSyncInterval);
      s.timerSyncInterval = null;
    }
    callback();
  }, durationMs);

  // Periodic timer sync broadcasts.
  // Bug 8 (April 19) — was 5000ms; reduced to 2000ms because at 5s host and
  // breakout participants visibly drifted (8:17 vs 9:05 reported during
  // pause + extend). Client decrements locally each second; server sync
  // every 2s caps drift to <2s instead of <5s. Trade-off: 2.5x more socket
  // events (~25 events/sec at 50 participants per session — trivial).
  // Forward-compat: when phase 2 (Redis) lands, this becomes a pub/sub
  // subscription so all hosts in a session get a single backend tick.
  // WS3/B2 (27 May remaining work) — "abrupt round end": warn the rooms at
  // T-30s and T-10s so conversations can wrap up. The warning rides this
  // same interval (threshold-crossing detection in closure state — no extra
  // timeouts to track, pause/resume restarts the closure naturally and
  // re-warns only thresholds still ahead of the resumed remaining time).
  // Round segments only: rating/transition segments ending abruptly is fine.
  const warnThresholds = [30, 10];
  let prevRemainingSeconds = durationSeconds;

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

    const secondsRemaining = Math.ceil(remainingMs / 1000);
    if (session.status === SessionStatus.ROUND_ACTIVE) {
      for (const threshold of warnThresholds) {
        if (secondsRemaining <= threshold && prevRemainingSeconds > threshold) {
          io.to(sessionRoom(sessionId)).emit('timer:warning', {
            segmentType: session.status,
            threshold,
            secondsRemaining,
            endsAt: session.timerEndsAt.toISOString(),
          });
        }
      }
    }
    prevRemainingSeconds = secondsRemaining;

    io.to(sessionRoom(sessionId)).emit('timer:sync', {
      segmentType: session.status,
      secondsRemaining: Math.ceil(remainingMs / 1000),
      totalSeconds: durationSeconds,
      // Bug 8.5: include the authoritative endsAt so clients compute
      // their own display from a single source of truth instead of
      // decrementing a fragile local counter (caused 60s+ drift).
      endsAt: session.timerEndsAt!.toISOString(),
      // Clock-offset anchor: the server's wall-clock at emit time. Clients
      // diff this against their own Date.now() to derive a per-client clock
      // offset, then anchor the timer off the absolute `endsAt` corrected by
      // that offset. Without it, a client whose system clock is skewed (or
      // that misses syncs) ticks from a wrong base and shows a different
      // countdown than its peers — the "everyone sees a different timer" bug.
      serverNow: new Date().toISOString(),
    });
  }, 2000);

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
