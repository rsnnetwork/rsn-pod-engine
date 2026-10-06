// server/src/__tests__/client/reason-m1-look.test.ts
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../../../../client');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

describe('REASON look (milestone 1)', () => {
  it('Tailwind carries the prototype palette with the accessible brand red', () => {
    const tw = read('tailwind.config.js');
    expect(tw).toMatch(/reason:\s*\{/);
    expect(tw).toMatch(/red: '#DE322E'/);
    expect(tw).toMatch(/ink: '#11131a'/);
  });
  it('sheep poses are web-sized (<= 200KB each)', () => {
    for (const pose of ['match', 'curious', 'hopeful', 'thinking']) {
      const size = fs.statSync(path.join(root, `public/sheep/v4/${pose}.png`)).size;
      expect(size).toBeLessThanOrEqual(200 * 1024);
    }
  });
  it('the logo is the official sheep mark, not a prototype crop', () => {
    const mark = read('src/features/reason/brand/ReasonMark.tsx');
    expect(mark).toMatch(/\/rsn-sheep\.png/);
    expect(mark).not.toMatch(/logo_mark|logo_crop/);
  });
  it('sheets portal to body, are real dialogs, and respect the iPhone home bar', () => {
    const sheet = read('src/features/reason/ui/Sheet.tsx');
    expect(sheet).toMatch(/createPortal\([\s\S]*document\.body/);
    expect(sheet).toMatch(/role="dialog"/);
    expect(sheet).toMatch(/aria-modal="true"/);
    expect(sheet).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(sheet).toMatch(/h-11 w-11/);
  });
});

describe('REASON sheet, fix round 1 (milestone 1)', () => {
  const sheet = () => read('src/features/reason/ui/Sheet.tsx');

  it('keeps Tab inside the dialog: wraps at both ends, from the panel itself and from outside', () => {
    const s = sheet();
    expect(s).toMatch(/e\.key !== 'Tab'/);
    // Tab or Shift+Tab pressed while focus is outside the dialog comes back in.
    expect(s).toMatch(/!dialog\.contains\(current\)/);
    // Shift+Tab from the first control, or from the panel itself, wraps to the last.
    expect(s).toMatch(/e\.shiftKey && \(current === first \|\| current === dialog\)/);
    // Tab from the last control wraps to the first.
    expect(s).toMatch(/!e\.shiftKey && current === last/);
    expect(s.match(/e\.preventDefault\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it('only the top sheet answers the keyboard when sheets stack', () => {
    const s = sheet();
    expect(s).toMatch(/openPanels\.push\(dialog\)/);
    expect(s).toMatch(/openPanels\[openPanels\.length - 1\] !== dialog/);
  });
  it('a sheet without a footer still clears the iPhone home bar', () => {
    expect(sheet()).toMatch(/footer \? 'pb-3' : 'pb-\[calc\(12px\+env\(safe-area-inset-bottom\)\)\]'/);
  });
  it('a long single-word title wraps instead of pushing Close off the screen', () => {
    expect(sheet()).toMatch(/<h2 className="[^"]*\bmin-w-0\b[^"]*\[overflow-wrap:anywhere\][^"]*"/);
  });
  it('a press that starts inside the panel and ends on the backdrop does not close it', () => {
    const s = sheet();
    expect(s).toMatch(/onPointerDown=\{\(e\) => \{[^}]*pressedOnBackdrop\.current = e\.target === e\.currentTarget/);
    expect(s).toMatch(/pressedOnBackdrop\.current && e\.target === e\.currentTarget/);
  });
  it('clicks inside the portal do not bubble to the React ancestors of the sheet', () => {
    const s = sheet();
    expect(s).toMatch(/onPointerDown=\{\(e\) => \{ e\.stopPropagation\(\)/);
    expect(s).toMatch(/onClick=\{\(e\) => \{\s*e\.stopPropagation\(\)/);
  });
  it('the sheet follows the visible viewport on phones and paints no focus ring around the panel', () => {
    const s = sheet();
    expect(s).toMatch(/max-h-\[90dvh\]/);
    expect(s).toMatch(/md:max-h-\[86dvh\]/);
    expect(s).not.toMatch(/max-h-\[(90|86)vh\]/);
    // The app's global :focus-visible rule adds a ring AND a 2px white ring offset. ring-0 alone
    // still leaves the white band showing against the dimmed page, so both are switched off.
    expect(s).toMatch(/focus-visible:ring-0 focus-visible:ring-offset-0/);
  });
  it('a long unbroken title cannot squash the page head sheep', () => {
    expect(read('src/features/reason/ui/PageHead.tsx')).toMatch(/<ReasonSheep[^>]*className="[^"]*\bshrink-0\b/);
  });
  it('toasts sit above the sheet overlay', () => {
    const layer = (rel: string, re: RegExp) => Number(read(rel).match(re)?.[1]);
    const toast = layer('src/components/ui/Toast.tsx', /fixed top-4 right-4 z-\[(\d+)\]/);
    const overlay = layer('src/features/reason/ui/Sheet.tsx', /fixed inset-0 z-\[(\d+)\]/);
    expect(toast).toBeGreaterThan(overlay);
  });
});

// Left open by the reviews of the look and the shell, closed before a client looks at it (task P2).
describe('REASON look: fixes before a client reviews it (P2)', () => {
  it('the page eyebrow is #646a77, which clears 4.5:1 on every light surface the app uses (the old #7b8190 was 3.90:1 on white)', () => {
    const head = read('src/features/reason/ui/PageHead.tsx');
    expect(head).toMatch(/<p className="[^"]*\btext-\[#646a77\][^"]*">\{eyebrow\}<\/p>/);
    expect(head).not.toMatch(/#7b8190/);
  });
  it('the page scroll lock belongs to the stack of open sheets: the first to open takes it, the last to close gives it back (closing out of order used to leave the page locked)', () => {
    const s = read('src/features/reason/ui/Sheet.tsx');
    // No sheet keeps a copy of the page's value for itself: that copy is what the first sheet to close put
    // back under the one still open, and what the second then replaced with the 'hidden' it had seen.
    expect(s).not.toMatch(/previousOverflow/);
    // Taken by the first sheet to open, before it joins the stack...
    expect(s).toMatch(/if \(openPanels\.length === 0\) \{\s*overflowBeforeLock = document\.body\.style\.overflow;\s*document\.body\.style\.overflow = 'hidden';\s*\}\s*openPanels\.push\(dialog\);/);
    // ...and given back only by the last one to close, after it has left the stack.
    expect(s).toMatch(/openPanels\.splice\(at, 1\);\s*if \(openPanels\.length === 0\) document\.body\.style\.overflow = overflowBeforeLock;/);
  });
});
