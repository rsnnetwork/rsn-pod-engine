// client/src/components/chat/emoji.ts
// The emojis the message boxes offer, and how one goes into the words being typed (30 Oct 2026 review, item 4.6, L9).
// Pure on purpose (no React), so a test can run it: server/src/__tests__/client/t6-messaging.test.ts.
//
// One list for every message box: the one-to-one and group threads and the live event's chat. It was kept twice, in
// MessagesPage and in the live ChatPanel.
export const EMOJI_PICKER_LIST = [
  '😀', '😂', '😍', '🥳', '🤔', '👍', '👏', '❤️', '🔥', '🎉',
  '💯', '🙌', '😮', '🤩', '😎', '👋', '✅', '💪', '🙏', '⭐',
] as const;

export interface Inserted {
  value: string;
  /** Where the caret goes: just after the emoji. */
  caret: number;
}

/**
 * The words with the emoji put where the caret is (replacing any selection), and where the caret goes next. With no
 * caret known (null), at the end. Several picks in a row run on from each other.
 */
export function insertAtCaret(value: string, start: number | null, end: number | null, emoji: string): Inserted {
  const from = start === null ? value.length : Math.max(0, Math.min(start, value.length));
  const to = end === null ? from : Math.max(from, Math.min(end, value.length));
  return { value: value.slice(0, from) + emoji + value.slice(to), caret: from + emoji.length };
}

/** The words with the emoji added, if the result still fits the box's limit; otherwise nothing changes. */
export function insertWithin(value: string, start: number | null, end: number | null, emoji: string, maxLength: number): Inserted | null {
  const next = insertAtCaret(value, start, end, emoji);
  return next.value.length > maxLength ? null : next;
}

/**
 * Whether an Enter belongs to an input method still choosing a word (Japanese, Chinese, Korean): there it picks the
 * word, and must never send. Safari sends the Enter that confirms the word after composition has ended, with keyCode
 * 229, so isComposing alone misses it (P22, 26 Oct 2026).
 */
export function isComposingEnter(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}
