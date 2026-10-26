// ─── The event chat card's words and rules (26 Oct 2026, C10, COM-02) ───────
//
// The chat of an event is kept with the event (S5): its page reads it back a page at a time from
// GET /sessions/:id/chat, newest page first, each page oldest to newest. These are the card's sentences (given
// verbatim in the brief) and the small rules it follows. Pure, so the server's jest runs it:
// server/src/__tests__/client/c10-after-event.test.ts.
import type { EventChatMessage, EventChatPage } from '@rsn/shared';

export const CHAT_TITLE = 'Event chat';
export const CHAT_EMPTY = 'No messages were sent during this event.';
export const CHAT_FORBIDDEN = 'Only people who took part in this event can read its chat.';
export const CHAT_LIVE = 'The chat is inside the live event.';
export const ENTER_LIVE = 'Enter live event';
export const SHOW_EARLIER = 'Show earlier messages';
export const CHAT_FAILED = "We couldn't load this event's chat.";
export const TRY_AGAIN = 'Try again';

/** The newest this many messages show first; "Show earlier messages" reads the page before. */
export const CHAT_PAGE_SIZE = 30;

/** The chat's pages as one list, oldest first: the first page is the newest, each next page the one before it. */
export function chatInOrder(pages: readonly EventChatPage[]): EventChatMessage[] {
  return [...pages].reverse().flatMap((p) => p.messages);
}

/** The time a message was sent, in the reader's own clock ("14:05"). */
export function chatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** The reactions the live chat offers, in its own order (ChatPanel's CHAT_EMOJIS). */
const REACTIONS: ReadonlyArray<{ key: string; emoji: string }> = [
  { key: 'heart', emoji: '❤️' },
  { key: 'clap', emoji: '👏' },
  { key: 'thumbs_up', emoji: '👍' },
];

/** The reactions a message had, with their counts; none that nobody gave. */
export function reactionSummary(reactions: Record<string, number>): Array<{ emoji: string; count: number }> {
  return REACTIONS.filter((r) => (reactions[r.key] ?? 0) > 0).map((r) => ({ emoji: r.emoji, count: reactions[r.key] }));
}

/** A 403 is the reader not having taken part (the card says so); anything else is a failure to load. */
export function chatLoadProblem(err: unknown): 'forbidden' | 'failed' {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 403 ? 'forbidden' : 'failed';
}
