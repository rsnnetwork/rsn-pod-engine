// ─── The main room's tile grid, as geometry (15 Nov 2026) ──────────────────────
//
// On 13 Nov a tester found the host's first view of the main room scrolled:
// tiles were sized by the grid's width alone (16:9 at a fixed column count),
// the host's own tile took a double 2 x 2 slot, and with a few people in the
// room the grid ran past the bottom of a phone, and past ~750px on a computer,
// so participants had to scroll to find each other. The main room now lays its
// tiles out from the grid area's own measured size, the way the video-meeting
// stage does (meeting/liveLayout.ts, whose fitGrid this reuses): every tile in
// the tile window is on screen and the grid never scrolls. Pure functions, no
// React and no LiveKit: the server's jest imports this file directly
// (server/src/__tests__/client/lobby-grid-fit.test.ts).

import { fitGrid, TILE_ASPECT, type StageGrid } from './meeting/liveLayout';
import type { TileDensity } from './tileWindow';

/** Space between tiles at each density, in px (the gap-1.5 / gap-3 / gap-6 the grid had before). */
export const LOBBY_GAP: Record<TileDensity, number> = { compact: 6, normal: 12, spacious: 24 };

/** Below this grid width (a phone) nobody's tile is drawn larger: a double tile there pushes everyone else down. */
export const EMPHASIS_MIN_WIDTH = 640;

/**
 * A host's tile is drawn 2 x 2 only when everyone else's tile keeps at least this share of the width it would have
 * with no larger tile; otherwise every tile is the same size.
 */
export const EMPHASIS_KEEP = 0.75;

/** A larger host tile needs at least two other tiles beside it; with only one, two equal tiles read better. */
export const EMPHASIS_MIN_OTHERS = 2;

export interface LobbyGridInput {
  /** The grid area's inner size, in px. */
  width: number;
  height: number;
  /** Cells to place: the tiles in the tile window plus the "+N more" cell when there is one. */
  cells: number;
  /** How many of the leading cells are acting hosts who may be drawn larger (2 x 2). */
  emphasized: number;
  density: TileDensity;
  /** The tiles' shape; 16:9, a webcam's, unless a test says otherwise. */
  aspect?: number;
}

export interface LobbyGrid extends StageGrid {
  /** Space between tiles, in px. */
  gap: number;
  /** 2 when the leading `emphasized` cells each span two columns and two rows; 1 when every tile is the same size. */
  span: 1 | 2;
}

/**
 * The fewest columns each density asks for, so the three stay visibly different (Bug 49, 19 May: normal and
 * spacious looked the same on a phone): spacious takes the largest tiles that fit, normal puts two people side by
 * side from two up, compact packs three or more across (four or five on a wider grid). A bias only: every candidate
 * fits, so none of them can make the grid overflow, and above the minimum the largest tiles win.
 */
export function lobbyMinCols(density: TileDensity, cells: number, narrow: boolean): number {
  const n = Math.max(1, Math.floor(cells));
  const wanted = density === 'spacious'
    ? 1
    : density === 'compact'
      ? (narrow ? 3 : n <= 4 ? 4 : 5)
      : 2;
  return Math.min(wanted, n);
}

/** The largest-tile grid among `fromCols`..`toCols` columns, `rowsFor(cols)` rows each; ties keep fewer columns. */
function bestGrid(
  width: number, height: number, fromCols: number, toCols: number,
  rowsFor: (cols: number) => number, gap: number, aspect: number,
): StageGrid | null {
  let best: StageGrid | null = null;
  for (let cols = fromCols; cols <= toCols; cols++) {
    const candidate = fitGrid(width, height, cols, rowsFor(cols), gap, aspect);
    if (!best || candidate.tileW > best.tileW) best = candidate;
  }
  return best;
}

/**
 * The main room's grid for this area: columns, rows and one tile size, so the whole grid fits inside width x height.
 * With hosts at the front it tries drawing each 2 x 2 (they sit side by side in the top two rows, the others fill
 * around and below them), and keeps that only on a wide area and only when the others keep EMPHASIS_KEEP of their
 * size; on a phone every tile is the same size.
 */
export function planLobbyGrid({ width, height, cells, emphasized, density, aspect = TILE_ASPECT }: LobbyGridInput): LobbyGrid {
  const n = Math.max(1, Math.floor(cells));
  const gap = LOBBY_GAP[density];
  const minCols = lobbyMinCols(density, n, width < EMPHASIS_MIN_WIDTH);
  const plain = bestGrid(width, height, minCols, n, (cols) => Math.ceil(n / cols), gap, aspect)
    ?? fitGrid(width, height, n, 1, gap, aspect);
  const flat: LobbyGrid = { ...plain, gap, span: 1 };

  const k = Math.max(0, Math.min(Math.floor(emphasized), n));
  if (k === 0 || n - k < EMPHASIS_MIN_OTHERS || width < EMPHASIS_MIN_WIDTH) return flat;
  // Each larger tile takes four cells. With at least 2k columns the hosts sit side by side across the top two rows
  // and the grid's own placement fills every cell around them, so the slots are exactly n + 3k. The widest useful
  // row is the hosts plus everyone else in it: n + k columns.
  const slots = n + 3 * k;
  const larger = bestGrid(width, height, Math.max(2 * k, minCols), n + k, (cols) => Math.max(2, Math.ceil(slots / cols)), gap, aspect);
  if (!larger || larger.tileW <= 0 || larger.tileW < EMPHASIS_KEEP * plain.tileW) return flat;
  return { ...larger, gap, span: 2 };
}

/** The grid's own width and height in px: the tracks it lays out and the gaps between them. */
export function lobbyGridExtent({ cols, rows, tileW, tileH, gap }: LobbyGrid): { w: number; h: number } {
  return { w: cols * tileW + Math.max(0, cols - 1) * gap, h: rows * tileH + Math.max(0, rows - 1) * gap };
}
