// ─── Nothing the browser scrolls into view lands behind the phone's bottom bar (10 Nov 2026, F7 fix round 3) ──────
//
// The production smoke (Chromium, 390px wide) scrolled the event page's End event button into view and found its
// centre under a tab of the bottom bar. <main> is the shell's scroll area and runs to the foot of the screen; below
// 721px the bar (MobileNav) is fixed over its last 69px and the safe area. <main>'s bottom PADDING already let the
// last thing on a page scroll up above the bar, so nothing was stuck there for good; but the scrollport still reached
// under the bar, so anything the browser scrolled into view (scrollIntoView, a focused field, an anchor) could be
// placed right behind it. The shell now gives <main> a bottom SCROLL padding of the same amount below 721px (none from
// 721px, where there is no bar). Layout is unchanged: pages that size or stick to <main> (Messages, the sticky submit
// bar on Create Event) are measured against its padding, which stays as it was.
// Pinned by source, as the other shell tests are; the bar's height is worked out from its own classes.

import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');

const shell = read('features/reason/shell/ReasonShell.tsx');
const nav = read('features/reason/shell/MobileNav.tsx');
const mainClass = shell.match(/<main ref=\{main\} className="([^"]*)"/)?.[1] ?? '';
const classes = mainClass.split(/\s+/);

/** The bar's height above the safe area: its top padding, its tallest tab, its bottom padding and its top border. */
function barHeight(): number {
  const tab = Number(nav.match(/const TAB = '[^']*\bmin-h-\[(\d+)px\]/)?.[1]);
  const navClass = nav.match(/<nav\s+aria-label="Main"\s+className="([^"]*)"/)?.[1] ?? '';
  const top = Number(navClass.match(/(?:^|\s)pt-(\d+(?:\.\d+)?)(?:\s|$)/)?.[1]) * 4; // Tailwind: n * 0.25rem = n * 4px
  const bottom = Number(navClass.match(/pb-\[calc\((\d+)px\+env\(safe-area-inset-bottom\)\)\]/)?.[1]);
  const border = /(?:^|\s)border-t(?:\s|$)/.test(navClass) ? 1 : 0;
  expect([tab, top, bottom].every(Number.isFinite)).toBe(true);
  return tab + top + bottom + border;
}

describe('<main> keeps what is scrolled into view clear of the phone bar', () => {
  it('the bar is fixed to the foot of the screen below 721px and hidden from 721px', () => {
    expect(nav).toMatch(/className="fixed inset-x-0 bottom-0 z-40 /);
    expect(nav).toMatch(/min-\[721px\]:hidden"/);
    expect(barHeight()).toBe(69);
  });

  it('below 721px, <main> has bottom padding AND bottom scroll padding of the same amount, more than the bar, with the safe area', () => {
    const pad = classes.find((c) => /^pb-\[calc\(\d+px\+env\(safe-area-inset-bottom\)\)\]$/.test(c));
    const scrollPad = classes.find((c) => /^scroll-pb-\[calc\(\d+px\+env\(safe-area-inset-bottom\)\)\]$/.test(c));
    expect(pad).toBeDefined();
    expect(scrollPad).toBeDefined();
    const padPx = Number(pad!.match(/(\d+)px/)![1]);
    const scrollPadPx = Number(scrollPad!.match(/(\d+)px/)![1]);
    expect(scrollPadPx).toBe(padPx);
    expect(scrollPadPx).toBeGreaterThan(barHeight());
  });

  it('from 721px, where there is no bar, there is no bottom scroll padding', () => {
    expect(classes).toContain('min-[721px]:scroll-pb-0');
  });

  it('<main> is still the scroll area, so the scroll padding applies to everything the shell shows', () => {
    expect(classes).toEqual(expect.arrayContaining(['overflow-y-auto', 'min-h-0', 'flex-1']));
  });
});
