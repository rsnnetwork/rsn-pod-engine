// ─── The main room's tile grid fits the space it is given (15 Nov 2026) ─────
//
// 13 Nov field test: "fix the initial host view; participants should not need
// to scroll to find others". The main-room grid sized its tiles by width alone
// (16:9 at a fixed column count), the host's tile took a double 2 x 2 slot, and
// the grid ran past the bottom of the screen. The grid is now laid out from its
// measured area by a pure function (client/src/features/live/lobbyGrid.ts),
// imported here directly, plus the Lobby wiring that uses it.

import { readFileSync } from 'fs';
import path from 'path';
import {
  planLobbyGrid,
  lobbyGridExtent,
  lobbyMinCols,
  EMPHASIS_MIN_WIDTH,
  EMPHASIS_KEEP,
  LOBBY_GAP,
} from '../../../../client/src/features/live/lobbyGrid';
import { TILE_CAPS, type TileDensity } from '../../../../client/src/features/live/tileWindow';
import { TILE_ASPECT } from '../../../../client/src/features/live/meeting/liveLayout';

const DENSITIES: TileDensity[] = ['compact', 'normal', 'spacious'];
const COUNTS = [1, 2, 3, 5, 9, 12, 20];
// Grid areas: every window width the brief names (360 / 390 / 414 / 768 / 1024 / 1280) less the page padding, at
// heights from a short phone with the host bar open to a tall desktop, plus a phone on its side.
const AREA_WIDTHS = [336, 366, 390, 720, 976, 1232, 896];
const AREA_HEIGHTS = [180, 240, 300, 360, 420, 480, 560, 640, 760];

function slotsOf(cells: number, emphasized: number, span: 1 | 2): number {
  return span === 2 ? cells + 3 * emphasized : cells;
}

describe('planLobbyGrid: every tile fits, nothing overflows', () => {
  for (const density of DENSITIES) {
    for (const cells of COUNTS) {
      for (const emphasized of [0, 1, 2]) {
        if (emphasized > cells) continue;
        it(`${density}, ${cells} tile(s), ${emphasized} host(s): fits every area`, () => {
          for (const width of AREA_WIDTHS) {
            for (const height of AREA_HEIGHTS) {
              const grid = planLobbyGrid({ width, height, cells, emphasized, density });
              const extent = lobbyGridExtent(grid);
              const where = `${width}x${height}`;
              // The whole grid lies inside the area: it can never scroll.
              expect({ where, w: extent.w <= width, h: extent.h <= height }).toEqual({ where, w: true, h: true });
              // Every cell has a slot.
              expect(grid.cols * grid.rows).toBeGreaterThanOrEqual(slotsOf(cells, emphasized, grid.span));
              // Tiles keep the camera's 16:9 shape (whole pixels, rounded down).
              expect(grid.tileH).toBe(Math.floor(grid.tileW / TILE_ASPECT));
              // A real tile, not a sliver, at every size the brief names.
              expect(grid.tileW).toBeGreaterThan(40);
              expect(grid.gap).toBe(LOBBY_GAP[density]);
              // Two columns for every larger tile, so hosts sit side by side across the top rows.
              if (grid.span === 2) {
                expect(grid.cols).toBeGreaterThanOrEqual(2 * emphasized);
                expect(grid.rows).toBeGreaterThanOrEqual(2);
              }
            }
          }
        });
      }
    }
  }

  it('fits the tile cap of every density (the most tiles plus the "+N more" cell) at phone and desktop sizes', () => {
    for (const density of DENSITIES) {
      const phone = planLobbyGrid({ width: 336, height: 300, cells: TILE_CAPS[density].mobile + 1, emphasized: 1, density });
      const desk = planLobbyGrid({ width: 896, height: 480, cells: TILE_CAPS[density].desktop + 1, emphasized: 1, density });
      expect(lobbyGridExtent(phone).h).toBeLessThanOrEqual(300);
      expect(lobbyGridExtent(desk).h).toBeLessThanOrEqual(480);
      expect(lobbyGridExtent(desk).w).toBeLessThanOrEqual(896);
    }
  });

  it('sizes by height too: a short area gets more columns and smaller tiles, not a taller grid', () => {
    const tall = planLobbyGrid({ width: 896, height: 900, cells: 9, emphasized: 0, density: 'normal' });
    const short = planLobbyGrid({ width: 896, height: 300, cells: 9, emphasized: 0, density: 'normal' });
    expect(short.tileH).toBeLessThan(tall.tileH);
    expect(short.cols).toBeGreaterThanOrEqual(tall.cols);
    expect(lobbyGridExtent(short).h).toBeLessThanOrEqual(300);
  });

  it('has an empty area (before it is measured) give zero-size tiles, never negative ones', () => {
    const grid = planLobbyGrid({ width: 0, height: 0, cells: 5, emphasized: 1, density: 'normal' });
    expect(grid.tileW).toBe(0);
    expect(grid.tileH).toBe(0);
    expect(grid.span).toBe(1);
  });
});

describe('planLobbyGrid: the host tile', () => {
  it('is never drawn larger on a phone-width area, whatever the count or density', () => {
    for (const density of DENSITIES) {
      for (const cells of COUNTS) {
        for (const width of [336, 366, 390, EMPHASIS_MIN_WIDTH - 1]) {
          for (const height of AREA_HEIGHTS) {
            expect(planLobbyGrid({ width, height, cells, emphasized: 1, density }).span).toBe(1);
          }
        }
      }
    }
  });

  it('is drawn 2 x 2 on a desktop area when everyone else still keeps a fair size', () => {
    // The host's own view on a 1280 x 800 laptop: the grid area left under the host bar.
    const plain = planLobbyGrid({ width: 896, height: 398, cells: 9, emphasized: 0, density: 'normal' });
    const host = planLobbyGrid({ width: 896, height: 398, cells: 9, emphasized: 1, density: 'normal' });
    expect(host.span).toBe(2);
    expect(host.cols).toBeGreaterThanOrEqual(2);
    expect(host.tileW).toBeGreaterThanOrEqual(EMPHASIS_KEEP * plain.tileW);
  });

  it('stays the same size as everyone else when a larger host tile would shrink the others too much', () => {
    // Five people on a portrait tablet: a 2 x 2 host would cost the others more than a quarter of their width.
    const plain = planLobbyGrid({ width: 720, height: 622, cells: 5, emphasized: 0, density: 'normal' });
    const grid = planLobbyGrid({ width: 720, height: 622, cells: 5, emphasized: 1, density: 'normal' });
    expect(grid.span).toBe(1);
    expect(grid.tileW).toBe(plain.tileW);
  });

  it('stays the same size when there is only one other person (two equal tiles side by side)', () => {
    for (const [width, height] of [[1232, 560], [896, 635], [720, 859]]) {
      const grid = planLobbyGrid({ width, height, cells: 2, emphasized: 1, density: 'normal' });
      expect(grid.span).toBe(1);
      expect(grid.cols).toBe(2);
    }
  });

  it('is not drawn larger when the host is alone (nothing to stand out from)', () => {
    expect(planLobbyGrid({ width: 1232, height: 560, cells: 1, emphasized: 1, density: 'normal' }).span).toBe(1);
  });
});

describe('planLobbyGrid: density still means something', () => {
  it('keeps the minimum columns of each density (Bug 49: normal is not spacious on a phone)', () => {
    expect(lobbyMinCols('spacious', 9, true)).toBe(1);
    expect(lobbyMinCols('normal', 2, true)).toBe(2);
    expect(lobbyMinCols('normal', 1, true)).toBe(1);
    expect(lobbyMinCols('normal', 9, false)).toBe(2);
    expect(lobbyMinCols('compact', 9, true)).toBe(3);
    expect(lobbyMinCols('compact', 2, false)).toBe(2);
    const normal = planLobbyGrid({ width: 366, height: 420, cells: 2, emphasized: 0, density: 'normal' });
    const spacious = planLobbyGrid({ width: 366, height: 420, cells: 2, emphasized: 0, density: 'spacious' });
    expect(normal.cols).toBe(2);
    expect(spacious.cols).toBe(1);
  });

  it('gives spacious tiles at least as large as normal, and normal at least as large as compact', () => {
    for (const width of AREA_WIDTHS) {
      for (const height of AREA_HEIGHTS) {
        for (const cells of COUNTS) {
          const size = (density: TileDensity) => planLobbyGrid({ width, height, cells, emphasized: 0, density }).tileW;
          // The gaps differ, so allow a few pixels where both pick the same columns.
          expect(size('spacious') + 2 * LOBBY_GAP.spacious).toBeGreaterThanOrEqual(size('normal'));
          expect(size('normal') + 2 * LOBBY_GAP.normal).toBeGreaterThanOrEqual(size('compact'));
        }
      }
    }
  });
});

describe('Lobby wiring', () => {
  const src = readFileSync(path.resolve(__dirname, '../../../../client/src/features/live/Lobby.tsx'), 'utf8');
  const mosaic = src.slice(src.indexOf('function LobbyMosaic'), src.indexOf('const appliedPrefsForSid'));
  const lobby = src.slice(src.indexOf('export default function Lobby('), src.indexOf('function DensityToggle'));
  const panel = src.slice(src.indexOf('function HostParticipantPanel'), src.indexOf('function DeviceTest'));

  it('measures the grid area and lays the grid out from it', () => {
    expect(mosaic).toMatch(/const \[gridAreaRef, gridArea\] = useBoxSize<HTMLDivElement>\(\);/);
    expect(mosaic).toMatch(/planLobbyGrid\(\{\s*width: gridArea\.w,\s*height: gridArea\.h,/);
    expect(mosaic).toMatch(/ref=\{gridAreaRef\} data-testid="lobby-grid-area" className="flex-1 min-h-0 w-full flex items-center justify-center overflow-hidden"/);
    expect(mosaic).toMatch(/style=\{lobbyGridStyle\(grid\)\}/);
    // No width-only 16:9 tiles left in the grid, and no fixed column classes.
    expect(mosaic).not.toMatch(/gridCols|grid-cols-3 sm:grid-cols-5/);
  });

  it('draws a host 2 x 2 only when the planner says so', () => {
    expect(mosaic).toMatch(/frame: grid\.span === 2 && isLargeHostTile\(trackRef\) \? 'cell-large' : 'cell'/);
    expect(mosaic).toMatch(/'cell-large': 'h-full w-full col-span-2 row-span-2'/);
    expect(mosaic).not.toMatch(/aspect-video col-span-2 row-span-2/);
  });

  it('keeps the lobby column from scrolling, the round dashboard scrolling in its own bounded box', () => {
    expect(lobby).toMatch(/<div className="flex-1 min-h-0 flex flex-col items-center p-2 sm:p-6 gap-2 sm:gap-4 overflow-hidden bg-white">/);
    expect(lobby).not.toMatch(/overflow-auto bg-white/);
    expect(lobby).toMatch(/data-testid="lobby-extras" className="w-full max-w-4xl shrink-0 /);
    expect(lobby).toMatch(/max-h-\[30dvh\] overflow-y-auto overscroll-contain">\s*<HostRoundDashboard/);
    expect(lobby).toMatch(/className="flex-1 min-h-0 w-full max-w-4xl"/);
    // The density toggle and the host's participant count share one row.
    expect(lobby).toMatch(/<DensityToggle \/>\s*\{isHost && <HostParticipantPanel sessionId=\{sessionId\} \/>\}/);
  });

  it('starts the host participant list collapsed, with a 44px header, and opens it over the room', () => {
    expect(panel).toMatch(/const \[expanded, setExpanded\] = useState\(false\);/);
    expect(panel).toMatch(/aria-expanded=\{expanded\}/);
    expect(panel).toMatch(/min-h-\[44px\]/);
    // A dropdown (absolute), bounded and scrolling in itself: it never pushes the grid.
    expect(panel).toMatch(/data-testid="host-participant-list"\s+className="absolute right-0 top-full z-30 [^"]*max-h-\[50dvh\] overflow-y-auto/);
    expect(panel).toMatch(/useEscapeKey\(collapse, expanded\)/);
  });

  it("moves the viewer's own controls to a bar under the grid when their tile is too small for them", () => {
    expect(src).toMatch(/function selfControlsFitTile\(w: number, h: number, isHost: boolean, phone: boolean\): boolean \{/);
    expect(mosaic).toMatch(/\{isLocal && controlsInTile \? \(/);
    expect(mosaic).toMatch(/controlsInTile: selfControlsInTile,/);
    expect(mosaic).toMatch(/\{!selfControlsInTile && selfControlsBar\}/);
    expect(mosaic).toMatch(/data-testid="lobby-self-controls"/);
  });
});
