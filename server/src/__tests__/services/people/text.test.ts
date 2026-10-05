import { clip } from '../../../services/people/text';

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
