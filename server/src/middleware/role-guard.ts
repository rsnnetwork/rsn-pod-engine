// ─── Who may change whose role or status (Part 3 Task 2, 11 Nov 2026) ─────────────────────────────────────────────
//
// Two holes the reauth audit found (audit-5 §2.3), closed on the server for every route that changes a role or a status:
//   - granting or removing admin or super_admin needs a super admin. PUT /users/:id/role checked only the role given;
//     the bulk route (POST /admin/users/bulk-action, change_role) checked nothing, so any admin could make anyone,
//     themselves included, a super admin.
//   - only a super admin may change or suspend a super admin. Neither route looked at the target's role, so an admin
//     could demote, suspend, ban or remove one. The admin page hid both; the server did not refuse.
// The guard reads each target's current role, refuses what the caller may not do, and leaves the change it allowed in
// res.locals for requireReauthForAdminRoleChange (middleware/reauth.ts) and the route's audit row.

import { Request, Response, NextFunction } from 'express';
import { UserRole, touchesAdminRole } from '@rsn/shared';
import { query } from '../db';
import { ForbiddenError, UnauthorizedError } from './errors';
import type { PendingRoleChange } from './reauth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SUPER_ADMIN_TARGET_MESSAGE = 'Only a super admin can change another super admin.';
export const ADMIN_ROLE_MESSAGE = 'Only a super admin can grant or remove an admin role.';

/** Each target's current role, by id. Ids that are not ids name nobody. */
export async function readTargetRoles(ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return new Map();
  const result = await query<{ id: string; role: string }>(
    `SELECT id, role FROM users WHERE id = ANY($1::uuid[])`,
    [wanted],
  );
  return new Map(result.rows.map((row) => [row.id, row.role]));
}

/** Why the caller may not make this change, or null. Changing a super admin is refused first: it explains the rest. */
export function accountChangeRefusal(actorRole: string, targetRoles: string[], newRole?: string): ForbiddenError | null {
  if (actorRole === UserRole.SUPER_ADMIN) return null;
  if (targetRoles.includes(UserRole.SUPER_ADMIN)) return new ForbiddenError(SUPER_ADMIN_TARGET_MESSAGE);
  if (newRole !== undefined && touchesAdminRole(targetRoles, newRole)) return new ForbiddenError(ADMIN_ROLE_MESSAGE);
  return null;
}

/**
 * A guard for a route that changes the role or status of the accounts `targets` names. `newRole` reads the role the
 * request gives, or undefined for a status change. Sets res.locals.targetRoles (id → role before the change) and, for a
 * role change, res.locals.roleChange.
 */
export function guardAccountChange(opts: {
  targets: (req: Request) => string[];
  newRole?: (req: Request) => string | undefined;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    (async () => {
      if (!req.user) throw new UnauthorizedError('Authentication required');
      const roles = await readTargetRoles(opts.targets(req));
      const from = [...roles.values()];
      const to = opts.newRole?.(req);
      const refusal = accountChangeRefusal(req.user.role, from, to);
      if (refusal) throw refusal;
      res.locals.targetRoles = roles;
      if (to !== undefined) res.locals.roleChange = { to, from } satisfies PendingRoleChange;
    })().then(() => next(), next);
  };
}
