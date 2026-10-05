/**
 * Trimmed text shortened to at most `max` characters, or null when there is
 * nothing to show.
 *
 * A character here is a code point (what `Array.from` yields), not a UTF-16
 * unit: cutting by unit can land inside an emoji and leave half of it, which
 * shows as a replacement mark. A text longer than `max` keeps its first
 * `max - 1` characters and ends in an ellipsis, so the result is exactly `max`
 * characters long.
 *
 * `max` is rounded down. Below 1 there is no room for even the ellipsis, so the
 * answer is null, the same "nothing to show" a blank text gets, and never the
 * whole text. NaN counts as below 1.
 */
export function clip(text: string | null | undefined, max = 160): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const limit = Math.floor(max);
  if (!(limit >= 1)) return null;
  const characters = Array.from(t);
  if (characters.length <= limit) return t;
  return `${characters.slice(0, limit - 1).join('')}…`;
}
