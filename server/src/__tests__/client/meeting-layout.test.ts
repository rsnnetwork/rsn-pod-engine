// ─── The video-meeting stage (26 Oct 2026, VID-01/02) ───────────────────────
//
// On 25 Oct a two-person "Video Meeting" put the director's own camera in a
// full-width hero tile and pushed the other person below the fold of a scroll
// area; the guest could only see themselves by scrolling. The meeting room now
// lays its tiles out from the stage's own measured size, with a pure function
// (client/src/features/live/meeting/liveLayout.ts) imported here directly:
//   - 1 person: their own camera, large;
//   - 2 people: side by side at equal size in a WINDOW at least 1024px wide and
//     landscape (ruling, fix round 1: a landscape tablet or small laptop counts,
//     though its stage is a few pixels narrower), otherwise the other person
//     large with yourself small in the corner, never covering them on a
//     landscape stage; the viewer can swap the two views;
//   - 3 or more: an even grid that always fits the stage (it never scrolls),
//     the viewer's own tile first;
//   - a pin or a host's spotlight: that person large, the others in a strip.

import {
  selectMeetingLayout,
  computeStageGrid,
  planStage,
  sideBySideByDefault,
  SIDE_BY_SIDE_QUERY,
  CLEAR_OF_INSET_MIN,
  STAGE_GAP,
  TILE_ASPECT,
  type Box,
  type MeetingLayout,
} from '../../../../client/src/features/live/meeting/liveLayout';

// The six windows the brief names (CSS viewport sizes).
const WINDOWS: Array<[number, number]> = [
  [1280, 720], [1440, 900], [1024, 768], [390, 844], [360, 740], [844, 390],
];

// The stage each window leaves inside the meeting chrome: the top bar (48px),
// the control bar (64px) and the stage's own 8px padding on every side.
const stageOf = ([w, h]: [number, number]) => ({ width: w - 16, height: h - 48 - 64 - 16 });

const COUNTS = [1, 2, 3, 4, 9, 25];

const inside = (b: Box, width: number, height: number) =>
  b.x >= 0 && b.y >= 0 && b.x + b.w <= width + 0.001 && b.y + b.h <= height + 0.001 && b.w > 0 && b.h > 0;

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w - 0.001 && b.x < a.x + a.w - 0.001 && a.y < b.y + b.h - 0.001 && b.y < a.y + a.h - 0.001;

const area = (b: Box) => b.w * b.h;

/** The full-size 16:9 frame a landscape stage holds, the size the other person keeps most of. */
const fullFrameArea = (width: number, height: number) => {
  const w = Math.floor(Math.min(width, height * TILE_ASPECT));
  return w * Math.floor(w / TILE_ASPECT);
};

describe('selectMeetingLayout: which layout the stage uses', () => {
  it('one person is always the solo layout, pinned or not', () => {
    expect(selectMeetingLayout({ visibleCount: 1, wide: true })).toBe('solo');
    expect(selectMeetingLayout({ visibleCount: 1, wide: false, focusKey: 'me' })).toBe('solo');
    expect(selectMeetingLayout({ visibleCount: 0, wide: false })).toBe('solo');
  });

  it('two people sit side by side in a window at least 1024px wide and landscape, 1024x768 included', () => {
    for (const [w, h] of [[1280, 720], [1440, 900], [1024, 768]] as const) {
      expect(selectMeetingLayout({ visibleCount: 2, wide: sideBySideByDefault(w, h) })).toBe('side');
    }
  });

  it('otherwise two people get the other person large with yourself small in the corner', () => {
    for (const [w, h] of [[390, 844], [360, 740], [844, 390], [768, 1024], [1023, 700], [1100, 1300]] as const) {
      expect(selectMeetingLayout({ visibleCount: 2, wide: sideBySideByDefault(w, h) })).toBe('pair');
    }
  });

  it('the viewer can swap the two views either way', () => {
    expect(selectMeetingLayout({ visibleCount: 2, wide: true, pairView: 'pair' })).toBe('pair');
    expect(selectMeetingLayout({ visibleCount: 2, wide: false, pairView: 'side' })).toBe('side');
  });

  it('three or more people get the grid', () => {
    for (const n of [3, 4, 9, 25]) {
      expect(selectMeetingLayout({ visibleCount: n, wide: true })).toBe('grid');
      expect(selectMeetingLayout({ visibleCount: n, wide: false })).toBe('grid');
    }
  });

  it('a pin or a host spotlight turns any stage of two or more into the focus layout', () => {
    for (const n of [2, 3, 4, 9, 25]) {
      expect(selectMeetingLayout({ visibleCount: n, wide: true, focusKey: 'sid-1' })).toBe('focus');
    }
    expect(selectMeetingLayout({ visibleCount: 2, wide: true, focusKey: 'sid-1', pairView: 'side' })).toBe('focus');
  });

  it("sideBySideByDefault is the window's 1024px-and-landscape rule, and the stage reads it as this media query", () => {
    expect(sideBySideByDefault(1024, 768)).toBe(true);
    expect(sideBySideByDefault(1024, 700)).toBe(true);
    expect(sideBySideByDefault(1023, 700)).toBe(false);
    expect(sideBySideByDefault(1200, 1300)).toBe(false);
    expect(sideBySideByDefault(1200, 1200)).toBe(false); // CSS landscape is wider than tall
    expect(SIDE_BY_SIDE_QUERY).toBe('(min-width: 1024px) and (orientation: landscape)');
  });
});

describe('computeStageGrid: an even grid that never exceeds the stage', () => {
  const fits = (width: number, height: number, n: number) => {
    const g = computeStageGrid(width, height, n);
    expect(g.tileW).toBeGreaterThan(0);
    expect(g.tileH).toBeGreaterThan(0);
    expect(g.cols * g.tileW + (g.cols - 1) * STAGE_GAP).toBeLessThanOrEqual(width);
    expect(g.rows * g.tileH + (g.rows - 1) * STAGE_GAP).toBeLessThanOrEqual(height);
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
    // No wasted row: one row fewer could not hold everyone.
    expect(g.cols * (g.rows - 1)).toBeLessThan(n);
    // The tiles keep the camera's shape (16:9, within a pixel of rounding).
    expect(Math.abs(g.tileW / TILE_ASPECT - g.tileH)).toBeLessThanOrEqual(1);
    return g;
  };

  it.each(WINDOWS)('fits every count from 1 to 25 inside the whole %ix%i window', (w, h) => {
    for (let n = 1; n <= 25; n++) fits(w, h, n);
  });

  it.each(WINDOWS)('fits every count from 1 to 25 inside the stage the %ix%i window leaves', (w, h) => {
    const { width, height } = stageOf([w, h]);
    for (let n = 1; n <= 25; n++) fits(width, height, n);
  });

  it('picks the column count with the largest tile (checked against every other count)', () => {
    for (const [w, h] of WINDOWS) {
      const { width, height } = stageOf([w, h]);
      for (const n of COUNTS) {
        const best = computeStageGrid(width, height, n);
        for (let cols = 1; cols <= n; cols++) {
          const rows = Math.ceil(n / cols);
          const tileW = Math.min((width - STAGE_GAP * (cols - 1)) / cols, ((height - STAGE_GAP * (rows - 1)) / rows) * TILE_ASPECT);
          expect(best.tileW).toBeGreaterThanOrEqual(Math.floor(tileW));
        }
      }
    }
  });

  it('gives the sizes the audit worked out: four people at 1280x720 are a 2x2 grid of ~505x284', () => {
    const g = computeStageGrid(1264, 576, 4);
    expect([g.cols, g.rows]).toEqual([2, 2]);
    expect(g.tileW).toBe(504);
    expect(g.tileH).toBe(283);
  });

  it('stacks four people in one column on a phone held upright (287px wide at 390x844)', () => {
    const g = computeStageGrid(374, 670, 4);
    expect([g.cols, g.rows]).toEqual([1, 4]);
    expect(g.tileW).toBe(287);
  });

  it('returns an empty tile instead of a negative one when the stage has no size yet', () => {
    const g = computeStageGrid(0, 0, 3);
    expect(g.tileW).toBe(0);
    expect(g.tileH).toBe(0);
  });
});

describe('planStage: where every tile sits, for 1, 2, 3, 4, 9 and 25 people at the six windows', () => {
  const expected = (n: number, wide: boolean): MeetingLayout => {
    if (n === 1) return 'solo';
    if (n === 2) return wide ? 'side' : 'pair';
    return 'grid';
  };

  it.each(WINDOWS)('every tile is fully on a stage that never scrolls at %ix%i', (w, h) => {
    const { width, height } = stageOf([w, h]);
    const wide = sideBySideByDefault(w, h);
    for (const n of COUNTS) {
      const plan = planStage({ width, height, count: n, focusIndex: null, pairView: null, wide });
      expect(plan.layout).toBe(expected(n, wide));
      expect(plan.boxes).toHaveLength(n);
      // The viewer's own tile is always shown (first page of the grid, the inset of a pair).
      expect(plan.boxes[0]).not.toBeNull();
      const shown = plan.boxes.filter((b): b is Box => b !== null);
      for (const b of shown) expect(inside(b, width, height)).toBe(true);
      if (plan.more) expect(inside(plan.more.box, width, height)).toBe(true);
      // Nothing overlaps except the small inset picture of a two-person view.
      const flat = plan.boxes
        .map((b, i) => (i === plan.insetIndex ? null : b))
        .filter((b): b is Box => b !== null)
        .concat(plan.more ? [plan.more.box] : []);
      for (let i = 0; i < flat.length; i++) {
        for (let j = i + 1; j < flat.length; j++) expect(overlap(flat[i], flat[j])).toBe(false);
      }
    }
  });

  it.each(WINDOWS)('two people at %ix%i: the other person is the large one, or both are equal', (w, h) => {
    const { width, height } = stageOf([w, h]);
    const plan = planStage({ width, height, count: 2, focusIndex: null, pairView: null, wide: sideBySideByDefault(w, h) });
    const [self, other] = plan.boxes as Box[];
    if (plan.layout === 'pair') {
      expect(plan.insetIndex).toBe(0);
      expect(area(other)).toBeGreaterThan(area(self) * 3);
      expect(plan.fills).toEqual(['cover', 'contain']);
    } else {
      expect(plan.insetIndex).toBeNull();
      expect([self.w, self.h]).toEqual([other.w, other.h]);
      // Side by side on a landscape stage: one row.
      expect(self.y).toBe(other.y);
      expect(plan.fills).toEqual(['contain', 'contain']);
    }
  });

  it('a 1024x768 window seats two people side by side, in one row, equal (ruling)', () => {
    const { width, height } = stageOf([1024, 768]);
    expect(width).toBeLessThan(1024); // the stage itself is narrower: the window decides
    const plan = planStage({ width, height, count: 2, focusIndex: null, pairView: null, wide: sideBySideByDefault(1024, 768) });
    expect(plan.layout).toBe('side');
    const [self, other] = plan.boxes as Box[];
    expect([self.w, self.h]).toEqual([other.w, other.h]);
    expect(self.y).toBe(other.y);
    expect(other.x).toBeLessThan(self.x); // the other person first
  });

  it('the viewer can pick side by side on a phone: two equal tiles, one above the other', () => {
    const { width, height } = stageOf([390, 844]);
    const plan = planStage({ width, height, count: 2, focusIndex: null, pairView: 'side', wide: false });
    expect(plan.layout).toBe('side');
    const [self, other] = plan.boxes as Box[];
    expect([self.w, self.h]).toEqual([other.w, other.h]);
    expect(self.x).toBe(other.x);
    expect(self.y).toBeGreaterThan(other.y); // the other person first, yourself below
  });

  it('the grid tiles are all the same size, the viewer first', () => {
    const { width, height } = stageOf([1280, 720]);
    for (const n of [3, 4, 9]) {
      const plan = planStage({ width, height, count: n, focusIndex: null, pairView: null, wide: true });
      const boxes = plan.boxes as Box[];
      for (const b of boxes) expect([b.w, b.h]).toEqual([boxes[0].w, boxes[0].h]);
      // Reading order: the viewer's own tile is the top-left one.
      const first = boxes.reduce((a, b) => (b.y < a.y || (b.y === a.y && b.x < a.x) ? b : a));
      expect(first).toBe(boxes[0]);
      expect(plan.more).toBeNull();
    }
  });

  it('25 people: 20 tiles and a "+5" cell on a computer, 9 tiles and "+16" on a phone, the viewer always shown', () => {
    const desk = stageOf([1280, 720]);
    const d = planStage({ ...desk, count: 25, focusIndex: null, pairView: null, wide: true });
    expect(d.boxes.filter(Boolean)).toHaveLength(20);
    expect(d.more?.count).toBe(5);
    expect(d.boxes[0]).not.toBeNull();

    const phone = stageOf([390, 844]);
    const p = planStage({ ...phone, count: 25, focusIndex: null, pairView: null, wide: false });
    expect(p.boxes.filter(Boolean)).toHaveLength(9);
    expect(p.more?.count).toBe(16);
    expect(p.boxes[0]).not.toBeNull();
  });

  it('a pin puts that person large and the others in a strip below, all on the stage', () => {
    for (const [w, h] of WINDOWS) {
      const { width, height } = stageOf([w, h]);
      for (const n of [3, 4, 9, 25]) {
        const plan = planStage({ width, height, count: n, focusIndex: 2, pairView: null, wide: sideBySideByDefault(w, h) });
        expect(plan.layout).toBe('focus');
        const main = plan.boxes[2] as Box;
        for (const [i, b] of plan.boxes.entries()) {
          if (b && i !== 2) {
            expect(area(main)).toBeGreaterThan(area(b));
            expect(b.y).toBeGreaterThanOrEqual(main.y + main.h); // the strip sits below
          }
        }
        expect(plan.boxes[0]).not.toBeNull(); // yourself, first in the strip
      }
    }
  });

  it('a pin with two people swaps who is large: the pinned one, with the other small in the corner', () => {
    const { width, height } = stageOf([1280, 720]);
    const plan = planStage({ width, height, count: 2, focusIndex: 0, pairView: null, wide: true });
    expect(plan.layout).toBe('focus');
    expect(plan.insetIndex).toBe(1);
    expect(area(plan.boxes[0] as Box)).toBeGreaterThan(area(plan.boxes[1] as Box) * 3);
    expect(overlap(plan.boxes[0] as Box, plan.boxes[1] as Box)).toBe(false);
  });

  it('solo: the viewer large, in the camera\'s shape on a landscape stage', () => {
    const { width, height } = stageOf([1280, 720]);
    const plan = planStage({ width, height, count: 1, focusIndex: null, pairView: null, wide: true });
    const me = plan.boxes[0] as Box;
    expect(plan.layout).toBe('solo');
    expect(Math.abs(me.w / TILE_ASPECT - me.h)).toBeLessThanOrEqual(1);
    // It fills the stage one way (to the pixel the rounding down can lose).
    expect(me.h >= height - 1 || me.w >= width - 1).toBe(true);
  });

  it('a stage that has no size yet shows nothing rather than a broken tile', () => {
    const plan = planStage({ width: 0, height: 0, count: 2, focusIndex: null, pairView: null, wide: true });
    expect(plan.boxes.every((b) => b === null)).toBe(true);
  });
});

describe('the corner picture of yourself never covers the other person on a landscape stage (fix round 1)', () => {
  // Landscape stages where the corner picture would sit over the other person's frame: the four landscape
  // windows with the view set to "Focus" (the other person large), the chat open on a computer (the stage
  // narrows) and the chat open on a 390 phone (its sheet leaves a short, wide stage, where it overlapped by ~16px).
  const LANDSCAPE: Array<[string, number, number]> = [
    ['1280x720', ...(Object.values(stageOf([1280, 720])) as [number, number])],
    ['1440x900', ...(Object.values(stageOf([1440, 900])) as [number, number])],
    ['1024x768', ...(Object.values(stageOf([1024, 768])) as [number, number])],
    ['844x390', ...(Object.values(stageOf([844, 390])) as [number, number])],
    ['1280x720 with chat', 1280 - 320 - 16, 720 - 48 - 64 - 16],
    ['390x844 with chat', 374, 340],
  ];

  it.each(LANDSCAPE)('%s: the inset is clear of the other person, who keeps most of their size', (_label, width, height) => {
    const plan = planStage({ width, height, count: 2, focusIndex: null, pairView: 'pair', wide: false });
    expect(plan.layout).toBe('pair');
    const self = plan.boxes[0] as Box;
    const other = plan.boxes[1] as Box;
    expect(overlap(self, other)).toBe(false);
    expect(inside(other, width, height)).toBe(true);
    expect(inside(self, width, height)).toBe(true);
    expect(area(other)).toBeGreaterThanOrEqual(CLEAR_OF_INSET_MIN * fullFrameArea(width, height));
    expect(Math.abs(other.w / TILE_ASPECT - other.h)).toBeLessThanOrEqual(1);
  });

  it('the swapped view keeps the same rule: the other person in the corner is clear of you', () => {
    const { width, height } = stageOf([1440, 900]);
    const plan = planStage({ width, height, count: 2, focusIndex: 0, pairView: null, wide: true });
    expect(overlap(plan.boxes[0] as Box, plan.boxes[1] as Box)).toBe(false);
  });

  it('on an upright phone the other person fills the stage and you sit over its corner, as on any phone call', () => {
    for (const win of [[390, 844], [360, 740]] as Array<[number, number]>) {
      const { width, height } = stageOf(win);
      const plan = planStage({ width, height, count: 2, focusIndex: null, pairView: null, wide: false });
      expect(plan.boxes[1]).toEqual({ x: 0, y: 0, w: width, h: height });
      expect(plan.insetIndex).toBe(0);
    }
  });
});
