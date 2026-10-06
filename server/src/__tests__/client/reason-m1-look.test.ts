// server/src/__tests__/client/reason-m1-look.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
    // The saved value is module-level state, shared by every sheet. Declared inside the component it would be
    // one per sheet again (the bug), and the assignments below would still look right.
    const savedAt = s.search(/^let overflowBeforeLock = '';$/m);
    expect(savedAt).toBeGreaterThan(-1);
    expect(savedAt).toBeLessThan(s.indexOf('export default function Sheet'));
    // Taken by the first sheet to open, before it joins the stack...
    expect(s).toMatch(/if \(openPanels\.length === 0\) \{\s*overflowBeforeLock = document\.body\.style\.overflow;\s*document\.body\.style\.overflow = 'hidden';\s*\}\s*openPanels\.push\(dialog\);/);
    // ...and given back only by the last one to close, after it has left the stack.
    expect(s).toMatch(/openPanels\.splice\(at, 1\);\s*if \(openPanels\.length === 0\) document\.body\.style\.overflow = overflowBeforeLock;/);
  });
  it('focus goes back to the control that opened a sheet even where a click does not focus it (WebKit): the control pressed last stands in for the opener when nothing has focus', () => {
    const s = read('src/features/reason/ui/Sheet.tsx');
    const component = s.indexOf('export default function Sheet');
    // WebKit leaves <body> focused after a click or a tap on a button, so a sheet opened that way had no opener to give
    // focus back to. One document-level capture listener, at module level, remembers the control pressed last...
    const pressedAt = s.search(/^let lastPressed: HTMLElement \| null = null;$/m);
    expect(pressedAt).toBeGreaterThan(-1);
    expect(pressedAt).toBeLessThan(component);
    expect(s).toMatch(/document\.addEventListener\('pointerdown', \(e\) => \{\s*lastPressed = e\.target instanceof Element \? e\.target\.closest<HTMLElement>\('button, a, \[tabindex\]'\) : null;\s*\}, \{ capture: true, passive: true \}\);/);
    expect(s.indexOf("document.addEventListener('pointerdown'")).toBeLessThan(component);
    // ...and it is the opener only when nothing has focus at open time (the body, or no element). A focused control, which
    // is what a keyboard opener and any click in Chromium leave, wins; and a pressed control that has left the page is not used.
    expect(s).toMatch(/const active = document\.activeElement as HTMLElement \| null;\s*const opener = \(!active \|\| active === document\.body\) && lastPressed\?\.isConnected \? lastPressed : active;/);
    // Focus goes back to it when the sheet closes.
    expect(s).toMatch(/opener\?\.focus\?\.\(\);/);
  });
});

// ---- the integration pass (milestone 1, Task P3) ---------------------------------------------------------

// WCAG relative luminance and contrast ratio.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// The real Tailwind palette: a class name in the source becomes the colour the browser paints.
const palette = require('tailwindcss/colors') as Record<string, Record<string, string>>;
const hexOf = (cls: string): string => {
  const m = cls.match(/^(?:bg|text|border)-([a-z]+)-(\d+)$/);
  const hex = m ? palette[m[1]]?.[m[2]] : undefined;
  if (!hex) throw new Error(`no palette colour for ${cls}`);
  return hex;
};

describe('Toasts a member can read, hear and see under a notch (integration pass)', () => {
  type Kind = 'success' | 'error' | 'info';
  interface Item { id: string; type: Kind; message: string; hostSilent?: boolean; internal?: boolean }

  // Toast.tsx itself, transpiled and drawn to markup. Only the store and the class joiner are stand-ins, so what
  // is asserted below is what the component really renders for a given list of toasts.
  function render(toasts: Item[], hostQuiet = false): string {
    const source = fs.readFileSync(path.join(root, 'src/components/ui/Toast.tsx'), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    const stand: Record<string, unknown> = {
      '@/stores/toastStore': { useToastStore: () => ({ toasts, removeToast: () => undefined }) },
      '@/lib/utils': { cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') },
    };
    const load = (id: string): unknown => (id in stand ? stand[id] : require(id));
    const mod: { exports: { default?: unknown } } = { exports: {} };
    new Function('module', 'exports', 'require', outputText)(mod, mod.exports, load);
    return renderToStaticMarkup(createElement(mod.exports.default as never, { hostQuiet }));
  }

  const three: Item[] = [
    { id: '1', type: 'success', message: 'Nadia saved' },
    { id: '2', type: 'info', message: 'Nadia can be suggested in For You again.' },
    { id: '3', type: 'error', message: 'Could not save that right now.' },
  ];

  it('success and info are announced politely, an error at once, and every toast is in exactly one region', () => {
    const html = render(three);
    // One region per politeness and no role on the cards themselves: a toast inside two live regions is read twice.
    expect(html.match(/role="status"/g)?.length ?? 0).toBe(1);
    expect(html.match(/role="alert"/g)?.length ?? 0).toBe(1);
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="false"');
    expect(html).toContain('role="alert" aria-live="assertive" aria-atomic="false"');
    const status = html.indexOf('role="status"');
    const alert = html.indexOf('role="alert"');
    expect(status).toBeGreaterThan(-1);
    expect(status).toBeLessThan(alert);
    const inStatus = html.slice(status, alert);
    const inAlert = html.slice(alert);
    for (const t of three) {
      expect(html.split(t.message)).toHaveLength(2);
      expect(t.type === 'error' ? inAlert : inStatus).toContain(t.message);
      expect(t.type === 'error' ? inStatus : inAlert).not.toContain(t.message);
    }
  });

  it('has both regions in the page before the first toast arrives, so a screen reader is already listening', () => {
    const html = render([]);
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('<button');
  });

  it('still drops internal messages for everyone, and shows a host only the errors that are theirs to act on', () => {
    const mixed: Item[] = [
      ...three,
      { id: '4', type: 'error', message: 'Not for the host', hostSilent: true },
      { id: '5', type: 'info', message: 'Plan updated for round 2', internal: true },
      { id: '6', type: 'error', message: 'Internal failure', internal: true },
    ];
    const everyone = render(mixed);
    for (const m of [...three.map((t) => t.message), 'Not for the host']) expect(everyone).toContain(m);
    for (const m of ['Plan updated for round 2', 'Internal failure']) expect(everyone).not.toContain(m);
    const host = render(mixed, true);
    expect(host).toContain('Could not save that right now.');
    for (const m of ['Nadia saved', 'Nadia can be suggested in For You again.', 'Not for the host', 'Plan updated for round 2', 'Internal failure']) {
      expect(host).not.toContain(m);
    }
  });

  it('the words are dark ink on a solid pale ground, 4.5:1 or better, so they read on any page or backdrop behind the toast', () => {
    const ink = read('tailwind.config.js').match(/ink: '(#[0-9a-f]{6})'/)![1];
    for (const type of ['success', 'info', 'error'] as Kind[]) {
      const html = render([{ id: '1', type, message: 'x' }]);
      const card = html.match(/<div class="([^"]*)" style="opacity:0/)![1].split(' ');
      expect({ type, ink: card.includes('text-reason-ink') }).toEqual({ type, ink: true });
      // Solid: a tint such as bg-emerald-500/10 lets the page through, and the ratio then depends on the page.
      expect({ type, tinted: card.some((c) => /^bg-[a-z]+-\d+\//.test(c)) }).toEqual({ type, tinted: false });
      const ground = card.find((c) => /^bg-[a-z]+-\d+$/.test(c));
      expect({ type, ground: !!ground }).toEqual({ type, ground: true });
      expect(contrast(ink, hexOf(ground!))).toBeGreaterThanOrEqual(4.5);
      // The colour meaning lives in the border and the icon, and the icon reads on the ground too.
      expect({ type, border: card.some((c) => /^border-[a-z]+-\d+$/.test(c)) }).toEqual({ type, border: true });
      const icon = html.match(/<svg[^>]*class="[^"]*\b(text-[a-z]+-\d+)\b/)![1];
      expect(contrast(hexOf(icon), hexOf(ground!))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('sits below a notch and clear of the side insets, and on phones spans the window minus its margins', () => {
    const html = render(three);
    // Inline, so it wins over top-4 and right-4, which stay as the fallback for a browser that knows no env().
    expect(html).toContain('top:max(16px, env(safe-area-inset-top))');
    expect(html).toContain('right:max(16px, env(safe-area-inset-right))');
    expect(html).toMatch(/class="fixed top-4 right-4 z-\[210\][^"]*\bleft-\[max\(16px,env\(safe-area-inset-left\)\)\] sm:left-auto sm:max-w-sm/);
  });

  it('keeps the hooks the older end-to-end specs use: a fixed top-right stack, with every message in a <p>', () => {
    const html = render(three);
    expect(html).toMatch(/^<div class="fixed top-4 right-4 z-\[210\]/);
    for (const t of three) expect(html).toMatch(new RegExp(`<p class="[^"]*">${t.message.replace(/\./g, '\\.')}</p>`));
    // A long unbroken word wraps inside the card instead of pushing it past the margin.
    expect(html).toMatch(/<p class="[^"]*\bmin-w-0\b[^"]*\[overflow-wrap:anywhere\]/);
  });

  it('every toast has a dismiss button at least 44px square, with a name', () => {
    const buttons = render(three).match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(b).toContain('aria-label="Dismiss notification"');
      expect(b).toMatch(/\bh-11\b/);
      expect(b).toMatch(/\bw-11\b/);
    }
  });
});

describe('A sheep that cannot load draws nothing (integration pass)', () => {
  const POSES = ['match', 'curious', 'hopeful', 'thinking'] as const;
  const sheep = () => read('src/features/reason/brand/ReasonSheep.tsx');

  // ReasonSheep.tsx itself, transpiled and drawn to markup. `failed` stands in for what the browser reports when the
  // picture cannot load: a static render cannot fire the image's error event, so useState answers with that state.
  function render(pose: string, failed: boolean): string {
    const { outputText } = ts.transpileModule(sheep(), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    const stand: Record<string, unknown> = {
      react: { useState: () => [failed, () => undefined] },
      '@/lib/utils': { cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') },
    };
    const load = (id: string): unknown => (id in stand ? stand[id] : require(id));
    const mod: { exports: { default?: unknown } } = { exports: {} };
    new Function('module', 'exports', 'require', outputText)(mod, mod.exports, load);
    return renderToStaticMarkup(createElement(mod.exports.default as never, { pose, className: 'h-9 w-9' }));
  }

  it('draws the same decorative, lazy picture for a pose that loads', () => {
    for (const pose of POSES) {
      expect(render(pose, false)).toBe(`<img src="/sheep/v4/${pose}.png" alt="" aria-hidden="true" loading="lazy" class="object-contain h-9 w-9"/>`);
    }
  });

  it('draws nothing at all once the picture has failed, so no broken-image box is left in an empty state or failure screen', () => {
    for (const pose of POSES) expect(render(pose, true)).toBe('');
  });

  it('forgets a failure on its own: the error sets the state, and a different pose is a new picture with a new try', () => {
    expect(sheep()).toMatch(/onError=\{\(\) => setFailed\(true\)\}/);
    expect(sheep()).toMatch(/if \(failed\) return null;/);
    expect(sheep()).toMatch(/<Picture key=\{pose\} pose=\{pose\} className=\{className\} \/>/);
  });
});
