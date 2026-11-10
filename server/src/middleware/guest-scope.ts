// ─── What an event guest may reach (Part 2, Task 3, 10 Nov 2026) ────────────────────────────────────────────
//
// An event guest (users.account_kind = 'event_guest') is someone who joined an event from its link and is not a
// member yet. They keep a full account for the event itself (its page, its live room, its chat, rating the people
// they met) and their own account, bell and settings, and nothing else: people, messages, pods, circles, search,
// requests, meetings and admin are for members (spec 02 rules of entry, 09/03: incomplete accounts are never exposed).
//
// The rule is default-deny. `authenticate` asks isGuestAllowed for every request a guest signs, with the path
// Express routed it by (req.baseUrl + req.path), and refuses anything not listed here with 403
// GUEST_MEMBERSHIP_REQUIRED. A new route is therefore closed to guests until someone adds it here on purpose.
//
// Each pattern matches the whole path. A path segment is letters, digits, '-' or '_' only, so '.', '..', an empty
// segment ('//') or an escaped character ('%2e') never matches, and an id is a uuid and nothing else.

import { ErrorCodes } from '@rsn/shared';
import { AppError } from './errors';

export type GuestRouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | '*';

/** The words a guest sees when they reach a member-only part of RSN. */
export const GUEST_MEMBERSHIP_MESSAGE =
  'This part of RSN is for members. You can become a member from your event page.';

const ID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** Any further plain path segments, and an optional trailing slash. */
const ANY_BELOW = '(?:/[A-Za-z0-9_-]+)*/?';

/** One path, exactly, with an optional trailing slash (Express routes '/x/' to the '/x' handler). */
const exact = (path: string): RegExp => new RegExp(`^${path}/?$`);
/** A path and everything below it. */
const below = (path: string): RegExp => new RegExp(`^${path}${ANY_BELOW}$`);

/** The member-free surface: every route an event guest may call. Anything else is refused. */
export const GUEST_ROUTES: ReadonlyArray<{ method: GuestRouteMethod; pattern: RegExp }> = [
  // Signing in and out, the session snapshot, refresh.
  { method: '*', pattern: below('/api/auth') },
  // The event link entry (Task 6).
  { method: '*', pattern: below('/api/call-links') },
  // Their own account and photo, and anyone's photo (the event room shows them).
  { method: 'GET', pattern: exact('/api/users/me') },
  { method: 'PUT', pattern: exact('/api/users/me') },
  { method: 'PUT', pattern: exact('/api/users/me/avatar') },
  { method: 'DELETE', pattern: exact('/api/users/me/avatar') },
  { method: 'GET', pattern: exact(`/api/users/${ID}/avatar`) },
  // Their bell and its settings.
  { method: '*', pattern: below('/api/notifications') },
  { method: '*', pattern: below('/api/notification-prefs') },
  // The event they are at.
  { method: 'GET', pattern: exact(`/api/sessions/${ID}`) },
  { method: 'GET', pattern: exact(`/api/sessions/${ID}/state`) },
  { method: 'POST', pattern: exact(`/api/sessions/${ID}/token`) },
  { method: 'DELETE', pattern: exact(`/api/sessions/${ID}/register`) },
  { method: 'POST', pattern: exact(`/api/sessions/${ID}/intention`) },
  { method: 'GET', pattern: exact(`/api/sessions/${ID}/participants`) },
  { method: 'GET', pattern: exact(`/api/sessions/${ID}/participant-counts`) },
  { method: 'GET', pattern: exact(`/api/sessions/${ID}/chat`) },
  { method: 'POST', pattern: exact(`/api/sessions/${ID}/feedback`) },
  { method: 'GET', pattern: exact(`/api/sessions/${ID}/schedule/mine`) },
  { method: 'GET', pattern: exact(`/api/sessions/${ID}/groups`) },
  // Rating the people they met at it.
  { method: '*', pattern: below('/api/ratings') },
];

/**
 * Whether an event guest may call `method` on `fullPath`, the path Express routed the request by
 * (req.baseUrl + req.path: no query string). Default deny: only a listed route is allowed.
 */
export function isGuestAllowed(method: string, fullPath: string): boolean {
  const verb = method.toUpperCase();
  return GUEST_ROUTES.some((route) => (route.method === '*' || route.method === verb) && route.pattern.test(fullPath));
}

/** The refusal a guest gets on a member-only route: 403 GUEST_MEMBERSHIP_REQUIRED. */
export function guestMembershipRequired(): AppError {
  return new AppError(403, ErrorCodes.GUEST_MEMBERSHIP_REQUIRED, GUEST_MEMBERSHIP_MESSAGE);
}
