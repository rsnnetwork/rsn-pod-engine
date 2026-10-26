// ─── The live chat's messages: merged with the server's history, and kept true to it (26 Oct 2026, C10) ───
//
// Since S5 an event's chat is stored as it is sent, so the server's history (chat:history) is a copy of what the
// panel should hold, not a replacement for it. Putting it in place of the panel dropped any message that arrived
// between asking and the answer (the late-joiner race, CLAUDE.md §3): now it is merged, every message once.
//
// A message taken down after it was sent (DELETE /sessions/:id/chat/:messageId) is announced only by the event's
// session:<id>:chat tag, and a merge never removes anything, so the panel then reads the chat page (the database,
// the truth) and drops what is no longer on it. A message counts as taken down only when the panel already held it
// before the page was asked for: it was stored before the page was read, so the page would list it if it were still
// there. Anything that arrived later is kept whatever the page says.
//
// Pure (no React, store or socket), so the server's jest runs it: server/src/__tests__/client/c10-after-event.test.ts.

/** The panel holds the newest this many messages (sessionStore's addChatMessage keeps the same number). */
export const LIVE_CHAT_CAP = 200;

/** What the merge needs of a live chat message (the socket's shape, sessionStore's ChatMessage). */
export interface HeldMessage {
  id: string;
  /** When the server stored it (ISO, to the millisecond). */
  timestamp: string;
  scope?: 'lobby' | 'room';
}

function millis(iso: string): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : 0;
}

/** The server's own order: when it was stored, then its id (the chat page's keyset is (created_at, id)). */
function compareStored(a: { at: number; id: string }, b: { at: number; id: string }): number {
  if (a.at !== b.at) return a.at - b.at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const stored = (m: HeldMessage) => ({ at: millis(m.timestamp), id: m.id });

/**
 * chat:history merged into what the panel holds: every message once (the server's copy of one the panel had takes
 * its place, so its reactions are the stored ones), oldest first, the newest `cap` kept.
 */
export function mergeChatHistory<T extends HeldMessage>(held: readonly T[], incoming: readonly T[], cap = LIVE_CHAT_CAP): T[] {
  if (incoming.length === 0) return [...held];
  const byId = new Map<string, T>();
  for (const m of held) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  const all = [...byId.values()].sort((a, b) => compareStored(stored(a), stored(b)));
  return all.length > cap ? all.slice(all.length - cap) : all;
}

/**
 * What the chat page said: its messages (one page or several, merged) and whether it holds the whole chat (the last
 * page had no nextCursor). When it does not, it reaches back only to its oldest message.
 */
export interface ChatPageSlice {
  messages: ReadonlyArray<{ id: string; createdAt: string; scope: 'lobby' | 'room' }>;
  complete: boolean;
}

/**
 * The panel's messages without the ones taken down. A message is dropped only when the panel held it before the page
 * was asked for (`heldBefore`), the page reaches back to it, and the page no longer has it. The page shows rooms to
 * everyone who may read it except an admin who did not take part (who reads the lobby only), so for an admin a room
 * message is judged only when the page shows at least one room message.
 */
export function withoutTakenDown<T extends HeldMessage>(
  held: readonly T[],
  page: ChatPageSlice,
  heldBefore: ReadonlySet<string>,
  viewerIsAdmin: boolean,
): T[] {
  const onPage = new Set(page.messages.map((m) => m.id));
  const roomsReadable = !viewerIsAdmin || page.messages.some((m) => m.scope === 'room');
  let oldest: { at: number; id: string } | null = null;
  for (const m of page.messages) {
    const s = { at: millis(m.createdAt), id: m.id };
    if (!oldest || compareStored(s, oldest) < 0) oldest = s;
  }
  const reaches = (m: T) => page.complete || (oldest !== null && compareStored(stored(m), oldest) >= 0);
  return held.filter((m) => {
    const takenDown = heldBefore.has(m.id) && !onPage.has(m.id) && (m.scope !== 'room' || roomsReadable) && reaches(m);
    return !takenDown;
  });
}
