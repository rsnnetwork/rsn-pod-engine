// ─── Quoted replies (30 Oct 2026 review, item 4.3) ───────────────────────────
//
// Stefan: "In messages ... you can't reply." A message, one-to-one or in a group, may answer one earlier message of
// the same conversation or group. Each message that does carries `replyTo`: the original as the reader may see it.
// Messages from before replies existed, and messages that answer nothing, carry `replyTo: null` (or none at all, from an
// older server), and are drawn without a quote.

/** The message a reply answers, as the reader may see it. */
export interface MessageReplyQuote {
  /** The original's id: the quote scrolls to it when it is on the page. */
  id: string;
  /** Who wrote the original: "Former member" once their account is closed; empty when `deleted` or `hidden`. */
  senderName: string;
  /** Its first 140 characters ("📷 Photo" or "🎤 Voice message" for an attachment alone); empty when `deleted` or `hidden`. */
  content: string;
  /** 'system' when the product wrote the original (a meeting card): replying to one is allowed. */
  kind: 'user' | 'system';
  /** The original no longer exists: the reply says "Original message deleted". */
  deleted: boolean;
  /**
   * The reader may not see the original (a group message from someone blocked with them either way, or from before they
   * joined the group): nothing of it is sent, and the reply says "Earlier message".
   */
  hidden?: boolean;
}
