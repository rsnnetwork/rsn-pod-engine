// client/src/features/calls/presence-words.ts
// Presence and the call button (11 Nov 2026, Shirley Palmer's RSN 07: "the camera button looked disabled because the
// other person looked offline, then became clickable unexpectedly"). Pure on purpose (no React or axios), so a test
// runs the rules: server/src/__tests__/client/shirley-s5-safety-calls.test.ts.
//
// The rules:
//   - A read still loading (undefined) or one that could not tell (null) is UNKNOWN: no label, never "Offline", and the
//     call button works. The server is the gate.
//   - online: "Online"; away: "Away" (they have REASON open but not in front of them; a call still reaches them);
//     offline: "Offline".
//   - The call button is never disabled for presence. Pressed while they are offline, it opens a sheet with Try again,
//     Find a time and Send a message instead of ringing.
import type { PresenceState } from '@rsn/shared';

/** What a screen knows: a state, null when the server could not tell, undefined while the read is on its way. */
export type SeenPresence = PresenceState | null | undefined;

export interface PresenceBadge {
  label: string;
  /** The dot's colour class. */
  dot: string;
  /** The word's colour class. */
  text: string;
}

const BADGES: Record<PresenceState, PresenceBadge> = {
  online: { label: 'Online', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  away: { label: 'Away', dot: 'bg-amber-400', text: 'text-amber-700' },
  offline: { label: 'Offline', dot: 'bg-gray-300', text: 'text-gray-500' },
};

/** The header's dot and word: nothing at all until the state is known. */
export function presenceBadge(p: SeenPresence): PresenceBadge | null {
  return p ? BADGES[p] : null;
}

/** The inbox avatar's dot: green when online, amber when away, none otherwise (the same source as the header). */
export function inboxDot(p: SeenPresence): string | null {
  if (p === 'online') return BADGES.online.dot;
  if (p === 'away') return BADGES.away.dot;
  return null;
}

const nameOf = (name: string | null | undefined) => name?.trim() || 'They';

/** Under or beside the call button while they are away: the call still goes, and when it is seen. */
export const awayNote = (name: string | null | undefined): string => `${nameOf(name)} is away. They'll see your call when they're back.`;

/** The call button's tooltip. */
export function callHint(p: SeenPresence, name: string | null | undefined, action = 'Video call'): string {
  if (p === 'away') return `${action}: ${awayNote(name)}`;
  if (p === 'offline') return `${action}: ${nameOf(name)} isn't on REASON right now`;
  return action;
}

/** Pressing call while they are known to be offline opens the sheet instead of ringing. Unknown rings. */
export const callOpensOfflineSheet = (p: SeenPresence): boolean => p === 'offline';

export const offlineTitle = (name: string | null | undefined): string => `${nameOf(name)} isn't on REASON right now.`;
export const OFFLINE_BODY = 'Try again in a moment, find a time to meet, or send a message they will see when they are back.';
export const stillOffline = (name: string | null | undefined): string =>
  `${nameOf(name)} still isn't on REASON. Find a time, or send a message they'll see when they're back.`;
export const TRY_AGAIN = 'Try again';
export const FIND_A_TIME = 'Find a time';
export const SEND_A_MESSAGE = 'Send a message';

/** The answer of GET /dm/presence. `states` came with 11 Nov 2026; `online` is the older field. */
export interface InboxPresence {
  online: Record<string, boolean>;
  states?: Record<string, PresenceState>;
}

/** One partner's state from the inbox read: undefined while it loads, null when that partner could not be placed. */
export function stateIn(data: InboxPresence | undefined, userId: string | null | undefined): SeenPresence {
  if (!data) return undefined;
  if (!userId) return null;
  const state = data.states?.[userId];
  if (state) return state;
  if (data.states) return null;
  return data.online[userId] ? 'online' : null;
}
