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
  ActiveSession, activeSessions, disconnectTimeouts, withSessionGuard, withMatchGenerationLock,
  sessionRoom, userRoom, getUserIdFromSocket,
  chatMessages, emitRatingWindowOnce,
} from '../state/session-state';
import * as sessionService from '../../session/session.service';
import * as matchingService from '../../matching/matching.service';
import * as ratingService from '../../rating/rating.service';
import { clearRoomTimers } from './host-actions';
// WS2 (27 May remaining work) — "nobody waits alone": a room dropping below 2
// ENDS for whoever remains (rating → main). The isolated-participants
// auto-reassign paths that used to re-pair survivors are gone.
import { endRoomEarlyForSurvivors } from './room-end-early';
// Phase 2B (5 May spec) — chokepoint helpers for presence + state writes.
import { transitionParticipant, setPresence, ParticipantState } from '../state/participant-state-machine';
// Phase 2 (19 May 2026) — realtime migration dual-emit. Each legacy
// per-user / session-room broadcast picks up a sibling emitEntities() call
// with domain-entity tags so the client's predicate-based invalidator
// refreshes the right React-Query keys without bespoke listeners. See:
//   docs/superpowers/plans/2026-05-19-realtime-architecture-migration.md
import { emitEntities } from '../../../realtime/emit';
import { E } from '../../../realtime/entities';

/**
 * Phase 2 helper — fan entity tags to every active session participant.
 * Mirrors the audience of an `io.to(sessionRoom(...)).emit(...)` broadcast.
 * Failures are swallowed by callers via `.catch(() => {})`.
 */
async function fanSessionRoomEntities(
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

// Phase 2.5D (5 May spec) — future-only repair throttle keys per session.
// One repair per 5 seconds per session prevents storms when many users
// join in quick succession (we only need ONE recompute that includes them all).
const _futureRepairThrottle = new Map<string, number>();
// Bug 18 (18 May Stefan) — trailing-edge tracking. When a request is
// throttled, schedule a single trailing repair so the *most recent*
// roster state is reflected in the plan. Without this a burst of joins
// could leave the plan stuck with whoever was registered at the moment
// of the first repair, plus all subsequent joiners silently dropped.
const _futureRepairTrailing = new Map<string, NodeJS.Timeout>();
const FUTURE_REPAIR_THROTTLE_MS = 5_000;

async function maybeRepairFutureRounds(
  io: SocketServer,
  sessionId: string,
  reason: 'late_joiner' | 'left',
): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;
  // Bug 18 (18 May Stefan) — pre-fix the guard was `currentRound < 1`,
  // which skipped recompute for joiners arriving between the host clicking
  // Start (plan generated, LOBBY_OPEN) and round 1 actually starting. So
  // an event that began with 6 participants and grew to 8 in the lobby
  // kept showing "3 rounds · 3 pairs" — Stefan's exact complaint. New
  // guard: skip only when the event hasn't started AT ALL (no plan).
  // Once status flips past SCHEDULED the plan exists and must be repaired
  // on every roster change. The "Pre-event joiners get covered by the
  // regular pre-plan" assumption only holds while status === SCHEDULED.
  if (activeSession.status === SessionStatus.SCHEDULED) return;
  if (activeSession.status === SessionStatus.COMPLETED) return;

  const now = Date.now();
  const last = _futureRepairThrottle.get(sessionId) || 0;
  if (now - last < FUTURE_REPAIR_THROTTLE_MS) {
    // Bug 18 (18 May Stefan) — trailing-edge repair so a burst of joins
    // doesn't lose the late ones. The first call in the window already
    // ran a repair; schedule ONE trailing repair that fires once the
    // window closes, capturing the latest roster (including anyone who
    // joined during the window).
    if (!_futureRepairTrailing.has(sessionId)) {
      const delay = FUTURE_REPAIR_THROTTLE_MS - (now - last) + 100;
      const handle = setTimeout(() => {
        _futureRepairTrailing.delete(sessionId);
        void runRepair(io, sessionId, reason);
      }, delay);
      _futureRepairTrailing.set(sessionId, handle);
    }
    logger.debug({ sessionId, reason }, 'maybeRepairFutureRounds: throttled (trailing repair queued)');
    return;
  }
  _futureRepairThrottle.set(sessionId, now);
  await runRepair(io, sessionId, reason);
}

/** Inner repair body — shared by the leading-edge call and the trailing-
 *  edge setTimeout. Reads the latest activeSession at fire time so a
 *  trailing repair captures the freshest roster.
 *
 *  Bug 18 (18 May Stefan) — emit also carries the fresh roundCount +
 *  totalPairs so the host's "Plan: X rounds · Y pairs" headline matches
 *  the per-round badges. Pre-fix the headline stuck at whatever
 *  generateSessionSchedule reported at Start; after a late-joiner repair
 *  the badges updated but the headline didn't, leaving the host with
 *  contradictory numbers on the same strip. */
async function runRepair(
  io: SocketServer,
  sessionId: string,
  reason: 'late_joiner' | 'left',
): Promise<void> {
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;
  try {
    // Serialize the read→compute→write of match regeneration per session.
    // Concurrent late-joiner/leaver repairs (and host generate) otherwise
    // race: each reads the same eligible set, computes a different pairing,
    // and the last writer clobbers the others — stranding users in 1-person
    // rooms or with no match row at all. Uses the dedicated match-generation
    // lock (NOT the presence guard) so a repair never blocks joins/leaves —
    // it only queues behind other match-write operations.
    const result = await withMatchGenerationLock(sessionId, async () => {
      // currentRound read inside the lock callback so a round that advanced
      // while we were queued is reflected. 27 May — gate the regen on the live
      // present-in-main set (dynamic import avoids a require cycle) so an absent
      // participant is never re-matched into a future round.
      const presentUserIds = await (await import('./matching-flow')).getPresentUserIds(io, sessionId, activeSession);
      return matchingService.repairFutureRounds(sessionId, activeSession.currentRound + 1, reason, presentUserIds);
    });
    if (result.regeneratedRounds.length > 0) {
      // Pull post-repair totals so the host strip shows the correct
      // roundCount + totalPairs. COUNT(*) over scheduled+active+completed
      // matches covers every persisted round in the plan.
      let roundCount = 0;
      let totalPairs = 0;
      try {
        const totals = await query<{ round_count: string; total_pairs: string }>(
          `SELECT
             COUNT(DISTINCT round_number)::text AS round_count,
             COUNT(*)::text AS total_pairs
           FROM matches
           WHERE session_id = $1 AND is_manual = FALSE AND status <> 'cancelled'`,
          [sessionId],
        );
        roundCount = parseInt(totals.rows[0]?.round_count ?? '0', 10);
        totalPairs = parseInt(totals.rows[0]?.total_pairs ?? '0', 10);
      } catch {
        // Non-fatal — the regeneratedRounds list is enough for the toast;
        // the EventPlanStrip's React-Query refetch will catch any drift.
      }
      io.to(sessionRoom(sessionId)).emit('host:event_plan_repaired', {
        sessionId,
        reason,
        regeneratedRounds: result.regeneratedRounds,
        roundCount,
        totalPairs,
      });
      // Phase 2 dual-emit — session + plan entities so every viewer's
      // event-plan / host-state queries refetch in the same tick.
      fanSessionRoomEntities(
        io, sessionId, [E.session(sessionId), E.sessionPlan(sessionId)],
      ).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, sessionId, reason }, 'maybeRepairFutureRounds: repair failed');
  }
}

// ─── Authoritative participant-list broadcast (debounced) ──────────────────
//
// Each client builds its participant list incrementally from
// participant:joined / participant:left events, and derives the displayed
// count from that local list. Under a burst of concurrent joins (10-12 users
// at once) those per-socket events can be dropped, reordered, or duplicated,
// so each client's list — and the count — drifts, with nothing pulling it
// back to server truth (the full snapshot was only ever UNICAST to the
// joining socket).
//
// After any membership change we now broadcast the authoritative connected-
// participant list (the same snapshot the join unicast and the REST
// /sessions/:id/state endpoint use) to the WHOLE room, so every client
// converges. Debounced per session so a 12-user join burst collapses into
// ~1 snapshot rather than 12 — each snapshot does an io.fetchSockets() plus
// DB reads, so fanning one per join would be wasteful under exactly the load
// that triggers the bug.
const _participantBroadcastTimers = new Map<string, NodeJS.Timeout>();
const PARTICIPANT_BROADCAST_DEBOUNCE_MS = 300;

function scheduleParticipantListBroadcast(io: SocketServer, sessionId: string): void {
  const existing = _participantBroadcastTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    _participantBroadcastTimers.delete(sessionId);
    void (async () => {
      try {
        const { buildSessionStateSnapshot } = await import('../../session/session-state-snapshot.service');
        const snapshot = await buildSessionStateSnapshot(sessionId, io);
        if (!snapshot) return;
        // Partial session:state — the client guards each field with
        // `if (data.X)`, so sending only the membership-derived fields
        // updates the participant list + host presence without clobbering
        // round/timer/status state the client tracks elsewhere.
        io.to(sessionRoom(sessionId)).emit('session:state', {
          participants: snapshot.connectedParticipants,
          hostInLobby: snapshot.hostInLobby,
          participantCounts: snapshot.participantCounts,
        });
      } catch (err) {
        logger.warn({ err, sessionId }, 'scheduleParticipantListBroadcast: failed (non-fatal)');
      }
    })();
  }, PARTICIPANT_BROADCAST_DEBOUNCE_MS);
  // Never keep the process alive solely for a pending presence broadcast.
  if (typeof timer.unref === 'function') timer.unref();
  _participantBroadcastTimers.set(sessionId, timer);
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

// ─── WS2: shared 15s match-end grace (disconnect + Leave Event) ─────────────
//
// A mid-round involuntary departure (connection drop, browser close, Leave
// Event) gives the leaver 15 seconds before their room ends. The partner saw
// match:partner_disconnected from the caller ("waiting for partner…"); a
// return within the grace cancels the timeout (rejoin clears
// disconnectTimeouts) or no-ops it (FIX 3C reconnectedAt guard) and the room
// resumes. Otherwise the match demotes and the room ENDS for the survivor —
// rating ('partner_no_return') → main room. NO re-pairing: WS2 removed the
// old auto-reassign-or-bye ladder that used to run here.
//
// M1 fix (21 May Ali) — the grace expiry still NEVER auto-transitions the
// disconnected user to LEFT and never fires the 'left' plan repair. A
// network blip must not delete the user from every viewer's roster. LEFT
// stays reserved for the explicit Leave Event handler, host kick (REMOVED),
// and the event-end sweep in completeSession.
function scheduleMatchEndGrace(
  io: SocketServer,
  sessionId: string,
  userId: string,
  matchId: string,
  roundNumber: number,
  survivorIds: string[],
): void {
  // Cancel any existing disconnect timeout for this user
  const timeoutKey = `${sessionId}:${userId}`;
  if (disconnectTimeouts.has(timeoutKey)) {
    clearTimeout(disconnectTimeouts.get(timeoutKey)!);
    disconnectTimeouts.delete(timeoutKey);
  }

  // FIX 3C: record disconnectedAt so the timeout can detect a reconnect
  const disconnectedAt = new Date();

  const timeoutId = setTimeout(async () => {
    disconnectTimeouts.delete(timeoutKey);
    await withSessionGuard(sessionId, async () => {
      try {
        // Tier-1 A3 — session-ended race guard.
        const currentSession = activeSessions.get(sessionId);
        if (!currentSession) return;
        if (currentSession.currentRound !== roundNumber) return;

        // FIX 3C: user came back during the grace window — room resumes.
        // Either signal (fresh reconnectedAt stamp or restored presence)
        // means the same thing; notify partner(s) so any "waiting for
        // partner…" banner clears (backstop — the rejoin path also emits
        // match:partner_reconnected immediately).
        const presence = currentSession.presenceMap.get(userId);
        const cameBack =
          (presence && presence.reconnectedAt && presence.reconnectedAt > disconnectedAt) ||
          currentSession.presenceMap.has(userId);
        if (cameBack) {
          logger.info({ userId, sessionId }, 'User reconnected during grace window — room resumes');
          for (const survivorId of survivorIds) {
            io.to(userRoom(survivorId)).emit('match:partner_reconnected', { matchId });
          }
          emitEntities(
            io, survivorIds,
            [E.session(sessionId), E.sessionParticipants(sessionId), E.match(matchId)],
          ).catch(() => {});
          return;
        }

        // M1 fix (21 May Ali) — no auto-LEFT from this expiry, ever. A 16s
        // network blip must not delete the user from every viewer's roster;
        // LEFT is reserved for the explicit Leave Event handler, host kick
        // (REMOVED), and the event-end sweep. Only the MATCH ends here.

        // Determine terminal status based on actual conversation state:
        //   >30s OR ratings submitted → completed (real conversation)
        //   otherwise → cancelled (no_show reserved for never-connected)
        const matchInfoRes = await query<{ seconds: string; rating_count: string }>(
          `SELECT
             EXTRACT(EPOCH FROM (NOW() - started_at))::text AS seconds,
             (SELECT COUNT(*)::text FROM ratings WHERE match_id = $1) AS rating_count
           FROM matches WHERE id = $1`,
          [matchId],
        );
        const durationS = parseFloat(matchInfoRes.rows[0]?.seconds || '0');
        const ratingCount = parseInt(matchInfoRes.rows[0]?.rating_count || '0', 10);
        const terminalStatus = (durationS > 30 || ratingCount > 0) ? 'completed' : 'cancelled';

        // Trio-aware demotion — the old inline terminal UPDATE here killed a
        // whole trio when ONE member dropped; demote keeps 2+ survivors
        // talking and only marks terminal when the room actually empties.
        const { remainingUserIds, matchStillActive } = await matchingService.demoteParticipantFromMatch(
          matchId, userId, terminalStatus as 'completed' | 'cancelled',
        );

        logger.info(
          { sessionId, matchId, userId, durationS, ratingCount, terminalStatus, matchStillActive },
          'Match-end grace expired',
        );

        const { clearCanonicalLocationToMain, clearCanonicalBreakoutByMatch } =
          await import('../state/canonical-state');

        if (matchStillActive) {
          // Trio: survivors continue to normal round end. Only the departed
          // user's canonical location clears (they are out of the room).
          await clearCanonicalLocationToMain(sessionId, userId);

          let leftName: string | undefined;
          try {
            const nameRes = await query<{ display_name: string | null; email: string | null }>(
              `SELECT display_name, email FROM users WHERE id = $1`, [userId],
            );
            leftName = resolveDisplayName(userId, nameRes.rows[0]?.display_name ?? null, nameRes.rows[0]?.email ?? null);
          } catch { /* placeholder below */ }
          for (const remainingId of remainingUserIds) {
            io.to(userRoom(remainingId)).emit('match:participant_left', {
              matchId,
              leftUserId: userId,
              leftDisplayName: leftName || placeholderName(userId),
              remainingCount: remainingUserIds.length,
              reason: 'disconnect_timeout',
            });
          }
          emitHostDashboard(sessionId);
          return;
        }

        // Pair: the room ends for the survivor — rating → main, no re-pairing.
        // Ship C ordering — canonical clears BEFORE survivor-facing emits so an
        // instant resync can't mint a stale room token.
        await clearCanonicalBreakoutByMatch(sessionId, [matchId]);
        clearRoomTimers(matchId);
        emitHostDashboard(sessionId);
        // Bug 4 (April 18 Dr Arch): the terminal status may have left zero
        // active matches in the round.
        maybeAutoEndEmptyRound(sessionId);
        // 'cancelled' (<30s, no ratings) = not a real conversation → no
        // rating form; the survivor goes straight back to the main room.
        await endRoomEarlyForSurvivors(
          io, sessionId, matchId, [userId], remainingUserIds,
          terminalStatus === 'completed',
        );
      } catch (err) {
        logger.warn({ err, sessionId, userId }, 'Error in match-end grace handler');
      }
    });
  }, 15000);
  disconnectTimeouts.set(timeoutKey, timeoutId);
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
      // If activeSession is missing (server restarted/deployed, OR the
      // event is still SCHEDULED and nobody has triggered creation yet)
      // we set one up so every downstream handler — presence map, state
      // machine, chat-handlers gate — works the same way for a pre-event
      // lobby as for a running event.
      //
      // M1 follow-up (21 May Ali) — `scheduled` was historically EXCLUDED
      // from this list, on the rationale that "the event hasn't started,
      // there's no live state to track yet." That assumption broke the
      // pre-event lobby badly:
      //   - presenceMap stayed empty for SCHEDULED sessions because
      //     setPresence() below is guarded on `if (activeSession)`.
      //   - chat-handlers.ts gate (`activeSession?.presenceMap.has(host)`)
      //     therefore always failed → every non-host participant got
      //     "Chat is available once the host joins" even when the host
      //     was clearly present (UI showed the green "Host is here" pill
      //     because that uses socket-room presence, a different signal).
      //   - The Bug 36 LEFT → IN_MAIN_ROOM reset for a host who clicked
      //     Leave and rejoined fell through with NO_ACTIVE_SESSION, so
      //     the host's session_participants row stayed `status='left'`,
      //     the snapshot filter excluded them from the participants list,
      //     and the count read 2/8 instead of 3/8.
      //
      // Now: include SCHEDULED in the recovery list. The in-memory
      // ActiveSession for a SCHEDULED event is mostly null fields plus
      // an empty presenceMap that the very next setPresence() populates.
      // handleStartSession preserves this presenceMap when promoting the
      // session to LOBBY_OPEN (see preservePresenceFromExisting below).
      if (!activeSession) {
        const activeStatuses = ['scheduled', 'lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby'];
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
      } catch (regErr: any) {
        // Already registered or session not open — that's fine.
        // WS2/S12 — EXCEPT a kicked user: registerParticipant now throws
        // REMOVED_FROM_EVENT and every filter already excludes them, but
        // this catch used to swallow it silently AFTER socket.join() —
        // the kicked user sat on a joined socket seeing nothing. Tell
        // them explicitly and don't proceed with the join flow.
        if (regErr?.code === 'REMOVED_FROM_EVENT') {
          socket.leave(sessionRoom(data.sessionId));
          socket.emit('session:evicted', {});
          logger.info({ sessionId: data.sessionId, userId }, 'Removed user attempted to rejoin — evicted');
          return;
        }
      }

      // Phase 2.5D (5 May spec) — late-joiner future-only repair.
      // If a NEW participant joined mid-event (event already past round 1),
      // regenerate the pre-planned future rounds to include them. Throttled
      // to one repair per 5s per session so a flurry of joiners triggers
      // only one recompute that covers them all.
      if (didRegister && session.hostUserId !== userId) {
        void maybeRepairFutureRounds(io, data.sessionId, 'late_joiner');
      }

      // Update participant status based on current session state.
      //
      // Bug 37.1 (19 May Ali) — accept-invite redirect → /session/.../live
      // must NOT auto-flip status to CHECKED_IN when the event is still
      // SCHEDULED (hasn't started). Status should stay 'registered' until
      // the host actually starts the event. Pre-fix, viewing the live page
      // a day early would jump everyone to CHECKED_IN, breaking pre-event
      // counts ("Will attend" vs "Checked in") in the HCC and reports.
      // Once status flips past SCHEDULED (LOBBY_OPEN / ROUND_*), the
      // auto-checkin is correct: arriving means "actually showed up".
      try {
        const effectiveStatus = (activeSession?.status ?? session.status) as SessionStatus;
        if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE) {
          // Will be updated to IN_ROUND below if they have an active match
          await sessionService.updateParticipantStatus(
            data.sessionId, userId, ParticipantStatus.IN_LOBBY
          );
        } else if (effectiveStatus === SessionStatus.SCHEDULED) {
          // Pre-start: do NOT auto-checkin. registerParticipant above
          // already inserted a 'registered' row if the user was new;
          // existing rows keep whatever status they had.
        } else {
          await sessionService.updateParticipantStatus(
            data.sessionId, userId,
            effectiveStatus === SessionStatus.LOBBY_OPEN ? ParticipantStatus.IN_LOBBY : ParticipantStatus.CHECKED_IN
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
          // Bug 36 (19 May Ali) — host/cohost LEFT carve-out. The director
          // (sessions.host_user_id) and any session_cohosts row must never
          // be stuck in LEFT on their own event: they navigated away (or
          // a stale disconnect-timeout fired against them pre-fix) but
          // reconnecting must put them straight back in the main room.
          // The state machine allows LEFT → IN_MAIN_ROOM as "explicit
          // re-entry only" (participant-state-machine.ts) which maps the
          // DB enum value to 'in_lobby' and clears left_at. Regular
          // participants who explicitly Leave still keep LEFT — only
          // hosts/cohosts get the reset here.
          // 23 May (Stefan + Ali) — this block runs ONLY on presence:ready,
          // i.e. the user is actively (re-)entering the live page, so they
          // ARE present right now. Any present user with no active match must
          // be matchable. Pre-fix only the director/cohost were reset from
          // LEFT (Bug 36 carve-out); a regular participant whose mobile
          // dropped and reconnected stayed 'left'/'disconnected' — still
          // counted in the roster but invisible to getEligibleParticipants,
          // so the engine never matched them (observed live with Ali Hamza on
          // mobile). Reset every present user back to the main room
          // regardless of role. LEFT → IN_MAIN_ROOM is the state machine's
          // "explicit re-entry" edge, which presence:ready is by definition.
          if (currentStatus === 'left' || currentStatus === 'disconnected' || currentStatus === 'in_round') {
            const result = await transitionParticipant(
              data.sessionId, userId, ParticipantState.IN_MAIN_ROOM,
            );
            if (result.ok) {
              logger.info({ sessionId: data.sessionId, userId, fromState: result.fromState },
                'Reconnect reset: present participant → in_main_room (was left/disconnected/in_round)');
            } else {
              logger.warn({ sessionId: data.sessionId, userId, reason: result.reason, fromState: result.fromState },
                'Reconnect reset: state-machine refused transition — leaving DB status untouched');
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

      // Bug 21 (18 May Stefan) — late joiners weren't appearing in
      // OTHER participants' "X participants + Y hosts" banner. The
      // existing participant:joined event only updates the local
      // store; the lobby header derives from hostsSet + cohorts +
      // actingAsHostOverrides which can be stale on remote clients.
      // Broadcasting roster:changed forces every viewer to refetch
      // the snapshot — same belt-and-braces pattern Ship #2 uses for
      // cohost mutations, now extended to plain joins so a slow-internet
      // join still converges all the other clients.
      io.to(sessionRoom(data.sessionId)).emit('roster:changed', {
        sessionId: data.sessionId,
        cause: 'participant_joined',
      });
      // Phase 2 dual-emit — session + participants tags for everyone in
      // the room. The joining user themselves gets it too so their
      // sessions / session-participants queries refresh.
      fanSessionRoomEntities(
        io, data.sessionId,
        [E.session(data.sessionId), E.sessionParticipants(data.sessionId)],
      ).catch(() => {});

      // Send current participant count
      const count = await sessionService.getParticipantCount(data.sessionId);
      io.to(sessionRoom(data.sessionId)).emit('participant:count', { count });

      // Pull every client in the room back to the authoritative connected
      // list (debounced) so a burst of concurrent joins can't leave clients
      // with divergent incrementally-built lists / counts.
      scheduleParticipantListBroadcast(io, data.sessionId);

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
            // Clock-offset anchor so a late joiner resolves timerEndsAt against
            // server time, not its own (possibly skewed) wall clock.
            serverNow: snapshot.serverNow,
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

      // Ship C — lobby:token retired. The client emits session:resync on
      // every connect (2792557) and on every status change; handleResync
      // always mints a token for the canonical location, so the joiner's
      // lobby token arrives via the snapshot rail within one round-trip.

      // If host reconnects mid-round, send them the dashboard
      if (activeSession && activeSession.status === SessionStatus.ROUND_ACTIVE && isHost) {
        emitHostDashboard(data.sessionId);
      }

      // Bug 44 (19 May Ali) — emit host:round_dashboard on every host
      // join, not just ROUND_ACTIVE. Pre-fix, the host's
      // `roundDashboard.eligibleMainRoomCount` was only populated after
      // round 1 became active, so Match People button label and HCC
      // counts fell back to local computation that didn't account for
      // Phase M cohost opt-ins. Calling emitHostDashboard on join
      // fans the dashboard (with the post-Phase-M eligibility count) to
      // every acting host's room immediately, so even pre-round-1 the
      // host strip + Match People badge are accurate. Covers LOBBY_OPEN,
      // ROUND_RATING, ROUND_TRANSITION, CLOSING_LOBBY — ROUND_ACTIVE is
      // already handled by the block above; this branch fires only when
      // that one didn't, so the dashboard isn't emitted twice.
      if (
        activeSession && isHost &&
        activeSession.status !== SessionStatus.ROUND_ACTIVE
      ) {
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

          // Ship C — lifecycle notification only; the reconnect token rides
          // the resync reply (client resyncs on every connect) or the REST
          // fallback the match:assigned handler always triggers now.
          socket.emit('match:assigned', {
            matchId: userMatch.id,
            partnerId: partners[0].userId,
            partnerDisplayName: partners[0].displayName,
            partners,
            roomId: userMatch.roomId || '',
            roundNumber: activeSession.currentRound,
          });
          // Phase 2 dual-emit — session + participants + match entity
          // for the reconnecting user so their live-event surfaces resync.
          emitEntities(
            io, [userId],
            [E.session(data.sessionId), E.sessionParticipants(data.sessionId), E.match(userMatch.id)],
          ).catch(() => {});

          // WS2 — the partner's "waiting for partner…" banner must clear the
          // moment the user is back, not 15s later at the grace expiry
          // backstop. Tell the surviving partner(s) the room resumed.
          for (const pid of partnerIds) {
            io.to(userRoom(pid)).emit('match:partner_reconnected', { matchId: userMatch.id });
          }
        } else {
          // WS2 (27 May remaining work) — LATE RETURNER. Their room ended
          // while they were away (15s grace expired, partner left, or kick of
          // a partner) and there's no active match to restore. Replay the
          // rating form for the most recent completed match they haven't
          // rated or skipped — "Rate your last conversation" — then the
          // normal lobby flow takes over (canonical already points at main).
          try {
            // S14 (live-test 2026-06-05) — TWO late-return shapes:
            //   (a) their room ENDED while away → completed match with them
            //       still in the slots;
            //   (b) they were DEPARTED from a still-running TRIO (grace
            //       expired, room continued without them) → match active,
            //       their id only in departed_user_ids. Pre-fix this case
            //       got NOTHING on return and they could never rate the
            //       partners they actually talked to.
            const lateMatchRes = await query<{ id: string; participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null; departed_user_ids: string[] | null; round_number: number }>(
              `SELECT id, participant_a_id, participant_b_id, participant_c_id, departed_user_ids, round_number
               FROM matches
               WHERE session_id = $1
                 AND (
                   (status = 'completed' AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2))
                   OR (status IN ('active', 'completed') AND $2 = ANY(departed_user_ids))
                 )
                 AND NOT EXISTS (SELECT 1 FROM ratings r WHERE r.match_id = matches.id AND r.from_user_id = $2)
               ORDER BY COALESCE(ended_at, started_at) DESC NULLS LAST
               LIMIT 1`,
              [data.sessionId, userId],
            );
            const lateMatch = lateMatchRes.rows[0];
            const lateSkipped = lateMatch
              ? (activeSession.ratingSkips?.has(`${userId}:${lateMatch.id}`) ?? false)
              : true;
            if (lateMatch && !lateSkipped) {
              // Partners = current slots ∪ other departed members, minus
              // self — a departed-from-trio returner rates the people they
              // actually talked to (the slots no longer contain them).
              const latePartnerIds = [
                lateMatch.participant_a_id, lateMatch.participant_b_id, lateMatch.participant_c_id,
                ...(lateMatch.departed_user_ids ?? []),
              ].filter((id, idx, arr): id is string => !!id && id !== userId && arr.indexOf(id) === idx);
              if (latePartnerIds.length > 0) {
                const lateNameRes = await query<{ id: string; display_name: string | null; email: string | null }>(
                  `SELECT id, display_name, email FROM users WHERE id = ANY($1)`, [latePartnerIds],
                );
                const lateNameMap = new Map(lateNameRes.rows.map(r => [r.id, resolveDisplayName(r.id, r.display_name, r.email)]));
                const latePartners = latePartnerIds.map(id => ({
                  userId: id, displayName: lateNameMap.get(id) || placeholderName(id),
                }));
                await emitRatingWindowOnce(io, userId, lateMatch.id, {
                  matchId: lateMatch.id,
                  partnerId: latePartnerIds[0],
                  partnerDisplayName: latePartners[0].displayName,
                  partners: latePartners,
                  roundNumber: lateMatch.round_number,
                  durationSeconds: 20,
                  earlyLeave: true,
                  reason: 'late_return',
                });
              }
            }
          } catch (err) {
            logger.warn({ err, sessionId: data.sessionId, userId }, 'Late-return rating replay failed');
          }
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
          // #6 (25 May) — a skip closes this match's rating: don't re-send the
          // form to someone who explicitly skipped it (reconnect/refresh).
          const skipped = activeSession.ratingSkips?.has(`${userId}:${userMatch.id}`) ?? false;
          if (existingRating.rows.length === 0 && !skipped) {
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
              reason: 'round_end',
            });
            // Phase 2 dual-emit — session + participants for the reconnecting
            // user picking up the rating screen replay.
            emitEntities(
              io, [userId],
              [E.session(data.sessionId), E.sessionParticipants(data.sessionId)],
            ).catch(() => {});
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

    // WS2 (27 May remaining work) — Leave Event mid-round used to orphan the
    // partner's match entirely (no notify, no end). Now the partner gets the
    // same 15s grace as a connection drop: "waiting for partner…", room
    // resumes if the leaver rejoins within the grace (rejoin cancels the
    // timeout + reconnectedAt guard), else the room ends for the survivor.
    // Canonical location is deliberately NOT cleared here — only the grace
    // expiry decides, so a resume walks the leaver straight back into the room.
    if (!isHost) {
      const leaveSession = activeSessions.get(data.sessionId);
      if (leaveSession && leaveSession.status === SessionStatus.ROUND_ACTIVE) {
        try {
          const leaveMatchRes = await query<{ id: string; participant_a_id: string; participant_b_id: string | null; participant_c_id: string | null }>(
            `SELECT id, participant_a_id, participant_b_id, participant_c_id
             FROM matches WHERE session_id = $1 AND status = 'active' AND round_number = $3
               AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2)
             LIMIT 1`,
            [data.sessionId, userId, leaveSession.currentRound],
          );
          if (leaveMatchRes.rows.length > 0) {
            const m = leaveMatchRes.rows[0];
            const survivorIds = [m.participant_a_id, m.participant_b_id, m.participant_c_id]
              .filter((id): id is string => !!id && id !== userId);
            for (const survivorId of survivorIds) {
              io.to(userRoom(survivorId)).emit('match:partner_disconnected', { matchId: m.id });
            }
            emitEntities(
              io, survivorIds,
              [E.session(data.sessionId), E.sessionParticipants(data.sessionId), E.match(m.id)],
            ).catch(() => {});
            scheduleMatchEndGrace(io, data.sessionId, userId, m.id, leaveSession.currentRound, survivorIds);
          }
        } catch (err) {
          logger.warn({ err, sessionId: data.sessionId, userId }, 'Leave-event match grace scheduling failed');
        }
      }
    }

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
    scheduleParticipantListBroadcast(io, data.sessionId);

    // Phase 2 dual-emit — every viewer's session/participants queries
    // refresh. The leaving user gets the tag too so their own
    // session-detail surfaces flip to "left" state.
    fanSessionRoomEntities(
      io, data.sessionId,
      [E.session(data.sessionId), E.sessionParticipants(data.sessionId)],
    ).catch(() => {});
    emitEntities(
      io, [userId],
      [E.session(data.sessionId), E.sessionParticipants(data.sessionId)],
    ).catch(() => {});

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
  // Canonical-100% — mirror the server-canonical assignment into the canonical
  // doc so location.breakout (with the REAL matchId) is authoritative for the
  // snapshot you-block and room-scoped consumers. This is the only place that
  // moves canonical location INTO a breakout (no IN_BREAKOUT transitions exist);
  // transitions back to main / disconnects are handled in transitionParticipant
  // (connState-only on disconnect — location survives for reconnect).
  void (async () => {
    const { updateCanonicalParticipant } = await import('../state/canonical-state');
    for (const uid of userIds) {
      if (!uid) continue;
      await updateCanonicalParticipant(sessionId, uid, {
        location: { type: 'breakout', roomId, matchId },
      });
    }
  })().catch(() => { /* best-effort; canonical heals via webhooks/resync */ });
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
      await checkAllRatingsCompleteByUserId(userId, sessionId, _io);
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

// #6 (25 May, Ali) — record that a user dismissed the rating form via "Skip" for
// a given match. A skip means "I saw it and chose not to rate" — distinct from
// "never saw it." Without this, the round-end emit + the reconnect rating-replay
// (which key off "no rating row") re-prompt skippers on every refresh/reconnect.
// Kept in-memory per session (a restart re-prompting once is acceptable). The
// rating-replay below + the endRound dedup both consult ratingSkips.
export async function handleRatingSkip(
  _io: SocketServer,
  socket: Socket,
  data: { sessionId: string; matchId: string }
): Promise<void> {
  const userId = getUserIdFromSocket(socket);
  if (!userId || !data?.sessionId || !data?.matchId) return;
  const activeSession = activeSessions.get(data.sessionId);
  if (!activeSession) return;
  (activeSession.ratingSkips ??= new Set<string>()).add(`${userId}:${data.matchId}`);
  logger.info({ sessionId: data.sessionId, userId, matchId: data.matchId }, '#6 — rating skipped (recorded)');
  // A skip SETTLES this match for the user exactly like a submitted rating, so it
  // must also trigger the all-done check. Without this, a round where EVERY user
  // skips never early-closes — nothing fires the check — and it limps to the
  // silent backstop (Ali, 26 May: "stuck at rating >1min after I skipped from
  // every user"). The rate path already calls this; the skip path did not.
  await checkAllRatingsCompleteByUserId(userId, data.sessionId, _io);
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
 * have finished rating. If so, cancel the rating window timer and advance early.
 *
 * #4 (26 May live test, "stuck at rating") — the pre-fix version computed
 *   expectedRatings = Σ pCount*(pCount-1) over the round's completed matches
 * and compared it to a raw COUNT(*) of ratings. That assumed EVERY participant
 * rates EVERY partner, which is wrong whenever a round has any of:
 *   - skips    — a Skip records no `ratings` row (it's tracked in
 *                activeSession.ratingSkips as `${userId}:${matchId}`),
 *   - leavers  — a participant who left isn't going to rate at all,
 *   - re-match dupes — a churned round has BOTH the superseded match
 *                (status 'reassigned') AND the new match in this round, so the
 *                naive sum over-counts (it expected ratings for the dead pair).
 * Any of these made totalRatings < expectedRatings forever → the early-close
 * never fired → the event sat on the 180/90s silent backstop ("stuck").
 *
 * Robust rule: a participant is "done" for the round when, for every partner in
 * their LATEST (most-recently-created, non-superseded) match this round, they
 * have EITHER submitted a rating OR skipped it. We only require this of
 * participants who are still PRESENT (presenceMap) — leavers never block. Each
 * participant is counted against their latest match only, so a re-match's
 * superseded match never inflates the requirement. Close (3s grace →
 * endRatingWindow) once every present, rated-eligible participant is done.
 *
 * Exported for the #4 behavioral test suite (stuck-at-rating.test.ts); the
 * production entry points are handleRatingSubmit and notifyRatingSubmitted.
 */
export async function checkAllRatingsCompleteByUserId(
  userId: string,
  sessionId?: string,
  io?: SocketServer,
): Promise<void> {
  try {
    // Resolve the session. Prefer the caller-supplied id (the rating/skip socket
    // events carry it) and do NOT depend on presenceMap for the lookup — a stale
    // heartbeat map was making this miss, so all-rated/skipped was never detected
    // and the round limped to the silent backstop (Ali, 26 May: "stuck >1min").
    let activeSession: ActiveSession | null = null;
    if (sessionId) {
      const s = activeSessions.get(sessionId);
      if (s && s.status === SessionStatus.ROUND_RATING) activeSession = s;
    }
    if (!activeSession) {
      for (const [sid, s] of activeSessions) {
        if (s.presenceMap.has(userId) && s.status === SessionStatus.ROUND_RATING) {
          sessionId = sid;
          activeSession = s;
          break;
        }
      }
    }
    if (!sessionId || !activeSession) return;

    const roundNumber = activeSession.currentRound;

    // Ratable real-conversation matches for this round. 'reassigned' is included
    // because a superseded match was a real (brief) meeting that may carry a
    // rating — but we only ever require the LATEST match per participant below,
    // so a stale 'reassigned' pair can never *block* the close.
    const matches = await matchingService.getMatchesByRound(sessionId, roundNumber);
    const ratable = matches.filter(
      m => m.status === 'completed' || m.status === 'reassigned' ||
           m.status === 'active' || m.status === 'no_show'
    );
    if (ratable.length === 0) return;

    // For each participant, find their LATEST match this round (max createdAt).
    // getMatchesByRound returns rows ORDER BY created_at, so a later row wins
    // ties; we compare createdAt defensively in case ordering ever changes.
    const latestMatchFor = new Map<string, typeof ratable[number]>();
    const participantsOf = (m: typeof ratable[number]): string[] => {
      const ids = [m.participantAId, m.participantBId];
      if (m.participantCId) ids.push(m.participantCId);
      return ids.filter((id): id is string => !!id);
    };
    for (const m of ratable) {
      for (const pid of participantsOf(m)) {
        const cur = latestMatchFor.get(pid);
        if (!cur || new Date(m.createdAt).getTime() >= new Date(cur.createdAt).getTime()) {
          latestMatchFor.set(pid, m);
        }
      }
    }

    // The set of (rater → partner) rating edges that exist this round. Keyed on
    // the partner (not the match id) so a rating filed under a superseded match
    // after a reassign still counts toward the rater's latest-match partner.
    const edgeResult = await query<{ from_user_id: string; to_user_id: string }>(
      `SELECT DISTINCT r.from_user_id, r.to_user_id
         FROM ratings r
         JOIN matches m ON m.id = r.match_id
        WHERE m.session_id = $1 AND m.round_number = $2`,
      [sessionId, roundNumber]
    );
    const ratedEdges = new Set(edgeResult.rows.map(r => `${r.from_user_id}:${r.to_user_id}`));
    const skips = activeSession.ratingSkips ?? new Set<string>();

    // Who is ACTUALLY still here. presenceMap (heartbeat) drifts stale, so union
    // it with live socket-room membership (ground truth) before deciding who can
    // still block the close — same staleness class as the LEFT-escalation fix.
    const connected = new Set<string>(activeSession.presenceMap.keys());
    if (io) {
      try {
        const liveSockets = await io.in(sessionRoom(sessionId)).fetchSockets();
        for (const sk of liveSockets) {
          const uid = (sk.data as { userId?: string } | undefined)?.userId;
          if (uid) connected.add(uid);
        }
      } catch { /* fall back to presenceMap only */ }
    }

    // Complete when every completed-match participant has rated-or-skipped their
    // partner(s). A rating/skip SETTLES that participant regardless of presence
    // (so an all-skip round closes immediately, never on the backstop). endRound
    // opens a form ONLY for 'completed' matches — a no_show/active/reassigned
    // latest match gives nothing to rate, so it never makes a participant "owe".
    // A not-yet-settled participant blocks the close ONLY while still connected;
    // a disconnected non-rater is a leaver and must not wedge the window.
    let anyEligible = false;
    let allSettled = true;
    for (const [pid, m] of latestMatchFor) {
      if (m.status !== 'completed') continue;
      const partners = participantsOf(m).filter(id => id !== pid);
      if (partners.length === 0) continue; // solo — nothing to rate
      anyEligible = true;
      const settled = skips.has(`${pid}:${m.id}`) ||
        partners.every(partnerId => ratedEdges.has(`${pid}:${partnerId}`));
      if (settled) continue;
      if (connected.has(pid)) { allSettled = false; break; } // present & still owes
    }

    if (anyEligible && allSettled) {
      logger.info(
        { sessionId, roundNumber, edges: ratedEdges.size, skips: skips.size },
        'All ratings submitted — ending rating window early'
      );

      // Cancel the existing round timer (the silent backstop)
      if (activeSession.timer) {
        clearTimeout(activeSession.timer);
        activeSession.timer = null;
        activeSession.timerEndsAt = null;
      }

      // 3-second grace period: allow in-flight rating submissions to land
      // before advancing. This prevents race conditions where the last
      // rating triggers early-exit while another user is mid-submission.
      const sid = sessionId;
      const rn = roundNumber;
      activeSession.timer = setTimeout(() => {
        const s = activeSessions.get(sid) ?? activeSession!;
        s.timer = null;
        endRatingWindow(sid, rn);
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

      // Ship A regression fix (4 Jun live test) — the leaver's canonical
      // location must clear NOW (their placement ended) or the snapshot/
      // resync wire walks them back into the room. Dissolved pair → clear the
      // whole match (the partner returns to main too); trio → leaver only
      // (survivors keep their location and continue).
      {
        const { clearCanonicalLocationToMain, clearCanonicalBreakoutByMatch } =
          await import('../state/canonical-state');
        if (matchStillActive) {
          await clearCanonicalLocationToMain(sessionId, userId);
        } else {
          await clearCanonicalBreakoutByMatch(sessionId, [userMatch.id]);
        }
      }

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

        // Ship C — lobby:token retired; the leaver's canonical location just
        // flipped to main (clearCanonicalLocationToMain above), so the next
        // snapshot co-emit mints their lobby token (location change).

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
          reason: 'early_leave',
        });

        // WS2 (27 May remaining work) — "Back to Main Room" is a DELIBERATE
        // exit: the room ends for the survivor IMMEDIATELY. No
        // partner_disconnected (that's the waiting state for grace paths),
        // no 5s wait, and no re-pairing — the old isolated-participants
        // auto-reassign block lived here and is gone. Survivor goes
        // rating ('partner_no_return') → main room.
        await endRoomEarlyForSurvivors(io, sessionId, userMatch.id, [userId], partnerIds);

        // Phase 2 dual-emit — session + participants + match for the
        // leaver and remaining partners.
        emitEntities(
          io, [userId, ...partnerIds],
          [E.session(sessionId), E.sessionParticipants(sessionId), E.match(userMatch.id)],
        ).catch(() => {});
      } else {
        // Solo in room — no one to rate, just return to lobby
        socket.emit('match:return_to_lobby', { reason: 'you_left' });
      }

      // Ship C — lobby:token retired; canonical location flipped to main via
      // the clears above, so the snapshot rail delivers the lobby token.

      logger.info({ sessionId, userId, matchId: userMatch.id }, 'Participant left conversation → returned to lobby');

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
      // Phase 2 dual-emit — every viewer's participants list refreshes
      // (this branch fires on disconnect for users with an activeSession).
      fanSessionRoomEntities(
        io, sessionId,
        [E.session(sessionId), E.sessionParticipants(sessionId)],
      ).catch(() => {});
      // + statemgmt: debounced authoritative participant-list push.
      scheduleParticipantListBroadcast(io, sessionId);

      // If mid-round, notify partner(s) and start the 15s match-end grace
      if (activeSession.status === SessionStatus.ROUND_ACTIVE) {
        try {
          const matches = await matchingService.getMatchesByRound(sessionId, activeSession.currentRound);
          const userMatch = matches.find(
            m => (m.participantAId === userId || m.participantBId === userId || m.participantCId === userId) && m.status === 'active'
          );
          if (userMatch) {
            // WS2 (27 May remaining work) — trio slot-C disconnects used to be
            // invisible (the find above only checked A/B). All surviving
            // partners now get the waiting state, not just a binary "other".
            const survivorIds = [userMatch.participantAId, userMatch.participantBId, userMatch.participantCId]
              .filter((id): id is string => !!id && id !== userId);

            // Step 1: notify partner(s) with "waiting for partner…" (NOT bye_round)
            for (const survivorId of survivorIds) {
              io.to(userRoom(survivorId)).emit('match:partner_disconnected', {
                matchId: userMatch.id,
              });
            }
            // Phase 2 dual-emit — partners' in-event match surfaces refetch.
            emitEntities(
              io, survivorIds,
              [E.session(sessionId), E.sessionParticipants(sessionId), E.match(userMatch.id)],
            ).catch(() => {});

            // Step 2: 15s grace, then the room ends for the survivor — no
            // re-pairing. M1 fix (21 May Ali) semantics live inside the shared
            // grace handler: the timeout still never auto-LEFTs the user.
            scheduleMatchEndGrace(io, sessionId, userId, userMatch.id, activeSession.currentRound, survivorIds);
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
      // Phase 2 dual-emit — pre-lobby waiting room disconnect also flips
      // every viewer's participants surface.
      fanSessionRoomEntities(
        io, sessionId,
        [E.session(sessionId), E.sessionParticipants(sessionId)],
      ).catch(() => {});
      // + statemgmt: debounced authoritative participant-list push.
      scheduleParticipantListBroadcast(io, sessionId);
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
          logger.warn({ userId, sessionId }, 'Stale heartbeat — clearing presence');
          setPresence(sessionId, userId, null);
          // M1 fix (21 May Ali) — same architectural change as the 15 s
          // disconnect-timeout path above: a stale heartbeat must NOT
          // auto-transition the user to LEFT. The presence map clear
          // above is enough — the user is no longer counted as
          // "connected" for active-match purposes (no_show / partner-
          // disconnect logic still fires), but their session_participants
          // row keeps a non-terminal status so they remain visible in
          // every roster across reconnect attempts. LEFT is reserved for
          // explicit user action, host kick (REMOVED), or event-end
          // sweep (`completeSession`).
          //
          // The participant:left socket emit + entity fanout still fire
          // so other viewers see the "disconnected" visual treatment in
          // real time — the difference is purely whether the DB row
          // gets stamped 'left' (it doesn't here anymore).
          io.to(sessionRoom(sessionId)).emit('participant:left', { userId });
          // Phase 2 dual-emit — every viewer's participants surface refetches.
          fanSessionRoomEntities(
            io, sessionId,
            [E.session(sessionId), E.sessionParticipants(sessionId)],
          ).catch(() => {});
          // + statemgmt: debounced authoritative participant-list push.
          scheduleParticipantListBroadcast(io, sessionId);
        }
      }
    }
  }, STALE_CHECK_INTERVAL_MS);
}
