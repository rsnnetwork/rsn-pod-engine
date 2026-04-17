// ─── Participant Flow Handlers ──────────────────────────────────────────────
// Extracted from orchestration.service.ts — all participant-facing socket handlers:
// join, leave, heartbeat, ready, rating, leave-conversation, disconnect.
//
// Includes critical fixes:
//   FIX 3C: Disconnect timeout vs reconnect race (reconnectedAt guard)
//   FIX 5E: Heartbeat stale detection (startHeartbeatStaleDetection)

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { SessionStatus, ParticipantStatus, UserRole } from '@rsn/shared';
import {
  ActiveSession, activeSessions, disconnectTimeouts, withSessionGuard,
  sessionRoom, userRoom, getUserIdFromSocket,
  chatMessages,
} from '../state/session-state';
import * as sessionService from '../../session/session.service';
import * as matchingService from '../../matching/matching.service';
import * as ratingService from '../../rating/rating.service';
import * as videoService from '../../video/video.service';
import { clearRoomTimers } from './host-actions';

// ─── Cross-module references (wired in Task 7) ────────────────────────────
// TODO: Import these from matching-flow.ts once it's created
// For now, declare as module-level variables that can be injected
let _emitHostDashboard: ((sessionId: string) => Promise<void>) | null = null;
let _endRatingWindow: ((sessionId: string, roundNumber: number) => Promise<void>) | null = null;

/**
 * Inject cross-module dependencies that live in other handler files.
 * Called during orchestration entry point wiring (Task 7).
 */
export function injectDependencies(deps: {
  emitHostDashboard: (sessionId: string) => Promise<void>;
  endRatingWindow: (sessionId: string, roundNumber: number) => Promise<void>;
}): void {
  _emitHostDashboard = deps.emitHostDashboard;
  _endRatingWindow = deps.endRatingWindow;
}

function emitHostDashboard(sessionId: string): void {
  if (_emitHostDashboard) {
    _emitHostDashboard(sessionId).catch(err =>
      logger.warn({ err, sessionId }, 'Failed to emit host dashboard from participant-flow')
    );
  } else {
    logger.warn({ sessionId }, 'emitHostDashboard not injected yet — skipping');
  }
}

function endRatingWindow(sessionId: string, roundNumber: number): void {
  if (_endRatingWindow) {
    _endRatingWindow(sessionId, roundNumber).catch(err =>
      logger.warn({ err, sessionId }, 'Failed to end rating window from participant-flow')
    );
  } else {
    logger.warn({ sessionId }, 'endRatingWindow not injected yet — skipping');
  }
}

// ─── Join Session ──────────────────────────────────────────────────────────

export async function handleJoinSession(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    try {
      const userId = getUserIdFromSocket(socket);
      if (!userId) {
        socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
        return;
      }

      // Refresh display name from DB — JWT may be stale if user updated their profile
      const freshNameResult = await query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id = $1', [userId]
      );
      if (freshNameResult.rows[0]?.display_name) {
        (socket.data as any).displayName = freshNameResult.rows[0].display_name;
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
      let activeSession = activeSessions.get(data.sessionId);
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

      // ── On-the-fly session recovery ──
      // If activeSession is missing (server restarted/deployed) but session is active in DB,
      // recreate the in-memory entry so all handlers work immediately
      if (!activeSession) {
        const activeStatuses = ['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby'];
        if (activeStatuses.includes(session.status)) {
          const config = typeof session.config === 'string' ? JSON.parse(session.config as unknown as string) : session.config || {};
          activeSession = {
            sessionId: data.sessionId,
            hostUserId: session.hostUserId,
            config,
            currentRound: (session as any).currentRound || 0,
            status: session.status as SessionStatus,
            timer: null,
            timerSyncInterval: null,
            timerEndsAt: null,
            isPaused: false,
            pausedTimeRemaining: null,
            pendingRoundNumber: null,
            presenceMap: new Map(),
            manuallyLeftRound: new Set(),
          };
          activeSessions.set(data.sessionId, activeSession);
          logger.info({ sessionId: data.sessionId, status: session.status }, 'On-the-fly session recovery — created ActiveSession from DB');
        }
      }

      // Cancel any pending disconnect timeout for this user (they reconnected)
      const reconnectKey = `${data.sessionId}:${userId}`;
      if (disconnectTimeouts.has(reconnectKey)) {
        clearTimeout(disconnectTimeouts.get(reconnectKey)!);
        disconnectTimeouts.delete(reconnectKey);
        logger.info({ sessionId: data.sessionId, userId }, 'Cancelled disconnect timeout — user reconnected');
      }

      // Join socket room
      socket.join(sessionRoom(data.sessionId));
      socket.join(userRoom(userId));

      // Update presence — FIX 3C: set reconnectedAt so disconnect timeout can detect reconnect
      if (activeSession) {
        activeSession.presenceMap.set(userId, {
          lastHeartbeat: new Date(),
          socketId: socket.id,
          reconnectedAt: new Date(),
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
          // Bye participants are those in_lobby during an active round (not in any active match)
          const matchedUserIds = new Set<string>();
          for (const m of matches) {
            matchedUserIds.add(m.participantAId);
            matchedUserIds.add(m.participantBId);
            if (m.participantCId) matchedUserIds.add(m.participantCId);
          }
          const byeResult = await query<{ user_id: string; display_name: string }>(
            `SELECT sp.user_id, u.display_name FROM session_participants sp JOIN users u ON u.id = sp.user_id
             WHERE sp.session_id = $1 AND sp.status IN ('in_lobby', 'registered', 'checked_in') AND sp.user_id != $2`,
            [data.sessionId, session.hostUserId]
          );
          // Filter to only those not in any match
          const byeParticipants = byeResult.rows
            .filter(r => !matchedUserIds.has(r.user_id))
            .map(r => ({ userId: r.user_id, displayName: r.display_name }));
          socket.emit('host:round_dashboard', {
            roundNumber: activeSession.currentRound,
            rooms: rooms.filter((r: any) => r.status !== 'cancelled'),
            byeParticipants,
            timerSecondsRemaining: 0,
            reassignmentInProgress: false,
          });
        } catch (dashErr) {
          logger.warn({ err: dashErr }, 'Failed to re-send host round dashboard on reconnect');
        }
      }

      // If in lobby/transition phase and session has a lobby room, send lobby token for video mosaic
      const lobbyPhases = [SessionStatus.LOBBY_OPEN, SessionStatus.ROUND_ACTIVE, SessionStatus.ROUND_TRANSITION, SessionStatus.ROUND_RATING, SessionStatus.CLOSING_LOBBY];
      const currentStatus = activeSession?.status || session.status;
      if (session.lobbyRoomId && lobbyPhases.includes(currentStatus as SessionStatus)) {
        try {
          const displayName = (socket.data as any)?.displayName || 'User';
          const lobbyToken = await videoService.issueJoinToken(userId, session.lobbyRoomId, displayName);
          const { config: appConfig } = await import('../../../config');
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

      // Clear manuallyLeftRound on rejoin — user chose to come back, let them participate
      if (activeSession && activeSession.manuallyLeftRound.has(userId)) {
        activeSession.manuallyLeftRound.delete(userId);
      }

      // If session is mid-round, restore user's match assignment
      if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE) {
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

          // Generate inline token for instant reconnection (FIX 15B)
          const { config: reconnectConfig } = await import('../../../config');
          let reconnectToken: string | null = null;
          try {
            const userDisplayName = (socket.data as any)?.displayName || 'User';
            const vt = await videoService.issueJoinToken(userId, userMatch.roomId || '', userDisplayName);
            reconnectToken = vt.token;
          } catch { /* non-fatal — client falls back to API fetch */ }

          socket.emit('match:assigned', {
            matchId: userMatch.id,
            partnerId: partners[0].userId,
            partnerDisplayName: partners[0].displayName,
            partners,
            roomId: userMatch.roomId || '',
            roundNumber: activeSession.currentRound,
            token: reconnectToken,
            livekitUrl: reconnectConfig.livekit.host,
          });
        }
      }

      // If session is in or recently past rating phase, re-send rating window
      // so reconnected users who missed it can still rate their conversation.
      // Also covers round_transition — user may have disconnected during rating.
      const ratingReplayStatuses = [SessionStatus.ROUND_RATING, SessionStatus.ROUND_TRANSITION, SessionStatus.CLOSING_LOBBY];
      if (activeSession && ratingReplayStatuses.includes(activeSession.status)) {
        const matches = await matchingService.getMatchesByRound(
          data.sessionId, activeSession.currentRound
        );
        const userMatch = matches.find(
          m => (m.participantAId === userId || m.participantBId === userId || m.participantCId === userId) && m.status === 'completed'
        );
        if (userMatch) {
          // Check if user already rated this match — don't re-send if they did
          const existingRating = await query<{ id: string }>(
            `SELECT id FROM ratings WHERE match_id = $1 AND from_user_id = $2 LIMIT 1`,
            [userMatch.id, userId]
          );
          if (existingRating.rows.length === 0) {
            const participantIds = [userMatch.participantAId, userMatch.participantBId];
            if (userMatch.participantCId) participantIds.push(userMatch.participantCId);
            const partnerIds = participantIds.filter(id => id !== userId);

            const partnerNameResult = await query<{ id: string; displayName: string }>(
              `SELECT id, display_name AS "displayName" FROM users WHERE id = ANY($1)`, [partnerIds]
            );
            const nameMap = new Map(partnerNameResult.rows.map(r => [r.id, r.displayName || 'Partner']));
            const partnersWithNames = partnerIds.map(id => ({ userId: id, displayName: nameMap.get(id) || 'Partner' }));

            // Give a short window to rate (15s or remaining time, whichever is more)
            const remainingSeconds = activeSession.timerEndsAt
              ? Math.max(15, Math.ceil((activeSession.timerEndsAt.getTime() - Date.now()) / 1000))
              : 15;
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
  });
}

// ─── Leave Session ──────────────────────────────────────────────────────────

export async function handleLeaveSession(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
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
  });
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────
// UNGUARDED: heartbeat is a read-only timestamp update, no race risk

export function handleHeartbeat(
  socket: Socket,
  data: { sessionId: string }
): void {
  const userId = getUserIdFromSocket(socket);
  if (!userId) return;

  const activeSession = activeSessions.get(data.sessionId);
  if (activeSession) {
    // Preserve reconnectedAt — overwriting it causes the disconnect timeout
    // to miss the reconnection and falsely mark the user as no_show (FIX 15A)
    const existing = activeSession.presenceMap.get(userId);
    activeSession.presenceMap.set(userId, {
      lastHeartbeat: new Date(),
      socketId: socket.id,
      reconnectedAt: existing?.reconnectedAt,
    });
  }
}

// ─── Ready ──────────────────────────────────────────────────────────────────
// UNGUARDED: simple flag set, no race risk

export async function handleReady(
  _io: SocketServer,
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

export async function handleRatingSubmit(
  _io: SocketServer,
  socket: Socket,
  data: { matchId: string; qualityScore: number; meetAgain: boolean; feedback?: string; sessionId?: string }
): Promise<void> {
  // Determine sessionId for the guard — find from active sessions if not provided
  let sessionId = data.sessionId;
  if (!sessionId) {
    const userId = getUserIdFromSocket(socket);
    if (userId) {
      for (const [sid, s] of activeSessions) {
        if (s.presenceMap.has(userId) && s.status === SessionStatus.ROUND_RATING) {
          sessionId = sid;
          break;
        }
      }
    }
  }

  const guardFn = async () => {
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
      await checkAllRatingsCompleteByUserId(userId);
    } catch (err: any) {
      socket.emit('error', { code: 'RATING_FAILED', message: err.message });
    }
  };

  if (sessionId) {
    return withSessionGuard(sessionId, guardFn);
  } else {
    // Fallback: run without guard if we can't determine sessionId
    await guardFn();
  }
}

/**
 * Called from the REST ratings endpoint after a rating is submitted.
 * Triggers the early-exit check to end the rating window if all participants have rated.
 */
export async function notifyRatingSubmitted(userId: string): Promise<void> {
  await checkAllRatingsCompleteByUserId(userId);
}

/**
 * After each rating submission, check if all participants in the current round
 * have finished rating. If so, cancel the rating window timer and advance immediately.
 */
async function checkAllRatingsCompleteByUserId(userId: string): Promise<void> {
  try {
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

      // Cancel the existing round timer
      if (activeSession.timer) {
        clearTimeout(activeSession.timer);
        activeSession.timer = null;
        activeSession.timerEndsAt = null;
      }

      // 3-second grace period: allow in-flight rating submissions to land
      // before advancing. This prevents race conditions where the last
      // rating triggers early-exit while another user is mid-submission.
      activeSession.timer = setTimeout(() => {
        activeSession.timer = null;
        endRatingWindow(sessionId, roundNumber);
      }, 3000);
    }
  } catch (err) {
    logger.error({ err }, 'Error in checkAllRatingsComplete');
  }
}

// ─── Leave Conversation (return to lobby, stay in event) ────────────────────

export async function handleLeaveConversation(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    try {
      const userId = getUserIdFromSocket(socket);
      if (!userId) return;

      const { sessionId } = data;
      const activeSession = activeSessions.get(sessionId);
      if (!activeSession) return;

      // Allow leaving during ROUND_ACTIVE (normal rounds) or LOBBY_OPEN (host-created rooms)
      if (activeSession.status !== SessionStatus.ROUND_ACTIVE && activeSession.status !== SessionStatus.LOBBY_OPEN) return;

      // Track that this user manually left — prevents re-entry via reconnect
      if (activeSession.status === SessionStatus.ROUND_ACTIVE) {
        activeSession.manuallyLeftRound.add(userId);
      }

      // Find the user's active match (check all rounds — host-created rooms may be round 0)
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

      // Clear any per-room timer/sync for this match (prevents ghost timers)
      clearRoomTimers(userMatch.id);

      // Move user back to lobby status
      await sessionService.updateParticipantStatus(sessionId, userId, ParticipantStatus.IN_LOBBY);

      // Collect partner IDs and names for rating screen
      const partnerIds = [userMatch.participantAId, userMatch.participantBId, userMatch.participantCId]
        .filter((id): id is string => !!id && id !== userId);

      // Fetch partner display names for rating
      const partnerNameRes = await query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM users WHERE id = ANY($1)`,
        [partnerIds]
      );
      const partnerNameMap = new Map(partnerNameRes.rows.map(r => [r.id, r.display_name || 'Partner']));
      const partnersWithNames = partnerIds.map(pid => ({
        userId: pid,
        displayName: partnerNameMap.get(pid) || 'Partner',
      }));

      // Show rating screen before returning to lobby (20s window)
      socket.emit('rating:window_open', {
        matchId: userMatch.id,
        partnerId: partnerIds[0],
        partnerDisplayName: partnerNameMap.get(partnerIds[0]) || 'Partner',
        partners: partnersWithNames,
        durationSeconds: 20,
        earlyLeave: true,
      });

      for (const partnerId of partnerIds) {
        io.to(userRoom(partnerId)).emit('match:partner_disconnected', { matchId: userMatch.id });
      }

      // Re-issue lobby token so user can rejoin lobby video
      const session = await sessionService.getSessionById(sessionId);
      if (session.lobbyRoomId) {
        try {
          const { config: appConfig } = await import('../../../config');
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

      // ─── 2.3: Auto-reassign solo partner after 5s, or return to lobby ──
      if (partnerIds.length === 1) {
        const soloPartnerId = partnerIds[0];

        // Change match to no_show so reassign logic can find it
        await query(
          `UPDATE matches SET status = 'no_show' WHERE id = $1`,
          [userMatch.id]
        );

        setTimeout(async () => {
          try {
            const currentSession = activeSessions.get(sessionId);
            if (!currentSession) return;
            // Allow ROUND_ACTIVE (normal rounds) and LOBBY_OPEN (host-created rooms)
            if (currentSession.status !== SessionStatus.ROUND_ACTIVE && currentSession.status !== SessionStatus.LOBBY_OPEN) return;
            if (currentSession.currentRound !== activeSession.currentRound) return;

            // Check if already reassigned by host or other flow
            const freshMatch = (await matchingService.getMatchesByRound(sessionId, currentSession.currentRound))
              .find(m => m.id === userMatch.id);
            if (!freshMatch || freshMatch.status !== 'no_show') return;

            // Try to find another isolated participant for auto-reassign
            const noShowMatches = await query<{ id: string; participant_a_id: string; participant_b_id: string }>(
              `SELECT id, participant_a_id, participant_b_id FROM matches
               WHERE session_id = $1 AND round_number = $2 AND status = 'no_show' AND id != $3`,
              [sessionId, currentSession.currentRound, userMatch.id]
            );

            let reassigned = false;
            for (const nsMatch of noShowMatches.rows) {
              const candidateA = nsMatch.participant_a_id;
              const candidateB = nsMatch.participant_b_id;
              const candidatePresent = currentSession.presenceMap.has(candidateA) ? candidateA
                : currentSession.presenceMap.has(candidateB) ? candidateB : null;

              if (candidatePresent && candidatePresent !== soloPartnerId) {
                // Found another isolated participant — pair them
                const reassignSlug = `leave-reassign-${Date.now()}`;
                const newRoomId = `session-${sessionId}-round-${currentSession.currentRound}-${reassignSlug}`;
                try {
                  await videoService.createMatchRoom(sessionId, currentSession.currentRound, reassignSlug);
                } catch { /* room may already exist */ }

                const { v4: uuid } = await import('uuid');
                const matchId = uuid();
                const normA = soloPartnerId < candidatePresent ? soloPartnerId : candidatePresent;
                const normB = soloPartnerId < candidatePresent ? candidatePresent : soloPartnerId;
                try {
                  await query(
                    `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, room_id, status, started_at)
                     VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())`,
                    [matchId, sessionId, currentSession.currentRound, normA, normB, newRoomId]
                  );
                } catch (insertErr: any) {
                  if (insertErr.message?.includes('PARTICIPANT_ALREADY_MATCHED') || insertErr.code === '23505') {
                    logger.warn({ soloPartnerId, candidatePresent }, 'Auto-reassign after leave skipped: already matched');
                    continue;
                  }
                  throw insertErr;
                }

                // Fetch display names + generate tokens
                const nameRes = await query<{ id: string; display_name: string }>(
                  `SELECT id, display_name FROM users WHERE id = ANY($1)`,
                  [[soloPartnerId, candidatePresent]]
                );
                const names = new Map(nameRes.rows.map(r => [r.id, r.display_name || 'User']));

                const { config: reassignConfig } = await import('../../../config');
                let soloTk: string | null = null;
                let candidateTk: string | null = null;
                try {
                  const [sVt, cVt] = await Promise.all([
                    videoService.issueJoinToken(soloPartnerId, newRoomId, names.get(soloPartnerId) || 'User'),
                    videoService.issueJoinToken(candidatePresent, newRoomId, names.get(candidatePresent) || 'User'),
                  ]);
                  soloTk = sVt.token;
                  candidateTk = cVt.token;
                } catch { /* non-fatal */ }

                io.to(userRoom(soloPartnerId)).emit('match:reassigned', {
                  matchId, newPartnerId: candidatePresent,
                  partnerDisplayName: names.get(candidatePresent),
                  roomId: newRoomId, roundNumber: currentSession.currentRound,
                  token: soloTk, livekitUrl: reassignConfig.livekit.host,
                });
                io.to(userRoom(candidatePresent)).emit('match:reassigned', {
                  matchId, newPartnerId: soloPartnerId,
                  partnerDisplayName: names.get(soloPartnerId),
                  roomId: newRoomId, roundNumber: currentSession.currentRound,
                  token: candidateTk, livekitUrl: reassignConfig.livekit.host,
                });

                logger.info({ sessionId, soloPartnerId, candidatePresent, matchId },
                  'Auto-reassigned after early leave');
                reassigned = true;
                break;
              }
            }

            if (!reassigned) {
              // No partner available — show rating for departed partner, then return to lobby
              await sessionService.updateParticipantStatus(sessionId, soloPartnerId, ParticipantStatus.IN_LOBBY);

              // Get the departed user's display name for the rating form
              const departedNameRes = await query<{ display_name: string }>(
                `SELECT display_name FROM users WHERE id = $1`, [userId]
              );
              const departedName = departedNameRes.rows[0]?.display_name || 'Partner';

              io.to(userRoom(soloPartnerId)).emit('rating:window_open', {
                matchId: userMatch.id,
                partnerId: userId,
                partnerDisplayName: departedName,
                partners: [{ userId, displayName: departedName }],
                durationSeconds: 20,
                earlyLeave: true,
              });

              // Re-issue lobby token
              if (session.lobbyRoomId) {
                const socketsInRoom = await io.in(userRoom(soloPartnerId)).fetchSockets();
                const { config: appConfig } = await import('../../../config');
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

              logger.info({ sessionId, soloPartnerId, matchId: userMatch.id }, 'No reassign available — showing rating then lobby');
            }
          } catch (err) {
            logger.error({ err }, 'Error in auto-reassign after early leave');
          }
        }, 5000);
      }
    } catch (err) {
      logger.error({ err }, 'Error in handleLeaveConversation');
    }
  });
}

// ─── Disconnect ─────────────────────────────────────────────────────────────

export async function handleDisconnect(
  io: SocketServer,
  socket: Socket
): Promise<void> {
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

            // Cancel any existing disconnect timeout for this user
            const timeoutKey = `${sessionId}:${userId}`;
            if (disconnectTimeouts.has(timeoutKey)) {
              clearTimeout(disconnectTimeouts.get(timeoutKey)!);
              disconnectTimeouts.delete(timeoutKey);
            }

            // FIX 3C: Record disconnectedAt so the timeout callback can detect if user reconnected
            const disconnectedAt = new Date();

            // Step 2: After 15 seconds, try auto-reassignment or fall back to bye
            const timeoutId = setTimeout(async () => {
              disconnectTimeouts.delete(timeoutKey);
              try {
                const currentSession = activeSessions.get(sessionId);
                if (!currentSession || currentSession.currentRound !== disconnectRound) return;

                // FIX 3C: Check if user reconnected during the timeout window
                const presence = currentSession.presenceMap.get(userId);
                if (presence && presence.reconnectedAt && presence.reconnectedAt > disconnectedAt) {
                  logger.info({ userId, sessionId }, 'User reconnected during timeout window — skipping no-show');
                  return; // Skip all no-show logic
                }

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

                    // Generate inline tokens for instant breakout transition
                    const { config: reassignConfig } = await import('../../../config');
                    let partnerTk: string | null = null;
                    let candidateTk: string | null = null;
                    try {
                      const [pVt, cVt] = await Promise.all([
                        videoService.issueJoinToken(partnerId, roomId, names.get(partnerId) || 'User'),
                        videoService.issueJoinToken(candidatePresent, roomId, names.get(candidatePresent) || 'User'),
                      ]);
                      partnerTk = pVt.token;
                      candidateTk = cVt.token;
                    } catch { /* non-fatal — client retries via API */ }

                    io.to(userRoom(partnerId)).emit('match:reassigned', {
                      matchId, newPartnerId: candidatePresent,
                      partnerDisplayName: names.get(candidatePresent),
                      roomId, roundNumber: disconnectRound,
                      token: partnerTk, livekitUrl: reassignConfig.livekit.host,
                    });
                    io.to(userRoom(candidatePresent)).emit('match:reassigned', {
                      matchId, newPartnerId: partnerId,
                      partnerDisplayName: names.get(partnerId),
                      roomId, roundNumber: disconnectRound,
                      token: candidateTk, livekitUrl: reassignConfig.livekit.host,
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
            disconnectTimeouts.set(timeoutKey, timeoutId);
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

// ─── FIX 5E: Heartbeat Stale Detection ─────────────────────────────────────

const STALE_HEARTBEAT_MS = 90_000; // 6 missed heartbeats at 15s interval — generous tolerance
const STALE_CHECK_INTERVAL_MS = 30_000;

export function startHeartbeatStaleDetection(io: SocketServer): void {
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions) {
      for (const [userId, presence] of session.presenceMap) {
        if (now - presence.lastHeartbeat.getTime() > STALE_HEARTBEAT_MS) {
          logger.warn({ userId, sessionId }, 'Stale heartbeat — triggering disconnect flow');
          session.presenceMap.delete(userId);
          io.to(sessionRoom(sessionId)).emit('participant:left', { userId });
        }
      }
    }
  }, STALE_CHECK_INTERVAL_MS);
}
