// ─── Where an event guest may go (Part 2, Task 12; spec 02 rules of entry) ──────────────────────────────────
//
// An event guest (account kind 'event_guest') joined an event from its RSN Call link and is not a member yet. They see
// their event and their guest home, their bell and their settings, and the way to become a member. Every member page
// (For You, People, Everyone, Messages, Pods, Circles, Entities, admin) sends them to the guest home. The kind is read
// from the session (GET /auth/session), never guessed from a refusal: the server's 403 GUEST_MEMBERSHIP_REQUIRED can
// also answer a member during a database outage (Task 3's report).
//
// No imports but the shared constant, so the server's test suite can run it.

import { CALL_LINK_BASE_PATH, EVENT_LINK_BASE_PATH, callLinkPath, eventLinkPath, parseEventLinkSlug } from '@rsn/shared';

/** The guest home: the guest's events by link, and the way to become a member. */
export const GUEST_HOME_PATH = '/my-events';

interface SessionPerson {
  id?: string;
  accountKind?: string | null;
}

/** True for an event guest's session. A session that does not say (an older server, a cached one) is a member's. */
export function isEventGuest(user: SessionPerson | null | undefined): boolean {
  return user?.accountKind === 'event_guest';
}

/**
 * The member's id, or undefined for nobody and for an event guest. The app-wide reads only a member can make (the
 * Messages badge, the group chats, calls) are enabled by it, so a guest's browser never asks for them.
 */
export function memberIdOf(user: SessionPerson | null | undefined): string | undefined {
  if (!user?.id || isEventGuest(user)) return undefined;
  return user.id;
}

const SEGMENT = '[^/]+';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pages a guest may open; every pattern matches the whole path. */
const GUEST_PAGES: readonly RegExp[] = [
  new RegExp(`^${escape(CALL_LINK_BASE_PATH)}/${SEGMENT}/?$`),
  new RegExp(`^${escape(EVENT_LINK_BASE_PATH)}/${SEGMENT}/?$`),
  new RegExp(`^/session/${SEGMENT}/live/?$`),
  new RegExp(`^${escape(GUEST_HOME_PATH)}/?$`),
  /^\/notifications\/?$/,
  /^\/settings\/?$/,
  /^\/request-to-join\/?$/,
];

/** Whether an event guest may open `pathname`; anything else sends them to the guest home. */
export function guestAllowedPath(pathname: string): boolean {
  return GUEST_PAGES.some((page) => page.test(pathname));
}

// ─── The way back to an event's link ─────────────────────────────────────────
//
// The live page knows the event's id; its link is known only to the page that sent the person there. The call page
// writes down which link led to which event before it sends someone in, so a guest the live room refuses goes back to
// that event's link (where the event says why, and what it still needs), not to a member page. A navigation hint, kept
// in this browser only; never shown, never sent.

const CALL_LINKS_KEY = 'rsn_call_links';
const CALL_LINKS_KEPT = 20;
/** A call code, or an event link's slug ('rsn-3', 'rsn-3-k7m2q9'): lower-case letters and digits in hyphenated runs. */
const CODE_SHAPE = /^[0-9a-z]{1,40}(?:-[0-9a-z]{1,40}){0,8}$/;

interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The browser's storage, or null where there is none (a test, a locked-down browser). */
function storage(): KeyValueStore | null {
  return (globalThis as { localStorage?: KeyValueStore }).localStorage ?? null;
}

function readKept(): Array<[string, string]> {
  try {
    const raw = storage()?.getItem(CALL_LINKS_KEY) ?? null;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((pair): pair is [string, string] =>
      Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string' && CODE_SHAPE.test(pair[1]));
  } catch {
    // Storage switched off, full, or holding something else: the hint is only lost, nothing breaks.
    return [];
  }
}

/** Write down that `code`'s link leads to event `sessionId` (the newest twenty are kept). */
export function rememberCallLink(sessionId: string, code: string): void {
  if (!sessionId || !CODE_SHAPE.test(code)) return;
  const kept = [[sessionId, code] as [string, string], ...readKept().filter(([id]) => id !== sessionId)].slice(0, CALL_LINKS_KEPT);
  try {
    storage()?.setItem(CALL_LINKS_KEY, JSON.stringify(kept));
  } catch {
    // As above: without storage the guest goes back to their guest home instead.
  }
}

/** The page of the link that led this browser to event `sessionId` (its event link or its call link), or null. */
export function callPathForEvent(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const found = readKept().find(([id]) => id === sessionId);
  if (!found) return null;
  return parseEventLinkSlug(found[1]) ? eventLinkPath(found[1]) : callLinkPath(found[1]);
}
