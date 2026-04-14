// ─── Round Lifecycle ───────────────────────────────────────────────────────
// Extracted from orchestration.service.ts — round lifecycle functions:
// recoverActiveSessions, transitionToRound, endRound, endRatingWindow,
// completeSession, cleanupLiveKitRooms, sendRecapEmails, detectNoShows.
//
// Includes FIX 3D (rating early-exit guard) and FIX 3E (LiveKit room retry).

import { Server as SocketServer } from 'socket.io';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { SessionStatus, ParticipantStatus } from '@rsn/shared';
import {
  ActiveSession, activeSessions,
  sessionRoom, userRoom, persistSessionState, clearPersistedState,
  cleanupChatMessages,
} from '../state/session-state';
import { startSegmentTimer, clearSessionTimers, getTimerCallbackForState, TimerCallbacks } from './timer-manager';
import * as sessionService from '../../session/session.service';
import * as matchingService from '../../matching/matching.service';
import * as ratingService from '../../rating/rating.service';
import * as videoService from '../../video/video.service';
import * as emailService from '../../email/email.service';

// ─── Cross-module references (wired in Task 7) ────────────────────────────

let _timerCallbacks: TimerCallbacks | null = null;
let _emitHostDashboard: ((io: SocketServer, sessionId: string) => Promise<void>) | null = null;

/**
 * Inject cross-module dependencies that live in other handler files.
 * Called during orchestration entry point wiring (Task 7).
 */
export function injectRoundLifecycleDeps(deps: {
  timerCallbacks: TimerCallbacks;
  emitHostDashboard: (io: SocketServer, sessionId: string) => Promise<void>;
}) {
  _timerCallbacks = deps.timerCallbacks;
  _emitHostDashboard = deps.emitHostDashboard;
}

// ─── Helper: emit host dashboard (delegates to injected fn or no-op) ──────

function emitHostDashboard(io: SocketServer, sessionId: string): void {
  if (_emitHostDashboard) {
    _emitHostDashboard(io, sessionId).catch(err => {
      logger.warn({ err, sessionId }, 'Failed to emit host dashboard');
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FIX 3E: LiveKit Room Creation with Retry
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Create a LiveKit room with 1 retry on failure.
 * Returns true if room was created, false if both attempts failed.
 */
async function createRoomWithRetry(
  sessionId: string,
  roundNumber: number,
  matchIdShort: string,
): Promise<boolean> {
  try {
    await videoService.createMatchRoom(sessionId, roundNumber, matchIdShort);
    return true;
  } catch (err) {
    logger.warn({ err, sessionId, roundNumber, matchIdShort },
      'LiveKit room creation failed — retrying in 2s');
    await new Promise(resolve => setTimeout(resolve, 2000));
    try {
      await videoService.createMatchRoom(sessionId, roundNumber, matchIdShort);
      return true;
    } catch (retryErr) {
      logger.error({ err: retryErr, sessionId, roundNumber, matchIdShort },
        'LiveKit room creation failed after retry');
      return false;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RECOVER ACTIVE SESSIONS
// ═════════════════════════════════════════════════════════════════════════════

export async function recoverActiveSessions(io: SocketServer): Promise<void> {
  const activeStatuses = ['lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby'];
  const result = await query<{
    id: string; status: string; host_user_id: string; config: any; current_round: number;
    active_state: any; lobby_room_id: string;
  }>(
    `SELECT id, status, host_user_id, config, current_round, active_state, lobby_room_id
     FROM sessions WHERE status = ANY($1) AND active_state IS NOT NULL`,
    [activeStatuses]
  );

  if (result.rows.length === 0) {
    logger.info('No active sessions to recover on startup');
    return;
  }

  for (const row of result.rows) {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    const state = typeof row.active_state === 'string' ? JSON.parse(row.active_state) : row.active_state;

    const activeSession: ActiveSession = {
      sessionId: row.id,
      status: row.status as SessionStatus,
      currentRound: state?.currentRound || row.current_round || 0,
      hostUserId: row.host_user_id,
      config,
      presenceMap: new Map(),
      manuallyLeftRound: new Set(),
      timer: null,
      timerSyncInterval: null,
      timerEndsAt: state?.timerEndsAt ? new Date(state.timerEndsAt) : null,
      pendingRoundNumber: null,
      isPaused: state?.isPaused || false,
      pausedTimeRemaining: state?.pausedTimeRemaining || null,
    };

    activeSessions.set(row.id, activeSession);

    // If there was a running timer, restart it based on remaining time
    if (activeSession.timerEndsAt && activeSession.timerEndsAt.getTime() > Date.now()) {
      const remainingMs = activeSession.timerEndsAt.getTime() - Date.now();
      const remainingSec = Math.ceil(remainingMs / 1000);
      logger.info({ sessionId: row.id, remainingSec, status: row.status },
        'Recovering active session with running timer');
      // Re-start the timer for the remaining duration
      if (_timerCallbacks) {
        startSegmentTimer(io, row.id, remainingSec, getTimerCallbackForState(row.id, activeSession, _timerCallbacks));
      }
    } else {
      logger.info({ sessionId: row.id, status: row.status },
        'Recovered active session (no timer or timer expired)');
    }
  }

  logger.info({ count: result.rows.length }, 'Active sessions recovered from database');
}

// ═════════════════════════════════════════════════════════════════════════════
// TRANSITION TO ROUND
// ═════════════════════════════════════════════════════════════════════════════

export async function transitionToRound(
  io: SocketServer,
  sessionId: string,
  roundNumber: number,
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
    persistSessionState(sessionId, activeSession).catch(() => {});

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
    // FIX 3E: Use createRoomWithRetry — on failure, cancel match and send bye
    const ROOM_BATCH_SIZE = 20;
    const matchList = Array.from(matches);
    for (let i = 0; i < matchList.length; i += ROOM_BATCH_SIZE) {
      const batch = matchList.slice(i, i + ROOM_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (match: any) => {
          const matchIdShort = match.id.substring(0, 8);
          const success = await createRoomWithRetry(sessionId, roundNumber, matchIdShort);
          return { match, matchIdShort, success };
        })
      );

      for (const { match, success } of results) {
        if (!success) {
          // Cancel the match and send bye to affected participants
          await query(`UPDATE matches SET status = 'cancelled' WHERE id = $1`, [match.id]);
          const affectedUserIds = [match.participantAId, match.participantBId, match.participantCId].filter(Boolean);
          for (const uid of affectedUserIds) {
            io.to(userRoom(uid)).emit('match:bye_round', { roundNumber });
          }
          logger.error({ matchId: match.id, sessionId }, 'Match cancelled due to room creation failure');
        }
      }
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
    const globalNameMap = new Map<string, string>(namesResult.rows.map(r => [r.id, r.displayName] as [string, string]));

    // Step 5: Pre-generate LiveKit tokens for all participants (inline, no API round-trip)
    // Uses same TTL formula as session.service.ts generateLiveKitToken
    const { config: appConfig } = await import('../../../config');
    const sessionConfig = activeSession.config;
    const roundsRemaining = Math.max(1, (sessionConfig.numberOfRounds || 5) - roundNumber);
    const roundDuration = sessionConfig.roundDurationSeconds || 480;
    const ratingWindow = sessionConfig.ratingWindowSeconds || 10;
    const estimatedRemainingSeconds = roundsRemaining * (roundDuration + ratingWindow + 30) + 600;
    const tokenTtl = Math.max(1800, Math.min(14400, estimatedRemainingSeconds));

    // Generate tokens in parallel for all matched participants
    const tokenMap = new Map<string, string>(); // pid -> JWT token
    const tokenPromises = allPidArray
      .filter(pid => matchedUserIds.has(pid))
      .map(async (pid) => {
        try {
          const displayName = globalNameMap.get(pid) || 'User';
          // Find which room this participant is in
          let pidRoomId: string | undefined;
          for (const match of matches) {
            const mPids = [match.participantAId, match.participantBId];
            if (match.participantCId) mPids.push(match.participantCId);
            if (mPids.includes(pid)) {
              pidRoomId = matchRoomMap.get(match.id);
              break;
            }
          }
          if (pidRoomId) {
            const vt = await videoService.issueJoinToken(pid, pidRoomId, displayName, tokenTtl);
            tokenMap.set(pid, vt.token);
          }
        } catch (err) {
          // Non-fatal: client will fall back to API token fetch
          logger.warn({ err, pid, sessionId }, 'Inline token generation failed — client will retry via API');
        }
      });
    await Promise.all(tokenPromises);

    // Step 6: Emit match:assigned to all participants + batch status update
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
          // Inline token eliminates client-side API round-trip (~100-500ms saved)
          token: tokenMap.get(pid) || null,
          livekitUrl: appConfig.livekit.host,
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
    startSegmentTimer(io, sessionId, activeSession.config.roundDurationSeconds, () => {
      endRound(io, sessionId, roundNumber);
    });

    // Schedule no-show detection after the configured timeout
    setTimeout(() => {
      detectNoShows(io, sessionId, roundNumber);
    }, activeSession.config.noShowTimeoutSeconds * 1000);

    // Emit host dashboard immediately and every 5 seconds during the round
    emitHostDashboard(io, sessionId);
    const dashboardInterval = setInterval(() => {
      const s = activeSessions.get(sessionId);
      if (!s || s.status !== SessionStatus.ROUND_ACTIVE) {
        clearInterval(dashboardInterval);
        return;
      }
      emitHostDashboard(io, sessionId);
    }, 5000);

    logger.info({ sessionId, roundNumber }, 'Round started');
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Error transitioning to round');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// END ROUND
// ═════════════════════════════════════════════════════════════════════════════

export async function endRound(
  io: SocketServer,
  sessionId: string,
  roundNumber: number,
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
    persistSessionState(sessionId, activeSession).catch(() => {});

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

          // Scale rating duration by number of partners (trios get 60s, duos get 30s)
          const partnerCount = partnersWithNames.length;
          const scaledDuration = (activeSession.config.ratingWindowSeconds || 30) * Math.max(1, partnerCount);

          io.to(userRoom(pid)).emit('rating:window_open', {
            matchId: match.id,
            partnerId: partnerIds[0],
            partnerDisplayName: ratingNameMap.get(partnerIds[0]) || 'Partner',
            partners: partnersWithNames,
            roundNumber,
            durationSeconds: scaledDuration,
            partnerCount,
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

    // Find the max partner count across all completed matches
    // Each match has participant_a, participant_b, and optionally participant_c
    const completedMatches = matches.filter((m: any) => m.status === 'completed');
    const maxPartnerCount = Math.max(
      ...completedMatches.map((m: any) => {
        const parts = [m.participantAId, m.participantBId, m.participantCId].filter(Boolean);
        return parts.length - 1; // subtract self = number of partners
      }),
      1 // minimum 1
    );
    const ratingDuration = (activeSession.config.ratingWindowSeconds || 30) * maxPartnerCount;

    // Start rating window timer (scaled by max partner count so trios have enough time)
    startSegmentTimer(io, sessionId, ratingDuration, () => {
      endRatingWindow(io, sessionId, roundNumber);
    });

    logger.info({ sessionId, roundNumber }, 'Round ended → ROUND_RATING');
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Error ending round');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// END RATING WINDOW
// ═════════════════════════════════════════════════════════════════════════════

export async function endRatingWindow(
  io: SocketServer,
  sessionId: string,
  roundNumber: number,
): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;

  // FIX 3D: Guard — only transition if we're actually in ROUND_RATING
  if (activeSession.status !== SessionStatus.ROUND_RATING) {
    logger.warn({ sessionId, currentStatus: activeSession.status },
      'endRatingWindow called but not in ROUND_RATING — skipping');
    return;
  }

  clearSessionTimers(sessionId);

  try {
    // Finalize ratings for the round
    await ratingService.finalizeRoundRatings(sessionId, roundNumber);

    io.to(sessionRoom(sessionId)).emit('rating:window_closed', { roundNumber });

    // Check if there are more rounds
    if (roundNumber < activeSession.config.numberOfRounds) {
      // Transition phase
      activeSession.status = SessionStatus.ROUND_TRANSITION;
      await sessionService.updateSessionStatus(sessionId, SessionStatus.ROUND_TRANSITION);
      persistSessionState(sessionId, activeSession).catch(() => {});

      io.to(sessionRoom(sessionId)).emit('session:status_changed', {
        sessionId,
        status: SessionStatus.ROUND_TRANSITION,
        currentRound: roundNumber,
      });

      // Re-issue lobby tokens to all connected participants for video mosaic
      const session = await sessionService.getSessionById(sessionId);
      if (session.lobbyRoomId) {
        const socketsInRoom = await io.in(sessionRoom(sessionId)).fetchSockets();
        const { config: appConfig } = await import('../../../config');
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
      persistSessionState(sessionId, activeSession).catch(() => {});

      io.to(sessionRoom(sessionId)).emit('session:status_changed', {
        sessionId,
        status: SessionStatus.CLOSING_LOBBY,
        currentRound: roundNumber,
      });

      // Re-issue lobby tokens so participants see each other for goodbyes
      const session = await sessionService.getSessionById(sessionId);
      if (session.lobbyRoomId) {
        const socketsInRoom = await io.in(sessionRoom(sessionId)).fetchSockets();
        const { config: appConfig } = await import('../../../config');
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

      // Host-controlled: no auto-end. Host must click "End Event".
      // 10-minute safety fallback prevents orphaned sessions if host disconnects.
      startSegmentTimer(io, sessionId, 600, () => {
        completeSession(io, sessionId);
      });

      logger.info({ sessionId, roundNumber }, 'All rounds completed → CLOSING_LOBBY (waiting for host, 10min safety timeout)');
    }
  } catch (err) {
    logger.error({ err, sessionId, roundNumber }, 'Error ending rating window');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// COMPLETE SESSION
// ═════════════════════════════════════════════════════════════════════════════

export async function completeSession(io: SocketServer, sessionId: string): Promise<void> {
  const activeSession = activeSessions.get(sessionId);

  try {
    // FIX 5D: Clear ALL timers (main + sync interval)
    clearSessionTimers(sessionId);

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
    clearPersistedState(sessionId).catch(() => {});
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CLEAN UP LIVEKIT ROOMS
// ═════════════════════════════════════════════════════════════════════════════

export async function cleanupLiveKitRooms(sessionId: string): Promise<void> {
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

// ═════════════════════════════════════════════════════════════════════════════
// SEND RECAP EMAILS
// ═════════════════════════════════════════════════════════════════════════════

export async function sendRecapEmails(sessionId: string): Promise<void> {
  const { config: appConfig } = await import('../../../config');

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

  const failedEmails: string[] = [];
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
      failedEmails.push(p.email);
      logger.warn({ err, userId: p.userId }, 'Failed to send recap email to participant');
    }
    // Rate-limit safety: 200ms between emails to avoid hitting Resend's 429
    await new Promise(r => setTimeout(r, 200));
  }

  if (failedEmails.length > 0) {
    logger.error({ sessionId, failedEmails, failedCount: failedEmails.length },
      'Some recap emails failed after all retries');
  }
  logger.info({ sessionId, sent: participantsResult.rows.length - failedEmails.length,
    failed: failedEmails.length }, 'Recap emails dispatched');

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
// NO-SHOW DETECTION
// ═════════════════════════════════════════════════════════════════════════════

export async function detectNoShows(
  io: SocketServer,
  sessionId: string,
  roundNumber: number,
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
