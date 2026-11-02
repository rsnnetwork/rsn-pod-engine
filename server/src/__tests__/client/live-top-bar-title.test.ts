// ─── The live room's top bar keeps the event's title on a phone (2 Nov 2026) ─────────────────────────
//
// On a 390px iPhone the room-state chip "Main Room · Round 1 of 5" (~191px) and the participants button with
// Leave Event (~151px) filled the one-line top bar, and the title's flex-1 box was squeezed to 0px: a member on a
// phone never saw the event's title. Now:
//   - under 640px the chip shows a short text ("Round 1/5"); the full text stays for screen readers and as its title;
//   - the title asks for at least 10rem before it shares the line; when the controls leave less, the bar wraps and
//     the title takes its own line above them (it truncates with an ellipsis, it never vanishes);
//   - the controls are one group that never shrinks, so Leave Event keeps its 44px and is never clipped;
//   - the bar keeps clear of a notch (safe-area insets on top, left and right).
// The chip's words are a pure function and are run here; the bar's layout is read from its source. The real
// layout is proven in a browser by e2e/tests/live-top-bar-title-phone.spec.ts.

import { loadClientModule, readClientSource } from './load-client-module';

interface ChipText {
  eventStateChipText: (sessionStatus: string, currentRound: number, totalRounds: number) => { full: string; short: string };
}

const chip = () => loadClientModule('features/live/event-state-chip.ts', {}) as unknown as ChipText;

describe('the room-state chip has a short text for phones', () => {
  it('keeps the full text it always had', () => {
    const { eventStateChipText } = chip();
    expect(eventStateChipText('lobby_open', 1, 5).full).toBe('Main Room · Round 1 of 5');
    expect(eventStateChipText('round_active', 2, 5).full).toBe('Breakout Rooms · Round 2');
    expect(eventStateChipText('round_rating', 2, 5).full).toBe('Rating · Round 2 of 5');
    expect(eventStateChipText('round_transition', 3, 5).full).toBe('Main Room · Round 3 of 5');
    expect(eventStateChipText('closing_lobby', 5, 5).full).toBe('Round 5 of 5');
    expect(eventStateChipText('scheduled', 0, 5).full).toBe('Waiting to start');
    expect(eventStateChipText('completed', 5, 5).full).toBe('Event ended');
    expect(eventStateChipText('lobby_open', 0, 0).full).toBe('Main Room');
  });

  it('says the round as "Round n/N" on a phone, and Rating stays named', () => {
    const { eventStateChipText } = chip();
    expect(eventStateChipText('lobby_open', 1, 5).short).toBe('Round 1/5');
    expect(eventStateChipText('round_active', 2, 5).short).toBe('Round 2/5');
    expect(eventStateChipText('round_transition', 3, 5).short).toBe('Round 3/5');
    expect(eventStateChipText('closing_lobby', 5, 5).short).toBe('Round 5/5');
    expect(eventStateChipText('round_rating', 2, 5).short).toBe('Rating 2/5');
    expect(eventStateChipText('lobby_open', 0, 5).short).toBe('Round 1/5');
  });

  it('keeps a text that is already short when there is no round count', () => {
    const { eventStateChipText } = chip();
    expect(eventStateChipText('scheduled', 0, 5).short).toBe('Waiting to start');
    expect(eventStateChipText('completed', 5, 5).short).toBe('Event ended');
    expect(eventStateChipText('lobby_open', 0, 0).short).toBe('Main Room');
    expect(eventStateChipText('round_active', 2, 0).short).toBe('Round 2');
    expect(eventStateChipText('unknown_status', 0, 0).full).toBe('Waiting to start');
  });

  it('is never longer than 16 characters on a phone', () => {
    const { eventStateChipText } = chip();
    for (const status of ['scheduled', 'lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby', 'completed']) {
      expect(eventStateChipText(status, 12, 12).short.length).toBeLessThanOrEqual(16);
    }
  });
});

describe('the live top bar keeps the title readable', () => {
  const page = () => readClientSource('features/live/LiveSessionPage.tsx');
  const topBar = () => {
    const src = page();
    const start = src.indexOf('data-testid="live-top-bar"');
    expect(start).toBeGreaterThan(-1);
    return src.slice(src.lastIndexOf('<div', start), src.indexOf('{/* (UX1) Event-state row removed', start));
  };

  // Final fix wave C3 (2 Nov 2026): the room's root already pads clear of the notch and the rounded corners
  // (pt/pl/pr-[env(safe-area-inset-*)]); main's bar, merged inside it, padded again, so on an iPhone the bar sat a
  // second notch's height below the notch, and in landscape its title and Leave Event moved in twice. The insets are
  // the root's, once; the bar keeps only its own spacing.
  it('wraps instead of squeezing the title, and clears the notch once: the root holds the insets, the bar none', () => {
    const bar = topBar();
    const open = bar.slice(0, bar.indexOf('>'));
    expect(open).toMatch(/\bflex-wrap\b/);
    expect(open).not.toMatch(/safe-area-inset/);
    expect(open).toMatch(/\bpx-4 pt-1\.5 pb-1\.5\b/);
    const src = page();
    const root = src.slice(src.indexOf('<div className="h-[100dvh] bg-white flex flex-col'), src.indexOf('data-testid="live-top-bar"'));
    const rootOpen = root.slice(0, root.indexOf('>'));
    expect(rootOpen).toContain('pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]');
    expect(src.match(/safe-area-inset-top/g)?.length).toBe(1);
  });

  it('gives the title at least 10rem of its own before it shares the line, truncating with an ellipsis', () => {
    const bar = topBar();
    const at = bar.indexOf('data-testid="live-top-bar-title"');
    const title = bar.slice(bar.lastIndexOf('<h2', at));
    const titleBox = bar.slice(bar.lastIndexOf('<div', at), at);
    expect(titleBox).toMatch(/flex-\[1_1_10rem\]/);
    expect(titleBox).toMatch(/\bmin-w-0\b/);
    expect(titleBox).not.toMatch(/\bflex-1\b/);
    expect(title).toMatch(/<h2[^>]*\btruncate\b[^>]*>\{session\?\.title \|\| 'Live Event'\}<\/h2>/);
  });

  it('keeps the chip, the count, Participants and Leave Event in one group that never shrinks', () => {
    const bar = topBar();
    const groupAt = bar.indexOf('data-testid="live-top-bar-controls"');
    expect(groupAt).toBeGreaterThan(-1);
    const groupOpen = bar.slice(bar.lastIndexOf('<div', groupAt), bar.indexOf('>', groupAt));
    expect(groupOpen).toMatch(/\bshrink-0\b/);
    expect(groupOpen).toMatch(/\bml-auto\b/);
    const group = bar.slice(groupAt);
    expect(group.indexOf('<EventStateBanner')).toBeGreaterThan(-1);
    expect(group.indexOf('<TopBarParticipantCount')).toBeGreaterThan(group.indexOf('<EventStateBanner'));
    expect(group.indexOf('Leave Event')).toBeGreaterThan(group.indexOf('<TopBarParticipantCount'));
    expect(group).toMatch(/min-h-\[44px\][^"]*"\s*>\s*<LogOut className="h-4 w-4" \/> Leave Event/);
  });

  it('draws the short chip text under 640px and the full text above, which a screen reader always hears', () => {
    const src = page();
    const banner = src.slice(src.indexOf('function EventStateBanner'), src.indexOf('function TopBarParticipantCount'));
    expect(banner).toMatch(/eventStateChipText\(sessionStatus, currentRound, totalRounds\)/);
    expect(banner).toMatch(/title=\{full\}/);
    expect(banner).toMatch(/<span className="whitespace-nowrap sm:hidden" aria-hidden="true">\{short\}<\/span>/);
    expect(banner).toMatch(/<span className="sr-only sm:not-sr-only whitespace-nowrap">\{full\}<\/span>/);
    expect(src).toMatch(/import \{ eventStateChipText \} from '\.\/event-state-chip';/);
  });
});

// ─── Production fix (2 Nov 2026): a toast never covers the live top bar ───────────────────────────────────
//
// On production the phone spec found Leave Event under "Thanks, we will use this for your matches.", the success
// toast a member gets on pressing Set on the event check-in. The toasts were `fixed top-4 right-4`: on a phone that
// box (y 16 to 90, almost the full width) lay over the whole top bar (the title, the chip, Participants and Leave
// Event) for 2.5s, and 6s for an error. It did so before the title fix as well. In the live room the toasts now open
// just below the top bar, so they never cover its controls; every other page keeps its toast position.

interface ToastModule { default: (props: { hostQuiet?: boolean; placement?: 'viewport' | 'below-bar' }) => unknown }

function drawToasts(props: { hostQuiet?: boolean; placement?: 'viewport' | 'below-bar' }): string {
  // Loaded inside a test so a missing piece fails that test with a message.
  /* eslint-disable @typescript-eslint/no-var-requires -- react and react-dom/server are only needed by this block */
  const { createElement, Fragment } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { iconStandIns } = require('./load-client-module');
  /* eslint-enable @typescript-eslint/no-var-requires */
  const toasts = [{ id: 't1', type: 'success', message: 'Thanks, we will use this for your matches.' }];
  const mod = loadClientModule('components/ui/Toast.tsx', {
    'framer-motion': { motion: { div: 'div' }, AnimatePresence: Fragment },
    'lucide-react': iconStandIns,
    '@/stores/toastStore': { useToastStore: () => ({ toasts, removeToast: () => undefined }) },
  }) as unknown as ToastModule;
  return renderToStaticMarkup(createElement(mod.default, props));
}

/** The class list of the toast stack's own element. */
const stackClasses = (html: string): string[] => (html.match(/^<div[^>]*class="([^"]*)"/)?.[1] ?? '').split(/\s+/);

describe('a toast in the live room opens below the top bar, never over it', () => {
  it('keeps every other page as it was: fixed to the top right of the window', () => {
    const html = drawToasts({});
    expect(html).toContain('Thanks, we will use this for your matches.');
    const classes = stackClasses(html);
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'top-4', 'right-4', 'z-[210]', 'sm:max-w-sm']));
  });

  it('opens just below its bar, inside the screen with the notch kept clear, when placed below the bar', () => {
    const html = drawToasts({ placement: 'below-bar' });
    expect(html).toContain('Thanks, we will use this for your matches.');
    const classes = stackClasses(html);
    expect(classes).toEqual(expect.arrayContaining(['absolute', 'top-full', 'mt-2', 'z-[210]', 'sm:left-auto', 'sm:max-w-sm']));
    expect(classes).not.toContain('fixed');
    expect(classes).not.toContain('top-4');
    // C3: it hangs inside the room's root, which already keeps clear of the rounded corners, so its sides are its own
    // spacing only (an inset here was the second one).
    expect(classes).toEqual(expect.arrayContaining(['left-4', 'right-4']));
    expect(classes.some((c) => /safe-area-inset/.test(c))).toBe(false);
  });

  it('draws a solid card in both placements, so the room under it never shows through its words', () => {
    const card = (html: string) => html.match(/<div[^>]*\sclass="([^"]*rounded-xl[^"]*)"/)?.[1].split(/\s+/) ?? [];
    for (const placement of ['below-bar', 'viewport'] as const) {
      const classes = card(drawToasts({ placement }));
      expect(classes).toEqual(expect.arrayContaining(['bg-emerald-50', 'border-emerald-600', 'shadow-lg']));
      // No see-through background (a Tailwind opacity suffix such as bg-emerald-500/10).
      expect(classes.filter((c) => c.startsWith('bg-') && c.includes('/'))).toEqual([]);
    }
  });

  it('still shows the host only actionable errors', () => {
    expect(drawToasts({ placement: 'below-bar', hostQuiet: true })).not.toContain('Thanks, we will use this');
  });

  it('is drawn inside the live top bar, which is its positioned parent, and only there', () => {
    const src = readClientSource('features/live/LiveSessionPage.tsx');
    expect(src.match(/<ToastContainer\b/g)).toHaveLength(1);
    const barAt = src.indexOf('data-testid="live-top-bar"');
    const barOpen = src.slice(src.lastIndexOf('<div', barAt), src.indexOf('>', barAt));
    expect(barOpen.split(/className="/)[1]).toMatch(/^relative\b|\srelative\s/);
    const toastAt = src.indexOf('<ToastContainer');
    expect(toastAt).toBeGreaterThan(barAt);
    expect(toastAt).toBeLessThan(src.indexOf('data-testid="live-top-bar-title"'));
    expect(src.slice(toastAt, src.indexOf('/>', toastAt))).toMatch(/hostQuiet=\{isHost\}\s+placement="below-bar"/);
  });
});
