// client/src/features/reason/shell/useMainScrollMemory.ts
// Keeps the shell's page area (<main>, the thing that scrolls) where the member left it, for Back (CON-01, 25 Oct 2026).
// The rules are in scroll-memory.ts and are run by reason-m1-scroll-memory.test.ts; this wires them to the page area:
// it records how far <main> is scrolled under the history entry it is showing, and on every new location, before the
// browser paints, puts it where the rules say.
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { mainScroll, placeScroll, scrollActionFor } from './scroll-memory';

/** The member taking over from a restore that is still waiting for the page: any of these on the page area ends it. */
const TAKES_OVER = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
/** The places are written to sessionStorage this long after the member stops scrolling (and at once when the page is hidden). */
const SAVE_AFTER_MS = 200;

const FRAMES = {
  now: () => performance.now(),
  request: (callback: () => void) => requestAnimationFrame(callback),
  cancel: (id: number) => cancelAnimationFrame(id),
};

export default function useMainScrollMemory(main: RefObject<HTMLElement>): void {
  const { key, pathname, search } = useLocation();
  const navigation = useNavigationType();
  const address = pathname + search;
  // Which history entry the page area is showing, for the scroll listener below: it lives as long as the shell, not as
  // long as one location.
  const here = useRef({ key, address });
  // True while a restore is waiting for the page to grow. The page area then moves by itself (a short page clamps it to
  // the top), and that is not the member scrolling: it must not overwrite the place being restored.
  const settling = useRef(false);
  const previousPathname = useRef<string | null>(null);

  useEffect(() => {
    const area = main.current;
    if (!area) return;
    let timer: number | undefined;
    const save = () => {
      window.clearTimeout(timer);
      timer = undefined;
      mainScroll.save();
    };
    const onScroll = () => {
      if (settling.current) return;
      mainScroll.remember(here.current.key, here.current.address, area.scrollTop);
      window.clearTimeout(timer);
      timer = window.setTimeout(save, SAVE_AFTER_MS);
    };
    // iOS Safari may never fire pagehide for a page it puts away, but it does say the page is hidden.
    const saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') save();
    };
    area.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', saveWhenHidden);
    return () => {
      area.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', saveWhenHidden);
      // Not read from the page area here: by now the page inside it is already the next one, and its height would be
      // saved as the place of the one the member left. The places were recorded as the member scrolled.
      save();
    };
  }, [main]);

  useLayoutEffect(() => {
    const area = main.current;
    if (!area) return;
    here.current = { key, address };
    const action = scrollActionFor({ navigation, previousPathname: previousPathname.current, pathname, saved: mainScroll.recall(key, address) });
    previousPathname.current = pathname;
    if (action.kind === 'top') area.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    // The same page under a new address (a view chosen, a search typed): the new entry starts where the member is.
    if (action.kind === 'keep') mainScroll.remember(key, address, area.scrollTop);
    if (action.kind !== 'restore') return;

    settling.current = true;
    let stop = () => {};
    const takeOver = () => stop();
    const release = () => {
      settling.current = false;
      for (const event of TAKES_OVER) area.removeEventListener(event, takeOver);
    };
    for (const event of TAKES_OVER) area.addEventListener(event, takeOver, { passive: true });
    stop = placeScroll(area, action.top, FRAMES, release);
    return () => stop();
  }, [key, address, pathname, navigation, main]);
}
