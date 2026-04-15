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

// State
import {
  activeSessions, getUserIdFromSocket, cleanupChatMessages,
} from './state/session-state';

// Handlers — Participant Flow
import {
  handleJoinSession, handleLeaveSession, handleHeartbeat, handleReady,
  handleDisconnect, handleRatingSubmit, handleLeaveConversation,
  startHeartbeatStaleDetection, notifyRatingSubmitted,
  injectDependencies as injectParticipantDeps,
} from './handlers/participant-flow';

// Handlers — Host Actions
import {
  handleHostStart, handleHostStartRound, handleHostPause, handleHostResume,
  handleHostEnd, handleHostBroadcast, handleHostRemoveParticipant, handleHostReassign,
  handleHostMuteParticipant, handleHostMuteAll, handleHostRemoveFromRoom,
  handleHostMoveToRoom, handleAssignCohost, handleRemoveCohost, handleHostExtendRound,
  handleHostCreateBreakout,
  startSession, pauseSession, resumeSession, endSession, broadcastMessage,
  setHostActionsIo, injectHostActionDeps,
} from './handlers/host-actions';

// Handlers — Matching Flow
import {
  handleHostGenerateMatches, handleHostConfirmRound, handleHostSwapMatch,
  handleHostExcludeFromRound, handleHostRegenerateMatches, handleHostCancelPreview,
  handleHostForceMatch, emitHostDashboard, injectMatchingFlowDeps,
} from './handlers/matching-flow';

// Handlers — Round Lifecycle
import {
  transitionToRound, endRound, endRatingWindow, completeSession,
  recoverActiveSessions, injectRoundLifecycleDeps,
} from './handlers/round-lifecycle';

// Handlers — Chat
import { handleChatSend, handleChatReact, handleReactionSend } from './handlers/chat-handlers';

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

  // ── Wire cross-module dependencies ──

  const timerCallbacks: TimerCallbacks = {
    transitionToRound: (sessionId, roundNumber) => transitionToRound(io, sessionId, roundNumber),
    endRound: (sessionId, roundNumber) => endRound(io, sessionId, roundNumber),
    endRatingWindow: (sessionId, roundNumber) => endRatingWindow(io, sessionId, roundNumber),
    completeSession: (sessionId) => completeSession(io, sessionId),
  };

  injectHostActionDeps({
    transitionToRound: (ioServer, sessionId, roundNumber) => transitionToRound(ioServer, sessionId, roundNumber),
    completeSession: (ioServer, sessionId) => completeSession(ioServer, sessionId),
    endRound: (ioServer, sessionId, roundNumber) => endRound(ioServer, sessionId, roundNumber),
    emitHostDashboard: (sessionId) => emitHostDashboard(io, sessionId),
    timerCallbacks,
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
  });

  // ── Recover active sessions from DB ──

  recoverActiveSessions(io).catch(err =>
    logger.error({ err }, 'Failed to recover active sessions')
  );

  // ── Start heartbeat stale detection (FIX 5E) ──

  startHeartbeatStaleDetection(io);

  // ── TTL cleanup (every 5 minutes, remove sessions older than 4 hours) ──

  const MAX_SESSION_AGE_MS = 4 * 60 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions) {
      const lastActivity = session.timerEndsAt?.getTime() || now;
      if (now - lastActivity > MAX_SESSION_AGE_MS) {
        logger.warn({ sessionId }, 'Cleaning up stale session (TTL exceeded)');
        clearSessionTimers(sessionId);
        activeSessions.delete(sessionId);
        cleanupChatMessages(sessionId);
      }
    }
  }, 5 * 60 * 1000);

  // ── Register socket handlers ──

  io.on('connection', (socket: Socket) => {
    const userId = getUserIdFromSocket(socket);
    if (userId) socket.join(`user:${userId}`);

    // ── Participant Events (guarded — state-mutating) ──
    wrapHandler('session:join', socket, handleJoinSession);
    wrapHandler('session:leave', socket, handleLeaveSession);
    wrapHandler('rating:submit', socket, handleRatingSubmit);
    wrapHandler('participant:leave_conversation', socket, handleLeaveConversation);

    // ── Participant Events (unguarded) ──
    socket.on('presence:heartbeat', (data) => {
      try { handleHeartbeat(socket, data); }
      catch (err) { logger.error({ err, userId }, 'Heartbeat handler error'); }
    });
    socket.on('presence:ready', async (data) => {
      try { await handleReady(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Ready handler error'); }
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
    wrapHandler('host:extend_round', socket, handleHostExtendRound);

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
    wrapHandler('host:confirm_round', socket, handleHostConfirmRound);
    wrapHandler('host:swap_match', socket, handleHostSwapMatch);
    wrapHandler('host:exclude_participant', socket, handleHostExcludeFromRound);
    wrapHandler('host:regenerate_matches', socket, handleHostRegenerateMatches);
    wrapHandler('host:cancel_preview', socket, handleHostCancelPreview);
    wrapHandler('host:force_match', socket, handleHostForceMatch);

    // ── Chat Events (unguarded) ──
    socket.on('chat:send', async (data) => {
      try { await handleChatSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat send error'); }
    });
    socket.on('chat:react', async (data) => {
      try { await handleChatReact(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat react error'); }
    });
    socket.on('reaction:send', async (data) => {
      try { await handleReactionSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Reaction error'); }
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

export { startSession, pauseSession, resumeSession, endSession, broadcastMessage };
export { notifyRatingSubmitted };
export { getActiveSessionCount } from './state/session-state';
