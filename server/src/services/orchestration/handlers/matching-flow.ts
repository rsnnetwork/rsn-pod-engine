// ─── Matching Flow ─────────────────────────────────────────────────────────
// Extracted from orchestration.service.ts — all matching-related socket handlers:
// generate-matches, confirm-round, swap-match, exclude-from-round,
// regenerate-matches, cancel-preview, plus internal helpers sendMatchPreview
// and emitHostDashboard.
//
// Match generation (generate/regenerate previews) is wrapped with the
// dedicated withMatchGenerationLock to serialise against the background
// auto-repair paths (late-joiner/leaver/reconciler), preventing concurrent
// regenerations from clobbering each other's pairing. That lock is separate
// from the presence guard (withSessionGuard) so a long matching run never
// blocks joins/leaves.
//
// Critical fixes included:
// - FIX 3A: pendingRoundNumber cleared AFTER successful transition (not before)
// - FIX 3B: Matching engine 60s timeout to prevent indefinite hangs

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../../config/logger';
import { query } from '../../../db';
import { SessionStatus, resolveDisplayName, placeholderName } from '@rsn/shared';
import {
  ActiveSession, activeSessions, withMatchGenerationLock,
  sessionRoom, userRoom, persistSessionState,
} from '../state/session-state';
import { verifyHost, getAllHostIds } from './host-actions';
import * as matchingService from '../../matching/matching.service';
import { pairKey } from '../../matching/matching.interface';
import { validateMatchAssignment } from '../../matching/match-validator.service';
// 23 May — match-time presence reconcile routes status resets through the chokepoint.
import { transitionParticipant, ParticipantState } from '../state/participant-state-machine';
// Phase 7C.1 (7 May spec) — backing data for the Host Control Center drawer.
import { buildHostParticipantsView } from './host-participants-view';
// Phase 2 (19 May 2026) — realtime migration dual-emit. The host:event_plan_*
// broadcast in this module gets a sibling emitEntities() call. See:
//   docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
import { emitEntities } from '../../../realtime/emit';
import { E } from '../../../realtime/entities';
// Phase 5 — flag-gated versioned snapshot co-emit.
import { emitStateSnapshot } from '../state/state-snapshot';

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

/**
 * 27 May — the authoritative "who is in the main room right now" set, used to
 * gate matching + manual room assignment so a registered-but-absent participant
 * (accepted the invite but never joined, or was here and left) is never matched.
 * Union of three signals: live session-room sockets, heartbeat-fresh presenceMap,
 * and the LiveKit lobby roster (the video presence that renders the host's tiles —
 * survives a backgrounded tab / blip the 15s heartbeat doesn't). Host/co-hosts are
 * NOT removed here — downstream excludeUserIds handles that. The LiveKit lookup
 * fails open in its own try/catch + 4s timeout.
 */
export async function getPresentUserIds(
  io: SocketServer,
  sessionId: string,
  activeSession: ActiveSession,
): Promise<Set<string>> {
  const present = new Set<string>();
  try {
    const socketsInRoom = await io.in(sessionRoom(sessionId)).fetchSockets();
    for (const s of socketsInRoom) {
      const uid = (s.data as any)?.userId;
      if (uid) present.add(uid);
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'getPresentUserIds: fetchSockets failed (non-fatal)');
  }
  for (const uid of activeSession.presenceMap.keys()) present.add(uid);
  // Ship B — canonical connState as a 4th union source. The function stays a
  // defense-in-depth UNION (each signal alone has gaps); canonical brings the
  // webhook/sweep-maintained server truth that survives restarts.
  try {
    const { getCanonicalConnectedSet } = await import('../state/canonical-state');
    const canonConnected = await getCanonicalConnectedSet(sessionId);
    if (canonConnected) for (const uid of canonConnected) present.add(uid);
  } catch { /* non-fatal — remaining signals stand */ }
  try {
    const sessionForRoom = await (await import('../../session/session.service')).getSessionById(sessionId);
    if (sessionForRoom?.lobbyRoomId) {
      const videoSvc = await import('../../video/video.service');
      const roster = await Promise.race([
        videoSvc.listParticipants(sessionForRoom.lobbyRoomId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('listParticipants timeout')), 4000)),
      ]);
      for (const p of roster) if (p.userId) present.add(p.userId);
    }
  } catch (lkErr) {
    logger.warn({ err: lkErr, sessionId },
      'getPresentUserIds: LiveKit roster lookup failed (non-fatal, using socket/heartbeat presence)');
  }
  return present;
}

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

// 23 May (#10/#5b) — the set of pair keys already used by OTHER rounds of this
// session (the engine's within-event no-repeat history). Mirrors the exclusion
// query in matching.service.generateSingleRound EXACTLY (other rounds,
// non-cancelled, non-manual) so the handler's "is this a repeat?" check agrees
// with what the engine would exclude. Used to (a) detect a pre-plan gone stale
// because an earlier round was swapped, and (b) verify a forced Re-match stayed
// fresh.
async function priorRoundPairKeys(sessionId: string, exceptRound: number): Promise<Set<string>> {
  const res = await query<{ participant_a_id: string; participant_b_id: string; participant_c_id: string | null }>(
    `SELECT participant_a_id, participant_b_id, participant_c_id FROM matches
       WHERE session_id = $1 AND round_number != $2
         AND status NOT IN ('cancelled', 'no_show')
         AND is_manual = FALSE`,
    [sessionId, exceptRound],
  );
  const keys = new Set<string>();
  for (const r of res.rows) {
    keys.add(pairKey(r.participant_a_id, r.participant_b_id));
    if (r.participant_c_id) {
      keys.add(pairKey(r.participant_a_id, r.participant_c_id));
      keys.add(pairKey(r.participant_b_id, r.participant_c_id));
    }
  }
  return keys;
}

// Pair keys for a single round's matches (each pair, plus the three edges of a trio).
function arrangementPairKeys(ms: { participantAId: string; participantBId: string; participantCId?: string | null }[]): string[] {
  const keys: string[] = [];
  for (const m of ms) {
    keys.push(pairKey(m.participantAId, m.participantBId));
    if (m.participantCId) {
      keys.push(pairKey(m.participantAId, m.participantCId));
      keys.push(pairKey(m.participantBId, m.participantCId));
    }
  }
  return keys;
}

// #14 (23 May, Ali) — after the host edits the CURRENT preview round (swap,
// exclude, re-match), re-plan the rounds AFTER it so the EVENT PLAN strip's
// future rounds (and the no-repeat journey) update live, instead of only when
// that round is later opened. Repairs from previewedRound+1 so the host's edit
// to the previewed round itself is preserved; repairFutureRounds only rewrites
// 'scheduled' rounds >= fromRound (active/completed are immutable). Non-fatal.
async function replanRoundsAfterPreviewEdit(
  io: SocketServer,
  sessionId: string,
  previewedRound: number,
): Promise<void> {
  try {
    // 27 May — replan against the LIVE present-in-main set so the regenerated
    // future rounds (and the Event Plan strip that renders them) mirror what
    // the presence-gated engine would actually produce — never a stale roster.
    const replanSession = activeSessions.get(sessionId);
    const presentUserIds = replanSession
      ? await getPresentUserIds(io, sessionId, replanSession)
      : undefined;
    const result = await matchingService.repairFutureRounds(sessionId, previewedRound + 1, 'host_request', presentUserIds);
    if (result.regeneratedRounds.length === 0) return;
    io.to(sessionRoom(sessionId)).emit('host:event_plan_repaired', {
      sessionId,
      reason: 'host_request',
      regeneratedRounds: result.regeneratedRounds,
    });
    const rows = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants
         WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
      [sessionId],
    );
    emitEntities(
      io, rows.rows.map(r => r.user_id),
      [E.session(sessionId), E.sessionPlan(sessionId)],
    ).catch(() => {});
  } catch (err) {
    logger.warn({ err, sessionId, previewedRound }, '#14 replan after preview edit failed (non-fatal)');
  }
}

// ─── Host Generate Matches (preview step) ──────────────────────────────────

export async function handleHostGenerateMatches(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string }
): Promise<void> {
  // Authorize BEFORE taking the match-generation lock — otherwise any socket
  // could queue unauthorized / no-op host:generate_matches calls ahead of
  // legitimate match writes. verifyHost is cheap and lock-independent.
  if (!await verifyHost(socket, data.sessionId)) return;
  // Serialize match generation per session against the auto-repair paths
  // (late-joiner/leaver/reconciler) so a host's preview generation and a
  // background regeneration can't read the same eligible set and clobber
  // each other's pairing. Dedicated match-generation lock — must NOT block
  // joins/leaves, otherwise a participant arriving during this (up to 60s)
  // run would be queued behind it and missing from the generated preview.
  return withMatchGenerationLock(data.sessionId, async () => {
  try {
    // Re-verify after acquiring the lock: this request may have waited behind
    // another long match-generation job, during which the caller could have
    // lost host/co-host privileges (TOCTOU). The pre-lock check above only
    // gates queuing; this one gates the actual write.
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
    // 23 May (Stefan live test) — the round-count bump MOVED to actual round
    // start (transitionToRound). Pre-fix, opening a bonus-round preview here
    // optimistically bumped numberOfRounds (+bonusRoundsAdded) BEFORE the round
    // ran; if the host then cancelled or ended, the count stayed inflated and
    // the recap read "3 of 4" for a round that never happened. Now we only
    // re-open the preview phase here; the bump happens when the host actually
    // Confirms -> Starts the round.
    if (activeSession.status === SessionStatus.CLOSING_LOBBY) {
      const { clearSessionTimers } = await import('./timer-manager');
      const sessionService = await import('../../session/session.service');
      clearSessionTimers(data.sessionId);
      activeSession.status = SessionStatus.ROUND_TRANSITION;
      await sessionService.updateSessionStatus(data.sessionId, SessionStatus.ROUND_TRANSITION);
      // 23 May — refresh the host's plan strip so it picks up the new preview
      // round. No round-count bump here (moved to round start), so the strip
      // shows the current total until the bonus round is actually started.
      io.to(sessionRoom(data.sessionId)).emit('host:event_plan_repaired', {
        sessionId: data.sessionId,
        reason: 'host_request',
        regeneratedRounds: [activeSession.currentRound + 1],
        roundCount: activeSession.config.numberOfRounds,
        bonusRoundsAdded: activeSession.config.bonusRoundsAdded ?? 0,
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

    // Phase A1 (10 May) — DB status is the source of truth for matching.
    // 23 May (Stefan live test) — but a transient socket/heartbeat blip (a
    // phone locking, a tab backgrounding, a Wi-Fi hiccup) flags a still-present
    // participant 'disconnected'. The host's room count includes 'disconnected'
    // while getEligibleParticipants excludes it, so present people went
    // unmatched — the host saw "4 in room" but got a trio/pair, and only a full
    // browser refresh fixed it. Reconcile first: anyone whose socket is live in
    // the room right now (or has a fresh heartbeat in presenceMap) has their
    // stale 'disconnected' cleared, so eligibility equals what the host sees.
    const allHostIds = await getAllHostIds(data.sessionId, activeSession.hostUserId);

    // 27 May — compute the live "present in main room" set ONCE (sockets +
    // heartbeat + LiveKit lobby roster). Used to (a) reconcile any present-but-
    // 'disconnected' rows so DB status matches what the host sees, and (b) gate
    // eligibility + the engine run below so a registered-but-absent participant
    // (e.g. accepted the invite, never joined) is never matched.
    const presentUserIds = await getPresentUserIds(io, data.sessionId, activeSession);
    try {
      if (presentUserIds.size > 0) {
        const stale = await query<{ user_id: string }>(
          `SELECT user_id FROM session_participants
             WHERE session_id = $1 AND status = 'disconnected' AND user_id = ANY($2)`,
          [data.sessionId, Array.from(presentUserIds)],
        );
        for (const r of stale.rows) {
          await transitionParticipant(data.sessionId, r.user_id, ParticipantState.IN_MAIN_ROOM);
        }
        if (stale.rows.length > 0) {
          logger.info({ sessionId: data.sessionId, reconciled: stale.rows.length },
            'Reconciled present-but-disconnected participants before matching');
        }
      }
    } catch (err) {
      logger.warn({ err, sessionId: data.sessionId }, 'Presence reconcile before matching failed (non-fatal)');
    }

    const eligible = await matchingService.getEligibleParticipants(data.sessionId, allHostIds, presentUserIds);
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

      // 23 May (#10) — membership equality is NOT enough. If the host swapped
      // an EARLIER round after this pre-plan was generated, the planned pairs
      // can now repeat that round (R2 swapped → R3's pre-plan duplicates R2)
      // even though the same people are in the round. The eligibility check
      // misses this (member set unchanged), so the stale repeating pre-plan was
      // surfaced verbatim ("Met 1x"). Detect it and route through the same
      // wipe-and-regenerate path so the engine produces a fresh arrangement.
      const priorKeys = await priorRoundPairKeys(data.sessionId, nextRound);
      const planRepeatsPriorRound = priorKeys.size > 0 &&
        arrangementPairKeys(existingPlanned.filter(m => m.status === 'scheduled'))
          .some(k => priorKeys.has(k));

      // #A (26 May, Ali) — platform_wide must NEVER surface the pre-plan. The
      // pre-plan (generateSessionSchedule) does NOT apply the cross-event HARD
      // exclusion that the live engine (generateSingleRound) does, so it can
      // surface "Met 1×" pairs that Re-match (live) would exclude — the exact
      // "met first, fresh on re-match" Ali saw. Route platform_wide through the
      // regenerate path so "Match People" runs the live engine with the same
      // relaxable cross-event exclusion + fallback ladder, fresh on the first
      // click. (within_event/none load no cross-event history, so the pre-plan
      // is already correct for them — keep their instant-surface path.)
      const matchingPolicy = matchingService.resolveMatchingPolicy(activeSession.config);
      const canSurfacePrePlan = sameMembers && !planRepeatsPriorRound && matchingPolicy !== 'platform_wide';

      if (canSurfacePrePlan) {
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
        // 27 May — re-sync the rest of the plan to the LIVE present roster so
        // the Event Plan strip mirrors the presence-gated engine, not the
        // roster the pre-plan was built for (non-fatal, replans scheduled only).
        await replanRoundsAfterPreviewEdit(io, data.sessionId, nextRound);
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
          planRepeatsPriorRound,
        },
        'Phase K / #10 — pre-plan stale (eligibility shift or now-repeating after an earlier-round edit), invalidating and regenerating',
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
      const matchPromise = matchingService.generateSingleRound(data.sessionId, nextRound, allHostIds, undefined, presentUserIds);
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
      // 27 May — re-sync the remaining scheduled rounds to the LIVE present
      // roster so the Event Plan strip mirrors the presence-gated engine.
      await replanRoundsAfterPreviewEdit(io, data.sessionId, nextRound);

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
  });
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

    // T0-1: validate the resulting matches before UPDATE. 23 May (Stefan live
    // test) — a swap rewrites BOTH rooms, so each validation must exclude both
    // matchA and matchB. Pre-fix it excluded only the room being checked, so
    // the swap-partner still sitting in the other room read as "already in
    // another match" and every two-room swap was rejected.
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
        excludeMatchIds: [matchA.id, matchB.id],
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

    // #14 — re-plan later rounds around the swapped round so the strip stays live.
    await replanRoundsAfterPreviewEdit(io, data.sessionId, roundNumber);

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

    // #14 — re-plan later rounds around the edited round so the strip stays live.
    await replanRoundsAfterPreviewEdit(io, data.sessionId, roundNumber);

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
  // Authorize before taking the lock (see handleHostGenerateMatches).
  if (!await verifyHost(socket, data.sessionId)) return;
  // Serialize with all other match-write paths (see handleHostGenerateMatches).
  return withMatchGenerationLock(data.sessionId, async () => {
  try {
    // Re-verify after the lock wait — privileges may have changed (TOCTOU).
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

    // 23 May (Stefan live test) — capture the current arrangement so we can
    // tell the host when Re-match couldn't produce a DIFFERENT one (out of
    // fresh no-repeat options) instead of the button silently doing nothing.
    const arrangementKey = (ms: { participantAId: string; participantBId: string; participantCId?: string | null }[]) =>
      ms.map(m => [m.participantAId, m.participantBId, m.participantCId].filter(Boolean).sort().join('+')).sort().join('|');
    const beforeMatches = await matchingService.getMatchesByRound(data.sessionId, roundNumber);
    const beforeArrangement = arrangementKey(beforeMatches);
    const beforePairKeys = arrangementPairKeys(beforeMatches);

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

    // Re-generate (exclude host + co-hosts from matching). 27 May — also gate on
    // the live present-in-main set so re-match never pulls in an absent participant.
    const allHostIds = await getAllHostIds(data.sessionId, activeSession.hostUserId);
    const presentUserIds = await getPresentUserIds(io, data.sessionId, activeSession);

    // 23 May (#5b, refined per Ali) — Re-match must ALWAYS rotate to a DIFFERENT
    // arrangement, every press. Hard-exclude the CURRENT preview pairs so the
    // engine cannot reproduce them; the no-repeat ladder inside generateSingleRound
    // still prefers fresh pairings while any remain, then falls into already-met
    // pairs (Met 1x, Met 2x…) once fresh is exhausted — but it always changes.
    //
    // Pre-fix a "fresh-only" gate restored the original whenever the rotated
    // arrangement repeated a prior round. On round 1 that gate counted the
    // PRE-PLANNED future rounds (2, 3) as history, so the only alternatives
    // looked like "repeats" and Re-match did nothing until a swap shifted state.
    await query(`DELETE FROM matches WHERE session_id = $1 AND round_number = $2`, [data.sessionId, roundNumber]);
    await matchingService.generateSingleRound(
      data.sessionId, roundNumber, allHostIds,
      { regenerate: true, excludePairKeys: beforePairKeys }, presentUserIds,
    );
    const afterMatches = await matchingService.getMatchesByRound(data.sessionId, roundNumber);
    const afterArrangement = arrangementKey(afterMatches);

    // The ONLY case Re-match genuinely can't change is a single possible pairing
    // (e.g. exactly 2 participants): excluding the current arrangement then either
    // reproduces it or leaves someone unmatched. Restore the original and report.
    const noOtherArrangement = beforePairKeys.length > 0 &&
      (afterArrangement === beforeArrangement || afterMatches.length < beforeMatches.length);
    if (noOtherArrangement) {
      await query(`DELETE FROM matches WHERE session_id = $1 AND round_number = $2`, [data.sessionId, roundNumber]);
      await matchingService.generateSingleRound(data.sessionId, roundNumber, allHostIds, { regenerate: false }, presentUserIds);
    }

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

    // #14 — re-plan later rounds around the re-matched round so the strip stays live.
    await replanRoundsAfterPreviewEdit(io, data.sessionId, roundNumber);

    // 23 May (#5b) — the only time Re-match can't change anything is a single
    // possible pairing (e.g. exactly 2 participants). Tell the host plainly
    // instead of the button looking dead (info toast: REMATCH_NO_ALTERNATIVE).
    if (noOtherArrangement) {
      socket.emit('error', {
        code: 'REMATCH_NO_ALTERNATIVE',
        message: "These participants only have one possible pairing, so Re-match can't change it.",
      });
    }

    logger.info({ sessionId: data.sessionId, roundNumber }, 'Host regenerated matches');
  } catch (err: any) {
    socket.emit('error', { code: 'REGENERATE_FAILED', message: err.message });
  }
  });
}

// 23 May (#12) — handleHostForceMatch (manual pairing) removed per Stefan.
// Swap rearranges the preview; manual room creation (breakout-bulk) covers
// ad-hoc grouping. The host:force_match socket event + client UI are gone too.

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
  io: SocketServer,
  socket: Socket,
  sessionId: string,
  roundNumber: number,
  hostUserId?: string
): Promise<void> {
  const matches = await matchingService.getMatchesByRound(sessionId, roundNumber);

  const allUserIds = new Set<string>();
  for (const m of matches) {
    // S25 — same NULL-slot guard as the dashboard builder below: a
    // 1-person manual room has no B participant.
    if (m.participantAId) allUserIds.add(m.participantAId);
    if (m.participantBId) allUserIds.add(m.participantBId);
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
  // Bug② — count departed-but-was-matched people as matched (union
  // departed_user_ids), same as the live dashboard; a preview is usually
  // pre-departure so this is normally a no-op, but stays correct if a
  // re-match preview is shown for a round that already had a departure.
  const matchedIds = new Set(matches.flatMap(m => [
    m.participantAId, m.participantBId, ...(m.participantCId ? [m.participantCId] : []),
    ...(m.departedUserIds ?? []),
  ]));
  let byeUserIds = allParticipants.rows.map(p => p.user_id).filter(uid => !matchedIds.has(uid));
  // 27 May — "Not matched: X" must only list people actually in the main room.
  // A registered-but-absent participant (accepted, never joined / here-then-left)
  // is gated out of matching; gate them out of the host's bye list too so the
  // host (and co-hosts, who receive the same preview) see live truth, not stale
  // roster. Fail-open: no activeSession or empty present set → leave the DB list.
  const previewActiveSession = activeSessions.get(sessionId);
  if (previewActiveSession) {
    const present = await getPresentUserIds(io, sessionId, previewActiveSession);
    if (present.size > 0) byeUserIds = byeUserIds.filter(uid => present.has(uid));
  }
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

  // 26 May (#9-UI) — surface whether this preview round contains any repeat
  // pairs so the host UI can show a persistent banner + fire a toast.
  // Derived from the matchPreview we already built: any pair with metBefore=true
  // (computed from encounterMap above) counts as a repeat. This avoids an extra
  // DB round-trip — encounterMap was already populated per the session policy.
  const usedRepeats = matchPreview.some(m => m.metBefore === true);

  socket.emit('host:match_preview', {
    roundNumber,
    matches: matchPreview,
    byeParticipants,
    usedRepeats,
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
// P2-4 — emit-on-change: when nothing in the payload changed, the periodic
// 5s rebuild (round-lifecycle) skips the socket push. Hosts still get an
// unchanged heartbeat at this cadence so the legacy timerSecondsRemaining
// field can't go arbitrarily stale on clients that read it.
const DASHBOARD_UNCHANGED_HEARTBEAT_MS = 30_000;

interface DashboardEmitState {
  lastEmit: number;      // epoch ms of the last immediate emit
  pendingTimer: NodeJS.Timeout | null; // trailing-edge timer
  lastPayloadFp?: string; // fingerprint of the last SENT payload (P2-4)
  lastSentAt?: number;    // epoch ms of the last actual socket push (P2-4)
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

    // Ship B — presence source for every membership read in this function:
    // canonical connected set when available, legacy heartbeat map otherwise
    // (fail-open: getCanonicalConnectedSet returns null — never an empty set —
    // when canonical is unavailable, so we can't wrongly render "nobody here").
    const { getCanonicalConnectedSet } = await import('../state/canonical-state');
    const presentSet: ReadonlySet<string> =
      (await getCanonicalConnectedSet(sessionId)) ?? new Set(activeSession.presenceMap.keys());

    // Look up display names for all participant IDs — use per-session cache
    // (Tier-1 A1) to skip the DB round-trip for names we've already fetched
    // during this event. Names are stable for the session lifetime.
    const allUserIds = new Set<string>();
    for (const m of matches) {
      // S25 (live-test bb root #2) — participant_b_id is NULL for a
      // 1-person manual room. The unguarded add fed that NULL into
      // placeholderName (null.slice → TypeError), which crashed THIS
      // WHOLE FUNCTION for as long as any such match existed in the
      // round (completed ones included — this loop isn't status-
      // filtered). Net effect in bb: zero dashboard emits from the
      // moment the 1-person room was created until event end — the
      // host's panel froze on the algorithm-round era and offered the
      // stale End Round that killed the event.
      if (m.participantAId) allUserIds.add(m.participantAId);
      if (m.participantBId) allUserIds.add(m.participantBId);
      if (m.participantCId) allUserIds.add(m.participantCId);
    }
    // Also include presence + host so bye-participant rendering has names
    for (const uid of presentSet) allUserIds.add(uid);

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
      return presentSet.has(uid);
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

    // Find bye participants (matched to nobody). Bug② (2026-06-08) — a person
    // who was in a match and clicked "Back to Main Room" is removed from the
    // slots but recorded in departed_user_ids; they WERE matched this round.
    // Union departed_user_ids so they are NOT shown in the host's "Not matched
    // this round" banner — only a genuine bye (never placed) belongs there.
    const matchedUserIds = new Set<string>();
    for (const m of matches) {
      if (m.participantAId) matchedUserIds.add(m.participantAId);
      if (m.participantBId) matchedUserIds.add(m.participantBId);
      if (m.participantCId) matchedUserIds.add(m.participantCId);
      for (const uid of (m.departedUserIds ?? [])) matchedUserIds.add(uid);
    }

    const byeParticipants: { userId: string; displayName: string }[] = [];
    for (const userId of presentSet) {
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
    // 27 May — gate the eligible count on LIVE main-room presence so the
    // "Match People" button + counts reflect who's actually here, not stale
    // roster (a registered-but-absent participant must not count). One query,
    // both counts derived. Fail-open: if presence is empty/unavailable, fall
    // back to the DB-eligible count so we never wrongly show zero.
    const presenceSet = presentSet;
    // 10-Jun audit — exclude the FULL host set (director + cohosts + super_admins),
    // not just the director, so the "Match People: N eligible" label matches what
    // the real matching path (getAllHostIds → getEligibleParticipants) will pair.
    // Resolved once here and reused as the dashboard audience below. Fail-open to
    // the director if the lookup throws, mirroring the audience fallback.
    const hostIds = await getAllHostIds(sessionId, activeSession.hostUserId).catch(() => [
      activeSession.hostUserId,
    ]);
    const eligibleRows = (await query<{ user_id: string }>(
      `SELECT sp.user_id FROM session_participants sp
       WHERE sp.session_id = $1
         AND sp.status NOT IN ('removed', 'left', 'no_show')
         AND sp.user_id != ALL($2::uuid[])
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE m.session_id = $1 AND m.status = 'active'
             AND (m.participant_a_id = sp.user_id OR m.participant_b_id = sp.user_id OR m.participant_c_id = sp.user_id)
         )`,
      [sessionId, hostIds],
    )).rows;
    const presentMainRoomCount = eligibleRows.filter(r => presenceSet.has(r.user_id)).length;
    const eligibleMainRoomCount = presenceSet.size > 0 ? presentMainRoomCount : eligibleRows.length;

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
    // P2-4 — emit-on-change. During ROUND_ACTIVE this function runs every 5s
    // per session and used to push the full payload (~15-25KB at 100
    // participants) to every host whether anything changed or not — thousands
    // of redundant pushes per event, each re-rendering the host panel. The
    // fingerprint EXCLUDES timerSecondsRemaining (it ticks every second by
    // construction; hosts render time from timerEndsAt — Bug 8.5); presence /
    // room / participant changes all alter the fingerprint, so real changes
    // always flow. An unchanged payload is still pushed every 30s as a
    // heartbeat belt.
    // hostIds resolved above (shared with the eligible-count query).
    // The AUDIENCE is part of the fingerprint: a newly-added co-host changes
    // hostIds, so their first dashboard is never withheld by the skip.
    const fp = JSON.stringify({ ...dashboardPayload, timerSecondsRemaining: 0, _audience: hostIds });
    const emitState = dashboardEmitState.get(sessionId) || { lastEmit: 0, pendingTimer: null };
    if (fp === emitState.lastPayloadFp && Date.now() - (emitState.lastSentAt ?? 0) < DASHBOARD_UNCHANGED_HEARTBEAT_MS) {
      return; // nothing changed — spare every host the redundant push
    }
    emitState.lastPayloadFp = fp;
    emitState.lastSentAt = Date.now();
    dashboardEmitState.set(sessionId, emitState);
    for (const hostId of hostIds) {
      io.to(userRoom(hostId)).emit('host:round_dashboard', dashboardPayload);
    }
    // Phase 5 — co-emit versioned snapshot. Self-gates on flag; no-op when off.
    void emitStateSnapshot(io, sessionId);
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to emit host dashboard');
  }
}
