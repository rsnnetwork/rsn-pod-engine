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
  resolveDisplayName, placeholderName,
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
// Phase 2B (5 May spec) — single chokepoint for presenceMap mutations.
import { setPresence } from '../state/participant-state-machine';
import { validateMatchAssignment } from '../../matching/match-validator.service';
// Phase 2 (19 May 2026) — realtime migration dual-emit. Every legacy
// in-handler broadcast (roster:changed, host:transferred, host:event_plan_*,
// pin:changed, tile:size_changed, host:visibility_changed,
// match:reassigned, match:partner_disconnected) gets a parallel
// emitEntities() call with the matching domain-entity tags. See:
//   docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
import { emitEntities } from '../../../realtime/emit';
import { E } from '../../../realtime/entities';

// ─── Cross-module references (wired in Task 7) ────────────────────────────
// Functions from round-lifecycle.ts that don't exist yet.

let _transitionToRound: ((io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>) | null = null;
let _completeSession: ((io: SocketServer, sessionId: string) => Promise<void>) | null = null;
let _endRound: ((io: SocketServer, sessionId: string, roundNumber: number) => Promise<void>) | null = null;
let _emitHostDashboard: ((sessionId: string) => Promise<void>) | null = null;
// Bug 68 (18 May Stefan) — coalesce-bypass variant for cohost promote/
// demote paths. The standard emitHostDashboard has a 1-second coalesce
// window which delays a post-promote dashboard refresh; the force
// variant skips it so the newly-promoted cohost sees their HCC populated
// immediately, with no perceptible delay between click and render.
let _emitHostDashboardForce: ((sessionId: string) => Promise<void>) | null = null;
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
  // Bug 68 (18 May Stefan) — force variant for host-action-triggered
  // emits that must not be coalesced.
  emitHostDashboardForce?: (sessionId: string) => Promise<void>;
  timerCallbacks: TimerCallbacks;
  maybeAutoEndEmptyRound?: (sessionId: string) => Promise<void>;
}) {
  _transitionToRound = deps.transitionToRound;
  _completeSession = deps.completeSession;
  _endRound = deps.endRound;
  _emitHostDashboard = deps.emitHostDashboard;
  _emitHostDashboardForce = deps.emitHostDashboardForce || null;
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

// Phase 8A.5 (8 May spec) — Stefan #4 + #9: cohost change re-shapes
// upcoming rounds. Reuses the same matching service repair the
// late-joiner / leaver path uses, with reason='host_request' since
// the trigger is a host action. No throttling — cohost change is
// a manual, low-frequency event.
async function maybeRepairFutureRounds(io: SocketServer, sessionId: string): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession || activeSession.currentRound < 1) return;
  const fromRound = activeSession.currentRound + 1;
  const result = await matchingService.repairFutureRounds(sessionId, fromRound, 'host_request');
  if (result.regeneratedRounds.length > 0) {
    io.to(sessionRoom(sessionId)).emit('host:event_plan_repaired', {
      sessionId,
      reason: 'host_request',
      regeneratedRounds: result.regeneratedRounds,
    });
    // Phase 2 dual-emit — plan + session entity covers every plan-aware
    // surface (event-plan, host-state, session). Audience is the active
    // session participants (same as the room broadcast above).
    emitSessionRoomEntities(io, sessionId, [E.session(sessionId), E.sessionPlan(sessionId)]).catch(() => {});
  }
}

// Phase 2 (19 May 2026) — helper used by every in-handler dual-emit below.
// Resolves the active session participants (same audience as
// `io.to(sessionRoom(sessionId)).emit(...)`) and fans the given entity
// tags to each via emitEntities. Wrapped in .catch() at every call site
// so fanout failure can never break the user-facing handler response.
async function emitSessionRoomEntities(
  io: SocketServer,
  sessionId: string,
  entities: string[],
): Promise<void> {
  if (entities.length === 0) return;
  const rows = await query<{ user_id: string }>(
    `SELECT user_id FROM session_participants
       WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
    [sessionId],
  );
  await emitEntities(io, rows.rows.map(r => r.user_id), entities);
}

// ═════════════════════════════════════════════════════════════════════════════
// HOST HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Get all user IDs that should be excluded from matching: original host +
 * co-hosts, with Phase M (12 May spec item 1) acting-as-host overrides
 * applied.
 *
 *   acting_as_host = TRUE  → add to the host set (admin opt-in)
 *   acting_as_host = FALSE → remove from the host set (super_admin or
 *                            event_host attending as participant)
 *   acting_as_host = NULL  → use role default (existing behavior)
 *
 * The opt-out is the operationally important case: a super_admin or
 * cohost wants to be matched on their own event. Pre-Phase-M they were
 * unconditionally excluded; now they are included when they've opted
 * out explicitly.
 */
export async function getAllHostIds(sessionId: string, hostUserId: string): Promise<string[]> {
  const cohostResult = await query<{ user_id: string }>(
    `SELECT user_id FROM session_cohosts WHERE session_id = $1`,
    [sessionId]
  );
  const overrideResult = await query<{ user_id: string; acting_as_host: boolean }>(
    `SELECT user_id, acting_as_host FROM session_participants
     WHERE session_id = $1 AND acting_as_host IS NOT NULL`,
    [sessionId]
  );
  const optedOut = new Set<string>();
  const optedIn = new Set<string>();
  for (const row of overrideResult.rows) {
    if (row.acting_as_host === false) optedOut.add(row.user_id);
    else if (row.acting_as_host === true) optedIn.add(row.user_id);
  }
  const baseHosts = new Set<string>([hostUserId, ...cohostResult.rows.map(r => r.user_id)]);
  for (const id of optedIn) baseHosts.add(id);
  for (const id of optedOut) baseHosts.delete(id);
  return Array.from(baseHosts);
}

// ─── Verify Host ────────────────────────────────────────────────────────────

export async function verifyHost(socket: Socket, sessionId: string): Promise<boolean> {
  const userId = getUserIdFromSocket(socket);
  if (!userId) {
    socket.emit('error', { code: 'UNAUTHORIZED', message: 'Not authenticated' });
    return false;
  }

  // T1-5 — delegated to the unified `getEffectiveRole` resolver. Allowed:
  // event host, cohost, pod director / pod creator, and super_admin.
  // Phase I (10 May spec item 18) — regular admins are no longer auto-
  // passed here; they must be promoted to cohost to act as a host on a
  // specific live event. Pod-management endpoints still accept admin via
  // their own gates.
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

/**
 * Bug J (15 May Ali) — defence-in-depth gate that refuses Make / Remove
 * co-host and Kick when the TARGET is a platform admin or super_admin.
 * Admins choose their own per-event role through the Phase M banner.
 *
 * Bug 2 (18 May Stefan) — supreme-host carve-out: the EVENT DIRECTOR
 * (sessions.host_user_id) IS the authority over their own event and
 * can promote / demote / kick anyone on the roster, including platform
 * admins. Non-director acting hosts (cohosts, super_admin opt-ins) are
 * still blocked — only the director gets the override. Stefan's exact
 * complaint: "Current admin logic blocks too much."
 *
 * Returns true if the action is permitted, false if it must be refused.
 * Emits an error frame on refusal so the caller's UI can surface it.
 */
async function refuseIfAdminTarget(
  socket: Socket,
  sessionId: string,
  targetUserId: string,
): Promise<boolean> {
  const callerUserId = getUserIdFromSocket(socket);
  if (!callerUserId) return false;

  // Bug 2 (18 May Stefan) — director shortcut. Reads the session row
  // directly to avoid an in-memory cache hit when the session is still
  // warming up.
  const sessionRow = await query<{ host_user_id: string }>(
    `SELECT host_user_id FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (sessionRow.rows[0]?.host_user_id === callerUserId) {
    return true;
  }

  const targetRow = await query<{ role: string }>(
    `SELECT role::text AS role FROM users WHERE id = $1`,
    [targetUserId],
  );
  const targetRole = targetRow.rows[0]?.role;
  if (targetRole === 'admin' || targetRole === 'super_admin') {
    socket.emit('error', {
      code: 'ADMIN_TARGET',
      message:
        "Admins manage their own per-event role. Only the event director can override this.",
    });
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

    // Phase 2.5A (5 May spec) — pre-event session planning.
    // Stefan's matching spec §5: "Generate the full session plan upfront. Do
    // not match session by session." We call generateSessionSchedule once at
    // event start; it runs the engine across all rounds at once and persists
    // every match at status='scheduled'. The round-transition path (2.5B)
    // then promotes pre-planned matches to active without re-running the
    // engine. Failure here is non-fatal: if planning fails we log it, the
    // legacy per-round path still works, and Sentry will surface the issue.
    try {
      // Phase 7A.2 (7 May spec) — exclude host + cohosts from the pre-plan
      // so they don't end up paired as regular participants in any round.
      const planExcludeIds = await getAllHostIds(data.sessionId, session.hostUserId);
      // Phase 8A.2 (8 May spec) — Stefan #2 (Wazim case): also pass the
      // presenceMap so registered-but-never-connected users are filtered
      // out of the schedule. Pre-fix the pre-plan only checked
      // session_participants.status, so anyone whose status was still
      // 'registered'/'in_lobby' got in even if they never opened the
      // event page on a live socket.
      const activeSessionForPlan = activeSessions.get(data.sessionId);
      const presentForPlan = activeSessionForPlan?.presenceMap
        ? new Set(activeSessionForPlan.presenceMap.keys())
        : undefined;
      const planOutput = await matchingService.generateSessionSchedule(
        data.sessionId,
        undefined,
        planExcludeIds,
        presentForPlan,
      );
      const totalPairs = planOutput.rounds.reduce((sum, r) => sum + r.pairs.length, 0);
      logger.info(
        { sessionId: data.sessionId, rounds: planOutput.rounds.length, totalPairs, durationMs: planOutput.durationMs },
        'Pre-event plan generated (Phase 2.5A)',
      );
      io.to(sessionRoom(data.sessionId)).emit('host:event_plan_generated', {
        sessionId: data.sessionId,
        roundCount: planOutput.rounds.length,
        totalPairs,
      });
      // Phase 2 dual-emit — plan + session for event-plan / host-state
      // re-queries on every participant's open lobby.
      emitSessionRoomEntities(
        io, data.sessionId,
        [E.session(data.sessionId), E.sessionPlan(data.sessionId)],
      ).catch(() => {});
    } catch (planErr: any) {
      logger.warn(
        { err: planErr, sessionId: data.sessionId },
        'Pre-event plan generation failed — falling back to legacy session-by-session matching',
      );
      // Don't block event start — host can still trigger per-round matching
      // via the existing host:generate_matches button (legacy fallback).
    }

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

    // Phase 8 (1 May spec) — host action receipt.
    {
      const { emitHostActionConfirmed } = await import('./matching-flow');
      const hostUid = activeSessions.get(data.sessionId)?.hostUserId;
      if (hostUid) {
        emitHostActionConfirmed(io, data.sessionId, hostUid, {
          action: 'broadcast',
          summary: 'Broadcast sent to all participants',
        });
      }
    }

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
    // Bug J (15 May Ali) — admins cannot be kicked from an event by a
    // cohost. Only the event director (Bug 2, 18 May Stefan) can — they
    // hold supreme authority over their own event. Co-hosts and other
    // acting hosts still can't kick admins.
    if (!await refuseIfAdminTarget(socket, data.sessionId, data.userId)) return;

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
        setPresence(data.sessionId, data.userId, null);
      }
    }

    io.to(sessionRoom(data.sessionId)).emit('participant:left', { userId: data.userId });
    // Bug 68 (18 May Stefan) — broadcast roster mutation so every viewer
    // refetches the snapshot and their lobby header count drops by one
    // within the same tick as the kick.
    io.to(sessionRoom(data.sessionId)).emit('roster:changed', {
      sessionId: data.sessionId,
      cause: 'participant_kicked',
    });
    // Phase 2 dual-emit — session + participants entities; the kicked
    // user also gets the entity tag so their own client invalidates the
    // session queries (which now show "removed" status).
    emitSessionRoomEntities(
      io, data.sessionId,
      [E.session(data.sessionId), E.sessionParticipants(data.sessionId)],
    ).catch(() => {});
    emitEntities(
      io, [data.userId],
      [E.session(data.sessionId), E.sessionParticipants(data.sessionId)],
    ).catch(() => {});

    // Phase 3 (5 May spec) — force-refresh canonical host dashboard after
    // any participant-state mutation. Closes Stefan #9 gap where the host
    // saw stale state until the next 5s dashboard tick.
    if (_emitHostDashboard) await _emitHostDashboard(data.sessionId).catch(() => {});

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

    // Phase R1 (20 May 2026) — belt-and-braces. Neither the host nor any
    // cohort may end up in a reassign INSERT. The host UI shouldn't allow
    // selecting them, but a malicious/buggy client could send the host's
    // user_id as participantId.
    if (targetId === activeSession.hostUserId ||
        (partner && partner === activeSession.hostUserId)) {
      logger.error({ sessionId: data.sessionId, targetId, partner,
        hostUserId: activeSession.hostUserId },
        'Phase R1 — refused host-driven reassign that would place the event host in a match');
      socket.emit('error', { code: 'HOST_NOT_MATCHABLE', message: 'The event host cannot be reassigned into a match' });
      return;
    }

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

      // Phase 0 (1 May spec) — server-canonical room assignment for host
      // reassign action. Same architectural rule as auto-rounds.
      const { setRoomAssignment } = await import('./participant-flow');
      setRoomAssignment(data.sessionId, matchId, roomId, [targetId, partner]);

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

      // Phase 2 dual-emit — session, participants list, and match entity
      // for the two reassigned users so their live-event surfaces refetch.
      emitEntities(
        io, [targetId, partner],
        [E.session(data.sessionId), E.sessionParticipants(data.sessionId), E.match(matchId)],
      ).catch(() => {});

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
//
// Phase O (12 May spec item 7) — persistent authoritative mute state.
// Stefan reported admins couldn't mute (the pre-fix gate accepted only
// the original event host, never co-hosts or super_admin), and that
// muted participants got "stuck" muted after reconnect because the
// mute was a fire-and-forget socket relay with no DB persistence.
// Both fixed below:
//   - Gate via verifyHost (which uses canActAsHost — cohort + super_admin
//     accepted post-Phase-I; admin opt-in via Phase M also covered).
//   - UPDATE session_participants.host_muted before emitting the relay,
//     so the snapshot can replay it to the user on reconnect.

export async function handleHostMuteParticipant(
  io: SocketServer,
  socket: Socket,
  data: any
): Promise<void> {
  if (!await verifyHost(socket, data.sessionId)) return;

  const activeSession = activeSessions.get(data.sessionId);
  if (!activeSession) {
    socket.emit('error', { code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    return;
  }

  // Persist host_muted on session_participants so the state survives
  // reconnects. host_muted_at is set when flipping to TRUE; left as-is
  // (history preserved) when flipping to FALSE.
  if (data.muted) {
    await query(
      `UPDATE session_participants
       SET host_muted = TRUE, host_muted_at = NOW()
       WHERE session_id = $1 AND user_id = $2`,
      [data.sessionId, data.targetUserId],
    );
  } else {
    await query(
      `UPDATE session_participants
       SET host_muted = FALSE
       WHERE session_id = $1 AND user_id = $2`,
      [data.sessionId, data.targetUserId],
    );
  }

  // Relay mute command to the target participant's client (immediate UX
  // feedback). Snapshot replay on reconnect uses the persisted state.
  io.to(userRoom(data.targetUserId)).emit('lobby:mute_command', {
    muted: data.muted,
    byHost: true,
  });

  // R2-audit (20 May 2026 — live-test post-mortem). host_muted lives on
  // session_participants and affects the participants list (muted icon).
  // Fan out E.sessionParticipants so every viewer's list refreshes the
  // mute state without F5. Pre-fix only the target user got the lobby
  // mute relay; other viewers had to refresh to see the muted indicator.
  try {
    const rows = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants
         WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
      [data.sessionId],
    );
    emitEntities(
      io, rows.rows.map(r => r.user_id),
      [E.session(data.sessionId), E.sessionParticipants(data.sessionId)],
    ).catch(() => {});
  } catch { /* non-fatal */ }

  // Phase U — LiveKit-level enforcement. Update publish permission on
  // every room the user could currently be in (lobby + any active
  // match). Provider swallows NotFound, so calling for both rooms is
  // safe; the relevant one applies. canPublishAudio is the inverse of
  // muted: false = revoke publish; true = restore.
  await enforceLiveKitMute(data.sessionId, data.targetUserId, !data.muted);

  logger.info({ sessionId: data.sessionId, targetUserId: data.targetUserId, muted: data.muted },
    'Phase O + U — Host mute/unmute persisted + relayed + LiveKit-enforced');
}

/**
 * Phase U — apply LiveKit canPublishAudio to every room the user might
 * be in: the session's lobby room + any active match they're in. The
 * provider swallows NotFound for the room they're NOT in, so this is
 * safe to call regardless of where they actually are.
 */
async function enforceLiveKitMute(
  sessionId: string,
  userId: string,
  canPublishAudio: boolean,
): Promise<void> {
  try {
    const sessRow = await query<{ lobby_room_id: string | null }>(
      `SELECT lobby_room_id FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const lobbyRoom = sessRow.rows[0]?.lobby_room_id;
    if (lobbyRoom) {
      await videoService.setParticipantCanPublishAudio(lobbyRoom, userId, canPublishAudio);
    }
    const matchRow = await query<{ room_id: string | null }>(
      `SELECT room_id FROM matches
       WHERE session_id = $1
         AND status = 'active'
         AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)
       LIMIT 1`,
      [sessionId, userId],
    );
    const matchRoom = matchRow.rows[0]?.room_id;
    if (matchRoom) {
      await videoService.setParticipantCanPublishAudio(matchRoom, userId, canPublishAudio);
    }
  } catch (err) {
    // Non-fatal: persistence + socket relay already happened; the
    // LiveKit enforcement is defence in depth. Log and move on.
    logger.warn({ err, sessionId, userId, canPublishAudio }, 'Phase U — LiveKit mute enforcement failed (non-fatal)');
  }
}

// ─── Host: Mute/Unmute All ─────────────────────────────────────────────────

export async function handleHostMuteAll(
  io: SocketServer,
  socket: Socket,
  data: any
): Promise<void> {
  if (!await verifyHost(socket, data.sessionId)) return;

  const activeSession = activeSessions.get(data.sessionId);
  if (!activeSession) {
    socket.emit('error', { code: 'SESSION_NOT_FOUND', message: 'Session not found' });
    return;
  }

  // Phase O — bulk persist BEFORE relay. Excludes the host themselves
  // (existing behaviour) AND any co-hosts (who shouldn't be silenced by
  // a bulk-mute action targeted at participants). One UPDATE replaces
  // N updates from a loop — keeps the operation a single round-trip
  // even at 100+ participants.
  const allHostIds = await getAllHostIds(data.sessionId, activeSession.hostUserId);
  if (data.muted) {
    await query(
      `UPDATE session_participants
       SET host_muted = TRUE, host_muted_at = NOW()
       WHERE session_id = $1
         AND user_id != ALL($2::uuid[])
         AND status NOT IN ('removed', 'left', 'no_show')`,
      [data.sessionId, allHostIds],
    );
  } else {
    await query(
      `UPDATE session_participants
       SET host_muted = FALSE
       WHERE session_id = $1
         AND user_id != ALL($2::uuid[])
         AND status NOT IN ('removed', 'left', 'no_show')`,
      [data.sessionId, allHostIds],
    );
  }

  let count = 0;
  for (const [participantId] of activeSession.presenceMap) {
    // Skip the host AND all co-hosts — they should not be muted by
    // bulk-mute. Excluded above for the DB persist; mirror here for
    // the socket relay.
    if (allHostIds.includes(participantId)) continue;
    io.to(userRoom(participantId)).emit('lobby:mute_command', {
      muted: data.muted,
      byHost: true,
    });
    // Phase U — LiveKit-level enforcement, mirroring DB + relay.
    // Sequenced (not parallel) to be gentle with the LiveKit API; mute
    // bulk is rare enough that the latency is acceptable.
    enforceLiveKitMute(data.sessionId, participantId, !data.muted).catch(err =>
      logger.warn({ err, participantId }, 'Phase U bulk mute enforcement failed (non-fatal)'),
    );
    count++;
  }

  logger.info({ sessionId: data.sessionId, muted: data.muted, count },
    'Phase O + U — Host mute/unmute all persisted + relayed + LiveKit-enforced');
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

    // Phase 3 (29 April 2026 spec) — trio-aware demotion. Pre-fix the entire
    // match was terminated when the host removed ONE participant from a
    // 3-person room, killing the room for the other two. Per spec:
    //   "the host pulls out the one ... the other two should continue
    //    talking, no need to interrupt them, but the one who host pulled
    //    off must give the rating and get back to the main room lobby"
    // demoteParticipantFromMatch handles all room sizes cleanly.
    const matchPreRemoval = await query<{ participant_a_id: string; participant_b_id: string; participant_c_id: string | null }>(
      `SELECT participant_a_id, participant_b_id, participant_c_id FROM matches WHERE id = $1`,
      [data.matchId]
    );
    const removalDemote = await matchingService.demoteParticipantFromMatch(
      data.matchId, data.userId, terminalStatus as 'completed' | 'cancelled',
    );

    if (removalDemote.matchStillActive) {
      // Trio room with 1 removed — the room continues for the other 2.
      // Send the removed user their rating screen + return to lobby; notify
      // the remaining users with a lighter event (NOT partner_disconnected).
      logger.info(
        { sessionId: (data as any).sessionId, matchId: data.matchId, remaining: removalDemote.remainingUserIds.length },
        'Host removed participant from trio — remaining users continue conversation',
      );

      await sessionService.updateParticipantStatus(data.sessionId, data.userId, ParticipantStatus.IN_LOBBY).catch(() => {});

      const remPartnerIds = removalDemote.remainingUserIds;
      const remNameRes = await query<{ id: string; display_name: string | null; email: string | null }>(
        `SELECT id, display_name, email FROM users WHERE id = ANY($1)`, [remPartnerIds]
      );
      // Phase 5 (1 May spec) — single-source displayName helper.
      const remNameMap = new Map(remNameRes.rows.map(r => [r.id, resolveDisplayName(r.id, r.display_name, r.email)]));
      const remPartnersWithNames = remPartnerIds.map(pid => ({
        userId: pid, displayName: remNameMap.get(pid) || placeholderName(pid),
      }));
      const removedNameRes = await query<{ display_name: string | null; email: string | null }>(
        `SELECT display_name, email FROM users WHERE id = $1`, [data.userId]
      );
      const removedName = resolveDisplayName(
        data.userId,
        removedNameRes.rows[0]?.display_name || null,
        removedNameRes.rows[0]?.email || null,
      );

      // Notify remaining (lighter event)
      for (const partnerId of remPartnerIds) {
        io.to(userRoom(partnerId)).emit('match:participant_left', {
          matchId: data.matchId,
          leftUserId: data.userId,
          leftDisplayName: removedName,
          remainingCount: remPartnerIds.length,
          reason: 'host_removed',
        });
      }

      // Send rating to removed user
      await emitRatingWindowOnce(io, data.userId, data.matchId, {
        matchId: data.matchId,
        partnerId: remPartnerIds[0],
        partnerDisplayName: remNameMap.get(remPartnerIds[0]) || `Partner ${remPartnerIds[0].slice(0, 6)}`,
        partners: remPartnersWithNames,
        durationSeconds: 20,
        earlyLeave: true,
      });

      // Re-issue lobby token for removed user
      const trioRemSession = await sessionService.getSessionById(data.sessionId);
      if (trioRemSession.lobbyRoomId) {
        try {
          const { config: appConfig } = await import('../../../config');
          const socketsInRoom = await io.in(userRoom(data.userId)).fetchSockets();
          for (const sk of socketsInRoom) {
            const uid = (sk.data as any)?.userId;
            if (uid !== data.userId) continue;
            const dName = (sk.data as any)?.displayName || 'User';
            const lobbyToken = await videoService.issueJoinToken(uid, trioRemSession.lobbyRoomId, dName);
            sk.emit('lobby:token', { token: lobbyToken.token, livekitUrl: appConfig.livekit.host, roomId: trioRemSession.lobbyRoomId });
          }
        } catch { /* skip */ }
      }

      // Refresh host dashboard so the room card reflects the smaller pair
      if (_emitHostDashboard) await _emitHostDashboard(data.sessionId).catch(() => {});
      return;
    }

    logger.info(
      { sessionId: (data as any).sessionId, matchId: data.matchId, durationS, ratingCount, terminalStatus },
      'Host removed participant — match ended (room had 2 or fewer participants)'
    );

    // Clear any per-room timer/sync for this match (prevents ghost timers)
    clearRoomTimers(data.matchId);

    // Get match participants before updating (use the snapshot we took
    // pre-demotion so we know the original participant set for downstream
    // notifications).
    const matchResult = matchPreRemoval;

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
      // Phase 2 dual-emit — affected partner(s) + the removed user.
      // Match entity covers the in-event match surface; session +
      // participants cover the lobby / participants list refresh.
      emitEntities(
        io, [...partnerIds, data.userId],
        [E.session(data.sessionId), E.sessionParticipants(data.sessionId), E.match(data.matchId)],
      ).catch(() => {});

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

    // Phase 8 (1 May spec) — host action receipt.
    {
      const { emitHostActionConfirmed } = await import('./matching-flow');
      const hostUid = activeSessions.get(data.sessionId)?.hostUserId;
      if (hostUid) {
        const removedRowRes = await query<{ display_name: string | null; email: string | null }>(
          `SELECT display_name, email FROM users WHERE id = $1`, [data.userId],
        );
        const removedLabel = resolveDisplayName(
          data.userId,
          removedRowRes.rows[0]?.display_name ?? null,
          removedRowRes.rows[0]?.email ?? null,
        );
        emitHostActionConfirmed(io, data.sessionId, hostUid, {
          action: 'remove_from_room',
          summary: `Removed ${removedLabel} from the breakout room`,
          target: data.userId,
        });
      }
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

    // Find the target match.
    // Phase 7-audit fix — gate by session_id too. Pre-fix the query trusted
    // a UUID alone, so a host who guessed a match UUID from another session
    // could (theoretically) move a participant across session boundaries.
    const targetMatchResult = await query<{ id: string; participant_a_id: string; participant_b_id: string; room_id: string }>(
      `SELECT id, participant_a_id, participant_b_id, room_id FROM matches
        WHERE id = $1 AND session_id = $2 AND status = 'active'`,
      [targetMatchId, sessionId]
    );

    if (targetMatchResult.rows.length === 0) {
      socket.emit('error', { code: 'TARGET_NOT_FOUND', message: 'Target room not found or not active' });
      return;
    }

    const targetMatch = targetMatchResult.rows[0];
    const targetParticipants = [targetMatch.participant_a_id, targetMatch.participant_b_id];

    // Phase 7A.4 (7 May spec) — atomic move-to-room.
    // Pre-fix: end-current + end-target + insert-new were independent
    // DB writes. If insert-new failed, both source matches were stuck
    // at 'completed' with no replacement → 3 participants orphaned.
    // Now: LiveKit room first (fail-fast), all 3 DB writes wrapped in
    // a single transaction. If insert fails, both ends roll back.

    // Step 1: LiveKit room first (fail-fast)
    const moveSlug = `move-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newRoomId = `session-${sessionId}-round-${activeSession.currentRound}-${moveSlug}`;
    try {
      await videoService.createMatchRoom(sessionId, activeSession.currentRound, moveSlug);
    } catch (err) {
      logger.error({ err, newRoomId }, 'Failed to create LiveKit room for host move-to-room');
      socket.emit('error', { code: 'ROOM_CREATION_FAILED', message: 'Failed to create new room. Try again.' });
      return;
    }

    const allParticipants = [...targetParticipants, userId];
    const [pA, pB] = allParticipants[0] < allParticipants[1]
      ? [allParticipants[0], allParticipants[1]] : [allParticipants[1], allParticipants[0]];

    // Step 2: atomic DB transaction — end-current, end-target, insert-new
    let newMatchId = '';
    try {
      await transaction(async (client) => {
        await client.query(
          `UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1`,
          [currentMatch.id],
        );
        await client.query(
          `UPDATE matches SET status = 'completed', ended_at = NOW() WHERE id = $1`,
          [targetMatchId],
        );
        const ins = await client.query<{ id: string }>(
          `INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW()) RETURNING id`,
          [sessionId, activeSession.currentRound, pA, pB, allParticipants.length > 2 ? allParticipants[2] : null, newRoomId],
        );
        newMatchId = ins.rows[0].id;
      });
    } catch (err: any) {
      logger.error({ err }, 'Phase 7A.4 — atomic move-to-room transaction rolled back');
      // Phase 7-audit fix — clean up the LiveKit room created in Step 1 so
      // a TX rollback doesn't leak rooms (and quota). Best-effort: a close
      // failure here is logged but doesn't override the original error
      // surfaced to the host.
      try {
        await videoService.closeMatchRoom(sessionId, activeSession.currentRound, moveSlug);
      } catch (cleanupErr) {
        logger.warn({ err: cleanupErr, newRoomId }, 'Failed to clean up orphaned LiveKit room after TX rollback');
      }
      if (err?.code === '23505') {
        socket.emit('error', { code: 'PARTICIPANT_ALREADY_MATCHED', message: 'One of the participants is already in another active match.' });
      } else {
        socket.emit('error', { code: 'MATCH_CREATION_FAILED', message: 'Could not move participant. Try again.' });
      }
      if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
      return;
    }

    // Post-transaction: give the abandoned partner a bye notification.
    io.to(userRoom(currentPartnerId)).emit('match:return_to_lobby', { reason: 'partner_left' });

    // Phase 0 (1 May spec) — server-canonical room assignment for host
    // move-to-room. Same architectural rule.
    {
      const { setRoomAssignment } = await import('./participant-flow');
      setRoomAssignment(sessionId, newMatchId, newRoomId, allParticipants);
    }

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
    // Phase 2 dual-emit — session, participants, match-id for everyone
    // in the new room. Same audience as the per-pid emits above.
    emitEntities(
      io, allParticipants,
      [E.session(sessionId), E.sessionParticipants(sessionId), E.match(newMatchId)],
    ).catch(() => {});

    // Give abandoned partner a bye notification
    io.to(userRoom(currentPartnerId)).emit('match:bye_round', {
      roundNumber: activeSession.currentRound,
      reason: 'The host moved your partner to another room. Waiting for next round.',
    });

    // Refresh dashboard
    if (_emitHostDashboard) {
      await _emitHostDashboard(sessionId);
    }

    // Phase 8 (1 May spec) — host action receipt.
    {
      const { emitHostActionConfirmed } = await import('./matching-flow');
      const hostUid = activeSession.hostUserId;
      const movedName = nameMap.get(userId) || resolveDisplayName(userId, null, null);
      if (hostUid) {
        emitHostActionConfirmed(io, sessionId, hostUid, {
          action: 'move_to_room',
          summary: `Moved ${movedName} into another room`,
          target: userId,
        });
      }
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

    // Phase 8 (1 May spec) — host action receipt.
    {
      const { emitHostActionConfirmed } = await import('./matching-flow');
      emitHostActionConfirmed(io, data.sessionId, activeSession.hostUserId, {
        action: 'extend_round',
        summary: `Extended round by ${data.additionalSeconds || 120}s`,
      });
    }

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

    // Phase 8 (1 May spec) — host action receipt.
    {
      const { emitHostActionConfirmed } = await import('./matching-flow');
      const hostUid = activeSession.hostUserId;
      if (hostUid) {
        emitHostActionConfirmed(io, sessionId, hostUid, {
          action: 'extend_breakout_room',
          summary: `Extended breakout room by ${additionalSeconds}s`,
          target: matchId,
        });
      }
    }

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

    // Phase B1 (10 May spec) — co-hosts and admins can manage co-hosts.
    // Only ownership transfer (handlePromoteCohost below) remains restricted
    // to the original host. Pre-fix, the client UI showed Make/Remove
    // co-host buttons for co-hosts but the server rejected with FORBIDDEN
    // — Stefan #7: "Shradha's control center did not work". `verifyHost`
    // routes through canActAsHost which accepts cohost + super_admin
    // (Phase I narrowed regular admin out of the auto-host set).
    if (!await verifyHost(socket, sessionId)) return;
    // Bug J (15 May Ali) — co-hosts cannot make a platform admin a co-host.
    // Bug 2 (18 May Stefan) — but the event director CAN; they hold
    // supreme authority over their own event. refuseIfAdminTarget now
    // shortcircuits to allow when caller === session.host_user_id.
    if (!await refuseIfAdminTarget(socket, sessionId, userId)) return;

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
    // Bug 68 (18 May Stefan) — every participant (not just the new cohost)
    // must see the roster change immediately: header count flips from
    // "N participants + M hosts" to "N-1 + M+1", tile badges update, etc.
    // roster:changed triggers each client to refetch the snapshot, which
    // carries every derived state in one round-trip.
    io.to(sessionRoom(sessionId)).emit('roster:changed', {
      sessionId,
      cause: 'cohost_assigned',
    });

    // F3 (20 May 2026 — live-test post-mortem). Defensive entity-tag
    // fanout so any client viewing session_participants / event-plan
    // queries invalidates and refetches. roster:changed already triggers
    // the full snapshot refetch, but tagging gives React-Query-based
    // surfaces (SessionDetailPage participants, EventPlanStrip) a direct
    // refresh signal too — covers admin / pod-page surfaces that don't
    // subscribe to the live session room.
    emitSessionRoomEntities(
      io, sessionId,
      [E.session(sessionId), E.sessionParticipants(sessionId), E.sessionPlan(sessionId)],
    ).catch(() => {});

    // Phase 8A.5 (8 May spec) — cohost change must re-shape upcoming
    // rounds immediately. Pre-fix the schedule generated at Start
    // included this user as a regular participant; promoting them
    // mid-event left those upcoming rounds with the now-cohost
    // matched as if they were attendees. Trigger repairFutureRounds
    // so the plan re-runs without them.
    maybeRepairFutureRounds(io, sessionId).catch(err =>
      logger.warn({ err, sessionId }, 'Cohost-change plan repair failed (non-fatal)')
    );

    // Bug F (15 May Ali) + Bug 68 (18 May Stefan) — re-emit the host
    // dashboard so the newly-promoted co-host sees a populated HCC with
    // ZERO perceptible delay. Force variant bypasses the 1-second
    // coalesce window that would otherwise defer this emit; matching-
    // flow's emit fans out via getAllHostIds to every acting host,
    // including the freshly-inserted cohost row.
    if (_emitHostDashboardForce) await _emitHostDashboardForce(sessionId).catch(() => {});
    else if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});

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

    // Phase B1 (10 May spec) — co-hosts and admins can remove co-hosts.
    // Same pattern as handleAssignCohost above. Only handlePromoteCohost
    // (ownership transfer) remains original-host-only.
    if (!await verifyHost(socket, sessionId)) return;
    // Bug J (15 May Ali) — directors cannot demote a platform admin. The
    // session_cohosts row only exists if the admin opted in themselves
    // via the Phase M banner. Bug 2 (18 May Stefan) — the event director
    // can still demote them via the supreme-host carve-out; other acting
    // hosts cannot.
    if (!await refuseIfAdminTarget(socket, sessionId, userId)) return;

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
    // Bug 68 (18 May Stefan) — broadcast the roster change so every
    // viewer's count + badges update in the same tick.
    io.to(sessionRoom(sessionId)).emit('roster:changed', {
      sessionId,
      cause: 'cohost_removed',
    });

    // F3 (20 May 2026 — live-test post-mortem). Same defensive fanout as
    // handleAssignCohost — covers React-Query surfaces (admin / pod
    // pages, SessionDetailPage participants) that don't listen on the
    // live session room socket.
    emitSessionRoomEntities(
      io, sessionId,
      [E.session(sessionId), E.sessionParticipants(sessionId), E.sessionPlan(sessionId)],
    ).catch(() => {});

    // Phase 8A.5 (8 May spec) — demoted user re-enters the matching pool
    // for upcoming rounds. Trigger plan repair so the schedule includes
    // them again from the next round onward.
    maybeRepairFutureRounds(io, sessionId).catch(err =>
      logger.warn({ err, sessionId }, 'Cohost-change plan repair failed (non-fatal)')
    );

    // Bug F (15 May Ali) + Bug 68 (18 May Stefan) — force-emit so the
    // demoted user (and every other host) sees the role change with no
    // coalesce-induced delay.
    if (_emitHostDashboardForce) await _emitHostDashboardForce(sessionId).catch(() => {});
    else if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});

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
      // Phase 2 dual-emit — session row, participants list (cohost
      // affiliation changed), and the pod (pod-level admin lists may
      // surface the host). Audience: whole session room participants
      // + both endpoints to make sure their user-scoped queries refresh.
      try {
        const podIdRes = await query<{ pod_id: string | null }>(
          `SELECT pod_id FROM sessions WHERE id = $1`, [sessionId],
        );
        const podId = podIdRes.rows[0]?.pod_id ?? null;
        const entities = [
          E.session(sessionId), E.sessionParticipants(sessionId),
        ];
        if (podId) entities.push(E.pod(podId));
        await emitSessionRoomEntities(io, sessionId, entities);
        await emitEntities(io, [hostId, cohostUserId], entities);
      } catch { /* dual-emit failure non-fatal */ }

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

      // Bug 33 (19 May Ali) — host transfer changes the matching pool:
      // the previous director is now a participant (re-enters the pool)
      // and the new director leaves the pool. Plan must recompute. Reuse
      // the same maybeRepairFutureRounds wrapper used by assign/remove
      // cohost above (which itself fires host:event_plan_repaired plus
      // the session+plan entity emit). Bug 44 (19 May Ali) — and the
      // host dashboard must refresh so the new director's HCC and the
      // demoted host's view both show the post-transfer roster + plan.
      maybeRepairFutureRounds(io, sessionId).catch(err =>
        logger.warn({ err, sessionId }, 'Host-transfer plan repair failed (non-fatal)')
      );
      if (_emitHostDashboardForce) await _emitHostDashboardForce(sessionId).catch(() => {});
      else if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});

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

// ─── Host Visibility Mode (Phase G — 10 May spec item 11) ──────────────────
//
// Modes: big_speaker | normal | producer | hidden.
//
// Rules
//   • Caller must be able to act as host (verifyHost / canActAsHost — so
//     original host, co-hosts, pod directors, and super-admins can all
//     change any host's mode. Regular admins must be promoted to cohost
//     first; Phase I narrowed them out of the auto-host set).
//   • Target must be either the session's original host (sessions.host_user_id)
//     or an active session_cohosts row. Anyone else → 400.
//   • Persisted on the right column (sessions.host_visibility_mode for the
//     original host, session_cohosts.visibility_mode for co-hosts).
//   • Broadcast `host:visibility_changed { userId, mode }` to the session
//     room so all clients can re-render the lobby/video tiles. Hidden hosts
//     are filtered out client-side; big_speaker hosts are pinned big.

// HostVisibilityMode + isHostVisibilityMode now live in `@rsn/shared` so the
// server, client, and socket-event types all reference one source. Re-export
// for the few existing callers that imported from this module.
import { HostVisibilityMode, isHostVisibilityMode } from '@rsn/shared';
export { isHostVisibilityMode };
export type { HostVisibilityMode };

export interface RequesterContext {
  userId: string;
  role: UserRole | undefined;
}

export async function setHostVisibility(
  sessionId: string,
  requester: RequesterContext,
  targetUserId: string,
  mode: HostVisibilityMode,
): Promise<{ userId: string; mode: HostVisibilityMode }> {
  // Auth: caller must be able to act as host.
  const { canActAsHost } = await import('../../roles/effective-role.service');
  const { allowed } = await canActAsHost(requester.userId, requester.role, sessionId);
  if (!allowed) {
    throw new ForbiddenError('Only hosts, co-hosts, or admins can set visibility');
  }
  if (!isHostVisibilityMode(mode)) {
    throw new ValidationError(`Invalid visibility mode: ${String(mode)}`);
  }

  // Phase H (10 May simplify pass) — single UPDATE per target column with
  // rowCount check. Pre-fix did SELECT-then-UPDATE on session_cohosts which
  // was a needless round-trip (and a TOCTOU race in theory). Now: try the
  // exact column the target identifies as, and only fail if no row matches.
  const session = await sessionService.getSessionById(sessionId);
  let updated = false;

  if (session.hostUserId === targetUserId) {
    const r = await query(
      `UPDATE sessions SET host_visibility_mode = $1::host_visibility_mode WHERE id = $2`,
      [mode, sessionId],
    );
    updated = (r.rowCount ?? 0) > 0;
  } else {
    const r = await query(
      `UPDATE session_cohosts SET visibility_mode = $1::host_visibility_mode
        WHERE session_id = $2 AND user_id = $3`,
      [mode, sessionId, targetUserId],
    );
    updated = (r.rowCount ?? 0) > 0;
  }

  if (!updated) {
    throw new ValidationError('Target user is not a host or co-host of this session');
  }

  if (_io) {
    _io.to(sessionRoom(sessionId)).emit('host:visibility_changed', {
      sessionId,
      userId: targetUserId,
      mode,
    });
    // Phase 2 dual-emit — session entity covers session-detail / host-state
    // queries (which surface visibility modes) for every participant in
    // the room.
    emitSessionRoomEntities(_io, sessionId, [E.session(sessionId)]).catch(() => {});
  }

  logger.info({ sessionId, targetUserId, mode, requesterUserId: requester.userId },
    'Host visibility mode updated');
  return { userId: targetUserId, mode };
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

      // Phase 4A (5 May spec) — atomic create-breakout flow.
      //
      // Stefan #6 + #7: pre-fix, Step 1 (reassign existing matches) and
      // Step 3 (insert new manual match) were independent DB writes — if
      // Step 3 failed, Step 1's reassignments stuck, leaving participants
      // stranded in 'reassigned' state with no replacement room. The
      // current order: LiveKit room first (fail fast — no DB writes if
      // room creation fails), then Steps 1+3 wrapped in a single
      // transaction so they commit together or roll back together.
      //
      // The LiveKit room is idempotent — if the transaction rolls back
      // after room creation, the room is orphaned but harmless (empty
      // room with no participants ever joining; LiveKit garbage-collects
      // empty rooms).

      // Step 2 (was): Create LiveKit room FIRST. If this fails, return
      // immediately — no DB writes have happened, no rollback needed.
      const roomSlug = `host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        await videoService.createMatchRoom(sessionId, activeSession.currentRound, roomSlug);
      } catch (err) {
        logger.error({ err }, 'Failed to create LiveKit room for host breakout');
        socket.emit('error', { code: 'ROOM_CREATION_FAILED', message: 'Failed to create breakout room. Try again.' });
        if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
        return;
      }
      const newRoomId = videoService.matchRoomId(sessionId, activeSession.currentRound, roomSlug);

      // Steps 1 + 3 wrapped in a single transaction. If the new-match INSERT
      // fails, the existing matches stay 'active' (reassignments rolled
      // back). Notifications for the orphaned partners are deferred until
      // AFTER the transaction commits so we never emit "your partner left"
      // for a reassignment that didn't actually take effect.
      let matchId = '';
      type ReassignedMatch = { matchId: string; remainingPartners: string[] };
      const reassignedForNotification: ReassignedMatch[] = [];
      try {
        await transaction(async (client) => {
          // Step 1 (in-transaction): reassign existing active matches for
          // each participant being moved.
          for (const pid of participantIds) {
            const currentMatch = await client.query<{ id: string; participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null }>(
              `SELECT id, participant_a_id, participant_b_id, participant_c_id FROM matches
               WHERE session_id = $1 AND status = 'active'
                 AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)`,
              [sessionId, pid],
            );
            if (currentMatch.rows.length === 0) continue;
            const match = currentMatch.rows[0];
            await client.query(
              `UPDATE matches SET status = 'reassigned', ended_at = NOW() WHERE id = $1 AND status = 'active'`,
              [match.id],
            );
            const remainingPartners = [match.participant_a_id, match.participant_b_id, match.participant_c_id]
              .filter((id): id is string => !!id && id !== pid && !participantIds.includes(id));
            reassignedForNotification.push({ matchId: match.id, remainingPartners });
          }

          // Step 3 (in-transaction): create the new manual match. A failure
          // here rolls back every reassignment from Step 1.
          if (participantIds.length >= 1) {
            const { v4: uuid } = await import('uuid');
            matchId = uuid();
            const sorted = [...participantIds].sort();
            await client.query(
              `INSERT INTO matches (id, session_id, round_number, participant_a_id, participant_b_id, participant_c_id, room_id, status, started_at, is_manual)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), TRUE)`,
              [matchId, sessionId, activeSession.currentRound, sorted[0], sorted[1] || null, sorted[2] || null, newRoomId],
            );
          }
        });
      } catch (err: any) {
        logger.error({ err }, 'Phase 4A — atomic create-breakout transaction rolled back');
        if (err?.code === '23505' || /unique|duplicate|already/i.test(err?.message || '')) {
          socket.emit('error', {
            code: 'PARTICIPANT_ALREADY_MATCHED',
            message: 'One or more participants are already in another active match. Wait for it to end.',
          });
        } else {
          socket.emit('error', { code: 'MATCH_CREATION_FAILED', message: 'Failed to create room assignment. Try again.' });
        }
        if (_emitHostDashboard) await _emitHostDashboard(sessionId).catch(() => {});
        return;
      }

      // Post-transaction: notifications + solo-partner return-to-lobby.
      // Run only AFTER the transaction commits so we never emit "your
      // partner left" for a reassignment that was rolled back.
      for (const reassigned of reassignedForNotification) {
        for (const partnerId of reassigned.remainingPartners) {
          io.to(userRoom(partnerId)).emit('match:partner_disconnected', { matchId: reassigned.matchId });
        }
        if (reassigned.remainingPartners.length === 1) {
          const soloPartnerId = reassigned.remainingPartners[0];
          const reassignedMatchId = reassigned.matchId;
          setTimeout(async () => {
            try {
              const s = activeSessions.get(sessionId);
              if (!s || s.status !== SessionStatus.ROUND_ACTIVE) return;
              const freshMatch = (await matchingService.getMatchesByRound(sessionId, s.currentRound))
                .find(m => m.id === reassignedMatchId);
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

      // Phase 0 (1 May spec) — server-canonical room assignment for host
      // single-breakout. Same architectural rule.
      if (participantIds.length > 0 && matchId) {
        const { setRoomAssignment } = await import('./participant-flow');
        setRoomAssignment(sessionId, matchId, newRoomId, participantIds);
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

// ─── Host Set Pin ───────────────────────────────────────────────────────────
//
// Bug 1 (18 May Stefan) — global pin. When an acting host clicks the pin
// icon on a participant, that participant becomes the big tile for EVERY
// viewer in the event (not just the host who clicked). Pre-fix the pin
// was local-per-viewer, which Stefan called out as the wrong architecture:
// "When host pins/highlights someone, that person should become large for
// all participants, not only for the host."
//
// Wire:
//   client (host clicks pin) → emit host:set_pin { sessionId, pinnedUserId }
//   server → verifyHost → activeSession.pinnedUserId = ... → persistSessionState
//   server → emit pin:changed { pinnedUserId } to sessionRoom (everyone)
//   client → store.setServerPinnedUserId(...) → Lobby re-renders pinned-mode
//
// Sending pinnedUserId=null clears the global pin (everyone's view returns
// to default grid, host auto-elevated). Participants can still set their
// own local pin while no global pin is active.

export async function handleHostSetPin(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; pinnedUserId: string | null },
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    try {
      if (!await verifyHost(socket, data.sessionId)) return;
      const { sessionId } = data;
      const activeSession = activeSessions.get(sessionId);
      if (!activeSession) {
        socket.emit('error', { code: 'SESSION_NOT_ACTIVE', message: 'No active session for pin' });
        return;
      }
      // Normalise: empty string / undefined / non-string → null.
      const pinnedUserId =
        typeof data.pinnedUserId === 'string' && data.pinnedUserId.length > 0
          ? data.pinnedUserId
          : null;
      // No-op if unchanged — saves a broadcast + DB write.
      if ((activeSession.pinnedUserId ?? null) === pinnedUserId) return;

      activeSession.pinnedUserId = pinnedUserId;
      persistSessionState(sessionId, activeSession).catch(() => {});

      // Broadcast to the whole session room — every participant rerenders
      // their lobby with the new pin (or unpins if pinnedUserId=null).
      io.to(sessionRoom(sessionId)).emit('pin:changed', {
        sessionId,
        pinnedUserId,
      });
      // Phase 2 dual-emit — session entity (host-state surfaces include
      // the pinned user) for the whole audience.
      emitSessionRoomEntities(io, sessionId, [E.session(sessionId)]).catch(() => {});

      logger.info(
        { sessionId, pinnedUserId, by: getUserIdFromSocket(socket) },
        'Host set/cleared global pin',
      );
    } catch (err: any) {
      logger.error({ err }, 'Error in handleHostSetPin');
      socket.emit('error', { code: 'SET_PIN_FAILED', message: err.message || 'Failed to set pin' });
    }
  });
}

// Bug 26 (19 May Ali) — director can flatten a cohost's tile to participant
// size without revoking any privilege. Visual-only override: cohost keeps
// HCC, mute-other, etc. — only their tile-grid sizing changes. Director-only
// authority (super_admin acting as host does NOT count as director here).
export async function handleHostSetTileSize(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; targetUserId: string; size: 'participant' | 'host' },
): Promise<void> {
  return withSessionGuard(data.sessionId, async () => {
    try {
      const { sessionId, targetUserId, size } = data;
      const callerId = getUserIdFromSocket(socket);
      const activeSession = activeSessions.get(sessionId);
      if (!activeSession) {
        socket.emit('error', { code: 'SESSION_NOT_ACTIVE', message: 'No active session for tile resize' });
        return;
      }
      // Director-only: hostUserId is THE event director (cohosts are
      // separate). Even super_admin acting as host does NOT pass here —
      // tile flattening is the director's prerogative.
      if (!callerId || callerId !== activeSession.hostUserId) {
        socket.emit('error', { code: 'NOT_DIRECTOR', message: 'Only the event director can resize tiles' });
        return;
      }
      if (!targetUserId || typeof targetUserId !== 'string') {
        socket.emit('error', { code: 'INVALID_TARGET', message: 'targetUserId required' });
        return;
      }
      if (size !== 'participant' && size !== 'host') {
        socket.emit('error', { code: 'INVALID_SIZE', message: "size must be 'participant' or 'host'" });
        return;
      }
      // Issue 13 (20 May Stefan) — "Host should be able to unpin." Phase Q
      // auto-elevates the director's tile (col-span-2 row-span-2). The
      // original Bug 26 handler refused self-demote on the rationale that
      // a director "can't be cohost of their own event." Stefan disagreed
      // on the live test: the director wants the option to drop their
      // own tile back to participant size when they're producing rather
      // than presenting. Visual-only — director still owns every host
      // privilege. Cohost demote semantics are unchanged.
      const current = new Set(activeSession.tileDemotedUserIds ?? []);
      const before = current.size;
      if (size === 'participant') current.add(targetUserId);
      else current.delete(targetUserId);
      const after = current.size;
      // No-op if unchanged — saves a broadcast.
      if (before === after) return;

      activeSession.tileDemotedUserIds = Array.from(current);
      persistSessionState(sessionId, activeSession).catch(() => {});

      io.to(sessionRoom(sessionId)).emit('tile:size_changed', {
        sessionId,
        tileDemotedUserIds: activeSession.tileDemotedUserIds,
      });
      // Phase 2 dual-emit — session entity (the demoted-ids list is part
      // of the session-state snapshot consumed by every viewer).
      emitSessionRoomEntities(io, sessionId, [E.session(sessionId)]).catch(() => {});

      logger.info(
        { sessionId, targetUserId, size, by: callerId, total: after },
        'Director set cohost tile size override',
      );
    } catch (err: any) {
      logger.error({ err }, 'Error in handleHostSetTileSize');
      socket.emit('error', { code: 'SET_TILE_SIZE_FAILED', message: err.message || 'Failed to resize tile' });
    }
  });
}
