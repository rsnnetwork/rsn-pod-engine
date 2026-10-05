// e2e/tests/live-screens-oct5.spec.ts
//
// The 5 Oct 2026 clean-up of four live screens, proven on production right after the deploy.
//
//   1. Messages   a long meeting request can be read in full on a phone: "Show more" appears
//                 only when the note really is cut off, follows the width of the window, flips
//                 to "Show less" with aria-expanded, and never appears on a short request
//   2. Messages   /messages?poke=<id> never calls a request that is still pending "already
//                 answered", even when the list of requests arrives after the request itself;
//                 an answered request still says so, or opens its conversation
//   3. The bell   keeps the line break between a member's note and "Why REASON suggested this:"
//   4. Matches    the open page updates on its own when a request is sent from another tab and
//                 when the other member answers it, with no reload
//
// Every check is on an outcome: what the screen shows, measured in the browser, next to the
// row in the database (or the socket event that really arrived), never "the page looked right".
//
// Needs the deploy first: the checks fail on the old client. Run it one engine at a time, and
// one spec per process (the database pool is shared):
//   cd e2e
//   npx playwright test tests/live-screens-oct5.spec.ts
//   E2E_ENGINE=webkit npx playwright test tests/live-screens-oct5.spec.ts
//   E2E_ENGINE=webkit E2E_DEVICE='iPhone 14' npx playwright test tests/live-screens-oct5.spec.ts
// E2E_JWT_SECRET must be production's signing key, or every call below is a 401.

import { test, expect, Browser, BrowserContext, Page, Locator } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, connectSocket, wait, APP, SERVER } from '../helpers/live-ui';
import type { Socket } from '../helpers/live-ui';
import { launchBrowser, engineLabel, contextOptions } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

// One id per run keeps every address, name and word unique and traceable.
const RUN = Date.now().toString(36);
const SHOTS = path.resolve(__dirname, '../../workspace/scratch/2026-10-05-live-screens-shots');
const DEVICE = process.env.E2E_DEVICE;

let browser: Browser | undefined;
const ctxs: BrowserContext[] = [];
const sockets: Socket[] = [];
// Every throwaway account, pushed the moment it exists, removed by exact id in afterAll.
const made: string[] = [];

// ── HTTP ─────────────────────────────────────────────────────────────────────

interface Envelope<T> { success?: boolean; data?: T; error?: { code?: string; message?: string } }

// u = null sends no Authorization header at all.
async function api<T = unknown>(u: TestUser | null, method: string, apiPath: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (u) headers.Authorization = `Bearer ${u.accessToken}`;
  const res = await fetch(`${SERVER}/api${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // The envelope is read loosely on purpose: an error reply has no data, a 500 may not be JSON.
  const parsed = (await res.json().catch(() => null)) as Envelope<T> | null;
  return { status: res.status, body: parsed };
}

// The reply's data, or an error that shows what the server actually said.
function dataOf<T>(r: { status: number; body: Envelope<T> | null }, what: string): T {
  if (r.body?.data === undefined) {
    throw new Error(`${what}: no data in the reply (HTTP ${r.status}) ${JSON.stringify(r.body)}`);
  }
  return r.body.data;
}

interface PokeJson { id: string; senderId: string; recipientId: string; status: string; message: string | null }
interface AcceptedJson { poke: PokeJson; conversationId: string }
interface MatchesJson { matches: Array<{ userId: string; reason: string; pokeStatus?: string | null; pokeSentByOwner?: boolean | null }> }

// ── Accounts ─────────────────────────────────────────────────────────────────

interface Profile {
  /** The name other members see. */
  name?: string;
  /** What the member says they want to meet (users.who_i_want_to_meet). */
  want?: string;
  /** What the member says they offer (users.expertise_text). */
  offer?: string;
}

// Resend refuses @example.com, and the request email would then log a 500 on
// Render. delivered+label@resend.dev is accepted and never reaches a real inbox.
async function makeUser(label: string, profile: Profile = {}): Promise<TestUser> {
  const u = await createTestUser(`c2-${label}`);
  made.push(u.id);
  const email = `delivered+c2-${RUN}-${label}@resend.dev`;
  await pool.query(
    `UPDATE users
        SET email = $2,
            display_name = COALESCE($3, display_name),
            who_i_want_to_meet = COALESCE($4, who_i_want_to_meet),
            expertise_text = COALESCE($5, expertise_text)
      WHERE id = $1`,
    [u.id, email, profile.name ?? null, profile.want ?? null, profile.offer ?? null],
  );
  return { ...u, email };
}

// Three words only this test uses, so no real member can fit a test account and no two test
// accounts of different sets fit each other. The matcher reads two words of eight letters or
// more as the same word when their first seven letters agree (isRelatedTerm), so each word
// starts with its own four letters and then the last four digits of this run's id.
const WORD_STEMS = [
  ['quil', 'marb', 'snor'],
  ['zeph', 'tarv', 'glim'],
  ['brol', 'fenx', 'korp'],
];
function madeUpWords(set: 0 | 1 | 2): string {
  return WORD_STEMS[set].map((stem) => `${stem}${RUN.slice(-4)}ward`).join(' ');
}

// ── Sockets ──────────────────────────────────────────────────────────────────

interface EntityLog {
  countOf(tag: string): number;
  all(): string[];
}

// Connect as the member and keep every entity:changed the server sends them.
async function listen(u: TestUser): Promise<EntityLog> {
  const sock = await connectSocket(u);
  sockets.push(sock);
  const events: string[][] = [];
  sock.on('entity:changed', (payload: { entities?: string[] }) => {
    events.push(Array.isArray(payload?.entities) ? payload.entities : []);
  });
  return {
    countOf: (tag) => events.filter((e) => e.includes(tag)).length,
    all: () => Array.from(new Set(events.flat())),
  };
}

async function waitForTag(log: EntityLog, tag: string, moreThan: number, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (log.countOf(tag) > moreThan) return;
    await wait(100);
  }
  throw new Error(`${label}: no entity:changed carrying ${tag} within ${ms / 1000}s. Heard: ${log.all().join(', ') || 'nothing'}`);
}

// ── Browser ──────────────────────────────────────────────────────────────────

// The browser's own notice that a resize observer needed another frame. It is not an
// application error, and the Messages page does use a resize observer.
const BENIGN_PAGE_ERROR = /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i;

const firstLineOf = (e: unknown): string => String((e as Error)?.message ?? e).split('\n')[0];

interface Viewport { width: number; height: number }

// A signed-in page for the member. With E2E_DEVICE set, the device's own viewport is used.
// `noFocusRefetch` stops the page from hearing that its window was shown again. The app
// refetches whatever it is showing when that happens, and in a headed run two windows can
// cover each other, so a page that did not update by itself could still look as if it had.
async function openAs(u: TestUser, vp: Viewport, pageErrors: string[], noFocusRefetch = false): Promise<Page> {
  browser = browser ?? await launchBrowser();
  const ctx = await browser.newContext(DEVICE ? contextOptions() : { viewport: vp });
  ctxs.push(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  if (noFocusRefetch) {
    await ctx.addInitScript(() => {
      for (const name of ['visibilitychange', 'focus']) {
        window.addEventListener(name, (e) => e.stopImmediatePropagation(), true);
      }
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    if (!BENIGN_PAGE_ERROR.test(e.message)) pageErrors.push(`${page.viewportSize()?.width ?? '?'}px ${page.url()}: ${e.message}`);
  });
  return page;
}

// Press where a finger would land, as a touch on a device and as a click otherwise. Never
// locator.click(): it scrolls for you, and a control that needs scrolling is not reachable.
async function tap(page: Page, target: Locator, label: string): Promise<void> {
  const { cx, cy } = await expectReachable(page, target, label);
  if (DEVICE) await page.touchscreen.tap(cx, cy);
  else await page.mouse.click(cx, cy);
}

const requestCard = (page: Page, pokeId: string) =>
  page.locator(`[data-testid="meeting-request"][data-poke-id="${pokeId}"]`);

// Sizes mean nothing until the stylesheet and the fonts have applied.
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.evaluate(async () => { await document.fonts.ready; });
}

// ── In-page measurements (they run inside the browser: nothing from this file) ──

interface ClampReading { clamp: string; lineHeight: number; shown: number; natural: number }

// How tall the paragraph is on screen (`shown`) and how tall the same text would be with no
// clamp (`natural`, from a hidden copy), plus its line height and its computed -webkit-line-clamp.
function measureClamp(el: HTMLElement): ClampReading {
  const cs = window.getComputedStyle(el);
  const clamp = cs.getPropertyValue('-webkit-line-clamp') || cs.getPropertyValue('line-clamp');
  const parsed = parseFloat(cs.lineHeight);
  const lineHeight = isFinite(parsed) ? parsed : parseFloat(cs.fontSize) * 1.2;
  const box = el.getBoundingClientRect();
  const probe = el.cloneNode(true) as HTMLElement;
  probe.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;display:block;overflow:visible;height:auto;max-height:none;width:' + box.width + 'px';
  probe.style.setProperty('-webkit-line-clamp', 'none');
  (el.parentElement as HTMLElement).appendChild(probe);
  const natural = probe.getBoundingClientRect().height;
  probe.remove();
  return { clamp, lineHeight, shown: box.height, natural };
}

// 'ok' when the LAST line of the paragraph is inside the window and is what a person would
// hit at that spot (not clipped by a parent, not covered).
function lastLineOnScreen(el: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return 'the paragraph has no text rectangles';
  let last = rects[0];
  for (const r of rects) if (r.bottom > last.bottom) last = r;
  if (last.top < 0 || last.bottom > window.innerHeight || last.left < 0 || last.right > window.innerWidth) {
    return 'the last line is outside the window: top=' + Math.round(last.top) + ' bottom=' + Math.round(last.bottom) + ' of ' + window.innerHeight;
  }
  const hit = document.elementFromPoint(last.left + last.width / 2, last.top + last.height / 2);
  if (!hit || !(hit === el || el.contains(hit))) {
    return 'the last line is clipped or covered by ' + (hit ? hit.tagName.toLowerCase() : 'nothing');
  }
  return 'ok';
}

interface BodyReading { whiteSpace: string; overflowWrap: string; lineHeight: number; tops: number[] }

// The computed wrapping of a paragraph, and the top edge of the first character of each
// needle, so two pieces of text can be compared by the line they sit on.
function readBody(el: HTMLElement, needles: string[]): BodyReading {
  const cs = window.getComputedStyle(el);
  const parsed = parseFloat(cs.lineHeight);
  const lineHeight = isFinite(parsed) ? parsed : parseFloat(cs.fontSize) * 1.2;
  const node = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined;
  const tops = needles.map((needle) => {
    if (!node) return NaN;
    const at = node.data.indexOf(needle);
    if (at < 0) return NaN;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + needle.length);
    // WebKit lists the line break before a range as an extra zero-width rectangle first.
    const rect = Array.from(range.getClientRects()).find((r) => r.width > 0 && r.height > 0);
    return rect ? rect.top : NaN;
  });
  return { whiteSpace: cs.whiteSpace, overflowWrap: cs.overflowWrap, lineHeight, tops };
}

// ── Hooks ────────────────────────────────────────────────────────────────────

test.beforeAll(() => {
  console.log(`[live-screens-oct5] engine=${engineLabel()} app=${APP} api=${SERVER}`);
  fs.mkdirSync(SHOTS, { recursive: true });
});

test.afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});

test.afterAll(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const c of ctxs) await c.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (made.length) await cleanup(pool, { ids: made });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Show more / Show less on a request row
// ═════════════════════════════════════════════════════════════════════════════

// Twelve short lines, one line break between each: well under 300 characters, so the
// server's fold (three or more line breaks only) leaves every one of them.
const NOTE_LINES = [
  'Line one: hello', 'Line two: coffee', 'Line three: notebook', 'Line four: station',
  'Line five: morning', 'Line six: sunshine', 'Line seven: Tuesday', 'Line eight: umbrella',
  'Line nine: bicycle', 'Line ten: harbour', 'Line eleven: lantern', 'Line twelve: goodbye',
];
const LONG_NOTE = NOTE_LINES.join('\n');
const FIRST_LINE = NOTE_LINES[0];
const LAST_LINE = NOTE_LINES[NOTE_LINES.length - 1];
const SHORT_NOTE = 'Coffee on Thursday?';

// One paragraph with no line breaks. It runs past six lines in a phone-wide request row and
// fits in four or fewer in a wide one, so the clamp depends on the width alone.
const WRAP_NOTE = 'I read your profile twice and would really like to compare notes on how you handle hiring, '
  + 'onboarding and the first ninety days, because we are growing from six people to twenty this '
  + 'year and I keep making the same mistakes in the same order. Half an hour over coffee or a '
  + 'call would be plenty, and I will bring the questions with me.';

const MATRIX: Viewport[] = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];
// With E2E_DEVICE set, the device's own viewport is the only size.
function viewports(): Viewport[] {
  if (!DEVICE) return MATRIX;
  return [contextOptions().viewport ?? { width: 390, height: 844 }];
}

const MORE = { name: 'Show more', exact: true } as const;
const LESS = { name: 'Show less', exact: true } as const;
const EITHER = /^Show (more|less)$/;

test('1. Show more: a long request can be read in full on a phone; a short one has no button', async () => {
  test.setTimeout(420_000);
  const askerLong = await makeUser('long-asker');
  const askerShort = await makeUser('short-asker');
  const reader = await makeUser('reader');

  // The short request first, so the long one (the newest) is the first row on the page.
  const shortSent = await api<PokeJson>(askerShort, 'POST', `/matches/platform/${reader.id}/interest`, { note: SHORT_NOTE });
  expect(shortSent.status, `short interest: ${JSON.stringify(shortSent.body)}`).toBe(201);
  const shortId = dataOf(shortSent, 'short interest').id;
  const longSent = await api<PokeJson>(askerLong, 'POST', `/matches/platform/${reader.id}/interest`, { note: LONG_NOTE });
  expect(longSent.status, `long interest: ${JSON.stringify(longSent.body)}`).toBe(201);
  const longId = dataOf(longSent, 'long interest').id;
  const stored = (await pool.query<{ id: string; status: string; message: string | null }>(
    `SELECT id, status, message FROM user_pokes WHERE recipient_id = $1 ORDER BY created_at`, [reader.id])).rows;
  expect(stored.map((r) => r.id), 'the reader has exactly these two pending requests, oldest first').toEqual([shortId, longId]);
  expect(stored.every((r) => r.status === 'pending')).toBe(true);
  expect(stored[1].message?.startsWith(LONG_NOTE), 'the twelve lines are stored with their single line breaks').toBe(true);

  const problems: string[] = [];
  const pageErrors: string[] = [];
  const info = test.info();
  const note = (type: string, description: string) => info.annotations.push({ type, description });
  const label = engineLabel().replace(/[^a-z0-9]+/gi, '-');

  for (const vp of viewports()) {
    const size = `${vp.width}x${vp.height}`;
    const page = await openAs(reader, vp, pageErrors);
    try {
      await gotoRetry(page, `${APP}/messages`);
      const longCard = requestCard(page, longId);
      const shortCard = requestCard(page, shortId);
      await expect(longCard, `${size}: the long request is on the page`).toContainText(FIRST_LINE, { timeout: 30_000 });
      await expect(shortCard, `${size}: the short request is on the page`).toContainText(SHORT_NOTE, { timeout: 30_000 });
      await settle(page);

      const msg = longCard.locator('p', { hasText: FIRST_LINE });
      await expect(msg, `${size}: the long note paragraph`).toHaveCount(1);
      const more = longCard.getByRole('button', MORE);
      const accept = longCard.getByRole('button', { name: /^Accept$/ });

      // Collapsed: six lines of a twelve line note, and a button to read the rest.
      const closed = await msg.evaluate(measureClamp);
      note(`collapsed-${size}`, `line height ${closed.lineHeight}px, shown ${Math.round(closed.shown)}px of ${Math.round(closed.natural)}px, clamp ${closed.clamp}`);
      expect(closed.clamp, `${size}: computed -webkit-line-clamp`).toBe('6');
      expect(closed.natural, `${size}: the note is twelve lines tall without the clamp`).toBeGreaterThanOrEqual(12 * closed.lineHeight - 2);
      expect(closed.shown, `${size}: the row shows at most six lines`).toBeLessThanOrEqual(6 * closed.lineHeight + 2);

      const moreBox = await expectReachable(page, more, `${size} "Show more"`);
      expect(moreBox.height, `${size}: "Show more" is at least 44px tall (${Math.round(moreBox.height)}px)`).toBeGreaterThanOrEqual(44);
      expect(moreBox.width, `${size}: "Show more" is at least 44px wide (${Math.round(moreBox.width)}px)`).toBeGreaterThanOrEqual(44);
      await expect(more, `${size}: "Show more" says it is collapsed`).toHaveAttribute('aria-expanded', 'false');
      const controlled = await more.getAttribute('aria-controls');
      expect(controlled, `${size}: "Show more" points at the note it opens`).toBeTruthy();
      expect(await msg.getAttribute('id'), `${size}: aria-controls names the note paragraph`).toBe(controlled);

      // Accept and Decline did not move: still reachable, still after the message and the button.
      const acceptBox = await expectReachable(page, accept, `${size} Accept`);
      await expectReachable(page, longCard.getByRole('button', { name: /^Decline$/ }), `${size} Decline`);
      const msgBox = (await msg.boundingBox())!;
      // (The button's own box may overlap the note's last few pixels: the tap area is 44px tall
      // and the text inside it is centred, so what has to be under the note is its centre.)
      expect(moreBox.cy, `${size}: "Show more" sits under the note`).toBeGreaterThan(msgBox.y + msgBox.height);
      expect(acceptBox.y, `${size}: Accept sits under "Show more"`).toBeGreaterThanOrEqual(moreBox.y + moreBox.height - 1);

      // The short request: no button at all, and nothing but Accept and Decline to press.
      await expect(shortCard.getByRole('button', { name: EITHER }), `${size}: the short row has no Show more / Show less`).toHaveCount(0);
      await expect(shortCard.getByRole('button'), `${size}: the short row has Accept and Decline only`).toHaveCount(2);

      // Tap it: every line, the twelfth on screen, the button says Show less.
      await tap(page, more, `${size} tap "Show more"`);
      const less = longCard.getByRole('button', LESS);
      await expect(less, `${size}: the button now says "Show less"`).toBeVisible();
      await expect(less, `${size}: "Show less" says it is expanded`).toHaveAttribute('aria-expanded', 'true');
      await expect(longCard.getByRole('button', MORE), `${size}: "Show more" is gone`).toHaveCount(0);
      const open = await msg.evaluate(measureClamp);
      note(`expanded-${size}`, `shown ${Math.round(open.shown)}px of ${Math.round(open.natural)}px, clamp ${open.clamp}`);
      expect(open.clamp, `${size}: the expanded note is not clamped`).toBe('none');
      expect(open.shown, `${size}: all twelve lines are laid out`).toBeGreaterThanOrEqual(12 * open.lineHeight - 2);
      expect(Math.abs(open.natural - open.shown), `${size}: nothing is cut from the expanded note`).toBeLessThanOrEqual(2);
      expect(await msg.evaluate(lastLineOnScreen), `${size}: the twelfth line ("${LAST_LINE}") is on screen`).toBe('ok');
      const lessBox = await expectReachable(page, less, `${size} "Show less"`);
      expect(lessBox.height, `${size}: "Show less" is at least 44px tall`).toBeGreaterThanOrEqual(44);
      const sw = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(sw.scroll, `${size}: sideways scroll when expanded (scrollWidth ${sw.scroll} over innerWidth ${sw.inner})`).toBeLessThanOrEqual(sw.inner);
      await page.screenshot({ path: path.join(SHOTS, `${label}-${vp.width}-expanded.png`), fullPage: true });

      // Tap again: back to six lines.
      await tap(page, less, `${size} tap "Show less"`);
      await expect(longCard.getByRole('button', MORE), `${size}: "Show more" is back`).toBeVisible();
      await expect(longCard.getByRole('button', MORE), `${size}: collapsed again`).toHaveAttribute('aria-expanded', 'false');
      const again = await msg.evaluate(measureClamp);
      expect(again.clamp, `${size}: clamped again`).toBe('6');
      expect(again.shown, `${size}: six lines again`).toBeLessThanOrEqual(6 * again.lineHeight + 2);

      const sw2 = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(sw2.scroll, `${size}: sideways scroll (scrollWidth ${sw2.scroll} over innerWidth ${sw2.inner})`).toBeLessThanOrEqual(sw2.inner);
      await page.screenshot({ path: path.join(SHOTS, `${label}-${vp.width}-collapsed.png`), fullPage: true });
      note(`tap-${size}`, `Show more ${Math.round(moreBox.width)}x${Math.round(moreBox.height)}px, Accept ${Math.round(acceptBox.width)}x${Math.round(acceptBox.height)}px`);
      console.log(`  ✓ ${size}: "Show more" ${Math.round(moreBox.width)}x${Math.round(moreBox.height)}px and reachable, six of twelve lines (${Math.round(closed.shown)}px of ${Math.round(closed.natural)}px); tap shows all twelve, "Show less" aria-expanded=true; tap again clamps; the short row has no button; no sideways scroll.`);
    } catch (e) {
      problems.push(`${size}: ${firstLineOf(e)}`);
      console.log(`  ✗ ${size}: ${firstLineOf(e)}`);
      await page.screenshot({ path: path.join(SHOTS, `${label}-${vp.width}-FAILED.png`), fullPage: true }).catch(() => undefined);
    } finally {
      await page.context().close().catch(() => undefined);
    }
  }

  expect(pageErrors, 'no script errors on any page').toEqual([]);
  expect(problems, `sizes with a problem:\n${problems.join('\n')}`).toEqual([]);
});

test('1. Show more follows the width of the window: it is there when the note wraps past six lines and gone when it fits', async () => {
  test.skip(!!DEVICE, 'a device has one fixed viewport; the plain-engine runs do the resizing');
  test.setTimeout(240_000);
  const asker = await makeUser('wrap-asker');
  const reader = await makeUser('wrap-reader');
  const sent = await api<PokeJson>(asker, 'POST', '/pokes', { recipientId: reader.id, message: WRAP_NOTE });
  expect(sent.status, `request: ${JSON.stringify(sent.body)}`).toBe(201);
  const pokeId = dataOf(sent, 'request').id;
  expect(WRAP_NOTE.includes('\n'), 'the note has no line breaks: only the width can clamp it').toBe(false);

  const pageErrors: string[] = [];
  const page = await openAs(reader, MATRIX[0], pageErrors);
  await gotoRetry(page, `${APP}/messages`);
  const card = requestCard(page, pokeId);
  await expect(card).toContainText('compare notes', { timeout: 30_000 });
  await settle(page);
  const msg = card.locator('p', { hasText: 'compare notes' });
  await expect(msg).toHaveCount(1);
  const button = card.getByRole('button', { name: EITHER });
  const lines = async () => {
    const m = await msg.evaluate(measureClamp);
    return { natural: Math.round(m.natural / m.lineHeight), shown: Math.round(m.shown / m.lineHeight), clamp: m.clamp };
  };

  // Phone width: more than six lines, clamped, so the button is there.
  const narrow = await lines();
  expect(narrow.natural, `360 wide: the note needs more than six lines (${narrow.natural})`).toBeGreaterThan(6);
  expect(narrow.shown, '360 wide: six lines shown').toBe(6);
  await expect(button, '360 wide: the button is there').toHaveCount(1);
  await expect(card.getByRole('button', MORE)).toBeVisible();

  // Wide window: the same note fits, so there is nothing to expand and no button.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(button, '1000 wide: the note fits, so no button').toHaveCount(0, { timeout: 10_000 });
  const wide = await lines();
  expect(wide.natural, `1000 wide: the note fits in six lines or fewer (${wide.natural})`).toBeLessThanOrEqual(6);
  expect(wide.clamp, '1000 wide: the row is clamped to six, and the note does not reach it').toBe('6');

  // Back to phone width: the button returns without a reload.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(card.getByRole('button', MORE), '360 wide again: the button is back').toBeVisible({ timeout: 10_000 });
  await expectReachable(page, card.getByRole('button', MORE), '360 wide again "Show more"');

  // Expanded at phone width, then widened: nothing to show less of, so the button goes.
  await tap(page, card.getByRole('button', MORE), 'tap "Show more"');
  await expect(card.getByRole('button', LESS)).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(button, '1000 wide, expanded earlier: the note fits, so no button').toHaveCount(0, { timeout: 10_000 });
  console.log(`  ✓ 360 wide: ${narrow.natural} lines, six shown, "Show more" there. 1000 wide: ${wide.natural} lines, no button. Back to 360: the button returns. Expanded then widened: the button goes.`);

  expect(pageErrors, 'no script errors').toEqual([]);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. A pending request is never "already answered"
// ═════════════════════════════════════════════════════════════════════════════

const ANSWERED = /already been answered/i;

// Poll for the false sentence until `done` says the page has settled. A single check at the end
// would miss the window in which it used to show.
async function neverSaid(page: Page, done: () => Promise<boolean>): Promise<number> {
  let samples = 0;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    samples++;
    if (await page.getByText(ANSWERED).count() > 0) {
      throw new Error(`the page said "This meeting request has already been answered." (sample ${samples})`);
    }
    if (await done()) return samples;
    await wait(100);
  }
  throw new Error('the page never settled within 40s');
}

test('2. A pending request is never called "already answered"; an answered one still says so or opens its chat', async () => {
  test.setTimeout(240_000);
  const sender = await makeUser('pending-asker');
  const turnedDown = await makeUser('declined-asker');
  const connected = await makeUser('accepted-asker');
  const reader = await makeUser('answerer');
  const send = async (from: TestUser, note: string) => {
    const r = await api<PokeJson>(from, 'POST', `/matches/platform/${reader.id}/interest`, { note });
    expect(r.status, `request from ${from.id}: ${JSON.stringify(r.body)}`).toBe(201);
    return dataOf(r, 'request').id;
  };
  const pendingId = await send(sender, `Pending request ${RUN}`);
  const declinedId = await send(turnedDown, `Declined request ${RUN}`);
  const acceptedId = await send(connected, `Accepted request ${RUN}`);
  const declined = await api(reader, 'POST', `/pokes/${declinedId}/decline`);
  expect(declined.status, `decline: ${JSON.stringify(declined.body)}`).toBe(200);
  const accepted = await api<AcceptedJson>(reader, 'POST', `/pokes/${acceptedId}/accept`);
  expect(accepted.status, `accept: ${JSON.stringify(accepted.body)}`).toBe(200);
  const conversationId = dataOf(accepted, 'accept').conversationId;
  const rows = (await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM user_pokes WHERE recipient_id = $1`, [reader.id])).rows;
  expect(Object.fromEntries(rows.map((r) => [r.id, r.status])), 'one pending, one declined, one accepted')
    .toEqual({ [pendingId]: 'pending', [declinedId]: 'declined', [acceptedId]: 'accepted' });

  const pageErrors: string[] = [];
  const wide: Viewport = { width: 1280, height: 800 };

  // (a) The list of requests arrives LATE. The request itself (GET /pokes/:id) answers first and
  // says "pending". The old page read that as "not in the list, so answered".
  //
  // The list is held until the request itself has been answered, and then for HOLD_MS more, so
  // the order does not depend on how fast the server is today (a fixed delay would lose the
  // race on a cold start). The old page showed the false sentence for the whole of that hold.
  const page = await openAs(reader, wide, pageErrors);
  const HOLD_MS = 3_000;
  let askedAt = 0;
  let stateAt = 0;
  let listAt = 0;
  let stateAnswered: () => void = () => undefined;
  const requestAnswered = new Promise<void>((resolve) => { stateAnswered = resolve; });
  let listCalls = 0;
  await page.route('**/api/pokes/received', async (route) => {
    listCalls++;
    if (listCalls === 1) {
      await Promise.race([requestAnswered, wait(30_000)]);
      await wait(HOLD_MS);
    }
    await route.continue();
  });
  page.on('response', (res) => {
    const url = res.url().split('?')[0];
    if (url.endsWith(`/api/pokes/${pendingId}`)) {
      stateAt = stateAt || Date.now();
      stateAnswered();
    } else if (url.endsWith('/api/pokes/received')) {
      listAt = listAt || Date.now();
    }
  });
  askedAt = Date.now();
  await gotoRetry(page, `${APP}/messages?poke=${pendingId}`);
  // Below 1024px the focused card's pane is hidden. It still mounts there, and the false
  // sentence was written into it all the same (neverSaid counts hidden text too), so on a
  // phone the request is read from its row in the list instead.
  const phone = (page.viewportSize()?.width ?? 0) < 1024;
  const shown = phone ? requestCard(page, pendingId) : page.getByTestId('focused-meeting-request');
  const samples = await neverSaid(page, async () => shown.isVisible().catch(() => false));
  await expect(shown.getByRole('button', { name: /^Accept$/ }), 'the Accept button is there once the list has loaded').toBeVisible();
  await expect(shown.getByRole('button', { name: /^Decline$/ })).toBeVisible();
  await expect(shown).toContainText('Pending request');
  await expect(page.getByText(ANSWERED), 'and still nothing says it was answered').toHaveCount(0);
  // The precondition that made the old page wrong: the request's own answer came well before the list.
  expect(stateAt, 'the request itself was fetched').toBeGreaterThan(0);
  expect(listAt, 'the list was fetched').toBeGreaterThan(0);
  expect(listAt - stateAt, `the list arrived at least ${HOLD_MS / 1000}s after the request itself (${listAt - stateAt}ms)`).toBeGreaterThanOrEqual(HOLD_MS - 500);
  console.log(`  ✓ (a) list held ${HOLD_MS / 1000}s past the request: the request answered after ${stateAt - askedAt}ms, the list after ${listAt - askedAt}ms; ${samples} samples, never "already answered"; then Accept and Decline appear.`);
  await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-answered-pending.png`) });

  // (b) A request the member turned down says so, in the words it always had.
  await page.unroute('**/api/pokes/received');
  await gotoRetry(page, `${APP}/messages?poke=${declinedId}`);
  const turnedDownNotice = page.getByText('You turned this meeting request down.');
  await neverSaid(page, async () => phone
    ? (await turnedDownNotice.count()) > 0
    : turnedDownNotice.isVisible().catch(() => false));
  if (!phone) await expect(page.getByRole('button', { name: 'Back to messages' }), 'a way back from the dead end').toBeVisible();
  console.log(`  ✓ (b) a declined request: "You turned this meeting request down."${phone ? ' (in the pane a phone hides)' : ' and a way back'}.`);

  // (c) An accepted request opens its conversation.
  await gotoRetry(page, `${APP}/messages?poke=${acceptedId}`);
  await neverSaid(page, async () => new RegExp(`/messages/${conversationId}$`).test(page.url()));
  expect(page.url(), 'an accepted request lands in its conversation').toMatch(new RegExp(`/messages/${conversationId}$`));
  console.log('  ✓ (c) an accepted request opens /messages/<conversation>.');

  // (d) The member who SENT a request that is still pending is not told it was answered either,
  // and is not left waiting on a spinner: it will never be in the list of requests they received.
  const senderPage = await openAs(sender, wide, pageErrors);
  await gotoRetry(senderPage, `${APP}/messages?poke=${pendingId}`);
  const notAnswered = senderPage.getByText('They have not answered your meeting request yet.');
  await neverSaid(senderPage, async () => phone
    ? (await notAnswered.count()) > 0
    : notAnswered.isVisible().catch(() => false));
  console.log('  ✓ (d) the sender of a pending request: "They have not answered your meeting request yet."');

  // (e) A request that is not theirs, or does not exist, is "not available". It is never called
  // answered, and it tells a stranger nothing about whether the request exists.
  const stranger = await makeUser('stranger');
  const strangerPage = await openAs(stranger, wide, pageErrors);
  const unavailable = strangerPage.getByText('This meeting request is not available.');
  for (const id of [pendingId, randomUUID()]) {
    await gotoRetry(strangerPage, `${APP}/messages?poke=${id}`);
    await neverSaid(strangerPage, async () => phone
      ? (await unavailable.count()) > 0
      : unavailable.isVisible().catch(() => false));
  }
  console.log('  ✓ (e) a request that is not theirs, and one that does not exist: "This meeting request is not available."');

  // The pending one is untouched by all of this.
  const still = (await pool.query<{ status: string }>(`SELECT status FROM user_pokes WHERE id = $1`, [pendingId])).rows[0];
  expect(still.status, 'the pending request is still pending').toBe('pending');
  expect(pageErrors, 'no script errors').toEqual([]);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The bell keeps the line break in a note
// ═════════════════════════════════════════════════════════════════════════════

test('3. The bell shows a note and "Why REASON suggested this:" on separate lines', async () => {
  test.setTimeout(240_000);
  const words = madeUpWords(0);
  // The sender wants what the recipient offers, so the request carries REASON's reason.
  const sender = await makeUser('bell-asker', { name: `C2 Bell Sender ${RUN}`, want: words });
  const recipient = await makeUser('bell-asked', { offer: words });
  const note = `Hello ${RUN}`;
  const sent = await api<PokeJson>(sender, 'POST', `/matches/platform/${recipient.id}/interest`, { note });
  expect(sent.status, `interest: ${JSON.stringify(sent.body)}`).toBe(201);
  const pokeId = dataOf(sent, 'interest').id;

  // What the bell is given: the note, a blank line, then the reason.
  const bell = (await pool.query<{ title: string; body: string | null }>(
    `SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'poke' AND link = $2`,
    [recipient.id, `/messages?poke=${pokeId}`])).rows;
  expect(bell, 'one bell row for this request').toHaveLength(1);
  expect(bell[0].title).toBe(`C2 Bell Sender ${RUN} asked to meet you`);
  expect(bell[0].body, 'the bell body is the note, a blank line and the reason').toMatch(new RegExp(`^${note}\\n\\nWhy REASON suggested this: .+`));

  const REASON_LEAD = 'Why REASON suggested this:';
  const sizes: Viewport[] = DEVICE ? [contextOptions().viewport ?? { width: 390, height: 844 }] : [{ width: 360, height: 780 }, { width: 1280, height: 800 }];
  const problems: string[] = [];
  const pageErrors: string[] = [];
  for (const vp of sizes) {
    const size = `${vp.width}x${vp.height}`;
    const page = await openAs(recipient, vp, pageErrors);
    try {
      await gotoRetry(page, `${APP}/`);
      await page.locator('button[aria-label="Notifications"]:visible').first().click();
      await expect(page.getByText(bell[0].title), `${size}: the request is in the bell`).toBeVisible({ timeout: 30_000 });
      const body = page.locator('p', { hasText: REASON_LEAD });
      await expect(body, `${size}: the bell body paragraph`).toHaveCount(1);
      await settle(page);

      const read = await body.evaluate(readBody, [note, REASON_LEAD]);
      expect(read.whiteSpace, `${size}: computed white-space of the bell body`).toBe('pre-line');
      expect(read.overflowWrap, `${size}: computed overflow-wrap of the bell body`).toBe('break-word');
      expect(Number.isFinite(read.tops[0]) && Number.isFinite(read.tops[1]), `${size}: both pieces of text were found (${read.tops.join(', ')})`).toBe(true);
      const gap = read.tops[1] - read.tops[0];
      expect(gap, `${size}: the reason starts a blank line below the note: ${Math.round(gap)}px apart, line height ${read.lineHeight}px`).toBeGreaterThanOrEqual(2 * read.lineHeight - 2);

      // The paragraphs are on screen and inside the panel, not cut off sideways.
      const fit = await body.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(fit.scroll, `${size}: the bell body does not overflow sideways`).toBeLessThanOrEqual(fit.client + 1);
      const sw = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
      expect(sw.scroll, `${size}: sideways scroll`).toBeLessThanOrEqual(sw.inner);
      await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-${vp.width}-bell.png`) });
      console.log(`  ✓ ${size}: white-space ${read.whiteSpace}, overflow-wrap ${read.overflowWrap}; the note and "${REASON_LEAD}" are ${Math.round(gap)}px apart (line height ${read.lineHeight}px).`);
    } catch (e) {
      problems.push(`${size}: ${firstLineOf(e)}`);
      console.log(`  ✗ ${size}: ${firstLineOf(e)}`);
      await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-${vp.width}-bell-FAILED.png`) }).catch(() => undefined);
    } finally {
      await page.context().close().catch(() => undefined);
    }
  }
  expect(pageErrors, 'no script errors on any page').toEqual([]);
  expect(problems, `sizes with a problem:\n${problems.join('\n')}`).toEqual([]);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The Matches page updates live
// ═════════════════════════════════════════════════════════════════════════════

test('4. Matches: an open page changes on its own when a request is sent from another tab and when it is answered', async () => {
  test.setTimeout(300_000);
  // Each member wants what the other offers, so each sees the other on /matches.
  const viewerWants = madeUpWords(1);
  const personWants = madeUpWords(2);
  const viewer = await makeUser('matches-viewer', { want: viewerWants, offer: personWants });
  const person = await makeUser('matches-person', { want: personWants, offer: viewerWants });

  const listed = async (u: TestUser, otherId: string) =>
    dataOf(await api<MatchesJson>(u, 'GET', '/matches/platform'), 'matches').matches.find((m) => m.userId === otherId);
  const seenByViewer = await listed(viewer, person.id);
  const seenByPerson = await listed(person, viewer.id);
  expect(seenByViewer, 'the viewer is shown the person').toBeDefined();
  expect(seenByViewer?.pokeStatus ?? null, 'no request yet (viewer)').toBeNull();
  expect(seenByPerson, 'the person is shown the viewer').toBeDefined();
  expect(seenByPerson?.pokeStatus ?? null, 'no request yet (person)').toBeNull();

  const viewerLog = await listen(viewer);
  const personLog = await listen(person);
  const phone: Viewport = { width: 390, height: 844 };
  const pageErrors: string[] = [];
  const viewerPage = await openAs(viewer, phone, pageErrors, true);
  const personPage = await openAs(person, phone, pageErrors, true);

  // Every call the open page makes to the list of matches, with the time it was made.
  const matchCalls = new Map<Page, number[]>();
  for (const p of [viewerPage, personPage]) {
    const calls: number[] = [];
    matchCalls.set(p, calls);
    p.on('request', (r) => {
      if (r.method() === 'GET' && /\/api\/matches\/platform(\?|$)/.test(r.url())) calls.push(Date.now());
    });
  }
  await gotoRetry(viewerPage, `${APP}/matches`);
  await gotoRetry(personPage, `${APP}/matches`);
  const viewerCard = viewerPage.locator(`div.card-hover:has(a[href="/profile/${person.id}"])`);
  const personCard = personPage.locator(`div.card-hover:has(a[href="/profile/${viewer.id}"])`);
  await expect(viewerCard.getByRole('button', { name: /I want to meet/i }), 'the viewer sees the person with the button').toBeVisible({ timeout: 30_000 });
  await expect(personCard.getByRole('button', { name: /I want to meet/i }), 'the person sees the viewer with the button').toBeVisible({ timeout: 30_000 });
  await settle(viewerPage);
  await settle(personPage);
  const viewerOrigin = await viewerPage.evaluate(() => performance.timeOrigin);
  const personOrigin = await personPage.evaluate(() => performance.timeOrigin);
  await wait(1_500); // a negative check: nothing on these pages may change by itself
  await expect(viewerCard.getByRole('button', { name: /I want to meet/i })).toBeVisible();

  // The request is sent from "another tab": straight to the API, as the viewer.
  const heardViewer = viewerLog.countOf(`user:${viewer.id}:invites`);
  const heardPerson = personLog.countOf(`user:${person.id}:invites`);
  const sentAt = Date.now();
  const sent = await api<PokeJson>(viewer, 'POST', `/matches/platform/${person.id}/interest`, { note: `From another tab ${RUN}` });
  expect(sent.status, `interest: ${JSON.stringify(sent.body)}`).toBe(201);
  const pokeId = dataOf(sent, 'interest').id;
  await waitForTag(viewerLog, `user:${viewer.id}:invites`, heardViewer, 'viewer');
  await waitForTag(personLog, `user:${person.id}:invites`, heardPerson, 'person');

  // Both open pages change, with no reload and no touch.
  const viewerState = viewerPage.getByTestId(`match-state-${person.id}`);
  const personState = personPage.getByTestId(`match-state-${viewer.id}`);
  await expect(viewerState, 'the viewer\'s card now says the request went out').toContainText('Introduction requested', { timeout: 15_000 });
  await expect(personState, 'the person\'s card now says they were asked').toContainText('They asked to meet you', { timeout: 15_000 });
  await expect(viewerCard.getByRole('button', { name: /I want to meet/i }), 'the viewer\'s button is gone').toHaveCount(0);
  await expect(personCard.getByRole('button', { name: /I want to meet/i }), 'the person\'s button is gone').toHaveCount(0);
  for (const [name, p] of [['viewer', viewerPage], ['person', personPage]] as const) {
    const after = matchCalls.get(p)!.filter((t) => t >= sentAt);
    expect(after.length, `the ${name}'s page asked for its matches again after the request (${after.length} calls)`).toBeGreaterThanOrEqual(1);
  }
  const row = (await pool.query<{ status: string }>(`SELECT status FROM user_pokes WHERE id = $1`, [pokeId])).rows[0];
  expect(row.status).toBe('pending');
  console.log('  ✓ request sent through the API: both open pages changed on their own ("Introduction requested" / "They asked to meet you"), and each asked for its matches again.');

  // The person says yes through the API. Both pages say Connected.
  const answeredAt = Date.now();
  const accepted = await api<AcceptedJson>(person, 'POST', `/pokes/${pokeId}/accept`);
  expect(accepted.status, `accept: ${JSON.stringify(accepted.body)}`).toBe(200);
  await expect(viewerState, 'the viewer\'s card says Connected').toContainText('Connected', { timeout: 15_000 });
  await expect(personState, 'the person\'s card says Connected').toContainText('Connected', { timeout: 15_000 });
  for (const [name, p] of [['viewer', viewerPage], ['person', personPage]] as const) {
    const after = matchCalls.get(p)!.filter((t) => t >= answeredAt);
    expect(after.length, `the ${name}'s page asked for its matches again after the answer (${after.length} calls)`).toBeGreaterThanOrEqual(1);
  }
  const done = (await pool.query<{ status: string }>(`SELECT status FROM user_pokes WHERE id = $1`, [pokeId])).rows[0];
  expect(done.status).toBe('accepted');
  console.log('  ✓ the answer went through the API: both open pages say Connected on their own.');

  // Neither page was reloaded along the way.
  expect(await viewerPage.evaluate(() => performance.timeOrigin), 'the viewer\'s page was not reloaded').toBe(viewerOrigin);
  expect(await personPage.evaluate(() => performance.timeOrigin), 'the person\'s page was not reloaded').toBe(personOrigin);
  await viewerPage.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-matches-viewer.png`), fullPage: true });
  expect(pageErrors, 'no script errors').toEqual([]);
});
