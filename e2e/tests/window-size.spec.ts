import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { launchBrowser } from '../helpers/engine';
import { inNewWindows } from '../helpers/window-size';

// ─────────────────────────────────────────────────────────────────────────────
// 8 Oct 2026 — what e2e/helpers/window-size.ts decides about a window with no size, in real browser windows.
//
// The fault itself (a headed WebKit window with a phone's descriptor that reads 0 wide and 0 high) cannot be
// had on demand, so a window is made to read like one: its innerWidth and innerHeight answer 0, for good
// (`lost`), or until a moment (`blink`). That is all the helper looks at. No site is opened.
//
//   a window lost from the start        -> the body is run again in a new window and passes there
//   every window lost                   -> three windows in all, then the failure stands
//   a defect in a window that has a size -> one window, the failure stands
//   a 0 that is only a moment (a navigation) -> two reads about a second apart: the window has a size
//                                          again by the second, so the failure stands and nothing is re-run
//   and every line a re-run discards is logged, not only the first.
// ─────────────────────────────────────────────────────────────────────────────

interface Opened { ctx: BrowserContext; page: Page }

/** A new window. `lost`: reads 0x0 for good. Any window can be made to read 0x0 for a moment with blink(). */
async function openWindow(browser: Browser, lost: boolean): Promise<Opened> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((isLost: boolean) => {
    const w = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const h = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const state = window as unknown as { __lost: boolean; __zeroUntil: number };
    state.__lost = isLost;
    state.__zeroUntil = 0;
    const reads = (real: PropertyDescriptor | undefined) => ({
      configurable: true,
      get: () => (state.__lost || Date.now() < state.__zeroUntil ? 0 : (real?.get ? real.get.call(window) : 0)),
    });
    Object.defineProperty(window, 'innerWidth', reads(w));
    Object.defineProperty(window, 'innerHeight', reads(h));
  }, lost);
  const page = await ctx.newPage();
  await page.goto('about:blank');
  return { ctx, page };
}

/** The window reads 0x0 for the next `ms`, as it can right after a navigation. */
async function blink(page: Page, ms: number): Promise<void> {
  await page.evaluate((m) => { (window as unknown as { __zeroUntil: number }).__zeroUntil = Date.now() + m; }, ms);
}

const sizeOf = (page: Page) => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

/** What the helper logs while `run` runs. */
async function logged(run: () => Promise<unknown>): Promise<{ lines: string[]; error: unknown }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  let error: unknown = null;
  try { await run(); } catch (e) { error = e; } finally { console.log = original; }
  return { lines, error };
}

test.describe('a window with no size, and what a test does about it', () => {
  let browser: Browser;
  test.beforeAll(async () => { browser = await launchBrowser(); });
  test.afterAll(async () => { await browser.close(); });

  test('the first window lost: the body is run again in a new window and passes there', async () => {
    let windows = 0;
    const { lines, error } = await logged(() => inNewWindows<Opened>({
      open: () => openWindow(browser, ++windows === 1),
      body: async ({ page }) => { expect((await sizeOf(page)).w).toBeGreaterThan(0); },
    }));
    expect(error).toBeNull();
    expect(windows).toBe(2);
    expect(lines.filter((l) => /a new window, attempt 2 of 3/.test(l))).toHaveLength(1);
  });

  test('every window lost: three windows in all, and then the failure stands', async () => {
    let windows = 0;
    const { lines, error } = await logged(() => inNewWindows<Opened>({
      open: () => { windows += 1; return openWindow(browser, true); },
      body: async ({ page }) => { expect((await sizeOf(page)).w).toBeGreaterThan(0); },
    }));
    expect(windows).toBe(3);
    expect(String((error as Error)?.message)).toMatch(/toBeGreaterThan/);
    expect(lines.filter((l) => /a new window, attempt \d of 3/.test(l))).toHaveLength(2);
  });

  test('a defect in a window that has a size: one window, and the failure stands', async () => {
    let windows = 0;
    const { lines, error } = await logged(() => inNewWindows<Opened>({
      open: () => { windows += 1; return openWindow(browser, false); },
      body: async () => { throw new Error('the Accept button is missing'); },
    }));
    expect(windows).toBe(1);
    expect((error as Error).message).toBe('the Accept button is missing');
    expect(lines.filter((l) => /a new window/.test(l))).toHaveLength(0);
  });

  test('a 0 that is only a moment: the window has a size by the second read, so the failure stands and nothing is run again', async () => {
    let windows = 0;
    const { lines, error } = await logged(() => inNewWindows<Opened>({
      open: () => { windows += 1; return openWindow(browser, false); },
      body: async ({ page }) => {
        // A navigation has just finished: for the next 600 ms the window reads 0x0, and then it reads its size again.
        await blink(page, 600);
        throw new Error('the Accept button is missing');
      },
    }));
    expect(windows).toBe(1);
    expect((error as Error).message).toBe('the Accept button is missing');
    expect(lines.filter((l) => /a new window/.test(l))).toHaveLength(0);
  });

  test('every line a re-run discards is logged, the one that was thrown and each one the body had recorded', async () => {
    let windows = 0;
    const problems: string[] = [];
    const { lines, error } = await logged(() => inNewWindows<Opened>({
      open: () => openWindow(browser, ++windows === 1),
      problems,
      body: async ({ page }) => {
        const { w } = await sizeOf(page);
        if (w === 0) {
          problems.push('1280: the Confirm button is off the window');
          problems.push('1280: the sheet is wider than the window');
          problems.push('390: the Send button is covered');
          throw new Error('the page never showed');
        }
      },
    }));
    expect(error).toBeNull();
    expect(windows).toBe(2);
    expect(problems).toEqual([]); // the lines of the window that was replaced are taken out
    const all = lines.join('\n');
    expect(all).toContain('the page never showed');
    expect(all).toContain('1280: the Confirm button is off the window');
    expect(all).toContain('1280: the sheet is wider than the window');
    expect(all).toContain('390: the Send button is covered');
  });
});
