// ─── Orchestration Service ───────────────────────────────────────────────────
// Manages session state machine, server-authoritative timers, round lifecycle,
// host controls, no-show detection, and reconnection handling.
//
// State machine:
//   SCHEDULED → LOBBY_OPEN → ROUND_ACTIVE(n) → ROUND_RATING(n)
//   → ROUND_TRANSITION(n) → ROUND_ACTIVE(n+1) ... → CLOSING_LOBBY → COMPLETED

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../config/logger';
import { query, transaction } from '../../db';
import {
  SessionStatus, ParticipantStatus, SessionConfig,
  ServerToClientEvents, ClientToServerEvents,
  MatchStatus,
} from '@rsn/shared';
import * as sessionService from '../session/session.service';
import * as matchingService from '../matching/matching.service';
import * as ratingService from '../rating/rating.service';
import * as videoService from '../video/video.service';
import * as emailService from '../email/email.service';
import { ForbiddenError, ValidationError } from '../../middleware/errors';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ActiveSession {
  sessionId: string;
  hostUserId: string;
  config: SessionConfig;
  currentRound: number;
  status: SessionStatus;
  timer: NodeJS.Timeout | null;
  timerEndsAt: Date | null;
  isPaused: boolean;
  pausedTimeRemaining: number | null;
  presenceMap: Map<string, { lastHeartbeat: Date; socketId: string }>;
}

// ─── State Store ────────────────────────────────────────────────────────────

const activeSessions = new Map<string, ActiveSession>();

// ─── Socket Namespaces ──────────────────────────────────────────────────────

let io: SocketServer<ClientToServerEvents, ServerToClientEvents>;

// ─── Initialise ─────────────────────────────────────────────────────────────

export function initOrchestration(
  socketServer: SocketServer<ClientToServerEvents, ServerToClientEvents>
): void {
  io = socketServer;

  io.on('connection', (socket: Socket) => {
    logger.debug({ socketId: socket.id }, 'Socket connected');

    socket.on('session:join', (data) => handleJoinSession(socket, data));
    socket.on('session:leave', (data) => handleLeaveSession(socket, data));
    socket.on('presence:heartbeat', (data) => handleHeartbeat(socket, data));
    socket.on('presence:ready', (data) => handleReady(socket, data));
    socket.on('rating:submit', (data) => handleRatingSubmit(socket, data));

    // Host controls
    socket.on('host:start_session', (data) => handleHostStart(socket, data));
    socket.on('host:start_round', (data) => handleHostStartRound(socket, data));
    socket.on('host:pause_session', (data) => handleHostPause(socket, data));
    socket.on('host:resume_session', (data) => handleHostResume(socket, data));
    socket.on('host:end_session', (data) => handleHostEnd(socket, data));
    socket.on('host:broadcast_message', (data) => handleHostBroadcast(socket, data));
    socket.on('host:remove_participant', (data) => handleHostRemoveParticipant(socket, data));
    socket.on('host:reassign', (data) => handleHostReassign(socket, data));

    socket.on('disconnect', () => handleDisconnect(socket));
  });

  logger.info('Orchestration engine initialised');

  // Periodic TTL cleanup: purge stale sessions older than 4 hours
  const MAX_SESSION_AGE_MS = 4 * 60 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions) {
      // Use timerEndsAt as a proxy for last activity; fallback to a generous window
      const lastActivity = session.timerEndsAt?.getTime() || now;
      if (now - lastActivity > MAX_SESSION_AGE_MS) {
        logger.warn({ sessionId }, 'TTL cleanup: purging stale active session');
        if (session.timer) clearTimeout(session.timer);
        activeSessions.delete(sessionId);
      }
    }
  }, 5 * 60 * 1000); // Check every 5 minutes
}

// ─── Socket Room Helpers ────────────────────────────────────────────────────

function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`;
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

function getUserIdFromSocket(socket: Socket): string | null {
  return (socket.data as any)?.userId || null;
}

// ─── Join Session ───────────────────────────────────────────────────────────

async function handleJoinSession(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }

    const session = await sessionService.getSessionById(data.sessionId);

    // Join socket room
    socket.join(sessionRoom(data.sessionId));
    socket.join(userRoom(userId));

    // Update presence
    const activeSession = activeSessions.get(data.sessionId);
    if (activeSession) {
      activeSession.presenceMap.set(userId, {
        lastHeartbeat: new Date(),
        socketId: socket.id,
      });
    }

    // Auto-register if not already a participant.
    // The host is also a participant in speed networking — they network too.
    try {
      await sessionService.registerParticipant(data.sessionId, userId);
    } catch {
      // Already registered or session not open — that's fine
    }

    // Update participant status based on current session state
    try {
      if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE) {
        // Will be updated to IN_ROUND below if they have an active match
        await sessionService.updateParticipantStatus(
          data.sessionId, userId, ParticipantStatus.IN_LOBBY
        );
      } else {
        await sessionService.updateParticipantStatus(
          data.sessionId, userId,
          session.status === SessionStatus.LOBBY_OPEN ? ParticipantStatus.IN_LOBBY : ParticipantStatus.CHECKED_IN
        );
      }
    } catch {
      // Participant may not exist (e.g. host who's not a participant) — that's OK
    }

    // Notify others
    io.to(sessionRoom(data.sessionId)).emit('participant:joined', {
      userId,
      displayName: (socket.data as any)?.displayName || 'Unknown',
    });

    // Send current participant count
    const count = await sessionService.getParticipantCount(data.sessionId);
    io.to(sessionRoom(data.sessionId)).emit('participant:count', { count });

    // If session is mid-round, restore user's match assignment
    if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE) {
      const matches = await matchingService.getMatchesByRound(
        data.sessionId, activeSession.currentRound
      );
      const userMatch = matches.find(
        m => (m.participantAId === userId || m.participantBId === userId) && m.status === 'active'
      );

      if (userMatch) {
        const partnerId = userMatch.participantAId === userId
          ? userMatch.participantBId : userMatch.participantAId;

        // Restore participant status to IN_ROUND
        await sessionService.updateParticipantStatus(
          data.sessionId, userId, ParticipantStatus.IN_ROUND
        ).catch(() => {});

        socket.emit('match:assigned', {
          matchId: userMatch.id,
          partnerId,
          roomId: userMatch.roomId || '',
          roundNumber: activeSession.currentRound,
        });
      }
    }

    // If session is in rating phase, re-send the rating window so reconnected users can still rate
    if (activeSession && activeSession.status === SessionStatus.ROUND_RATING) {
      const matches = await matchingService.getMatchesByRound(
        data.sessionId, activeSession.currentRound
      );
      const userMatch = matches.find(
        m => (m.participantAId === userId || m.participantBId === userId) && m.status === 'completed'
      );
      if (userMatch) {
        const partnerId = userMatch.participantAId === userId
          ? userMatch.participantBId : userMatch.participantAId;
        const remainingSeconds = activeSession.timerEndsAt
          ? Math.max(0, Math.ceil((activeSession.timerEndsAt.getTime() - Date.now()) / 1000))
          : activeSession.config.ratingWindowSeconds;
        socket.emit('rating:window_open', {
          matchId: userMatch.id,
          partnerId,
          roundNumber: activeSession.currentRound,
          durationSeconds: remainingSeconds,
        });
      }
    }

    logger.info({ sessionId: data.sessionId, userId }, 'User joined session');
  } catch (err: any) {
    logger.error({ err }, 'Error joining session');
    socket.emit('error', { code: 'JOIN_FAILED', message: err.message });
  }
}

// ─── Leave Session ──────────────────────────────────────────────────────────

async function handleLeaveSession(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  const userId = getUserIdFromSocket(socket);
  if (!userId) return;

  socket.leave(sessionRoom(data.sessionId));

  const activeSession = activeSessions.get(data.sessionId);
  if (activeSession) {
    activeSession.presenceMap.delete(userId);
  }

  await sessionService.updateParticipantStatus(
    data.sessionId, userId, ParticipantStatus.LEFT
  );

  io.to(sessionRoom(data.sessionId)).emit('participant:left', { userId });

  const count = await sessionService.getParticipantCount(data.sessionId);
  io.to(sessionRoom(data.sessionId)).emit('participant:count', { count });

  logger.info({ sessionId: data.sessionId, userId }, 'User left session');
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────

function handleHeartbeat(
  socket: Socket,
  data: { sessionId: string }
): void {
  const userId = getUserIdFromSocket(socket);
  if (!userId) return;

  const activeSession = activeSessions.get(data.sessionId);
  if (activeSession) {
    activeSession.presenceMap.set(userId, {
      lastHeartbeat: new Date(),
      socketId: socket.id,
    });
  }
}

// ─── Ready ──────────────────────────────────────────────────────────────────

async function handleReady(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  const userId = getUserIdFromSocket(socket);
  if (!userId) return;

  await sessionService.updateParticipantStatus(
    data.sessionId, userId, ParticipantStatus.IN_LOBBY
  );
}

// ─── Rating Submit (via Socket) ─────────────────────────────────────────────

async function handleRatingSubmit(
  socket: Socket,
  data: { matchId: string; qualityScore: number; meetAgain: boolean; feedback?: string }
): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }

    await ratingService.submitRating(userId, {
      matchId: data.matchId,
      qualityScore: data.qualityScore,
      meetAgain: data.meetAgain,
      feedback: data.feedback,
    });
  } catch (err: any) {
    socket.emit('error', { code: 'RATING_FAILED', message: err.message });
  }
}

// ─── Disconnect ─────────────────────────────────────────────────────────────

async function handleDisconnect(socket: Socket): Promise<void> {
  const userId = getUserIdFromSocket(socket);
  if (!userId) return;

  // Mark disconnected in all active sessions they were part of
  for (const [sessionId, activeSession] of activeSessions) {
    if (activeSession.presenceMap.has(userId)) {
      activeSession.presenceMap.delete(userId);

      await sessionService.updateParticipantStatus(
        sessionId, userId, ParticipantStatus.DISCONNECTED
      ).catch(() => {}); // Swallow errors on disconnect cleanup

      logger.info({ sessionId, userId }, 'Participant disconnected');
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// HOST CONTROLS
// ═════════════════════════════════════════════════════════════════════════════

// ─── Verify Host ────────────────────────────────────────────────────────────

async function verifyHost(socket: Socket, sessionId: string): Promise<boolean> {
  const userId = getUserIdFromSocket(socket);
  if (!userId) {
    socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
    return false;
  }

  const session = await sessionService.getSessionById(sessionId);
  if (session.hostUserId !== userId) {
    socket.emit('error', { code: 'FORBIDDEN', message: 'Only the host can perform this action' });
    return false;
  }

  return true;
}

// ─── Host Start Session ─────────────────────────────────────────────────────

async function handleHostStart(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
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
      timerEndsAt: null,
      isPaused: false,
      pausedTimeRemaining: null,
      presenceMap: new Map(),
    };

    activeSessions.set(data.sessionId, activeSession);

    // Broadcast status change
    io.to(sessionRoom(data.sessionId)).emit('session:status_changed', {
      sessionId: data.sessionId,
      status: SessionStatus.LOBBY_OPEN,
      currentRound: 0,
    });

    // Start lobby timer
    startSegmentTimer(data.sessionId, config.lobbyDurationSeconds, () => {
      transitionToRound(data.sessionId, 1);
    });

    logger.info({ sessionId: data.sessionId }, 'Session started → LOBBY_OPEN');
  } catch (err: any) {
    logger.error({ err }, 'Error starting session');
    socket.emit('error', { code: 'START_FAILED', message: err.message });
  }
}

// ─── Host Start Round (manual trigger) ──────────────────────────────────────

async function handleHostStartRound(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session is not active' });
      return;
    }

    // Allow starting round from lobby or transition states
    if (
      activeSession.status !== SessionStatus.LOBBY_OPEN &&
      activeSession.status !== SessionStatus.ROUND_TRANSITION
    ) {
      socket.emit('error', {
        code: 'INVALID_STATE',
        message: 'Can only start a round from the lobby or transition phase',
      });
      return;
    }

    // Need at least 2 participants with eligible status
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM session_participants
       WHERE session_id = $1 AND status IN ('in_lobby', 'checked_in', 'registered')`,
      [data.sessionId]
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

    logger.info({ sessionId: data.sessionId, roundNumber: nextRound }, 'Host manually starting round');
    await transitionToRound(data.sessionId, nextRound);
  } catch (err: any) {
    logger.error({ err }, 'Error starting round');
    socket.emit('error', { code: 'START_ROUND_FAILED', message: err.message });
  }
}

// ─── Host Pause ─────────────────────────────────────────────────────────────

async function handleHostPause(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
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

    io.to(sessionRoom(data.sessionId)).emit('session:status_changed', {
      sessionId: data.sessionId,
      status: activeSession.status,
      currentRound: activeSession.currentRound,
    });

    logger.info({ sessionId: data.sessionId }, 'Session paused');
  } catch (err: any) {
    socket.emit('error', { code: 'PAUSE_FAILED', message: err.message });
  }
}

// ─── Host Resume ────────────────────────────────────────────────────────────

async function handleHostResume(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
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
      const callback = getTimerCallbackForState(data.sessionId, activeSession);
      startSegmentTimer(data.sessionId, remainingMs / 1000, callback);
    }

    io.to(sessionRoom(data.sessionId)).emit('session:status_changed', {
      sessionId: data.sessionId,
      status: activeSession.status,
      currentRound: activeSession.currentRound,
    });

    logger.info({ sessionId: data.sessionId }, 'Session resumed');
  } catch (err: any) {
    socket.emit('error', { code: 'RESUME_FAILED', message: err.message });
  }
}

// ─── Host End Session ───────────────────────────────────────────────────────

async function handleHostEnd(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);

    // If currently in an active round, end the round first so users get
    // a rating window before the session completes.
    if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE) {
      // Clear any existing timer
      if (activeSession.timer) clearTimeout(activeSession.timer);

      // End the current round (triggers rating window)
      await endRound(data.sessionId, activeSession.currentRound);

      // Override: after a short rating window (15s), auto-complete
      if (activeSession.timer) clearTimeout(activeSession.timer);
      startSegmentTimer(data.sessionId, 15, () => {
        completeSession(data.sessionId);
        logger.info({ sessionId: data.sessionId }, 'Session ended by host (after rating window)');
      });
      return;
    }

    await completeSession(data.sessionId);
    logger.info({ sessionId: data.sessionId }, 'Session ended by host');
  } catch (err: any) {
    socket.emit('error', { code: 'END_FAILED', message: err.message });
  }
}

// ─── Host Broadcast ─────────────────────────────────────────────────────────

async function handleHostBroadcast(
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

async function handleHostRemoveParticipant(
  socket: Socket,
  data: { sessionId: string; userId: string; reason: string }
): Promise<void> {
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
}

// ─── Host Reassign ──────────────────────────────────────────────────────────

async function handleHostReassign(
  socket: Socket,
  data: { sessionId: string; participantId: string }
): Promise<void> {
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

      // Notify both participants
      io.to(userRoom(targetId)).emit('match:reassigned', {
        matchId,
        newPartnerId: partner,
        roomId,
      });

      io.to(userRoom(partner)).emit('match:reassigned', {
        matchId,
        newPartnerId: targetId,
        roomId,
      });

      logger.info({ sessionId: data.sessionId, targetId, partner }, 'Participant reassigned');
    } else {
      socket.emit('error', { code: 'NO_PARTNER', message: 'No available partner for reassignment' });
    }
  } catch (err: any) {
    socket.emit('error', { code: 'REASSIGN_FAILED', message: err.message });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// STATE MACHINE TRANSITIONS
// ═════════════════════════════════════════════════════════════════════════════

// ─── Transition to Round ────────────────────────────────────────────────────

async function transitionToRound(
  sessionId: string,
  roundNumber: number
): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  try {
    // Update session state
    activeSession.currentRound = roundNumber;
    activeSession.status = SessionStatus.ROUND_ACTIVE;

    await sessionService.updateSessionStatus(sessionId, SessionStatus.ROUND_ACTIVE);
    await query('UPDATE sessions SET current_round = $1 WHERE id = $2', [roundNumber, sessionId]);

    // Generate matches for this round (or load if pre-generated)
    let matches = await matchingService.getMatchesByRound(sessionId, roundNumber);
    if (matches.length === 0) {
      // Generate on-the-fly for this round
      await matchingService.generateSingleRound(sessionId, roundNumber);
      matches = await matchingService.getMatchesByRound(sessionId, roundNumber);
    }

    // Collect all matched user IDs to determine bye participants
    const matchedUserIds = new Set<string>();

    // Activate matches, create LiveKit rooms, and notify participants
    for (const match of matches) {
      const roomId = match.roomId || `session-${sessionId}-round-${roundNumber}-${match.id.slice(0, 8)}`;

      // Create a LiveKit room for this match before assigning participants
      try {
        await videoService.createMatchRoom(sessionId, roundNumber, match.id.slice(0, 8));
      } catch (err) {
        logger.warn({ err, roomId }, 'LiveKit room creation failed (may already exist)');
      }

      await query(
        `UPDATE matches SET status = 'active', room_id = $1, started_at = NOW() WHERE id = $2`,
        [roomId, match.id]
      );

      matchedUserIds.add(match.participantAId);
      matchedUserIds.add(match.participantBId);

      // Notify participant A
      io.to(userRoom(match.participantAId)).emit('match:assigned', {
        matchId: match.id,
        partnerId: match.participantBId,
        roomId,
        roundNumber,
      });

      // Notify participant B
      io.to(userRoom(match.participantBId)).emit('match:assigned', {
        matchId: match.id,
        partnerId: match.participantAId,
        roomId,
        roundNumber,
      });

      // Update participant statuses
      await sessionService.updateParticipantStatus(sessionId, match.participantAId, ParticipantStatus.IN_ROUND);
      await sessionService.updateParticipantStatus(sessionId, match.participantBId, ParticipantStatus.IN_ROUND);
    }

    // Notify bye participants (unmatched due to odd count)
    const allParticipants = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants WHERE session_id = $1 AND status IN ('in_lobby', 'checked_in', 'registered')`,
      [sessionId]
    );
    for (const p of allParticipants.rows) {
      if (!matchedUserIds.has(p.user_id)) {
        io.to(userRoom(p.user_id)).emit('match:bye_round', {
          roundNumber,
          reason: 'Odd number of participants — you have a bye this round.',
        });
        logger.info({ sessionId, roundNumber, userId: p.user_id }, 'Bye round assigned');
      }
    }

    // Broadcast round start
    const endsAt = new Date(Date.now() + activeSession.config.roundDurationSeconds * 1000);
    io.to(sessionRoom(sessionId)).emit('session:round_started', {
      sessionId,
      roundNumber,
      totalRounds: activeSession.config.numberOfRounds,
      endsAt: endsAt.toISOString(),
    });

    io.to(sessionRoom(sessionId)).emit('session:status_changed', {
      sessionId,
      status: SessionStatus.ROUND_ACTIVE,
      currentRound: roundNumber,
    });

    // Start round timer
    startSegmentTimer(sessionId, activeSession.config.roundDurationSeconds, () => {
      endRound(sessionId, roundNumber);
    });

    // Schedule no-show detection after the configured timeout
    setTimeout(() => {
      detectNoShows(sessionId, roundNumber);
    }, activeSession.config.noShowTimeoutSeconds * 1000);

    logger.info({ sessionId, roundNumber }, 'Round started');
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Error transitioning to round');
  }
}

// ─── End Round ──────────────────────────────────────────────────────────────

async function endRound(
  sessionId: string,
  roundNumber: number
): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  try {
    // Complete all active matches for this round
    await query(
      `UPDATE matches SET status = 'completed', ended_at = NOW()
       WHERE session_id = $1 AND round_number = $2 AND status = 'active'`,
      [sessionId, roundNumber]
    );

    // Broadcast round end
    io.to(sessionRoom(sessionId)).emit('session:round_ended', {
      sessionId,
      roundNumber,
    });

    // Move to rating phase
    activeSession.status = SessionStatus.ROUND_RATING;
    await sessionService.updateSessionStatus(sessionId, SessionStatus.ROUND_RATING);

    io.to(sessionRoom(sessionId)).emit('session:status_changed', {
      sessionId,
      status: SessionStatus.ROUND_RATING,
      currentRound: roundNumber,
    });

    // Get matches for rating window notifications
    const matches = await matchingService.getMatchesByRound(sessionId, roundNumber);
    for (const match of matches) {
      if (match.status === 'completed') {
        // Notify participant A to rate
        io.to(userRoom(match.participantAId)).emit('rating:window_open', {
          matchId: match.id,
          partnerId: match.participantBId,
          roundNumber,
          durationSeconds: activeSession.config.ratingWindowSeconds,
        });

        // Notify participant B to rate
        io.to(userRoom(match.participantBId)).emit('rating:window_open', {
          matchId: match.id,
          partnerId: match.participantAId,
          roundNumber,
          durationSeconds: activeSession.config.ratingWindowSeconds,
        });
      }

      // Increment rounds completed for participants
      await sessionService.incrementRoundsCompleted(sessionId, match.participantAId);
      await sessionService.incrementRoundsCompleted(sessionId, match.participantBId);
    }

    // Update participant statuses back to lobby
    await query(
      `UPDATE session_participants SET status = 'in_lobby'
       WHERE session_id = $1 AND status = 'in_round'`,
      [sessionId]
    );

    // Start rating window timer
    startSegmentTimer(sessionId, activeSession.config.ratingWindowSeconds, () => {
      endRatingWindow(sessionId, roundNumber);
    });

    logger.info({ sessionId, roundNumber }, 'Round ended → ROUND_RATING');
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Error ending round');
  }
}

// ─── End Rating Window ──────────────────────────────────────────────────────

async function endRatingWindow(
  sessionId: string,
  roundNumber: number
): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  try {
    // Finalize ratings for the round
    await ratingService.finalizeRoundRatings(sessionId, roundNumber);

    io.to(sessionRoom(sessionId)).emit('rating:window_closed', { roundNumber });

    // Check if there are more rounds
    if (roundNumber < activeSession.config.numberOfRounds) {
      // Transition phase
      activeSession.status = SessionStatus.ROUND_TRANSITION;
      await sessionService.updateSessionStatus(sessionId, SessionStatus.ROUND_TRANSITION);

      io.to(sessionRoom(sessionId)).emit('session:status_changed', {
        sessionId,
        status: SessionStatus.ROUND_TRANSITION,
        currentRound: roundNumber,
      });

      // Start transition timer
      startSegmentTimer(sessionId, activeSession.config.transitionDurationSeconds, () => {
        transitionToRound(sessionId, roundNumber + 1);
      });

      logger.info({ sessionId, roundNumber }, 'Rating window closed → ROUND_TRANSITION');
    } else {
      // Last round done → closing lobby
      await transitionToClosingLobby(sessionId);
    }
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Error ending rating window');
  }
}

// ─── Closing Lobby ──────────────────────────────────────────────────────────

async function transitionToClosingLobby(sessionId: string): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  try {
    activeSession.status = SessionStatus.CLOSING_LOBBY;
    await sessionService.updateSessionStatus(sessionId, SessionStatus.CLOSING_LOBBY);

    io.to(sessionRoom(sessionId)).emit('session:status_changed', {
      sessionId,
      status: SessionStatus.CLOSING_LOBBY,
      currentRound: activeSession.currentRound,
    });

    // Start closing lobby timer
    startSegmentTimer(sessionId, activeSession.config.closingLobbyDurationSeconds, () => {
      completeSession(sessionId);
    });

    logger.info({ sessionId }, 'Session entering closing lobby');
  } catch (err) {
    logger.error({ err, sessionId }, 'Error transitioning to closing lobby');
  }
}

// ─── Complete Session ───────────────────────────────────────────────────────

async function completeSession(sessionId: string): Promise<void> {
  const activeSession = activeSessions.get(sessionId);

  try {
    // Clear any remaining timers
    if (activeSession?.timer) {
      clearTimeout(activeSession.timer);
    }

    // Update session status
    await sessionService.updateSessionStatus(sessionId, SessionStatus.COMPLETED);
    await query('UPDATE sessions SET ended_at = NOW() WHERE id = $1', [sessionId]);

    // Finalize encounter history for any unrated matches
    try {
      await ratingService.finalizeSessionEncounters(sessionId);
    } catch (encErr) {
      logger.error({ err: encErr, sessionId }, 'Error finalizing session encounters (non-fatal)');
    }

    io.to(sessionRoom(sessionId)).emit('session:completed', { sessionId });
    io.to(sessionRoom(sessionId)).emit('session:status_changed', {
      sessionId,
      status: SessionStatus.COMPLETED,
      currentRound: activeSession?.currentRound || 0,
    });

    logger.info({ sessionId }, 'Session completed');

    // Fire-and-forget: send recap emails to all participants
    sendRecapEmails(sessionId).catch(emailErr => {
      logger.error({ err: emailErr, sessionId }, 'Error sending recap emails (non-fatal)');
    });
  } catch (err) {
    logger.error({ err, sessionId }, 'Error completing session');
  } finally {
    // Always clean up to prevent memory leak, even on error
    activeSessions.delete(sessionId);
  }
}

// ─── Send Recap Emails ──────────────────────────────────────────────────────

async function sendRecapEmails(sessionId: string): Promise<void> {
  const { config: appConfig } = await import('../../config');

  const sessionResult = await query<{ title: string }>(
    `SELECT title FROM sessions WHERE id = $1`, [sessionId]
  );
  if (sessionResult.rows.length === 0) return;
  const sessionTitle = sessionResult.rows[0].title;

  const stats = await ratingService.getSessionRatingStats(sessionId);

  const participantsResult = await query<{ email: string; displayName: string; userId: string }>(
    `SELECT u.email, u.display_name AS "displayName", u.id AS "userId"
     FROM session_participants sp
     JOIN users u ON u.id = sp.user_id
     WHERE sp.session_id = $1 AND sp.status != 'removed'`,
    [sessionId]
  );

  for (const p of participantsResult.rows) {
    try {
      await emailService.sendSessionRecapEmail(p.email, p.displayName || 'there', {
        sessionTitle,
        peopleMet: stats.totalRatings, // approximate
        mutualConnections: stats.mutualMeetAgainCount,
        avgRating: stats.avgQualityScore,
        recapUrl: `${appConfig.clientUrl}/sessions/${sessionId}/recap`,
      });
    } catch (err) {
      logger.warn({ err, userId: p.userId }, 'Failed to send recap email to participant');
    }
  }

  logger.info({ sessionId, participantCount: participantsResult.rows.length }, 'Recap emails dispatched');
}

// ═════════════════════════════════════════════════════════════════════════════
// TIMER MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

function startSegmentTimer(
  sessionId: string,
  durationSeconds: number,
  callback: () => void
): void {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  // Clear previous timer
  if (activeSession.timer) {
    clearTimeout(activeSession.timer);
  }

  const durationMs = durationSeconds * 1000;
  activeSession.timerEndsAt = new Date(Date.now() + durationMs);

  activeSession.timer = setTimeout(() => {
    activeSession.timer = null;
    activeSession.timerEndsAt = null;
    callback();
  }, durationMs);

  // Set up periodic timer sync broadcasts (every 5 seconds)
  const syncInterval = setInterval(() => {
    const session = activeSessions.get(sessionId);
    if (!session || !session.timerEndsAt || session.isPaused) {
      clearInterval(syncInterval);
      return;
    }

    const remainingMs = session.timerEndsAt.getTime() - Date.now();
    if (remainingMs <= 0) {
      clearInterval(syncInterval);
      return;
    }

    io.to(sessionRoom(sessionId)).emit('timer:sync', {
      segmentType: session.status,
      secondsRemaining: Math.ceil(remainingMs / 1000),
      totalSeconds: durationSeconds,
    });
  }, 5000);
}

function getTimerCallbackForState(sessionId: string, activeSession: ActiveSession): () => void {
  switch (activeSession.status) {
    case SessionStatus.LOBBY_OPEN:
      return () => transitionToRound(sessionId, 1);
    case SessionStatus.ROUND_ACTIVE:
      return () => endRound(sessionId, activeSession.currentRound);
    case SessionStatus.ROUND_RATING:
      return () => endRatingWindow(sessionId, activeSession.currentRound);
    case SessionStatus.ROUND_TRANSITION:
      return () => transitionToRound(sessionId, activeSession.currentRound + 1);
    case SessionStatus.CLOSING_LOBBY:
      return () => completeSession(sessionId);
    default:
      return () => {};
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// NO-SHOW DETECTION
// ═════════════════════════════════════════════════════════════════════════════

async function detectNoShows(
  sessionId: string,
  roundNumber: number
): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession || activeSession.status !== SessionStatus.ROUND_ACTIVE) return;

  try {
    const matches = await matchingService.getMatchesByRound(sessionId, roundNumber);

    for (const match of matches) {
      if (match.status !== 'active') continue;

      const aPresent = activeSession.presenceMap.has(match.participantAId);
      const bPresent = activeSession.presenceMap.has(match.participantBId);

      if (!aPresent && !bPresent) {
        // Both absent — mark both no-show, cancel match
        await query(
          `UPDATE matches SET status = 'no_show' WHERE id = $1`,
          [match.id]
        );
        await sessionService.updateParticipantStatus(sessionId, match.participantAId, ParticipantStatus.NO_SHOW);
        await sessionService.updateParticipantStatus(sessionId, match.participantBId, ParticipantStatus.NO_SHOW);
        await query(
          'UPDATE session_participants SET is_no_show = TRUE WHERE session_id = $1 AND user_id = ANY($2)',
          [sessionId, [match.participantAId, match.participantBId]]
        );

        logger.warn({ sessionId, roundNumber, matchId: match.id }, 'Both participants no-show');
      } else if (!aPresent || !bPresent) {
        const missingUserId = !aPresent ? match.participantAId : match.participantBId;
        const waitingUserId = !aPresent ? match.participantBId : match.participantAId;

        // Mark match as no-show
        await query(
          `UPDATE matches SET status = 'no_show' WHERE id = $1`,
          [match.id]
        );
        await sessionService.updateParticipantStatus(sessionId, missingUserId, ParticipantStatus.NO_SHOW);
        await query(
          'UPDATE session_participants SET is_no_show = TRUE WHERE session_id = $1 AND user_id = $2',
          [sessionId, missingUserId]
        );

        // Notify waiting participant
        io.to(userRoom(waitingUserId)).emit('match:bye_round', {
          roundNumber,
          reason: 'Your partner did not connect. We are looking for a new partner.',
        });

        logger.warn({ sessionId, roundNumber, missingUserId, waitingUserId }, 'No-show detected');
      }
    }
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Error detecting no-shows');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// HOST REST API HELPERS (called from routes)
// ═════════════════════════════════════════════════════════════════════════════

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
    timerEndsAt: null,
    isPaused: false,
    pausedTimeRemaining: null,
    presenceMap: new Map(),
  };

  activeSessions.set(sessionId, activeSession);

  if (io) {
    io.to(sessionRoom(sessionId)).emit('session:status_changed', {
      sessionId,
      status: SessionStatus.LOBBY_OPEN,
      currentRound: 0,
    });
  }

  startSegmentTimer(sessionId, config.lobbyDurationSeconds, () => {
    transitionToRound(sessionId, 1);
  });

  logger.info({ sessionId }, 'Session started via REST → LOBBY_OPEN');
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
    const callback = getTimerCallbackForState(sessionId, activeSession);
    startSegmentTimer(sessionId, remainingMs / 1000, callback);
  }

  logger.info({ sessionId }, 'Session resumed via REST');
}

export async function endSession(sessionId: string, hostUserId: string): Promise<void> {
  const session = await sessionService.getSessionById(sessionId);
  if (session.hostUserId !== hostUserId) {
    throw new ForbiddenError('Only the host can end a session');
  }

  await completeSession(sessionId);
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

  if (io) {
    io.to(sessionRoom(sessionId)).emit('host:broadcast', {
      message,
      sentAt: new Date().toISOString(),
    });
  }
}

// ─── Get Active Session State ───────────────────────────────────────────────

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
