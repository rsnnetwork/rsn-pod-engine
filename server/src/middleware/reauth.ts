// ─── A fresh identity proof in front of a sensitive change (Part 3 Task 2, 11 Nov 2026) ───────────────────────────
//
// The proof is the reauth token from POST /auth/reauth/verify, sent in the JSON body as `reauthToken` (CORS lets only
// Content-Type and Authorization through, so it is not a header). It is spent here, before the change runs: one token,
// one change. Use these AFTER `authenticate`, after validation (a Zod schema must keep `reauthToken`), and after every
// permission check, so a change refused for another reason never costs the member their proof.

import { Request, Response, NextFunction } from 'express';
import { touchesAdminRole, type ReauthScope } from '@rsn/shared';
import { UnauthorizedError } from './errors';
import { consumeReauthGrant, reauthRequired } from '../services/identity/reauth.service';

/** The proof a request carries, if any. */
function reauthTokenOf(req: Request): string {
  const token = (req.body as { reauthToken?: unknown } | undefined)?.reauthToken;
  return typeof token === 'string' ? token : '';
}

/** Spend the request's proof for `scope`, or throw 403 REAUTH_REQUIRED. */
export async function assertRecentReauth(req: Request, scope: ReauthScope): Promise<void> {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  const token = reauthTokenOf(req);
  if (!token || !(await consumeReauthGrant(req.user.userId, scope, token))) throw reauthRequired(scope);
}

/** Refuses the request with 403 { code: 'REAUTH_REQUIRED', details: { scope } } unless it carries a live proof for `scope`. */
export function requireRecentReauth(scope: ReauthScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    assertRecentReauth(req, scope).then(() => next(), next);
  };
}

/**
 * The role change a request is about to make, set by the route's own permission check before
 * requireReauthForAdminRoleChange runs: the role given and every target's current role. Unset: no role change.
 */
export interface PendingRoleChange {
  to: string;
  from: string[];
}

/**
 * An `admin_role` proof, but only when the change grants or removes admin or super_admin (the new role, or any target's
 * current role, is one of them). Moving people between member tiers needs none.
 */
export function requireReauthForAdminRoleChange(req: Request, res: Response, next: NextFunction): void {
  const change = res.locals.roleChange as PendingRoleChange | undefined;
  if (!change || !touchesAdminRole(change.from, change.to)) {
    next();
    return;
  }
  assertRecentReauth(req, 'admin_role').then(() => next(), next);
}
