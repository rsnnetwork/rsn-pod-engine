// The chat panel in the call room (1 Nov 2026, T7, 30 Oct review 5a): what it counts and how it lists the pair's
// conversation. Pure on purpose (no axios, store or router), so a test can run it:
// server/src/__tests__/client/t7-call-chat.test.ts.

import type { DmMessage } from '../messages/thread/dm-message';

/** The newest message's time as the server wrote it, or null for an empty conversation. Server times only, so a
 *  phone whose clock is wrong counts the same as any other. */
export function newestAt(messages: readonly DmMessage[]): string | null {
  let newest: string | null = null;
  for (const m of messages) if (newest === null || Date.parse(m.createdAt) > Date.parse(newest)) newest = m.createdAt;
  return newest;
}

/** The Chat button's count: what the other person wrote after `seenAt` (the newest message when the panel was last
 *  open, or when the room opened). Lines the product wrote are not counted, nor are your own. */
export function unreadFrom(messages: readonly DmMessage[], partnerId: string | null | undefined, seenAt: string | null): number {
  if (!partnerId) return 0;
  const after = seenAt === null ? -Infinity : Date.parse(seenAt);
  return messages.filter((m) => m.fromUserId === partnerId && m.kind !== 'system' && Date.parse(m.createdAt) > after).length;
}

/** The panel lists the latest messages oldest first, so the newest sits at the bottom. The server answers newest first. */
export const PANEL_LIMIT = 50;
export function panelOrder(messages: readonly DmMessage[]): DmMessage[] {
  return [...messages]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-PANEL_LIMIT);
}

/** What the text box sends: the words with the outer spaces taken off, or nothing for a box of spaces. */
export function sendable(draft: string): string | null {
  const text = draft.trim();
  return text ? text : null;
}

/** Enter sends; Shift+Enter starts a new line, and Enter while a phone keyboard or an IME is composing does not send. */
export function sendsOnKey(e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}
