// client/src/lib/message-chime-policy.ts
// When a new message sounds, and which open tab plays it (30 Oct 2026 review, item 4.4, L8). Pure on purpose (no React,
// no socket, no audio), so a test can run it: server/src/__tests__/client/t6-messaging.test.ts.
//
// A message sounds once, in one tab, however many of the member's tabs are open: every tab hears it (the server sends
// it to each), so each tab says over a BroadcastChannel whether it may sound here and whether it is in front, waits a
// moment for the others, and the same rule picks one tab in all of them. It does not sound at all when any tab says
// quiet: the conversation is open in a tab in front of the member, or a tab is in a live event or a meeting (where the
// event's own sounds matter), or the member has switched the sound off on this device. Nor within 2 seconds of the last
// chime in any tab, nor twice for the same message.
//
// An incoming call rings through the same path (X3, 2 Nov 2026): one tab, the same setting, quiet in a live event or a
// meeting. Unlike a message it rings in its own open conversation too, and a recent chime does not hold it back.

/** No chime within this long of the last one, in any tab. */
export const CHIME_COOLDOWN_MS = 2000;
/** How long a tab waits for the other tabs' word before deciding. */
export const CHIME_VOTE_WINDOW_MS = 250;

/** A message that may sound: its id, and the address of its conversation. */
export interface ChimeEvent {
  id: string;
  /** /messages/<conversationId> or /messages/g/<groupId>. */
  path: string;
  /** An incoming call: it rings (another sound), also in its open conversation. */
  ring?: true;
}

/** One tab's word on one message. */
export interface ChimeVote {
  id: string;
  tabId: string;
  /** This tab says it must not sound (see quietHere). */
  quiet: boolean;
  /** This tab is in front of the member. */
  visible: boolean;
}

/** A live dm:message, as much of it as this needs. */
export interface DmMessageLike { id: string; conversationId: string; fromUserId: string; kind?: string | null }

/** A notification:new, as much of it as this needs. */
export interface NotificationLike { id: string; type: string; link?: string | null }

/** A one-to-one message that may sound: never your own, never a card REASON wrote. */
export function chimeFromDm(msg: DmMessageLike, me: string | undefined): ChimeEvent | null {
  if (!me || !msg?.id || msg.fromUserId === me || msg.kind === 'system') return null;
  return { id: `dm:${msg.id}`, path: `/messages/${msg.conversationId}` };
}

/** A group's bell may sound (the server rings a group at most once in 10 minutes per member); no other bell does. */
export function chimeFromNotification(n: NotificationLike): ChimeEvent | null {
  if (!n?.id || n.type !== 'group_message' || !n.link) return null;
  return { id: `bell:${n.id}`, path: n.link };
}

/** An incoming call (call:request) rings once per request. */
export function chimeFromCall(d: { requestId: string; conversationId: string }): ChimeEvent | null {
  if (!d?.requestId || !d.conversationId) return null;
  return { id: `call:${d.requestId}`, path: `/messages/${d.conversationId}`, ring: true };
}

/** Whether this tab says quiet for this message. */
export function quietHere(ev: ChimeEvent, tab: { pathname: string; visible: boolean; soundOn: boolean }): boolean {
  if (!tab.soundOn) return true;
  if (tab.pathname.startsWith('/meet/')) return true;
  if (/^\/session\/[^/]+\/live(\/|$)/.test(tab.pathname)) return true;
  return !ev.ring && tab.visible && tab.pathname === ev.path;
}

/**
 * Whether this tab plays the message, given every tab's word on it. Nobody plays when one says quiet, when it has
 * already played somewhere, or within the cooldown of the last chime. Otherwise one tab: one in front of the member if
 * there is one, then the smallest tab id, so every tab picks the same one.
 */
export function playsHere(
  votes: ChimeVote[],
  self: string,
  history: { alreadyPlayed: boolean; lastPlayedAt: number | null; now: number },
): boolean {
  if (history.alreadyPlayed) return false;
  if (history.lastPlayedAt !== null && history.now - history.lastPlayedAt < CHIME_COOLDOWN_MS) return false;
  if (votes.length === 0 || votes.some((v) => v.quiet)) return false;
  const [winner] = [...votes].sort((a, b) => Number(b.visible) - Number(a.visible) || (a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0));
  return winner.tabId === self;
}
