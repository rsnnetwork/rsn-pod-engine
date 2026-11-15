import { useCallback, useLayoutEffect, useState } from 'react';

export interface BoxSize { w: number; h: number }

/**
 * The size of an element's box in whole pixels, kept up to date as it resizes. The video-meeting stage and the main
 * room's tile grid both lay their tiles out from it, so every tile is on screen and neither ever scrolls.
 *
 * It hands back a callback ref, not a ref object: the main room swaps the element it measures (the grid, the held
 * grid while reconnecting, the pinned view) without unmounting, and a ref object read once on mount would keep
 * watching the element that went away.
 */
export function useBoxSize<T extends HTMLElement>(): [(el: T | null) => void, BoxSize] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState<BoxSize>({ w: 0, h: 0 });
  const ref = useCallback((node: T | null) => setEl(node), []);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const next = { w: Math.floor(r.width), h: Math.floor(r.height) };
      setSize((s) => (s.w === next.w && s.h === next.h ? s : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [ref, size];
}
