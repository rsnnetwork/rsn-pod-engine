// A row of tabs that scrolls sideways starts at its left end, so on a phone the
// current tab can be off screen. Bring it into view inside the row only:
// scrollIntoView would move the page as well.
//
// The web font arrives after the first paint and makes every tab wider, which moves
// the current one, so the row is placed again once fonts have loaded. A row the
// member has already scrolled or tapped is left where they put it.
import { useEffect, type RefObject } from 'react';
import { useLocation } from 'react-router-dom';

export default function useRevealActive(row: RefObject<HTMLElement>): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const strip = row.current;
    if (!strip) return;
    let handled = false;
    const markHandled = () => { handled = true; };
    const reveal = () => {
      const current = strip.querySelector<HTMLElement>('[aria-current="page"]');
      if (!current || handled) return;
      strip.scrollTo({ left: Math.max(0, current.offsetLeft - (strip.clientWidth - current.offsetWidth) / 2) });
    };
    strip.addEventListener('pointerdown', markHandled);
    strip.addEventListener('wheel', markHandled, { passive: true });
    reveal();
    document.fonts.addEventListener('loadingdone', reveal);
    void document.fonts.ready.then(reveal);
    return () => {
      strip.removeEventListener('pointerdown', markHandled);
      strip.removeEventListener('wheel', markHandled);
      document.fonts.removeEventListener('loadingdone', reveal);
    };
  }, [row, pathname]);
}
