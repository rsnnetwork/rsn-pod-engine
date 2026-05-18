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

  /** T1-4 — canonical counts that disambiguate "X participants" UX.
   *
   * Phase P (12 May spec — Ali's 13 May clarification) adds `hostsRegistered`
   * and `hostsConnected` so the UI can render "N hosts + M participants"
   * accurately when admins/super_admins toggle "Join as host". The existing
   * `connected` / `registered` / `active` fields preserve their pre-Phase-P
   * semantics for backward compat: they exclude only the director (the
   * `session.host_user_id`), not cohosts or opt-ins. Clients that want a
   * pure "non-host participants" count should derive it by subtracting
   * `hostsConnected` from `connected` (or use `hostsRegistered` for the
   * registered split).
   */
  participantCounts: {
    /** Real-time socket presence — users with an active socket in the session room. Excludes director by default. */
    connected: number;
    /** DB rows in session_participants with status NOT IN ('removed','left','no_show'). Excludes director by default. */
    registered: number;
    /** Subset of registered who are also currently connected — what hosts mean by "active right now". Excludes director by default. */
    active: number;
    /** Whether the director is currently connected (for explicit display, NOT included in the counts above). */
    hostConnected: boolean;
    /** True if test/loadtest accounts (email LIKE 'loadtest_%@rsn-test.invalid') were filtered out. Always true post-T1-4. */
    ghostFiltered: boolean;
    /**
     * Phase P — count of users currently acting as host on this event:
     * director + cohosts (minus opt-outs) + admin/super_admin opt-ins.
     * The director is always counted regardless of any stale opt-out
     * row. INCLUDES the director, unlike `registered`/`connected`/`active`
     * which exclude them.
     */
    hostsRegistered: number;
    /** Phase P — subset of hostsRegistered who are currently connected via socket. */
    hostsConnected: number;
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
   * Phase M (12 May spec item 1) — explicit acting-as-host overrides.
   * Map of userId → boolean for users who have toggled "Join as host" /
   * "Join as participant". Absent users follow the role default (super_admin
   * and event_host auto-host; everyone else auto-participant). The client
   * uses this to derive isHost for its own user without round-tripping to
   * the server on every render.
   */
  actingAsHostOverrides: Record<string, boolean>;

  /**
   * Phase O (12 May spec item 7) — authoritative host-muted state.
   * Array of userIds whose `host_muted = TRUE` in session_participants.
   * The client respects this on cold-start and reconnect: if our user is
   * in the array, the client mirrors the muted state on its local audio
   * track. The server is the single source of truth — self-unmute from
   * the client UI does NOT clear this flag; only a host:mute_participant
   * with muted=false can.
   */
  hostMutedUserIds: string[];

  /**
   * Bug 1 (18 May Stefan) — global pin set by an acting host. When non-null,
   * every participant's lobby renders that user as the big tile (pinned-mode
   * layout). null means no global pin; participants can use their own local
   * pin if desired. Updated live via `pin:changed` socket events; the
   * snapshot carries the latest value so a cold-start client sees the right
   * layout immediately on page load / reconnect.
   */
  pinnedUserId: string | null;

  /**
   * Bug 68 (18 May Stefan) — Host Control Center participants list, sourced
   * from buildHostParticipantsView. Previously HCC was populated solely by
   * the `host:round_dashboard` socket emit, which created a race when an
   * admin was just promoted to co-host: their `isHost` flipped via
   * `permissions:updated` → snapshot fetch, but their HCC drawer rendered
   * empty until the next dashboard tick arrived. Including the same data
   * on the snapshot makes the HCC drawer self-hydrating on every state
   * transition — no socket dependency, no race window.
   *
   * Hidden when the snapshot is built before activeSessions is populated;
   * the live emit then takes over once the host opens the drawer.
   */
  hccParticipants: Array<{
    userId: string;
    displayName: string;
    email: string | null;
    role: 'host' | 'cohost' | 'participant';
    globalRole: 'user' | 'admin' | 'super_admin';
    state: 'in_main_room' | 'in_room' | 'disconnected' | 'left';
    currentMatchId: string | null;
    currentRoomId: string | null;
    joinedAt: string;
  }>;

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
  //
  // Phase M (12 May spec item 1) piggybacks the acting_as_host column on
  // this same SELECT so the snapshot remains a single round-trip for
  // session_participants. Pull non-null overrides into the
  // actingAsHostOverrides map; participants without an explicit toggle
  // contribute nothing (they follow the role default).
  // Phase O (12 May item 7) piggybacks host_muted on the same SELECT so
  // the snapshot stays a single round-trip for session_participants. The
  // hostMutedUserIds array is the server-authoritative mute roster:
  // a user reconnecting must look in this list and mirror the mute on
  // their own audio track.
  const registeredRes = await query<{
    user_id: string;
    acting_as_host: boolean | null;
    host_muted: boolean | null;
  }>(
    `SELECT sp.user_id, sp.acting_as_host, sp.host_muted
     FROM session_participants sp
     JOIN users u ON u.id = sp.user_id
     WHERE sp.session_id = $1
       AND sp.status NOT IN ('removed', 'left', 'no_show')
       AND u.email NOT LIKE 'loadtest_%@rsn-test.invalid'`,
    [sessionId],
  );
  const actingAsHostOverrides: Record<string, boolean> = {};
  const hostMutedUserIds: string[] = [];
  for (const r of registeredRes.rows) {
    // Phase P (Ali's 13 May clarification) — never expose the director's
    // acting_as_host value. The director is permanently host of their
    // own event; a stale FALSE row from pre-Phase-P or a malicious
    // client must not leak into the snapshot. Filtering at the source
    // means every consumer (client isHost, HCC role badge, banner
    // visibility) sees a consistent "director is always host" view
    // without each call site re-checking.
    if (r.user_id === session.hostUserId) continue;
    if (r.acting_as_host !== null && r.acting_as_host !== undefined) {
      actingAsHostOverrides[r.user_id] = r.acting_as_host;
    }
    if (r.host_muted === true) hostMutedUserIds.push(r.user_id);
  }
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

  // ── Phase P (12 May spec — Ali's 13 May clarification) — host roster ───
  //
  // The system must read each user's role accurately so the UI can show
  // "N hosts + M participants" honestly. The host roster is:
  //   director + cohosts − opt-outs + opt-ins
  // where the director is always counted regardless of any (stale or
  // malicious) opt-out row. Phase P-A enforces this at multiple layers;
  // here we just compute the snapshot view consistently.
  const hostsRegisteredSet = new Set<string>();
  if (session.hostUserId) hostsRegisteredSet.add(session.hostUserId);
  for (const cohostId of cohosts) hostsRegisteredSet.add(cohostId);
  for (const [uid, value] of Object.entries(actingAsHostOverrides)) {
    if (value === true) hostsRegisteredSet.add(uid);
    if (value === false) hostsRegisteredSet.delete(uid);
  }
  // Director defence in depth — always counted, never removable by override.
  if (session.hostUserId) hostsRegisteredSet.add(session.hostUserId);
  const hostsConnectedSet = new Set<string>();
  for (const p of connectedParticipants) {
    if (hostsRegisteredSet.has(p.userId)) hostsConnectedSet.add(p.userId);
  }

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

  // Bug 68 (18 May Stefan) — bundle the HCC participants list onto the
  // snapshot so a newly-promoted cohost has a populated drawer on the
  // very next snapshot fetch (which permissions:updated already triggers).
  // Pure read — buildHostParticipantsView runs the canonical SELECT every
  // time. Cheap enough to call on every snapshot since the round
  // dashboard does the same call every 5 seconds.
  let hccParticipants: any[] = [];
  if (activeSession && session.hostUserId) {
    try {
      const { buildHostParticipantsView } = await import('../orchestration/handlers/host-participants-view');
      hccParticipants = await buildHostParticipantsView({
        sessionId,
        hostUserId: session.hostUserId,
        presenceMap: activeSession.presenceMap,
      });
    } catch {
      // Best-effort. If the helper throws, the snapshot still returns;
      // the HCC will populate from the live host:round_dashboard tick.
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
      hostsRegistered: hostsRegisteredSet.size,
      hostsConnected: hostsConnectedSet.size,
    },

    timerVisibility: (config as any).timerVisibility || 'last_10s',
    testMode,
    hostVisibilityModes,
    actingAsHostOverrides,
    hostMutedUserIds,
    // Bug 1 (18 May Stefan) — global pin from the in-memory activeSession.
    // Missing on a fresh DB-only fetch (session not yet loaded into memory),
    // which is correct: there is no live pin when nobody's running it.
    pinnedUserId: activeSession?.pinnedUserId ?? null,
    // Bug 68 (18 May Stefan) — HCC drawer data bundled directly with the
    // snapshot so a newly-promoted cohost can render their drawer in the
    // same tick as their isHost flips.
    hccParticipants,
  };
}
