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
  MatchStatus, UserRole, hasRoleAtLeast,
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
  pendingRoundNumber: number | null;  // Round number for pre-generated matches awaiting host confirmation
  manuallyLeftRound: Set<string>;     // Users who clicked "Leave Conversation" — skip in reconnect/reassignment
}

// ─── State Store ────────────────────────────────────────────────────────────

const activeSessions = new Map<string, ActiveSession>();

// ─── In-Memory Chat Store ──────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  userId: string;
  displayName: string;
  message: string;
  timestamp: string;
  scope: 'lobby' | 'room';
  isHost: boolean;
  roomId?: string; // breakout room ID for room-scope messages
}

const MAX_CHAT_MESSAGES = 50;
const chatMessages = new Map<string, ChatMessage[]>(); // sessionId -> messages

// ─── Socket Namespaces ──────────────────────────────────────────────────────

let io: SocketServer<ClientToServerEvents, ServerToClientEvents>;

// ─── Initialise ─────────────────────────────────────────────────────────────

export function initOrchestration(
  socketServer: SocketServer<ClientToServerEvents, ServerToClientEvents>
): void {
  io = socketServer;

  io.on('connection', (socket: Socket) => {
    logger.debug({ socketId: socket.id }, 'Socket connected');

    // Join user-specific room for notifications (works on all pages)
    if (socket.data.userId) {
      socket.join(`user:${socket.data.userId}`);
    }

    socket.on('session:join', (data) => handleJoinSession(socket, data));
    socket.on('session:leave', (data) => handleLeaveSession(socket, data));
    socket.on('presence:heartbeat', (data) => handleHeartbeat(socket, data));
    socket.on('presence:ready', (data) => handleReady(socket, data));
    socket.on('rating:submit', (data) => handleRatingSubmit(socket, data));
    socket.on('participant:leave_conversation', (data) => handleLeaveConversation(socket, data));

    // Host controls
    socket.on('host:start_session', (data) => handleHostStart(socket, data));
    socket.on('host:start_round', (data) => handleHostStartRound(socket, data));
    socket.on('host:pause_session', (data) => handleHostPause(socket, data));
    socket.on('host:resume_session', (data) => handleHostResume(socket, data));
    socket.on('host:end_session', (data) => handleHostEnd(socket, data));
    socket.on('host:broadcast_message', (data) => handleHostBroadcast(socket, data));
    socket.on('host:remove_participant', (data) => handleHostRemoveParticipant(socket, data));
    socket.on('host:reassign', (data) => handleHostReassign(socket, data));
    socket.on('host:generate_matches', (data) => handleHostGenerateMatches(socket, data));
    socket.on('host:confirm_round', (data) => handleHostConfirmRound(socket, data));
    socket.on('host:swap_match', (data) => handleHostSwapMatch(socket, data));
    socket.on('host:exclude_participant', (data) => handleHostExcludeFromRound(socket, data));
    socket.on('host:regenerate_matches', (data) => handleHostRegenerateMatches(socket, data));
    socket.on('host:mute_participant', (data) => handleHostMuteParticipant(socket, data));
    socket.on('host:mute_all', (data) => handleHostMuteAll(socket, data));
    socket.on('host:remove_from_room', (data) => handleHostRemoveFromRoom(socket, data));
    socket.on('host:assign_cohost', (data) => handleAssignCohost(socket, data));
    socket.on('host:remove_cohost', (data) => handleRemoveCohost(socket, data));

    // Chat
    socket.on('chat:send', (data) => handleChatSend(socket, data));
    socket.on('reaction:send', (data) => handleReactionSend(socket, data));

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
        chatMessages.delete(sessionId);
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

    // ── Single-session enforcement ──
    // At 200+ participants, duplicate tabs/reconnects are common.
    // A user can only be "present" in ONE active session at a time.
    // If they're already in another session, remove them from the old one first.
    for (const [existingSessionId, existingSession] of activeSessions) {
      if (existingSessionId !== data.sessionId && existingSession.presenceMap.has(userId)) {
        existingSession.presenceMap.delete(userId);
        socket.leave(sessionRoom(existingSessionId));
        logger.info({ userId, oldSessionId: existingSessionId, newSessionId: data.sessionId },
          'User moved to new session — removed from previous session presence');
      }
    }

    // ── Single-socket enforcement for same session ──
    // If this user already has a socket in this session, evict the old one
    const activeSession = activeSessions.get(data.sessionId);
    if (activeSession) {
      const existingPresence = activeSession.presenceMap.get(userId);
      if (existingPresence && existingPresence.socketId !== socket.id) {
        // Disconnect old socket to prevent ghost users
        const oldSocket = io.sockets.sockets.get(existingPresence.socketId);
        if (oldSocket) {
          oldSocket.emit('session:evicted', { reason: 'Connected from another tab or device' });
          oldSocket.disconnect(true);
        }
        logger.info({ userId, oldSocketId: existingPresence.socketId, newSocketId: socket.id },
          'Evicted old socket — single connection per user per session');
      }
    }

    // Join socket room
    socket.join(sessionRoom(data.sessionId));
    socket.join(userRoom(userId));

    // Update presence
    if (activeSession) {
      activeSession.presenceMap.set(userId, {
        lastHeartbeat: new Date(),
        socketId: socket.id,
      });
    }

    // Auto-register if not already a participant.
    // The host is also a participant in speed networking — they network too.
    // Pass user role so admin/super_admin can bypass pod visibility restrictions.
    const userRole = (socket.data as any)?.role as UserRole | undefined;
    try {
      await sessionService.registerParticipant(data.sessionId, userId, userRole);
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

    // Notify others — include isHost flag for client-side tracking
    const isHost = session.hostUserId === userId;
    io.to(sessionRoom(data.sessionId)).emit('participant:joined', {
      userId,
      displayName: (socket.data as any)?.displayName || 'Unknown',
      isHost,
    });

    // Send current participant count
    const count = await sessionService.getParticipantCount(data.sessionId);
    io.to(sessionRoom(data.sessionId)).emit('participant:count', { count });

    // Send session state to the JOINING socket: only socket-connected participants, session status, host presence
    try {
      // Get only socket-connected participants from this session room
      const socketsInRoom = await io.in(sessionRoom(data.sessionId)).fetchSockets();
      const connectedParticipants = socketsInRoom
        .map(s => ({
          userId: (s.data as any)?.userId,
          displayName: (s.data as any)?.displayName || 'User',
        }))
        .filter(p => p.userId);
      
      // Check if host is among connected participants
      const hostInLobby = socketsInRoom.some(s => (s.data as any)?.userId === session.hostUserId);
      
      // Get session config for totalRounds
      const config = typeof session.config === 'string'
        ? JSON.parse(session.config as unknown as string)
        : session.config || {};
      
      // Fetch co-hosts for this session
      const cohostResult = await query<{ user_id: string }>(
        `SELECT user_id FROM session_cohosts WHERE session_id = $1`,
        [session.id]
      );
      const cohosts = cohostResult.rows.map(r => r.user_id);

      socket.emit('session:state', {
        participants: connectedParticipants,
        sessionStatus: activeSession?.status || session.status,
        hostInLobby,
        hostUserId: session.hostUserId,
        currentRound: activeSession?.currentRound || 0,
        totalRounds: config.numberOfRounds || 5,
        timerVisibility: config.timerVisibility || 'last_10s',
        cohosts,
      });
    } catch (stateErr) {
      logger.warn({ err: stateErr }, 'Failed to send initial session state');
    }

    // If host reconnects during an active round, re-send the round dashboard
    if (isHost && activeSession && (activeSession.status === SessionStatus.ROUND_ACTIVE || activeSession.status === SessionStatus.ROUND_RATING)) {
      try {
        const getName = async (uid: string) => {
          const r = await query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [uid]);
          return r.rows[0]?.display_name || 'User';
        };
        const matches = await matchingService.getMatchesByRound(data.sessionId, activeSession.currentRound);
        const rooms = await Promise.all(matches.map(async (m: any) => {
          const participants = [
            { userId: m.participantAId, displayName: await getName(m.participantAId), isConnected: activeSession!.presenceMap.has(m.participantAId) },
            { userId: m.participantBId, displayName: await getName(m.participantBId), isConnected: activeSession!.presenceMap.has(m.participantBId) },
          ];
          if (m.participantCId) {
            participants.push({ userId: m.participantCId, displayName: await getName(m.participantCId), isConnected: activeSession!.presenceMap.has(m.participantCId) });
          }
          return { matchId: m.id, roomId: m.roomId || '', status: m.status, participants, isTrio: !!m.participantCId };
        }));
        const byeResult = await query<{ user_id: string; display_name: string }>(
          `SELECT sp.user_id, u.display_name FROM session_participants sp JOIN users u ON u.id = sp.user_id
           WHERE sp.session_id = $1 AND sp.status = 'bye' AND sp.user_id != $2`,
          [data.sessionId, session.hostUserId]
        );
        socket.emit('host:round_dashboard', {
          roundNumber: activeSession.currentRound,
          rooms: rooms.filter((r: any) => r.status !== 'cancelled'),
          byeParticipants: byeResult.rows.map(r => ({ userId: r.user_id, displayName: r.display_name })),
          timerSecondsRemaining: 0,
          reassignmentInProgress: false,
        });
      } catch (dashErr) {
        logger.warn({ err: dashErr }, 'Failed to re-send host round dashboard on reconnect');
      }
    }

    // If in lobby/transition phase and session has a lobby room, send lobby token for video mosaic
    const lobbyPhases = [SessionStatus.LOBBY_OPEN, SessionStatus.ROUND_TRANSITION, SessionStatus.ROUND_RATING, SessionStatus.CLOSING_LOBBY];
    const currentStatus = activeSession?.status || session.status;
    if (session.lobbyRoomId && lobbyPhases.includes(currentStatus as SessionStatus)) {
      try {
        const displayName = (socket.data as any)?.displayName || 'User';
        const lobbyToken = await videoService.issueJoinToken(userId, session.lobbyRoomId, displayName);
        const { config: appConfig } = await import('../../config');
        socket.emit('lobby:token', {
          token: lobbyToken.token,
          livekitUrl: appConfig.livekit.host,
          roomId: session.lobbyRoomId,
        });
      } catch (tokenErr) {
        logger.warn({ err: tokenErr }, 'Failed to issue lobby token');
      }
    }

    // If host reconnects mid-round, send them the dashboard
    if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE && isHost) {
      emitHostDashboard(data.sessionId);
    }

    // If session is mid-round, restore user's match assignment (skip if they manually left)
    if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE && !activeSession.manuallyLeftRound.has(userId)) {
      const matches = await matchingService.getMatchesByRound(
        data.sessionId, activeSession.currentRound
      );
      const userMatch = matches.find(
        m => (m.participantAId === userId || m.participantBId === userId || m.participantCId === userId) && m.status === 'active'
      );

      if (userMatch) {
        // Collect all participant IDs for this match
        const participantIds = [userMatch.participantAId, userMatch.participantBId];
        if (userMatch.participantCId) participantIds.push(userMatch.participantCId);
        const partnerIds = participantIds.filter(id => id !== userId);

        // Look up partner display names
        const partnerNameResult = await query<{ id: string; displayName: string }>(
          `SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1)`, [partnerIds]
        );
        const nameMap = new Map(partnerNameResult.rows.map(r => [r.id, r.displayName || 'Partner']));
        const partners = partnerIds.map(id => ({ userId: id, displayName: nameMap.get(id) || 'Partner' }));

        // Restore participant status to IN_ROUND
        await sessionService.updateParticipantStatus(
          data.sessionId, userId, ParticipantStatus.IN_ROUND
        ).catch(() => {});

        socket.emit('match:assigned', {
          matchId: userMatch.id,
          partnerId: partners[0].userId,
          partnerDisplayName: partners[0].displayName,
          partners,
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
        m => (m.participantAId === userId || m.participantBId === userId || m.participantCId === userId) && m.status === 'completed'
      );
      if (userMatch) {
        const participantIds = [userMatch.participantAId, userMatch.participantBId];
        if (userMatch.participantCId) participantIds.push(userMatch.participantCId);
        const partnerIds = participantIds.filter(id => id !== userId);

        // Look up partner display names for the rating UI
        const partnerNameResult = await query<{ id: string; displayName: string }>(
          `SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1)`, [partnerIds]
        );
        const nameMap = new Map(partnerNameResult.rows.map(r => [r.id, r.displayName || 'Partner']));
        const partnersWithNames = partnerIds.map(id => ({ userId: id, displayName: nameMap.get(id) || 'Partner' }));

        const remainingSeconds = activeSession.timerEndsAt
          ? Math.max(0, Math.ceil((activeSession.timerEndsAt.getTime() - Date.now()) / 1000))
          : activeSession.config.ratingWindowSeconds;
        socket.emit('rating:window_open', {
          matchId: userMatch.id,
          partnerId: partnerIds[0],
          partnerDisplayName: nameMap.get(partnerIds[0]) || 'Partner',
          partners: partnersWithNames,
          roundNumber: activeSession.currentRound,
          durationSeconds: remainingSeconds,
        });
      }
    }

    // Send chat history to joining user
    const history = chatMessages.get(data.sessionId) || [];
    if (history.length > 0) {
      socket.emit('chat:history', { messages: history });
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

  // Check if leaving user is host
  const session = await sessionService.getSessionById(data.sessionId).catch(() => null);
  const isHost = session?.hostUserId === userId;

  // If event hasn't started yet, keep status as 'registered' — they're just leaving the lobby
  if (session?.status === SessionStatus.SCHEDULED || session?.status === SessionStatus.LOBBY_OPEN) {
    await sessionService.updateParticipantStatus(
      data.sessionId, userId, ParticipantStatus.REGISTERED
    );
  } else {
    await sessionService.updateParticipantStatus(
      data.sessionId, userId, ParticipantStatus.LEFT
    );
  }

  io.to(sessionRoom(data.sessionId)).emit('participant:left', { userId, isHost });

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

    // ─── Early exit: if ALL participants in this round have rated, skip remaining timer ───
    await checkAllRatingsComplete(socket);
  } catch (err: any) {
    socket.emit('error', { code: 'RATING_FAILED', message: err.message });
  }
}

/**
 * After each rating submission, check if all participants in the current round
 * have finished rating. If so, cancel the rating window timer and advance immediately.
 */
async function checkAllRatingsComplete(socket: Socket): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) return;

    // Find which session this user is in
    let sessionId: string | null = null;
    let activeSession: ActiveSession | null = null;
    for (const [sid, s] of activeSessions) {
      if (s.presenceMap.has(userId) && s.status === SessionStatus.ROUND_RATING) {
        sessionId = sid;
        activeSession = s;
        break;
      }
    }
    if (!sessionId || !activeSession) return;

    const roundNumber = activeSession.currentRound;

    // Get all matches for this round
    const matches = await matchingService.getMatchesByRound(sessionId, roundNumber);
    const completedMatches = matches.filter(m => m.status === 'completed' || m.status === 'no_show');

    // Collect all participant IDs who need to rate
    const participantIds = new Set<string>();
    for (const m of completedMatches) {
      participantIds.add(m.participantAId);
      participantIds.add(m.participantBId);
      if (m.participantCId) participantIds.add(m.participantCId);
    }

    // Count how many ratings exist for this round
    const ratingCountResult = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ratings r
       JOIN matches m ON r.match_id = m.id
       WHERE m.session_id = $1 AND m.round_number = $2`,
      [sessionId, roundNumber]
    );
    const totalRatings = parseInt(ratingCountResult.rows[0]?.count || '0', 10);

    // Each participant rates each partner: pairs = 2 ratings, trios = 6 ratings
    let expectedRatings = 0;
    for (const m of completedMatches) {
      const pCount = m.participantCId ? 3 : 2;
      expectedRatings += pCount * (pCount - 1); // each rates each other
    }

    if (totalRatings >= expectedRatings && expectedRatings > 0) {
      logger.info({ sessionId, roundNumber, totalRatings, expectedRatings }, 'All ratings submitted — ending rating window early');

      // Cancel the existing timer
      if (activeSession.timer) {
        clearTimeout(activeSession.timer);
        activeSession.timer = null;
        activeSession.timerEndsAt = null;
      }

      // Advance immediately
      endRatingWindow(sessionId, roundNumber);
    }
  } catch (err) {
    logger.error({ err }, 'Error in checkAllRatingsComplete');
  }
}

// ─── Leave Conversation (return to lobby, stay in event) ────────────────────

async function handleLeaveConversation(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) return;

    const { sessionId } = data;
    const activeSession = activeSessions.get(sessionId);
    if (!activeSession || activeSession.status !== SessionStatus.ROUND_ACTIVE) return;

    // Track that this user manually left — prevents re-entry via reconnect
    activeSession.manuallyLeftRound.add(userId);

    // Find the user's active match
    const matches = await matchingService.getMatchesByRound(sessionId, activeSession.currentRound);
    const userMatch = matches.find(
      m => (m.participantAId === userId || m.participantBId === userId || m.participantCId === userId) && m.status === 'active'
    );
    if (!userMatch) return;

    // Mark match as ended early
    await query(
      `UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1 AND status = 'active'`,
      [userMatch.id]
    );

    // Move user back to lobby status
    await sessionService.updateParticipantStatus(sessionId, userId, ParticipantStatus.IN_LOBBY);

    // Tell the user to return to lobby
    socket.emit('match:return_to_lobby', { reason: 'you_left' });

    // Notify remaining partners
    const partnerIds = [userMatch.participantAId, userMatch.participantBId, userMatch.participantCId]
      .filter((id): id is string => !!id && id !== userId);

    for (const partnerId of partnerIds) {
      io.to(userRoom(partnerId)).emit('match:partner_disconnected', { matchId: userMatch.id });
    }

    // Re-issue lobby token so user can rejoin lobby video
    const session = await sessionService.getSessionById(sessionId);
    if (session.lobbyRoomId) {
      try {
        const { config: appConfig } = await import('../../config');
        const dName = (socket.data as any)?.displayName || 'User';
        const lobbyToken = await videoService.issueJoinToken(userId, session.lobbyRoomId, dName);
        socket.emit('lobby:token', {
          token: lobbyToken.token,
          livekitUrl: appConfig.livekit.host,
          roomId: session.lobbyRoomId,
        });
      } catch { /* skip */ }
    }

    logger.info({ sessionId, userId, matchId: userMatch.id }, 'Participant left conversation → returned to lobby');

    // ─── 2.3: Auto-return solo partner after 5s ────────────────────
    if (partnerIds.length === 1) {
      const soloPartnerId = partnerIds[0];
      setTimeout(async () => {
        try {
          const currentSession = activeSessions.get(sessionId);
          if (!currentSession || currentSession.status !== SessionStatus.ROUND_ACTIVE) return;
          if (currentSession.currentRound !== activeSession.currentRound) return;

          // Check if the match is still marked completed (partner hasn't been reassigned)
          const freshMatch = (await matchingService.getMatchesByRound(sessionId, currentSession.currentRound))
            .find(m => m.id === userMatch.id);
          if (!freshMatch || freshMatch.status !== 'completed') return;

          // Move solo partner to lobby
          await sessionService.updateParticipantStatus(sessionId, soloPartnerId, ParticipantStatus.IN_LOBBY);
          io.to(userRoom(soloPartnerId)).emit('match:return_to_lobby', { reason: 'partner_left' });

          // Re-issue lobby token for the solo partner
          if (session.lobbyRoomId) {
            const socketsInRoom = await io.in(userRoom(soloPartnerId)).fetchSockets();
            const { config: appConfig } = await import('../../config');
            for (const s of socketsInRoom) {
              try {
                const uid = (s.data as any)?.userId;
                const dName = (s.data as any)?.displayName || 'User';
                if (uid !== soloPartnerId) continue;
                const lobbyToken = await videoService.issueJoinToken(uid, session.lobbyRoomId, dName);
                s.emit('lobby:token', {
                  token: lobbyToken.token,
                  livekitUrl: appConfig.livekit.host,
                  roomId: session.lobbyRoomId,
                });
              } catch { /* skip */ }
            }
          }

          logger.info({ sessionId, soloPartnerId, matchId: userMatch.id }, 'Auto-returned solo partner to lobby after 5s');
        } catch (err) {
          logger.error({ err }, 'Error in auto-return solo partner');
        }
      }, 5000);
    }
  } catch (err) {
    logger.error({ err }, 'Error in handleLeaveConversation');
  }
}

// ─── Disconnect ─────────────────────────────────────────────────────────────

async function handleDisconnect(socket: Socket): Promise<void> {
  const userId = getUserIdFromSocket(socket);
  if (!userId) return;

  // Track which session IDs we already handled via activeSessions so we don't double-emit
  const handledSessionIds = new Set<string>();

  // Mark disconnected in all active sessions they were part of
  for (const [sessionId, activeSession] of activeSessions) {
    if (activeSession.presenceMap.has(userId)) {
      handledSessionIds.add(sessionId);
      activeSession.presenceMap.delete(userId);

      await sessionService.updateParticipantStatus(
        sessionId, userId, ParticipantStatus.DISCONNECTED
      ).catch(() => {}); // Swallow errors on disconnect cleanup

      // Always notify remaining participants that this user left
      const isHost = activeSession.hostUserId === userId;
      io.to(sessionRoom(sessionId)).emit('participant:left', { userId, isHost });

      // If mid-round, notify partner and attempt auto-reassignment
      if (activeSession.status === SessionStatus.ROUND_ACTIVE) {
        try {
          const matches = await matchingService.getMatchesByRound(sessionId, activeSession.currentRound);
          const userMatch = matches.find(
            m => (m.participantAId === userId || m.participantBId === userId) && m.status === 'active'
          );
          if (userMatch) {
            const partnerId = userMatch.participantAId === userId
              ? userMatch.participantBId : userMatch.participantAId;

            // Step 1: Notify partner with "waiting for reassignment" (NOT bye_round)
            io.to(userRoom(partnerId)).emit('match:partner_disconnected', {
              matchId: userMatch.id,
            });

            const disconnectRound = activeSession.currentRound;
            const disconnectMatchId = userMatch.id;

            // Step 2: After 15 seconds, try auto-reassignment or fall back to bye
            setTimeout(async () => {
              try {
                const currentSession = activeSessions.get(sessionId);
                if (!currentSession || currentSession.currentRound !== disconnectRound) return;
                if (currentSession.presenceMap.has(userId)) {
                  // User reconnected — notify partner
                  io.to(userRoom(partnerId)).emit('match:partner_reconnected', {
                    matchId: disconnectMatchId,
                  });
                  return;
                }

                // Mark original match as no_show
                await query(
                  `UPDATE matches SET status = 'no_show', ended_at = NOW() WHERE id = $1 AND status = 'active'`,
                  [disconnectMatchId]
                );

                // Step 3: Try auto-reassignment — find another isolated participant
                const noShowMatches = await query<{ id: string; participant_a_id: string; participant_b_id: string }>(
                  `SELECT id, participant_a_id, participant_b_id FROM matches
                   WHERE session_id = $1 AND round_number = $2 AND status = 'no_show' AND id != $3`,
                  [sessionId, disconnectRound, disconnectMatchId]
                );

                let reassigned = false;
                for (const nsMatch of noShowMatches.rows) {
                  // Find which participant in this no_show match is still present
                  const candidateA = nsMatch.participant_a_id;
                  const candidateB = nsMatch.participant_b_id;
                  const candidatePresent = currentSession.presenceMap.has(candidateA) ? candidateA
                    : currentSession.presenceMap.has(candidateB) ? candidateB : null;

                  if (candidatePresent && candidatePresent !== partnerId) {
                    // Found another isolated participant — pair them!
                    const reassignSlug = `auto-reassign-${Date.now()}`;
                    const roomId = `session-${sessionId}-round-${disconnectRound}-${reassignSlug}`;
                    try {
                      await videoService.createMatchRoom(sessionId, disconnectRound, reassignSlug);
                    } catch { /* room may already exist */ }

                    const matchId = require('uuid').v4();
                    // Normalize participant order (lexicographic) for constraint consistency
                    const normA = partnerId < candidatePresent ? partnerId : candidatePresent;
                    const normB = partnerId < candidatePresent ? candidatePresent : partnerId;
                    try {
                      await query(
                        `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, room_id, status, started_at)
                         VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())`,
                        [matchId, sessionId, disconnectRound, normA, normB, roomId]
                      );
                    } catch (insertErr: any) {
                      // DB constraint caught a conflict — participant already matched
                      if (insertErr.message?.includes('PARTICIPANT_ALREADY_MATCHED') || insertErr.code === '23505') {
                        logger.warn({ partnerId, candidatePresent, disconnectRound },
                          'Auto-reassign skipped: participant already in active match');
                        continue; // Try next candidate
                      }
                      throw insertErr;
                    }

                    // Fetch display names
                    const nameRes = await query<{ id: string; display_name: string }>(
                      `SELECT id, display_name FROM users WHERE id = ANY($1)`,
                      [[partnerId, candidatePresent]]
                    );
                    const names = new Map(nameRes.rows.map(r => [r.id, r.display_name || 'User']));

                    io.to(userRoom(partnerId)).emit('match:reassigned', {
                      matchId, newPartnerId: candidatePresent,
                      partnerDisplayName: names.get(candidatePresent),
                      roomId, roundNumber: disconnectRound,
                    });
                    io.to(userRoom(candidatePresent)).emit('match:reassigned', {
                      matchId, newPartnerId: partnerId,
                      partnerDisplayName: names.get(partnerId),
                      roomId, roundNumber: disconnectRound,
                    });

                    logger.info({ sessionId, partnerId, candidatePresent, matchId },
                      'Auto-reassigned isolated participants after disconnect');
                    reassigned = true;
                    break;
                  }
                }

                if (!reassigned) {
                  // No available partner — fall back to bye round
                  io.to(userRoom(partnerId)).emit('match:bye_round', {
                    roundNumber: disconnectRound,
                    reason: 'Your partner could not reconnect and no reassignment was available. You have a bye this round.',
                  });
                  logger.info({ sessionId, userId, partnerId, matchId: disconnectMatchId },
                    'Partner disconnect timeout — no reassignment available, converted to bye');
                }
              } catch (err) {
                logger.warn({ err, sessionId, userId }, 'Error in disconnect timeout handler');
              }
            }, 15000);
          }
        } catch (err) {
          logger.warn({ err, sessionId, userId }, 'Failed to notify partner of disconnect');
        }
      }

      logger.info({ sessionId, userId }, 'Participant disconnected');
    }
  }

  // Handle disconnects for sessions not yet in activeSessions (e.g. SCHEDULED state).
  // The socket joined session rooms via session:join but the host hasn't started yet,
  // so there's no ActiveSession with a presenceMap entry. We still need to emit
  // participant:left so other waiting participants see the real-time update.
  try {
    const socketRooms = [...socket.rooms];
    for (const room of socketRooms) {
      if (!room.startsWith('session:')) continue;
      const sessionId = room.replace('session:', '');
      if (handledSessionIds.has(sessionId)) continue; // Already handled above

      // Look up session to determine if this user is host
      const session = await sessionService.getSessionById(sessionId).catch(() => null);
      if (!session) continue;
      const isHost = session.hostUserId === userId;

      io.to(sessionRoom(sessionId)).emit('participant:left', { userId, isHost });
      logger.info({ sessionId, userId }, 'Participant disconnected from pre-lobby waiting room');
    }
  } catch (err) {
    logger.warn({ err, userId }, 'Error handling disconnect for non-active session rooms');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// HOST HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/** Get all user IDs that should be excluded from matching: original host + co-hosts */
async function getAllHostIds(sessionId: string, hostUserId: string): Promise<string[]> {
  const cohostResult = await query<{ user_id: string }>(
    `SELECT user_id FROM session_cohosts WHERE session_id = $1`,
    [sessionId]
  );
  return [hostUserId, ...cohostResult.rows.map(r => r.user_id)];
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

    // Create LiveKit lobby room for the video mosaic
    try {
      const lobbyRoom = await videoService.createLobbyRoom(data.sessionId);
      await sessionService.updateSessionStatus(data.sessionId, SessionStatus.LOBBY_OPEN, {
        lobbyRoomId: lobbyRoom.roomId,
      });
      logger.info({ sessionId: data.sessionId, lobbyRoom: lobbyRoom.roomId }, 'Lobby LiveKit room created');

      // Distribute lobby tokens to all sockets already in the session room
      try {
        const { config: appConfig } = await import('../../config');
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
      timerEndsAt: null,
      isPaused: false,
      pausedTimeRemaining: null,
      presenceMap: new Map(),
      pendingRoundNumber: null,
      manuallyLeftRound: new Set(),
    };

    activeSessions.set(data.sessionId, activeSession);

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
    // endRound() triggers the normal flow: rating window → endRatingWindow() →
    // next round (if more remain) or closing lobby → completeSession().
    if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE) {
      // Clear any existing timer
      if (activeSession.timer) clearTimeout(activeSession.timer);

      // End the current round — endRound() schedules the rating window timer
      // which in turn calls endRatingWindow() → multi-round transition logic
      await endRound(data.sessionId, activeSession.currentRound);
      logger.info({ sessionId: data.sessionId }, 'Host ended active round — rating window started, normal flow continues');
      return;
    }

    // If in closing lobby, host can skip the 30s countdown
    if (activeSession && activeSession.status === SessionStatus.CLOSING_LOBBY) {
      if (activeSession.timer) { clearTimeout(activeSession.timer); activeSession.timer = null; }
      logger.info({ sessionId: data.sessionId }, 'Host skipped closing lobby');
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

// ─── Host Generate Matches (preview step) ────────────────────────────────────

async function handleHostGenerateMatches(
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

    if (
      activeSession.status !== SessionStatus.LOBBY_OPEN &&
      activeSession.status !== SessionStatus.ROUND_TRANSITION
    ) {
      socket.emit('error', {
        code: 'INVALID_STATE',
        message: 'Can only generate matches from the lobby or transition phase',
      });
      return;
    }

    // Need at least 2 non-host/co-host participants for matching
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
        message: `Need at least 2 participants (currently ${participantCount})`,
      });
      return;
    }

    const nextRound = activeSession.status === SessionStatus.LOBBY_OPEN
      ? 1
      : activeSession.currentRound + 1;

    // Generate matches for preview — exclude host + co-hosts from matching
    await matchingService.generateSingleRound(data.sessionId, nextRound, allHostIds);

    // Store pending round number so confirm_round knows what to start
    activeSession.pendingRoundNumber = nextRound;

    // Send preview to host only (includes trio support + encounter history)
    await sendMatchPreview(socket, data.sessionId, nextRound, activeSession.hostUserId);

    logger.info({ sessionId: data.sessionId, roundNumber: nextRound },
      'Match preview generated for host');
  } catch (err: any) {
    logger.error({ err }, 'Error generating match preview');
    socket.emit('error', { code: 'GENERATE_FAILED', message: err.message });
  }
}

// ─── Host Confirm Round (start after preview) ───────────────────────────────

async function handleHostConfirmRound(
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

    if (!activeSession.pendingRoundNumber) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'No pending matches to confirm. Click "Match People" first.' });
      return;
    }

    // Clear any existing timer
    if (activeSession.timer) {
      clearTimeout(activeSession.timer);
      activeSession.timer = null;
    }

    const roundNumber = activeSession.pendingRoundNumber;
    activeSession.pendingRoundNumber = null;

    // ─── Matching anticipation: broadcast "matching in progress" then delay ───
    const matches = await matchingService.getMatchesByRound(data.sessionId, roundNumber);
    const roomCount = matches.length;

    io.to(sessionRoom(data.sessionId)).emit('session:matching_in_progress', {
      sessionId: data.sessionId,
      roomCount,
      roundNumber,
    });

    // Deliberate 2.5s anticipation delay before actually moving people
    await new Promise(resolve => setTimeout(resolve, 2500));

    logger.info({ sessionId: data.sessionId, roundNumber, roomCount }, 'Host confirmed round — starting');
    await transitionToRound(data.sessionId, roundNumber);
  } catch (err: any) {
    logger.error({ err }, 'Error confirming round');
    socket.emit('error', { code: 'CONFIRM_ROUND_FAILED', message: err.message });
  }
}

// ─── Host Swap Match (swap two participants between matches in preview) ──────

async function handleHostSwapMatch(
  socket: Socket,
  data: { sessionId: string; userA: string; userB: string }
): Promise<void> {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession || !activeSession.pendingRoundNumber) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'No pending match preview to edit' });
      return;
    }

    const roundNumber = activeSession.pendingRoundNumber;

    // Swap the two users between their respective matches
    // Find match containing userA and match containing userB
    const matches = await matchingService.getMatchesByRound(data.sessionId, roundNumber);
    const matchA = matches.find(m => m.participantAId === data.userA || m.participantBId === data.userA || m.participantCId === data.userA);
    const matchB = matches.find(m => m.participantAId === data.userB || m.participantBId === data.userB || m.participantCId === data.userB);

    if (!matchA || !matchB || matchA.id === matchB.id) {
      socket.emit('error', { code: 'SWAP_FAILED', message: 'Cannot swap — participants must be in different matches' });
      return;
    }

    // Perform the swap in DB — replace userA with userB in matchA, and vice versa
    const replaceInMatch = (match: typeof matchA, oldUser: string, newUser: string) => {
      const ids = [match!.participantAId, match!.participantBId, match!.participantCId].map(
        id => id === oldUser ? newUser : id
      );
      // Sort A < B for consistency (C stays as-is if present)
      const main = [ids[0]!, ids[1]!].sort();
      return { a: main[0], b: main[1], c: ids[2] || null };
    };

    const newA = replaceInMatch(matchA, data.userA, data.userB);
    const newB = replaceInMatch(matchB, data.userB, data.userA);

    await query('UPDATE matches SET participant_a_id = $1, participant_b_id = $2, participant_c_id = $3 WHERE id = $4',
      [newA.a, newA.b, newA.c, matchA.id]);
    await query('UPDATE matches SET participant_a_id = $1, participant_b_id = $2, participant_c_id = $3 WHERE id = $4',
      [newB.a, newB.b, newB.c, matchB.id]);

    // Re-send updated preview (pass hostUserId so host is excluded from bye list)
    await sendMatchPreview(socket, data.sessionId, roundNumber, activeSession.hostUserId);

    logger.info({ sessionId: data.sessionId, userA: data.userA, userB: data.userB }, 'Host swapped match participants');
  } catch (err: any) {
    socket.emit('error', { code: 'SWAP_FAILED', message: err.message });
  }
}

// ─── Host Exclude Participant from Round ────────────────────────────────────

async function handleHostExcludeFromRound(
  socket: Socket,
  data: { sessionId: string; userId: string }
): Promise<void> {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession || !activeSession.pendingRoundNumber) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'No pending match preview to edit' });
      return;
    }

    const roundNumber = activeSession.pendingRoundNumber;

    // Find the match containing this user
    const matches = await matchingService.getMatchesByRound(data.sessionId, roundNumber);
    const userMatch = matches.find(m =>
      m.participantAId === data.userId || m.participantBId === data.userId || m.participantCId === data.userId
    );

    if (userMatch) {
      if (userMatch.participantCId === data.userId) {
        // Trio: just remove participant C — pair remains intact
        await query('UPDATE matches SET participant_c_id = NULL WHERE id = $1', [userMatch.id]);
      } else if (userMatch.participantCId) {
        // Trio: excluded user is A or B — promote C to fill the gap
        const remaining = [userMatch.participantAId, userMatch.participantBId, userMatch.participantCId]
          .filter(id => id !== data.userId);
        const sorted = remaining.sort();
        await query('UPDATE matches SET participant_a_id = $1, participant_b_id = $2, participant_c_id = NULL WHERE id = $3',
          [sorted[0], sorted[1], userMatch.id]);
      } else {
        // Pair: delete the match — the partner becomes a bye participant
        await query('DELETE FROM matches WHERE id = $1', [userMatch.id]);
      }
    }

    // Re-send updated preview (pass hostUserId so host is excluded from bye list)
    await sendMatchPreview(socket, data.sessionId, roundNumber, activeSession.hostUserId);

    logger.info({ sessionId: data.sessionId, excludedUser: data.userId }, 'Host excluded participant from round');
  } catch (err: any) {
    socket.emit('error', { code: 'EXCLUDE_FAILED', message: err.message });
  }
}

// ─── Host Regenerate Matches ────────────────────────────────────────────────

async function handleHostRegenerateMatches(
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession || !activeSession.pendingRoundNumber) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'No pending match preview to regenerate' });
      return;
    }

    const roundNumber = activeSession.pendingRoundNumber;

    // Delete existing scheduled matches for this round
    await query(
      `DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled'`,
      [data.sessionId, roundNumber]
    );

    // Re-generate (exclude host + co-hosts from matching)
    const allHostIds = await getAllHostIds(data.sessionId, activeSession.hostUserId);
    await matchingService.generateSingleRound(data.sessionId, roundNumber, allHostIds);

    // Re-send preview
    await sendMatchPreview(socket, data.sessionId, roundNumber, activeSession.hostUserId);

    logger.info({ sessionId: data.sessionId, roundNumber }, 'Host regenerated matches');
  } catch (err: any) {
    socket.emit('error', { code: 'REGENERATE_FAILED', message: err.message });
  }
}

// ─── Host: Mute/Unmute Participant ──────────────────────────────────────────

async function handleHostMuteParticipant(socket: Socket, data: any): Promise<void> {
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

async function handleHostMuteAll(socket: Socket, data: any): Promise<void> {
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

async function handleHostRemoveFromRoom(socket: Socket, data: any): Promise<void> {
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
    await emitHostDashboard(data.sessionId);

    logger.info({ sessionId: data.sessionId, matchId: data.matchId, removedUserId: data.userId },
      'Host removed participant from breakout room');
  } catch (err) {
    logger.error({ err }, 'Error removing participant from room');
    socket.emit('error', { code: 'REMOVE_FAILED', message: 'Failed to remove participant from room' });
  }
}

// ─── Helper: Send Match Preview to Host ─────────────────────────────────────

async function sendMatchPreview(
  socket: Socket,
  sessionId: string,
  roundNumber: number,
  hostUserId?: string
): Promise<void> {
  const matches = await matchingService.getMatchesByRound(sessionId, roundNumber);

  const allUserIds = new Set<string>();
  for (const m of matches) {
    allUserIds.add(m.participantAId);
    allUserIds.add(m.participantBId);
    if (m.participantCId) allUserIds.add(m.participantCId);
  }

  const namesResult = await query<{ id: string; displayName: string }>(
    `SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1)`,
    [Array.from(allUserIds)]
  );
  const nameMap = new Map(namesResult.rows.map(r => [r.id, r.displayName || 'User']));

  // Fetch encounter history for all matched pairs to show "met before" info
  const userIdsArray = Array.from(allUserIds);
  const encounterResult = userIdsArray.length > 0
    ? await query<{ user_a_id: string; user_b_id: string; times_met: number }>(
        `SELECT user_a_id, user_b_id, times_met FROM encounter_history
         WHERE user_a_id = ANY($1) AND user_b_id = ANY($1) AND times_met > 0`,
        [userIdsArray]
      )
    : { rows: [] };
  const encounterMap = new Map<string, number>();
  for (const e of encounterResult.rows) {
    const key = [e.user_a_id, e.user_b_id].sort().join(':');
    encounterMap.set(key, e.times_met);
  }

  const matchPreview = matches.map(m => {
    const pairKey = [m.participantAId, m.participantBId].sort().join(':');
    const timesMet = encounterMap.get(pairKey) || 0;
    const preview: any = {
      participantA: { userId: m.participantAId, displayName: nameMap.get(m.participantAId) || 'User' },
      participantB: { userId: m.participantBId, displayName: nameMap.get(m.participantBId) || 'User' },
      metBefore: timesMet > 0,
      timesMet,
    };
    if (m.participantCId) {
      preview.participantC = { userId: m.participantCId, displayName: nameMap.get(m.participantCId) || 'User' };
      preview.isTrio = true;
    }
    return preview;
  });

  // Exclude host from bye list — host stays in lobby, not a "bye"
  const allParticipants = hostUserId
    ? await query<{ user_id: string }>(
        `SELECT user_id FROM session_participants WHERE session_id = $1 AND status IN ('in_lobby', 'checked_in', 'registered')
           AND user_id != $2`,
        [sessionId, hostUserId]
      )
    : await query<{ user_id: string }>(
        `SELECT user_id FROM session_participants WHERE session_id = $1 AND status IN ('in_lobby', 'checked_in', 'registered')`,
        [sessionId]
      );
  const matchedIds = new Set(matches.flatMap(m => [m.participantAId, m.participantBId, ...(m.participantCId ? [m.participantCId] : [])]));
  const byeParticipants = allParticipants.rows
    .filter(p => !matchedIds.has(p.user_id))
    .map(p => ({ userId: p.user_id, displayName: nameMap.get(p.user_id) || 'User' }));

  // Generate warnings when multiple participants have byes (unique pairs likely exhausted)
  const roundWarnings: string[] = [];
  if (byeParticipants.length > 1) {
    roundWarnings.push(`All unique pairs exhausted — ${byeParticipants.length} participants have bye rounds`);
  }

  socket.emit('host:match_preview', {
    roundNumber,
    matches: matchPreview,
    byeParticipants,
    ...(roundWarnings.length > 0 && { warnings: roundWarnings }),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// STATE MACHINE TRANSITIONS
// ═════════════════════════════════════════════════════════════════════════════

// ─── Host Round Dashboard ───────────────────────────────────────────────────

async function emitHostDashboard(sessionId: string): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession || !io) return;

  try {
    const matches = await matchingService.getMatchesByRound(sessionId, activeSession.currentRound);

    // Look up display names for all participant IDs
    const allUserIds = new Set<string>();
    for (const m of matches) {
      allUserIds.add(m.participantAId);
      allUserIds.add(m.participantBId);
      if (m.participantCId) allUserIds.add(m.participantCId);
    }
    const nameMap = new Map<string, string>();
    if (allUserIds.size > 0) {
      const nameResult = await query<{ id: string; displayName: string }>(
        `SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1)`,
        [Array.from(allUserIds)]
      );
      for (const row of nameResult.rows) nameMap.set(row.id, row.displayName);
    }

    const rooms = matches
      .filter(m => m.status === 'active' || m.status === 'completed' || m.status === 'no_show')
      .map(m => {
        const participants = [
          {
            userId: m.participantAId,
            displayName: nameMap.get(m.participantAId) || 'User',
            isConnected: activeSession.presenceMap.has(m.participantAId),
          },
          {
            userId: m.participantBId,
            displayName: nameMap.get(m.participantBId) || 'User',
            isConnected: activeSession.presenceMap.has(m.participantBId),
          },
        ];
        if (m.participantCId) {
          participants.push({
            userId: m.participantCId,
            displayName: nameMap.get(m.participantCId) || 'User',
            isConnected: activeSession.presenceMap.has(m.participantCId),
          });
        }
        return {
          matchId: m.id,
          roomId: m.roomId || '',
          status: m.status,
          participants,
          isTrio: !!m.participantCId,
        };
      });

    // Find bye participants (matched to nobody)
    const matchedUserIds = new Set<string>();
    for (const m of matches) {
      matchedUserIds.add(m.participantAId);
      matchedUserIds.add(m.participantBId);
      if (m.participantCId) matchedUserIds.add(m.participantCId);
    }

    const byeParticipants: { userId: string; displayName: string }[] = [];
    for (const [userId] of activeSession.presenceMap) {
      if (userId !== activeSession.hostUserId && !matchedUserIds.has(userId)) {
        byeParticipants.push({
          userId,
          displayName: nameMap.get(userId) || 'User',
        });
      }
    }

    const timerSecondsRemaining = activeSession.timerEndsAt
      ? Math.max(0, Math.ceil((activeSession.timerEndsAt.getTime() - Date.now()) / 1000))
      : 0;

    io.to(userRoom(activeSession.hostUserId)).emit('host:round_dashboard', {
      roundNumber: activeSession.currentRound,
      rooms,
      byeParticipants,
      timerSecondsRemaining,
      reassignmentInProgress: false,
    });
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to emit host dashboard');
  }
}

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
    activeSession.manuallyLeftRound.clear();

    await sessionService.updateSessionStatus(sessionId, SessionStatus.ROUND_ACTIVE);
    await query('UPDATE sessions SET current_round = $1 WHERE id = $2', [roundNumber, sessionId]);

    // Generate matches for this round (or load if pre-generated)
    // Exclude host from matching — host stays in lobby to manage the event
    let matches = await matchingService.getMatchesByRound(sessionId, roundNumber);
    if (matches.length === 0) {
      // Generate on-the-fly for this round
      await matchingService.generateSingleRound(sessionId, roundNumber, [activeSession.hostUserId]);
      matches = await matchingService.getMatchesByRound(sessionId, roundNumber);
    }

    // Collect all matched user IDs to determine bye participants
    const matchedUserIds = new Set<string>();

    // ── SCALE-OPTIMISED: Parallel room creation + batched DB updates ──
    // At 200 participants = 100 matches, sequential await would take 15-30s.
    // Parallel approach: <2s regardless of participant count.

    // Step 1: Compute roomIds and collect ALL participant IDs upfront
    const matchRoomMap = new Map<string, string>(); // matchId -> roomId
    const allParticipantIds = new Set<string>();
    for (const match of matches) {
      const matchIdShort = match.id.slice(0, 8);
      const roomId = match.roomId || videoService.matchRoomId(sessionId, roundNumber, matchIdShort);
      matchRoomMap.set(match.id, roomId);

      const pids = [match.participantAId, match.participantBId];
      if (match.participantCId) pids.push(match.participantCId);
      for (const pid of pids) {
        matchedUserIds.add(pid);
        allParticipantIds.add(pid);
      }
    }

    // Step 2: Create ALL LiveKit rooms in parallel (batched, max 20 concurrent)
    const ROOM_BATCH_SIZE = 20;
    const matchList = Array.from(matches);
    for (let i = 0; i < matchList.length; i += ROOM_BATCH_SIZE) {
      const batch = matchList.slice(i, i + ROOM_BATCH_SIZE);
      await Promise.allSettled(
        batch.map(match =>
          videoService.createMatchRoom(sessionId, roundNumber, match.id.slice(0, 8))
            .catch(err => logger.warn({ err, matchId: match.id }, 'LiveKit room creation failed (may already exist)'))
        )
      );
    }

    // Step 3: Batch-update ALL matches to active status in one query
    if (matches.length > 0) {
      const updateCases = matches.map(m => {
        const roomId = matchRoomMap.get(m.id)!;
        return `WHEN '${m.id}' THEN '${roomId}'`;
      }).join(' ');
      const matchIds = matches.map(m => m.id);
      await query(
        `UPDATE matches SET status = 'active', started_at = NOW(),
         room_id = CASE id::text ${updateCases} ELSE room_id END
         WHERE id = ANY($1)`,
        [matchIds]
      );
    }

    // Step 4: Batch-fetch ALL display names in one query (not per-match)
    const allPidArray = Array.from(allParticipantIds);
    const namesResult = allPidArray.length > 0
      ? await query<{ id: string; displayName: string }>(
          `SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1)`,
          [allPidArray]
        )
      : { rows: [] };
    const globalNameMap = new Map(namesResult.rows.map(r => [r.id, r.displayName]));

    // Step 5: Emit match:assigned to all participants + batch status update
    const statusUpdatePromises: Promise<void>[] = [];
    for (const match of matches) {
      const roomId = matchRoomMap.get(match.id)!;
      const matchParticipantIds = [match.participantAId, match.participantBId];
      if (match.participantCId) matchParticipantIds.push(match.participantCId);

      for (const pid of matchParticipantIds) {
        const partners = matchParticipantIds
          .filter(id => id !== pid)
          .map(id => ({ userId: id, displayName: globalNameMap.get(id) || 'Partner' }));

        io.to(userRoom(pid)).emit('match:assigned', {
          matchId: match.id,
          partnerId: partners[0].userId,
          partnerDisplayName: partners[0].displayName,
          partners,
          roomId,
          roundNumber,
        });

        statusUpdatePromises.push(
          sessionService.updateParticipantStatus(sessionId, pid, ParticipantStatus.IN_ROUND)
        );
      }
    }
    // Fire all status updates in parallel (these are independent writes)
    await Promise.allSettled(statusUpdatePromises);

    // Notify bye participants (unmatched due to odd count — exclude host, they stay in lobby)
    const allParticipants = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants WHERE session_id = $1 AND status IN ('in_lobby', 'checked_in', 'registered')
         AND user_id != $2`,
      [sessionId, activeSession.hostUserId]
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

    // Emit host dashboard immediately and every 5 seconds during the round
    emitHostDashboard(sessionId);
    const dashboardInterval = setInterval(() => {
      const s = activeSessions.get(sessionId);
      if (!s || s.status !== SessionStatus.ROUND_ACTIVE) {
        clearInterval(dashboardInterval);
        return;
      }
      emitHostDashboard(sessionId);
    }, 5000);

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

    // Batch-lookup display names for all participants across all matches
    const allMatchParticipantIds = new Set<string>();
    for (const match of matches) {
      allMatchParticipantIds.add(match.participantAId);
      allMatchParticipantIds.add(match.participantBId);
      if (match.participantCId) allMatchParticipantIds.add(match.participantCId);
    }
    const ratingNameMap = new Map<string, string>();
    if (allMatchParticipantIds.size > 0) {
      const nameResult = await query<{ id: string; displayName: string }>(
        `SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1)`,
        [Array.from(allMatchParticipantIds)]
      );
      for (const row of nameResult.rows) ratingNameMap.set(row.id, row.displayName || 'Partner');
    }

    for (const match of matches) {
      if (match.status === 'completed') {
        // Collect all participant IDs for this match (pair or trio)
        const participantIds = [match.participantAId, match.participantBId];
        if (match.participantCId) participantIds.push(match.participantCId);

        // Notify each participant to rate their partner(s) — include display names
        for (const pid of participantIds) {
          const partnerIds = participantIds.filter(id => id !== pid);
          const partnersWithNames = partnerIds.map(id => ({
            userId: id,
            displayName: ratingNameMap.get(id) || 'Partner',
          }));
          io.to(userRoom(pid)).emit('rating:window_open', {
            matchId: match.id,
            partnerId: partnerIds[0],
            partnerDisplayName: ratingNameMap.get(partnerIds[0]) || 'Partner',
            partners: partnersWithNames,
            roundNumber,
            durationSeconds: activeSession.config.ratingWindowSeconds,
          });
        }
      }

      // Increment rounds completed for all participants (including C)
      await sessionService.incrementRoundsCompleted(sessionId, match.participantAId);
      await sessionService.incrementRoundsCompleted(sessionId, match.participantBId);
      if (match.participantCId) {
        await sessionService.incrementRoundsCompleted(sessionId, match.participantCId);
      }
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

      // Re-issue lobby tokens to all connected participants for video mosaic
      const session = await sessionService.getSessionById(sessionId);
      if (session.lobbyRoomId) {
        const socketsInRoom = await io.in(sessionRoom(sessionId)).fetchSockets();
        const { config: appConfig } = await import('../../config');
        for (const s of socketsInRoom) {
          try {
            const uid = (s.data as any)?.userId;
            const dName = (s.data as any)?.displayName || 'User';
            if (!uid) continue;
            const lobbyToken = await videoService.issueJoinToken(uid, session.lobbyRoomId, dName);
            s.emit('lobby:token', {
              token: lobbyToken.token,
              livekitUrl: appConfig.livekit.host,
              roomId: session.lobbyRoomId,
            });
          } catch { /* skip */ }
        }
      }

      // Host-controlled: no auto-timer. Host must click "Start Round" for next round.
      logger.info({ sessionId, roundNumber }, 'Rating window closed → ROUND_TRANSITION (waiting for host)');
    } else {
      // Last round done → transition to closing lobby for goodbyes
      activeSession.status = SessionStatus.CLOSING_LOBBY;
      await sessionService.updateSessionStatus(sessionId, SessionStatus.CLOSING_LOBBY);

      io.to(sessionRoom(sessionId)).emit('session:status_changed', {
        sessionId,
        status: SessionStatus.CLOSING_LOBBY,
        currentRound: roundNumber,
      });

      // Re-issue lobby tokens so participants see each other for goodbyes
      const session = await sessionService.getSessionById(sessionId);
      if (session.lobbyRoomId) {
        const socketsInRoom = await io.in(sessionRoom(sessionId)).fetchSockets();
        const { config: appConfig } = await import('../../config');
        for (const s of socketsInRoom) {
          try {
            const uid = (s.data as any)?.userId;
            const dName = (s.data as any)?.displayName || 'User';
            if (!uid) continue;
            const lobbyToken = await videoService.issueJoinToken(uid, session.lobbyRoomId, dName);
            s.emit('lobby:token', {
              token: lobbyToken.token,
              livekitUrl: appConfig.livekit.host,
              roomId: session.lobbyRoomId,
            });
          } catch { /* skip */ }
        }
      }

      // 30-second closing lobby timer, then auto-complete
      startSegmentTimer(sessionId, 30, () => {
        completeSession(sessionId);
      });

      logger.info({ sessionId, roundNumber }, 'All rounds completed → CLOSING_LOBBY (30s goodbye period)');
    }
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Error ending rating window');
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

    // Invalidate all pending invites for this session — no one can join a completed event
    await query(
      `UPDATE invites SET status = 'expired' WHERE session_id = $1 AND status = 'pending'`,
      [sessionId]
    ).catch(err => logger.warn({ err, sessionId }, 'Failed to expire session invites (non-fatal)'));

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

    // Fire-and-forget: clean up LiveKit rooms (lobby + all match rooms)
    cleanupLiveKitRooms(sessionId).catch(roomErr => {
      logger.warn({ err: roomErr, sessionId }, 'Error cleaning up LiveKit rooms (non-fatal)');
    });
  } catch (err) {
    logger.error({ err, sessionId }, 'Error completing session');
  } finally {
    // Always clean up to prevent memory leak, even on error
    activeSessions.delete(sessionId);
    cleanupChatMessages(sessionId);
  }
}

// ─── Clean Up LiveKit Rooms ──────────────────────────────────────────────────

async function cleanupLiveKitRooms(sessionId: string): Promise<void> {
  // Close lobby room
  try {
    await videoService.closeLobbyRoom(sessionId);
  } catch { /* may not exist */ }

  // Close all match rooms for this session
  const matches = await query<{ id: string; round_number: number }>(
    `SELECT id, round_number FROM matches WHERE session_id = $1 AND room_id IS NOT NULL`,
    [sessionId]
  );

  // Batch close in parallel (max 20 concurrent to avoid overwhelming LiveKit)
  const BATCH_SIZE = 20;
  for (let i = 0; i < matches.rows.length; i += BATCH_SIZE) {
    const batch = matches.rows.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(m =>
        videoService.closeMatchRoom(sessionId, m.round_number, m.id.slice(0, 8))
          .catch(() => { /* room may already be closed */ })
      )
    );
  }

  logger.info({ sessionId, roomsClosed: matches.rows.length + 1 }, 'LiveKit rooms cleaned up');
}

// ─── Send Recap Emails ──────────────────────────────────────────────────────

async function sendRecapEmails(sessionId: string): Promise<void> {
  const { config: appConfig } = await import('../../config');

  const sessionResult = await query<{ title: string; hostUserId: string }>(
    `SELECT title, host_user_id AS "hostUserId" FROM sessions WHERE id = $1`, [sessionId]
  );
  if (sessionResult.rows.length === 0) return;
  const sessionTitle = sessionResult.rows[0].title;
  const hostUserId = sessionResult.rows[0].hostUserId;

  // Exclude host — they manage the event from the lobby, so their stats would be empty
  const participantsResult = await query<{ email: string; displayName: string; userId: string }>(
    `SELECT u.email, u.display_name AS "displayName", u.id AS "userId"
     FROM session_participants sp
     JOIN users u ON u.id = sp.user_id
     WHERE sp.session_id = $1 AND sp.status != 'removed'
       AND sp.user_id != $2`,
    [sessionId, hostUserId]
  );

  if (participantsResult.rows.length === 0) return;

  // Batch query: unique partners met per user (handles pairs + trios correctly)
  const peopleMetBatch = await query<{ userId: string; count: string }>(
    `SELECT sub.user_id AS "userId", COUNT(DISTINCT sub.partner)::text AS count
     FROM (
       SELECT m.participant_a_id AS user_id,
              unnest(ARRAY[m.participant_b_id, m.participant_c_id]) AS partner
       FROM matches m WHERE m.session_id = $1 AND m.status = 'completed'
       UNION ALL
       SELECT m.participant_b_id AS user_id,
              unnest(ARRAY[m.participant_a_id, m.participant_c_id]) AS partner
       FROM matches m WHERE m.session_id = $1 AND m.status = 'completed'
       UNION ALL
       SELECT m.participant_c_id AS user_id,
              unnest(ARRAY[m.participant_a_id, m.participant_b_id]) AS partner
       FROM matches m WHERE m.session_id = $1 AND m.status = 'completed'
         AND m.participant_c_id IS NOT NULL
     ) sub
     WHERE sub.partner IS NOT NULL AND sub.user_id IS NOT NULL
     GROUP BY sub.user_id`,
    [sessionId]
  );
  const peopleMetMap = new Map(peopleMetBatch.rows.map(r => [r.userId, parseInt(r.count, 10)]));

  // Batch query: avg rating per user
  const avgRatingBatch = await query<{ userId: string; avg: string }>(
    `SELECT r.from_user_id AS "userId", COALESCE(AVG(r.quality_score), 0)::text AS avg
     FROM ratings r
     JOIN matches m ON m.id = r.match_id
     WHERE m.session_id = $1
     GROUP BY r.from_user_id`,
    [sessionId]
  );
  const avgRatingMap = new Map(avgRatingBatch.rows.map(r => [r.userId, parseFloat(r.avg)]));

  // Batch query: mutual connections per user
  const mutualBatch = await query<{ userId: string; count: string }>(
    `SELECT sub.user_id AS "userId", COUNT(*)::text AS count
     FROM (
       SELECT user_a_id AS user_id FROM encounter_history
       WHERE mutual_meet_again = TRUE AND last_session_id = $1
       UNION ALL
       SELECT user_b_id AS user_id FROM encounter_history
       WHERE mutual_meet_again = TRUE AND last_session_id = $1
     ) sub
     GROUP BY sub.user_id`,
    [sessionId]
  );
  const mutualMap = new Map(mutualBatch.rows.map(r => [r.userId, parseInt(r.count, 10)]));

  for (const p of participantsResult.rows) {
    try {
      await emailService.sendSessionRecapEmail(p.email, p.displayName || 'there', {
        sessionTitle,
        peopleMet: peopleMetMap.get(p.userId) || 0,
        mutualConnections: mutualMap.get(p.userId) || 0,
        avgRating: avgRatingMap.get(p.userId) || 0,
        recapUrl: `${appConfig.clientUrl}/sessions/${sessionId}/recap`,
      });
    } catch (err) {
      logger.warn({ err, userId: p.userId }, 'Failed to send recap email to participant');
    }
  }

  logger.info({ sessionId, participantCount: participantsResult.rows.length }, 'Recap emails dispatched');

  // ─── Host Event Recap ─────────────────────────────────────────────────────
  try {
    const hostResult = await query<{ email: string; displayName: string }>(
      `SELECT email, display_name AS "displayName" FROM users WHERE id = $1`, [hostUserId]
    );
    if (hostResult.rows.length > 0) {
      const host = hostResult.rows[0];

      const totalRoundsResult = await query<{ max: string }>(
        `SELECT COALESCE(MAX(round_number), 0)::text AS max FROM matches WHERE session_id = $1`, [sessionId]
      );
      const totalMatchesResult = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM matches WHERE session_id = $1 AND status = 'completed'`, [sessionId]
      );
      const avgEventRatingResult = await query<{ avg: string }>(
        `SELECT COALESCE(AVG(r.quality_score), 0)::text AS avg FROM ratings r JOIN matches m ON m.id = r.match_id WHERE m.session_id = $1`, [sessionId]
      );
      const totalMutualResult = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM encounter_history WHERE mutual_meet_again = TRUE AND last_session_id = $1`, [sessionId]
      );

      await emailService.sendHostRecapEmail(host.email, host.displayName || 'Host', {
        sessionTitle,
        totalParticipants: participantsResult.rows.length,
        totalRounds: parseInt(totalRoundsResult.rows[0]?.max || '0', 10),
        totalMatches: parseInt(totalMatchesResult.rows[0]?.count || '0', 10),
        avgEventRating: parseFloat(avgEventRatingResult.rows[0]?.avg || '0'),
        mutualConnectionsCount: parseInt(totalMutualResult.rows[0]?.count || '0', 10),
        recapUrl: `${appConfig.clientUrl}/sessions/${sessionId}/recap`,
      });

      logger.info({ sessionId, hostUserId }, 'Host recap email dispatched');
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to send host recap email');
  }
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
    pendingRoundNumber: null,
    manuallyLeftRound: new Set(),
  };

  activeSessions.set(sessionId, activeSession);

  if (io) {
    io.to(sessionRoom(sessionId)).emit('session:status_changed', {
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

// ─── Chat ──────────────────────────────────────────────────────────────────

async function handleChatSend(
  socket: Socket,
  data: { sessionId: string; message: string; scope: 'lobby' | 'room' }
): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) {
      socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
      return;
    }

    const { sessionId, message, scope } = data;

    // Validate message
    if (!message || typeof message !== 'string' || message.trim().length === 0) return;
    const trimmed = message.trim().slice(0, 500); // Cap at 500 chars

    // Verify user is in the session room
    const rooms = socket.rooms;
    if (!rooms.has(sessionRoom(sessionId))) {
      socket.emit('error', { code: 'NOT_IN_SESSION', message: 'You are not in this session' });
      return;
    }

    // Determine if sender is host/co-host
    const session = await sessionService.getSessionById(sessionId).catch(() => null);
    const isHost = session?.hostUserId === userId;
    const cohostResult = isHost ? { rows: [] } : await query<{ user_id: string }>(
      `SELECT user_id FROM session_cohosts WHERE session_id = $1 AND user_id = $2`, [sessionId, userId]
    ).catch(() => ({ rows: [] }));
    const isCohost = cohostResult.rows.length > 0;

    // In lobby phase, only allow chat when host is present (host/co-hosts always allowed)
    const activeSession = activeSessions.get(sessionId);
    if (!isHost && !isCohost && scope === 'lobby') {
      const hostPresent = activeSession?.presenceMap.has(session?.hostUserId || '');
      if (!hostPresent) {
        socket.emit('error', { code: 'CHAT_DISABLED', message: 'Chat is available once the host joins' });
        return;
      }
    }

    const displayName = (socket.data as any)?.displayName || 'Unknown';
    const chatMsg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId,
      displayName,
      message: trimmed,
      timestamp: new Date().toISOString(),
      scope,
      isHost,
    };

    // Store message in memory
    if (!chatMessages.has(sessionId)) chatMessages.set(sessionId, []);
    const msgs = chatMessages.get(sessionId)!;
    msgs.push(chatMsg);
    // Keep only the last MAX_CHAT_MESSAGES
    if (msgs.length > MAX_CHAT_MESSAGES) msgs.splice(0, msgs.length - MAX_CHAT_MESSAGES);

    if (scope === 'lobby') {
      // Broadcast to everyone in the session
      io.to(sessionRoom(sessionId)).emit('chat:message', chatMsg);
    } else {
      // Room scope: find the user's current breakout room match and emit only to those users
      const activeSession = activeSessions.get(sessionId);
      if (!activeSession || activeSession.status !== SessionStatus.ROUND_ACTIVE) {
        // Not in a round, fall back to lobby broadcast
        chatMsg.scope = 'lobby';
        io.to(sessionRoom(sessionId)).emit('chat:message', chatMsg);
        return;
      }

      const matches = await matchingService.getMatchesByRound(sessionId, activeSession.currentRound);
      const userMatch = matches.find(
        m => (m.participantAId === userId || m.participantBId === userId || m.participantCId === userId) && m.status === 'active'
      );

      if (userMatch) {
        chatMsg.roomId = userMatch.roomId || undefined;
        // Emit to all participants in this match
        const participantIds = [userMatch.participantAId, userMatch.participantBId];
        if (userMatch.participantCId) participantIds.push(userMatch.participantCId);
        for (const pid of participantIds) {
          io.to(userRoom(pid)).emit('chat:message', chatMsg);
        }
      } else {
        // Not matched, send only to self
        socket.emit('chat:message', chatMsg);
      }
    }
  } catch (err: any) {
    logger.error({ err }, 'Error handling chat message');
    socket.emit('error', { code: 'CHAT_FAILED', message: 'Failed to send message' });
  }
}

// ─── Reactions ──────────────────────────────────────────────────────────────

const VALID_REACTIONS = ['raise_hand', 'heart', 'clap', 'thumbs_up'];

async function handleReactionSend(
  socket: Socket,
  data: { sessionId: string; type: string }
): Promise<void> {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) return;

    const { sessionId, type } = data;
    if (!VALID_REACTIONS.includes(type)) return;

    if (!socket.rooms.has(sessionRoom(sessionId))) return;

    // In lobby phase, block reactions when host is not present (host/co-hosts always allowed)
    const session = await sessionService.getSessionById(sessionId).catch(() => null);
    const isHost = session?.hostUserId === userId;
    const cohostCheck = isHost ? { rows: [] } : await query<{ user_id: string }>(
      `SELECT user_id FROM session_cohosts WHERE session_id = $1 AND user_id = $2`, [sessionId, userId]
    ).catch(() => ({ rows: [] }));
    const isCohost = cohostCheck.rows.length > 0;
    if (!isHost && !isCohost) {
      const activeSession = activeSessions.get(sessionId);
      const hostPresent = activeSession?.presenceMap.has(session?.hostUserId || '');
      if (!hostPresent && (!activeSession || activeSession.status === SessionStatus.LOBBY_OPEN || activeSession.status === SessionStatus.SCHEDULED)) {
        return; // Silently ignore reactions when host is absent in lobby
      }
    }

    const displayName = (socket.data as any)?.displayName || 'User';

    io.to(sessionRoom(sessionId)).emit('reaction:received', {
      userId,
      displayName,
      type,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'Error handling reaction');
  }
}

// ─── Co-Host Management ─────────────────────────────────────────────────────

async function handleAssignCohost(
  socket: Socket,
  data: { sessionId: string; userId: string; role: 'co_host' | 'moderator' }
): Promise<void> {
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
}

async function handleRemoveCohost(
  socket: Socket,
  data: { sessionId: string; userId: string }
): Promise<void> {
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
}

// Clean up chat messages when session completes
function cleanupChatMessages(sessionId: string): void {
  chatMessages.delete(sessionId);
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
