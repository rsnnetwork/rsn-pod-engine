// ─── The event link (Stefan, 11 Nov 2026): /events/<name>-<n>, and /events/<name>-<n>-<tail> when not public ──────────
//
// Every event has one link people can read and share: a name the organiser chooses (e.g. "rsn"), then the next number
// for that name across all events ("rsn-1", "rsn-2", ...). An event that is not public (private, invitation-only, or in
// a closed circle) adds a random tail ("rsn-3-k7m2q9") so its link cannot be guessed from its neighbours' numbers.
//
// The tail: EVENT_LINK_TAIL_LENGTH symbols from the operating system's random source, the first a letter (so the tail
// never reads as a number and every link parses one way only), the rest from a 32-symbol alphabet without 0, o, 1 and l
// (the symbols people confuse). 6 symbols give 24 x 32^5, about 805 million tails (29.6 bits) per name and number.
//
// The call link (/call/<code>, call-link.ts) keeps working beside it: both lead to the same entry.

/** Where an event link lives on the client. The server's emails and the client's router both read this constant. */
export const EVENT_LINK_BASE_PATH = '/events';

/** The name an event gets when its organiser chooses none and nothing better is known (the platform's own). */
export const EVENT_LINK_DEFAULT_NAME = 'rsn';

export const EVENT_LINK_NAME_MIN = 2;
export const EVENT_LINK_NAME_MAX = 40;

/** The tail's symbols: digits 2-9 and the letters without l and o (32). */
export const EVENT_LINK_TAIL_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';
/** The tail's first symbol: a letter (24), so a tail is never all digits. */
export const EVENT_LINK_TAIL_FIRST = 'abcdefghijkmnpqrstuvwxyz';
export const EVENT_LINK_TAIL_LENGTH = 6;

/** The most digits an event number may have (a Postgres integer holds nine safely). */
const NUMBER_DIGITS_MAX = 9;

/**
 * Names nobody may choose: the app's own paths and words that would read as the app speaking. Profanity is not policed
 * here. "rsn" is not reserved: it is the platform default every organiser may use.
 */
export const EVENT_LINK_RESERVED_NAMES: readonly string[] = [
  'about', 'account', 'admin', 'administrator', 'agents', 'api', 'app', 'assets', 'auth', 'billing', 'call', 'calls',
  'circle', 'circles', 'connections', 'create', 'dashboard', 'delete', 'edit', 'encounters', 'entities', 'event',
  'events', 'everyone', 'feedback', 'help', 'home', 'host', 'invite', 'invites', 'join', 'live', 'login', 'logout',
  'matches', 'me', 'meet', 'meetings', 'messages', 'moderation', 'my-events', 'new', 'notifications', 'null',
  'onboarding', 'people', 'pod', 'pods', 'preview', 'privacy', 'profile', 'public', 'reason', 'recap', 'register',
  'report', 'request-to-join', 'root', 'search', 'security', 'session', 'sessions', 'settings', 'sign-in', 'sign-up',
  'signin', 'signup', 'staff', 'static', 'support', 'system', 'terms', 'undefined', 'verify', 'welcome', 'www',
];

const RESERVED: ReadonlySet<string> = new Set(EVENT_LINK_RESERVED_NAMES);

/** Lower-case letters and digits, in hyphen-separated runs: no leading, trailing or doubled hyphen. */
const NAME_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A name as typed, in the form it is checked and stored: trimmed and lower-cased (nothing else is changed). */
export function normaliseEventLinkName(raw: string): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export const EVENT_LINK_NAME_RULE = 'Use 2 to 40 lower-case letters, digits and single hyphens, starting and ending with a letter or digit.';

/**
 * Why a name cannot be used, in the organiser's words, or null when it can. The name is checked as stored
 * (normaliseEventLinkName first).
 */
export function eventLinkNameProblem(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'Give the event link a name.';
  if (name.length < EVENT_LINK_NAME_MIN) return 'The link name needs at least 2 characters.';
  if (name.length > EVENT_LINK_NAME_MAX) return 'The link name can have at most 40 characters.';
  if (!NAME_SHAPE.test(name)) return EVENT_LINK_NAME_RULE;
  if (RESERVED.has(name)) return 'That name is kept for REASON itself. Choose another.';
  return null;
}

/** True for a name an event link may use. */
export function isEventLinkName(name: string): boolean {
  return eventLinkNameProblem(name) === null;
}

/** The parts of an event link: its name, its number and, when the event is not public, its tail. */
export interface EventLinkParts {
  name: string;
  number: number;
  tail: string | null;
}

/** The link's last path segment: "rsn-3", or "rsn-3-k7m2q9" with a tail. */
export function eventLinkSlug(parts: EventLinkParts): string {
  return parts.tail ? `${parts.name}-${parts.number}-${parts.tail}` : `${parts.name}-${parts.number}`;
}

/** The client path of an event link, e.g. '/events/rsn-3'. */
export function eventLinkPath(slug: string): string {
  return `${EVENT_LINK_BASE_PATH}/${slug}`;
}

/** True for a well-formed tail: EVENT_LINK_TAIL_LENGTH symbols, a letter first, every one in the tail alphabet. */
export function isEventLinkTail(tail: string): boolean {
  if (typeof tail !== 'string' || tail.length !== EVENT_LINK_TAIL_LENGTH) return false;
  if (!EVENT_LINK_TAIL_FIRST.includes(tail[0])) return false;
  for (const ch of tail) if (!EVENT_LINK_TAIL_ALPHABET.includes(ch)) return false;
  return true;
}

/** The longest slug: a 40-character name, a 9-digit number, a tail and two hyphens. */
export const EVENT_LINK_SLUG_MAX = EVENT_LINK_NAME_MAX + 1 + NUMBER_DIGITS_MAX + 1 + EVENT_LINK_TAIL_LENGTH;

/**
 * An event link's slug read back into its parts, or null when it cannot be one. Read from the right, one way only: a
 * last segment holding a letter is the tail (a tail always starts with one), the all-digit segment before it the number,
 * the rest the name. Case is ignored. The name is checked for shape and length but not against the reserved words (a
 * link made before a word was reserved still opens).
 */
export function parseEventLinkSlug(raw: string): EventLinkParts | null {
  if (typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase();
  if (slug.length === 0 || slug.length > EVENT_LINK_SLUG_MAX || !NAME_SHAPE.test(slug)) return null;
  const segments = slug.split('-');
  let tail: string | null = null;
  const last = segments[segments.length - 1];
  if (/[a-z]/.test(last)) {
    if (!isEventLinkTail(last)) return null;
    tail = last;
    segments.pop();
  }
  if (segments.length < 2) return null;
  const digits = segments.pop() as string;
  if (!/^[1-9][0-9]*$/.test(digits) || digits.length > NUMBER_DIGITS_MAX) return null;
  const name = segments.join('-');
  if (name.length < EVENT_LINK_NAME_MIN || name.length > EVENT_LINK_NAME_MAX) return null;
  return { name, number: Number(digits), tail };
}
