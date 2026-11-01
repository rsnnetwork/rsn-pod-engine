// client/src/features/messages/reply-text.ts
// What a quoted reply says (30 Oct 2026 review, item 4.3, L7), in the one-to-one and the group thread alike. Pure on
// purpose (no React), so a test can run it: server/src/__tests__/client/t6-messaging.test.ts.
//
// Stefan: "In messages ... you can't reply." Each message now has a Reply beside it. The message box then shows
// "Replying to Shradha: …" with a way to cancel, and the reply carries a quote of the original: tapping the quote shows
// the original when it is on the page. The server sends each reply's original as MessageReplyQuote (@rsn/shared).
import type { MessageReplyQuote } from '@rsn/shared';

export const REPLY = 'Reply';
export const CANCEL_REPLY = 'Cancel reply';
export const ORIGINAL_DELETED = 'Original message deleted';
export const EARLIER_MESSAGE = 'Earlier message';
/** The strip's name for a message of your own. */
export const YOURSELF = 'yourself';

/** How much of the original the strip above the message box shows. */
const STRIP_MAX = 80;

/** The message a reply is being written to, as the strip above the message box shows it. */
export interface ReplyTarget {
  id: string;
  senderName: string;
  /** The original's words (or "📷 Photo" for an attachment alone). */
  content: string;
  mine: boolean;
}

/** The first n characters, a whole emoji counted as one, with "…" when there was more. */
export function shorten(text: string, n: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > n ? `${chars.slice(0, n).join('').trimEnd()}…` : chars.join('');
}

/** "Replying to Shradha: Shall we meet on…" */
export function replyingTo(target: ReplyTarget): string {
  const who = target.mine ? YOURSELF : target.senderName || 'this message';
  const what = shorten(target.content, STRIP_MAX);
  return what ? `Replying to ${who}: ${what}` : `Replying to ${who}`;
}

/** What a message offers as its words when it is replied to: its text, or what it carried instead. */
export function replyContentOf(m: { content?: string | null; attachmentType?: string | null }): string {
  if (m.content && m.content.trim()) return m.content;
  if (m.attachmentType === 'image') return '📷 Photo';
  if (m.attachmentType === 'audio') return '🎤 Voice message';
  return '';
}

/** What a quote in a bubble says: the original's writer and words, or why they cannot be shown. */
export function quoteView(quote: MessageReplyQuote, loaded: boolean): {
  /** Bold line: who wrote the original, or the reason it is not shown. */
  heading: string;
  /** The original's words, or nothing. */
  text: string;
  /** Tapping the quote brings the original into view: it is on the page now. */
  canJump: boolean;
} {
  if (quote.deleted) return { heading: ORIGINAL_DELETED, text: '', canJump: false };
  if (quote.hidden) return { heading: EARLIER_MESSAGE, text: '', canJump: false };
  if (!loaded) return { heading: quote.senderName || EARLIER_MESSAGE, text: `${EARLIER_MESSAGE} · ${shorten(quote.content, 140)}`, canJump: false };
  return { heading: quote.senderName, text: shorten(quote.content, 140), canJump: true };
}
