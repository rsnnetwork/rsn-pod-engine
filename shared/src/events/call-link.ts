// ─── The RSN Call link (Part 2 foundation, Task 6; spec 04) ─────────────────────────────────────────
//
// Every event has one link anyone can open: they verify their email with a 6-digit code, give only what that
// event still needs, and enter. The link carries a call code: 10 symbols from a 32-symbol alphabet (50 bits from
// the operating system's random source), lower-case, with no i, l, o or u so it reads aloud and types without
// mistakes. The server stores it in sessions.call_code (migration 139); an organiser can rotate it, and the old
// link then stops working at once.

/**
 * Where the link lives on the client. Provisional naming: Stefan still has to confirm it. Change it only here; the
 * server's emails and the client's router both read this constant.
 */
export const CALL_LINK_BASE_PATH = '/call';

/** The 32 symbols a call code is written in: digits and lower-case letters, without i, l, o and u. */
export const CALL_CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** How many symbols a call code has (10 x 5 bits = 50 bits). */
export const CALL_CODE_LENGTH = 10;

/** The client path of an event's call link, e.g. '/call/k7m2x9q4ra'. */
export function callLinkPath(code: string): string {
  return `${CALL_LINK_BASE_PATH}/${code}`;
}

/** The most characters the name someone gives on the link's details step may have. */
export const CALL_DISPLAY_NAME_MAX = 60;

/**
 * The name given on the details step, as it is stored, or null when it cannot be one: trimmed, runs of spaces made one,
 * 1 to CALL_DISPLAY_NAME_MAX characters, and no control characters or angle brackets (a name is shown to other people).
 * Invisible characters that can disguise a name (zero-width marks, the byte-order mark and the bidirectional controls,
 * isInvisibleInName) are taken out first, so a name cannot pass for someone else's or be made of nothing.
 */
export function cleanCallDisplayName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let out = '';
  let space = false;
  for (const ch of raw.trim()) {
    const code = ch.codePointAt(0) ?? 0;
    if (isInvisibleInName(code)) continue;
    if (code < 0x20 || code === 0x7f || ch === '<' || ch === '>') return null;
    if (code === 0x20 || code === 0xa0) {
      space = true;
      continue;
    }
    if (space && out.length > 0) out += ' ';
    space = false;
    out += ch;
  }
  return out.length >= 1 && [...out].length <= CALL_DISPLAY_NAME_MAX ? out : null;
}

/**
 * Zero-width space, non-joiner and joiner, the left-to-right and right-to-left marks (U+200B to U+200F), the line and
 * paragraph separators (U+2028, U+2029), the embeddings and overrides (U+202A to U+202E), the word joiner and invisible
 * operators (U+2060 to U+2064), the isolates (U+2066 to U+2069), the Arabic letter mark (U+061C), the Hangul fillers that
 * draw as blank (U+115F, U+1160, U+3164, U+FFA0) and the byte-order mark (U+FEFF).
 */
const INVISIBLE_SINGLES: ReadonlySet<number> = new Set([0x061c, 0x115f, 0x1160, 0x3164, 0xffa0, 0xfeff]);

function isInvisibleInName(code: number): boolean {
  return (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064)
    || (code >= 0x2066 && code <= 0x2069) || INVISIBLE_SINGLES.has(code);
}

/** The longest text normaliseCallCode reads: a code with a separator between every symbol, and a little more. */
const CALL_CODE_RAW_MAX = 40;

/**
 * A call code as typed or pasted, in its stored form, or null when it cannot be one. Lower-cases it, drops spaces
 * and dashes, reads 'o' as '0' and 'i' or 'l' as '1' (the symbols people confuse), then checks its length and that
 * every symbol is in the alphabet.
 */
export function normaliseCallCode(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > CALL_CODE_RAW_MAX) return null;
  let out = '';
  for (const ch of raw.toLowerCase()) {
    if (ch === ' ' || ch === '-') continue;
    const mapped = ch === 'o' ? '0' : ch === 'i' || ch === 'l' ? '1' : ch;
    if (!CALL_CODE_ALPHABET.includes(mapped)) return null;
    out += mapped;
  }
  return out.length === CALL_CODE_LENGTH ? out : null;
}
