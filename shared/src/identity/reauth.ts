// ─── Confirm it's you again before a sensitive change (10 Nov 2026 spec, Part 3 item 5) ──────────────────────────
//
// Section 11 of the spec: "Verify identity again for sensitive changes." A member who is signed in asks for a 6-digit
// code at their current address, types it, and gets a short proof (a reauth token) that is good for one change of one
// kind, for REAUTH_GRANT_MINUTES. The server and the client agree on the kinds here.

/** The changes that need a fresh proof: changing one's sign-in email, closing one's account, and granting or removing admin. */
export const REAUTH_SCOPES = ['change_email', 'close_account', 'admin_role'] as const;
export type ReauthScope = typeof REAUTH_SCOPES[number];

/** How long a proof lasts once its code is typed, in minutes. It is spent by the first change it is used for. */
export const REAUTH_GRANT_MINUTES = 10;

/** What a refused change says when no fresh proof came with it (403 REAUTH_REQUIRED, error.details.scope names the kind). */
export const REAUTH_REQUIRED_MESSAGE = "Confirm it's you first. We'll email you a code.";

export function isReauthScope(value: unknown): value is ReauthScope {
  return typeof value === 'string' && (REAUTH_SCOPES as readonly string[]).includes(value);
}

/** The roles whose grant or removal is an admin role change. */
const ADMIN_ROLES: readonly string[] = ['admin', 'super_admin'];

export function isAdminRole(role: unknown): boolean {
  return typeof role === 'string' && ADMIN_ROLES.includes(role);
}

/**
 * Whether moving people from `fromRoles` to `toRole` grants or removes an admin role, so needs a super admin and a fresh
 * `admin_role` proof. Moving between member tiers (member, pro, host, ...) does not.
 */
export function touchesAdminRole(fromRoles: readonly unknown[], toRole: unknown): boolean {
  return isAdminRole(toRole) || fromRoles.some(isAdminRole);
}
