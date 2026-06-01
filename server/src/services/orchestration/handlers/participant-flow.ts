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
import { SessionStatus, ParticipantStatus, UserRole, resolveDisplayName, placeholderName } from '@rsn/shared';
import {
  ActiveSession, activeSessions, disconnectTimeouts, withSessionGuard,
  sessionRoom, userRoom, getUserIdFromSocket,
  chatMessages, emitRatingWindowOnce,
} from '../state/session-state';
import * as sessionService from '../../session/session.service';
import * as matchingService from '../../matching/matching.service';
import * as ratingService from '../../rating/rating.service';
import * as videoService from '../../video/video.service';
import { clearRoomTimers } from './host-actions';
import { findIsolatedParticipants } from '../../matching/isolated-participants';
// Phase 2B (5 May spec) — chokepoint helpers for presence + state writes.
import { transitionParticipant, setPresence, ParticipantState } from '../state/participant-state-machine';

// Phase 2.5D (5 May spec) — future-only repair throttle keys per session.
// One repair per 5 seconds per session prevents storms when many users
// join in quick succession (we only need ONE recompute that includes them all).
const _futureRepairThrottle = new Map<string, number>();
const FUTURE_REPAIR_THROTTLE_MS = 5_000;

async function maybeRepairFutureRounds(
  io: SocketServer,
  sessionId: string,
  reason: 'late_joiner' | 'left',
): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;
  // Only repair if the event has actually started rounds (currentRound >= 1).
  // Pre-event joiners get covered by the regular pre-plan since the plan
  // hasn't been generated yet.
  if (activeSession.currentRound < 1) return;

  const now = Date.now();
  const last = _futureRepairThrottle.get(sessionId) || 0;
  if (now - last < FUTURE_REPAIR_THROTTLE_MS) {
    logger.debug({ sessionId, reason }, 'maybeRepairFutureRounds: throttled');
    return;
  }
  _futureRepairThrottle.set(sessionId, now);

  try {
    const fromRound = activeSession.currentRound + 1;
    const result = await matchingService.repairFutureRounds(sessionId, fromRound, reason);
    if (result.regeneratedRounds.length > 0) {
      io.to(sessionRoom(sessionId)).emit('host:event_plan_repaired', {
        sessionId,
        reason,
        regeneratedRounds: result.regeneratedRounds,
      });
    }
  } catch (err) {
    logger.warn({ err, sessionId, reason }, 'maybeRepairFutureRounds: repair failed');
  }
}

// ─── Cross-module references (wired in Task 7) ────────────────────────────
// TODO: Import these from matching-flow.ts once it's created
// For now, declare as module-level variables that can be injected
let _emitHostDashboard: ((sessionId: string) => Promise<void>) | null = null;
let _endRatingWindow: ((sessionId: string, roundNumber: number) => Promise<void>) | null = null;
let _maybeAutoEndEmptyRound: ((sessionId: string) => Promise<void>) | null = null;

/**
 * Inject cross-module dependencies that live in other handler files.
 * Called during orchestration entry point wiring (Task 7).
 */
export function injectDependencies(deps: {
  emitHostDashboard: (sessionId: string) => Promise<void>;
  endRatingWindow: (sessionId: string, roundNumber: number) => Promise<void>;
  maybeAutoEndEmptyRound?: (sessionId: string) => Promise<void>;
}): void {
  _emitHostDashboard = deps.emitHostDashboard;
  _endRatingWindow = deps.endRatingWindow;
  _maybeAutoEndEmptyRound = deps.maybeAutoEndEmptyRound || null;
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

// Bug 4 (April 18 Dr Arch): if a match-status transition leaves the session
// in ROUND_ACTIVE with zero active matches, auto-transition to ROUND_RATING
// so the lobby/Match-People button doesn't lock up. Fire-and-forget.
function maybeAutoEndEmptyRound(sessionId: string): void {
  if (_maybeAutoEndEmptyRound) {
    _maybeAutoEndEmptyRound(sessionId).catch(err =>
      logger.warn({ err, sessionId }, 'Failed maybeAutoEndEmptyRound from participant-flow')
    );
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
          setPresence(existingSessionId, userId, null);
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
        setPresence(data.sessionId, userId, {
          lastHeartbeat: new Date(),
          socketId: socket.id,
          reconnectedAt: new Date(),
        });
      }

      // Auto-register if not already a participant.
      // The host is also a participant in speed networking — they network too.
      // Pass user role so admin/super_admin can bypass pod visibility restrictions.
      const userRole = (socket.data as any)?.role as UserRole | undefined;
      let didRegister = false;
      try {
        await sessionService.registerParticipant(data.sessionId, userId, userRole);
        didRegister = true;
      } catch {
        // Already registered or session not open — that's fine
      }

      // Phase 2.5D (5 May spec) — late-joiner future-only repair.
      // If a NEW participant joined mid-event (event already past round 1),
      // regenerate the pre-planned future rounds to include them. Throttled
      // to one repair per 5s per session so a flurry of joiners triggers
      // only one recompute that covers them all.
      if (didRegister && session.hostUserId !== userId) {
        void maybeRepairFutureRounds(io, data.sessionId, 'late_joiner');
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

      // ── FIX A: Defensive status reset for stuck disconnected/in_round users ──
      // If the user is reconnecting AFTER their match was already terminated
      // (disconnect timeout fired, host ended room, or partner left), their
      // session_participants.status can be left at 'disconnected' or 'in_round'.
      // Both make them ineligible for future manual rooms / algorithm rounds
      // (host-actions.ts:227, matching-flow.ts:545,550 filter for in_lobby/
      // checked_in/registered). Explicit guard: if no active match exists for
      // this user, force status back to 'in_lobby' so they can be matched again.
      try {
        const userActiveMatch = await query<{ id: string }>(
          `SELECT id FROM matches
           WHERE session_id = $1 AND status = 'active'
             AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)
           LIMIT 1`,
          [data.sessionId, userId],
        );
        if (userActiveMatch.rows.length === 0) {
          // Phase 2B (5 May spec) — route the reset through the chokepoint.
          // Read current DB status, and only call transitionParticipant when
          // the user is in a stuck state (disconnected/in_round). The
          // chokepoint enforces legal transitions; both DISCONNECTED →
          // IN_MAIN_ROOM and IN_BREAKOUT → IN_MAIN_ROOM are in the table.
          const currentRow = await query<{ status: string }>(
            `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`,
            [data.sessionId, userId],
          );
          const currentStatus = currentRow.rows[0]?.status;
          if (currentStatus === 'disconnected' || currentStatus === 'in_round') {
            const result = await transitionParticipant(
              data.sessionId, userId, ParticipantState.IN_MAIN_ROOM,
            );
            if (result.ok) {
              logger.info({ sessionId: data.sessionId, userId, fromState: result.fromState },
                'Fix A: reset stuck participant status (disconnected/in_round → in_main_room) on reconnect');
            } else {
              logger.warn({ sessionId: data.sessionId, userId, reason: result.reason, fromState: result.fromState },
                'Fix A: state-machine refused reset transition — leaving DB status untouched');
            }
          }
        }
      } catch (resetErr) {
        logger.warn({ err: resetErr, sessionId: data.sessionId, userId },
          'Fix A status-reset query failed — non-fatal');
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

      // T0-3: send the authoritative session-state snapshot. Same helper
      // backs the GET /api/sessions/:id/state REST endpoint, so the two
      // paths can never silently drift apart. Snapshot includes connected
      // participants, host presence, session status/round, timer/pause
      // state, pendingRound, co-hosts, and counts.
      try {
        const { buildSessionStateSnapshot } = await import('../../session/session-state-snapshot.service');
        const snapshot = await buildSessionStateSnapshot(data.sessionId, io);
        if (snapshot) {
          socket.emit('session:state', {
            // Original socket-only field names preserved for client back-compat
            participants: snapshot.connectedParticipants,
            sessionStatus: snapshot.sessionStatus,
            hostInLobby: snapshot.hostInLobby,
            hostUserId: snapshot.hostUserId,
            currentRound: snapshot.currentRound,
            totalRounds: snapshot.totalRounds,
            timerVisibility: snapshot.timerVisibility,
            cohosts: snapshot.cohosts,
            // T0-3: NEW fields the snapshot adds for resync precision
            isPaused: snapshot.isPaused,
            timerEndsAt: snapshot.timerEndsAt,
            pausedTimeRemainingMs: snapshot.pausedTimeRemainingMs,
            pendingRoundNumber: snapshot.pendingRoundNumber,
            participantCounts: snapshot.participantCounts,
            // Phase 5B (5 May spec) — surface test-mode flag for the host
            // banner. Heuristic-or-explicit detection happens server-side.
            testMode: snapshot.testMode,
            // Phase G (10 May spec item 11) — per-host visibility modes for
            // cold-start (page reload) so the client renders the right
            // tile arrangement without waiting for a host:visibility_changed.
            hostVisibilityModes: snapshot.hostVisibilityModes,
          });
        }
      } catch (stateErr) {
        logger.warn({ err: stateErr }, 'Failed to send initial session state');
      }

      // Phase 7-audit fix — also emit the dashboard in LOBBY_OPEN /
      // ROUND_TRANSITION / CLOSING_LOBBY so the host's Control Center
      // drawer has its participants list before any round starts. The
      // rooms / byeParticipants stay empty in those states; the
      // participants array (synthesized host + cohorts + registered
      // users) is what the drawer relies on.
      const hostDashboardStates = activeSession ? [
        SessionStatus.LOBBY_OPEN,
        SessionStatus.ROUND_ACTIVE,
        SessionStatus.ROUND_RATING,
        SessionStatus.ROUND_TRANSITION,
        SessionStatus.CLOSING_LOBBY,
      ].includes(activeSession.status) : false;
      if (isHost && activeSession && hostDashboardStates) {
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
          // Phase 7C.1 — also include the Host Control Center participants
          // payload on reconnect, so the host's drawer (if open) populates
          // immediately with the live participants/state list.
          let hccParticipants: any[] = [];
          try {
            const { buildHostParticipantsView } = await import('./host-participants-view');
            hccParticipants = await buildHostParticipantsView({
              sessionId: data.sessionId,
              hostUserId: session.hostUserId,
              presenceMap: activeSession.presenceMap,
              activeMatches: matches,
            });
          } catch (hccErr) {
            logger.warn({ err: hccErr, sessionId: data.sessionId }, 'Failed to build HCC participants on reconnect');
          }
          socket.emit('host:round_dashboard', {
            roundNumber: activeSession.currentRound,
            rooms: rooms.filter((r: any) => r.status !== 'cancelled'),
            byeParticipants,
            timerSecondsRemaining: 0,
            reassignmentInProgress: false,
            participants: hccParticipants,
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

          // Look up partner display names. Fall back to email-prefix then to
          // a short userId-derived label so trios never show "Partner, Partner"
          // in the rating prompt — same fix family as the host matching screen.
          const partnerNameResult = await query<{ id: string; displayName: string | null; email: string | null }>(
            `SELECT id, display_name AS "displayName", email FROM users WHERE id = ANY($1)`, [partnerIds]
          );
          // Phase 5 (1 May spec) — single-source displayName helper.
          const nameMap = new Map(partnerNameResult.rows.map(r => [r.id, resolveDisplayName(r.id, r.displayName, r.email)]));
          const partners = partnerIds.map(id => ({ userId: id, displayName: nameMap.get(id) || placeholderName(id) }));

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

            // Same fallback chain as the assigned-partner block above to keep
            // the rating prompt names readable when display_name is missing.
            const partnerNameResult = await query<{ id: string; displayName: string | null; email: string | null }>(
              `SELECT id, display_name AS "displayName", email FROM users WHERE id = ANY($1)`, [partnerIds]
            );
            // Phase 5 (1 May spec) — single-source displayName helper.
            const nameMap = new Map(partnerNameResult.rows.map(r => [r.id, resolveDisplayName(r.id, r.displayName, r.email)]));
            const partnersWithNames = partnerIds.map(id => ({ userId: id, displayName: nameMap.get(id) || placeholderName(id) }));

            // Give a short window to rate (15s or remaining time, whichever is more)
            const remainingSeconds = activeSession.timerEndsAt
              ? Math.max(15, Math.ceil((activeSession.timerEndsAt.getTime() - Date.now()) / 1000))
              : 15;
            socket.emit('rating:window_open', {
              matchId: userMatch.id,
              partnerId: partnerIds[0],
              partnerDisplayName: nameMap.get(partnerIds[0]) || `Partner ${partnerIds[0].slice(0, 6)}`,
              partners: partnersWithNames,
              roundNumber: activeSession.currentRound,
              durationSeconds: remainingSeconds,
            });
          }
        }
      }

      // Send chat history — only lobby messages (room messages are private to their breakout)
      const allHistory = chatMessages.get(data.sessionId) || [];
      const lobbyHistory = allHistory.filter(m => m.scope === 'lobby' || !m.scope);
      if (lobbyHistory.length > 0) {
        socket.emit('chat:history', { messages: lobbyHistory });
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

    setPresence(data.sessionId, userId, null);

    // Check if leaving user is host
    const session = await sessionService.getSessionById(data.sessionId).catch(() => null);
    const isHost = session?.hostUserId === userId;

    // Phase A1 (10 May spec) — always mark LEFT, regardless of session phase.
    // Pre-fix, leaving during SCHEDULED/LOBBY_OPEN reset status to REGISTERED;
    // since `getEligibleParticipants` treats REGISTERED as eligible, the user
    // was a "ghost" — gone from the room but still matched. The state-machine
    // legal-transitions table allows LEFT → IN_MAIN_ROOM/CHECKED_IN, so a
    // re-join works fine without the special case. This was Stefan's #2 in
    // the 10 May review.
    await sessionService.updateParticipantStatus(
      data.sessionId, userId, ParticipantStatus.LEFT
    );
    // Phase 2.5D — leaver future-only repair. Skip if the host left
    // (their leaving is a different lifecycle path).
    if (!isHost) {
      void maybeRepairFutureRounds(io, data.sessionId, 'left');
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
    setPresence(data.sessionId, userId, {
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

// ─── Room-Joined Signal (T0-2 / Issue 7) ────────────────────────────────────
//
// Client fires this after LiveKit `room.connect()` resolves AND tracks have
// been successfully published. Distinct from `presence:ready` (which signals
// generic in-lobby readiness). Lets the host dashboard distinguish "socket
// connected to session room" from "actually inside the LiveKit breakout
// room" — eliminating the false-positive "active" state the host UI used to
// show before participants had finished WebRTC setup.
//
// Cleanup happens automatically: socket disconnect clears the user from
// roomParticipants (handled in handleDisconnect). Match status flipping to
// completed/cancelled clears all participants in clearRoomParticipantsForMatch.

export async function handleRoomJoined(
  _io: SocketServer,
  socket: Socket,
  data: { sessionId: string; matchId: string; roomId: string },
): Promise<void> {
  const userId = getUserIdFromSocket(socket);
  if (!userId || !data.sessionId || !data.matchId || !data.roomId) return;

  const activeSession = activeSessions.get(data.sessionId);
  if (!activeSession) return;

  // Phase 2D (5 May spec) — single chokepoint for roomParticipants writes.
  // setRoomAssignment is the existing wrapper that handles map init +
  // overwrites on re-join; keeping mutations centralised so future Redis
  // portability has one seam to swap.
  setRoomAssignment(data.sessionId, data.matchId, data.roomId, [userId]);

  logger.debug({ sessionId: data.sessionId, userId, matchId: data.matchId },
    'presence:room_joined — participant confirmed in LiveKit room');

  // Refresh host dashboard so the green dot now reflects real LiveKit
  // presence (not just socket presence).
  if (_emitHostDashboard) await _emitHostDashboard(data.sessionId).catch(() => {});
}

/**
 * Server-canonical room assignment. Called at match-activation time (auto
 * round start, manual host breakout, solo-recovery match insert) so that
 * roomParticipants reflects "user X is assigned to room Y" the moment the
 * server hands out the LiveKit token, NOT after each client emits
 * presence:room_joined.
 *
 * Phase 0 (1 May 2026 spec) — pre-fix, roomParticipants was populated only
 * via the client-side LiveKit `onConnected` callback. If user A's LK
 * connected before user B's, A's chat-send found A in roomParticipants but
 * no one else mapped to the same roomId, so the message routed only back
 * to A. B's later presence:room_joined fixed it for the next message but
 * the first one was lost. This helper makes assignment server-canonical.
 *
 * Idempotent: safe to call multiple times for the same (sessionId, matchId,
 * roomId, userIds). Existing entries for the same user are overwritten.
 */
export function setRoomAssignment(
  sessionId: string,
  matchId: string,
  roomId: string,
  userIds: (string | null | undefined)[],
): void {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;
  if (!activeSession.roomParticipants) {
    activeSession.roomParticipants = new Map();
  }
  const now = new Date();
  for (const uid of userIds) {
    if (!uid) continue;
    activeSession.roomParticipants.set(uid, { matchId, roomId, joinedAt: now });
  }
}

/**
 * Drop a participant from the roomParticipants map. Called on socket
 * disconnect / leave / participant removal. Safe no-op if not present.
 */
export function clearRoomParticipant(sessionId: string, userId: string): void {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession?.roomParticipants) return;
  activeSession.roomParticipants.delete(userId);
}

/**
 * Drop ALL participants from a specific match's roomParticipants entries.
 * Called when a match transitions to a terminal status so we don't carry
 * stale presence into the next round.
 */
export function clearRoomParticipantsForMatch(sessionId: string, matchId: string): void {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession?.roomParticipants) return;
  for (const [uid, entry] of activeSession.roomParticipants) {
    if (entry.matchId === matchId) activeSession.roomParticipants.delete(uid);
  }
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

      // Allow leaving during any active status (manual rooms can exist at any time)
      const blockedStatuses = [SessionStatus.COMPLETED];
      if (blockedStatuses.includes(activeSession.status)) return;

      // Track that this user manually left — prevents re-entry via reconnect
      if (activeSession.status === SessionStatus.ROUND_ACTIVE) {
        activeSession.manuallyLeftRound.add(userId);
      }

      // Find the user's active match across ALL rounds (manual rooms may be on any round)
      const matchResult = await query<{ id: string; session_id: string; round_number: number; participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null; room_id: string; status: string }>(
        `SELECT id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status
         FROM matches WHERE session_id = $1 AND status = 'active'
           AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)
         LIMIT 1`,
        [sessionId, userId]
      );
      if (matchResult.rows.length === 0) return;
      const userMatch = {
        id: matchResult.rows[0].id,
        participantAId: matchResult.rows[0].participant_a_id,
        participantBId: matchResult.rows[0].participant_b_id,
        participantCId: matchResult.rows[0].participant_c_id,
        roomId: matchResult.rows[0].room_id,
        status: matchResult.rows[0].status,
      };

      // Phase 3 (29 April 2026 spec) — trio-aware demotion. Pre-fix any
      // leave killed the entire match, so a 3-person room becomes "completed"
      // the moment one user clicked Leave, breaking the spec rule
      //   "3-person room, 1 leaves → other 2 keep talking uninterrupted".
      // demoteParticipantFromMatch nullifies the leaver's slot when 2+
      // remain (match stays active, remaining users continue), or marks
      // terminal when 0/1 remain.
      const { remainingUserIds, matchStillActive } = await matchingService.demoteParticipantFromMatch(
        userMatch.id, userId, 'completed'
      );

      if (matchStillActive) {
        // Trio room with 1 leaver. Don't broadcast partner_disconnected
        // (which implies the match ended). Don't trigger solo-reassign.
        // Just notify the remaining users with a lighter event, send the
        // leaver their rating prompt, and return them to lobby.
        emitHostDashboard(sessionId);
        await sessionService.updateParticipantStatus(sessionId, userId, ParticipantStatus.IN_LOBBY);

        const trioPartnerIds = [userMatch.participantAId, userMatch.participantBId, userMatch.participantCId]
          .filter((id): id is string => !!id && id !== userId);
        const trioNameRes = await query<{ id: string; display_name: string | null; email: string | null }>(
          `SELECT id, display_name, email FROM users WHERE id = ANY($1)`, [trioPartnerIds]
        );
        const trioFallback = (id: string, dn: string | null, em: string | null): string => {
          const t = (dn || '').trim();
          if (t) return t;
          const ep = (em || '').split('@')[0].trim();
          if (ep) return ep;
          return `Partner ${id.slice(0, 6)}`;
        };
        const trioNameMap = new Map(trioNameRes.rows.map(r => [r.id, trioFallback(r.id, r.display_name, r.email)]));
        const trioPartnersWithNames = trioPartnerIds.map(pid => ({
          userId: pid,
          displayName: trioNameMap.get(pid) || `Partner ${pid.slice(0, 6)}`,
        }));

        const leaverNameRes = await query<{ display_name: string | null; email: string | null }>(
          `SELECT display_name, email FROM users WHERE id = $1`, [userId]
        );
        const leaverName = trioFallback(
          userId,
          leaverNameRes.rows[0]?.display_name || null,
          leaverNameRes.rows[0]?.email || null,
        );

        for (const remainingId of remainingUserIds) {
          io.to(userRoom(remainingId)).emit('match:participant_left', {
            matchId: userMatch.id,
            leftUserId: userId,
            leftDisplayName: leaverName,
            remainingCount: remainingUserIds.length,
          });
        }

        socket.emit('rating:window_open', {
          matchId: userMatch.id,
          partnerId: trioPartnerIds[0],
          partnerDisplayName: trioNameMap.get(trioPartnerIds[0]) || `Partner ${trioPartnerIds[0].slice(0, 6)}`,
          partners: trioPartnersWithNames,
          durationSeconds: 20,
          earlyLeave: true,
        });

        const trioSession = await sessionService.getSessionById(sessionId);
        if (trioSession.lobbyRoomId) {
          try {
            const { config: appConfig } = await import('../../../config');
            const dName = (socket.data as any)?.displayName || 'User';
            const lobbyToken = await videoService.issueJoinToken(userId, trioSession.lobbyRoomId, dName);
            socket.emit('lobby:token', {
              token: lobbyToken.token,
              livekitUrl: appConfig.livekit.host,
              roomId: trioSession.lobbyRoomId,
            });
          } catch { /* skip */ }
        }

        logger.info(
          { sessionId, userId, matchId: userMatch.id, remaining: remainingUserIds.length },
          'Trio leave: leaver returned to lobby, remaining users continue conversation',
        );
        return;
      }

      // Match was 1-2 person and is now empty/solo — existing flow handles
      // partner_disconnected, lobby return, and solo auto-reassign.
      // Clear any per-room timer/sync for this match (prevents ghost timers)
      clearRoomTimers(userMatch.id);

      // Architectural rule: refresh host dashboard on every match transition.
      // Manual rooms run during LOBBY_OPEN where the round-lifecycle polling
      // interval doesn't cover us, so emit explicitly here to clear the
      // ghost-room card from the host's view.
      emitHostDashboard(sessionId);

      // Bug 4 (April 18 Dr Arch): if voluntary leave was the last active match
      // in the round, auto-end the round so session.status doesn't linger in
      // ROUND_ACTIVE with zero active matches.
      maybeAutoEndEmptyRound(sessionId);

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

      if (partnerIds.length > 0) {
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
      } else {
        // Solo in room — no one to rate, just return to lobby
        socket.emit('match:return_to_lobby', { reason: 'you_left' });
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

        // Schedule auto-reassign — match stays 'completed' (no status overload);
        // isolated partners found via presence helper in setTimeout body below.
        setTimeout(async () => {
          try {
            const currentSession = activeSessions.get(sessionId);
            if (!currentSession) return;
            // Allow ROUND_ACTIVE (normal rounds) and LOBBY_OPEN (host-created rooms)
            if (currentSession.status !== SessionStatus.ROUND_ACTIVE && currentSession.status !== SessionStatus.LOBBY_OPEN) return;
            if (currentSession.currentRound !== activeSession.currentRound) return;

            // Verify solo partner is still waiting (not matched by another flow, still connected)
            if (!currentSession.presenceMap.has(soloPartnerId)) return;
            const alreadyMatched = await query<{ id: string }>(
              `SELECT id FROM matches
               WHERE session_id = $1 AND round_number = $2 AND status = 'active'
                 AND (participant_a_id = $3 OR participant_b_id = $3 OR participant_c_id = $3)
               LIMIT 1`,
              [sessionId, currentSession.currentRound, soloPartnerId]
            );
            if (alreadyMatched.rows.length > 0) return;

            // Find an isolated participant (not in any active match) via presence helper
            const isolatedUserIds = await findIsolatedParticipants(
              sessionId,
              currentSession.currentRound,
              currentSession.presenceMap,
              soloPartnerId,
            );

            let reassigned = false;
            for (const candidateUserId of isolatedUserIds) {
              // Already filtered by presenceMap.has in findIsolatedParticipants
              if (candidateUserId === soloPartnerId) continue;

              // Found another isolated participant — pair them
              const reassignSlug = `leave-reassign-${Date.now()}`;
              const newRoomId = `session-${sessionId}-round-${currentSession.currentRound}-${reassignSlug}`;
              try {
                await videoService.createMatchRoom(sessionId, currentSession.currentRound, reassignSlug);
              } catch { /* room may already exist */ }

              const { v4: uuid } = await import('uuid');
              const matchId = uuid();
              const normA = soloPartnerId < candidateUserId ? soloPartnerId : candidateUserId;
              const normB = soloPartnerId < candidateUserId ? candidateUserId : soloPartnerId;
              try {
                await query(
                  `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, room_id, status, started_at)
                   VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())`,
                  [matchId, sessionId, currentSession.currentRound, normA, normB, newRoomId]
                );
              } catch (insertErr: any) {
                if (insertErr.message?.includes('PARTICIPANT_ALREADY_MATCHED') || insertErr.code === '23505') {
                  logger.warn({ soloPartnerId, candidateUserId }, 'Auto-reassign after leave skipped: already matched');
                  continue;
                }
                throw insertErr;
              }

              // Fetch display names + generate tokens
              const nameRes = await query<{ id: string; display_name: string }>(
                `SELECT id, display_name FROM users WHERE id = ANY($1)`,
                [[soloPartnerId, candidateUserId]]
              );
              const names = new Map(nameRes.rows.map(r => [r.id, r.display_name || 'User']));

              const { config: reassignConfig } = await import('../../../config');
              let soloTk: string | null = null;
              let candidateTk: string | null = null;
              try {
                const [sVt, cVt] = await Promise.all([
                  videoService.issueJoinToken(soloPartnerId, newRoomId, names.get(soloPartnerId) || 'User'),
                  videoService.issueJoinToken(candidateUserId, newRoomId, names.get(candidateUserId) || 'User'),
                ]);
                soloTk = sVt.token;
                candidateTk = cVt.token;
              } catch { /* non-fatal */ }

              // Phase 0 (1 May spec) — server-canonical room assignment
              // for solo-recovery match. Same architectural rule.
              setRoomAssignment(sessionId, matchId, newRoomId, [soloPartnerId, candidateUserId]);

              io.to(userRoom(soloPartnerId)).emit('match:reassigned', {
                matchId, newPartnerId: candidateUserId,
                partnerDisplayName: names.get(candidateUserId),
                roomId: newRoomId, roundNumber: currentSession.currentRound,
                token: soloTk, livekitUrl: reassignConfig.livekit.host,
              });
              io.to(userRoom(candidateUserId)).emit('match:reassigned', {
                matchId, newPartnerId: soloPartnerId,
                partnerDisplayName: names.get(soloPartnerId),
                roomId: newRoomId, roundNumber: currentSession.currentRound,
                token: candidateTk, livekitUrl: reassignConfig.livekit.host,
              });

              logger.info({ sessionId, soloPartnerId, candidateUserId, matchId },
                'Auto-reassigned after early leave');
              reassigned = true;
              break;
            }

            if (!reassigned) {
              // No partner available — show rating for departed partner, then return to lobby
              await sessionService.updateParticipantStatus(sessionId, soloPartnerId, ParticipantStatus.IN_LOBBY);

              // Get the departed user's display name for the rating form
              const departedNameRes = await query<{ display_name: string }>(
                `SELECT display_name FROM users WHERE id = $1`, [userId]
              );
              const departedName = departedNameRes.rows[0]?.display_name || 'Partner';

              await emitRatingWindowOnce(io, soloPartnerId, userMatch.id, {
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
      setPresence(sessionId, userId, null);
      // T0-2 — also clear room-presence so dashboard reflects the actual
      // LiveKit-room state, not just socket disconnect. Phase 2D — routed
      // through the wrapper instead of mutating roomParticipants directly.
      clearRoomParticipant(sessionId, userId);

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

                // Phase 2.7 (5 May spec §9, 6 May per Ali's call) — confirmed
                // gone after 15 s with no reconnect. Transition to LEFT and
                // trigger repair_future_rounds so the user is removed from
                // upcoming pre-planned rounds. Best-effort: failures are
                // logged and the reassignment attempt below still runs so
                // the partner gets a new pair / bye for THIS round.
                try {
                  await transitionParticipant(sessionId, userId, ParticipantState.LEFT);
                } catch (transErr) {
                  logger.warn({ err: transErr, sessionId, userId },
                    'Phase 2.7: state-machine LEFT transition failed in disconnect timeout (continuing with reassignment)');
                }
                void maybeRepairFutureRounds(io, sessionId, 'left');

                // Determine terminal status based on actual conversation state:
                //   >30s OR ratings submitted → completed (real conversation)
                //   otherwise → cancelled (no_show reserved for never-connected)
                const matchInfoRes = await query<{ seconds: string; rating_count: string }>(
                  `SELECT
                     EXTRACT(EPOCH FROM (NOW() - started_at))::text AS seconds,
                     (SELECT COUNT(*)::text FROM ratings WHERE match_id = $1) AS rating_count
                   FROM matches WHERE id = $1`,
                  [disconnectMatchId],
                );
                const durationS = parseFloat(matchInfoRes.rows[0]?.seconds || '0');
                const ratingCount = parseInt(matchInfoRes.rows[0]?.rating_count || '0', 10);
                const terminalStatus = (durationS > 30 || ratingCount > 0) ? 'completed' : 'cancelled';

                await query(
                  `UPDATE matches SET status = $2, ended_at = NOW() WHERE id = $1 AND status = 'active'`,
                  [disconnectMatchId, terminalStatus],
                );

                logger.info(
                  { sessionId, matchId: disconnectMatchId, userId, durationS, ratingCount, terminalStatus },
                  'Match ended by disconnect',
                );

                // Architectural rule: refresh host dashboard on every match
                // transition. Manual rooms during LOBBY_OPEN need this since
                // the round-lifecycle polling only runs in ROUND_ACTIVE.
                emitHostDashboard(sessionId);

                // Bug 4 (April 18 Dr Arch): a disconnect-triggered terminal
                // status may have left zero active matches in the round.
                maybeAutoEndEmptyRound(sessionId);

                // Step 3: Try auto-reassignment — find another isolated participant via presence
                const isolatedUserIds = await findIsolatedParticipants(
                  sessionId,
                  disconnectRound,
                  currentSession.presenceMap,
                  userId,
                );

                let reassigned = false;
                for (const candidateUserId of isolatedUserIds) {
                  if (candidateUserId === userId) continue; // double-safety, already excluded
                  if (candidateUserId === partnerId) continue; // don't pair partner with themselves

                  // Found another isolated participant — pair them!
                  const reassignSlug = `auto-reassign-${Date.now()}`;
                  const roomId = `session-${sessionId}-round-${disconnectRound}-${reassignSlug}`;
                  try {
                    await videoService.createMatchRoom(sessionId, disconnectRound, reassignSlug);
                  } catch { /* room may already exist */ }

                  const matchId = require('uuid').v4();
                  // Normalize participant order (lexicographic) for constraint consistency
                  const normA = partnerId < candidateUserId ? partnerId : candidateUserId;
                  const normB = partnerId < candidateUserId ? candidateUserId : partnerId;
                  try {
                    await query(
                      `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, room_id, status, started_at)
                       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())`,
                      [matchId, sessionId, disconnectRound, normA, normB, roomId]
                    );
                  } catch (insertErr: any) {
                    // DB constraint caught a conflict — participant already matched
                    if (insertErr.message?.includes('PARTICIPANT_ALREADY_MATCHED') || insertErr.code === '23505') {
                      logger.warn({ partnerId, candidateUserId, disconnectRound },
                        'Auto-reassign skipped: participant already in active match');
                      continue; // Try next candidate
                    }
                    throw insertErr;
                  }

                  // Fetch display names
                  const nameRes = await query<{ id: string; display_name: string }>(
                    `SELECT id, display_name FROM users WHERE id = ANY($1)`,
                    [[partnerId, candidateUserId]]
                  );
                  const names = new Map(nameRes.rows.map(r => [r.id, r.display_name || 'User']));

                  // Generate inline tokens for instant breakout transition
                  const { config: reassignConfig } = await import('../../../config');
                  let partnerTk: string | null = null;
                  let candidateTk: string | null = null;
                  try {
                    const [pVt, cVt] = await Promise.all([
                      videoService.issueJoinToken(partnerId, roomId, names.get(partnerId) || 'User'),
                      videoService.issueJoinToken(candidateUserId, roomId, names.get(candidateUserId) || 'User'),
                    ]);
                    partnerTk = pVt.token;
                    candidateTk = cVt.token;
                  } catch { /* non-fatal — client retries via API */ }

                  // Phase 0 (1 May spec) — server-canonical room
                  // assignment for disconnect-recovery match. Same rule.
                  setRoomAssignment(sessionId, matchId, roomId, [partnerId, candidateUserId]);

                  io.to(userRoom(partnerId)).emit('match:reassigned', {
                    matchId, newPartnerId: candidateUserId,
                    partnerDisplayName: names.get(candidateUserId),
                    roomId, roundNumber: disconnectRound,
                    token: partnerTk, livekitUrl: reassignConfig.livekit.host,
                  });
                  io.to(userRoom(candidateUserId)).emit('match:reassigned', {
                    matchId, newPartnerId: partnerId,
                    partnerDisplayName: names.get(partnerId),
                    roomId, roundNumber: disconnectRound,
                    token: candidateTk, livekitUrl: reassignConfig.livekit.host,
                  });

                  logger.info({ sessionId, partnerId, candidateUserId, matchId },
                    'Auto-reassigned isolated participants after disconnect');
                  reassigned = true;
                  break;
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
  setInterval(async () => {
    const now = Date.now();
    for (const [sessionId, session] of activeSessions) {
      for (const [userId, presence] of session.presenceMap) {
        if (now - presence.lastHeartbeat.getTime() > STALE_HEARTBEAT_MS) {
          logger.warn({ userId, sessionId }, 'Stale heartbeat — triggering disconnect flow');
          setPresence(sessionId, userId, null);
          // Phase 2.7 — stale-heartbeat path also transitions to LEFT and
          // triggers future-rounds repair so the user is consistently
          // removed from the system, not stranded in DISCONNECTED state.
          try {
            await transitionParticipant(sessionId, userId, ParticipantState.LEFT);
          } catch (err) {
            logger.warn({ err, sessionId, userId },
              'Phase 2.7: stale-heartbeat LEFT transition failed (continuing)');
          }
          void maybeRepairFutureRounds(io, sessionId, 'left');
          io.to(sessionRoom(sessionId)).emit('participant:left', { userId });
        }
      }
    }
  }, STALE_CHECK_INTERVAL_MS);
}
