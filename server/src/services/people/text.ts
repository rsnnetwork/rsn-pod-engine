import { clip as sharedClip } from '@rsn/shared';

/**
 * Trimmed text shortened to at most `max` characters, or null when there is nothing to show (code points, never
 * half an emoji; see @rsn/shared). It lives in @rsn/shared since 21 Oct 2026, so a page shows a member's answer by
 * the very rule the server uses, and is handed on here unchanged for the server code that imports it from this module.
 */
export const clip = sharedClip;

const isSpace = (character: string) => /\s/.test(character);

/**
 * Like clip, but a text that has to be cut is cut between words, so it never
 * ends in half a word. It keeps as many whole words as fit, with the ellipsis,
 * in at most `max` characters, and drops a dash, comma or colon left hanging
 * before the ellipsis. A first word longer than `max` has no earlier break, so
 * it is cut inside the word, as clip does. Blank, `max` and characters are
 * handled as in clip.
 */
export function clipAtWord(text: string | null | undefined, max = 160): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const limit = Math.floor(max);
  if (!(limit >= 1)) return null;
  const characters = Array.from(t);
  if (characters.length <= limit) return t;

  const kept = characters.slice(0, limit - 1);
  let end = kept.length;
  const cutsAWord = end > 0 && !isSpace(characters[end]) && !isSpace(kept[end - 1]);
  if (cutsAWord) {
    const lastSpace = kept.map(isSpace).lastIndexOf(true);
    if (lastSpace > 0) end = lastSpace;
  }
  return `${kept.slice(0, end).join('').replace(/[\s,;:(–—-]+$/, '')}…`;
}
