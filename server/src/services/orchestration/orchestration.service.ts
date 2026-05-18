// ─── Orchestration Service — Entry Point ────────────────────────────────────
// Thin wiring layer that imports all handler modules, injects cross-module
// dependencies, registers socket handlers with try-catch wrappers (FIX 5A),
// and re-exports the public API consumed by REST routes and index.ts.
//
// State machine:
//   SCHEDULED → LOBBY_OPEN → ROUND_ACTIVE(n) → ROUND_RATING(n)
//   → ROUND_TRANSITION(n) → ROUND_ACTIVE(n+1) ... → CLOSING_LOBBY → COMPLETED

import { Server as SocketServer, Socket } from 'socket.io';
import logger from '../../config/logger';
import { SessionStatus } from '@rsn/shared';

// Phase 2 (19 May 2026) — realtime architecture migration dual-emit. Each
// existing notify* fanout below ALSO calls emitEntities() with the matching
// domain-entity tags so the client's generic predicate handler can
// invalidate the right React-Query keys. The legacy emit stays until
// Phase 5; both pathways coexist. See:
//   docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
import { emitEntities } from '../../realtime/emit';
import { E } from '../../realtime/entities';

// State
import {
  activeSessions, getUserIdFromSocket, cleanupChatMessages,
} from './state/session-state';

// Handlers — Participant Flow
import {
  handleJoinSession, handleLeaveSession, handleHeartbeat, handleReady,
  handleDisconnect, handleRatingSubmit, handleLeaveConversation,
  handleRoomJoined,
  startHeartbeatStaleDetection, notifyRatingSubmitted,
  injectDependencies as injectParticipantDeps,
} from './handlers/participant-flow';

// Handlers — Host Actions
import {
  handleHostStart, handleHostStartRound, handleHostPause, handleHostResume,
  handleHostEnd, handleHostBroadcast, handleHostRemoveParticipant, handleHostReassign,
  handleHostMuteParticipant, handleHostMuteAll, handleHostRemoveFromRoom,
  handleHostMoveToRoom, handleAssignCohost, handleRemoveCohost, handlePromoteCohost, handleHostExtendRound,
  handleHostExtendBreakoutRoom, handleHostCreateBreakout,
  handleHostSetPin, handleHostSetTileSize,
  startSession, pauseSession, resumeSession, endSession, broadcastMessage,
  setHostVisibility,
  setHostActionsIo, injectHostActionDeps,
} from './handlers/host-actions';

// Handlers — Matching Flow
import {
  handleHostGenerateMatches, handleHostConfirmRound, handleHostConfirmMatches,
  handleHostSwapMatch, handleHostExcludeFromRound, handleHostRegenerateMatches,
  handleHostCancelPreview, handleHostForceMatch, emitHostDashboard, emitHostDashboardForce, injectMatchingFlowDeps,
} from './handlers/matching-flow';

// Handlers — Round Lifecycle
import {
  transitionToRound, endRound, endRatingWindow, completeSession,
  recoverActiveSessions, injectRoundLifecycleDeps, maybeAutoEndEmptyRound,
} from './handlers/round-lifecycle';

// Handlers — Chat
import { handleChatSend, handleChatReact, handleReactionSend, handleChatRequestHistory } from './handlers/chat-handlers';
import { handleDmSend, handleDmRead, handleDmReact, handleDmUnreact } from './handlers/dm-handlers';
// Phase 2E (5 May spec) — global state reconciler.
import { startGlobalReconciler } from './state/participant-state-machine';

// Handlers — Bulk Breakout (Task 14)
import {
  handleHostCreateBreakoutBulk, handleHostExtendBreakoutAll,
  handleHostEndBreakoutAll, handleHostSetBreakoutDurationAll,
  injectBreakoutBulkDeps,
} from './handlers/breakout-bulk';

// Timer Manager
import { clearSessionTimers, TimerCallbacks } from './handlers/timer-manager';

let io: SocketServer;

// ── Try-Catch Wrapper (FIX 5A) ────────────────────────────────────────────

function wrapHandler(
  eventName: string,
  socket: Socket,
  handler: (io: SocketServer, socket: Socket, data: any) => Promise<void>
): void {
  socket.on(eventName, async (data: any) => {
    try {
      await handler(io, socket, data);
    } catch (err) {
      const userId = getUserIdFromSocket(socket);
      logger.error({ err, event: eventName, userId }, 'Socket handler error');
      socket.emit('error', { message: 'Something went wrong. Please try again.' });
    }
  });
}

// ── Initialise ─────────────────────────────────────────────────────────────

export function initOrchestration(socketServer: SocketServer): void {
  io = socketServer;

  // Give host-actions module access to io for REST API helpers
  setHostActionsIo(io);

  // ── Wire cross-module dependencies ──

  const timerCallbacks: TimerCallbacks = {
    transitionToRound: (sessionId, roundNumber) => transitionToRound(io, sessionId, roundNumber),
    endRound: (sessionId, roundNumber) => endRound(io, sessionId, roundNumber),
    endRatingWindow: (sessionId, roundNumber) => endRatingWindow(io, sessionId, roundNumber),
    completeSession: (sessionId) => completeSession(io, sessionId),
  };

  injectHostActionDeps({
    transitionToRound: (ioServer, sessionId, roundNumber) => transitionToRound(ioServer, sessionId, roundNumber),
    completeSession: (ioServer, sessionId) => completeSession(ioServer, sessionId),
    endRound: (ioServer, sessionId, roundNumber) => endRound(ioServer, sessionId, roundNumber),
    emitHostDashboard: (sessionId) => emitHostDashboard(io, sessionId),
    // Bug 68 (18 May Stefan) — coalesce-bypass for cohost promote/demote.
    emitHostDashboardForce: (sessionId) => emitHostDashboardForce(io, sessionId),
    timerCallbacks,
    // Bug 4 (April 18 Dr Arch): wire auto-end so host actions that end matches
    // can recover the session if every active match in the round is gone.
    maybeAutoEndEmptyRound: (sessionId) => maybeAutoEndEmptyRound(io, sessionId),
  });

  injectMatchingFlowDeps({
    transitionToRound: (ioServer, sessionId, roundNumber) => transitionToRound(ioServer, sessionId, roundNumber),
  });

  injectRoundLifecycleDeps({
    timerCallbacks,
    emitHostDashboard: (ioServer, sessionId) => emitHostDashboard(ioServer, sessionId),
  });

  injectParticipantDeps({
    emitHostDashboard: (sessionId) => emitHostDashboard(io, sessionId),
    endRatingWindow: (sessionId, roundNumber) => endRatingWindow(io, sessionId, roundNumber),
    // Bug 4 (April 18 Dr Arch): voluntary leave / disconnect may end the last
    // active match — auto-recover the round.
    maybeAutoEndEmptyRound: (sessionId) => maybeAutoEndEmptyRound(io, sessionId),
  });

  injectBreakoutBulkDeps({
    emitHostDashboard: (sessionId) => emitHostDashboard(io, sessionId),
  });

  // ── Recover active sessions from DB ──

  recoverActiveSessions(io).catch(err =>
    logger.error({ err }, 'Failed to recover active sessions')
  );

  // ── Start heartbeat stale detection (FIX 5E) ──

  startHeartbeatStaleDetection(io);

  // ── Phase 2E (5 May spec) — periodic state-machine reconciler ──
  // Auto-heals participant-state drift every 30 s so users never need to
  // leave-and-rejoin to recover from a wedged state.
  startGlobalReconciler();

  // ── TTL cleanup (every 5 minutes, remove sessions older than 4 hours) ──

  const MAX_SESSION_AGE_MS = 4 * 60 * 60 * 1000;
  setInterval(async () => {
    const now = Date.now();
    const { clearDashboardCoalesce } = await import('./handlers/matching-flow');
    const { cleanupLiveKitRooms } = await import('./handlers/round-lifecycle');
    for (const [sessionId, session] of activeSessions) {
      const lastActivity = session.timerEndsAt?.getTime() || now;
      if (now - lastActivity > MAX_SESSION_AGE_MS) {
        logger.warn({ sessionId }, 'Cleaning up stale session (TTL exceeded)');
        clearSessionTimers(sessionId);
        // Phase A4 (10 May spec) — tear down LiveKit rooms before dropping
        // the in-memory entry. Pre-fix this only deleted the in-memory
        // ActiveSession, leaving LiveKit rooms alive forever (Stefan's
        // #17). Fire-and-forget so the loop keeps making progress.
        cleanupLiveKitRooms(sessionId).catch(err =>
          logger.warn({ err, sessionId }, 'TTL reaper: LiveKit cleanup failed (non-fatal)'));
        activeSessions.delete(sessionId);
        cleanupChatMessages(sessionId);
        // Tier-1 A1: also clear dashboard coalesce state
        clearDashboardCoalesce(sessionId);
      }
    }
  }, 5 * 60 * 1000);

  // ── Phase A4 (10 May spec) — orphan-lobby reaper ──
  // Catches sessions that ended cleanly via completeSession (which awaits
  // LiveKit cleanup) but whose lobby room id stuck around in DB or LiveKit
  // due to a transient failure, AND sessions that ended pre-Phase-A4 (whose
  // lobby_room_id was never nulled). Runs every 15 min, sweeps anything
  // that's been completed/cancelled for >1 h.
  const ORPHAN_REAPER_INTERVAL_MS = 15 * 60 * 1000;
  setInterval(async () => {
    try {
      const { query } = await import('../../db');
      const { cleanupLiveKitRooms } = await import('./handlers/round-lifecycle');
      const stale = await query<{ id: string }>(
        `SELECT id FROM sessions
          WHERE status IN ('completed', 'cancelled')
            AND lobby_room_id IS NOT NULL
            AND ended_at < NOW() - INTERVAL '1 hour'
          LIMIT 50`,
      );
      if (stale.rows.length === 0) return;
      logger.info({ count: stale.rows.length }, 'Orphan-lobby reaper: tearing down stale rooms');
      // Phase H (10 May simplify pass) — clean each orphan in parallel.
      // Pre-fix this awaited cleanupLiveKitRooms sequentially in a loop;
      // a 50-row backlog × 500ms per LiveKit close = 25s of unnecessary
      // serial work per tick. Promise.allSettled keeps per-row error
      // isolation while letting LiveKit closes overlap.
      const results = await Promise.allSettled(
        stale.rows.map(async row => {
          await cleanupLiveKitRooms(row.id);
          await query(`UPDATE sessions SET lobby_room_id = NULL WHERE id = $1`, [row.id]);
        }),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          logger.warn({ err: r.reason, sessionId: stale.rows[i].id },
            'Orphan-lobby reaper: per-session cleanup failed (will retry next tick)');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Orphan-lobby reaper tick failed');
    }
  }, ORPHAN_REAPER_INTERVAL_MS);

  // ── Register socket handlers ──

  io.on('connection', (socket: Socket) => {
    const userId = getUserIdFromSocket(socket);
    if (userId) socket.join(`user:${userId}`);

    // ── Participant Events (guarded — state-mutating) ──
    wrapHandler('session:join', socket, handleJoinSession);
    wrapHandler('session:leave', socket, handleLeaveSession);
    wrapHandler('rating:submit', socket, handleRatingSubmit);
    wrapHandler('participant:leave_conversation', socket, handleLeaveConversation);

    // ── Participant Events (unguarded) ──
    socket.on('presence:heartbeat', (data) => {
      try { handleHeartbeat(socket, data); }
      catch (err) { logger.error({ err, userId }, 'Heartbeat handler error'); }
    });
    socket.on('presence:ready', async (data) => {
      try { await handleReady(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Ready handler error'); }
    });
    // T0-2 (Issue 7) — fired by VideoRoom after LiveKit room.connect()
    // resolves. Distinct from presence:ready: this confirms LiveKit room
    // membership specifically, so the host dashboard can show real
    // breakout state instead of false-positive "active".
    socket.on('presence:room_joined', async (data) => {
      try { await handleRoomJoined(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Room-joined handler error'); }
    });

    // ── Host Events (guarded — state-mutating) ──
    wrapHandler('host:start_session', socket, handleHostStart);
    wrapHandler('host:start_round', socket, handleHostStartRound);
    wrapHandler('host:pause_session', socket, handleHostPause);
    wrapHandler('host:resume_session', socket, handleHostResume);
    wrapHandler('host:end_session', socket, handleHostEnd);
    wrapHandler('host:remove_participant', socket, handleHostRemoveParticipant);
    wrapHandler('host:reassign', socket, handleHostReassign);
    wrapHandler('host:remove_from_room', socket, handleHostRemoveFromRoom);
    wrapHandler('host:move_to_room', socket, handleHostMoveToRoom);
    wrapHandler('host:create_breakout', socket, handleHostCreateBreakout);
    wrapHandler('host:assign_cohost', socket, handleAssignCohost);
    wrapHandler('host:remove_cohost', socket, handleRemoveCohost);
    // Bug 1 (18 May Stefan) — global pin broadcast. Acting hosts can set
    // a pin that every participant's lobby honours.
    wrapHandler('host:set_pin', socket, handleHostSetPin);
    // Bug 26 (19 May Ali) — director can flatten a cohost's tile to
    // participant size (visual only; cohost keeps all privileges).
    wrapHandler('host:set_tile_size', socket, handleHostSetTileSize);
    // T1-5 — host can pass the baton to an existing co-host
    wrapHandler('host:promote_cohost', socket, handlePromoteCohost);
    wrapHandler('host:extend_round', socket, handleHostExtendRound);
    wrapHandler('host:extend_breakout_room', socket, handleHostExtendBreakoutRoom);

    // ── Bulk Manual Breakout (Task 14) ──
    wrapHandler('host:create_breakout_bulk', socket, handleHostCreateBreakoutBulk);
    wrapHandler('host:extend_breakout_all', socket, handleHostExtendBreakoutAll);
    wrapHandler('host:end_breakout_all', socket, handleHostEndBreakoutAll);
    wrapHandler('host:set_breakout_duration_all', socket, handleHostSetBreakoutDurationAll);

    // ── Host Events (unguarded — no session state mutation) ──
    socket.on('host:broadcast_message', async (data) => {
      try { await handleHostBroadcast(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Broadcast handler error'); }
    });
    socket.on('host:mute_participant', async (data) => {
      try { await handleHostMuteParticipant(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Mute handler error'); }
    });
    socket.on('host:mute_all', async (data) => {
      try { await handleHostMuteAll(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Mute all handler error'); }
    });

    // ── Matching Events (guarded) ──
    wrapHandler('host:generate_matches', socket, handleHostGenerateMatches);
    wrapHandler('host:confirm_matches', socket, handleHostConfirmMatches);
    wrapHandler('host:confirm_round', socket, handleHostConfirmRound);
    wrapHandler('host:swap_match', socket, handleHostSwapMatch);
    wrapHandler('host:exclude_participant', socket, handleHostExcludeFromRound);
    wrapHandler('host:regenerate_matches', socket, handleHostRegenerateMatches);
    wrapHandler('host:cancel_preview', socket, handleHostCancelPreview);
    wrapHandler('host:force_match', socket, handleHostForceMatch);

    // ── Chat Events (unguarded) ──
    socket.on('chat:send', async (data) => {
      try { await handleChatSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat send error'); }
    });
    socket.on('chat:react', async (data) => {
      try { await handleChatReact(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat react error'); }
    });
    // Phase 4B (5 May spec) — chat history force-fetch fallback for Stefan #8.
    socket.on('chat:request_history', async (data) => {
      try { await handleChatRequestHistory(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Chat request_history error'); }
    });
    socket.on('reaction:send', async (data) => {
      try { await handleReactionSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'Reaction error'); }
    });

    // ── DM Events (Phase D, 1 May 2026 spec) — platform-level person-to-
    // person messaging. Independent of any session/round/event.
    socket.on('dm:send', async (data) => {
      try { await handleDmSend(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'DM send error'); }
    });
    socket.on('dm:read', async (data) => {
      try { await handleDmRead(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'DM read error'); }
    });
    // Phase E (3 May 2026) — emoji reactions on DM messages.
    socket.on('dm:react', async (data) => {
      try { await handleDmReact(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'DM react error'); }
    });
    socket.on('dm:unreact', async (data) => {
      try { await handleDmUnreact(io, socket, data); }
      catch (err) { logger.error({ err, userId }, 'DM unreact error'); }
    });

    // ── Disconnect ──
    socket.on('disconnect', async () => {
      try { await handleDisconnect(io, socket); }
      catch (err) { logger.error({ err, userId }, 'Disconnect handler error'); }
    });
  });
}

// ── Phase M (12 May spec item 1) — permissions:updated notifier ────────────
//
// REST handlers that change a user's effective role (acting_as_host toggle,
// future opt-in / opt-out paths) emit through this helper so the client
// re-fetches its session-state snapshot. The existing client handler at
// useSessionSocket.ts:171 already calls fetchSessionStateSnapshot() on
// permissions:updated — Phase M just reuses that path. The payload is
// intentionally minimal: only the sessionId/userId/cause so the client can
// route the resync; it does NOT carry the new effective role, because the
// snapshot is the canonical source of truth.

/**
 * Bug 3 (18 May Stefan) — notify a single user that their pod
 * membership status changed (approved / rejected / promoted / demoted /
 * removed). Front-end listens on their personal room and refetches the
 * pending-pods / my-pods queries so the UI flips from "Pending approval"
 * to "Active member" without a refresh.
 *
 * cause: short reason string for analytics + client-side messaging.
 */
export async function notifyPodMembershipChanged(
  podId: string,
  userId: string,
  cause: string,
): Promise<void> {
  if (!io) return;
  const { userRoom } = await import('./state/session-state');
  io.to(userRoom(userId)).emit('pod:membership_updated', {
    podId,
    userId,
    cause,
  });
  // Phase 2 dual-emit — the target user's pod queries (pod, pod-members,
  // my-pods) refetch. The user-specific user:pods covers their "Which pods
  // do I belong to" UI.
  emitEntities(
    io,
    [userId],
    [E.pod(podId), E.podMembers(podId), E.userPods(userId)],
  ).catch(() => {});
}

/**
 * Bug 19 (18 May Stefan) — fan-out variant: notify EVERY current member
 * of a pod that something on the pod changed (member added/removed/role
 * change, pod archived, etc). Every member's UI invalidates the pod
 * queries on receipt so the member list, role badges, and pending counts
 * stay in sync across all open clients without a refresh.
 *
 * Uses a single query to find members, then emits one event per user's
 * room. Cheap at typical pod sizes (under a few hundred members).
 */
export async function notifyPodChanged(podId: string, cause: string): Promise<void> {
  if (!io) return;
  try {
    const { userRoom } = await import('./state/session-state');
    const { query } = await import('../../db');
    const result = await query<{ user_id: string }>(
      // status NOT IN ('removed','declined') — keep notifying members who
      // are 'invited' or 'pending_approval' too so their UI reflects the
      // change immediately.
      `SELECT user_id FROM pod_members
       WHERE pod_id = $1 AND status NOT IN ('removed', 'declined')`,
      [podId],
    );
    for (const row of result.rows) {
      io.to(userRoom(row.user_id)).emit('pod:membership_updated', {
        podId,
        userId: row.user_id,
        cause,
      });
    }
    // Phase 2 dual-emit — pod itself, member list, and invite list cover
    // every pod-scoped query (membership, role, invite, settings changes
    // all converge on these tags). Re-use the recipient list already
    // resolved above so we don't re-query.
    emitEntities(
      io,
      result.rows.map(r => r.user_id),
      [E.pod(podId), E.podMembers(podId), E.podInvites(podId)],
    ).catch(() => {});
  } catch (err) {
    logger.warn({ err, podId, cause }, 'notifyPodChanged: failed to fan out');
  }
}

/**
 * Bug 20 (18 May Stefan) — broadcast that a session list / detail has
 * changed (new session created, started, ended, registration count
 * shifted, etc). Every pod member's UI invalidates the my-sessions /
 * pod-sessions / session-detail queries on receipt. Same fan-out
 * pattern as notifyPodChanged so a single event covers everyone who
 * could be looking at the affected list.
 */
export async function notifySessionListChanged(
  podId: string | null,
  sessionId: string,
  cause: string,
): Promise<void> {
  if (!io) return;
  try {
    const { userRoom } = await import('./state/session-state');
    const { query } = await import('../../db');
    // Fan-out: anyone who is a pod member OR registered for this session
    // gets the event. The UNION DISTINCT keeps the loop small.
    const result = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants
         WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')
       UNION
       SELECT user_id FROM pod_members
         WHERE pod_id = COALESCE($2, '00000000-0000-0000-0000-000000000000'::uuid)
           AND status NOT IN ('removed', 'declined')`,
      [sessionId, podId],
    );
    for (const row of result.rows) {
      io.to(userRoom(row.user_id)).emit('session:list_changed', {
        sessionId,
        podId,
        cause,
      });
    }
    // Phase 2 dual-emit — session row + (optional) pod's session list +
    // session participants. The session itself updates session/host-state/
    // event-plan queries; pod:sessions covers pod-level session lists;
    // sessionParticipants covers the participant-count surfaces that
    // session-list mutations also affect.
    const entities = [E.session(sessionId), E.sessionParticipants(sessionId)];
    if (podId) entities.push(E.podSessions(podId));
    emitEntities(io, result.rows.map(r => r.user_id), entities).catch(() => {});
  } catch (err) {
    logger.warn({ err, sessionId, cause }, 'notifySessionListChanged: failed to fan out');
  }
}

export async function notifyPermissionsUpdated(
  sessionId: string,
  userId: string,
  cause: string = 'acting_as_host_changed',
): Promise<void> {
  if (!io) return;
  const { userRoom, sessionRoom } = await import('./state/session-state');
  io.to(userRoom(userId)).emit('permissions:updated', {
    sessionId,
    userId,
    cause,
  });
  // Phase 2 dual-emit — session + participants list + this specific user.
  // The user gets the entity tags so their session-detail / unrated-
  // partners / user-scoped queries pick up the change in one tick.
  emitEntities(
    io,
    [userId],
    [E.session(sessionId), E.sessionParticipants(sessionId), E.user(userId)],
  ).catch(() => {});
  // Bug 68 (18 May Stefan) — every roster mutation must be visible to
  // EVERY connected client without a refresh. Pre-fix, only the target
  // user received permissions:updated; other participants kept the stale
  // count + stale badges until the next 30s session:state tick. The
  // roster:changed broadcast tells the whole session room to re-pull the
  // snapshot, which already includes the latest cohosts/overrides/counts/
  // hccParticipants. One small event, one snapshot fetch per client —
  // and everyone's UI is consistent within the same tick as the action.
  io.to(sessionRoom(sessionId)).emit('roster:changed', {
    sessionId,
    cause,
  });
  // Phase 2 dual-emit — roster:changed targets the WHOLE session room,
  // so resolve the same audience (active session_participants) and emit
  // session + participants entities so every client's session-scoped
  // queries (session-participants, session-cohost, unrated-partners,
  // session-participant-counts) refetch in the same tick.
  try {
    const { query } = await import('../../db');
    const rosterRows = await query<{ user_id: string }>(
      `SELECT user_id FROM session_participants
        WHERE session_id = $1 AND status NOT IN ('removed', 'left', 'no_show')`,
      [sessionId],
    );
    emitEntities(
      io,
      rosterRows.rows.map(r => r.user_id),
      [E.session(sessionId), E.sessionParticipants(sessionId)],
    ).catch(() => {});
  } catch {
    /* roster fanout is best-effort */
  }
  // Bug F + I (15 May Ali) — keep re-emitting the HCC dashboard so every
  // acting host sees the new role layout in the same tick. Force-variant
  // bypass the coalesce so a back-to-back acting-as-host toggle doesn't
  // defer the second emit.
  try {
    const { emitHostDashboardForce } = await import('./handlers/matching-flow');
    await emitHostDashboardForce(io, sessionId);
  } catch {
    /* opportunistic refresh — non-fatal if the helper isn't ready */
  }
}

// ── Phase May-19 realtime gap closures ─────────────────────────────────────
//
// Code-reviewer pass flagged 12+ REST routes that mutate state but never
// emit any socket fanout, causing "I did X and the other screen didn't
// update" bugs across admin / users / notifications / DM-reactions /
// join-requests / groups / sessions / reports. The helpers below extend
// the existing notifyPodChanged / notifySessionListChanged shape (query
// the affected user rows, then io.to(userRoom(id)).emit(...) per row) so
// every gap can be patched with the same idiom.

/**
 * Broadcast that an admin-managed list (users, pods, sessions, violations,
 * templates, support-tickets, join-requests, email-config) has changed.
 * Sent to every admin/super_admin user so any open admin dashboard
 * invalidates its React-Query keys immediately. Best-effort — DB lookup
 * failures are swallowed because the user-visible mutation already
 * succeeded.
 *
 * scope: one of 'users' | 'pods' | 'sessions' | 'violations' | 'templates'
 *        | 'support-tickets' | 'join-requests' | 'email-config'. Free-form
 *        so a new admin list can plug in without changing this signature.
 * cause: short reason string for analytics + client-side messaging.
 */
export async function notifyAdminListChanged(
  scope: string,
  cause: string,
): Promise<void> {
  if (!io) return;
  try {
    const { userRoom } = await import('./state/session-state');
    const { query } = await import('../../db');
    const result = await query<{ id: string }>(
      `SELECT id FROM users WHERE role IN ('admin', 'super_admin')`,
    );
    for (const row of result.rows) {
      io.to(userRoom(row.id)).emit('admin:list_changed', { scope, cause });
    }
    // Phase 2 dual-emit — the admin entity strings are simple `admin:<scope>`
    // tags (admin:pods, admin:sessions, admin:users, admin:join-requests,
    // admin:violations, admin:support-tickets, admin:analytics). Pass the
    // raw `admin:${scope}` so a brand-new admin list plugged into the
    // helper Just Works without a server-side enum bump.
    emitEntities(
      io,
      result.rows.map(r => r.id),
      [`admin:${scope}`],
    ).catch(() => {});
  } catch (err) {
    logger.warn({ err, scope, cause }, 'notifyAdminListChanged: failed to fan out');
  }
}

/**
 * Notify a single user that their own notification list changed (mark-read,
 * mark-all-read, etc) so OTHER tabs / devices the same user has open update
 * the bell counter without a refresh. The user's own request response
 * already covers the originating tab; this is for the cross-tab gap.
 */
export async function notifyOwnNotificationsChanged(
  userId: string,
  cause: string,
): Promise<void> {
  if (!io) return;
  try {
    const { userRoom } = await import('./state/session-state');
    io.to(userRoom(userId)).emit('notification:list_changed', { userId, cause });
    // Phase 2 dual-emit — invalidate this user's notification queries
    // (notification-prefs, notification list, bell counter) across every
    // open tab/device.
    emitEntities(io, [userId], [E.userNotifications(userId)]).catch(() => {});
  } catch (err) {
    logger.warn({ err, userId, cause }, 'notifyOwnNotificationsChanged: failed to fan out');
  }
}

/**
 * Fan out a block-relationship change (block / unblock) to BOTH the blocker
 * and the blocked user's personal rooms. The blocker's UI flips the Block
 * button label and any open DM conversation surface; the blocked user's
 * UI removes the now-inaccessible Message button on the blocker's profile.
 */
export async function notifyUserBlocksChanged(
  blockerId: string,
  blockedId: string,
  cause: string,
): Promise<void> {
  if (!io) return;
  try {
    const { userRoom } = await import('./state/session-state');
    const payload = { blockerId, blockedId, cause };
    io.to(userRoom(blockerId)).emit('user:blocks_changed', payload);
    io.to(userRoom(blockedId)).emit('user:blocks_changed', payload);
    // Phase 2 dual-emit — both parties' block-list queries
    // (blocked-users, user-block-status, can-message) need to refetch.
    emitEntities(
      io,
      [blockerId, blockedId],
      [E.userBlocks(blockerId), E.userBlocks(blockedId)],
    ).catch(() => {});
  } catch (err) {
    logger.warn({ err, blockerId, blockedId, cause }, 'notifyUserBlocksChanged: failed to fan out');
  }
}

/**
 * Targeted single-user notify for the user-room. Thin wrapper kept distinct
 * from notifyOwnNotificationsChanged because the event name differs and
 * downstream client handlers care about the distinction. Used when admin
 * routes mutate a specific user (role / status / delete) so that user's
 * own UI flips state in real time alongside the admin-list broadcast.
 */
export async function notifyUserChanged(
  userId: string,
  cause: string,
): Promise<void> {
  if (!io) return;
  try {
    const { userRoom } = await import('./state/session-state');
    io.to(userRoom(userId)).emit('user:changed', { userId, cause });
    // Phase 2 dual-emit — the user-scope entity covers profile, encounters,
    // and any user-keyed query on the affected user's surfaces.
    emitEntities(io, [userId], [E.user(userId)]).catch(() => {});
  } catch (err) {
    logger.warn({ err, userId, cause }, 'notifyUserChanged: failed to fan out');
  }
}

/**
 * Fan out a DM reaction add/remove to BOTH participants in the conversation.
 * Used by the REST routes for /dm/messages/:id/reactions — the socket
 * handlers already fan out via the same shape; this keeps the REST path
 * in lockstep.
 */
export async function notifyDmReactionChanged(
  conversationId: string,
  messageId: string,
  userId: string,
  otherUserId: string,
  emoji: string,
  added: boolean,
): Promise<void> {
  if (!io) return;
  try {
    const { userRoom } = await import('./state/session-state');
    const event = added ? 'dm:reaction_added' : 'dm:reaction_removed';
    const payload = { messageId, conversationId, userId, emoji };
    io.to(userRoom(userId)).emit(event, payload);
    io.to(userRoom(otherUserId)).emit(event, payload);
    // Phase 2 dual-emit — both participants invalidate their dm-messages
    // query for the affected conversation.
    emitEntities(
      io,
      [userId, otherUserId],
      [E.dmConversation(conversationId)],
    ).catch(() => {});
  } catch (err) {
    logger.warn({ err, conversationId, messageId }, 'notifyDmReactionChanged: failed to fan out');
  }
}

/**
 * Fan out a DM read-receipt to BOTH participants — the reader's other tabs
 * + the original sender's open thread surface — when the REST path
 * (POST /dm/conversations/:id/read) is used. Mirrors handleDmRead in
 * dm-handlers.ts so the two transports stay consistent.
 */
export async function notifyDmReadReceipt(
  conversationId: string,
  readerId: string,
  otherUserId: string,
  readAt: Date,
  markedCount: number,
): Promise<void> {
  if (!io) return;
  try {
    const { userRoom } = await import('./state/session-state');
    const payload = {
      conversationId,
      readBy: readerId,
      readAt,
      markedCount,
    };
    io.to(userRoom(readerId)).emit('dm:read_receipt', payload);
    io.to(userRoom(otherUserId)).emit('dm:read_receipt', payload);
    // Phase 2 dual-emit — dm-messages for this conversation refetches on
    // both sides (the unread badge and read-receipts re-render).
    emitEntities(
      io,
      [readerId, otherUserId],
      [E.dmConversation(conversationId)],
    ).catch(() => {});
  } catch (err) {
    logger.warn({ err, conversationId }, 'notifyDmReadReceipt: failed to fan out');
  }
}

/**
 * Fan out a group-chat membership/message event to every current member's
 * personal room so each member's open inbox + thread surfaces refetch.
 * Mirrors the notifyPodChanged shape: single SELECT against the
 * dm_group_members table → one emit per row.
 */
export async function notifyGroupChanged(
  groupId: string,
  cause: string,
): Promise<void> {
  if (!io) return;
  try {
    const { userRoom } = await import('./state/session-state');
    const { query } = await import('../../db');
    const result = await query<{ user_id: string }>(
      `SELECT user_id FROM dm_group_members WHERE group_id = $1`,
      [groupId],
    );
    for (const row of result.rows) {
      io.to(userRoom(row.user_id)).emit('group:changed', {
        groupId,
        userId: row.user_id,
        cause,
      });
    }
    // Phase 2 dual-emit — group entity is not in the centralised E builder
    // (groups are a niche surface). Use the raw string so DM/group queries
    // can declare `group:${groupId}` in their meta.entities.
    emitEntities(
      io,
      result.rows.map(r => r.user_id),
      [`group:${groupId}`],
    ).catch(() => {});
  } catch (err) {
    logger.warn({ err, groupId, cause }, 'notifyGroupChanged: failed to fan out');
  }
}

// ── Get Active Session State (used by REST routes) ─────────────────────────

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

// ── Public API Re-exports ──────────────────────────────────────────────────

export { startSession, pauseSession, resumeSession, endSession, broadcastMessage, setHostVisibility };
export type { HostVisibilityMode } from './handlers/host-actions';
export { notifyRatingSubmitted };
export { getActiveSessionCount } from './state/session-state';
