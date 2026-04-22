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
//   1. globalUserRole >= ADMIN          → 'pod_admin'  (admins always pass any check)
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
import { UserRole, hasRoleAtLeast } from '@rsn/shared';
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
  // Layer 1 — Platform admin always wins.
  if (globalUserRole && hasRoleAtLeast(globalUserRole as UserRole, UserRole.ADMIN)) {
    return 'pod_admin';
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
 * verifyHost which also includes admin/cohost in its accepted set. Equivalent
 * to "effective role >= cohost in this session context".
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
