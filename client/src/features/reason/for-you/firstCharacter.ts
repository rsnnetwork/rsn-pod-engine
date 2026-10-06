// The character a person sees first in a name, for a round initial. A flag, a family or a hand with a skin
// tone is one character to a reader and several code points to JavaScript, so a name is cut at a grapheme:
// Intl.Segmenter does that, and every current browser has it. Where one does not, the first code point is the
// best that can be done: a letter or a plain emoji is still whole, a flag or a family is not.
//
// Pure on purpose (no store, router or axios), so a test can run it.

/** The part of Intl.Segmenter this needs. The library types this project builds with stop at ES2020. */
interface Graphemes { segment(text: string): Iterable<{ segment: string }> }

const defaultSegmenter: Graphemes | null = (() => {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locales?: string, options?: { granularity: 'grapheme' }) => Graphemes }).Segmenter;
  return Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
})();

/** The upper-case first character of `text`, spaces ignored; '' for nothing. `segmenter` is only for a test to pass `null`. */
export function firstCharacter(text: string, segmenter: Graphemes | null = defaultSegmenter): string {
  const trimmed = text.trim();
  const first: string | undefined = segmenter ? segmenter.segment(trimmed)[Symbol.iterator]().next().value?.segment : Array.from(trimmed)[0];
  return (first ?? '').toUpperCase();
}
