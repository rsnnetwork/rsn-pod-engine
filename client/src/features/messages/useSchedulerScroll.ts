// Keeping the scheduler's moving parts in sight. The panel scrolls inside the thread column (it cannot grow past it),
// and the timeline scrolls inside the panel; every scroll here moves one of those two, never an ancestor (a scrolled
// thread column slides its header away). What has to stay in sight: the time a day opens on, a time just typed or
// pointed at (flashed so the eye lands on it), the confirm card, and the step that finishes the job at the top.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { hasStarted, slotTime } from './scheduler-flow';

const WORK_START_HOUR = 8; // where the day's timeline opens by default (local)

interface Frame {
  panelRef: RefObject<HTMLDivElement>;
  gridRef: RefObject<HTMLDivElement>;
  saveBarRef: RefObject<HTMLDivElement>;
}

/** Floor of the panel's visible frame: the pinned Save bar's top, or the frame's own bottom. */
function floorOf(panel: HTMLElement, bar: HTMLElement | null): number {
  return bar && bar.dataset.pinned === 'true' ? bar.getBoundingClientRect().top : panel.getBoundingClientRect().bottom;
}

/**
 * Bring a time into view and flash it so the eye lands on it. `panel`: bring it into the panel's frame too, clear of
 * the Save bar (a typed time); not for a confirm card, which keeps the top of the panel.
 */
export function useReveal({ panelRef, gridRef, saveBarRef }: Frame) {
  const [scrollTo, setScrollTo] = useState<{ key: string; panel: boolean } | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);

  useEffect(() => {
    if (!scrollTo) return;
    const box = gridRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-slot="${scrollTo.key}"]`);
    if (box && el) {
      const top = el.offsetTop - 4;
      const bottom = el.offsetTop + el.offsetHeight + 4;
      if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
        box.scrollTop = Math.max(0, top - Math.round((box.clientHeight - el.offsetHeight) / 2));
      }
      // On a small phone the timeline is taller than the panel's frame: scroll
      // the panel so the time is above the pinned Save bar.
      const panel = panelRef.current;
      if (scrollTo.panel && panel) {
        const frameTop = panel.getBoundingClientRect().top;
        const floor = floorOf(panel, saveBarRef.current);
        const cell = el.getBoundingClientRect();
        if (cell.bottom > floor) panel.scrollTop += cell.bottom - floor + 8;
        else if (cell.top < frameTop) panel.scrollTop -= frameTop - cell.top + 8;
      }
    }
    setFlashKey(scrollTo.key);
    setScrollTo(null);
    const t = setTimeout(() => setFlashKey(null), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per time revealed; the refs are stable
  }, [scrollTo]);

  return {
    flashKey,
    /** Bring a time into view (and into the panel's frame when `panel`), and flash it. */
    reveal: (key: string, panel: boolean) => setScrollTo({ key, panel }),
  };
}

interface Options extends Frame {
  confirmCardRef: RefObject<HTMLDivElement>;
  reveal: (key: string, panel: boolean) => void;
  /** The day on screen, its times, and whether the scheduling has loaded. */
  dayKey: string;
  daySlots: readonly string[];
  loaded: boolean;
  saved: ReadonlySet<string>;
  theirs: ReadonlySet<string>;
  bookedKey: string | null;
  zone: string;
  /** Opened by Reschedule: the first pickable time takes the focus. */
  focusFirstPick?: boolean;
  /** The time whose confirm card is open. */
  finalizing: string | null;
  /** What the top of the panel shows; when it changes the panel goes back to it. */
  headline: string;
}

export function useSchedulerScroll(o: Options) {
  const { panelRef, gridRef, saveBarRef, confirmCardRef, bookedKey, focusFirstPick, reveal } = o;

  // Opening a day: scroll its timeline to what matters — a time you both
  // can, else yours, else theirs, else the first time from the working day on.
  // Runs per day, not per tap, so toggling never jumps.
  const pickFocused = useRef(false);
  useEffect(() => {
    const box = gridRef.current;
    if (!box || !o.loaded) return;
    const shown = o.daySlots.filter(k => !hasStarted(k, Date.now()));
    const target =
      shown.find(k => o.saved.has(k) && o.theirs.has(k)) ??
      shown.find(k => o.saved.has(k)) ??
      shown.find(k => o.theirs.has(k)) ??
      shown.find(k => Number(slotTime(k, o.zone).slice(0, 2)) >= WORK_START_HOUR) ??
      shown[0];
    const el = target ? box.querySelector<HTMLElement>(`[data-slot="${target}"]`) : null;
    if (el) box.scrollTop = Math.max(0, el.offsetTop - 4);
    // Reschedule opened the panel for a new pick: a time that can be picked
    // (not the booked one it opened on, the time just after it) comes into the
    // panel's frame (the panel scrolls, never an ancestor) and takes the focus.
    const pick = target === bookedKey ? shown[shown.indexOf(target) + 1] ?? shown.find(k => k !== bookedKey) : target;
    const pickEl = pick ? box.querySelector<HTMLElement>(`[data-slot="${pick}"]`) : null;
    if (focusFirstPick && !pickFocused.current && pickEl && pick) {
      pickFocused.current = true;
      reveal(pick, true);
      pickEl.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per day opened (and once the times load), not per tap
  }, [o.dayKey, o.loaded]);

  // The confirm card opens at the top of the panel. Bring the whole card —
  // its button above all — inside the panel's own frame, clear of the pinned
  // Save bar.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const card = confirmCardRef.current;
    if (!o.finalizing || !panel || !card) return;
    const frameTop = panel.getBoundingClientRect().top;
    const floor = floorOf(panel, saveBarRef.current);
    const box = card.getBoundingClientRect();
    // A card taller than the frame is aligned to its BOTTOM: the confirm button
    // and "Remove this time" are its last rows, and they have to be in reach.
    if (box.bottom > floor || box.height + 16 > floor - frameTop) panel.scrollTop += box.bottom - floor + 8;
    else if (box.top < frameTop) panel.scrollTop -= frameTop - box.top + 8;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per card opened
  }, [o.finalizing]);

  // The step that finishes the job mounts at the TOP of the panel: the shared
  // times when they appear, then the confirmed meeting. For the second person
  // to save, their own Save can be what creates it — and they are usually
  // scrolled down in the timeline at that moment. Bring the panel back to it.
  useLayoutEffect(() => {
    if (o.headline !== 'none' && panelRef.current) panelRef.current.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per change of what the top shows
  }, [o.headline]);
}
