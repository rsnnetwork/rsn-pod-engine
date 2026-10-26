// client/src/features/reason/shell/scroll-memory.ts
// Where each page of the shell was scrolled to, so that Back returns to the exact place (CON-01, 25 Oct 2026: Stefan
// and Claus opened a profile from a list, pressed Back, and were at the top of the list again).
//
// <main> is what scrolls in the shell, not the window, so the browser's own scroll restoration cannot help; and the
// Human Profile is outside the shell, so coming back builds the shell, and its <main>, from nothing. A place is therefore
// kept per history entry (React Router's location.key, which comes back unchanged on Back) in a module-level map that
// outlives the shell, and mirrored to sessionStorage, which outlives a reload and a page the browser threw away.
//
// Pure on purpose: no React, router, DOM or global (the store and the frames are handed in), and nothing happens when the file
// is loaded, so a test can run it: server/src/__tests__/client/reason-m1-scroll-memory.test.ts. useMainScrollMemory.ts holds the
// one memory of the page area, reads where it comes from, and wires all of this to <main>.

export type Navigation = 'POP' | 'PUSH' | 'REPLACE';

export type ScrollAction =
  | { kind: 'restore'; top: number }
  | { kind: 'top' }
  | { kind: 'keep' };

/**
 * What the page area does when the shell shows a new location.
 * - Back or Forward to a place the member had scrolled: put it where it was.
 * - Any other way to a different page (a link, a button, a redirect): that page's top. The shell's first page counts as
 *   different, so a page opened from a profile starts at its top.
 * - The same page with a new address (?tab=, ?q=, ?view=): stay, as before.
 */
export function scrollActionFor(move: {
  navigation: Navigation;
  /** The path the shell showed before this one, or null when this is the shell's first location. */
  previousPathname: string | null;
  pathname: string;
  /** The place saved for this history entry and address, or null. */
  saved: number | null;
}): ScrollAction {
  if (move.navigation === 'POP' && move.saved !== null) return { kind: 'restore', top: move.saved };
  return move.previousPathname === move.pathname ? { kind: 'keep' } : { kind: 'top' };
}

// ---- the places ---------------------------------------------------------------------------------

/** How many history entries' places are kept. Older ones go first. */
export const REMEMBER_LIMIT = 60;
export const STORAGE_KEY = 'reason:main-scroll';

export interface ScrollStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface Place { path: string; top: number }

const isPlace = (top: unknown): top is number => typeof top === 'number' && Number.isFinite(top) && top >= 0;

export class ScrollMemory {
  // Oldest first: a Map keeps insertion order, and an entry scrolled again is moved to the end.
  private readonly places = new Map<string, Place>();

  constructor(private readonly store: ScrollStore | null, private readonly limit = REMEMBER_LIMIT) {
    this.load();
  }

  /** The place for a history entry. `path` (pathname and search) is kept with it because the first entry of a tab is always keyed "default", whatever its address. */
  remember(key: string, path: string, top: number): void {
    if (!isPlace(top)) return;
    this.places.delete(key);
    this.places.set(key, { path, top: Math.round(top) });
    while (this.places.size > this.limit) {
      const oldest = this.places.keys().next();
      if (oldest.done) break;
      this.places.delete(oldest.value);
    }
  }

  /** The place saved for this entry, if it was saved for this address. */
  recall(key: string, path: string): number | null {
    const place = this.places.get(key);
    return place && place.path === path ? place.top : null;
  }

  /** Drops the place saved for an entry. */
  forget(key: string): void {
    this.places.delete(key);
  }

  /** Writes the places to the store. A store that is missing, full or refused changes nothing: the map still serves this shell. */
  save(): void {
    if (!this.store) return;
    try {
      this.store.setItem(STORAGE_KEY, JSON.stringify([...this.places].map(([key, place]) => [key, place.path, place.top])));
    } catch {
      // Private browsing, a full store, a blocked frame: the places are only a convenience.
    }
  }

  private load(): void {
    if (!this.store) return;
    try {
      const saved: unknown = JSON.parse(this.store.getItem(STORAGE_KEY) ?? 'null');
      if (!Array.isArray(saved)) return;
      for (const row of saved) {
        if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string') this.remember(row[0], row[1], row[2]);
      }
    } catch {
      // Text that is not ours, or a store that refuses to be read: start empty.
    }
  }
}

/**
 * Whether a page loaded by `type` (the browser's own word for it, from the navigation timing) is the entry it was before:
 * a reload, or Back into this document from another one. Any other way (a URL typed in, a link, a bookmark) is a new
 * page, which starts at its top.
 */
export const loadedAsSameEntry = (type: string | undefined): boolean => type === 'reload' || type === 'back_forward';

// ---- putting the page back ----------------------------------------------------------------------

/** How long a page may take to grow tall enough for the place before the place is clamped to what it has. */
export const RESTORE_WAIT_MS = 1500;

export interface ScrollArea {
  scrollHeight: number;
  clientHeight: number;
  scrollTo(options: { top: number; left: number; behavior: 'instant' }): void;
}

export interface Frames {
  now(): number;
  request(callback: () => void): number;
  cancel(id: number): void;
}

/** How a placement ended: at the place, given up on a page that stayed too short (and moved as far as it goes), or stopped early. */
export type Placed = 'placed' | 'gave-up' | 'stopped';

/**
 * Puts the area at `top`. The page may not be tall enough yet (a list still on its way), so until it is, this tries again on
 * every frame, for at most RESTORE_WAIT_MS, and then goes as far as the page allows. The first try is now, so a page that is
 * already there is placed before anything is drawn. `done` is called once, when it ends for any reason, and says how. The
 * function returned stops it early (the member took over, or the shell moved on) and is safe to call again.
 */
export function placeScroll(area: ScrollArea, top: number, frames: Frames, done: (how: Placed) => void): () => void {
  const started = frames.now();
  let waiting: number | null = null;
  let over = false;
  const finish = (how: Placed) => {
    if (over) return;
    over = true;
    done(how);
  };
  const attempt = () => {
    waiting = null;
    const roomEnough = area.scrollHeight - area.clientHeight >= top;
    if (!roomEnough && frames.now() - started < RESTORE_WAIT_MS) {
      waiting = frames.request(attempt);
      return;
    }
    // Instant: the app scrolls smoothly (index.css), and a smooth restore would be seen travelling down the list.
    area.scrollTo({ top, left: 0, behavior: 'instant' });
    finish(roomEnough ? 'placed' : 'gave-up');
  };
  attempt();
  return () => {
    if (waiting !== null) frames.cancel(waiting);
    waiting = null;
    finish('stopped');
  };
}

/**
 * Remembers that the page area was just moved by this code, so the scroll event that follows (it arrives a frame later) is
 * not taken for the member scrolling and recorded as where they left it. A restore that gives up on a page that stayed
 * short clamps the area to the end of what there is; recording that would replace the place it was trying to reach.
 */
export class OwnScrolls {
  private pending = false;
  private waiting: number | null = null;

  constructor(private readonly frames: Frames) {}

  /** Call right after moving the area. It is the member's again once two frames have been drawn. */
  mark(): void {
    this.pending = true;
    if (this.waiting !== null) this.frames.cancel(this.waiting);
    this.waiting = this.frames.request(() => {
      this.waiting = this.frames.request(() => {
        this.waiting = null;
        this.pending = false;
      });
    });
  }

  /** True while a scroll event may still be on its way from a move this code made. */
  get active(): boolean {
    return this.pending;
  }
}
