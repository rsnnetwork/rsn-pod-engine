// ─── Effective Role Resolver (T1-5) ─────────────────────────────────────────
//
// RSN has FOUR overlapping role systems and pre-T1-5 every check picked
// arbitrarily from them:
//
//   1. users.role (global) — member, host, admin, super_admin, etc.
//   2. pod_members.role (per-pod) — director, host, member
//   3. sessions.host_user_id (per-session, binary) — single owner
//   4. session_cohosts (per-session, delegated) — co_host, moderator
//
// This module collapses all four into a single function:
//
//   getEffectiveRole(userId, globalUserRole, { podId?, sessionId? })
//     → 'pod_admin' | 'event_host' | 'cohost' | 'participant' | 'unauthorized'
//
// Resolution order (highest privilege wins):
//   1. globalUserRole === SUPER_ADMIN    → 'pod_admin'  (only super admin auto-passes)
//   2. pod's created_by === userId
//      OR pod_members.role === 'director' → 'pod_admin'
//   3. sessions.host_user_id === userId  → 'event_host'
//   4. session_cohosts entry             → 'cohost'
//   5. session_participants (active)     → 'participant'
//   6. else                              → 'unauthorized'
//
// `requireEffectiveRole(...)` throws ForbiddenError when the user's actual
// role is below the required tier in the privilege ordering above.
//
// This is the foundation for the Tier-2 cleanup that will refactor
// every existing role check to call through here. For now (T1-5) only
// `verifyHost` and the new `handlePromoteCohost` consume it directly —
// other check sites continue working with their existing patterns.

import { query } from '../../db';
import { UserRole } from '@rsn/shared';
import { ForbiddenError } from '../../middleware/errors';

export type EffectiveRole =
  | 'pod_admin'      // platform admin OR pod creator/director
  | 'event_host'     // session.host_user_id
  | 'cohost'         // session_cohosts entry
  | 'participant'    // session_participants entry (non-removed)
  | 'unauthorized';  // none of the above

export interface ResolverContext {
  podId?: string;
  sessionId?: string;
}

/**
 * Numeric privilege ranking. Higher = more privilege. Used to compare
 * actual vs required when calling `requireEffectiveRole`.
 */
const ROLE_RANK: Record<EffectiveRole, number> = {
  pod_admin: 4,
  event_host: 3,
  cohost: 2,
  participant: 1,
  unauthorized: 0,
};

export async function getEffectiveRole(
  userId: string,
  globalUserRole: UserRole | string | undefined,
  context: ResolverContext,
): Promise<EffectiveRole> {
  // Phase M (12 May spec item 1) — per-event acting_as_host override.
  // Read the explicit toggle BEFORE applying role-based layers. FALSE means
  // the user has chosen "Join as participant" for this event regardless of
  // their global / pod / session role — they get the participant
  // experience (matchable, in breakouts, no host UI). TRUE means the
  // opposite — they've opted to act as host even if their base role
  // wouldn't otherwise grant it.
  // NULL (the default) preserves the existing role-based logic below.
  //
  // Phase P (Ali's 13 May clarification) — the event director CANNOT opt
  // out. Their actingOverride is intentionally ignored: even if a stale
  // FALSE row exists (from a buggy client or pre-Phase-P data), the
  // director short-circuit below returns 'event_host'. The REST endpoint
  // also refuses the demote attempt, but this resolver is defense in
  // depth (e.g. for snapshot reads after a malformed UPDATE).
  let actingOverride: boolean | null = null;
  let isDirector = false;
  if (context.sessionId) {
    try {
      const overrideRow = await query<{ acting_as_host: boolean | null }>(
        `SELECT acting_as_host FROM session_participants
         WHERE session_id = $1 AND user_id = $2`,
        [context.sessionId, userId],
      );
      actingOverride = overrideRow.rows[0]?.acting_as_host ?? null;
    } catch {
      // Fall through with null — role defaults still apply, no regression.
    }
    try {
      const sessRow = await query<{ host_user_id: string | null }>(
        `SELECT host_user_id FROM sessions WHERE id = $1`,
        [context.sessionId],
      );
      isDirector = sessRow.rows[0]?.host_user_id === userId;
    } catch {
      // Fall through with isDirector=false — the layer 3 check below
      // will also catch this if the session row is readable later.
    }
  }
  if (isDirector) {
    // Director is permanently the host of their own event. Any
    // actingOverride is ignored (Phase P enforcement).
    return 'event_host';
  }

  // SEC-1 (audit C1) — defense in depth for the acting-as-host opt-in.
  // A TRUE override only escalates a bare participant to the 'cohost' floor
  // below; honour it solely for platform admins/super_admins. A TRUE on any
  // other row is poisoned data (formerly writable via the un-gated REST
  // endpoint, or written by the old instance during a deploy overlap) and is
  // treated as NULL so it cannot grant host powers. Opt-out (FALSE) is a
  // de-escalation and stays honoured for everyone; a formal co-host keeps
  // 'cohost' via the session_cohosts layer regardless of this.
  if (
    actingOverride === true &&
    globalUserRole !== UserRole.SUPER_ADMIN &&
    globalUserRole !== UserRole.ADMIN
  ) {
    actingOverride = null;
  }

  if (actingOverride === false) {
    // Honour the opt-out: regardless of base role, the user is acting as a
    // participant on this event. The session_participants row must already
    // exist for the override to be set (UPDATE is a no-op otherwise), so
    // they ARE a participant; just downgrade the effective role.
    return 'participant';
  }

  // Layer 1 — Super admin always wins.
  // Phase I (10 May spec item 18) — narrowed from `hasRoleAtLeast(ADMIN)`
  // to `=== SUPER_ADMIN`. Stefan asked for super_admin to have full host
  // controls; regular admins (Shraddha, Raja) should join live events as
  // participants and be promoted to cohost if intervention is needed.
  // Pod-management endpoints use `hasRoleAtLeast(ADMIN)` directly via
  // their own helpers and are unaffected by this narrowing.
  if (globalUserRole === UserRole.SUPER_ADMIN) {
    return 'pod_admin';
  }

  // Phase M opt-in (acting_as_host === true) — if the user has explicitly
  // opted in AND has a session_participants row, promote them to cohost
  // tier so canActAsHost accepts them. This covers the "admin attends as
  // host" path (uncommon; admin gets host UI without being formally
  // assigned as a cohost). Pod-admin and event_host pass naturally
  // through the layers below; cohost rank is the minimum useful upgrade.
  if (actingOverride === true) {
    // Continue through layers 2-4 so the highest natural rank wins; if
    // none, fall through to cohost (the opt-in floor).
  }

  // Layer 2 — Pod admin (creator OR director). Pod context can come from
  // an explicit podId or be derived from sessionId.
  let podId = context.podId;
  if (!podId && context.sessionId) {
    const sessRow = await query<{ pod_id: string | null }>(
      `SELECT pod_id FROM sessions WHERE id = $1`,
      [context.sessionId],
    );
    podId = sessRow.rows[0]?.pod_id || undefined;
  }

  if (podId) {
    const podRow = await query<{ created_by: string; member_role: string | null }>(
      `SELECT p.created_by, pm.role AS member_role
       FROM pods p
       LEFT JOIN pod_members pm ON pm.pod_id = p.id AND pm.user_id = $2 AND pm.status = 'active'
       WHERE p.id = $1`,
      [podId, userId],
    );
    const row = podRow.rows[0];
    if (row && (row.created_by === userId || row.member_role === 'director')) {
      return 'pod_admin';
    }
  }

  // Layers 3-5 — session-scoped checks.
  if (context.sessionId) {
    const sessRow = await query<{ host_user_id: string | null }>(
      `SELECT host_user_id FROM sessions WHERE id = $1`,
      [context.sessionId],
    );
    if (sessRow.rows[0]?.host_user_id === userId) {
      return 'event_host';
    }

    const cohostRow = await query<{ role: string }>(
      `SELECT role FROM session_cohosts WHERE session_id = $1 AND user_id = $2`,
      [context.sessionId, userId],
    );
    if (cohostRow.rows.length > 0) {
      return 'cohost';
    }

    const partRow = await query<{ status: string }>(
      `SELECT status FROM session_participants
       WHERE session_id = $1 AND user_id = $2
         AND status NOT IN ('removed', 'left', 'no_show')
       LIMIT 1`,
      [context.sessionId, userId],
    );
    if (partRow.rows.length > 0) {
      // Phase M opt-in floor: if the user explicitly opted in AND none of
      // the higher layers (pod_admin / event_host / cohost) granted host
      // capability, promote them to 'cohost'. The session_participants
      // row guarantees they're entitled to be in the event; the override
      // grants the host UI for the duration.
      if (actingOverride === true) return 'cohost';
      return 'participant';
    }
  }

  return 'unauthorized';
}

/**
 * Throws ForbiddenError if the user's effective role is strictly below the
 * required role. Use when you want a structured throw rather than a boolean.
 */
export async function requireEffectiveRole(
  userId: string,
  globalUserRole: UserRole | string | undefined,
  required: EffectiveRole,
  context: ResolverContext,
): Promise<EffectiveRole> {
  const actual = await getEffectiveRole(userId, globalUserRole, context);
  if (ROLE_RANK[actual] < ROLE_RANK[required]) {
    throw new ForbiddenError(
      `Role '${actual}' does not satisfy required '${required}' for this action`,
    );
  }
  return actual;
}

/**
 * Convenience: returns true when the user can act as event host. Used by
 * verifyHost. Accepted set: pod_admin (super_admin or pod director/creator),
 * event_host (this session's owner), cohost (explicitly delegated). Plain
 * admin is NOT in the set as of Phase I — they must be promoted to cohost
 * to act as host on a specific event.
 */
export async function canActAsHost(
  userId: string,
  globalUserRole: UserRole | string | undefined,
  sessionId: string,
): Promise<{ allowed: boolean; effectiveRole: EffectiveRole }> {
  const role = await getEffectiveRole(userId, globalUserRole, { sessionId });
  // pod_admin (4) | event_host (3) | cohost (2) — all can perform host actions.
  // participant (1) | unauthorized (0) — cannot.
  return { allowed: ROLE_RANK[role] >= ROLE_RANK.cohost, effectiveRole: role };
}
