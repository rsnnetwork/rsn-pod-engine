// ─── The video-meeting stage, as geometry (26 Oct 2026, VID-01/02) ─────────────
//
// On 25 Oct a two-person video meeting showed the director's own camera as a
// full-width hero tile and pushed the other person below the fold of a scroll
// area. The meeting room lays its tiles out from the stage's own measured size
// instead, so every tile is on screen at every window size and the stage never
// scrolls. Pure functions, no React and no LiveKit: the server's jest imports
// this file directly (server/src/__tests__/client/meeting-layout.test.ts).

import { TILE_CAPS } from '../tileWindow';

export type MeetingLayout = 'solo' | 'pair' | 'side' | 'grid' | 'focus';

/** How two people sit: the other person large with yourself small in the corner, or both the same size. */
export type PairView = 'pair' | 'side';

export type TileFill = 'contain' | 'cover';

export interface Box { x: number; y: number; w: number; h: number }

export interface StageGrid { cols: number; rows: number; tileW: number; tileH: number }

/** Space between tiles, in px. */
export const STAGE_GAP = 8;
/** A camera's shape: tiles are 16:9 so a webcam picture fills them. */
export const TILE_ASPECT = 16 / 9;
/** Two people sit side by side by default in a window at least this wide (and landscape). */
export const SIDE_BY_SIDE_MIN_WIDTH = 1024;

/**
 * The default for two people, decided by the WINDOW, not the stage (ruling, 26 Oct 2026): side by side in a window at
 * least 1024px wide and landscape, so a landscape tablet or a small laptop counts as a computer even though its stage
 * is a few pixels narrower; otherwise the other person large with yourself in the corner.
 */
export function sideBySideByDefault(windowWidth: number, windowHeight: number): boolean {
  return windowWidth >= SIDE_BY_SIDE_MIN_WIDTH && windowWidth > windowHeight;
}

/** The same rule as a media query, for the stage to follow the window live (CSS landscape: wider than tall). */
export const SIDE_BY_SIDE_QUERY = `(min-width: ${SIDE_BY_SIDE_MIN_WIDTH}px) and (orientation: landscape)`;

export interface MeetingLayoutInput {
  /** Video tiles on the stage: the viewer's own plus every other person shown on camera. */
  visibleCount: number;
  /** The window is at least 1024px wide and landscape (sideBySideByDefault). */
  wide: boolean;
  /** The tile pinned on this screen or put in the spotlight by a host, when it is on the stage. */
  focusKey?: string | null;
  /** The viewer's choice for two people; null or absent follows the window. */
  pairView?: PairView | null;
}

export function selectMeetingLayout({ visibleCount, wide, focusKey, pairView }: MeetingLayoutInput): MeetingLayout {
  if (visibleCount <= 1) return 'solo';
  if (focusKey) return 'focus';
  if (visibleCount === 2) return pairView ?? (wide ? 'side' : 'pair');
  return 'grid';
}

/** A grid of `cols` x `rows` same-size tiles of the given shape, as large as fits; sizes are whole pixels, rounded down. */
function fitGrid(width: number, height: number, cols: number, rows: number, gap: number, aspect: number): StageGrid {
  const maxW = (width - gap * (cols - 1)) / cols;
  const maxH = (height - gap * (rows - 1)) / rows;
  const tileW = Math.max(0, Math.floor(Math.min(maxW, maxH * aspect)));
  const tileH = Math.max(0, Math.floor(tileW / aspect));
  return { cols, rows, tileW, tileH };
}

/**
 * The even grid for `n` tiles: every column count is tried and the one with the largest tile wins, so the grid
 * always fits inside width x height (it never makes the stage scroll).
 */
export function computeStageGrid(width: number, height: number, n: number, gap = STAGE_GAP, aspect = TILE_ASPECT): StageGrid {
  const count = Math.max(1, Math.floor(n));
  let best = fitGrid(width, height, 1, count, gap, aspect);
  for (let cols = 2; cols <= count; cols++) {
    const candidate = fitGrid(width, height, cols, Math.ceil(count / cols), gap, aspect);
    if (candidate.tileW > best.tileW) best = candidate;
  }
  return best;
}

/** The largest box of the given shape inside width x height, centred (empty when there is no room). */
function fitCentered(width: number, height: number, aspect: number): Box {
  const w = Math.max(0, Math.floor(Math.min(width, height * aspect)));
  const h = Math.floor(w / aspect);
  return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), w, h };
}

function areaOf(b: Box): number {
  return b.w * b.h;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * The box for one large picture: a 16:9 frame on a landscape stage; the whole stage when it is upright, so a phone's
 * portrait camera fills it (the picture is shown whole, letterboxed when it is landscape).
 */
function mainBox(width: number, height: number): Box {
  return width >= height ? fitCentered(width, height, TILE_ASPECT) : { x: 0, y: 0, w: width, h: height };
}

/** The small picture of yourself in the corner, sized for the stage. */
export function insetSize(width: number, height: number): { w: number; h: number } {
  if (width > height && height <= 500) return { w: 96, h: 72 }; // a phone on its side
  if (width <= height) return width < 640 ? { w: 112, h: 144 } : { w: 144, h: 192 }; // held upright: a portrait frame
  if (width < 640) return { w: 112, h: 63 };
  if (width < 1024) return { w: 176, h: 99 };
  if (width < 1400) return { w: 208, h: 117 };
  return { w: 240, h: 135 };
}

/** Of its full size, how much the other person's frame keeps when it moves clear of the inset; below that it stays. */
export const CLEAR_OF_INSET_MIN = 0.7;

/** The smallest the picture of yourself gets, either way: still a picture you can see, and a target you can tap. */
export const INSET_MIN = 44;

/**
 * The other person's largest frame clear of the inset: where it is, when the inset is already clear of it. On an
 * upright stage, the stage's whole width below the inset: a landscape camera's picture is as wide as the stage
 * either way, so it loses nothing there. On a landscape stage, a 16:9 frame below the inset or to its left,
 * whichever is larger.
 */
function clearOf(width: number, height: number, inset: Box): Box {
  const full = mainBox(width, height);
  if (!intersects(full, inset)) return full;
  const top = inset.y + inset.h + STAGE_GAP;
  if (width < height) return { x: 0, y: top, w: width, h: Math.max(0, height - top) };
  const lower = fitCentered(width, Math.max(0, height - top), TILE_ASPECT);
  const below = { ...lower, y: lower.y + top };
  const left = fitCentered(Math.max(0, inset.x - STAGE_GAP), height, TILE_ASPECT);
  return areaOf(below) >= areaOf(left) ? below : left;
}

/**
 * The other person large, and the picture of yourself in the top-right corner of the stage, never over them (fix
 * round 2: on every stage, upright or on its side, chat open or closed). Your picture keeps its size while the
 * other person, moved clear of it, keeps at least CLEAR_OF_INSET_MIN of their frame; on a stage too short for that
 * it shrinks first, in its own shape, never below INSET_MIN either way, and at that size the other person takes
 * the largest room clear of it.
 */
function pairBoxes(width: number, height: number): { main: Box; inset: Box } {
  const margin = height <= 500 ? 8 : 12;
  const size = insetSize(width, height);
  const maxW = Math.max(0, width - 2 * margin);
  const maxH = Math.max(0, height - 2 * margin);
  const insetOfHeight = (h: number): Box => {
    const w = Math.min(Math.round((h * size.w) / size.h), maxW);
    const ch = Math.min(h, maxH);
    return { x: width - margin - w, y: margin, w, h: ch };
  };
  const enough = CLEAR_OF_INSET_MIN * areaOf(mainBox(width, height));
  // The height at which the narrower side reaches INSET_MIN (a portrait picture is narrower than it is tall).
  const floorH = Math.min(size.h, Math.ceil(INSET_MIN * Math.max(1, size.h / size.w)));
  for (let h = size.h; h > floorH; h--) {
    const inset = insetOfHeight(h);
    const main = clearOf(width, height, inset);
    if (areaOf(main) >= enough) return { main, inset };
  }
  const inset = insetOfHeight(floorH);
  return { main: clearOf(width, height, inset), inset };
}

/** Lays `cells` same-size tiles out as rows, each row centred and the block centred on the stage. */
function gridCells(width: number, height: number, cells: number, grid: StageGrid): Box[] {
  const { cols, rows, tileW, tileH } = grid;
  const blockH = rows * tileH + (rows - 1) * STAGE_GAP;
  const top = Math.floor((height - blockH) / 2);
  const boxes: Box[] = [];
  for (let i = 0; i < cells; i++) {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, cells - row * cols);
    const rowW = inRow * tileW + (inRow - 1) * STAGE_GAP;
    const left = Math.floor((width - rowW) / 2);
    boxes.push({ x: left + (i % cols) * (tileW + STAGE_GAP), y: top + row * (tileH + STAGE_GAP), w: tileW, h: tileH });
  }
  return boxes;
}

export interface StagePlanInput {
  /** The stage's inner size, in px. */
  width: number;
  height: number;
  /** Tiles to place; index 0 is the viewer's own, the rest are the other people in order. */
  count: number;
  /** The tile pinned or spotlighted, or null. */
  focusIndex: number | null;
  /** The viewer's choice for two people, or null for the window's default. */
  pairView: PairView | null;
  /** The window is at least 1024px wide and landscape (sideBySideByDefault): two people sit side by side. */
  wide: boolean;
}

export interface StagePlan {
  layout: MeetingLayout;
  /** Where each tile sits, in stage coordinates and the order given; null for a tile that is not shown. */
  boxes: (Box | null)[];
  /** How each tile's picture fills its box: whole ('contain'), or filling a small frame ('cover'). */
  fills: TileFill[];
  /** The tile shown as the small picture in the corner of a two-person view, or null. */
  insetIndex: number | null;
  /** The "+N" cell for the people beyond what fits, or null. */
  more: { box: Box; count: number } | null;
}

/** The others in a pinned view, as a strip of small tiles under the pinned one; "+N" when they do not all fit. */
function focusPlan(width: number, height: number, count: number, focusIndex: number): StagePlan {
  const boxes: (Box | null)[] = new Array(count).fill(null);
  const fills: TileFill[] = new Array(count).fill('cover');
  const others = Array.from({ length: count }, (_, i) => i).filter((i) => i !== focusIndex);
  // At least three thumbnails fit across, and the strip takes about a fifth of the height (56 to 120px).
  const wanted = Math.min(120, Math.max(56, height * 0.2));
  const tileW = Math.max(0, Math.min(Math.floor(wanted * TILE_ASPECT), Math.floor((width - 2 * STAGE_GAP) / 3)));
  const tileH = Math.floor(tileW / TILE_ASPECT);
  const room = Math.max(1, Math.floor((width + STAGE_GAP) / (tileW + STAGE_GAP)));
  const shownOthers = others.length <= room ? others : others.slice(0, room - 1);
  const hidden = others.length - shownOthers.length;
  const cells = shownOthers.length + (hidden > 0 ? 1 : 0);
  const stripW = cells * tileW + (cells - 1) * STAGE_GAP;
  const left = Math.floor((width - stripW) / 2);
  const stripY = height - tileH;
  shownOthers.forEach((i, k) => { boxes[i] = { x: left + k * (tileW + STAGE_GAP), y: stripY, w: tileW, h: tileH }; });
  const main = mainBox(width, Math.max(0, stripY - STAGE_GAP));
  boxes[focusIndex] = main;
  fills[focusIndex] = 'contain';
  const more = hidden > 0
    ? { box: { x: left + shownOthers.length * (tileW + STAGE_GAP), y: stripY, w: tileW, h: tileH }, count: hidden }
    : null;
  return { layout: 'focus', boxes, fills, insetIndex: null, more };
}

/**
 * Where every tile goes for this stage: the layout (selectMeetingLayout), the boxes and how each picture fills
 * its box. The viewer's own tile (index 0) is always shown.
 */
export function planStage({ width, height, count, focusIndex, pairView, wide }: StagePlanInput): StagePlan {
  const n = Math.max(0, Math.floor(count));
  const focus = focusIndex !== null && focusIndex >= 0 && focusIndex < n ? focusIndex : null;
  const layout = selectMeetingLayout({
    visibleCount: n, wide, focusKey: focus === null ? null : String(focus), pairView,
  });
  const empty: StagePlan = { layout, boxes: new Array(n).fill(null), fills: new Array(n).fill('contain'), insetIndex: null, more: null };
  if (n === 0 || width <= 0 || height <= 0) return empty;

  if (layout === 'solo') return { ...empty, boxes: [mainBox(width, height), ...empty.boxes.slice(1)] };

  if (layout === 'pair' || (layout === 'focus' && n === 2)) {
    const large = layout === 'pair' ? 1 : (focus as number);
    const small = 1 - large;
    const { main, inset } = pairBoxes(width, height);
    const boxes: (Box | null)[] = [null, null];
    const fills: TileFill[] = ['contain', 'contain'];
    boxes[large] = main;
    boxes[small] = inset;
    fills[small] = 'cover';
    return { layout, boxes, fills, insetIndex: small, more: null };
  }

  if (layout === 'side') {
    // Two equal tiles: in a row on a landscape stage, one above the other on an upright one; the other person first.
    const grid = width >= height
      ? fitGrid(width, height, 2, 1, STAGE_GAP, TILE_ASPECT)
      : fitGrid(width, height, 1, 2, STAGE_GAP, TILE_ASPECT);
    const [first, second] = gridCells(width, height, 2, grid);
    return { ...empty, boxes: [second, first] };
  }

  if (layout === 'focus') return focusPlan(width, height, n, focus as number);

  // The grid: the viewer first, up to the same cap the main room uses, then a "+N" cell.
  const cap = TILE_CAPS.normal[width < 640 ? 'mobile' : 'desktop'];
  const shown = Math.min(n, cap);
  const hidden = n - shown;
  const cells = shown + (hidden > 0 ? 1 : 0);
  const placed = gridCells(width, height, cells, computeStageGrid(width, height, cells));
  const boxes: (Box | null)[] = empty.boxes.map((_, i) => (i < shown ? placed[i] : null));
  return { ...empty, boxes, more: hidden > 0 ? { box: placed[shown], count: hidden } : null };
}
