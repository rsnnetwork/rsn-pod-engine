// ─── Entity fields as they are stored (21 Oct 2026) ──────────────────────────
// The routes run these inside their Zod schemas, and the service runs the name through again,
// because the one-active-entity-per-name check depends on it.

/**
 * An entity's name as stored: outer spaces trimmed and every run of spaces inside made one, so
 * "Acme  Ltd" and "Acme Ltd" are one name to the unique index (which also ignores case).
 */
export function normaliseName(typed: string): string {
  return typed.replace(/\s+/g, ' ').trim();
}

/**
 * How many characters a name has, counted as the database counts them (length() and VARCHAR(200) count
 * characters). A string's .length counts UTF-16 units, so one emoji or one rare Chinese character counts 2:
 * a name of just one of them passed a .length check of "at least 2" and the database refused it.
 */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Optional text as stored: trimmed, and an answer with nothing in it is null. */
export function blankToNull(typed: string | null): string | null {
  const text = typed?.trim() ?? '';
  return text === '' ? null : text;
}

// A scheme is letters, digits, + and - before a colon. A dot before the colon makes it a host with a
// port ("acme.com:8080"), which gets https:// like any bare address.
const HAS_SCHEME = /^[a-z][a-z0-9+-]*:/i;

/**
 * A website as stored, or null when what was typed is not a web address. The client renders it as a
 * link, so only http and https are kept: `javascript:` and every other scheme are refused. A bare
 * address ("acme.com") gets https:// in front. It must name a real host (one with a dot in it), carry
 * no user name or password, and hold no spaces.
 */
export function normaliseWebsite(typed: string): string | null {
  const text = typed.trim();
  if (text === '' || /\s/.test(text)) return null;
  const address = HAS_SCHEME.test(text) ? text : `https://${text.replace(/^\/+/, '')}`;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.') || url.username !== '' || url.password !== '') return null;
  return address;
}
