import type { BrowserContext, Page } from '@playwright/test';
import { contextOptions, engineLabel } from './engine';

// Windows that have no size, and what a test does about them.
//
// Playwright's WebKit with a phone's descriptor (headed, on Windows) now and then gives a window that is 0 wide and 0 high,
// for a moment or for the rest of its life, from its first moment or a second after the page has loaded. A probe that only
// opened the sign-in page found 2 windows in 84 like that, and never in Chromium; desktop WebKit has done it once too, in a
// 430px window. A page cannot set its own innerWidth, so it is the emulation and not the page. Nothing can be looked at in
// such a window: every box is "off the window" and a hit test finds nothing. Applying the viewport again (the same size, or
// one pixel off and back), bringToFront and a reload all left such a window at 0x0, while a new page in the same context and
// a new context were fine.
//
// So a window with no size is dealt with in two steps (a failure in a window that HAS a size is never run again):
//   1. untilSized: a measurement waits for the window to have a size, applies the context's own viewport once if it still
//      reads 0, and waits some more. That is for a size that is missing for a moment.
//   2. inNewWindows: a test that fails while one of its windows has no size has not judged the app, so it is run again in a
//      new window, three windows at most, and every re-run is logged with the failure that caused it.

/** How many windows one test body may use in all: the first and two more. */
const WINDOW_ATTEMPTS = 3;

/** How long a measurement waits for a window to have a size. It waits this long twice when the viewport has to be applied again. */
const WAIT_MS = 5_000;
/** How long the probe waits for a page to say what size its window is: a page in a bad state may never answer. */
const PROBE_MS = 5_000;

const log = (line: string): void => console.log(`  [window-size] ${engineLabel()}: ${line}`);
const firstLine = (what: unknown): string => String((what as Error)?.message ?? what).split('\n')[0];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface WindowSize { w: number; h: number }
/** The single definition of a window with no size. */
const hasNoSize = (s: WindowSize): boolean => s.w <= 0 || s.h <= 0;

/** The size the page reads for its window right now; null when it cannot say (between two documents, closed, stuck). */
async function readWindow(page: Page): Promise<WindowSize | null> {
  const asked = page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PROBE_MS); });
  try {
    return await Promise.race([asked, gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks again, every 100 ms for up to 5 seconds, until the answer comes from a document that is complete in a window with a
 * width and a height above 0. The question works that out itself and says so in `sized`, in the same instant as it
 * measures, so the size and the measurement can never be from different moments. Only "execution context was destroyed"
 * (the page between two documents) is asked again; any other error (an element that is not there, a closed page) goes
 * straight through.
 */
async function askUntilSized<T extends { sized: boolean }>(ask: () => Promise<T>): Promise<T | null> {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    let answer: T | null = null;
    try {
      answer = await ask();
    } catch (e) {
      if (!/Execution context was destroyed|Cannot find context with specified id/i.test(String((e as Error)?.message ?? e))) throw e;
    }
    if (answer?.sized) return answer;
    if (Date.now() >= until) return answer;
    await sleep(100);
  }
}

/**
 * A question that depends on the window's size, asked until the window has one (see askUntilSized), and answered by
 * `null` or by an answer whose `sized` is false when it never does. What is measured once the window has a size is judged
 * as strictly as ever; a window that never gets one is reported as that, not measured.
 *
 * Right after a navigation the window can read 0 for a moment (one run measured "scrollWidth 390 over 0"). It is not always
 * a moment: it has also answered 0 wide and 0 high, document complete, for the whole 5 seconds. So when the window itself
 * still reads 0 after the first 5 seconds, the page is nudged once, by applying the viewport it already has, and the
 * question is asked for 5 seconds more. (A document that never finishes loading is not nudged: a viewport cannot help it.)
 * The nudge has not been seen to cure a window that was lost for good, so such a window costs these 10 seconds before the
 * test fails and inNewWindows runs it again.
 */
export async function untilSized<T extends { sized: boolean }>(page: Page, ask: () => Promise<T>): Promise<T | null> {
  const first = await askUntilSized(ask);
  if (first?.sized) return first;
  const read = await readWindow(page);
  if (!read || !hasNoSize(read)) return first;
  const viewport = page.viewportSize() ?? contextOptions().viewport ?? { width: 390, height: 844 };
  log(`the window read ${read.w}x${read.h} for ${WAIT_MS / 1000} s; applying the viewport ${viewport.width}x${viewport.height} again`);
  await page.setViewportSize(viewport);
  const second = await askUntilSized(ask);
  log(second?.sized ? 'the window measured again after that' : 'the window is still without a size after that');
  return second;
}

/** The pages of a browser context whose window has no size right now, each as "WxH". */
async function windowsWithoutSize(ctx: BrowserContext): Promise<string[]> {
  const lost: string[] = [];
  for (const page of ctx.pages()) {
    if (page.isClosed()) continue;
    const read = await readWindow(page);
    if (read && hasNoSize(read)) lost.push(`${read.w}x${read.h}`);
  }
  return lost;
}

interface NewWindows<O extends { ctx: BrowserContext }> {
  /** A fresh window: a new, signed-in browser context and its page. */
  open: () => Promise<O>;
  /** What the test does in that window. It fails by throwing. */
  body: (o: O) => Promise<void>;
  /**
   * For a test that collects its failures as lines and judges them at its end, instead of throwing them: a line the body
   * adds to this list is a failure of that body. When the body is run again, the lines of the window it replaces are
   * taken out, so that only the window that judged the app is left standing.
   */
  problems?: string[];
  /** Puts the test's data back as it was when the test began; runs before the body is run again, never before the first. */
  beforeRerun?: () => Promise<void>;
}

/**
 * Runs a test body in a new window. A body that fails (throws, or adds a line to `problems`) while one of the pages of its
 * window has no size is run again in another new window, up to WINDOW_ATTEMPTS windows in all, and the run says so, with
 * the failure that caused it. A body that fails in a window that has a size is never run again: nothing is retried on the
 * app's account, and the last window's failure is the test's failure, in its own words. Every window is closed.
 */
export async function inNewWindows<O extends { ctx: BrowserContext }>(run: NewWindows<O>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1) await run.beforeRerun?.();
    const before = run.problems?.length ?? 0;
    const o = await run.open();
    try {
      let thrown: { error: unknown } | null = null;
      try {
        await run.body(o);
      } catch (error) {
        thrown = { error };
      }
      const recorded = run.problems?.slice(before) ?? [];
      if (!thrown && recorded.length === 0) return;
      const lost = attempt < WINDOW_ATTEMPTS ? await windowsWithoutSize(o.ctx) : [];
      if (lost.length === 0) {
        if (thrown) throw thrown.error;
        return;
      }
      run.problems?.splice(before);
      log(`the window had no size (${lost.join(', ')}) when this failed: "${firstLine(thrown ? thrown.error : recorded[0])}". That is the emulation, not the page: a new window, attempt ${attempt + 1} of ${WINDOW_ATTEMPTS}`);
    } finally {
      await o.ctx.close().catch(() => undefined);
    }
  }
}
