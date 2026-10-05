import { clip, clipAtWord } from '../../../services/people/text';

// A lone surrogate is half of an emoji. It is not valid text and shows as a replacement mark.
// Encoding to UTF-8 and back turns each one into U+FFFD, so a well-formed string survives it unchanged.
const isWellFormed = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s)) === s;
const characters = (s: string) => Array.from(s).length;

describe('clip', () => {
  it('turns blank text into null', () => {
    expect(clip('')).toBeNull();
    expect(clip('   ')).toBeNull();
    expect(clip('\n\t ')).toBeNull();
    expect(clip(null)).toBeNull();
    expect(clip(undefined)).toBeNull();
  });

  it('returns a short text as it is, trimmed', () => {
    expect(clip('  abc  ', 10)).toBe('abc');
    expect(clip('abc', 3)).toBe('abc'); // exactly the limit: nothing is cut
  });

  it('cuts a long text to exactly max characters, ending in an ellipsis', () => {
    expect(clip('a'.repeat(200), 20)).toBe(`${'a'.repeat(19)}…`);
    expect(clip('abcdef', 4)).toBe('abc…');
  });

  it('allows 160 characters unless told otherwise', () => {
    expect(clip('a'.repeat(160))).toBe('a'.repeat(160));
    expect(clip('a'.repeat(161))).toBe(`${'a'.repeat(159)}…`);
  });

  it('counts what a person sees: an emoji is one character, and a cut never lands inside it', () => {
    // 'abc😀def' is 7 characters but 8 UTF-16 units. A cut by unit at 4 leaves "abc" and the first
    // half of the emoji.
    const straddling = clip('abc😀def', 5)!;
    expect(straddling).toBe('abc😀…');
    expect(isWellFormed(straddling)).toBe(true);
    expect(characters(straddling)).toBe(5);

    // Emoji only: every cut point is between two emoji, and the length is in characters.
    const faces = clip('😀'.repeat(10), 5)!;
    expect(faces).toBe('😀😀😀😀…');
    expect(isWellFormed(faces)).toBe(true);
    expect(characters(faces)).toBe(5);

    // An emoji that sits just past the cut is dropped whole, not halved.
    expect(clip('abcd😀ef', 5)).toBe('abcd…');

    // Short enough in characters, though longer in units: left alone.
    expect(clip('😀😀😀', 3)).toBe('😀😀😀');
  });

  it('gives back nothing when max leaves no room, never the whole text', () => {
    expect(clip('abc', 0)).toBeNull();
    expect(clip('abc', -5)).toBeNull();
    expect(clip('abc', Number.NaN)).toBeNull();
    expect(clip('abc', 0.5)).toBeNull();
  });

  it('with room for one character, shows the ellipsis for a longer text and the character itself when it fits', () => {
    expect(clip('abc', 1)).toBe('…');
    expect(clip('😀😀', 1)).toBe('…');
    expect(clip('a', 1)).toBe('a');
  });

  it('rounds a fractional max down, and treats an infinite one as no limit', () => {
    expect(clip('abcdefgh', 4.9)).toBe('abc…');
    expect(clip('a'.repeat(500), Infinity)).toBe('a'.repeat(500));
  });
});

describe('clipAtWord', () => {
  it('turns blank text into null and leaves a text that fits as it is, trimmed', () => {
    expect(clipAtWord('   ')).toBeNull();
    expect(clipAtWord(null)).toBeNull();
    expect(clipAtWord('  alpha beta  ', 10)).toBe('alpha beta');
  });

  it('cuts between words, so it never ends in half a word', () => {
    // 12 characters allowed: "one two thr" would be half of "three".
    expect(clipAtWord('one two three four', 12)).toBe('one two…');
    // The cut falls exactly on a space: all of "alpha beta" fits with the ellipsis, 11 in all.
    expect(clipAtWord('alpha beta gamma', 11)).toBe('alpha beta…');
    // The last character kept is a space.
    expect(clipAtWord('alpha beta gamma', 12)).toBe('alpha beta…');
  });

  it('never goes over max characters, and keeps as many whole words as fit', () => {
    const text = 'Fatima is looking to meet investors and angels for her seed round in Karachi';
    for (let max = 1; max < Array.from(text).length; max++) {
      const out = clipAtWord(text, max)!;
      expect(characters(out)).toBeLessThanOrEqual(max);
      expect(out.endsWith('…')).toBe(true);
      // Without the ellipsis it is the start of the text and the next character is a space: whole words only...
      const head = out.slice(0, -1);
      if (max >= 8) {
        expect(text.startsWith(head)).toBe(true);
        expect(text[head.length]).toBe(' ');
        // ...as many as fit: the next word would not have.
        const nextWord = /^\s+\S+/.exec(text.slice(head.length))![0];
        expect(characters(head + nextWord) + 1).toBeGreaterThan(max);
      }
    }
  });

  it('drops a dash, comma or colon left hanging before the ellipsis', () => {
    expect(clipAtWord('meet investors — you are an investor', 18)).toBe('meet investors…');
    expect(clipAtWord('founders, investors, angels', 16)).toBe('founders…');
    expect(clipAtWord('who I want to meet: founders', 20)).toBe('who I want to meet…');
  });

  it('cuts inside the word when the first word alone is longer than max', () => {
    expect(clipAtWord('supercalifragilistic is long', 10)).toBe('supercali…');
  });

  it('counts characters a person sees, and never cuts an emoji in half', () => {
    // The emoji run is one word to the cut, so it goes whole or not at all.
    expect(clipAtWord('hello 😀😀😀 world', 9)).toBe('hello…');
    const out = clipAtWord('😀😀😀😀😀😀', 4)!;
    expect(out).toBe('😀😀😀…');
    expect(isWellFormed(out)).toBe(true);
  });

  it('gives back nothing when max leaves no room, and an ellipsis alone when there is room for one character', () => {
    expect(clipAtWord('alpha beta', 0)).toBeNull();
    expect(clipAtWord('alpha beta', -3)).toBeNull();
    expect(clipAtWord('alpha beta', Number.NaN)).toBeNull();
    expect(clipAtWord('alpha beta', 1)).toBe('…');
    expect(clipAtWord('a', 1)).toBe('a');
  });
});
