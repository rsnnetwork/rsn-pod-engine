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
  MatchStatus, UserRole, hasRoleAtLeast,
} from '@rsn/shared';
import {
  ActiveSession, activeSessions, withSessionGuard,
  sessionRoom, userRoom, getUserIdFromSocket, persistSessionState,
} from '../state/session-state';
import { startSegmentTimer, getTimerCallbackForState, TimerCallbacks } from './timer-manager';
import * as sessionService from '../../session/session.service';
import * as videoService from '../../video/video.service';
import { ForbiddenError, ValidationError } from '../../../middleware/errors';
import * as matchingService from '../../matching/matching.service';

// ─── Cross-module references (wired in Task 7) ────────────────────────────
// Functions from round-lifecycle.ts that don't exist yet.

let _transitionToRound: ((io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>) | null = null;
let _completeSession: ((io: SocketServer, sessionId: string) => Promise<void>) | null = null;
let _endRound: ((io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>) | null = null;
let _emitHostDashboard: ((sessionId: string) => Promise<void>) | null = null;
let _timerCallbacks: TimerCallbacks | null = null;

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
}) {
  _transitionToRound = deps.transitionToRound;
  _completeSession = deps.completeSession;
  _endRound = deps.endRound;
  _emitHostDashboard = deps.emitHostDashboard;
  _timerCallbacks = deps.timerCallbacks;
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

  const session = await sessionService.getSessionById(sessionId);

  // Allow session host, co-hosts, admin, and super_admin to perform host actions
  const userRole = (socket.data as any)?.role as UserRole | undefined;
  const isHost = session.hostUserId === userId;
  const isAdminOrAbove = userRole && hasRoleAtLeast(userRole, UserRole.ADMIN);

  if (!isHost && !isAdminOrAbove) {
    // Check co-host table
    const cohostResult = await query<{ role: string }>(
      `SELECT role FROM session_cohosts WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
    if (cohostResult.rows.length === 0) {
      socket.emit('error', { code: 'FORBIDDEN', message: 'Only the host can perform this action' });
      return false;
    }
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

    // Calculate remaining time
    if (activeSession.timer && activeSession.timerEndsAt) {
      const remaining = Math.max(0, activeSession.timerEndsAt.getTime() - Date.now());
      clearTimeout(activeSession.timer);
      activeSession.timer = null;
      activeSession.pausedTimeRemaining = remaining;
    }

    activeSession.isPaused = true;
    persistSessionState(data.sessionId, activeSession).catch(() => {});

    io.to(sessionRoom(data.sessionId)).emit('session:status_changed', {
      sessionId: data.sessionId,
      status: activeSession.status,
      currentRound: activeSession.currentRound,
      isPaused: true,
    });

    logger.info({ sessionId: data.sessionId }, 'Session paused');
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

    // Resume timer with remaining time
    if (activeSession.pausedTimeRemaining !== null && activeSession.pausedTimeRemaining > 0) {
      const remainingMs = activeSession.pausedTimeRemaining;
      activeSession.pausedTimeRemaining = null;

      // Determine what callback to use based on current status
      if (!_timerCallbacks) {
        logger.warn({ sessionId: data.sessionId }, 'Timer callbacks not injected — cannot resume timer');
      } else {
        const callback = getTimerCallbackForState(data.sessionId, activeSession, _timerCallbacks);
        startSegmentTimer(io, data.sessionId, remainingMs / 1000, callback);
      }
    }

    persistSessionState(data.sessionId, activeSession).catch(() => {});

    io.to(sessionRoom(data.sessionId)).emit('session:status_changed', {
      sessionId: data.sessionId,
      status: activeSession.status,
      currentRound: activeSession.currentRound,
      isPaused: false,
    });

    logger.info({ sessionId: data.sessionId }, 'Session resumed');
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
    // Mark the match as no_show
    await query(
      `UPDATE matches SET status = 'no_show', ended_at = NOW() WHERE id = $1 AND status = 'active'`,
      [data.matchId]
    );

    // Notify the removed user
    io.to(userRoom(data.userId)).emit('host:participant_removed', {
      userId: data.userId,
      reason: 'The host removed you from the current round.',
    });

    // Notify partner if exists
    const matchResult = await query<{ participant_a_id: string; participant_b_id: string }>(
      `SELECT participant_a_id, participant_b_id FROM matches WHERE id = $1`,
      [data.matchId]
    );
    if (matchResult.rows.length > 0) {
      const match = matchResult.rows[0];
      const partnerId = match.participant_a_id === data.userId
        ? match.participant_b_id : match.participant_a_id;
      io.to(userRoom(partnerId)).emit('match:bye_round', {
        roundNumber: activeSession.currentRound,
        reason: 'Your partner was removed by the host. You have a bye this round.',
      });
    }

    // Refresh host dashboard
    if (_emitHostDashboard) {
      await _emitHostDashboard(data.sessionId);
    }

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

    // Broadcast updated timer to all participants
    const remaining = Math.ceil(remainingMs / 1000);
    io.to(sessionRoom(data.sessionId)).emit('timer:sync', {
      segmentType: activeSession.status,
      secondsRemaining: remaining,
    });

    persistSessionState(data.sessionId, activeSession);

    logger.info(
      { sessionId: data.sessionId, additionalSeconds: data.additionalSeconds, newRemaining: remaining },
      'Round extended by host'
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
    logger.info({ sessionId, userId, removedBy: hostId }, 'Co-host removed');
  } catch (err) {
    logger.error({ err }, 'Error removing co-host');
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

  if (activeSession.timer && activeSession.timerEndsAt) {
    const remaining = Math.max(0, activeSession.timerEndsAt.getTime() - Date.now());
    clearTimeout(activeSession.timer);
    activeSession.timer = null;
    activeSession.pausedTimeRemaining = remaining;
  }

  activeSession.isPaused = true;
  logger.info({ sessionId }, 'Session paused via REST');
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

  if (activeSession.pausedTimeRemaining !== null && activeSession.pausedTimeRemaining > 0) {
    const remainingMs = activeSession.pausedTimeRemaining;
    activeSession.pausedTimeRemaining = null;
    if (_timerCallbacks) {
      const callback = getTimerCallbackForState(sessionId, activeSession, _timerCallbacks);
      startSegmentTimer(_io!, sessionId, remainingMs / 1000, callback);
    } else {
      logger.warn({ sessionId }, 'Timer callbacks not injected — cannot resume timer via REST');
    }
  }

  logger.info({ sessionId }, 'Session resumed via REST');
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

// Per-room timers for host-created breakout rooms with custom duration
const roomTimers = new Map<string, NodeJS.Timeout>();

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

      // Step 1: Remove each participant from their current match (if any)
      // Each removal is independent — failure in one doesn't affect others
      for (const pid of participantIds) {
        try {
          const currentMatch = await query<{ id: string; participant_a_id: string; participant_b_id: string; participant_c_id: string | null }>(
            `SELECT id, participant_a_id, participant_b_id, participant_c_id FROM matches
             WHERE session_id = $1 AND round_number = $2 AND status = 'active'
               AND (participant_a_id = $3 OR participant_b_id = $3 OR participant_c_id = $3)`,
            [sessionId, activeSession.currentRound, pid]
          );

          if (currentMatch.rows.length > 0) {
            const match = currentMatch.rows[0];
            await query(`UPDATE matches SET status = 'no_show', ended_at = NOW() WHERE id = $1 AND status = 'active'`, [match.id]);

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
        return;
      }
      const newRoomId = videoService.matchRoomId(sessionId, activeSession.currentRound, roomSlug);

      // Step 3: Create match in DB (skip if empty room)
      let matchId = '';
      if (participantIds.length >= 2) {
        const { v4: uuid } = await import('uuid');
        matchId = uuid();
        const sorted = [...participantIds].sort();
        try {
          await query(
            `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW())`,
            [matchId, sessionId, activeSession.currentRound, sorted[0], sorted[1], sorted[2] || null, newRoomId]
          );
        } catch (err: any) {
          logger.error({ err }, 'Failed to insert match for host breakout');
          socket.emit('error', { code: 'MATCH_CREATION_FAILED', message: 'Failed to create room assignment. Try again.' });
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
      if (duration && duration > 0 && matchId && participantIds.length >= 2) {
        // Clear any existing timer for this match
        if (roomTimers.has(matchId)) clearTimeout(roomTimers.get(matchId)!);

        roomTimers.set(matchId, setTimeout(async () => {
          roomTimers.delete(matchId);
          try {
            // Check match is still active
            const matchRow = await query<{ status: string }>(
              `SELECT status FROM matches WHERE id = $1`, [matchId]
            );
            if (!matchRow.rows[0] || matchRow.rows[0].status !== 'active') return;

            // Mark match completed
            await query(
              `UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1 AND status = 'active'`,
              [matchId]
            );

            // Send rating screen to each participant, then return to lobby
            const namesResult2 = await query<{ id: string; display_name: string }>(
              `SELECT id, display_name FROM users WHERE id = ANY($1)`, [participantIds]
            );
            const nm = new Map(namesResult2.rows.map(r => [r.id, r.display_name || 'Partner']));

            for (const pid of participantIds) {
              const partners = participantIds
                .filter(id => id !== pid)
                .map(id => ({ userId: id, displayName: nm.get(id) || 'Partner' }));

              await sessionService.updateParticipantStatus(sessionId, pid, ParticipantStatus.IN_LOBBY).catch(() => {});

              io.to(userRoom(pid)).emit('rating:window_open', {
                matchId,
                partnerId: partners[0]?.userId,
                partnerDisplayName: partners[0]?.displayName,
                partners,
                durationSeconds: 20,
                earlyLeave: true,
              });

              // Send lobby token so they can rejoin main room after rating
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

            // Refresh dashboard
            if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
            logger.info({ sessionId, matchId }, 'Host breakout room timer expired — participants sent to rating');
          } catch (err) {
            logger.error({ err, matchId }, 'Error in host breakout room timer');
          }
        }, duration * 1000));

        // Send timer:sync to participants in this room so they see countdown
        for (const pid of participantIds) {
          io.to(userRoom(pid)).emit('timer:sync', { secondsRemaining: duration });
        }
      }

      // Step 6: Refresh dashboard
      if (_emitHostDashboard) {
        await _emitHostDashboard(sessionId).catch(() => {});
      }

      logger.info({ sessionId, matchId, participantIds, roomSlug, durationSeconds: duration }, 'Host created breakout room');
    } catch (err: any) {
      logger.error({ err }, 'Error in handleHostCreateBreakout');
      socket.emit('error', { code: 'CREATE_BREAKOUT_FAILED', message: err.message || 'Failed to create breakout room' });
    }
  });
}
