// ─── Quoted replies: one rule for the one-to-one and the group thread (30 Oct 2026 review, item 4.3) ────────────────
//
// A message may answer one earlier message of the same conversation or group (direct_messages.reply_to_id, migration
// 121). Every message a thread sends carries `replyTo`, the original as the reader may see it (MessageReplyQuote in
// @rsn/shared). This file holds what both threads share: the words of a refusal, the length of a quote, the columns a
// thread reads for it, and how a row becomes a quote.

import type { MessageReplyQuote } from '@rsn/shared';
import { FORMER_MEMBER_NAME } from '../users/active-member';

/** How much of the original a quote carries, in characters (a whole emoji is one). */
export const REPLY_EXCERPT_MAX = 140;

/** A closed account's name wherever a message of theirs is shown: T2's one constant (services/users/active-member.ts). */
export const FORMER_MEMBER = FORMER_MEMBER_NAME;

/** The words people read. */
export const REPLY_COPY = {
  notInConversation: 'You can only reply to a message in this conversation.',
  notInGroup: 'You can only reply to a message in this group.',
} as const;

/** The first n characters, counted the way the database counts them (a whole emoji is one). */
function excerpt(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('');
}

/** What a quote says of an original with no words: what it carried instead. */
function quotedText(content: string | null, attachmentType: string | null): string {
  if (content && content.trim().length > 0) return excerpt(content, REPLY_EXCERPT_MAX);
  if (attachmentType === 'image') return '📷 Photo';
  if (attachmentType === 'audio') return '🎤 Voice message';
  return '';
}

/**
 * The original's columns a thread reads beside each message, from `o` (the original, LEFT JOINed on the message's
 * reply_to_id) and `ou` (its writer). reply_id is null when the message answers nothing, or its original is gone.
 */
export const REPLY_COLUMNS = `o.id AS reply_id, LEFT(o.content, ${REPLY_EXCERPT_MAX}) AS reply_content, o.kind AS reply_kind,
        o.attachment_type AS reply_attachment_type, ou.display_name AS reply_name, ou.status AS reply_status`;

/** A thread row's reply columns (REPLY_COLUMNS, with the message's own reply_to_id). */
export interface ReplyColumns {
  reply_to_id: string | null;
  reply_id: string | null;
  reply_content: string | null;
  reply_kind: string | null;
  reply_attachment_type: string | null;
  reply_name: string | null;
  reply_status: string | null;
  /** Groups only: the reader may not see the original. */
  reply_hidden?: boolean | null;
}

/** The quote a message carries, or null when it answers nothing (every message from before migration 121). */
export function replyQuoteOf(row: ReplyColumns): MessageReplyQuote | null {
  if (!row.reply_to_id) return null;
  if (!row.reply_id) return { id: row.reply_to_id, senderName: '', content: '', kind: 'user', deleted: true };
  if (row.reply_hidden) return { id: row.reply_to_id, senderName: '', content: '', kind: 'user', deleted: false, hidden: true };
  return {
    id: row.reply_id,
    senderName: row.reply_status === 'active' ? (row.reply_name ?? '').trim() || 'Member' : FORMER_MEMBER,
    content: quotedText(row.reply_content, row.reply_attachment_type),
    kind: row.reply_kind === 'system' ? 'system' : 'user',
    deleted: false,
  };
}

/** The original as a send path looked it up (one row: o.id, o.content, o.kind, o.attachment_type, ou.display_name, ou.status). */
export interface OriginalRow {
  id: string;
  content: string | null;
  kind: string | null;
  attachment_type: string | null;
  display_name: string | null;
  status: string | null;
}

/** The quote of an original a writer has just answered. */
export function replyQuoteFromOriginal(o: OriginalRow): MessageReplyQuote {
  return replyQuoteOf({
    reply_to_id: o.id, reply_id: o.id, reply_content: o.content, reply_kind: o.kind,
    reply_attachment_type: o.attachment_type, reply_name: o.display_name, reply_status: o.status,
  }) as MessageReplyQuote;
}
