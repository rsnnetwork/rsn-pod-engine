// Issue 10 (20 May Stefan) — "Background does not persist between main
// room and breakout room." Each component (Lobby's LobbyMediaControls,
// VideoRoom's MediaControls) previously held its own local React state
// for bgMode that defaulted to 'disabled' on mount. Switching main →
// breakout unmounts Lobby and mounts a fresh VideoRoom whose camera
// track has no processor. This module persists the user's last choice
// to sessionStorage and re-applies it on every mount where a camera
// track exists.
//
// Scope: same browser tab session. A full reload of the page clears
// sessionStorage; the user gets a clean 'disabled' state, which is the
// expected fresh-session behaviour.
//
// Custom uploads: blob URLs from URL.createObjectURL survive same-tab
// navigation (the blob stays alive until the tab unloads), so the saved
// URL keeps working across the main↔breakout transition. After a full
// reload the blob is gone and the apply call fails harmlessly — falls
// back to 'disabled'.
import { Track } from 'livekit-client';

const KEY = 'rsn_bg_preference';

export type BgPreference =
  | { mode: 'disabled' }
  | { mode: 'blur' }
  | { mode: 'image'; imageUrl: string };

export function saveBgPreference(pref: BgPreference): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(pref));
  } catch {
    // sessionStorage may be unavailable (private mode, quota); silent
    // fallback — feature degrades to in-memory only.
  }
}

export function loadBgPreference(): BgPreference | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.mode === 'disabled') return { mode: 'disabled' };
    if (parsed?.mode === 'blur') return { mode: 'blur' };
    if (parsed?.mode === 'image' && typeof parsed?.imageUrl === 'string') {
      return { mode: 'image', imageUrl: parsed.imageUrl };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearBgPreference(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

interface BgProcessorMod {
  BackgroundBlur: (radius: number) => any;
  VirtualBackground: (url: string) => any;
}

// Apply a persisted preference to the LIVE LocalParticipant's camera
// track. Called on mount once the participant + camera publication are
// ready. Times out at 8s so a hung WASM worker can't freeze the caller.
// On any failure the preference is left as-is (next mount retries).
export async function applyBgPreference(
  localParticipant: { trackPublications: Map<string, any> | { values(): IterableIterator<any> } },
  mod: BgProcessorMod | null,
  pref: BgPreference,
): Promise<void> {
  if (!mod) return;
  const withTimeout = <T,>(p: Promise<T>, ms = 8000): Promise<T> =>
    Promise.race<T>([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error('bg_processor_timeout')), ms),
      ),
    ]);
  try {
    const publications = Array.from((localParticipant.trackPublications as any).values());
    const camPub = publications.find((p: any) => p.source === Track.Source.Camera);
    const camTrack = (camPub as any)?.track;
    if (!camTrack) return;
    await withTimeout(camTrack.stopProcessor?.() ?? Promise.resolve(), 5000).catch(() => {});
    if (pref.mode === 'disabled') return;
    if (pref.mode === 'blur') {
      await withTimeout(camTrack.setProcessor(mod.BackgroundBlur(25)));
      return;
    }
    if (pref.mode === 'image') {
      await withTimeout(camTrack.setProcessor(mod.VirtualBackground(pref.imageUrl)));
    }
  } catch (err) {
    console.error('Failed to apply persisted bg preference:', err);
  }
}
