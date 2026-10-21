// ─── A member's own words, as a page shows them (21 Oct 2026) ────────────────
// One rule, used where another member reads an answer (the Human Profile brief, on the server) and where the member
// sees their own profile "the way others see it" (the client), so the two can never show the same answer differently.
// clip moved here from server/src/services/people/text.ts, which hands it on unchanged; usableAnswer moved here
// from the person brief.

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

/**
 * An answer worth showing, as a page shows it: clipped to 160 characters, and only when what is left has a letter or
 * a digit in it. A member who types ".", "…" or "!!!" to get past a box has given no answer, and after a colon it
 * reads as a mistake. It counts as blank, so the reading goes on to the member's next field.
 */
export function usableAnswer(text: string | null | undefined): string | null {
  const shown = clip(text);
  return shown && /[\p{L}\p{N}]/u.test(shown) ? shown : null;
}

/** What a member can bring, as their profile shows it to others: what they can help with, else their expertise. */
export function canBring(member: { whatICanHelpWith?: string | null; expertiseText?: string | null } | null | undefined): string | null {
  return usableAnswer(member?.whatICanHelpWith) ?? usableAnswer(member?.expertiseText);
}
