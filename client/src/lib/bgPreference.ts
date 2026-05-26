// Persists the user's background-effect choice so it follows them across room
// transitions (main → breakout → main) and survives a page refresh, until they
// explicitly pick "Off". The hook (useBackgroundEffects) re-applies it whenever
// the camera publishes.
//
// Storage: localStorage (survives refresh, which RSN clients do constantly
// mid-event). Custom uploads are blob: URLs created with URL.createObjectURL —
// those die on a full reload, so a persisted custom image falls back to Off
// after a hard refresh (the blob no longer exists). Blur and preset images
// (same-origin static URLs) survive refresh fine.

const KEY = 'rsn_bg_preference';

export type BgPreference =
  | { mode: 'disabled' }
  | { mode: 'blur' }
  | { mode: 'image'; imageUrl: string };

export function saveBgPreference(pref: BgPreference): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
  } catch {
    // storage unavailable (private mode / quota) — degrade to in-memory only.
  }
}

export function loadBgPreference(): BgPreference | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.mode === 'disabled') return { mode: 'disabled' };
    if (parsed?.mode === 'blur') return { mode: 'blur' };
    if (parsed?.mode === 'image' && typeof parsed?.imageUrl === 'string') {
      // A blob: URL from a previous tab session is dead after reload — ignore it.
      if (parsed.imageUrl.startsWith('blob:')) return null;
      return { mode: 'image', imageUrl: parsed.imageUrl };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearBgPreference(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
