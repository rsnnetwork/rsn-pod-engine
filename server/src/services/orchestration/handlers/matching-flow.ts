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
import { SessionStatus, resolveDisplayName, placeholderName } from '@rsn/shared';
import {
  activeSessions,
  sessionRoom, userRoom, persistSessionState,
} from '../state/session-state';
import { verifyHost, getAllHostIds } from './host-actions';
import * as matchingService from '../../matching/matching.service';
import { validateMatchAssignment } from '../../matching/match-validator.service';
// Phase 7C.1 (7 May spec) — backing data for the Host Control Center drawer.
import { buildHostParticipantsView } from './host-participants-view';
// Phase 2 (19 May 2026) — realtime migration dual-emit. The host:event_plan_*
// broadcast in this module gets a sibling emitEntities() call. See:
//   docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
import { emitEntities } from '../../../realtime/emit';
import { E } from '../../../realtime/entities';

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

// 23 May (Stefan + Ali) — recover the previewed round from the DB when the
// in-memory pendingRoundNumber was lost (e.g. a deploy/restart between the
// host pressing "Match People" and a follow-up preview action like Swap or
// Re-match). The preview is persisted as 'scheduled' match rows, so the
// highest scheduled round is the one currently on screen. Pre-fix the guard
// returned silently and those buttons appeared to do nothing.
async function resolvePendingRound(
  activeSession: { pendingRoundNumber: number | null },
  sessionId: string,
): Promise<number | null> {
  if (activeSession.pendingRoundNumber) return activeSession.pendingRoundNumber;
  const sched = await query<{ round_number: number | null }>(
    `SELECT MAX(round_number) AS round_number FROM matches WHERE session_id = $1 AND status = 'scheduled'`,
    [sessionId],
  );
  const recovered = sched.rows[0]?.round_number ?? null;
  if (recovered) activeSession.pendingRoundNumber = recovered;
  return recovered;
}

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
      activeSession.status !== SessionStatus.ROUND_TRANSITION &&
      activeSession.status !== SessionStatus.CLOSING_LOBBY
    ) {
      socket.emit('error', {
        code: 'INVALID_STATE',
        message: 'Can only generate matches from the lobby, transition, or closing phase',
      });
      return;
    }

    // Bug 9 (April 19) — "Another Round" on the "All rounds complete" screen
    // now emits host:generate_matches (was host:start_round). If we're in
    // CLOSING_LOBBY, transition back to ROUND_TRANSITION and bump the round
    // cap so the new round is a legitimate round N+1 rather than tripping
    // the ">= numberOfRounds" end-of-event guard in endRatingWindow. Also
    // cancel the 10-min closing safety timer — host is continuing the event.
    //
    // Bug 22 (18 May Ali) — the bump used to live ONLY in
    // activeSession.config (in-memory) + the Redis snapshot via the
    // next persistSessionState call. The DB sessions.config row was
    // never touched, which left the recap page reading "X of 3" even
    // when the host actually ran 4 rounds. Now we also UPDATE the DB
    // config so every downstream consumer — recap, REST /sessions/:id,
    // post-event analytics, server restart recovery — agrees the
    // event ran for N+1 rounds.
    //
    // Bug 23 (18 May Ali) — idempotency. Pre-fix the bump fired any time
    // status === CLOSING_LOBBY, so if cancel-preview / a future flow ever
    // reverted status back to CLOSING_LOBBY after the first bump, a second
    // "Another Round" click would push numberOfRounds to N+2 even though
    // the extra round had not actually been run. The new guard adds an
    // explicit numberOfRounds check: bump ONLY when the configured round
    // count is still <= currentRound (i.e. nothing has been bumped yet
    // for THIS attempt). After the first bump, numberOfRounds = currentRound
    // + 1 so the guard rejects every subsequent click until the new round
    // actually completes — clicking "Another Round" three times in a row
    // still adds exactly one round.
    const alreadyBumpedForThisAttempt =
      (activeSession.config.numberOfRounds || 5) > activeSession.currentRound;
    if (
      activeSession.status === SessionStatus.CLOSING_LOBBY
      && !alreadyBumpedForThisAttempt
    ) {
      const { clearSessionTimers } = await import('./timer-manager');
      const sessionService = await import('../../session/session.service');
      clearSessionTimers(data.sessionId);
      const bumpedRounds = (activeSession.config.numberOfRounds || 5) + 1;
      // Bug 28 (19 May Ali + Stefan) — track bonus-round count alongside
      // the bumped total so UI can render "Bonus" badges and recap can
      // report "3 + 1 bonus" honestly.
      const bonusRoundsAdded = (activeSession.config.bonusRoundsAdded ?? 0) + 1;
      activeSession.config = {
        ...activeSession.config,
        numberOfRounds: bumpedRounds,
        bonusRoundsAdded,
      };
      activeSession.status = SessionStatus.ROUND_TRANSITION;
      await sessionService.updateSessionStatus(data.sessionId, SessionStatus.ROUND_TRANSITION);
      // Bug 22 + Bug 28 — durable persistence of BOTH the new total and
      // the bonus count so a restart / recap / cold REST fetch sees them.
      // Nested jsonb_set rewrites the two keys; the rest of the config
      // blob stays intact.
      try {
        await query(
          `UPDATE sessions
             SET config = jsonb_set(
               jsonb_set(config, '{numberOfRounds}', to_jsonb($2::int), true),
               '{bonusRoundsAdded}', to_jsonb($3::int), true
             )
             WHERE id = $1`,
          [data.sessionId, bumpedRounds, bonusRoundsAdded],
        );
      } catch (err) {
        logger.warn({ err, sessionId: data.sessionId, bumpedRounds, bonusRoundsAdded }, 'Failed to persist bumped numberOfRounds/bonusRoundsAdded to DB — non-fatal (in-memory + Redis still hold the bump)');
      }
      // Bug 22 + Bug 28 — broadcast so EventPlanStrip + any UI showing
      // the round count refetches and renders the new total. The
      // bonusRoundsAdded field lets clients flag bonus rounds without
      // a snapshot refetch.
      io.to(sessionRoom(data.sessionId)).emit('host:event_plan_repaired', {
        sessionId: data.sessionId,
        reason: 'host_request',
        regeneratedRounds: [activeSession.currentRound + 1],
        roundCount: bumpedRounds,
        // totalPairs will catch up on the next plan refetch from EventPlanStrip
        // — the per-round badge query reads matches directly.
        totalPairs: 0,
        bonusRoundsAdded,
      });
      // Phase 2 dual-emit — session + plan entities for every viewer so
      // event-plan / host-state queries refetch in the same tick.
      try {
        const rows = await query<{ user_id: string }>(
          `SELECT user_id FROM session_participants
             WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
          [data.sessionId],
        );
        emitEntities(
          io, rows.rows.map(r => r.user_id),
          [E.session(data.sessionId), E.sessionPlan(data.sessionId)],
        ).catch(() => {});
      } catch { /* dual-emit failure non-fatal */ }
      io.to(sessionRoom(data.sessionId)).emit('session:status_changed', {
        sessionId: data.sessionId,
        status: SessionStatus.ROUND_TRANSITION,
        currentRound: activeSession.currentRound,
      });
    }

    // Phase A1 (10 May spec) — DB is the single source of truth for who can
    // be matched. Pre-fix this code intersected DB eligibility with the
    // in-memory presenceMap; whenever the two diverged (user left but DB
    // status update lagged, OR DB status was stale and presenceMap was
    // empty) the host either saw ghost users in the preview or got a
    // misleading "Not enough participants" error. The state-machine
    // chokepoint now keeps DB status accurate: leave→LEFT, disconnect→
    // DISCONNECTED, both excluded by getEligibleParticipants. So one query
    // covers both checks — count + filter, single source.
    const allHostIds = await getAllHostIds(data.sessionId, activeSession.hostUserId);
    const eligible = await matchingService.getEligibleParticipants(data.sessionId, allHostIds);
    if (eligible.length < 2) {
      socket.emit('error', {
        code: 'INSUFFICIENT_PARTICIPANTS',
        message: `Only ${eligible.length} participant(s) available in main room. Need at least 2 to match.`,
      });
      return;
    }

    const nextRound = activeSession.status === SessionStatus.LOBBY_OPEN
      ? 1
      : activeSession.currentRound + 1;

    // Phase 2.5B (5 May spec compliance) — if a pre-event plan exists for
    // this round (scheduled status, generated at event start by 2.5A's
    // generateSessionSchedule call), surface those matches as the preview
    // instead of running the engine again. The "Generate Matches" button
    // becomes "Show round N preview" (Option B): clicking it pulls the
    // pre-planned matches; pressing Re-match regenerates only this round.
    //
    // Phase K (12 May spec items 3, 4) — the pre-plan must be invalidated
    // when the live eligible set has diverged from the planned set. Late
    // joiners that arrived after the pre-plan was generated wouldn't have
    // been included; using the stale plan would exclude them from this
    // round, which is exactly what Stefan flagged ("matching pre-calculates
    // before host presses Match People"). Also covers the inverse: someone
    // planned-in has left, so the plan would reference a user the engine
    // won't actually match. In both cases we wipe the scheduled pre-plan
    // for this round and fall through to the legacy on-the-fly engine run
    // which uses getEligibleParticipants (DB-authoritative, Phase A1).
    const existingPlanned = await matchingService.getMatchesByRound(data.sessionId, nextRound);
    const hasPrePlan = existingPlanned.some(m => m.status === 'scheduled');
    if (hasPrePlan) {
      // `eligible` is string[] of user IDs (getEligibleParticipants's
      // contract). Wrap directly into the Set without a .map.
      const eligibleIds = new Set<string>(eligible);
      const plannedIds = new Set<string>();
      for (const m of existingPlanned) {
        if (m.status !== 'scheduled') continue;
        plannedIds.add(m.participantAId);
        plannedIds.add(m.participantBId);
        if (m.participantCId) plannedIds.add(m.participantCId);
      }
      const sameSize = eligibleIds.size === plannedIds.size;
      const sameMembers = sameSize && [...eligibleIds].every(id => plannedIds.has(id));

      if (sameMembers) {
        logger.info(
          {
            sessionId: data.sessionId,
            roundNumber: nextRound,
            count: existingPlanned.filter(m => m.status === 'scheduled').length,
          },
          'Phase 2.5B — surfacing pre-planned matches as preview (eligibility unchanged, no engine re-run)',
        );
        activeSession.pendingRoundNumber = nextRound;
        await sendMatchPreview(io, socket, data.sessionId, nextRound, activeSession.hostUserId);
        return;
      }

      // Eligibility has shifted since the pre-plan was generated.
      const addedLateJoiners = [...eligibleIds].filter(id => !plannedIds.has(id));
      const removedLeavers = [...plannedIds].filter(id => !eligibleIds.has(id));
      logger.info(
        {
          sessionId: data.sessionId,
          roundNumber: nextRound,
          addedLateJoiners,
          removedLeavers,
          plannedCount: plannedIds.size,
          eligibleCount: eligibleIds.size,
        },
        'Phase K — pre-plan stale (eligibility shifted), invalidating and regenerating',
      );
      // Scope the DELETE to status='scheduled' so completed/active matches
      // from prior rounds are NEVER touched — the spec requires "preserve
      // already completed rounds" (12 May item 4). pendingRoundNumber by
      // definition exists only during preview phase, so this is safe.
      await query(
        `DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled'`,
        [data.sessionId, nextRound],
      );
      // Fall through to the legacy on-the-fly path — engine will run on
      // the current eligible set (which includes the late joiners).
    }

    // Legacy path — fires for sessions that started before pre-planning was
    // wired in 2.5A, or when the pre-plan failed at event start. Generates
    // matches on-the-fly for this round only.
    //
    // Bug 25 (18 May): 'cancelled' rows are the forensic audit trail from
    // earlier cancel-preview clicks for THIS same round — never wipe them.
    // Only clear pending 'scheduled' state from a prior failed attempt.
    await query(
      `DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled'`,
      [data.sessionId, nextRound]
    );

    // Notify all participants that host is preparing matches
    io.to(sessionRoom(data.sessionId)).emit('session:matching_preparing', {
      sessionId: data.sessionId,
      roundNumber: nextRound,
    });

    // FIX 3B: Matching engine timeout — 60s max to prevent indefinite hangs.
    // Phase A1 (10 May) — no presentUserIds intersection; DB status is the
    // single source of truth via getEligibleParticipants.
    try {
      const matchPromise = matchingService.generateSingleRound(data.sessionId, nextRound, allHostIds);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Matching engine timeout after 60s')), MATCHING_TIMEOUT_MS)
      );
      await Promise.race([matchPromise, timeoutPromise]);

      // Verify the algorithm actually produced pairs. Zero matches usually means
      // every eligible pair has already been matched in a prior round — reject
      // rather than silently presenting an empty preview to the host.
      const generatedMatches = await matchingService.getMatchesByRound(data.sessionId, nextRound);
      if (generatedMatches.length === 0) {
        // Clean up the empty round so the next attempt starts fresh.
        // Bug 25: keep 'cancelled' history; only clear pending 'scheduled'.
        await query(
          `DELETE FROM matches WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled'`,
          [data.sessionId, nextRound]
        );
        socket.emit('error', {
          code: 'NO_ELIGIBLE_PAIRS',
          message: 'All eligible pairs have already been matched in this session. End the event or wait for new participants to join.',
        });
        // Tell participants to clear the preparing overlay
        io.to(sessionRoom(data.sessionId)).emit('session:matching_cancelled', {
          sessionId: data.sessionId,
        });
        return;
      }

      // Store pending round number so confirm_round knows what to start
      activeSession.pendingRoundNumber = nextRound;

      // R7 (20 May 2026 — live-test post-mortem). After fresh-generation
      // for a new round, matches table now has 'scheduled' rows for this
      // round. Invalidate EventPlanStrip for every viewer so the button
      // strip switches from "Pending" to "Planned · N pairs" without F5.
      io.to(sessionRoom(data.sessionId)).emit('host:event_plan_repaired', {
        sessionId: data.sessionId,
        reason: 'host_request',
        regeneratedRounds: [nextRound],
        roundCount: activeSession.config.numberOfRounds,
        totalPairs: 0,
        bonusRoundsAdded: activeSession.config.bonusRoundsAdded ?? 0,
      });
      try {
        const rows = await query<{ user_id: string }>(
          `SELECT user_id FROM session_participants
             WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
          [data.sessionId],
        );
        emitEntities(
          io, rows.rows.map(r => r.user_id),
          [E.session(data.sessionId), E.sessionPlan(data.sessionId)],
        ).catch(() => {});
      } catch { /* dual-emit failure non-fatal */ }

      // Send preview to host only (includes trio support + encounter history)
      await sendMatchPreview(io, socket, data.sessionId, nextRound, activeSession.hostUserId);

      logger.info({ sessionId: data.sessionId, roundNumber: nextRound },
        'Match preview generated for host (legacy on-the-fly path)');
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
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session is not active' });
      return;
    }
    const roundNumber = await resolvePendingRound(activeSession, data.sessionId);
    if (!roundNumber) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'No pending match preview to edit. Click "Match People" first.' });
      return;
    }

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

    // T0-1: validate the resulting matches before UPDATE. The swap is in
    // preview phase (status='scheduled' for both), so we check conflicts
    // against scheduled+active rows; excludeMatchId lets each validation
    // ignore the match it's updating.
    for (const [check, label] of [
      [{ result: newA, matchId: matchA.id }, 'matchA'] as const,
      [{ result: newB, matchId: matchB.id }, 'matchB'] as const,
    ]) {
      const validation = await validateMatchAssignment({
        sessionId: data.sessionId,
        roundNumber,
        participantAId: check.result.a,
        participantBId: check.result.b,
        participantCId: check.result.c,
        excludeMatchId: check.matchId,
        conflictingStatuses: ['scheduled', 'active'],
      });
      if (!validation.valid) {
        socket.emit('error', {
          code: 'INVALID_MATCH_ASSIGNMENT',
          message: `Swap rejected (${label}): ${validation.errors.join('; ')}`,
        });
        return;
      }
    }

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
        // T0-1: validate the resulting pair (the unchanged A/B). This is a
        // safety net — input was valid, so output should be too, but the
        // validator catches drift caused by other handlers writing in
        // parallel since we read userMatch.
        const validation = await validateMatchAssignment({
          sessionId: data.sessionId,
          roundNumber,
          participantAId: userMatch.participantAId,
          participantBId: userMatch.participantBId,
          participantCId: null,
          excludeMatchId: userMatch.id,
          conflictingStatuses: ['scheduled', 'active'],
        });
        if (!validation.valid) {
          socket.emit('error', {
            code: 'INVALID_MATCH_ASSIGNMENT',
            message: `Exclude rejected: ${validation.errors.join('; ')}`,
          });
          return;
        }
        await query('UPDATE matches SET participant_c_id = NULL WHERE id = $1', [userMatch.id]);
      } else if (userMatch.participantCId) {
        // Trio: excluded user is A or B — promote C to fill the gap
        const remaining = [userMatch.participantAId, userMatch.participantBId, userMatch.participantCId]
          .filter(id => id !== data.userId);
        const sorted = remaining.sort();
        // T0-1: validate the resulting pair (B promoted from C, or A/B unchanged with new ordering).
        const validation = await validateMatchAssignment({
          sessionId: data.sessionId,
          roundNumber,
          participantAId: sorted[0]!,
          participantBId: sorted[1] || null,
          participantCId: null,
          excludeMatchId: userMatch.id,
          conflictingStatuses: ['scheduled', 'active'],
        });
        if (!validation.valid) {
          socket.emit('error', {
            code: 'INVALID_MATCH_ASSIGNMENT',
            message: `Exclude rejected: ${validation.errors.join('; ')}`,
          });
          return;
        }
        await query('UPDATE matches SET participant_a_id = $1, participant_b_id = $2, participant_c_id = NULL WHERE id = $3',
          [sorted[0], sorted[1], userMatch.id]);
      } else {
        // Pair: delete the match — the partner becomes a bye participant.
        // No validator needed — DELETE is always safe.
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
    if (!activeSession) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'Session is not active' });
      return;
    }
    const roundNumber = await resolvePendingRound(activeSession, data.sessionId);
    if (!roundNumber) {
      socket.emit('error', { code: 'INVALID_STATE', message: 'No pending match preview to regenerate. Click "Match People" first.' });
      return;
    }

    // Phase 1 (5 May spec) — wipe ALL matches for the pending round before
    // regenerating, regardless of state. Previously this filtered by status
    // IN ('scheduled', 'cancelled') which let confirmed/forced/duplicate
    // rows survive and stack on every Re-match press (root cause of the
    // 3fc21cbb round 4 duplicate-pair bug on 5 May 2026). pendingRoundNumber
    // only exists during the preview phase, so this round is by definition
    // pre-start; nothing live is being clobbered.
    await query(
      `DELETE FROM matches WHERE session_id = $1 AND round_number = $2`,
      [data.sessionId, roundNumber]
    );

    // Re-generate (exclude host + co-hosts from matching). Phase A1 (10 May)
    // — DB status is the single source of truth via getEligibleParticipants
    // inside the matching service; no in-memory presence intersection.
    const allHostIds = await getAllHostIds(data.sessionId, activeSession.hostUserId);
    await matchingService.generateSingleRound(data.sessionId, roundNumber, allHostIds, { regenerate: true });

    // R7 (20 May 2026 — live-test post-mortem). After regenerating a round
    // (e.g. host clicked Re-match on a cancelled Round 3), the matches
    // table has new 'scheduled' rows. Tell EventPlanStrip + every viewer
    // to refetch their plan query so the round button switches from
    // "Cancelled · 4 not matched" to "Planned · N pairs". Pre-fix the
    // strip cache stayed stale because no event_plan_repaired emit fired
    // on this path — only on CLOSING_LOBBY → Another Round bumps and on
    // maybeRepairFutureRounds in host-actions.ts.
    io.to(sessionRoom(data.sessionId)).emit('host:event_plan_repaired', {
      sessionId: data.sessionId,
      reason: 'host_request',
      regeneratedRounds: [roundNumber],
      roundCount: activeSession.config.numberOfRounds,
      totalPairs: 0,
      bonusRoundsAdded: activeSession.config.bonusRoundsAdded ?? 0,
    });
    try {
      const rows = await query<{ user_id: string }>(
        `SELECT user_id FROM session_participants
           WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
        [data.sessionId],
      );
      emitEntities(
        io, rows.rows.map(r => r.user_id),
        [E.session(data.sessionId), E.sessionPlan(data.sessionId)],
      ).catch(() => {});
    } catch { /* dual-emit failure non-fatal */ }

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

    // Phase 2 (29 April 2026 spec) — hard-block force_match when either user
    // is already in another pair for this round. Pre-fix, this handler would
    // SILENTLY cancel the user's existing pair and create a new one, leaving
    // the host's preview screen rearranged with no warning. The user
    // explicitly asked for the system to STOP the action with a clear
    // message naming the conflict, and pointed out that Swap is the right
    // way to move someone between existing pairs:
    //   "one user one room, always. system must stops hosts and tells why."
    // We also check session-wide for any *active* match (i.e. a manual
    // breakout in progress in another round number) so the host can't put
    // someone into a preview pair while they're physically inside another
    // breakout room having a conversation.
    const validation = await validateMatchAssignment({
      sessionId: data.sessionId,
      roundNumber,
      participantAId: normA,
      participantBId: normB,
      conflictingStatuses: ['scheduled', 'active'],
      sessionWideActiveCheck: true,
    });
    if (!validation.valid) {
      const namesResult = await query<{ id: string; displayName: string | null; email: string | null }>(
        `SELECT id, display_name AS "displayName", email FROM users WHERE id = ANY($1)`,
        [validation.conflictingUserIds]
      );
      // Phase 5 (1 May spec) — single-source displayName helper.
      const conflictNames = namesResult.rows.map(r => resolveDisplayName(r.id, r.displayName, r.email));
      const who = conflictNames.length > 0
        ? conflictNames.join(' and ')
        : `${validation.conflictingUserIds.length} participant(s)`;
      const verb = validation.conflictingUserIds.length > 1 ? 'are' : 'is';
      socket.emit('error', {
        code: 'PARTICIPANT_ALREADY_MATCHED',
        message: `${who} ${verb} already in another room. Use Swap to move them between pairs, or move them back to the lobby first.`,
        conflictingUserIds: validation.conflictingUserIds,
      });
      logger.info(
        { sessionId: data.sessionId, userA: normA, userB: normB, conflictingUserIds: validation.conflictingUserIds },
        'Manual force-match rejected: participants already in another room',
      );
      return;
    }

    // No conflicts — safe to create the preview pair (status='scheduled').
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

    // Bug 25 (18 May Ali) — soft-delete on cancel so the proposed round
    // stays in the DB for forensic audit ("what did the engine propose
    // for round N before the host bailed?"). Pre-fix this was a HARD
    // DELETE which destroyed all evidence — Stefan's 18 May test event
    // had a round 4 preview with "met 1x" badges, host cancelled, and
    // nothing remained to debug. Migration 060 widened mig 057's unique
    // pair index to exclude cancelled+no_show so a future regenerate
    // of the same round can re-INSERT the same pair without colliding.
    if (roundNumber) {
      await query(
        `UPDATE matches
           SET status = 'cancelled', ended_at = NOW()
         WHERE session_id = $1 AND round_number = $2 AND status = 'scheduled'`,
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

  // Fetch displayName + email so we can fall back to the email-prefix when
  // displayName is null/empty. Pre-fix the host saw literal "User" everywhere
  // (e.g. "Not matched: User, User" in the match preview, "User × User" in
  // pair tiles) which made the screen useless. Now: displayName → email
  // username → short userId — always something distinguishable per person.
  const namesResult = await query<{ id: string; displayName: string | null; email: string | null }>(
    `SELECT id, display_name AS "displayName", email FROM users WHERE id = ANY($1)`,
    [Array.from(allUserIds)]
  );
  // Phase 5 (1 May spec) — single-source displayName helper.
  const nameMap = new Map(namesResult.rows.map(r => [r.id, resolveDisplayName(r.id, r.displayName, r.email)]));

  // Bug 5 (18 May Stefan) — "met before" badge must reflect the session's
  // matching POLICY, not always lifetime. Three policies exist:
  //   - 'platform_wide'   → strict: pair must never have met anywhere on RSN.
  //                         Host needs the lifetime count so they can SEE
  //                         when the engine is forced into a fallback that
  //                         breaks the rule.
  //   - 'within_event'    → default: in-event no-rematch only. Lifetime
  //                         repeats are EXPECTED and not noteworthy; badge
  //                         should count THIS event's prior rounds only.
  //   - 'none'            → no constraint. Same as within_event for badge
  //                         purposes (host still wants to know who's a
  //                         repeat within this run).
  // Choosing per-policy keeps the badge meaningful: under within_event a
  // 'met one time' badge means "they paired earlier in this very event,"
  // not "they crossed paths months ago elsewhere."
  const sessionServiceForPreview = await import('../../session/session.service');
  const previewSession = await sessionServiceForPreview.getSessionById(sessionId).catch(() => null);
  const previewSessionConfig: any = previewSession
    ? (typeof previewSession.config === 'string'
        ? JSON.parse(previewSession.config as unknown as string)
        : previewSession.config)
    : null;
  const previewPolicy = matchingService.resolveMatchingPolicy(previewSessionConfig);
  const userIdsArray = Array.from(allUserIds);
  const encounterMap = new Map<string, number>();
  const bump = (a: string, b: string, n = 1) => {
    const key = [a, b].sort().join(':');
    encounterMap.set(key, (encounterMap.get(key) || 0) + n);
  };
  if (previewPolicy === 'platform_wide') {
    // Lifetime — host needs to see the strict-rule signal.
    const lifetimeRes = userIdsArray.length > 0
      ? await query<{ user_a_id: string; user_b_id: string; times_met: number }>(
          `SELECT user_a_id, user_b_id, times_met
           FROM encounter_history
           WHERE user_a_id = ANY($1) AND user_b_id = ANY($1) AND times_met > 0`,
          [userIdsArray]
        )
      : { rows: [] };
    for (const e of lifetimeRes.rows) {
      bump(e.user_a_id, e.user_b_id, e.times_met);
    }
  } else {
    // within_event or none — scope to THIS event's prior rounds.
    const inEventRes = userIdsArray.length > 0
      ? await query<{ participant_a_id: string; participant_b_id: string; participant_c_id: string | null }>(
          `SELECT participant_a_id, participant_b_id, participant_c_id
           FROM matches
           WHERE session_id = $1
             AND round_number < $2
             AND status NOT IN ('cancelled')
             AND is_manual = FALSE`,
          [sessionId, roundNumber]
        )
      : { rows: [] };
    for (const e of inEventRes.rows) {
      bump(e.participant_a_id, e.participant_b_id);
      if (e.participant_c_id) {
        bump(e.participant_a_id, e.participant_c_id);
        bump(e.participant_b_id, e.participant_c_id);
      }
    }
  }

  // Defensive fallback if a user appears in matches but somehow not in nameMap
  // (race between query and DB write — extremely rare, kept for safety).
  const safeName = (uid: string): string => nameMap.get(uid) || placeholderName(uid);

  const matchPreview = matches.map(m => {
    const pairKey = [m.participantAId, m.participantBId].sort().join(':');
    const timesMet = encounterMap.get(pairKey) || 0;
    const preview: any = {
      participantA: { userId: m.participantAId, displayName: safeName(m.participantAId) },
      participantB: { userId: m.participantBId, displayName: safeName(m.participantBId) },
      metBefore: timesMet > 0,
      timesMet,
    };
    if (m.participantCId) {
      preview.participantC = { userId: m.participantCId, displayName: safeName(m.participantCId) };
      preview.isTrio = true;
    }
    return preview;
  });

  // Exclude host from bye list — host stays in lobby, not a "bye"
  //
  // Bug 4 (18 May Stefan) — bye list now uses the same broader filter as
  // matching eligibility so the headline count, matched set, and "not
  // matched" set all reconcile. Pre-fix: a user with status='disconnected'
  // was counted in the lobby header (NOT IN 'removed/left/no_show') but
  // appeared in NEITHER matched nor bye list — silently vanishing. Stefan:
  // "Room showed 10 or 11 participants but only 8 matched."
  const allParticipants = hostUserId
    ? await query<{ user_id: string }>(
        `SELECT user_id FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')
           AND user_id != $2`,
        [sessionId, hostUserId]
      )
    : await query<{ user_id: string }>(
        `SELECT user_id FROM session_participants WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
        [sessionId]
      );
  // byeParticipants list shows up in the host UI as "Not matched: X, Y, Z" —
  // the placeholder bug ("Not matched: User, User") was caused by missing
  // display names. We re-fetch names for any bye-only users not already in
  // nameMap so they always render with a real label.
  const matchedIds = new Set(matches.flatMap(m => [m.participantAId, m.participantBId, ...(m.participantCId ? [m.participantCId] : [])]));
  const byeUserIds = allParticipants.rows.map(p => p.user_id).filter(uid => !matchedIds.has(uid));
  const byeNamesNeeded = byeUserIds.filter(uid => !nameMap.has(uid));
  if (byeNamesNeeded.length > 0) {
    const byeNamesResult = await query<{ id: string; displayName: string | null; email: string | null }>(
      `SELECT id, display_name AS "displayName", email FROM users WHERE id = ANY($1)`,
      [byeNamesNeeded]
    );
    for (const r of byeNamesResult.rows) {
      nameMap.set(r.id, resolveDisplayName(r.id, r.displayName, r.email));
    }
  }
  // Bug B (15 May Shraddha) — surface WHY a participant was excluded from
  // matching. Acting cohosts (session_cohosts member OR Phase M opt-in via
  // session_participants.acting_as_host = true) are filtered out of the
  // matching engine by policy, not because no partner was available. The
  // host UI used to just list their name with no reason, which looked like a
  // matching failure. Now each bye row carries an optional reason string so
  // the host sees "Shradha's Personal A/C (acting as host)".
  const cohostRoleRows = byeUserIds.length > 0
    ? await query<{ user_id: string; acting_as_host: boolean | null; is_cohost: boolean }>(
        `SELECT sp.user_id,
                sp.acting_as_host,
                EXISTS (
                  SELECT 1 FROM session_cohosts sc
                   WHERE sc.session_id = sp.session_id AND sc.user_id = sp.user_id
                ) AS is_cohost
           FROM session_participants sp
          WHERE sp.session_id = $1 AND sp.user_id = ANY($2)`,
        [sessionId, byeUserIds],
      )
    : { rows: [] };
  const roleByUserId = new Map<string, { actingAsHost: boolean | null; isCohost: boolean }>();
  for (const r of cohostRoleRows.rows) {
    roleByUserId.set(r.user_id, { actingAsHost: r.acting_as_host, isCohost: r.is_cohost });
  }
  const byeParticipants = byeUserIds.map(uid => {
    const role = roleByUserId.get(uid);
    // Resolution mirrors the snapshot's hostsSet: opt-out beats cohost role,
    // opt-in beats no-cohost-row. Anyone landing here as "acting as host" was
    // excluded by the matching engine on purpose.
    const actingAsHost =
      role?.actingAsHost === false ? false
      : role?.actingAsHost === true ? true
      : !!role?.isCohost;
    return {
      userId: uid,
      displayName: safeName(uid),
      reason: actingAsHost ? 'acting as host' : undefined,
    };
  });

  // Generate warnings when multiple participants have byes (unique pairs likely exhausted).
  // Filter out acting-host byes since their exclusion is intentional — they
  // shouldn't trigger the "no fresh pairs available" warning.
  const roundWarnings: string[] = [];
  const policyByes = byeParticipants.filter(p => !p.reason);
  if (policyByes.length > 1) {
    roundWarnings.push(`All participants have already met — ${policyByes.length} will sit this round out. Need new participants for fresh matches.`);
  }

  socket.emit('host:match_preview', {
    roundNumber,
    matches: matchPreview,
    byeParticipants,
    ...(roundWarnings.length > 0 && { warnings: roundWarnings }),
  });
}

// ─── Host Round Dashboard ─────────────────────────────────────────────────
//
// Tier-1 A1 (April 20) — the dashboard emit is the hottest fan-out path in
// the server. It fires on every match transition + a 5-sec interval during
// ROUND_ACTIVE + a 5-sec interval during LOBBY_OPEN when manual rooms are
// live. At 200 users / 100 matches each call = 3 DB round-trips including a
// NOT EXISTS subquery. Pre-fix, bursts during round transitions saturated
// the Neon pooler and blocked the event loop.
//
// Two behavior-preserving optimisations:
//
// 1. COALESCE to max 1 emit/sec per session. Rapid calls (transition +
//    interval tick + host action overlapping) fold into a single leading
//    emit + trailing emit. Host sees the same data just without the thrash.
//
// 2. CACHE display names on ActiveSession.displayNameCache. Names don't
//    change mid-event. On first emit we bulk-fetch uncached ids; subsequent
//    emits hit the cache (O(n) map lookups, no DB). Cache is tied to the
//    ActiveSession lifecycle — cleared automatically on completeSession.

const DASHBOARD_COALESCE_MS = 1000;

interface DashboardEmitState {
  lastEmit: number;      // epoch ms of the last immediate emit
  pendingTimer: NodeJS.Timeout | null; // trailing-edge timer
}

const dashboardEmitState = new Map<string, DashboardEmitState>();

/** Reset coalesce state for a session — call from completeSession / cleanup. */
export function clearDashboardCoalesce(sessionId: string): void {
  const state = dashboardEmitState.get(sessionId);
  if (state?.pendingTimer) clearTimeout(state.pendingTimer);
  dashboardEmitState.delete(sessionId);
}

export async function emitHostDashboard(io: SocketServer, sessionId: string): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession || !io) return;

  const now = Date.now();
  const state = dashboardEmitState.get(sessionId) || { lastEmit: 0, pendingTimer: null };
  const elapsed = now - state.lastEmit;

  if (elapsed >= DASHBOARD_COALESCE_MS) {
    // Leading edge — fire immediately. Cancel any pending trailing emit
    // since we're firing a fresh one right now.
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
    state.lastEmit = now;
    dashboardEmitState.set(sessionId, state);
    return emitHostDashboardImmediate(io, sessionId);
  }

  // Within coalesce window — schedule a trailing emit if not already queued.
  if (!state.pendingTimer) {
    const delay = DASHBOARD_COALESCE_MS - elapsed;
    state.pendingTimer = setTimeout(() => {
      const s = dashboardEmitState.get(sessionId);
      if (!s) return; // session ended during window
      s.lastEmit = Date.now();
      s.pendingTimer = null;
      emitHostDashboardImmediate(io, sessionId).catch(err =>
        logger.warn({ err, sessionId }, 'Trailing emitHostDashboard failed'),
      );
    }, delay);
    dashboardEmitState.set(sessionId, state);
  }
  // else: trailing already scheduled — nothing to do, caller's event folds
  // into the pending emit.
}

/**
 * Phase 8 (1 May 2026 spec) — bypass the 1-second coalesce. Used when a
 * host action just completed; the host's own click should refresh their
 * dashboard with no perceptible delay. Other transitions (auto round-end,
 * participant heartbeat) keep using the coalesced emitHostDashboard.
 */
export async function emitHostDashboardForce(io: SocketServer, sessionId: string): Promise<void> {
  const state = dashboardEmitState.get(sessionId);
  if (state) {
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
    state.lastEmit = Date.now();
    dashboardEmitState.set(sessionId, state);
  }
  return emitHostDashboardImmediate(io, sessionId);
}

/**
 * Phase 8 (1 May spec) — emit a per-action confirmation to the host so the
 * dashboard can render a transient toast + audit-strip entry. Stefan: 'Host
 * controls — missing: clarity of effect, confirmation of action, visibility
 * of system state.'
 *
 * Goes to the host's userRoom only (other participants don't need to see
 * "host clicked X"). Pair with emitHostDashboardForce so the dashboard
 * state and the toast land in the same render frame.
 */
export function emitHostActionConfirmed(
  io: SocketServer,
  sessionId: string,
  hostUserId: string,
  payload: { action: string; summary: string; target?: string | null },
): void {
  if (!io || !hostUserId) return;
  io.to(userRoom(hostUserId)).emit('host:action_confirmed', {
    sessionId,
    action: payload.action,
    summary: payload.summary,
    target: payload.target ?? null,
    timestamp: new Date().toISOString(),
  });
}

async function emitHostDashboardImmediate(io: SocketServer, sessionId: string): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession || !io) return;

  try {
    const matches = await matchingService.getMatchesByRound(sessionId, activeSession.currentRound);

    // Look up display names for all participant IDs — use per-session cache
    // (Tier-1 A1) to skip the DB round-trip for names we've already fetched
    // during this event. Names are stable for the session lifetime.
    const allUserIds = new Set<string>();
    for (const m of matches) {
      allUserIds.add(m.participantAId);
      allUserIds.add(m.participantBId);
      if (m.participantCId) allUserIds.add(m.participantCId);
    }
    // Also include presence + host so bye-participant rendering has names
    for (const uid of activeSession.presenceMap.keys()) allUserIds.add(uid);

    if (!activeSession.displayNameCache) activeSession.displayNameCache = new Map();
    const cache = activeSession.displayNameCache;
    const missingIds: string[] = [];
    for (const uid of allUserIds) {
      if (!cache.has(uid)) missingIds.push(uid);
    }

    if (missingIds.length > 0) {
      // Fetch email alongside displayName so the fallback chain
      // (displayName → email-prefix → "Participant {short_id}") produces a
      // distinguishable label per person. Pre-fix, missing display_names
      // collapsed to literal "User" and the host dashboard rendered
      // "User × User" / "Not matched: User, User" — confusing and useless.
      const nameResult = await query<{ id: string; displayName: string | null; email: string | null }>(
        `SELECT id, display_name AS "displayName", email FROM users WHERE id = ANY($1)`,
        [missingIds]
      );
      // Phase 5 (1 May spec) — single-source displayName helper.
      for (const row of nameResult.rows) cache.set(row.id, resolveDisplayName(row.id, row.displayName, row.email));
      // Negative-cache misses so we don't re-query a user we couldn't find at
      // all. Use a userId-derived label so they remain distinguishable.
      for (const uid of missingIds) if (!cache.has(uid)) cache.set(uid, placeholderName(uid));
    }
    const nameMap = cache;
    const safeName = (uid: string): string => nameMap.get(uid) || placeholderName(uid);

    // Bug 18 (April 19) — per-room manual timer in dashboard payload.
    // Each manual room has its own RoomTimerState in the roomTimers Map
    // (host-actions.ts). Surface that endsAt + duration in the dashboard
    // so the host UI can render a per-room timer (or detect "all share
    // the same duration" and render a column header timer).
    const { roomTimers } = await import('./host-actions');

    // T0-2 (Issue 7) — choose presence source for isConnected.
    // ROOM_JOINED requires the participant's LiveKit client to have emitted
    // presence:room_joined after a successful room.connect(). Falls back to
    // socket presence (legacy) if the feature flag is off OR if the
    // session pre-dates the upgrade (no roomParticipants map yet).
    const requireRoomJoined = process.env.BREAKOUT_REQUIRE_ROOM_JOINED !== 'false';
    const isConnectedFor = (uid: string): boolean => {
      if (requireRoomJoined && activeSession.roomParticipants) {
        return activeSession.roomParticipants.has(uid);
      }
      return activeSession.presenceMap.has(uid);
    };

    const rooms = matches
      .filter(m => m.status === 'active')
      .map(m => {
        const participants: { userId: string; displayName: string; isConnected: boolean }[] = [];
        if (m.participantAId) {
          participants.push({
            userId: m.participantAId,
            displayName: safeName(m.participantAId),
            isConnected: isConnectedFor(m.participantAId),
          });
        }
        if (m.participantBId) {
          participants.push({
            userId: m.participantBId,
            displayName: safeName(m.participantBId),
            isConnected: isConnectedFor(m.participantBId),
          });
        }
        if (m.participantCId) {
          participants.push({
            userId: m.participantCId,
            displayName: safeName(m.participantCId),
            isConnected: isConnectedFor(m.participantCId),
          });
        }
        const isManual = m.isManual === true;
        // Per-room timer (manual rooms only — algorithm rooms share the
        // session-level round timer at the dashboard's `timerEndsAt`).
        const roomTimer = isManual ? roomTimers.get(m.id) : undefined;
        // Bug 20 (April 19) — also send roomSecondsRemaining (relative)
        // so the client computes a CLOCK-SKEW-IMMUNE local endsAt
        // (clientNow + secondsRemaining*1000). Sending only the absolute
        // ISO endsAt produces visible drift between host and participant
        // when their machine clocks differ from the server (same root
        // cause as Bug 16 for the algorithm round timer).
        const roomSecondsRemaining = roomTimer
          ? Math.max(0, Math.ceil((roomTimer.endsAt.getTime() - Date.now()) / 1000))
          : null;
        return {
          matchId: m.id,
          roomId: m.roomId || '',
          status: m.status,
          participants,
          isTrio: !!m.participantCId,
          isManual,
          // Manual-room-only fields. null when the manual room has no
          // timer (host chose "no limit") or when this is an algorithm room.
          roomEndsAt: roomTimer ? roomTimer.endsAt.toISOString() : null,
          roomStartedAt: roomTimer ? roomTimer.startedAt.toISOString() : null,
          roomSecondsRemaining,
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
          displayName: safeName(userId),
        });
      }
    }

    // Bug 8.6 (April 19) — when paused, timerEndsAt is null. Use the frozen
    // pausedTimeRemaining (ms) instead so the host display has a sane value
    // to render if it ever consumes the dashboard's timerSecondsRemaining.
    const timerSecondsRemaining = activeSession.timerEndsAt
      ? Math.max(0, Math.ceil((activeSession.timerEndsAt.getTime() - Date.now()) / 1000))
      : activeSession.pausedTimeRemaining
      ? Math.max(0, Math.ceil(activeSession.pausedTimeRemaining / 1000))
      : 0;

    // Count of main-room participants eligible for the next algorithm round.
    // Excludes host AND anyone already in an active match (manual or algorithm).
    // Used by the client to enable/disable the "Match People" button.
    const eligibleMainRoomRes = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM session_participants sp
       WHERE sp.session_id = $1
         AND sp.status NOT IN ('removed', 'left', 'no_show')
         AND sp.user_id != $2
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE m.session_id = $1 AND m.status = 'active'
             AND (m.participant_a_id = sp.user_id OR m.participant_b_id = sp.user_id OR m.participant_c_id = sp.user_id)
         )`,
      [sessionId, activeSession.hostUserId],
    );
    const eligibleMainRoomCount = parseInt(eligibleMainRoomRes.rows[0]?.c || '0', 10);

    // Phase 8A.2 (8 May spec) — Stefan #2: also surface how many of
    // those eligible-by-DB are actually CONNECTED right now. Lets the
    // host see the gap (e.g. "5 in main room out of 7 registered").
    const presenceSet = activeSession.presenceMap;
    const presentMainRoomCount = (await query<{ user_id: string }>(
      `SELECT sp.user_id FROM session_participants sp
       WHERE sp.session_id = $1
         AND sp.status NOT IN ('removed', 'left', 'no_show')
         AND sp.user_id != $2
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE m.session_id = $1 AND m.status = 'active'
             AND (m.participant_a_id = sp.user_id OR m.participant_b_id = sp.user_id OR m.participant_c_id = sp.user_id)
         )`,
      [sessionId, activeSession.hostUserId],
    )).rows.filter(r => presenceSet.has(r.user_id)).length;

    // Phase 7C.1 — backing data for the Host Control Center drawer.
    // Same query cadence as the dashboard, so opening the drawer never
    // shows stale state.
    let participants: Awaited<ReturnType<typeof buildHostParticipantsView>> = [];
    try {
      participants = await buildHostParticipantsView({
        sessionId,
        hostUserId: activeSession.hostUserId,
        presenceMap: activeSession.presenceMap,
        activeMatches: matches,
      });
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to build host participants view');
    }

    // Bug F (15 May Ali) — fan out the dashboard to EVERY acting host, not
    // just the original director. Pre-fix `io.to(userRoom(hostUserId))`
    // only delivered to the event director; co-hosts and admins who opted
    // in via Phase M never received the 5-second refresh, so opening HCC
    // showed an empty roster + "0 host" headline until they reloaded the
    // tab. getAllHostIds returns director + session_cohosts + opt-ins
    // minus opt-outs — the same set canActAsHost accepts.
    const dashboardPayload = {
      roundNumber: activeSession.currentRound,
      rooms,
      byeParticipants,
      timerSecondsRemaining,
      // Bug 8.5: send endsAt so the host dashboard computes its display
      // from the SAME source as participant tiles. Was: dashboard refreshed
      // every 5s with a server-computed snapshot while participants
      // decremented locally → host always showed MORE time than participants.
      timerEndsAt: activeSession.timerEndsAt ? activeSession.timerEndsAt.toISOString() : null,
      eligibleMainRoomCount,
      presentMainRoomCount,
      reassignmentInProgress: false,
      participants,
    };
    const hostIds = await getAllHostIds(sessionId, activeSession.hostUserId).catch(() => [
      activeSession.hostUserId,
    ]);
    for (const hostId of hostIds) {
      io.to(userRoom(hostId)).emit('host:round_dashboard', dashboardPayload);
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to emit host dashboard');
  }
}
