// ─── Orchestration Service — Entry Point ────────────────────────────────────
// Thin wiring layer that imports all handler modules, injects cross-module
// dependencies, registers socket handlers with try-catch wrappers (FIX 5A),
// and re-exports the public API consumed by REST routes and index.ts.
//
// State machine:
//   SCHEDULED → LOBBY_OPEN → ROUND_ACTIVE(n) → ROUND_RATING(n)
//   → ROUND_TRANSITION(n) → ROUND_ACTIVE(n+1) ... → CLOSING_LOBBY → COMPLETED

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../config/logger';
import { SessionStatus } from '@rsn/shared';

// Phase 5 (19 May 2026) — realtime architecture migration complete. The
// legacy notify* helpers (notifyPodChanged / notifySessionListChanged /
// notifyAdminListChanged / notifyPodMembershipChanged / notifyUserChanged /
// notifyUserBlocksChanged / notifyOwnNotificationsChanged /
// notifyDmReactionChanged / notifyDmReadReceipt / notifyGroupChanged /
// notifyPermissionsUpdated) have all been deleted from this module. Routes
// now call the entity-only fanout helpers in ../../realtime/fanout
// directly. The two surviving bespoke events — permissions:updated and
// roster:changed — live in emitPermissionsUpdated (also in fanout.ts) and
// are kept solely because useSessionSocket needs them to hydrate Zustand
// state. See:
//   docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
import { setRealtimeIo } from '../../realtime/emit';

// State
import {
  activeSessions, getUserIdFromSocket, cleanupChatMessages, withSessionGuard,
} from './state/session-state';

// Handlers — Participant Flow
import {
  handleJoinSession, handleLeaveSession, handleHeartbeat, handleReady,
  handleDisconnect, handleRatingSubmit, handleRatingSkip, handleLeaveConversation,
  handleRoomJoined,
  startHeartbeatStaleDetection, notifyRatingSubmitted,
  injectDependencies as injectParticipantDeps,
} from './handlers/participant-flow';

// Handlers — Host Actions
import {
  handleHostStart, handleHostStartRound, handleHostPause, handleHostResume,
  handleHostEnd, handleHostBroadcast, handleHostRemoveParticipant, handleHostReassign,
  handleHostMuteParticipant, handleHostMuteAll, handleHostRemoveFromRoom,
  handleHostMoveToRoom, handleAssignCohost, handleRemoveCohost, handlePromoteCohost, handleHostExtendRound,
  handleHostExtendBreakoutRoom, handleHostCreateBreakout,
  handleHostSetPin, handleHostSetTileSize,
  startSession, pauseSession, resumeSession, endSession, broadcastMessage,
  setHostVisibility,
  setHostActionsIo, injectHostActionDeps,
} from './handlers/host-actions';

// Handlers — Matching Flow
import {
  handleHostGenerateMatches, handleHostConfirmRound, handleHostConfirmMatches,
  handleHostSwapMatch, handleHostExcludeFromRound, handleHostRegenerateMatches,
  handleHostCancelPreview, emitHostDashboard, emitHostDashboardForce, injectMatchingFlowDeps,
} from './handlers/matching-flow';

// Handlers — Round Lifecycle
import {
  transitionToRound, endRound, endRatingWindow, completeSession,
  recoverActiveSessions, injectRoundLifecycleDeps, maybeAutoEndEmptyRound,
} from './handlers/round-lifecycle';

// Handlers — Chat
import { handleChatSend, handleChatReact, handleReactionSend, handleChatRequestHistory } from './handlers/chat-handlers';
import { handleDmSend, handleDmRead, handleDmReact, handleDmUnreact } from './handlers/dm-handlers';
// Phase 2E (5 May spec) — global state reconciler.
import { startGlobalReconciler } from './state/participant-state-machine';
import { startLiveKitSweep } from './state/livekit-sweep';
// Phase 5 — resync handler for session:resync socket event.
import { handleResync } from './state/state-snapshot';

// Handlers — Bulk Breakout (Task 14)
import {
  handleHostCreateBreakoutBulk, handleHostExtendBreakoutAll,
  handleHostEndBreakoutAll, handleHostSetBreakoutDurationAll,
  handleHostAddToRoom,
  injectBreakoutBulkDeps,
} from './handlers/breakout-bulk';

// Timer Manager
import { clearSessionTimers, TimerCallbacks } from './handlers/timer-manager';

let io: SocketServer;

// ── Try-Catch Wrapper (FIX 5A) ────────────────────────────────────────────

function wrapHandler(
  eventName: string,
  socket: Socket,
  handler: (io: SocketServer, socket: Socket, data: any) => Promise<void>
): void {
  socket.on(eventName, async (data: any) => {
    try {
      await handler(io, socket, data);
    } catch (err) {
      const userId = getUserIdFromSocket(socket);
      logger.error({ err, event: eventName, userId }, 'Socket handler error');
      socket.emit('error', { message: 'Something went wrong. Please try again.' });
    }
  });
}

// ── Initialise ─────────────────────────────────────────────────────────────

export function initOrchestration(socketServer: SocketServer): void {
  io = socketServer;

  // Give host-actions module access to io for REST API helpers
  setHostActionsIo(io);

  // Phase 5 (19 May 2026) — wire the realtime fanout module's cached io so
  // the entity-only fanout helpers in ../../realtime/fanout can emit
  // without each caller threading an SocketServer through.
  setRealtimeIo(io);

  // ── Wire cross-module dependencies ──

  // C1 (Phase 2) — timer-fired transitions run OUTSIDE any host guard. Wrap
  // each in withSessionGuard so a timer firing cannot run concurrently with a
  // host-clicked transition on the same session. Safe (non-re-entrant): the
  // lifecycle fns never acquire the guard themselves (host handlers already
  // call them while holding it).
  const timerCallbacks: TimerCallbacks = {
    transitionToRound: (sessionId, roundNumber) => withSessionGuard(sessionId, () => transitionToRound(io, sessionId, roundNumber)),
    endRound: (sessionId, roundNumber) => withSessionGuard(sessionId, () => endRound(io, sessionId, roundNumber)),
    endRatingWindow: (sessionId, roundNumber) => withSessionGuard(sessionId, () => endRatingWindow(io, sessionId, roundNumber)),
    completeSession: (sessionId) => withSessionGuard(sessionId, () => completeSession(io, sessionId)),
  };

  injectHostActionDeps({
    transitionToRound: (ioServer, sessionId, roundNumber) => transitionToRound(ioServer, sessionId, roundNumber),
    completeSession: (ioServer, sessionId) => completeSession(ioServer, sessionId),
    endRound: (ioServer, sessionId, roundNumber) => endRound(ioServer, sessionId, roundNumber),
    // #4 (26 May) — direct (non-guard-wrapped) endRatingWindow for host
    // force-advance from ROUND_RATING. Host handlers already hold the session
    // guard, so they must NOT use the guard-wrapped timerCallbacks variant.
    endRatingWindow: (ioServer, sessionId, roundNumber) => endRatingWindow(ioServer, sessionId, roundNumber),
    emitHostDashboard: (sessionId) => emitHostDashboard(io, sessionId),
    // Bug 68 (18 May Stefan) — coalesce-bypass for cohost promote/demote.
    emitHostDashboardForce: (sessionId) => emitHostDashboardForce(io, sessionId),
    timerCallbacks,
    // Bug 4 (April 18 Dr Arch): wire auto-end so host actions that end matches
    // can recover the session if every active match in the round is gone.
    maybeAutoEndEmptyRound: (sessionId) => maybeAutoEndEmptyRound(io, sessionId),
  });

  injectMatchingFlowDeps({
    transitionToRound: (ioServer, sessionId, roundNumber) => transitionToRound(ioServer, sessionId, roundNumber),
  });

  injectRoundLifecycleDeps({
    timerCallbacks,
    emitHostDashboard: (ioServer, sessionId) => emitHostDashboard(ioServer, sessionId),
  });

  injectParticipantDeps({
    emitHostDashboard: (sessionId) => emitHostDashboard(io, sessionId),
    endRatingWindow: (sessionId, roundNumber) => endRatingWindow(io, sessionId, roundNumber),
    // Bug 4 (April 18 Dr Arch): voluntary leave / disconnect may end the last
    // active match — auto-recover the round.
    maybeAutoEndEmptyRound: (sessionId) => maybeAutoEndEmptyRound(io, sessionId),
  });

  injectBreakoutBulkDeps({
    emitHostDashboard: (sessionId) => emitHostDashboard(io, sessionId),
  });

  // ── Recover active sessions from DB ──

  recoverActiveSessions(io).catch(err =>
    logger.error({ err }, 'Failed to recover active sessions')
  );

  // ── Start heartbeat stale detection (FIX 5E) ──

  startHeartbeatStaleDetection(io);

  // ── Phase 2E (5 May spec) — periodic state-machine reconciler ──
  // Auto-heals participant-state drift every 30 s so users never need to
  // leave-and-rejoin to recover from a wedged state.
  startGlobalReconciler(io);

  // ── Ship B (Phase 4) — 15s LiveKit reconciliation sweep ──
  // Heals canonical connState for roster members whose join webhook was
  // missed (positive heal only — see livekit-sweep.ts for the rationale).
  startLiveKitSweep();

  // ── TTL cleanup (every 5 minutes, remove sessions older than 4 hours) ──

  const MAX_SESSION_AGE_MS = 4 * 60 * 60 * 1000;
  setInterval(async () => {
    const now = Date.now();
    const { clearDashboardCoalesce } = await import('./handlers/matching-flow');
    const { cleanupLiveKitRooms } = await import('./handlers/round-lifecycle');
    for (const [sessionId, session] of activeSessions) {
      const lastActivity = session.timerEndsAt?.getTime() || now;
      if (now - lastActivity > MAX_SESSION_AGE_MS) {
        logger.warn({ sessionId }, 'Cleaning up stale session (TTL exceeded)');
        clearSessionTimers(sessionId);
        // Phase A4 (10 May spec) — tear down LiveKit rooms before dropping
        // the in-memory entry. Pre-fix this only deleted the in-memory
        // ActiveSession, leaving LiveKit rooms alive forever (Stefan's
        // #17). Fire-and-forget so the loop keeps making progress.
        cleanupLiveKitRooms(sessionId).catch(err =>
          logger.warn({ err, sessionId }, 'TTL reaper: LiveKit cleanup failed (non-fatal)'));
        activeSessions.delete(sessionId);
        cleanupChatMessages(sessionId);
        // Tier-1 A1: also clear dashboard coalesce state
        clearDashboardCoalesce(sessionId);
      }
    }
  }, 5 * 60 * 1000);

  // ── Phase A4 (10 May spec) — orphan-lobby reaper ──
  // Catches sessions that ended cleanly via completeSession (which awaits
  // LiveKit cleanup) but whose lobby room id stuck around in DB or LiveKit
  // due to a transient failure, AND sessions that ended pre-Phase-A4 (whose
  // lobby_room_id was never nulled). Runs every 15 min, sweeps anything
  // that's been completed/cancelled for >1 h.
  const ORPHAN_REAPER_INTERVAL_MS = 15 * 60 * 1000;
  setInterval(async () => {
    try {
      const { query } = await import('../../db');
      const { cleanupLiveKitRooms } = await import('./handlers/round-lifecycle');
      const stale = await query<{ id: string }>(
        `SELECT id FROM sessions
          WHERE status IN ('completed', 'cancelled')
            AND lobby_room_id IS NOT NULL
            AND ended_at < NOW() - INTERVAL '1 hour'
          LIMIT 50`,
      );
      if (stale.rows.length === 0) return;
      logger.info({ count: stale.rows.length }, 'Orphan-lobby reaper: tearing down stale rooms');
      // Phase H (10 May simplify pass) — clean each orphan in parallel.
      // Pre-fix this awaited cleanupLiveKitRooms sequentially in a loop;
      // a 50-row backlog × 500ms per LiveKit close = 25s of unnecessary
      // serial work per tick. Promise.allSettled keeps per-row error
      // isolation while letting LiveKit closes overlap.
      const results = await Promise.allSettled(
        stale.rows.map(async row => {
          await cleanupLiveKitRooms(row.id);
          await query(`UPDATE sessions SET lobby_room_id = NULL WHERE id = $1`, [row.id]);
        }),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          logger.warn({ err: r.reason, sessionId: stale.rows[i].id },
            'Orphan-lobby reaper: per-session cleanup failed (will retry next tick)');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Orphan-lobby reaper tick failed');
    }
  }, ORPHAN_REAPER_INTERVAL_MS);

  // ── Register socket handlers ──

  io.on('connection', (socket: Socket) => {
    const userId = getUserIdFromSocket(socket);
    if (userId) socket.join(`user:${userId}`);

    // ── Participant Events (guarded — state-mutating) ──
    wrapHandler('session:join', socket, handleJoinSession);
    wrapHandler('session:leave', socket, handleLeaveSession);
    wrapHandler('rating:submit', socket, handleRatingSubmit);
    wrapHandler('rating:skip', socket, handleRatingSkip);
    wrapHandler('participant:leave_conversation', socket, handleLeaveConversation);

    // ── Phase 5 — client resync request (unguarded, flag-gated in handler) ──
    socket.on('session:resync', (data) => handleResync(io, socket, data));

    // ── Participant Events (unguarded) ──
    socket.on('presence:heartbeat', (data) => {
      try { handleHeartbeat(socket, data); }
      catch (err) { logger.error({ err, userId }, 'Heartbeat handler error'); }
    });
    socket.on('presence:ready', async (data) => {
      try { await handleReady(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Ready handler error'); }
    });
    // T0-2 (Issue 7) — fired by VideoRoom after LiveKit room.connect()
    // resolves. Distinct from presence:ready: this confirms LiveKit room
    // membership specifically, so the host dashboard can show real
    // breakout state instead of false-positive "active".
    socket.on('presence:room_joined', async (data) => {
      try { await handleRoomJoined(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Room-joined handler error'); }
    });

    // ── Host Events (guarded — state-mutating) ──
    wrapHandler('host:start_session', socket, handleHostStart);
    wrapHandler('host:start_round', socket, handleHostStartRound);
    wrapHandler('host:pause_session', socket, handleHostPause);
    wrapHandler('host:resume_session', socket, handleHostResume);
    wrapHandler('host:end_session', socket, handleHostEnd);
    wrapHandler('host:remove_participant', socket, handleHostRemoveParticipant);
    wrapHandler('host:reassign', socket, handleHostReassign);
    wrapHandler('host:remove_from_room', socket, handleHostRemoveFromRoom);
    wrapHandler('host:move_to_room', socket, handleHostMoveToRoom);
    wrapHandler('host:create_breakout', socket, handleHostCreateBreakout);
    wrapHandler('host:assign_cohost', socket, handleAssignCohost);
    wrapHandler('host:remove_cohost', socket, handleRemoveCohost);
    // Bug 1 (18 May Stefan) — global pin broadcast. Acting hosts can set
    // a pin that every participant's lobby honours.
    wrapHandler('host:set_pin', socket, handleHostSetPin);
    // Bug 26 (19 May Ali) — director can flatten a cohost's tile to
    // participant size (visual only; cohost keeps all privileges).
    wrapHandler('host:set_tile_size', socket, handleHostSetTileSize);
    // T1-5 — host can pass the baton to an existing co-host
    wrapHandler('host:promote_cohost', socket, handlePromoteCohost);
    wrapHandler('host:extend_round', socket, handleHostExtendRound);
    wrapHandler('host:extend_breakout_room', socket, handleHostExtendBreakoutRoom);

    // ── Bulk Manual Breakout (Task 14) ──
    wrapHandler('host:create_breakout_bulk', socket, handleHostCreateBreakoutBulk);
    wrapHandler('host:extend_breakout_all', socket, handleHostExtendBreakoutAll);
    wrapHandler('host:end_breakout_all', socket, handleHostEndBreakoutAll);
    wrapHandler('host:set_breakout_duration_all', socket, handleHostSetBreakoutDurationAll);
    // S25 — grow an active manual room (1→2, 2→3; hard cap 3).
    wrapHandler('host:add_to_room', socket, handleHostAddToRoom);

    // ── Host Events (unguarded — no session state mutation) ──
    socket.on('host:broadcast_message', async (data) => {
      try { await handleHostBroadcast(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Broadcast handler error'); }
    });
    socket.on('host:mute_participant', async (data) => {
      try { await handleHostMuteParticipant(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Mute handler error'); }
    });
    socket.on('host:mute_all', async (data) => {
      try { await handleHostMuteAll(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Mute all handler error'); }
    });

    // ── Matching Events (guarded) ──
    wrapHandler('host:generate_matches', socket, handleHostGenerateMatches);
    wrapHandler('host:confirm_matches', socket, handleHostConfirmMatches);
    wrapHandler('host:confirm_round', socket, handleHostConfirmRound);
    wrapHandler('host:swap_match', socket, handleHostSwapMatch);
    wrapHandler('host:exclude_participant', socket, handleHostExcludeFromRound);
    wrapHandler('host:regenerate_matches', socket, handleHostRegenerateMatches);
    wrapHandler('host:cancel_preview', socket, handleHostCancelPreview);

    // ── Chat Events (unguarded) ──
    socket.on('chat:send', async (data) => {
      try { await handleChatSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat send error'); }
    });
    socket.on('chat:react', async (data) => {
      try { await handleChatReact(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat react error'); }
    });
    // Phase 4B (5 May spec) — chat history force-fetch fallback for Stefan #8.
    socket.on('chat:request_history', async (data) => {
      try { await handleChatRequestHistory(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat request_history error'); }
    });
    socket.on('reaction:send', async (data) => {
      try { await handleReactionSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Reaction error'); }
    });

    // ── DM Events (Phase D, 1 May 2026 spec) — platform-level person-to-
    // person messaging. Independent of any session/round/event.
    socket.on('dm:send', async (data) => {
      try { await handleDmSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'DM send error'); }
    });
    socket.on('dm:read', async (data) => {
      try { await handleDmRead(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'DM read error'); }
    });
    // Phase E (3 May 2026) — emoji reactions on DM messages.
    socket.on('dm:react', async (data) => {
      try { await handleDmReact(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'DM react error'); }
    });
    socket.on('dm:unreact', async (data) => {
      try { await handleDmUnreact(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'DM unreact error'); }
    });

    // ── Disconnect ──
    socket.on('disconnect', async () => {
      try { await handleDisconnect(io, socket); }
      catch (err) { logger.error({ err, userId }, 'Disconnect handler error'); }
    });
  });
}

// ── Get Active Session State (used by REST routes) ─────────────────────────

export function getActiveSessionState(sessionId: string): {
  status: SessionStatus;
  currentRound: number;
  isPaused: boolean;
  timerEndsAt: string | null;
  participantCount: number;
} | null {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return null;

  return {
    status: activeSession.status,
    currentRound: activeSession.currentRound,
    isPaused: activeSession.isPaused,
    timerEndsAt: activeSession.timerEndsAt?.toISOString() || null,
    participantCount: activeSession.presenceMap.size,
  };
}

// ── Public API Re-exports ──────────────────────────────────────────────────

export { startSession, pauseSession, resumeSession, endSession, broadcastMessage, setHostVisibility };
export type { HostVisibilityMode } from './handlers/host-actions';
export { notifyRatingSubmitted };
export { getActiveSessionCount } from './state/session-state';
