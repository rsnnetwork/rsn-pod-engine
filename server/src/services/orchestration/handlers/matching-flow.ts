// ─── Matching Flow ─────────────────────────────────────────────────────────
// Extracted from orchestration.service.ts — all matching-related socket handlers:
// generate-matches, confirm-round, swap-match, exclude-from-round,
// regenerate-matches, cancel-preview, plus internal helpers sendMatchPreview
// and emitHostDashboard.
//
// Every state-mutating handler is wrapped with withSessionGuard to prevent
// concurrent host actions on the same session.
//
// Critical fixes included:
// - FIX 3A: pendingRoundNumber cleared AFTER successful transition (not before)
// - FIX 3B: Matching engine 60s timeout to prevent indefinite hangs

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { SessionStatus } from '@rsn/shared';
import {
  activeSessions,
  sessionRoom, userRoom, persistSessionState,
} from '../state/session-state';
import { verifyHost, getAllHostIds } from './host-actions';
import * as matchingService from '../../matching/matching.service';

// ─── Cross-module references (wired in Task 7) ────────────────────────────
// transitionToRound lives in round-lifecycle.ts.

let _transitionToRound: ((io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>) | null = null;

/**
 * Inject cross-module dependencies that live in other handler files.
 * Called during orchestration entry point wiring (Task 7).
 */
export function injectMatchingFlowDeps(deps: {
  transitionToRound: (io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>;
}) {
  _transitionToRound = deps.transitionToRound;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const MATCHING_TIMEOUT_MS = 60_000;

// ─── Host Generate Matches (preview step) ──────────────────────────────────

export async function handleHostGenerateMatches(
  io: SocketServer,
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
    const hostIdSet = new Set(allHostIds);

    // Cross-check DB status with actual presence to prevent phantom matches.
    // Phase 2 (Redis): presentUserIds will come from Redis presence instead of in-memory map.
    const presentUserIds = new Set(activeSession.presenceMap.keys());
    const presentNonHostIds = new Set(
      [...presentUserIds].filter(uid => !hostIdSet.has(uid))
    );
    const participantCount = presentNonHostIds.size;

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

    // Clean up any stale matches for this round (previous generate/cancel cycles)
    await query(
      `DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND status IN ('scheduled', 'cancelled')`,
      [data.sessionId, nextRound]
    );

    // Notify all participants that host is preparing matches
    io.to(sessionRoom(data.sessionId)).emit('session:matching_preparing', {
      sessionId: data.sessionId,
      roundNumber: nextRound,
    });

    // FIX 3B: Matching engine timeout — 60s max to prevent indefinite hangs
    try {
      const matchPromise = matchingService.generateSingleRound(data.sessionId, nextRound, allHostIds, presentUserIds);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Matching engine timeout after 60s')), MATCHING_TIMEOUT_MS)
      );
      await Promise.race([matchPromise, timeoutPromise]);

      // Store pending round number so confirm_round knows what to start
      activeSession.pendingRoundNumber = nextRound;

      // Send preview to host only (includes trio support + encounter history)
      await sendMatchPreview(io, socket, data.sessionId, nextRound, activeSession.hostUserId);

      logger.info({ sessionId: data.sessionId, roundNumber: nextRound },
        'Match preview generated for host');
    } catch (err: any) {
      if (err.message?.includes('timeout')) {
        logger.error({ sessionId: data.sessionId }, 'Matching engine timed out after 60s');
        socket.emit('error', { message: 'Matching took too long. Please try again.' });
        return; // Session stays in current state — host can retry
      }
      throw err; // Re-throw non-timeout errors
    }
  } catch (err: any) {
    logger.error({ err }, 'Error generating match preview');
    socket.emit('error', { code: 'GENERATE_FAILED', message: err.message });
  }
}

// ─── Host Confirm Round (start after preview) ─────────────────────────────

export async function handleHostConfirmRound(
  io: SocketServer,
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
    // FIX 3A: Do NOT clear before transition — if transition fails, host can't retry

    logger.info({ sessionId: data.sessionId, roundNumber }, 'Host confirmed round — starting');

    if (!_transitionToRound) {
      throw new Error('transitionToRound not injected — call injectMatchingFlowDeps first');
    }
    await _transitionToRound(io, data.sessionId, roundNumber!);

    // FIX 3A: Clear ONLY after successful transition
    activeSession.pendingRoundNumber = null;
    persistSessionState(data.sessionId, activeSession);
  } catch (err: any) {
    logger.error({ err }, 'Error confirming round');
    socket.emit('error', { code: 'CONFIRM_ROUND_FAILED', message: err.message });
  }
}

// ─── Host Swap Match (swap two participants between matches in preview) ────

export async function handleHostSwapMatch(
  io: SocketServer,
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
    await sendMatchPreview(io, socket, data.sessionId, roundNumber, activeSession.hostUserId);

    logger.info({ sessionId: data.sessionId, userA: data.userA, userB: data.userB }, 'Host swapped match participants');
  } catch (err: any) {
    socket.emit('error', { code: 'SWAP_FAILED', message: err.message });
  }
}

// ─── Host Exclude Participant from Round ──────────────────────────────────

export async function handleHostExcludeFromRound(
  io: SocketServer,
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
    await sendMatchPreview(io, socket, data.sessionId, roundNumber, activeSession.hostUserId);

    logger.info({ sessionId: data.sessionId, excludedUser: data.userId }, 'Host excluded participant from round');
  } catch (err: any) {
    socket.emit('error', { code: 'EXCLUDE_FAILED', message: err.message });
  }
}

// ─── Host Regenerate Matches ──────────────────────────────────────────────

export async function handleHostRegenerateMatches(
  io: SocketServer,
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

    // Delete existing scheduled/cancelled matches for this round
    await query(
      `DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND status IN ('scheduled', 'cancelled')`,
      [data.sessionId, roundNumber]
    );

    // Re-generate (exclude host + co-hosts from matching, filter by presence)
    const allHostIds = await getAllHostIds(data.sessionId, activeSession.hostUserId);
    const presentUserIds = new Set(activeSession.presenceMap.keys());
    await matchingService.generateSingleRound(data.sessionId, roundNumber, allHostIds, presentUserIds);

    // Re-send preview
    await sendMatchPreview(io, socket, data.sessionId, roundNumber, activeSession.hostUserId);

    logger.info({ sessionId: data.sessionId, roundNumber }, 'Host regenerated matches');
  } catch (err: any) {
    socket.emit('error', { code: 'REGENERATE_FAILED', message: err.message });
  }
}

// ─── Host Force Match (manually pair two specific participants) ──────────────

export async function handleHostForceMatch(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; userIdA: string; userIdB: string }
): Promise<void> {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Event is not active' });
      return;
    }

    const roundNumber = activeSession.pendingRoundNumber;
    if (roundNumber == null) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'No pending round to add matches to' });
      return;
    }

    // Normalize IDs (A < B for consistency)
    const normA = data.userIdA < data.userIdB ? data.userIdA : data.userIdB;
    const normB = data.userIdA < data.userIdB ? data.userIdB : data.userIdA;

    // Cancel any existing matches containing either participant for this round
    const existing = await query(
      `SELECT id FROM matches WHERE session_id = $1 AND round_number = $2
       AND (participant_a_id = $3 OR participant_b_id = $3 OR participant_c_id = $3
         OR participant_a_id = $4 OR participant_b_id = $4 OR participant_c_id = $4)
       AND status != 'cancelled'`,
      [data.sessionId, roundNumber, data.userIdA, data.userIdB]
    );

    if (existing.rows.length > 0) {
      const ids = existing.rows.map(r => r.id);
      await query(`UPDATE matches SET status = 'cancelled' WHERE id = ANY($1)`, [ids]);
    }

    // Create the manual match
    const { v4: uuid } = await import('uuid');
    const matchId = uuid();
    await query(
      `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, status)
       VALUES ($1, $2, $3, $4, $5, 'scheduled')`,
      [matchId, data.sessionId, roundNumber, normA, normB]
    );

    logger.info({ sessionId: data.sessionId, matchId, userA: normA, userB: normB }, 'Manual match created by host');

    // Re-send updated preview
    await sendMatchPreview(io, socket, data.sessionId, roundNumber, activeSession.hostUserId);
  } catch (err: any) {
    logger.error({ err }, 'Error creating manual match');
    socket.emit('error', { code: 'FORCE_MATCH_FAILED', message: err.message });
  }
}

// ─── Host Cancel Preview ────────────────────────────────────────────────────

export async function handleHostCancelPreview(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession) return;

    const roundNumber = activeSession.pendingRoundNumber;
    activeSession.pendingRoundNumber = null;

    // Clean up scheduled matches for cancelled preview
    if (roundNumber) {
      await query(
        `DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND status IN ('scheduled', 'cancelled')`,
        [data.sessionId, roundNumber]
      );
    }

    // Tell participants to clear the preparing overlay
    io.to(sessionRoom(data.sessionId)).emit('session:matching_cancelled', {
      sessionId: data.sessionId,
    });

    logger.info({ sessionId: data.sessionId }, 'Host cancelled match preview');
  } catch (err: any) {
    logger.error({ err }, 'Error cancelling preview');
  }
}

// ─── Host Confirm Matches (visual trigger — does NOT start the round) ─────

export async function handleHostConfirmMatches(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  try {
    if (!await verifyHost(socket, data.sessionId)) return;

    const activeSession = activeSessions.get(data.sessionId);
    if (!activeSession || !activeSession.pendingRoundNumber) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'No pending matches to confirm' });
      return;
    }

    const matches = await matchingService.getMatchesByRound(data.sessionId, activeSession.pendingRoundNumber);

    // Broadcast to ALL participants — triggers 3-second visual
    io.to(sessionRoom(data.sessionId)).emit('session:matches_confirmed', {
      sessionId: data.sessionId,
      matchCount: matches.length,
      roundNumber: activeSession.pendingRoundNumber,
    });

    logger.info({ sessionId: data.sessionId, matchCount: matches.length }, 'Host confirmed matches — visual sent to participants');
  } catch (err: any) {
    logger.error({ err }, 'Error in handleHostConfirmMatches');
    socket.emit('error', { code: 'CONFIRM_MATCHES_FAILED', message: err.message });
  }
}

// ─── Helper: Send Match Preview to Host ───────────────────────────────────

export async function sendMatchPreview(
  _io: SocketServer,
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
    roundWarnings.push(`All participants have already met — ${byeParticipants.length} will sit this round out. Need new participants for fresh matches.`);
  }

  socket.emit('host:match_preview', {
    roundNumber,
    matches: matchPreview,
    byeParticipants,
    ...(roundWarnings.length > 0 && { warnings: roundWarnings }),
  });
}

// ─── Host Round Dashboard ─────────────────────────────────────────────────

export async function emitHostDashboard(io: SocketServer, sessionId: string): Promise<void> {
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
        const participants: { userId: string; displayName: string; isConnected: boolean }[] = [];
        if (m.participantAId) {
          participants.push({
            userId: m.participantAId,
            displayName: nameMap.get(m.participantAId) || 'User',
            isConnected: activeSession.presenceMap.has(m.participantAId),
          });
        }
        if (m.participantBId) {
          participants.push({
            userId: m.participantBId,
            displayName: nameMap.get(m.participantBId) || 'User',
            isConnected: activeSession.presenceMap.has(m.participantBId),
          });
        }
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
          isManual: (m.roomId || '').includes('host-'),
        };
      });

    // Find bye participants (matched to nobody)
    const matchedUserIds = new Set<string>();
    for (const m of matches) {
      if (m.participantAId) matchedUserIds.add(m.participantAId);
      if (m.participantBId) matchedUserIds.add(m.participantBId);
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
