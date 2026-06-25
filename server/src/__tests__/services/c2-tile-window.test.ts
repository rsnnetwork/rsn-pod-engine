// VID-2 (audit C2) — pure tile-windowing logic. Caps rendered video tiles by
// density × viewport so a 50-person lobby never mounts 50 <video> decoders on
// one client; the rest collapse into a "+N more" overflow. Direct client-module
// import (same pattern as bg-engine-core.test.ts).

import { computeTileWindow, TILE_CAPS } from '../../../../client/src/features/live/tileWindow';

type Tr = { sid: string };
const tracks = (n: number, prefix = 's'): Tr[] => Array.from({ length: n }, (_, i) => ({ sid: `${prefix}${i}` }));
const sidOf = (t: Tr) => t.sid;

describe('VID-2 — computeTileWindow', () => {
  it('under/at cap returns the SAME array reference and overflow 0 (no behavior change)', () => {
    const t = tracks(20);
    const r = computeTileWindow({ tracks: t, density: 'normal', isMobile: false, localSid: null, sidOf });
    expect(r.visible).toBe(t);           // same reference
    expect(r.overflowCount).toBe(0);
  });

  it('honors each density × viewport cap', () => {
    for (const density of ['compact', 'normal', 'spacious'] as const) {
      for (const isMobile of [true, false]) {
        const cap = TILE_CAPS[density][isMobile ? 'mobile' : 'desktop'];
        const r = computeTileWindow({ tracks: tracks(cap + 10), density, isMobile, localSid: null, sidOf });
        expect(r.visible.length).toBe(cap);
        expect(r.overflowCount).toBe(10);
      }
    }
  });

  it('overflow math: 50 tracks, normal/mobile → 9 visible + 41 overflow', () => {
    const r = computeTileWindow({ tracks: tracks(50), density: 'normal', isMobile: true, localSid: null, sidOf });
    expect(r.visible.length).toBe(9);
    expect(r.overflowCount).toBe(41);
  });

  it('keeps the local self-view rendered even when it sorts past the cap', () => {
    const t = tracks(50);
    const localSid = t[40].sid; // beyond the normal/mobile cap of 9
    const r = computeTileWindow({ tracks: t, density: 'normal', isMobile: true, localSid, sidOf });
    expect(r.visible.length).toBe(9);
    expect(r.visible.some(x => x.sid === localSid)).toBe(true); // swapped into the last slot
    expect(r.overflowCount).toBe(41);                            // count unchanged
  });

  it('local already within the window is untouched', () => {
    const t = tracks(50);
    const localSid = t[2].sid;
    const r = computeTileWindow({ tracks: t, density: 'normal', isMobile: true, localSid, sidOf });
    expect(r.visible.slice(0, 9).map(sidOf)).toEqual(t.slice(0, 9).map(sidOf)); // unchanged order
  });

  it('empty input → empty window, overflow 0', () => {
    const r = computeTileWindow({ tracks: [], density: 'normal', isMobile: false, localSid: 'x', sidOf });
    expect(r.visible).toEqual([]);
    expect(r.overflowCount).toBe(0);
  });
});
