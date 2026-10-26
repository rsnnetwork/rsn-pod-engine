// client/src/features/reason/shell/useMainScrollMemory.ts
// Keeps the shell's page area (<main>, the thing that scrolls) where the member left it, for Back (CON-01, 25 Oct 2026).
// The rules are in scroll-memory.ts and are run by reason-m1-scroll-memory.test.ts; this file holds the one memory of the
// page area, and wires the rules to it: it records how far <main> is scrolled under the history entry it is showing, and on
// every new location, before the browser paints, puts it where the rules say.
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import {
  OwnScrolls, ScrollMemory, loadedAsSameEntry, placeScroll, scrollActionFor, type Placed, type ScrollArea, type ScrollStore,
} from './scroll-memory';

/** What the member does to scroll, or to take over from a restore that is still waiting for the page: seen anywhere in the page. */
const MEMBER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
/** The places are written to sessionStorage this long after the member stops scrolling (and at once when the page is hidden). */
const SAVE_AFTER_MS = 200;

const FRAMES = {
  now: () => performance.now(),
  request: (callback: () => void) => requestAnimationFrame(callback),
  cancel: (id: number) => cancelAnimationFrame(id),
};

/** sessionStorage, or null where asking for it throws (a sandboxed frame, a browser that blocks storage). */
function sessionStore(): ScrollStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The one memory of the page area. Module level, so it outlives the shell: the profile is outside it. */
const mainScroll = new ScrollMemory(sessionStore());

// The first entry of a tab is keyed "default" whatever its address, and what is saved under it may belong to an earlier page
// of the tab (the same address, typed in again). A page loaded as something new starts at its top, so it forgets that, in
// the store too, or a reload of this page would find it again.
const loaded = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
if (!loadedAsSameEntry(loaded?.type)) {
  mainScroll.forget('default');
  mainScroll.save();
}

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
  // True after a restore gave up on a page that stayed short, until the member next touches the page. The page keeps
  // adjusting the area as it fills (a clamp, an anchor), and none of that is the member either: recording it replaced the
  // place the restore was after with the top, so the Back after that one landed there.
  const waitingForMember = useRef(false);
  // The page area moved by this code (a restore, a new page's top): the scroll event that follows is not the member's either.
  const ours = useRef(new OwnScrolls(FRAMES));
  // Ends the restore in progress, if there is one.
  const stopRestore = useRef(() => {});
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
      if (settling.current || waitingForMember.current || ours.current.active) return;
      mainScroll.remember(here.current.key, here.current.address, area.scrollTop);
      window.clearTimeout(timer);
      timer = window.setTimeout(save, SAVE_AFTER_MS);
    };
    // The member taking over: a restore still waiting for the page ends, and scrolling is theirs again. Anywhere in the page,
    // not only on the area: a key pressed with nothing focused scrolls it too.
    const onMemberInput = () => {
      waitingForMember.current = false;
      stopRestore.current();
    };
    // iOS Safari may never fire pagehide for a page it puts away, but it does say the page is hidden.
    const saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') save();
    };
    area.addEventListener('scroll', onScroll, { passive: true });
    for (const event of MEMBER_INPUT) document.addEventListener(event, onMemberInput, { capture: true, passive: true });
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', saveWhenHidden);
    return () => {
      area.removeEventListener('scroll', onScroll);
      for (const event of MEMBER_INPUT) document.removeEventListener(event, onMemberInput, { capture: true });
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
    waitingForMember.current = false;
    const action = scrollActionFor({ navigation, previousPathname: previousPathname.current, pathname, saved: mainScroll.recall(key, address) });
    previousPathname.current = pathname;
    // Every move this code makes goes through here, so its scroll event can be told from the member's.
    const mover: ScrollArea = {
      get scrollHeight() { return area.scrollHeight; },
      get clientHeight() { return area.clientHeight; },
      scrollTo: (options) => {
        ours.current.mark();
        area.scrollTo(options);
      },
    };
    if (action.kind === 'top') mover.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    // The same page under a new address (a view chosen, a search typed): the new entry starts where the member is.
    if (action.kind === 'keep') mainScroll.remember(key, address, area.scrollTop);
    if (action.kind !== 'restore') return;

    settling.current = true;
    const release = (how: Placed) => {
      settling.current = false;
      waitingForMember.current = how === 'gave-up';
    };
    stopRestore.current = placeScroll(mover, action.top, FRAMES, release);
    return () => stopRestore.current();
  }, [key, address, pathname, navigation, main]);
}
