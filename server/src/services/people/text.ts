/** Trimmed text shortened to `max` characters (with an ellipsis), or null when blank. */
export function clip(text: string | null | undefined, max = 160): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
