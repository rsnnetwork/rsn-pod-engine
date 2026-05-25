// ─── Host Participants View ────────────────────────────────────────────────
//
// Phase 7C.1 (7 May spec, Stefan #3 + #11) — backing data for the Host
// Control Center drawer. Single source of truth for the participants
// list shown to the host: who's here, what role, what state. Joined
// to host:round_dashboard payloads so the live drawer updates on the
// same cadence as room status changes.
//
// State derivation order (highest precedence first):
//   1. session_participants.status in {'left','no_show','removed'} -> 'left'
//   2. user is in any active match (matches arg)                    -> 'in_room'
//   3. status='disconnected' OR not in presenceMap                   -> 'disconnected'
//   4. otherwise                                                     -> 'in_main_room'
//
// Role: hostUserId match -> 'host'; row in session_cohosts -> 'cohost';
// else 'participant'. Never derived from session_participants.role —
// session_cohosts is the canonical source post-Phase 7A.5.

import { query } from '../../../db';
// Phase 3 (M1) — canonical Redis doc is authoritative for per-user
// location/connState when present. Falls back to the legacy presence/match/DB
// derivation below when the doc is absent (Redis down or not yet projected).
import { readCanonical } from '../state/canonical-state';

export type HostParticipantState =
  | 'in_main_room'
  | 'in_room'
  | 'disconnected'
  | 'left';

export type HostParticipantRole = 'host' | 'cohost' | 'participant';

/**
 * Global platform role pulled from users.role. Used by the Host Control
 * Center to disable Make/Remove co-host / Kick on admin + super_admin
 * targets (Bug J — 15 May Ali). The host of an event cannot promote or
 * demote an admin to a co-host role; admins toggle their own per-event
 * role via the Phase M banner instead.
 */
export type HostParticipantGlobalRole = 'user' | 'admin' | 'super_admin';

export interface HostParticipantSummary {
  userId: string;
  displayName: string;
  email: string | null;
  role: HostParticipantRole;
  globalRole: HostParticipantGlobalRole;
  state: HostParticipantState;
  currentMatchId: string | null;
  currentRoomId: string | null;
  joinedAt: string;
}

interface MatchLike {
  id: string;
  roomId?: string | null;
  participantAId?: string | null;
  participantBId?: string | null;
  participantCId?: string | null;
  status: string;
}

interface ParticipantRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  status: string;
  joined_at: Date | null;
  is_cohost: boolean;
  /**
   * Phase P (12 May spec — Ali's 13 May clarification): per-event opt-in
   * / opt-out. NULL for synthetic host + cohost rows (use base role).
   * TRUE for admins/super_admin who chose "Join as host" → reclassify
   * to 'cohost'. FALSE for cohosts/admins who chose "Join as participant"
   * → reclassify to 'participant'. The director (host_user_id) ignores
   * this column entirely.
   */
  acting_as_host: boolean | null;
  /**
   * Bug J (15 May Ali) — global platform role, used by HCC to disable
   * Make/Remove co-host and Kick on admin/super_admin targets. The host
   * of an event cannot change an admin's role via these controls;
   * admins manage their own per-event role through the Phase M banner.
   */
  user_role: string | null;
}

export async function buildHostParticipantsView(opts: {
  sessionId: string;
  hostUserId: string;
  presenceMap: Map<string, unknown>;
  activeMatches?: MatchLike[];
}): Promise<HostParticipantSummary[]> {
  // Phase 7-audit fix — the host is NOT a session_participants row (they
  // own the session, they don't join it). Same for co-hosts who were
  // promoted before joining as a participant. UNION pulls in:
  //   1. Every session_participants row (with cohost flag).
  //   2. The host as a synthetic row when missing from #1.
  //   3. Each co-host as a synthetic row when missing from #1.
  // status='in_main_room' for synthetic rows; presenceMap drives the
  // final state below (in_room/disconnected/in_main_room).
  const rows = await query<ParticipantRow>(
    `SELECT user_id, display_name, email, status, joined_at, is_cohost, acting_as_host, user_role FROM (
       SELECT
         sp.user_id,
         u.display_name,
         u.email,
         sp.status::text AS status,
         sp.joined_at,
         (sc.user_id IS NOT NULL) AS is_cohost,
         sp.acting_as_host,
         u.role::text AS user_role
       FROM session_participants sp
       LEFT JOIN users u ON u.id = sp.user_id
       LEFT JOIN session_cohosts sc
         ON sc.session_id = sp.session_id AND sc.user_id = sp.user_id
       WHERE sp.session_id = $1
       UNION ALL
       SELECT
         s.host_user_id AS user_id,
         u.display_name,
         u.email,
         'in_lobby'::text AS status,
         NULL::timestamptz AS joined_at,
         FALSE AS is_cohost,
         NULL::boolean AS acting_as_host,
         u.role::text AS user_role
       FROM sessions s
       LEFT JOIN users u ON u.id = s.host_user_id
       WHERE s.id = $1
         AND s.host_user_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM session_participants sp2
           WHERE sp2.session_id = s.id AND sp2.user_id = s.host_user_id
         )
       UNION ALL
       SELECT
         sc.user_id,
         u.display_name,
         u.email,
         'in_lobby'::text AS status,
         NULL::timestamptz AS joined_at,
         TRUE AS is_cohost,
         NULL::boolean AS acting_as_host,
         u.role::text AS user_role
       FROM session_cohosts sc
       LEFT JOIN users u ON u.id = sc.user_id
       WHERE sc.session_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM session_participants sp2
           WHERE sp2.session_id = sc.session_id AND sp2.user_id = sc.user_id
         )
     ) AS combined
     ORDER BY joined_at NULLS FIRST, user_id`,
    [opts.sessionId],
  );

  // Phase 3 (M1) — load the canonical doc once. When present it is the
  // authority for per-user state; null → fall back to the legacy derivation.
  const canon = await readCanonical(opts.sessionId);

  const userToMatch = new Map<string, { matchId: string; roomId: string | null }>();
  for (const m of opts.activeMatches || []) {
    if (m.status !== 'active') continue;
    const room = { matchId: m.id, roomId: m.roomId ?? null };
    if (m.participantAId) userToMatch.set(m.participantAId, room);
    if (m.participantBId) userToMatch.set(m.participantBId, room);
    if (m.participantCId) userToMatch.set(m.participantCId, room);
  }

  return rows.rows.map((r: ParticipantRow) => {
    // Role precedence (Phase P — Ali's 13 May clarification):
    //   1. Director (hostUserId match) → 'host' ALWAYS, ignoring any
    //      acting_as_host value (defence in depth — server REST refuses
    //      the demote, but if a stale FALSE row exists from old data
    //      we still classify the director correctly).
    //   2. acting_as_host = FALSE → 'participant' (admin/super_admin/
    //      cohost explicitly opted out for this event).
    //   3. acting_as_host = TRUE → 'cohost' (admin/super_admin explicitly
    //      opted in; cohost-level role grants host UI and excludes them
    //      from matching).
    //   4. is_cohost (session_cohosts row) → 'cohost'.
    //   5. else → 'participant'.
    let role: HostParticipantRole;
    if (r.user_id === opts.hostUserId) {
      role = 'host';
    } else if (r.acting_as_host === false) {
      role = 'participant';
    } else if (r.acting_as_host === true) {
      role = 'cohost';
    } else if (r.is_cohost) {
      role = 'cohost';
    } else {
      role = 'participant';
    }

    const inMatch = userToMatch.get(r.user_id);
    const c = canon?.participants[r.user_id];
    let state: HostParticipantState;
    if (c) {
      // Phase 3 (M1) — canonical is authoritative when present.
      if (c.location.type === 'breakout') state = 'in_room';
      else if (c.connState === 'connected') state = 'in_main_room';
      else if (c.connState === 'left' || c.connState === 'removed' || c.connState === 'no_show') state = 'left';
      else state = 'disconnected';
    } else {
      // Fallback: existing presence/match/DB derivation (unchanged).
      // Bug 36 (19 May Ali) — presenceMap is the live source of truth. If
      // the user has an active socket connection RIGHT NOW, they cannot
      // be displayed as 'left' or 'disconnected', regardless of what the
      // session_participants.status DB column says. The DB status is a
      // projection that lags reality — most commonly because the state
      // machine transitions to LEFT on a Leave click or disconnect
      // timeout but doesn't reset on reconnect. UI override here keeps
      // the "Left" tab honest: it only shows users who are actually gone.
      const isPresent = opts.presenceMap.has(r.user_id);
      if (inMatch) {
        state = 'in_room';
      } else if (isPresent) {
        state = 'in_main_room';
      } else if (r.status === 'left' || r.status === 'no_show' || r.status === 'removed') {
        state = 'left';
      } else {
        state = 'disconnected';
      }
    }

    const fallback = r.email ? r.email.split('@')[0] : 'Participant';
    // Bug J (15 May Ali) — surface the global platform role so the HCC can
    // disable Make/Remove co-host / Kick on admin and super_admin targets.
    // Defence in depth: handleAssignCohost / handleRemoveCohost reject
    // the same combinations server-side, so a forged socket frame cannot
    // bypass the rule.
    const globalRole: HostParticipantGlobalRole =
      r.user_role === 'super_admin'
        ? 'super_admin'
        : r.user_role === 'admin'
        ? 'admin'
        : 'user';
    return {
      userId: r.user_id,
      displayName: r.display_name || fallback,
      email: r.email,
      role,
      globalRole,
      state,
      currentMatchId: inMatch?.matchId ?? null,
      currentRoomId: inMatch?.roomId ?? null,
      joinedAt: r.joined_at ? r.joined_at.toISOString() : new Date(0).toISOString(),
    };
  });
}
