// VID-2 (audit C2) — pure tile-windowing logic for the lobby mosaic. Caps how
// many video tiles are RENDERED (and therefore decoded + laid out) by density
// and viewport, so a 50-person room never mounts 50 <video> elements + 50
// overlay subtrees on one client. The remainder collapses into a single
// "+N more" overflow tile. No React/LiveKit imports — unit-testable directly.

export const TILE_CAPS = {
  compact:  { mobile: 12, desktop: 30 },
  normal:   { mobile: 9,  desktop: 20 },
  spacious: { mobile: 4,  desktop: 8  },
} as const;

export type TileDensity = keyof typeof TILE_CAPS;

interface TileWindowArgs<T> {
  tracks: T[];
  density: TileDensity;
  isMobile: boolean;
  /** sid of the local participant — its self-view is always kept on screen. */
  localSid: string | null;
  sidOf: (t: T) => string;
}

/**
 * Returns the deterministic, order-preserving window of tiles to render plus a
 * count of those hidden in the "+N more" overflow.
 *
 * - At or under the cap: returns the SAME array reference and overflowCount 0
 *   (zero behavior change vs. today — no extra re-render under cap).
 * - Over the cap: the first `cap` tracks (the caller's priority sort already put
 *   director/hosts/local first). As a safety net, if the local participant got
 *   bumped past the cap, its track replaces the last visible slot so a user is
 *   never missing from their own screen.
 */
export function computeTileWindow<T>({
  tracks,
  density,
  isMobile,
  localSid,
  sidOf,
}: TileWindowArgs<T>): { visible: T[]; overflowCount: number } {
  const cap = TILE_CAPS[density][isMobile ? 'mobile' : 'desktop'];
  if (tracks.length <= cap) return { visible: tracks, overflowCount: 0 };
  const visible = tracks.slice(0, cap);
  if (localSid && !visible.some(t => sidOf(t) === localSid)) {
    const local = tracks.find(t => sidOf(t) === localSid);
    if (local) visible[visible.length - 1] = local;
  }
  return { visible, overflowCount: tracks.length - visible.length };
}
