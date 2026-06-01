// ─── Session State Snapshot (T0-3) ──────────────────────────────────────────
//
// Single source of truth for the "what's the current state of this session?"
// payload. Returns the same shape whether read via:
//   - REST: GET /api/sessions/:id/state           (this T0-3 endpoint)
//   - Socket: emit('session:state', ...)          (existing on-join emit)
//
// Source-of-truth resolution (in order):
//   1. activeSessions Map (in-memory) — most current; reflects pause, timer,
//      pendingRoundNumber, manuallyLeftRound, etc.
//   2. sessions table (DB) — fallback for sessions not currently active in
//      memory (e.g. server restart before recovery completes, or session
//      finished/scheduled and not in activeSessions).
//
// Why split out: previously the session:state emit at participant-flow.ts:279
// was the only way clients could resync. New REST endpoint reuses this same
// builder so the two paths can never drift apart.

import { Server as SocketServer } from 'socket.io';
import { query } from '../../db';
import { SessionStatus, SessionConfig } from '@rsn/shared';
import { activeSessions, sessionRoom } from '../orchestration/state/session-state';
import * as sessionService from './session.service';

export interface SessionStateSnapshot {
  sessionId: string;
  sessionStatus: SessionStatus;
  currentRound: number;
  totalRounds: number;
  isPaused: boolean;
  /** Server-side wall-clock end of the current segment (ISO 8601). null when paused or no timer running. */
  timerEndsAt: string | null;
  /** Frozen remaining ms when paused. null otherwise. Used by clients to render the held value. */
  pausedTimeRemainingMs: number | null;
  /** Pre-generated round number awaiting host confirm (null when none). */
  pendingRoundNumber: number | null;

  hostUserId: string | null;
  /** Co-host user IDs assigned to this session. */
  cohosts: string[];

  /** Real-time socket presence — users currently connected to this session's socket room. */
  connectedParticipants: Array<{ userId: string; displayName: string }>;
  /** Whether the host's socket is currently in the lobby room. */
  hostInLobby: boolean;

  /** T1-4 — three canonical counts that disambiguate "X participants" UX. */
  participantCounts: {
    /** Real-time socket presence — users with an active socket in the session room. Excludes host by default. */
    connected: number;
    /** DB rows in session_participants with status NOT IN ('removed','left','no_show'). Excludes host by default. */
    registered: number;
    /** Subset of registered who are also currently connected — what hosts mean by "active right now". Excludes host by default. */
    active: number;
    /** Whether the host is currently connected (for explicit display, NOT included in the counts above). */
    hostConnected: boolean;
    /** True if test/loadtest accounts (email LIKE 'loadtest_%@rsn-test.invalid') were filtered out. Always true post-T1-4. */
    ghostFiltered: boolean;
  };

  /** UI hint propagated from session config. */
  timerVisibility: string;

  /**
   * Phase G (10 May spec item 11) — visibility mode per host/co-host.
   * Map of userId → mode (`big_speaker` | `normal` | `producer` | `hidden`).
   * Absent users default to `normal`. Lets the client render the right
   * tile arrangement on cold-start (page refresh) without waiting for a
   * `host:visibility_changed` socket event.
   */
  hostVisibilityModes: Record<string, string>;

  /**
   * Phase 5B (5 May spec) — test-mode flag. Stefan's #2: when the host is
   * signed in across multiple accounts to test the system, display a
   * banner so it's visually clear this isn't a real production event.
   *
   * Sources (priority):
   *   1. Explicit session.config.testMode flag (host opt-in, definitive)
   *   2. Heuristic: 2+ non-host participants whose emails share the host's
   *      email-username root (length ≥ 4 chars). Catches the canonical
   *      Stefan case (stefan@avivson.com / stefanavivson@gmail.com /
   *      im@mister-raw.com all reading as "stefan" / "raw" patterns —
   *      we use the host's username root specifically).
   */
  testMode: boolean;
}

/**
 * Build a self-contained session-state snapshot. Reads from the in-memory
 * `activeSessions` Map first; falls back to the `sessions` table when the
 * session isn't currently held in memory.
 *
 * Pure read — never mutates state, never emits.
 */
export async function buildSessionStateSnapshot(
  sessionId: string,
  io: SocketServer | null,
): Promise<SessionStateSnapshot | null> {
  // ── DB row (source of truth for static fields) ─────────────────────────
  const session = await sessionService.getSessionById(sessionId).catch(() => null);
  if (!session) return null;

  const config: SessionConfig =
    typeof session.config === 'string'
      ? JSON.parse(session.config as unknown as string)
      : (session.config as unknown as SessionConfig) || ({} as SessionConfig);

  // ── activeSessions overlay (preferred when present) ────────────────────
  const activeSession = activeSessions.get(sessionId);

  // ── Connected participants (real-time socket presence) ────────────────
  // io is optional so this helper can be called in pure-DB contexts (e.g.
  // background reconciler, future tests). When io is missing, leave
  // connected counts at 0 — REST callers always pass io, they always get
  // the real number.
  let connectedParticipants: Array<{ userId: string; displayName: string }> = [];
  let hostInLobby = false;
  if (io) {
    const socketsInRoom = await io.in(sessionRoom(sessionId)).fetchSockets();
    connectedParticipants = socketsInRoom
      .map(s => ({
        userId: (s.data as any)?.userId,
        displayName: (s.data as any)?.displayName || 'User',
      }))
      .filter(p => p.userId);
    hostInLobby = socketsInRoom.some(s => (s.data as any)?.userId === session.hostUserId);
  }

  // ── Co-hosts ────────────────────────────────────────────────────────────
  // Phase G (10 May spec) — also pull each cohost's visibility_mode so the
  // client renders the right tile for them on cold-start (page refresh).
  // The original host's visibility lives on sessions.host_visibility_mode and
  // is already pulled via SESSION_COLUMNS — no extra query needed.
  const cohostResult = await query<{ user_id: string; visibility_mode: string }>(
    `SELECT user_id, visibility_mode FROM session_cohosts WHERE session_id = $1`,
    [sessionId],
  );
  const cohosts = cohostResult.rows.map(r => r.user_id);
  const hostVisibilityModes: Record<string, string> = {};
  for (const r of cohostResult.rows) {
    if (r.visibility_mode) hostVisibilityModes[r.user_id] = r.visibility_mode;
  }
  const hostMode = (session as any).hostVisibilityMode as string | undefined;
  if (session.hostUserId && hostMode) {
    hostVisibilityModes[session.hostUserId] = hostMode;
  }

  // ── T1-4 — three canonical counts ────────────────────────────────────
  // Registered: all session_participants rows with non-ghost statuses,
  //   filtered for test/loadtest accounts and the host.
  // Connected: socket presence in the session room, minus host.
  // Active: registered AND connected — what hosts intuitively mean by
  //   "X participants right now".
  // hostConnected: separate boolean so UI can show "+1 host" explicitly.
  const registeredRes = await query<{ user_id: string }>(
    `SELECT sp.user_id
     FROM session_participants sp
     JOIN users u ON u.id = sp.user_id
     WHERE sp.session_id = $1
       AND sp.status NOT IN ('removed', 'left', 'no_show')
       AND u.email NOT LIKE 'loadtest_%@rsn-test.invalid'`,
    [sessionId],
  );
  const registeredIds = new Set(registeredRes.rows.map(r => r.user_id));
  // Exclude host from the headline count — surfaced separately as hostConnected
  if (session.hostUserId) registeredIds.delete(session.hostUserId);

  const connectedIds = new Set(
    connectedParticipants.map(p => p.userId).filter(uid => uid && uid !== session.hostUserId),
  );

  // Active = intersection of registered + connected (with host excluded from both)
  let activeCount = 0;
  for (const uid of connectedIds) if (registeredIds.has(uid)) activeCount++;

  const hostConnected = session.hostUserId
    ? connectedParticipants.some(p => p.userId === session.hostUserId)
    : false;

  // ── Phase 7C.3 — test-mode detection v2 ─────────────────────────────────
  // 1. Explicit override via session.config.testMode wins. Set via the
  //    host's manual toggle in HostControls (host:set_test_mode socket
  //    event), so a host who knows it's a test event can flip it on
  //    regardless of the heuristic, and a real event can override a
  //    false positive.
  // 2. Heuristic: a non-host participant matches the host on ANY of:
  //      a) email-username root (alphabetic) — substring match either way
  //      b) email domain — exact (catches multiple aliases on the same
  //         workspace, e.g. all *@avivson.com)
  //      c) display-name first-name token — case-insensitive equality
  //    If 2+ non-host participants match on at least one signal, flag
  //    testMode=true. Pre-fix the v1 heuristic required hostRoot length
  //    ≥ 4, which produced false negatives for short real names — and
  //    only checked the email root, missing same-domain workspace tests.
  // Phase D1 (10 May spec) — only run the heuristic when the host has
  // explicitly opted in (config.testMode === true) OR when the server is
  // running in non-production. Stefan #5: real participants on a real
  // event saw the embarrassing "Test mode — multiple accounts detected"
  // banner because two of them happened to share an email domain. The
  // explicit override (config.testMode boolean) still wins regardless,
  // so an admin who knows it's a real test can flip it on; conversely,
  // setting config.testMode = false suppresses the banner outright.
  let testMode = false;
  const isProd = process.env.NODE_ENV === 'production';
  if (typeof (config as any).testMode === 'boolean') {
    testMode = (config as any).testMode;
  } else if (!isProd && session.hostUserId && registeredIds.size > 0) {
    try {
      const hostRow = await query<{ email: string | null; display_name: string | null }>(
        `SELECT email, display_name FROM users WHERE id = $1`,
        [session.hostUserId],
      );
      const hostEmail = (hostRow.rows[0]?.email || '').toLowerCase();
      const hostDisplay = (hostRow.rows[0]?.display_name || '').toLowerCase();
      const [hostUserPart, hostDomain] = hostEmail.split('@');
      const hostRoot = (hostUserPart || '').replace(/[^a-z]+/g, '');
      const firstNameToken = hostDisplay.split(/\s+/)[0]?.replace(/[^a-z]+/g, '') || '';

      const partRows = await query<{ email: string | null; display_name: string | null }>(
        `SELECT u.email, u.display_name FROM session_participants sp
           JOIN users u ON u.id = sp.user_id
          WHERE sp.session_id = $1
            AND sp.user_id != $2`,
        [sessionId, session.hostUserId],
      );
      let matches = 0;
      for (const r of partRows.rows) {
        const partEmail = (r.email || '').toLowerCase();
        const [partUserPart, partDomain] = partEmail.split('@');
        const partRoot = (partUserPart || '').replace(/[^a-z]+/g, '');
        const partDisplay = (r.display_name || '').toLowerCase();
        const partFirstName = partDisplay.split(/\s+/)[0]?.replace(/[^a-z]+/g, '') || '';

        const rootMatch =
          hostRoot.length > 0 && partRoot.length > 0 &&
          (partRoot.includes(hostRoot) || hostRoot.includes(partRoot));
        const domainMatch =
          !!hostDomain && !!partDomain && hostDomain === partDomain;
        const nameTokenMatch =
          firstNameToken.length > 0 && partFirstName.length > 0 &&
          firstNameToken === partFirstName;

        if (rootMatch || domainMatch || nameTokenMatch) matches++;
      }
      if (matches >= 2) testMode = true;
    } catch {
      // Heuristic is best-effort; skip on any DB error.
    }
  }

  // ── Compose snapshot ───────────────────────────────────────────────────
  return {
    sessionId,
    sessionStatus: activeSession?.status ?? session.status,
    currentRound: activeSession?.currentRound ?? session.currentRound,
    totalRounds: config.numberOfRounds || 5,
    isPaused: activeSession?.isPaused ?? false,
    timerEndsAt: activeSession?.timerEndsAt?.toISOString() ?? null,
    pausedTimeRemainingMs: activeSession?.pausedTimeRemaining ?? null,
    pendingRoundNumber: activeSession?.pendingRoundNumber ?? null,

    hostUserId: session.hostUserId ?? null,
    cohosts,

    connectedParticipants,
    hostInLobby,

    participantCounts: {
      connected: connectedIds.size,
      registered: registeredIds.size,
      active: activeCount,
      hostConnected,
      ghostFiltered: true,
    },

    timerVisibility: (config as any).timerVisibility || 'last_10s',
    testMode,
    hostVisibilityModes,
  };
}
