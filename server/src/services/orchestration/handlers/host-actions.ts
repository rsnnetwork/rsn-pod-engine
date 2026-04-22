// ─── Host Actions ──────────────────────────────────────────────────────────
// Extracted from orchestration.service.ts — all host-action socket handlers:
// start, start-round, pause, resume, end, broadcast, remove-participant,
// reassign, mute, mute-all, remove-from-room, move-to-room, co-host mgmt.
//
// Every state-mutating handler is wrapped with withSessionGuard to prevent
// concurrent host actions on the same session.

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../../config/logger';
import { query, transaction } from '../../../db';
import {
  SessionStatus, ParticipantStatus,
  MatchStatus, UserRole,
} from '@rsn/shared';
import {
  ActiveSession, activeSessions, withSessionGuard,
  sessionRoom, userRoom, getUserIdFromSocket, persistSessionState,
  emitRatingWindowOnce,
} from '../state/session-state';
import { startSegmentTimer, getTimerCallbackForState, TimerCallbacks } from './timer-manager';
import * as sessionService from '../../session/session.service';
import * as videoService from '../../video/video.service';
import { ForbiddenError, ValidationError } from '../../../middleware/errors';
import * as matchingService from '../../matching/matching.service';
import { validateMatchAssignment } from '../../matching/match-validator.service';

// ─── Cross-module references (wired in Task 7) ────────────────────────────
// Functions from round-lifecycle.ts that don't exist yet.

let _transitionToRound: ((io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>) | null = null;
let _completeSession: ((io: SocketServer, sessionId: string) => Promise<void>) | null = null;
let _endRound: ((io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>) | null = null;
let _emitHostDashboard: ((sessionId: string) => Promise<void>) | null = null;
let _timerCallbacks: TimerCallbacks | null = null;
let _maybeAutoEndEmptyRound: ((sessionId: string) => Promise<void>) | null = null;

/**
 * Inject cross-module dependencies that live in other handler files.
 * Called during orchestration entry point wiring (Task 7).
 */
export function injectHostActionDeps(deps: {
  transitionToRound: (io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>;
  completeSession: (io: SocketServer, sessionId: string) => Promise<void>;
  endRound: (io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>;
  emitHostDashboard: (sessionId: string) => Promise<void>;
  timerCallbacks: TimerCallbacks;
  maybeAutoEndEmptyRound?: (sessionId: string) => Promise<void>;
}) {
  _transitionToRound = deps.transitionToRound;
  _completeSession = deps.completeSession;
  _endRound = deps.endRound;
  _emitHostDashboard = deps.emitHostDashboard;
  _timerCallbacks = deps.timerCallbacks;
  _maybeAutoEndEmptyRound = deps.maybeAutoEndEmptyRound || null;
}

// Bug 4 (April 18 Dr Arch): fire-and-forget auto-end check used after every
// match-status transition that may have left ROUND_ACTIVE with 0 active matches.
function maybeAutoEndEmptyRound(sessionId: string): void {
  if (_maybeAutoEndEmptyRound) {
    _maybeAutoEndEmptyRound(sessionId).catch(err =>
      logger.warn({ err, sessionId }, 'Failed maybeAutoEndEmptyRound from host-actions'),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// HOST HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/** Get all user IDs that should be excluded from matching: original host + co-hosts */
export async function getAllHostIds(sessionId: string, hostUserId: string): Promise<string[]> {
  const cohostResult = await query<{ user_id: string }>(
    `SELECT user_id FROM session_cohosts WHERE session_id = $1`,
    [sessionId]
  );
  return [hostUserId, ...cohostResult.rows.map(r => r.user_id)];
}

// ─── Verify Host ────────────────────────────────────────────────────────────

export async function verifyHost(socket: Socket, sessionId: string): Promise<boolean> {
  const userId = getUserIdFromSocket(socket);
  if (!userId) {
    socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
    return false;
  }

  // T1-5 — delegated to the unified `getEffectiveRole` resolver. This
  // adds pod-admin cascade (pod directors / pod creators can now act as
  // session hosts even if they're not explicitly the session.host_user_id)
  // alongside the existing host + admin + co-host paths. Behavior preserved
  // for everyone who was already allowed: admins still pass, hosts still
  // pass, co-hosts still pass. New: pod directors pass for sessions in
  // their pod even without manual host assignment.
  const userRole = (socket.data as any)?.role as UserRole | undefined;
  const { canActAsHost } = await import('../../roles/effective-role.service');
  const { allowed, effectiveRole } = await canActAsHost(userId, userRole, sessionId);

  if (!allowed) {
    logger.debug({ userId, sessionId, effectiveRole }, 'verifyHost denied');
    socket.emit('error', { code: 'FORBIDDEN', message: 'Only the host can perform this action' });
    return false;
  }

  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// HOST CONTROLS
// ═════════════════════════════════════════════════════════════════════════════

// ─── Host Start Session ─────────────────────────────────────────────────────

export async function handleHostStart(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const session = await sessionService.getSessionById(data.sessionId);

    if (session.status !== SessionStatus.SCHEDULED) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session can only start from scheduled state' });
      return;
    }

    // Transition to lobby
    await sessionService.updateSessionStatus(data.sessionId, SessionStatus.LOBBY_OPEN);
    await query('UPDATE sessions SET started_at = NOW() WHERE id = $1', [data.sessionId]);

    // Create LiveKit lobby room for the video mosaic
    try {
      const lobbyRoom = await videoService.createLobbyRoom(data.sessionId);
      await sessionService.updateSessionStatus(data.sessionId, SessionStatus.LOBBY_OPEN, {
        lobbyRoomId: lobbyRoom.roomId,
      });
      logger.info({ sessionId: data.sessionId, lobbyRoom: lobbyRoom.roomId }, 'Lobby LiveKit room created');

      // Distribute lobby tokens to all sockets already in the session room
      try {
        const { config: appConfig } = await import('../../../config');
        const sockets = await io.in(sessionRoom(data.sessionId)).fetchSockets();
        for (const s of sockets) {
          const uid = (s.data as any)?.userId;
          if (!uid) continue;
          const name = (s.data as any)?.displayName || 'User';
          const tok = await videoService.issueJoinToken(uid, lobbyRoom.roomId, name);
          s.emit('lobby:token', {
            token: tok.token,
            livekitUrl: appConfig.livekit.host,
            roomId: lobbyRoom.roomId,
          });
        }
      } catch (broadcastErr) {
        logger.warn({ err: broadcastErr, sessionId: data.sessionId }, 'Failed to broadcast lobby tokens to existing sockets');
      }
    } catch (lobbyErr) {
      logger.warn({ err: lobbyErr, sessionId: data.sessionId }, 'Failed to create lobby LiveKit room — continuing without video mosaic');
    }

    const config = typeof session.config === 'string'
      ? JSON.parse(session.config as unknown as string)
      : session.config;

    // Create active session tracker
    const activeSession: ActiveSession = {
      sessionId: data.sessionId,
      hostUserId: session.hostUserId,
      config,
      currentRound: 0,
      status: SessionStatus.LOBBY_OPEN,
      timer: null,
      timerSyncInterval: null,
      timerEndsAt: null,
      isPaused: false,
      pausedTimeRemaining: null,
      presenceMap: new Map(),
      pendingRoundNumber: null,
      manuallyLeftRound: new Set(),
    };

    activeSessions.set(data.sessionId, activeSession);
    persistSessionState(data.sessionId, activeSession).catch(() => {});

    // Broadcast status change
    io.to(sessionRoom(data.sessionId)).emit('session:status_changed', {
      sessionId: data.sessionId,
      status: SessionStatus.LOBBY_OPEN,
      currentRound: 0,
    });

    // Host-controlled lobby: no auto-timer. Host must click "Start Round" manually.
    logger.info({ sessionId: data.sessionId }, 'Session started → LOBBY_OPEN (host-controlled)');
  } catch (err: any) {
    logger.error({ err }, 'Error starting session');
    socket.emit('error', { code: 'START_FAILED', message: err.message });
  }
  });
}

// ─── Host Start Round (manual trigger) ──────────────────────────────────────

export async function handleHostStartRound(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session is not active' });
      return;
    }

    // Allow starting round from lobby, transition, or closing_lobby (dynamic round extension)
    if (
      activeSession.status !== SessionStatus.LOBBY_OPEN &&
      activeSession.status !== SessionStatus.ROUND_TRANSITION &&
      activeSession.status !== SessionStatus.CLOSING_LOBBY
    ) {
      socket.emit('error', {
        code: 'INVALID_STATE',
        message: 'Can only start a round from the lobby, transition, or closing phase',
      });
      return;
    }

    // Need at least 2 non-host/co-host participants with eligible status
    const allHostIds = await getAllHostIds(data.sessionId, activeSession.hostUserId);
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM session_participants
       WHERE session_id = $1 AND status IN ('in_lobby', 'checked_in', 'registered')
         AND user_id != ALL($2)`,
      [data.sessionId, allHostIds]
    );
    const participantCount = parseInt(countResult.rows[0].count, 10);
    if (participantCount < 2) {
      socket.emit('error', {
        code: 'NOT_ENOUGH_PARTICIPANTS',
        message: `Need at least 2 participants to start a round (currently ${participantCount})`,
      });
      return;
    }

    // Clear the lobby/transition timer — host is overriding
    if (activeSession.timer) {
      clearTimeout(activeSession.timer);
      activeSession.timer = null;
    }

    const nextRound = activeSession.status === SessionStatus.LOBBY_OPEN
      ? 1
      : activeSession.currentRound + 1;

    // If starting a round beyond the original plan, extend the total
    if (nextRound > activeSession.config.numberOfRounds) {
      activeSession.config.numberOfRounds = nextRound;
      logger.info({ sessionId: data.sessionId, newTotal: nextRound }, 'Host extended total rounds dynamically');
    }

    logger.info({ sessionId: data.sessionId, roundNumber: nextRound }, 'Host manually starting round');

    if (!_transitionToRound) {
      logger.error({ sessionId: data.sessionId }, 'transitionToRound not injected — cannot start round');
      socket.emit('error', { code: 'INTERNAL_ERROR', message: 'Round transition not available' });
      return;
    }
    await _transitionToRound(io, data.sessionId, nextRound);
  } catch (err: any) {
    logger.error({ err }, 'Error starting round');
    socket.emit('error', { code: 'START_ROUND_FAILED', message: err.message });
  }
  });
}

// ─── Host Pause ─────────────────────────────────────────────────────────────

export async function handleHostPause(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession || activeSession.isPaused) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session cannot be paused' });
      return;
    }

    // Bug #1 fix — Pause timer drift between host and participants.
    // Compute secondsRemaining ONCE on the server from the authoritative endsAt
    // and broadcast a unified `timer:sync` snapshot to everyone in the session
    // room. Clients display this exact value (no per-client tick drift). Without
    // this, each client kept ticking 1s/sec until their own pause event arrived
    // (network jitter = 12s drift between host and participant).
    let pausedSecondsRemaining = 0;
    if (activeSession.timer && activeSession.timerEndsAt) {
      const remainingMs = Math.max(0, activeSession.timerEndsAt.getTime() - Date.now());
      pausedSecondsRemaining = Math.ceil(remainingMs / 1000);
      clearTimeout(activeSession.timer);
      activeSession.timer = null;
      activeSession.pausedTimeRemaining = remainingMs;
      // Bug 8.6 (April 19) — also clear timerEndsAt during pause. Otherwise
      // emitHostDashboard (which runs every 5s during ROUND_ACTIVE regardless
      // of pause) keeps computing `(timerEndsAt - Date.now())` and emits a
      // decreasing value to the host. Even though the client store doesn't
      // currently re-derive timerSeconds from the dashboard payload, this
      // makes the server state internally consistent: paused == no
      // running endsAt. Resume restores it via startSegmentTimer.
      activeSession.timerEndsAt = null;
    }
    // Stop the periodic 5s timer:sync interval — we'll restart it on resume.
    if (activeSession.timerSyncInterval) {
      clearInterval(activeSession.timerSyncInterval);
      activeSession.timerSyncInterval = null;
    }

    activeSession.isPaused = true;
    persistSessionState(data.sessionId, activeSession).catch(() => {});

    // Unified snapshot — same secondsRemaining for host AND participants.
    // Client useSessionSocket reads `paused` to stop its 1s tick interval and
    // freeze the displayed value at secondsRemaining.
    // Bug 8.5: endsAt:null signals to the client to clear timerEndsAt so
    // the recompute path stops auto-decrementing during pause.
    io.to(sessionRoom(data.sessionId)).emit('timer:sync', {
      segmentType: activeSession.status,
      secondsRemaining: pausedSecondsRemaining,
      paused: true,
      endsAt: null,
    });

    io.to(sessionRoom(data.sessionId)).emit('session:status_changed', {
      sessionId: data.sessionId,
      status: activeSession.status,
      currentRound: activeSession.currentRound,
      isPaused: true,
    });

    logger.info(
      { sessionId: data.sessionId, pausedSecondsRemaining },
      'Session paused — broadcast unified timer:sync snapshot',
    );
  } catch (err: any) {
    socket.emit('error', { code: 'PAUSE_FAILED', message: err.message });
  }
  });
}

// ─── Host Resume ────────────────────────────────────────────────────────────

export async function handleHostResume(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession || !activeSession.isPaused) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session is not paused' });
      return;
    }

    activeSession.isPaused = false;

    // Bug #1 fix — Resume restarts ticks with adjusted endsAt + unified snapshot.
    // Server adjusts endsAt = now + frozen remainingMs and broadcasts a single
    // `timer:sync` (paused: false) so all clients restart their 1s tick from
    // the same secondsRemaining value.
    let resumeSecondsRemaining = 0;
    if (activeSession.pausedTimeRemaining !== null && activeSession.pausedTimeRemaining > 0) {
      const remainingMs = activeSession.pausedTimeRemaining;
      activeSession.pausedTimeRemaining = null;
      resumeSecondsRemaining = Math.ceil(remainingMs / 1000);

      // Determine what callback to use based on current status
      if (!_timerCallbacks) {
        logger.warn({ sessionId: data.sessionId }, 'Timer callbacks not injected — cannot resume timer');
      } else {
        const callback = getTimerCallbackForState(data.sessionId, activeSession, _timerCallbacks);
        // startSegmentTimer recomputes endsAt = now + duration internally and
        // restarts the 5s sync interval — the broadcast below is the immediate
        // unified snapshot so clients don't drift waiting for the next tick.
        startSegmentTimer(io, data.sessionId, remainingMs / 1000, callback);
      }
    }

    persistSessionState(data.sessionId, activeSession).catch(() => {});

    // Bug 8.5: include endsAt so clients restart their derived-from-endsAt
    // computation. activeSession.timerEndsAt was reset by startSegmentTimer
    // above to (now + remainingMs) — exactly what the client needs.
    io.to(sessionRoom(data.sessionId)).emit('timer:sync', {
      segmentType: activeSession.status,
      secondsRemaining: resumeSecondsRemaining,
      paused: false,
      endsAt: activeSession.timerEndsAt ? activeSession.timerEndsAt.toISOString() : null,
    });

    io.to(sessionRoom(data.sessionId)).emit('session:status_changed', {
      sessionId: data.sessionId,
      status: activeSession.status,
      currentRound: activeSession.currentRound,
      isPaused: false,
    });

    logger.info(
      { sessionId: data.sessionId, resumeSecondsRemaining },
      'Session resumed — broadcast unified timer:sync snapshot',
    );
  } catch (err: any) {
    socket.emit('error', { code: 'RESUME_FAILED', message: err.message });
  }
  });
}

// ─── Host End Session ───────────────────────────────────────────────────────

export async function handleHostEnd(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);

    // If currently in an active round, end the round first so users get
    // a rating window before the session completes.
    // endRound() triggers the normal flow: rating window → endRatingWindow() →
    // next round (if more remain) or closing lobby → completeSession().
    if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE) {
      // Clear any existing timer
      if (activeSession.timer) clearTimeout(activeSession.timer);

      if (!_endRound) {
        logger.error({ sessionId: data.sessionId }, 'endRound not injected — cannot end round');
        socket.emit('error', { code: 'INTERNAL_ERROR', message: 'Round end not available' });
        return;
      }

      // End the current round — endRound() schedules the rating window timer
      // which in turn calls endRatingWindow() → multi-round transition logic
      await _endRound(io, data.sessionId, activeSession.currentRound);
      logger.info({ sessionId: data.sessionId }, 'Host ended active round — rating window started, normal flow continues');
      return;
    }

    // If in closing lobby, host can skip the 30s countdown
    if (activeSession && activeSession.status === SessionStatus.CLOSING_LOBBY) {
      if (activeSession.timer) { clearTimeout(activeSession.timer); activeSession.timer = null; }
      logger.info({ sessionId: data.sessionId }, 'Host skipped closing lobby');
    }

    if (!_completeSession) {
      logger.error({ sessionId: data.sessionId }, 'completeSession not injected — cannot complete session');
      socket.emit('error', { code: 'INTERNAL_ERROR', message: 'Session completion not available' });
      return;
    }

    await _completeSession(io, data.sessionId);
    logger.info({ sessionId: data.sessionId }, 'Session ended by host');
  } catch (err: any) {
    socket.emit('error', { code: 'END_FAILED', message: err.message });
  }
  });
}

// ─── Host Broadcast ─────────────────────────────────────────────────────────

export async function handleHostBroadcast(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; message: string }
): Promise<void> {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    io.to(sessionRoom(data.sessionId)).emit('host:broadcast', {
      message: data.message,
      sentAt: new Date().toISOString(),
    });

    logger.info({ sessionId: data.sessionId }, 'Host broadcast sent');
  } catch (err: any) {
    socket.emit('error', { code: 'BROADCAST_FAILED', message: err.message });
  }
}

// ─── Host Remove Participant ────────────────────────────────────────────────

export async function handleHostRemoveParticipant(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; userId: string; reason: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    await sessionService.updateParticipantStatus(
      data.sessionId, data.userId, ParticipantStatus.REMOVED
    );

    // Disconnect the user's socket
    io.to(userRoom(data.userId)).emit('host:participant_removed', {
      userId: data.userId,
      reason: data.reason,
    });

    // Remove from presence
    const activeSession = activeSessions.get(data.sessionId);
    if (activeSession) {
      const presence = activeSession.presenceMap.get(data.userId);
      if (presence) {
        const targetSocket = io.sockets.sockets.get(presence.socketId);
        if (targetSocket) {
          targetSocket.leave(sessionRoom(data.sessionId));
        }
        activeSession.presenceMap.delete(data.userId);
      }
    }

    io.to(sessionRoom(data.sessionId)).emit('participant:left', { userId: data.userId });

    logger.info({ sessionId: data.sessionId, removedUserId: data.userId }, 'Participant removed by host');
  } catch (err: any) {
    socket.emit('error', { code: 'REMOVE_FAILED', message: err.message });
  }
  });
}

// ─── Host Reassign ──────────────────────────────────────────────────────────

export async function handleHostReassign(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; participantId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession || activeSession.status !== SessionStatus.ROUND_ACTIVE) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Can only reassign during active round' });
      return;
    }

    // Find available participants (those whose partner disconnected/left/no-showed)
    const matches = await matchingService.getMatchesByRound(
      data.sessionId, activeSession.currentRound
    );

    // Find isolated participants (no_show or reassigned match partners)
    const isolatedParticipants: string[] = [];
    for (const match of matches) {
      if (match.status === MatchStatus.NO_SHOW || match.status === MatchStatus.REASSIGNED) {
        // Find the remaining participant
        const aPresent = activeSession.presenceMap.has(match.participantAId);
        const bPresent = activeSession.presenceMap.has(match.participantBId);
        if (aPresent && !bPresent) isolatedParticipants.push(match.participantAId);
        if (bPresent && !aPresent) isolatedParticipants.push(match.participantBId);
      }
    }

    // Try to pair the target participant with an isolated one
    const targetId = data.participantId;
    const partner = isolatedParticipants.find(id => id !== targetId);

    if (partner) {
      // Create a new match for this round
      const reassignSlug = `reassign-${Date.now()}`;
      const roomId = `session-${data.sessionId}-round-${activeSession.currentRound}-${reassignSlug}`;

      // Create the LiveKit room BEFORE inserting the match
      try {
        await videoService.createMatchRoom(data.sessionId, activeSession.currentRound, reassignSlug);
      } catch (err) {
        logger.warn({ err, roomId }, 'LiveKit room creation failed for reassignment (may already exist)');
      }

      let matchId = '';
      await transaction(async (client) => {
        const { v4: uuid } = await import('uuid');
        matchId = uuid();
        await client.query(
          `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, room_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
          [matchId, data.sessionId, activeSession.currentRound,
           targetId < partner ? targetId : partner,
           targetId < partner ? partner : targetId,
           roomId]
        );
      });

      // Generate tokens for both participants inline
      const { config: appConfig } = await import('../../../config');
      let targetToken: string | null = null;
      let partnerToken: string | null = null;
      try {
        const targetName = (await query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [targetId])).rows[0]?.display_name || 'User';
        const partnerName = (await query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [partner])).rows[0]?.display_name || 'User';
        const [tVt, pVt] = await Promise.all([
          videoService.issueJoinToken(targetId, roomId, targetName),
          videoService.issueJoinToken(partner, roomId, partnerName),
        ]);
        targetToken = tVt.token;
        partnerToken = pVt.token;
      } catch (err) {
        logger.warn({ err }, 'Inline token gen failed for reassignment — clients will retry via API');
      }

      // Notify both participants
      io.to(userRoom(targetId)).emit('match:reassigned', {
        matchId,
        newPartnerId: partner,
        roomId,
        token: targetToken,
        livekitUrl: appConfig.livekit.host,
      });

      io.to(userRoom(partner)).emit('match:reassigned', {
        matchId,
        newPartnerId: targetId,
        roomId,
        token: partnerToken,
        livekitUrl: appConfig.livekit.host,
      });

      logger.info({ sessionId: data.sessionId, targetId, partner }, 'Participant reassigned');
    } else {
      socket.emit('error', { code: 'NO_PARTNER', message: 'No available partner for reassignment' });
    }
  } catch (err: any) {
    socket.emit('error', { code: 'REASSIGN_FAILED', message: err.message });
  }
  });
}

// ─── Host: Mute/Unmute Participant ──────────────────────────────────────────

export async function handleHostMuteParticipant(
  io: SocketServer,
  socket: Socket,
  data: any
): Promise<void> {
  const userId = getUserIdFromSocket(socket);
  if (!userId) return;

  const activeSession = activeSessions.get(data.sessionId);
  if (!activeSession) {
    socket.emit('error', { code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    return;
  }

  if (activeSession.hostUserId !== userId) {
    socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can mute/unmute participants' });
    return;
  }

  // Relay mute command to the target participant's client
  io.to(userRoom(data.targetUserId)).emit('lobby:mute_command', {
    muted: data.muted,
    byHost: true,
  });

  logger.info({ sessionId: data.sessionId, targetUserId: data.targetUserId, muted: data.muted },
    'Host mute/unmute command sent');
}

// ─── Host: Mute/Unmute All ─────────────────────────────────────────────────

export async function handleHostMuteAll(
  io: SocketServer,
  socket: Socket,
  data: any
): Promise<void> {
  const userId = getUserIdFromSocket(socket);
  if (!userId) return;

  const activeSession = activeSessions.get(data.sessionId);
  if (!activeSession) {
    socket.emit('error', { code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    return;
  }

  if (activeSession.hostUserId !== userId) {
    socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can mute/unmute all participants' });
    return;
  }

  let count = 0;
  for (const [participantId] of activeSession.presenceMap) {
    // Skip the host — they should not be muted
    if (participantId === activeSession.hostUserId) continue;
    io.to(userRoom(participantId)).emit('lobby:mute_command', {
      muted: data.muted,
      byHost: true,
    });
    count++;
  }

  logger.info({ sessionId: data.sessionId, muted: data.muted, count },
    'Host mute/unmute all command sent');
}

// ─── Host: Remove participant from breakout room ────────────────────────────

export async function handleHostRemoveFromRoom(
  io: SocketServer,
  socket: Socket,
  data: any
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  const userId = getUserIdFromSocket(socket);
  if (!userId) return;

  const activeSession = activeSessions.get(data.sessionId);
  if (!activeSession) {
    socket.emit('error', { code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    return;
  }

  if (activeSession.hostUserId !== userId) {
    socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can remove participants from rooms' });
    return;
  }

  try {
    // Determine terminal status: real conversation (>30s or rated) → completed,
    // else cancelled. no_show is reserved for "never connected".
    const matchInfoRes = await query<{ seconds: string; rating_count: string }>(
      `SELECT
         EXTRACT(EPOCH FROM (NOW() - started_at))::text AS seconds,
         (SELECT COUNT(*)::text FROM ratings WHERE match_id = $1) AS rating_count
       FROM matches WHERE id = $1`,
      [data.matchId],
    );
    const durationS = parseFloat(matchInfoRes.rows[0]?.seconds || '0');
    const ratingCount = parseInt(matchInfoRes.rows[0]?.rating_count || '0', 10);
    const terminalStatus = (durationS > 30 || ratingCount > 0) ? 'completed' : 'cancelled';

    await query(
      `UPDATE matches SET status = $2, ended_at = NOW() WHERE id = $1 AND status = 'active'`,
      [data.matchId, terminalStatus]
    );

    logger.info(
      { sessionId: (data as any).sessionId, matchId: data.matchId, durationS, ratingCount, terminalStatus },
      'Host removed participant — match ended'
    );

    // Clear any per-room timer/sync for this match (prevents ghost timers)
    clearRoomTimers(data.matchId);

    // Get match participants before updating
    const matchResult = await query<{ participant_a_id: string; participant_b_id: string; participant_c_id: string | null }>(
      `SELECT participant_a_id, participant_b_id, participant_c_id FROM matches WHERE id = $1`,
      [data.matchId]
    );

    // Return the removed user with rating screen (NOT evict from event)
    await sessionService.updateParticipantStatus(data.sessionId, data.userId, ParticipantStatus.IN_LOBBY).catch(() => {});

    // Show rating only if there were actual partners (not solo in room)
    if (matchResult.rows.length > 0) {
      const match = matchResult.rows[0];
      const partnerIds = [match.participant_a_id, match.participant_b_id, match.participant_c_id]
        .filter((id): id is string => !!id && id !== data.userId);

      if (partnerIds.length > 0) {
        const partnerNameRes = await query<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM users WHERE id = ANY($1)`, [partnerIds]
        );
        const pnm = new Map(partnerNameRes.rows.map(r => [r.id, r.display_name || 'Partner']));
        const partnersWithNames = partnerIds.map(pid => ({ userId: pid, displayName: pnm.get(pid) || 'Partner' }));

        await emitRatingWindowOnce(io, data.userId, data.matchId, {
          matchId: data.matchId,
          partnerId: partnerIds[0],
          partnerDisplayName: pnm.get(partnerIds[0]) || 'Partner',
          partners: partnersWithNames,
          durationSeconds: 20,
          earlyLeave: true,
        });
      } else {
        // Solo — no one to rate, just return to lobby
        io.to(userRoom(data.userId)).emit('match:return_to_lobby', { reason: 'host_removed' });
      }
    }

    // Re-issue lobby token for the removed user
    const session = await sessionService.getSessionById(data.sessionId);
    if (session.lobbyRoomId) {
      try {
        const { config: appConfig } = await import('../../../config');
        const socketsInRoom = await io.in(userRoom(data.userId)).fetchSockets();
        for (const sk of socketsInRoom) {
          const uid = (sk.data as any)?.userId;
          if (uid !== data.userId) continue;
          const dName = (sk.data as any)?.displayName || 'User';
          const lobbyToken = await videoService.issueJoinToken(uid, session.lobbyRoomId, dName);
          sk.emit('lobby:token', { token: lobbyToken.token, livekitUrl: appConfig.livekit.host, roomId: session.lobbyRoomId });
        }
      } catch { /* skip */ }
    }

    // Notify partner — show "partner left" with 5s countdown, then rating + lobby
    if (matchResult.rows.length > 0) {
      const match = matchResult.rows[0];
      const partnerIds = [match.participant_a_id, match.participant_b_id, match.participant_c_id]
        .filter((id): id is string => !!id && id !== data.userId);

      for (const partnerId of partnerIds) {
        io.to(userRoom(partnerId)).emit('match:partner_disconnected', { matchId: data.matchId });
      }

      // Server-side 5s timeout: return partner to rating → lobby
      // (Client's auto-leave won't work because match is already 'no_show').
      //
      // Tier-1 A3: guard the deferred callback against session-ended race.
      // If the host ended the event during this 5 s window, firing rating
      // prompts + reissuing lobby tokens against a dead session would emit
      // stale events to disconnected sockets and touch a DB row whose
      // parent session is in the completed/deleted state. Bail out early.
      setTimeout(async () => {
        const currentSession = activeSessions.get(data.sessionId);
        if (!currentSession) {
          logger.info({ sessionId: data.sessionId, userId: data.userId }, 'Session ended during host-remove 5s grace — skipping partner-return flow');
          return;
        }
        try {
          const removedNameRes = await query<{ display_name: string }>(
            `SELECT display_name FROM users WHERE id = $1`, [data.userId]
          );
          const removedName = removedNameRes.rows[0]?.display_name || 'Partner';

          for (const partnerId of partnerIds) {
            await sessionService.updateParticipantStatus(data.sessionId, partnerId, ParticipantStatus.IN_LOBBY).catch(() => {});

            await emitRatingWindowOnce(io, partnerId, data.matchId, {
              matchId: data.matchId,
              partnerId: data.userId,
              partnerDisplayName: removedName,
              partners: [{ userId: data.userId, displayName: removedName }],
              durationSeconds: 20,
              earlyLeave: true,
            });

            // Re-issue lobby token
            if (session.lobbyRoomId) {
              try {
                const { config: appConfig2 } = await import('../../../config');
                const socketsInRoom = await io.in(userRoom(partnerId)).fetchSockets();
                for (const sk of socketsInRoom) {
                  const uid = (sk.data as any)?.userId;
                  if (uid !== partnerId) continue;
                  const dName = (sk.data as any)?.displayName || 'User';
                  const lobbyToken = await videoService.issueJoinToken(uid, session.lobbyRoomId, dName);
                  sk.emit('lobby:token', { token: lobbyToken.token, livekitUrl: appConfig2.livekit.host, roomId: session.lobbyRoomId });
                }
              } catch { /* skip */ }
            }
          }

          if (_emitHostDashboard) await _emitHostDashboard(data.sessionId).catch(() => {});
        } catch (err) {
          logger.error({ err }, 'Error in host remove-from-room partner timeout');
        }
      }, 5000);
    }

    // Refresh host dashboard
    if (_emitHostDashboard) {
      await _emitHostDashboard(data.sessionId);
    }

    // Bug 4 (April 18 Dr Arch): if the removal ended the last active match in
    // an algorithm round, we'd be stuck in ROUND_ACTIVE with 0 active matches.
    maybeAutoEndEmptyRound(data.sessionId);

    logger.info({ sessionId: data.sessionId, matchId: data.matchId, removedUserId: data.userId },
      'Host removed participant from breakout room');
  } catch (err) {
    logger.error({ err }, 'Error removing participant from room');
    socket.emit('error', { code: 'REMOVE_FAILED', message: 'Failed to remove participant from room' });
  }
  });
}

// ─── Host: Move Participant to Another Room ─────────────────────────────────

export async function handleHostMoveToRoom(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; userId: string; targetMatchId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession || activeSession.status !== SessionStatus.ROUND_ACTIVE) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Can only move participants during an active round' });
      return;
    }

    const { userId, targetMatchId, sessionId } = data;

    // Find the user's current match
    const currentMatchResult = await query<{ id: string; participant_a_id: string; participant_b_id: string; room_id: string }>(
      `SELECT id, participant_a_id, participant_b_id, room_id FROM matches
       WHERE session_id = $1 AND round_number = $2 AND status = 'active'
         AND (participant_a_id = $3 OR participant_b_id = $3)`,
      [sessionId, activeSession.currentRound, userId]
    );

    if (currentMatchResult.rows.length === 0) {
      socket.emit('error', { code: 'NOT_IN_MATCH', message: 'Participant is not in an active match' });
      return;
    }

    const currentMatch = currentMatchResult.rows[0];
    const currentPartnerId = currentMatch.participant_a_id === userId
      ? currentMatch.participant_b_id : currentMatch.participant_a_id;

    // Find the target match
    const targetMatchResult = await query<{ id: string; participant_a_id: string; participant_b_id: string; room_id: string }>(
      `SELECT id, participant_a_id, participant_b_id, room_id FROM matches WHERE id = $1 AND status = 'active'`,
      [targetMatchId]
    );

    if (targetMatchResult.rows.length === 0) {
      socket.emit('error', { code: 'TARGET_NOT_FOUND', message: 'Target room not found or not active' });
      return;
    }

    const targetMatch = targetMatchResult.rows[0];
    const targetParticipants = [targetMatch.participant_a_id, targetMatch.participant_b_id];

    // End the user's current match
    await query(`UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1`, [currentMatch.id]);

    // Give the abandoned partner a bye
    io.to(userRoom(currentPartnerId)).emit('match:return_to_lobby', { reason: 'partner_left' });

    // Create new match: user joins the target room participants
    const moveSlug = `move-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newRoomId = `session-${sessionId}-round-${activeSession.currentRound}-${moveSlug}`;
    try {
      await videoService.createMatchRoom(sessionId, activeSession.currentRound, moveSlug);
    } catch (err) {
      logger.warn({ err, newRoomId }, 'LiveKit room creation failed for move (may already exist)');
    }
    const allParticipants = [...targetParticipants, userId];
    const [pA, pB] = allParticipants[0] < allParticipants[1]
      ? [allParticipants[0], allParticipants[1]] : [allParticipants[1], allParticipants[0]];

    // End the old target match
    await query(`UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1`, [targetMatchId]);

    // Insert new match with all participants
    const newMatchResult = await query<{ id: string }>(
      `INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW()) RETURNING id`,
      [sessionId, activeSession.currentRound, pA, pB, allParticipants.length > 2 ? allParticipants[2] : null, newRoomId]
    );
    const newMatchId = newMatchResult.rows[0].id;

    // Get display names for all participants
    const namesResult = await query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM users WHERE id = ANY($1)`, [allParticipants]
    );
    const nameMap = new Map(namesResult.rows.map(r => [r.id, r.display_name || 'User']));

    // Generate tokens and notify all participants in the new room
    const { config: moveConfig } = await import('../../../config');
    const tokenMapMove = new Map<string, string>();
    try {
      const tokenResults = await Promise.all(
        allParticipants.map(async (pid) => {
          const vt = await videoService.issueJoinToken(pid, newRoomId, nameMap.get(pid) || 'User');
          return { pid, token: vt.token };
        })
      );
      for (const { pid, token } of tokenResults) tokenMapMove.set(pid, token);
    } catch (err) {
      logger.warn({ err }, 'Inline token gen failed for move-reassign — clients will retry via API');
    }

    for (const pid of allParticipants) {
      const partners = allParticipants.filter(p => p !== pid).map(p => ({
        userId: p,
        displayName: nameMap.get(p) || 'User',
      }));
      io.to(userRoom(pid)).emit('match:reassigned', {
        matchId: newMatchId,
        newPartnerId: partners[0]?.userId,
        partnerDisplayName: partners[0]?.displayName,
        roomId: newRoomId,
        roundNumber: activeSession.currentRound,
        token: tokenMapMove.get(pid) || null,
        livekitUrl: moveConfig.livekit.host,
      });
    }

    // Give abandoned partner a bye notification
    io.to(userRoom(currentPartnerId)).emit('match:bye_round', {
      roundNumber: activeSession.currentRound,
      reason: 'The host moved your partner to another room. Waiting for next round.',
    });

    // Refresh dashboard
    if (_emitHostDashboard) {
      await _emitHostDashboard(sessionId);
    }

    // Bug 4 (April 18 Dr Arch): in the unlikely event the move/end pattern
    // leaves zero active matches in the round, auto-end so we don't lock up.
    maybeAutoEndEmptyRound(sessionId);

    logger.info({ sessionId, userId, targetMatchId, newMatchId },
      'Host moved participant to another room');
  } catch (err: any) {
    logger.error({ err }, 'Error moving participant to room');
    socket.emit('error', { code: 'MOVE_FAILED', message: err.message });
  }
  });
}

// ─── Host: Extend Round Timer ──────────────────────────────────────────────

export async function handleHostExtendRound(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; additionalSeconds: number }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession || !activeSession.timerEndsAt) {
      socket.emit('error', { code: 'NO_TIMER', message: 'No active timer to extend' });
      return;
    }

    if (activeSession.status !== SessionStatus.ROUND_ACTIVE) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Can only extend timer during an active round' });
      return;
    }

    const additionalMs = (data.additionalSeconds || 120) * 1000;

    // Extend the timerEndsAt
    const newEndsAt = new Date(activeSession.timerEndsAt.getTime() + additionalMs);
    activeSession.timerEndsAt = newEndsAt;

    // Reschedule the main timeout: clear old, set new with remaining time
    if (activeSession.timer) {
      clearTimeout(activeSession.timer);
      activeSession.timer = null;
    }

    const remainingMs = newEndsAt.getTime() - Date.now();
    if (_timerCallbacks) {
      const callback = getTimerCallbackForState(data.sessionId, activeSession, _timerCallbacks);
      // Set a raw timeout (don't use startSegmentTimer which resets timerEndsAt)
      activeSession.timer = setTimeout(() => {
        activeSession.timer = null;
        activeSession.timerEndsAt = null;
        if (activeSession.timerSyncInterval) {
          clearInterval(activeSession.timerSyncInterval);
          activeSession.timerSyncInterval = null;
        }
        callback();
      }, remainingMs);
    }

    // Broadcast updated timer to all participants. Bug 8.5: include endsAt
    // so the client's derived-from-endsAt computation immediately reflects
    // the +120s extension instead of waiting for the next periodic sync.
    const remaining = Math.ceil(remainingMs / 1000);
    io.to(sessionRoom(data.sessionId)).emit('timer:sync', {
      segmentType: activeSession.status,
      secondsRemaining: remaining,
      endsAt: newEndsAt.toISOString(),
    });

    persistSessionState(data.sessionId, activeSession);

    logger.info(
      { sessionId: data.sessionId, additionalSeconds: data.additionalSeconds, newRemaining: remaining },
      'Round extended by host'
    );
  });
}

// ─── Host Extend Breakout Room Timer ──────────────────────────────────────
//
// Extends a per-room timer started by handleHostCreateBreakout (manual rooms
// with custom duration). Mirrors handleHostExtendRound but targets a single
// match instead of the session-level round timer.
//
// Preserves Change 4.5 ghost-timer fixes: the sync interval reads endsAt from
// the RoomTimerState struct, so extensions propagate to participants on the
// next 5s tick without any extra state.

export async function handleHostExtendBreakoutRoom(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; matchId: string; additionalSeconds: number },
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    if (!await verifyHost(socket, data.sessionId)) return;

    const { sessionId, matchId } = data;
    const additionalSeconds = data.additionalSeconds || 120;

    const activeSession = activeSessions.get(sessionId);
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session not active.' });
      return;
    }

    const roomTimer = roomTimers.get(matchId);
    if (!roomTimer) {
      socket.emit('error', { code: 'NO_TIMER', message: 'Breakout room timer not found.' });
      return;
    }

    // Validate match is still active
    const matchRes = await query<{ status: string }>(
      `SELECT status FROM matches WHERE id = $1`,
      [matchId],
    );
    if (matchRes.rows.length === 0 || matchRes.rows[0].status !== 'active') {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Breakout room is not active.' });
      return;
    }

    // Extend endsAt and reschedule the expiry timeout
    const newEndsAt = new Date(roomTimer.endsAt.getTime() + additionalSeconds * 1000);
    roomTimer.endsAt = newEndsAt;

    clearTimeout(roomTimer.timeoutHandle);
    const msRemaining = Math.max(0, newEndsAt.getTime() - Date.now());
    roomTimer.timeoutHandle = setTimeout(() => { roomTimer.fireCallback(); }, msRemaining);

    // Broadcast timer:sync to match participants immediately (don't wait for 5s tick).
    // Bug 15 — include endsAt so client recompute (Bug 8.5) reflects the
    // extended duration; otherwise the digit jumps to the new value once
    // and then doesn't tick down.
    const secondsRemaining = Math.ceil(msRemaining / 1000);
    const newEndsAtIso = newEndsAt.toISOString();
    for (const pid of roomTimer.participantIds) {
      io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining, endsAt: newEndsAtIso });
    }

    // Refresh host dashboard
    if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});

    logger.info(
      { sessionId, matchId, additionalSeconds, newEndsAt: newEndsAt.toISOString(), secondsRemaining },
      'Host extended breakout room timer',
    );
  });
}

// ─── Co-Host Management ─────────────────────────────────────────────────────

export async function handleAssignCohost(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; userId: string; role: 'co_host' | 'moderator' }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    const hostId = getUserIdFromSocket(socket);
    if (!hostId) return;

    const { sessionId, userId, role } = data;
    const session = await sessionService.getSessionById(sessionId);

    // Only the original host (not co-hosts) can assign co-hosts
    if (session.hostUserId !== hostId) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Only the event host can assign co-hosts' });
      return;
    }

    await query(
      `INSERT INTO session_cohosts (session_id, user_id, role, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, user_id) DO UPDATE SET role = $3`,
      [sessionId, userId, role, hostId]
    );

    const displayName = (await query<{ display_name: string }>(
      `SELECT display_name FROM users WHERE id = $1`, [userId]
    )).rows[0]?.display_name || 'User';

    io.to(sessionRoom(sessionId)).emit('cohost:assigned', { userId, displayName, role });
    // T1-5 — direct permission notification to the newly-promoted co-host
    // so their UI re-renders host-only buttons without polling/refresh.
    io.to(userRoom(userId)).emit('permissions:updated', {
      sessionId,
      effectiveRole: 'cohost' as const,
      capabilities: [
        'mute_participants', 'remove_participants', 'reassign',
        'start_round', 'pause', 'resume', 'broadcast', 'create_breakout',
      ],
    });
    logger.info({ sessionId, userId, role, grantedBy: hostId }, 'Co-host assigned');
  } catch (err) {
    logger.error({ err }, 'Error assigning co-host');
    socket.emit('error', { code: 'COHOST_FAILED', message: 'Failed to assign co-host' });
  }
  });
}

export async function handleRemoveCohost(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; userId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
  try {
    const hostId = getUserIdFromSocket(socket);
    if (!hostId) return;

    const { sessionId, userId } = data;
    const session = await sessionService.getSessionById(sessionId);

    if (session.hostUserId !== hostId) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Only the event host can remove co-hosts' });
      return;
    }

    await query(
      `DELETE FROM session_cohosts WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId]
    );

    io.to(sessionRoom(sessionId)).emit('cohost:removed', { userId });
    // T1-5 — direct permission downgrade so removed co-host's UI hides
    // host-only controls without polling/refresh.
    io.to(userRoom(userId)).emit('permissions:updated', {
      sessionId,
      effectiveRole: 'participant' as const,
      capabilities: [],
    });
    logger.info({ sessionId, userId, removedBy: hostId }, 'Co-host removed');
  } catch (err) {
    logger.error({ err }, 'Error removing co-host');
  }
  });
}

// ─── Promote Co-Host to Host (T1-5 — host transfer) ────────────────────────
//
// The original event host can transfer ownership to an existing co-host.
// Without this handler the host couldn't gracefully leave mid-session;
// they had to either let the event run without them or end it. Now they
// can hand the baton.
//
// Steps (under withSessionGuard for the affected session):
//   1. Verify caller is the current `sessions.host_user_id` (not a co-host
//      — only the original host can transfer)
//   2. Verify target is currently in `session_cohosts` for this session
//   3. UPDATE sessions SET host_user_id = target
//   4. DELETE old co-host row for the target (they're host now, not cohost)
//   5. Broadcast host:transferred to the session room + permissions:updated
//      to both old and new host's user rooms

export async function handlePromoteCohost(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; cohostUserId: string },
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    try {
      const hostId = getUserIdFromSocket(socket);
      if (!hostId) return;

      const { sessionId, cohostUserId } = data;
      const session = await sessionService.getSessionById(sessionId);

      if (session.hostUserId !== hostId) {
        socket.emit('error', { code: 'FORBIDDEN', message: 'Only the original host can transfer ownership' });
        return;
      }

      const cohostCheck = await query(
        `SELECT 1 FROM session_cohosts WHERE session_id = $1 AND user_id = $2`,
        [sessionId, cohostUserId],
      );
      if (cohostCheck.rows.length === 0) {
        socket.emit('error', { code: 'NOT_COHOST', message: 'Target user is not a co-host of this session' });
        return;
      }

      await query(`UPDATE sessions SET host_user_id = $1 WHERE id = $2`, [cohostUserId, sessionId]);
      await query(
        `DELETE FROM session_cohosts WHERE session_id = $1 AND user_id = $2`,
        [sessionId, cohostUserId],
      );

      // Update in-memory ActiveSession so subsequent verifyHost calls see new host
      const activeSession = activeSessions.get(sessionId);
      if (activeSession) activeSession.hostUserId = cohostUserId;

      const newHostName = (await query<{ display_name: string }>(
        `SELECT display_name FROM users WHERE id = $1`, [cohostUserId],
      )).rows[0]?.display_name || 'New Host';

      io.to(sessionRoom(sessionId)).emit('host:transferred', {
        sessionId,
        previousHostId: hostId,
        newHostId: cohostUserId,
        newHostDisplayName: newHostName,
      });

      // Direct permission updates to both parties so UIs re-render.
      io.to(userRoom(cohostUserId)).emit('permissions:updated', {
        sessionId,
        effectiveRole: 'event_host' as const,
        capabilities: [
          'assign_cohost', 'remove_cohost', 'promote_cohost',
          'mute_participants', 'remove_participants', 'reassign',
          'start_round', 'pause', 'resume', 'broadcast', 'create_breakout',
          'end_session',
        ],
      });
      io.to(userRoom(hostId)).emit('permissions:updated', {
        sessionId,
        effectiveRole: 'participant' as const,
        capabilities: [],
      });

      logger.info({ sessionId, previousHostId: hostId, newHostId: cohostUserId }, 'Host transferred');
    } catch (err) {
      logger.error({ err }, 'Error promoting co-host');
      socket.emit('error', { code: 'PROMOTE_FAILED', message: 'Failed to transfer host role' });
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// HOST REST API HELPERS (called from routes)
// ═════════════════════════════════════════════════════════════════════════════

let _io: SocketServer | null = null;

/** Set the io reference for REST API helpers. Called during wiring. */
export function setHostActionsIo(io: SocketServer): void {
  _io = io;
}

export async function startSession(sessionId: string, hostUserId: string): Promise<void> {
  const session = await sessionService.getSessionById(sessionId);
  if (session.hostUserId !== hostUserId) {
    throw new ForbiddenError('Only the host can start a session');
  }
  if (session.status !== SessionStatus.SCHEDULED) {
    throw new ValidationError('Session can only start from scheduled state');
  }

  await sessionService.updateSessionStatus(sessionId, SessionStatus.LOBBY_OPEN);
  await query('UPDATE sessions SET started_at = NOW() WHERE id = $1', [sessionId]);

  const config = typeof session.config === 'string'
    ? JSON.parse(session.config as unknown as string)
    : session.config;

  const activeSession: ActiveSession = {
    sessionId,
    hostUserId: session.hostUserId,
    config,
    currentRound: 0,
    status: SessionStatus.LOBBY_OPEN,
    timer: null,
    timerSyncInterval: null,
    timerEndsAt: null,
    isPaused: false,
    pausedTimeRemaining: null,
    presenceMap: new Map(),
    pendingRoundNumber: null,
    manuallyLeftRound: new Set(),
  };

  activeSessions.set(sessionId, activeSession);

  if (_io) {
    _io.to(sessionRoom(sessionId)).emit('session:status_changed', {
      sessionId,
      status: SessionStatus.LOBBY_OPEN,
      currentRound: 0,
    });
  }

  // Host-controlled lobby: no auto-timer. Host must click "Start Round" manually.
  logger.info({ sessionId }, 'Session started via REST → LOBBY_OPEN (host-controlled)');
}

export async function pauseSession(sessionId: string, hostUserId: string): Promise<void> {
  const session = await sessionService.getSessionById(sessionId);
  if (session.hostUserId !== hostUserId) {
    throw new ForbiddenError('Only the host can pause a session');
  }

  const activeSession = activeSessions.get(sessionId);
  if (!activeSession || activeSession.isPaused) {
    throw new ValidationError('Session cannot be paused');
  }

  // Bug #1 fix — see handleHostPause for full rationale. Compute snapshot
  // ONCE on server, broadcast unified timer:sync so all clients freeze at
  // the same value (no per-client tick drift).
  let pausedSecondsRemaining = 0;
  if (activeSession.timer && activeSession.timerEndsAt) {
    const remainingMs = Math.max(0, activeSession.timerEndsAt.getTime() - Date.now());
    pausedSecondsRemaining = Math.ceil(remainingMs / 1000);
    clearTimeout(activeSession.timer);
    activeSession.timer = null;
    activeSession.pausedTimeRemaining = remainingMs;
  }
  if (activeSession.timerSyncInterval) {
    clearInterval(activeSession.timerSyncInterval);
    activeSession.timerSyncInterval = null;
  }

  activeSession.isPaused = true;

  if (_io) {
    _io.to(sessionRoom(sessionId)).emit('timer:sync', {
      segmentType: activeSession.status,
      secondsRemaining: pausedSecondsRemaining,
      paused: true,
    });
    _io.to(sessionRoom(sessionId)).emit('session:status_changed', {
      sessionId,
      status: activeSession.status,
      currentRound: activeSession.currentRound,
      isPaused: true,
    });
  }

  logger.info({ sessionId, pausedSecondsRemaining }, 'Session paused via REST');
}

export async function resumeSession(sessionId: string, hostUserId: string): Promise<void> {
  const session = await sessionService.getSessionById(sessionId);
  if (session.hostUserId !== hostUserId) {
    throw new ForbiddenError('Only the host can resume a session');
  }

  const activeSession = activeSessions.get(sessionId);
  if (!activeSession || !activeSession.isPaused) {
    throw new ValidationError('Session is not paused');
  }

  activeSession.isPaused = false;

  // Bug #1 fix — same unified-snapshot pattern as handleHostResume.
  let resumeSecondsRemaining = 0;
  if (activeSession.pausedTimeRemaining !== null && activeSession.pausedTimeRemaining > 0) {
    const remainingMs = activeSession.pausedTimeRemaining;
    activeSession.pausedTimeRemaining = null;
    resumeSecondsRemaining = Math.ceil(remainingMs / 1000);
    if (_timerCallbacks) {
      const callback = getTimerCallbackForState(sessionId, activeSession, _timerCallbacks);
      startSegmentTimer(_io!, sessionId, remainingMs / 1000, callback);
    } else {
      logger.warn({ sessionId }, 'Timer callbacks not injected — cannot resume timer via REST');
    }
  }

  if (_io) {
    _io.to(sessionRoom(sessionId)).emit('timer:sync', {
      segmentType: activeSession.status,
      secondsRemaining: resumeSecondsRemaining,
      paused: false,
    });
    _io.to(sessionRoom(sessionId)).emit('session:status_changed', {
      sessionId,
      status: activeSession.status,
      currentRound: activeSession.currentRound,
      isPaused: false,
    });
  }

  logger.info({ sessionId, resumeSecondsRemaining }, 'Session resumed via REST');
}

export async function endSession(sessionId: string, hostUserId: string): Promise<void> {
  const session = await sessionService.getSessionById(sessionId);
  if (session.hostUserId !== hostUserId) {
    throw new ForbiddenError('Only the host can end a session');
  }

  if (!_completeSession || !_io) {
    throw new ValidationError('Session completion not available — server not fully initialised');
  }

  await _completeSession(_io, sessionId);
  logger.info({ sessionId }, 'Session ended via REST');
}

export async function broadcastMessage(
  sessionId: string,
  hostUserId: string,
  message: string
): Promise<void> {
  const session = await sessionService.getSessionById(sessionId);
  if (session.hostUserId !== hostUserId) {
    throw new ForbiddenError('Only the host can broadcast');
  }

  if (_io) {
    _io.to(sessionRoom(sessionId)).emit('host:broadcast', {
      message,
      sentAt: new Date().toISOString(),
    });
  }
}

// ─── Host Create Breakout Room ────────────────────────────────────────────

/**
 * Per-room timer state for host-created breakout rooms with custom duration.
 *
 * Tracks endsAt + startedAt + participantIds so the timer can be extended by
 * `handleHostExtendBreakoutRoom` without losing the original expiry callback.
 * The callback is stored as `fireCallback` so extension can reschedule it.
 *
 * Exported for use by breakout-bulk.ts (Task 14 — bulk manual breakout ops).
 */
export interface RoomTimerState {
  timeoutHandle: NodeJS.Timeout;
  endsAt: Date;
  startedAt: Date;
  participantIds: string[];
  fireCallback: () => Promise<void>;
}

export const roomTimers = new Map<string, RoomTimerState>();
export const roomSyncIntervals = new Map<string, NodeJS.Timeout>();

/** Clear per-room timer and sync interval for a given matchId */
export function clearRoomTimers(matchId: string): void {
  const timer = roomTimers.get(matchId);
  if (timer) { clearTimeout(timer.timeoutHandle); roomTimers.delete(matchId); }
  const interval = roomSyncIntervals.get(matchId);
  if (interval) { clearInterval(interval); roomSyncIntervals.delete(matchId); }
}

// ─── LOBBY_OPEN dashboard polling — defensive safety net ──────────────────
//
// The round-lifecycle dashboard polling interval (round-lifecycle.ts) only runs
// during ROUND_ACTIVE. Manual breakout rooms (handleHostCreateBreakout +
// handleHostCreateBreakoutBulk) run during LOBBY_OPEN, so the dashboard never
// auto-refreshed during that phase and ghost-room cards persisted indefinitely
// when matches transitioned to terminal status.
//
// This map tracks per-session polling intervals that fire while there is at
// least one active manual match. The interval self-stops when no manual match
// remains, so it has zero overhead during normal (algorithm) rounds.
//
// Forward-compat: phase 2 Redis pub/sub can replace this poll by subscribing
// to a `match:status_changed` channel — call sites already emit at every
// transition, so the migration is mechanical (poll → subscribe).

export const manualDashboardIntervals = new Map<string, NodeJS.Timeout>();

const MANUAL_DASHBOARD_INTERVAL_MS = 5000;

/**
 * Ensure a per-session 5s dashboard refresh interval is running. Idempotent —
 * calling twice for the same session returns the same handle. The interval
 * self-stops when no active manual matches remain for the session (or the
 * session leaves activeSessions entirely).
 *
 * Call this from any flow that creates a manual breakout room (single or bulk).
 */
export function ensureManualDashboardInterval(_io: SocketServer, sessionId: string): void {
  if (manualDashboardIntervals.has(sessionId)) return;

  const interval = setInterval(async () => {
    const session = activeSessions.get(sessionId);
    if (!session) {
      const h = manualDashboardIntervals.get(sessionId);
      if (h) clearInterval(h);
      manualDashboardIntervals.delete(sessionId);
      return;
    }

    // Stop polling once active manual matches drain — saves CPU during long
    // idle stretches between rounds. Caller will start a fresh interval the
    // next time a manual room is created.
    let hasActiveManual = false;
    try {
      const r = await query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM matches
           WHERE session_id = $1 AND status = 'active' AND is_manual = TRUE
         ) AS exists`,
        [sessionId],
      );
      hasActiveManual = r.rows[0]?.exists === true;
    } catch (err) {
      // DB blip — keep polling next tick rather than dropping the interval
      logger.warn({ err, sessionId }, 'Manual-dashboard poll: DB check failed, will retry');
      return;
    }

    if (!hasActiveManual) {
      const h = manualDashboardIntervals.get(sessionId);
      if (h) clearInterval(h);
      manualDashboardIntervals.delete(sessionId);
      return;
    }

    if (_emitHostDashboard) {
      await _emitHostDashboard(sessionId).catch(() => {});
    }
  }, MANUAL_DASHBOARD_INTERVAL_MS);

  manualDashboardIntervals.set(sessionId, interval);
}

export async function handleHostCreateBreakout(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; participantIds: string[]; durationSeconds?: number }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    try {
      if (!await verifyHost(socket, data.sessionId)) return;

      const activeSession = activeSessions.get(data.sessionId);
      if (!activeSession) {
        socket.emit('error', { code: 'INVALID_STATE', message: 'Event is not active' });
        return;
      }

      const { sessionId, participantIds = [] } = data;
      if (participantIds.length > 3) {
        socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Maximum 3 participants per breakout room' });
        return;
      }

      // T0-1: structural validation BEFORE Step 1's reassign so we never
      // orphan existing matches if the new payload is itself invalid
      // (duplicate participants, missing IDs). Conflict check is skipped
      // here — Step 1 below explicitly reassigns existing active matches
      // for these participants, which is a legitimate intent.
      if (participantIds.length >= 1) {
        const sortedForValidation = [...participantIds].sort();
        const structureCheck = await validateMatchAssignment({
          sessionId,
          roundNumber: activeSession.currentRound,
          participantAId: sortedForValidation[0],
          participantBId: sortedForValidation[1] || null,
          participantCId: sortedForValidation[2] || null,
          skipConflictCheck: true,
        });
        if (!structureCheck.valid) {
          socket.emit('error', {
            code: 'INVALID_MATCH_ASSIGNMENT',
            message: structureCheck.errors.join('; '),
          });
          return;
        }
      }

      // Step 1: Remove each participant from ANY active match (across all rounds)
      // Each removal is independent — failure in one doesn't affect others
      for (const pid of participantIds) {
        try {
          const currentMatch = await query<{ id: string; participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null }>(
            `SELECT id, participant_a_id, participant_b_id, participant_c_id FROM matches
             WHERE session_id = $1 AND status = 'active'
               AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)`,
            [sessionId, pid]
          );

          if (currentMatch.rows.length > 0) {
            const match = currentMatch.rows[0];
            // Host moved participants to another room — the original match was
            // reassigned, not abandoned. Reassigned matches are still ratable
            // and count in People Met / recap stats.
            await query(`UPDATE matches SET status = 'reassigned', ended_at = NOW() WHERE id = $1 AND status = 'active'`, [match.id]);

            // Notify remaining partners (exclude participants being moved together)
            const remainingPartners = [match.participant_a_id, match.participant_b_id, match.participant_c_id]
              .filter((id): id is string => !!id && id !== pid && !participantIds.includes(id));

            for (const partnerId of remainingPartners) {
              io.to(userRoom(partnerId)).emit('match:partner_disconnected', { matchId: match.id });
            }

            // Solo partner left behind: return to lobby after 5s
            if (remainingPartners.length === 1) {
              const soloPartnerId = remainingPartners[0];
              setTimeout(async () => {
                try {
                  const s = activeSessions.get(sessionId);
                  if (!s || s.status !== SessionStatus.ROUND_ACTIVE) return;
                  const freshMatch = (await matchingService.getMatchesByRound(sessionId, s.currentRound))
                    .find(m => m.id === match.id);
                  if (!freshMatch || freshMatch.status !== 'no_show') return;

                  await sessionService.updateParticipantStatus(sessionId, soloPartnerId, ParticipantStatus.IN_LOBBY);
                  io.to(userRoom(soloPartnerId)).emit('match:return_to_lobby', { reason: 'partner_left' });

                  const session = await sessionService.getSessionById(sessionId);
                  if (session.lobbyRoomId) {
                    const { config: appConfig } = await import('../../../config');
                    const socketsInRoom = await io.in(userRoom(soloPartnerId)).fetchSockets();
                    for (const sk of socketsInRoom) {
                      const uid = (sk.data as any)?.userId;
                      if (uid !== soloPartnerId) continue;
                      const dName = (sk.data as any)?.displayName || 'User';
                      const lobbyToken = await videoService.issueJoinToken(uid, session.lobbyRoomId, dName);
                      sk.emit('lobby:token', { token: lobbyToken.token, livekitUrl: appConfig.livekit.host, roomId: session.lobbyRoomId });
                    }
                  }
                } catch (err) {
                  logger.error({ err }, 'Error returning solo partner to lobby after create_breakout');
                }
              }, 5000);
            }
          }
        } catch (err) {
          logger.warn({ err, pid }, 'Non-fatal: failed to remove participant from current match during create_breakout');
        }
      }

      // Step 2: Create LiveKit room
      const roomSlug = `host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        await videoService.createMatchRoom(sessionId, activeSession.currentRound, roomSlug);
      } catch (err) {
        logger.error({ err }, 'Failed to create LiveKit room for host breakout');
        socket.emit('error', { code: 'ROOM_CREATION_FAILED', message: 'Failed to create breakout room. Try again.' });
        // Bug 1 (April 18 Dr Arch): Step-1 reassignment may have already run.
        // Refresh dashboard so the host sees the actual DB state, not stale.
        if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
        return;
      }
      const newRoomId = videoService.matchRoomId(sessionId, activeSession.currentRound, roomSlug);

      // Step 3: Create match in DB (for 1+ participants — enables dashboard, leave, timer)
      // is_manual=TRUE marks this as a host-created breakout — invisible to the
      // algorithm exclusion logic (matching.service.ts).
      let matchId = '';
      if (participantIds.length >= 1) {
        const { v4: uuid } = await import('uuid');
        matchId = uuid();
        const sorted = [...participantIds].sort();
        try {
          await query(
            `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at, is_manual)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), TRUE)`,
            [matchId, sessionId, activeSession.currentRound, sorted[0], sorted[1] || null, sorted[2] || null, newRoomId]
          );
        } catch (err: any) {
          logger.error({ err }, 'Failed to insert match for host breakout');
          // Surface participant-already-matched constraint violation to host so
          // the UI can tell them what went wrong instead of silently failing.
          if (err?.code === '23505' || /unique|duplicate|already/i.test(err?.message || '')) {
            socket.emit('error', {
              code: 'PARTICIPANT_ALREADY_MATCHED',
              message: 'One or more participants are already in another active match. Wait for it to end.',
            });
          } else {
            socket.emit('error', { code: 'MATCH_CREATION_FAILED', message: 'Failed to create room assignment. Try again.' });
          }
          // Bug 1 (April 18 Dr Arch): the Step-1 reassign already moved the
          // participants' prior matches to status='reassigned'. The new manual
          // INSERT failed, but we still need to refresh the dashboard so the
          // host sees the actual DB state — not the cached pre-action snapshot.
          if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
          return;
        }
      }

      // Step 4: Update participant statuses + notify
      if (participantIds.length > 0) {
        for (const pid of participantIds) {
          await sessionService.updateParticipantStatus(sessionId, pid, ParticipantStatus.IN_ROUND).catch(() => {});
        }

        const namesResult = await query<{ id: string; display_name: string }>(
          `SELECT id, display_name FROM users WHERE id = ANY($1)`, [participantIds]
        );
        const nameMap = new Map(namesResult.rows.map(r => [r.id, r.display_name || 'User']));

        const { config: appConfig } = await import('../../../config');
        for (const pid of participantIds) {
          const partners = participantIds
            .filter(id => id !== pid)
            .map(id => ({ userId: id, displayName: nameMap.get(id) || 'User' }));

          let token: string | null = null;
          try {
            const vt = await videoService.issueJoinToken(pid, newRoomId, nameMap.get(pid) || 'User');
            token = vt.token;
          } catch { /* client retries via API */ }

        io.to(userRoom(pid)).emit('match:reassigned', {
          matchId,
          newPartnerId: partners[0]?.userId,
          partnerDisplayName: partners[0]?.displayName,
          partners,
          roomId: newRoomId,
          roundNumber: activeSession.currentRound,
          token,
          livekitUrl: appConfig.livekit.host,
        });
        }
      } // end if participantIds.length > 0

      // Step 5: Per-room timer — end room after custom duration
      const duration = data.durationSeconds;
      if (duration && duration > 0 && matchId && participantIds.length >= 1) {
        // Clear any existing timer for this match
        if (roomTimers.has(matchId)) clearTimeout(roomTimers.get(matchId)!.timeoutHandle);

        // Start per-room countdown sync interval (every 5s) — reads from
        // roomTimers.get(matchId).endsAt so extensions propagate automatically.
        const startedAt = new Date();
        roomSyncIntervals.set(matchId, setInterval(() => {
          const state = roomTimers.get(matchId);
          if (!state) {
            const iv = roomSyncIntervals.get(matchId);
            if (iv) { clearInterval(iv); roomSyncIntervals.delete(matchId); }
            return;
          }
          const remaining = Math.max(0, Math.ceil((state.endsAt.getTime() - Date.now()) / 1000));
          for (const pid of state.participantIds) {
            io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining: remaining });
          }
          if (remaining <= 0) {
            const iv = roomSyncIntervals.get(matchId);
            if (iv) { clearInterval(iv); roomSyncIntervals.delete(matchId); }
          }
        }, 5000));

        // Expiry callback — extracted so handleHostExtendBreakoutRoom can
        // reschedule the same callback without duplicating the teardown logic.
        const fireCallback = async () => {
          roomTimers.delete(matchId);
          const iv = roomSyncIntervals.get(matchId);
          if (iv) { clearInterval(iv); roomSyncIntervals.delete(matchId); }
          try {
            const matchRow = await query<{ status: string }>(
              `SELECT status FROM matches WHERE id = $1`, [matchId]
            );
            if (!matchRow.rows[0] || matchRow.rows[0].status !== 'active') return;

            await query(
              `UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1 AND status = 'active'`,
              [matchId]
            );

            const namesResult2 = await query<{ id: string; display_name: string }>(
              `SELECT id, display_name FROM users WHERE id = ANY($1)`, [participantIds]
            );
            const nm = new Map(namesResult2.rows.map(r => [r.id, r.display_name || 'Partner']));

            for (const pid of participantIds) {
              const partners = participantIds
                .filter(id => id !== pid)
                .map(id => ({ userId: id, displayName: nm.get(id) || 'Partner' }));

              await sessionService.updateParticipantStatus(sessionId, pid, ParticipantStatus.IN_LOBBY).catch(() => {});

              await emitRatingWindowOnce(io, pid, matchId, {
                matchId,
                partnerId: partners[0]?.userId,
                partnerDisplayName: partners[0]?.displayName,
                partners,
                durationSeconds: 20,
                earlyLeave: true,
              });

              const session2 = await sessionService.getSessionById(sessionId);
              if (session2.lobbyRoomId) {
                try {
                  const { config: appConfig2 } = await import('../../../config');
                  const socketsInRoom = await io.in(userRoom(pid)).fetchSockets();
                  for (const sk of socketsInRoom) {
                    const uid = (sk.data as any)?.userId;
                    if (uid !== pid) continue;
                    const dName = (sk.data as any)?.displayName || 'User';
                    const lobbyToken = await videoService.issueJoinToken(uid, session2.lobbyRoomId, dName);
                    sk.emit('lobby:token', { token: lobbyToken.token, livekitUrl: appConfig2.livekit.host, roomId: session2.lobbyRoomId });
                  }
                } catch { /* skip */ }
              }
            }

            if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
            logger.info({ sessionId, matchId }, 'Host breakout room timer expired — participants sent to rating');
          } catch (err) {
            logger.error({ err, matchId }, 'Error in host breakout room timer');
          }
        };

        const endsAt = new Date(startedAt.getTime() + duration * 1000);
        const timeoutHandle = setTimeout(() => { fireCallback(); }, duration * 1000);
        roomTimers.set(matchId, {
          timeoutHandle,
          endsAt,
          startedAt,
          participantIds: [...participantIds],
          fireCallback,
        });

        // Send timer:sync to participants in this room so they see countdown
        for (const pid of participantIds) {
          io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining: duration });
        }
      }

      // Step 6: Refresh dashboard + start LOBBY_OPEN polling safety net
      if (_emitHostDashboard) {
        await _emitHostDashboard(sessionId).catch(() => {});
      }
      // Defensive: keep dashboard fresh during LOBBY_OPEN. Self-stops when no
      // active manual matches remain (covers any transition that might miss
      // an explicit emit — e.g. future code paths or race conditions).
      ensureManualDashboardInterval(io, sessionId);

      logger.info({ sessionId, matchId, participantIds, roomSlug, durationSeconds: duration }, 'Host created breakout room');
    } catch (err: any) {
      logger.error({ err }, 'Error in handleHostCreateBreakout');
      socket.emit('error', { code: 'CREATE_BREAKOUT_FAILED', message: err.message || 'Failed to create breakout room' });
    }
  });
}
