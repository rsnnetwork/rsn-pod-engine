// ─── The bell panel on a phone: clear of the home indicator, and nothing cut off ─
// (8 Oct 2026)
//
// Two faults on a phone. In portrait the panel is a sheet fixed to the bottom of the screen, and with the
// page allowed to run under the home indicator (viewport-fit=cover) the last row's Accept sat under it.
// In landscape the screen is wide enough for the dropdown and only ~390px tall, so the panel's cap of 80vh
// (312px) was shorter than its header and its list (44 + 320px): the panel clipped the bottom of the list,
// and the last row's buttons could not be scrolled into view. The client has no test runner of its own, so,
// like the other files here, this reads the source. How the panel looks and where its last row ends up, in
// portrait with a home indicator, in landscape and on a desktop, was measured in a real browser; see the
// task report.

import * as fs from 'fs';
import * as path from 'path';

const BELL = fs.readFileSync(path.join(__dirname, '../../../../client/src/components/ui/NotificationBell.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The classes of the element whose opening tag matches, split into words. */
function classesOf(re: RegExp): string[] {
  const m = BELL.match(re);
  if (!m) throw new Error(`not found in NotificationBell.tsx: ${re}`);
  return m[1].split(/\s+/).filter(Boolean);
}

const panel = () => classesOf(/<div className="(absolute z-\[9999\][^"]*)"/);
const header = () => classesOf(/<div className="([^"]*border-b border-gray-100[^"]*)">\s*<h3/);
const list = () => classesOf(/\{\/\* List\b[^*]*\*\/\}\s*<div className="([^"]*)">/);

describe('the bell panel', () => {
  it('leaves room for the home indicator on a phone, and none from the sm breakpoint up', () => {
    expect(panel()).toContain('pb-[env(safe-area-inset-bottom)]');
    expect(panel()).toContain('sm:pb-0');
  });

  it('is a column, so that when the panel is capped it is the list that gives way', () => {
    expect(panel()).toContain('flex');
    expect(panel()).toContain('flex-col');
    expect(list()).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']));
  });

  it('keeps its header whole when the panel is short', () => {
    expect(header()).toContain('shrink-0');
  });

  it('is still the same panel: a bottom sheet capped at 80vh on a phone, a 20rem dropdown from sm up, the list capped at 20rem', () => {
    expect(panel()).toEqual(expect.arrayContaining([
      'absolute', 'inset-x-0', 'bottom-0', 'max-h-[80vh]', 'overflow-hidden', 'rounded-t-2xl', 'sm:rounded-xl', 'sm:inset-auto', 'sm:w-80',
    ]));
    expect(list()).toContain('max-h-80');
  });

  it('does not scroll the whole panel: only the list scrolls', () => {
    expect(panel()).not.toContain('overflow-y-auto');
    expect(panel()).not.toContain('overflow-auto');
  });
});
