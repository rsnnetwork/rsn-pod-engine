// Persists the user's background-effect choice so it survives a page refresh
// (which RSN clients do constantly mid-event). Within an event, persistence is
// structural — the event-scoped engine (lib/bgEngine) keeps one processed
// camera track alive across every room; this localStorage pref only seeds the
// engine on boot/refresh.
//
// Custom uploads persist as the CUSTOM_BG_URL sentinel ('idb://custom-bg');
// the engine rehydrates the image bytes from IndexedDB (lib/bgUploadStore).
// Raw blob: URLs from a previous tab session are dead after reload — ignored.

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
