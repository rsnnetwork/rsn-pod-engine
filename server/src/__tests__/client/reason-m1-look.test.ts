// server/src/__tests__/client/reason-m1-look.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createElement, type ReactElement } from 'react';
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

// A client source file, transpiled and run. What it imports through the app's own aliases is replaced by `stand`;
// everything else (react, framer-motion, lucide-react) is the real thing.
function loadModule(rel: string, stand: Record<string, unknown>): Record<string, unknown> {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const load = (id: string): unknown => (id in stand ? stand[id] : require(id));
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(mod, mod.exports, load);
  return mod.exports;
}
// A client component file, drawn to markup: what the component really renders for the given props.
function renderComponent(rel: string, stand: Record<string, unknown>, props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(loadModule(rel, stand).default as never, props));
}
const joinClasses = { cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') };

describe('Toasts a member can read, hear and see under a notch (integration pass)', () => {
  type Kind = 'success' | 'error' | 'info';
  interface Item { id: string; type: Kind; message: string; hostSilent?: boolean; internal?: boolean }

  // The store is a stand-in that holds the given toasts, so the filtering asserted below is the component's own.
  const render = (toasts: Item[], hostQuiet = false) => renderComponent(
    'src/components/ui/Toast.tsx',
    { '@/stores/toastStore': { useToastStore: () => ({ toasts, removeToast: () => undefined }) }, '@/lib/utils': joinClasses },
    { hostQuiet },
  );

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

describe('A sheep that cannot load keeps its place, empty (integration pass, polish pass)', () => {
  const POSES = ['match', 'curious', 'hopeful', 'thinking'] as const;
  const sheep = () => read('src/features/reason/brand/ReasonSheep.tsx');
  // The realtime guard's test makes and removes a scratch folder (__test_realtime_guard__) under src while the suites run
  // side by side. It is not source, and a file listed from it can be gone by the time it is read.
  const sourcesUnder = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((e) => !e.name.startsWith('__test_'))
    .flatMap((e) => (e.isDirectory() ? sourcesUnder(`${dir}/${e.name}`) : /\.tsx$/.test(e.name) ? [`${dir}/${e.name}`] : []));

  // `failed` stands in for what the browser reports when the picture cannot load: a static render cannot fire the
  // image's error event, so useState answers with that state.
  const render = (pose: string, failed: boolean) => renderComponent(
    'src/features/reason/brand/ReasonSheep.tsx',
    { react: { useState: () => [failed, () => undefined] }, '@/lib/utils': joinClasses },
    { pose, className: 'h-9 w-9' },
  );

  it('draws the same decorative, lazy picture for a pose that loads', () => {
    for (const pose of POSES) {
      expect(render(pose, false)).toBe(`<img src="/sheep/v4/${pose}.png" alt="" aria-hidden="true" loading="lazy" class="object-contain h-9 w-9"/>`);
    }
  });

  // A picture that is taken out of the page takes its box with it: the offline notice's "Try again" jumped 108px (the
  // sheep's 96px and the 12px gap under it) a few milliseconds after the notice appeared. The failed picture is
  // replaced by an empty box that the same classes size, so nothing below it moves.
  it('swaps a picture that has failed for an empty, hidden box that the same classes size: no broken-image box, and nothing around it moves', () => {
    for (const pose of POSES) {
      const html = render(pose, true);
      // A block with the caller's h-9 w-9, as the picture is (the page's base styles make an <img> a block with max-width 100%).
      expect(html).toBe('<span aria-hidden="true" class="block max-w-full h-9 w-9"></span>');
      expect(html).not.toContain('<img');
    }
  });

  it('forgets a failure on its own: the error sets the state, and a different pose is a new picture with a new try', () => {
    expect(sheep()).toMatch(/onError=\{\(\) => setFailed\(true\)\}/);
    expect(sheep()).toMatch(/if \(failed\) return <span aria-hidden="true" className=\{cn\('block max-w-full', className\)\} \/>;/);
    expect(sheep()).not.toMatch(/return null/);
    expect(sheep()).toMatch(/<Picture key=\{pose\} pose=\{pose\} className=\{className\} \/>/);
  });

  // The empty box is as big as the picture was only because the picture's size comes from the call site's classes. A call
  // site that left it to the picture's own size would lose its place the moment the picture failed.
  it('every call site gives the sheep both a width and a height of its own, and wherever it changes one at a wider window it changes the other', () => {
    const sites = sourcesUnder('src').flatMap((file) => [...read(file).matchAll(/<ReasonSheep\b([^>]*)>/g)]
      .map((m) => ({ file: file.split('/').pop()!, classes: m[1].match(/\bclassName="([^"]*)"/)?.[1].split(/\s+/) })));
    // The page head, the two For You empty states, the profile's hero and its notice, the For You list and the coming-soon note:
    // a count that drops to nothing would make the loop below pass for nothing.
    expect(sites.length).toBeGreaterThanOrEqual(7);
    for (const { file, classes } of sites) {
      expect({ file, hasClasses: !!classes }).toEqual({ file, hasClasses: true });
      const sizes = new Map<string, Set<string>>();
      for (const c of classes!) {
        const m = c.match(/^((?:min-\[\d+px\]:)*)([hw])-/);
        if (m) sizes.set(m[1], (sizes.get(m[1]) ?? new Set()).add(m[2]));
      }
      expect({ file, base: [...(sizes.get('') ?? [])].sort() }).toEqual({ file, base: ['h', 'w'] });
      for (const [variant, axes] of sizes) expect({ file, variant, axes: [...axes].sort() }).toEqual({ file, variant, axes: ['h', 'w'] });
    }
  });
});

describe('The bell panel\'s text reads at 4.5:1 on white and on the unread tint (integration pass)', () => {
  const bell = () => read('src/components/ui/NotificationBell.tsx');
  const classesOf = (re: RegExp) => {
    const m = bell().match(re);
    if (!m) throw new Error(`not found in NotificationBell.tsx: ${re}`);
    return m[1];
  };
  const textColour = (classes: string) => {
    const m = classes.match(/\btext-([a-z]+-\d+)\b/);
    if (!m) throw new Error(`no text colour in "${classes}"`);
    return hexOf(`text-${m[1]}`);
  };
  // An unread row is painted bg-blue-50/40 over the white panel.
  const unreadTint = () => {
    const m = bell().match(/!n\.isRead \? '(bg-[a-z]+-\d+)\/(\d+)'/);
    if (!m) throw new Error('the unread tint is not where this test looks');
    const alpha = Number(m[2]) / 100;
    const fg = [1, 3, 5].map((i) => parseInt(hexOf(m[1]).slice(i, i + 2), 16));
    return `#${fg.map((v) => Math.round(v * alpha + 255 * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
  };
  const grounds = () => ['#ffffff', unreadTint()];

  it('the message and its time are 4.5:1 or better on both grounds, and the message stays the darker of the two', () => {
    const body = textColour(classesOf(/<p className="([^"]*)">\{n\.body\}<\/p>/));
    const time = textColour(classesOf(/<p className="([^"]*)">\{formatTime\(n\.createdAt\)\}<\/p>/));
    for (const ground of grounds()) {
      expect(contrast(body, ground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(time, ground)).toBeGreaterThanOrEqual(4.5);
    }
    expect(luminance(body)).toBeLessThan(luminance(time));
  });

  it('the loading and empty lines, and every status label, read too', () => {
    for (const line of ['Loading\\.\\.\\.', 'No notifications yet']) {
      const colour = textColour(classesOf(new RegExp(`<p className="([^"]*)">${line}</p>`)));
      expect(contrast(colour, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    }
    const labels = [...bell().matchAll(/color: '(text-[a-z]+-\d+)'/g)].map((m) => m[1]);
    // Accepted, Declined, Expired on an invite, and the two words under a meeting request.
    const poke = classesOf(/n\.pokeStatus === 'accepted' \? '(text-[a-z]+-\d+)' : '(?:text-[a-z]+-\d+)'/);
    const pokeDeclined = classesOf(/n\.pokeStatus === 'accepted' \? '(?:text-[a-z]+-\d+)' : '(text-[a-z]+-\d+)'/);
    expect(labels).toHaveLength(3);
    for (const cls of [...labels, poke, pokeDeclined]) {
      for (const ground of grounds()) expect({ cls, ratio: contrast(textColour(cls), ground) >= 4.5 }).toEqual({ cls, ratio: true });
    }
  });

  it('keeps none of the colours that failed: the pale greys, emerald-500 and amber-400 text', () => {
    expect(bell()).not.toMatch(/\btext-(gray-(300|400)|emerald-500|amber-400)\b/);
  });
});

describe('The bell\'s Accept buttons read at 4.5:1, resting and hovered (polish pass)', () => {
  const bell = () => read('src/components/ui/NotificationBell.tsx');
  // The colours the app is built with: `bg-reason-red` is the red the browser paints, not a name this test makes up.
  const reasonToken = (name: string): string => {
    const block = read('tailwind.config.js').match(/reason:\s*\{([^}]*)\}/)?.[1] ?? '';
    const hex = block.match(new RegExp(`['"]?${name}['"]?:\\s*'(#[0-9a-fA-F]{6})'`))?.[1];
    if (!hex) throw new Error(`no reason.${name} in tailwind.config.js`);
    return hex;
  };
  const paint = (cls: string): string => {
    if (cls === 'text-white' || cls === 'bg-white') return '#ffffff';
    const token = cls.match(/^(?:bg|text)-reason-([a-z-]+)$/);
    return token ? reasonToken(token[1]) : hexOf(cls);
  };
  // Both Accept buttons in the panel: the one on a pod or event invite, and the one on a meeting request.
  const accepts = () => [...bell().matchAll(/onClick=\{\(\) => (handleAccept\w+)\(n\)\}\s*disabled=\{isActing\}\s*className="([^"]*)"/g)]
    .map((m) => ({ handler: m[1], classes: m[2].split(/\s+/) }));

  it('there are two Accept buttons, and both are checked below', () => {
    expect(accepts().map((a) => a.handler)).toEqual(['handleAcceptInvite', 'handleAcceptPoke']);
  });

  it('the label is white on the brand red, and white on the darker red under the pointer', () => {
    for (const { handler, classes } of accepts()) {
      expect({ handler, classes: classes.filter((c) => /^(text-white|bg-reason-red|hover:bg-reason-red-hover)$/.test(c)).sort() })
        .toEqual({ handler, classes: ['bg-reason-red', 'hover:bg-reason-red-hover', 'text-white'] });
    }
  });

  it('the label reads at 4.5:1 or better on the resting fill and on the hover fill, and the hover fill is the darker of the two', () => {
    for (const { handler, classes } of accepts()) {
      const label = paint(classes.find((c) => /^text-(white|reason-[a-z-]+)$/.test(c))!);
      const resting = paint(classes.find((c) => /^bg-[a-z]+(-[a-z0-9]+)*$/.test(c))!);
      const hover = paint(classes.find((c) => c.startsWith('hover:bg-'))!.slice('hover:'.length));
      expect({ handler, state: 'resting', ok: contrast(label, resting) >= 4.5 }).toEqual({ handler, state: 'resting', ok: true });
      expect({ handler, state: 'hover', ok: contrast(label, hover) >= 4.5 }).toEqual({ handler, state: 'hover', ok: true });
      expect(luminance(hover)).toBeLessThan(luminance(resting));
    }
  });

  it('keeps the rest of each button: the 44px height on a meeting request, and the dimmed look while it is busy', () => {
    const [invite, poke] = accepts();
    expect(poke.classes).toContain('min-h-[44px]');
    for (const { classes } of [invite, poke]) expect(classes).toContain('disabled:opacity-50');
  });
});

describe('Admin status pills wrap instead of scrolling <main> sideways at phone widths (integration pass)', () => {
  // Five pills at px-4 are about 450px wide: more than a 360px phone leaves inside <main>, and their words cannot
  // be split, so an unwrapped row pushed <main> 88px (Moderation) and 82px (Support) sideways at 360.
  it('Moderation: the status row wraps', () => {
    expect(read('src/features/admin/AdminModerationPage.tsx'))
      .toMatch(/<div className="flex flex-wrap gap-2 animate-fade-in-up">\s*\{\(\['open', 'resolved', 'actioned', 'dismissed', ''\] as ViolationStatus\[\]\)\.map\(/);
  });
  it('Support: the status row wraps', () => {
    expect(read('src/features/admin/AdminSupportPage.tsx'))
      .toMatch(/<div className="flex flex-wrap gap-3 animate-fade-in-up">\s*\{STATUS_OPTIONS\.map\(/);
  });
});

// ---- the last pass (milestone 1, fix wave F1) --------------------------------------------------------------------

describe('Weights the page loads, and the waiting-call card above the phone bar (fix wave F1)', () => {
  const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const WEIGHT: Record<string, number> = { thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
  const heaviestInter = () => {
    const link = read('index.html').match(/family=Inter:wght@([\d;]+)/);
    if (!link) throw new Error('the Inter link is not where this test looks');
    return Math.max(...link[1].split(';').map(Number));
  };

  it('Inter is loaded up to 800, so nothing in REASON asks for a heavier weight (font-black is 900: the browser would draw 800 and call it 900)', () => {
    const heaviest = heaviestInter();
    expect(heaviest).toBe(800);
    const files = walk('src/features/reason');
    expect(files.length).toBeGreaterThan(20);
    const tooHeavy: string[] = [];
    for (const file of files) {
      const src = read(file).replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/(?<![\w-])font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)(?![\w-])|(?<![\w-])font-\[(\d{3})\]/g)) {
        const weight = m[1] ? WEIGHT[m[1]] : Number(m[2]);
        if (weight > heaviest) tooHeavy.push(`${file}: ${m[0]}`);
      }
    }
    expect(tooHeavy).toEqual([]);
  });

  // Measured in Chromium with the home-indicator inset emulated (34px) and without: the card's bottom edge is 27px above
  // the bar's top edge in both. The inset reaches the card through its margin: a fixed box with `bottom` set is placed
  // by its margin edge, so `marginBottom: env(safe-area-inset-bottom)` lifts it by the inset, like the bar's own padding.
  // Without that margin the card would sit 96px up on a bar that is 103px tall, and overlap it by 7px.
  it('the waiting-call card stays above the phone bar with or without a home indicator: bottom-24 plus the inset as its margin, against the bar\'s height plus the same inset', () => {
    const card = read('src/features/messages/CallRequest.tsx').match(/<div\s+className="(fixed [^"]*)"\s+style=\{\{([^}]*)\}\}\s+role="status"\s+data-testid="call-waiting"/);
    expect(card).not.toBeNull();
    const liftedByInset = /marginBottom: 'env\(safe-area-inset-bottom\)'/.test(card![2]);
    const offset = Number(card![1].match(/(?<![\w-])bottom-(\d+)(?![\w-])/)?.[1]) * 4; // Tailwind: n * 0.25rem = n * 4px
    expect(offset).toBe(96);

    const nav = read('src/features/reason/shell/MobileNav.tsx');
    const tab = Number(nav.match(/const TAB = '[^']*\bmin-h-\[(\d+)px\]/)?.[1]);
    const above = Number(nav.match(/<nav[^>]*\bpt-(\d+(?:\.\d+)?)\b/)?.[1]) * 4;
    const below = Number(nav.match(/<nav[^>]*\bpb-\[calc\((\d+)px\+env\(safe-area-inset-bottom\)\)\]/)?.[1]);
    expect(nav).toMatch(/<nav[^>]*\bborder-t\b/);
    for (const v of [tab, above, below]) expect(Number.isFinite(v)).toBe(true);

    for (const inset of [0, 34, 47]) {
      const barHeight = 1 + above + tab + below + inset;
      const cardBottom = offset + (liftedByInset ? inset : 0);
      expect({ inset, barHeight, cardBottom, clear: cardBottom - barHeight >= 8 }).toEqual({ inset, barHeight, cardBottom, clear: true });
    }
  });
});

describe('Admin users does not scroll <main> sideways at phone widths (fix wave F1)', () => {
  // A 70-character name and a 60-character e-mail pushed <main> 449px sideways at 360 and 419px at 390: the badges and the
  // action row could not wrap, and the name block could not shrink below its longest word.
  it('Users: every flex item between the card and the name can shrink, the name breaks, the avatar keeps its size, and the badges and the action row wrap', () => {
    const page = read('src/features/admin/AdminUsersPage.tsx');
    // break-words does nothing for a flex item that cannot shrink: the row, the link and the block are all min-w-0.
    expect(page).toMatch(/<div className="flex items-center justify-between gap-3">\s*<div className="flex min-w-0 items-center gap-3">/);
    expect(page).toMatch(/<a href=\{`\/admin\/users\/\$\{u\.id\}`\} className="flex min-w-0 items-center gap-3 hover:opacity-80 transition-opacity">/);
    expect(page).toMatch(/<Avatar [^>]*size="sm" className="shrink-0" \/>\s*<div className="min-w-0 break-words">/);
    expect(page).toMatch(/<div className="flex flex-wrap items-center gap-2">\s*<Badge variant=\{u\.role ===/);
    expect(page).toMatch(/<div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-gray-100">/);
  });
});

describe('The tour\'s first card names what the preview shows (polish pass)', () => {
  // HowRsnWorks.tsx, run: the cards are read from its own export, and each card's picture is drawn to markup.
  const cards = () => {
    const tour = loadModule('src/features/onboarding/HowRsnWorks.tsx', {
      '@/components/ui/Button': { Button: () => null },
      '@/components/brand/SheepAvatar': { default: () => null },
    });
    return (tour.TOUR_CARDS as Array<{ title: string; body: string; visual: ReactElement }>).map((card) => ({
      title: card.title,
      body: card.body,
      // The words in the picture, one text node each.
      words: renderToStaticMarkup(card.visual).replace(/<[^>]*>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean),
    }));
  };

  it('card 1 is "For You" and tells the member to tap Meet, and its picture shows a Meet button', () => {
    const [first] = cards();
    expect(first.title).toBe('For You');
    expect(first.body).toBe("We suggest people who match your intent. Tap 'Meet' to ask.");
    expect(first.words).toEqual(['Amara Okafor', 'Founder · Northwind', 'Meet', 'Tomas Lind', 'Investor · Baltic Seed']);
  });

  it('there are still four cards, and the other three are the client\'s deck copy, word for word', () => {
    const all = cards();
    expect(all).toHaveLength(4);
    expect(all.slice(1)).toEqual([
      {
        title: 'Matches',
        body: "When they want to meet you too, it's a match - you'll see it here and in chat.",
        words: ['Amara Okafor', 'Matched', 'Tomas Lind', 'Asked, waiting', 'Priya Raman', 'Wants to meet you'],
      },
      {
        title: 'Meetings',
        body: 'Share your availability, pick a green slot - we create the meeting with a link.',
        words: ['9:00', '9:30', '10:00', '10:30', '11:00', 'Both can', '11:30', 'Meeting confirmed · Join'],
      },
      {
        title: 'Circles & events',
        body: 'Join circles of people who share your intent, and networking events.',
        words: ['Founders', 'Join', 'AI Developers', 'Join', 'Thursday networking'],
      },
    ]);
  });
});
