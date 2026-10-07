// e2e/tests/reason-m1.spec.ts
//
// REASON milestone 1, task B7: For You, the Human Card, the Meet and "What happened?" sheets and the Human
// Profile, driven by clicks the way a member would, at every size Stefan's checklist names, in Chromium,
// WebKit and on a phone device. Throwaway members only; the preview reads and writes PRODUCTION data.
//
//   One test per size     (360, 390, 430, 768, 1024, 1280, 1440, 1920): the shell, For You, the Meet sheet,
//                         the Human Profile (top and bottom) of a member with a 65 character name and no
//                         photo, the "What happened?" sheet and, on a phone, the More sheet. No sideways
//                         scroll, nothing sticking out of a card or the page, every button at least 44px tall
//                         and not under a fixed bar, no private want anywhere in the page
//   Save                  persists across a reload, and so does un-saving; each press raises its toast
//   Pass                  on the profile hides the person from For You (also after a reload); Undo pass
//                         brings them back
//   Meet                  a double press on Send request is ONE request on the wire and ONE stored row, the
//                         note first and then the format; the private want is not in For You, the open sheet,
//                         the sent request or the profile
//   Typing                a note being typed, and the chosen format, survive the page refetching when the
//                         window comes back to the front (For You and the profile)
//   What happened         a double press on Save outcome is ONE stored outcome; "Nothing yet" excludes the rest
//   Blocked               a blocked member's profile says "This profile is not available." and shows none of
//                         their data; a mistyped address does not even ask the server
//   Back                  a profile opened by a direct link in a fresh tab goes back to For You; one opened
//                         from a card goes back to where it came from; a made-up ?from= is never printed
//   Failures              For You and a profile forced to 500 show their error and Try again, and Try again
//                         recovers; with no connection a Save fails at once, and nothing loaded shows the
//                         error state (never "no one to suggest") and fills in when the connection returns
//   More (phone)          the sheet lists the rest and each entry opens
//   Rail (wide)           the context rail beside For You, and where it starts (981px)
//
// Every page is watched: a script error or a console error fails the test, except exactly the errors a
// test makes happen on purpose (a forced 500, a lost connection).
//
// Seeding. The viewer wants three made-up words; three people offer them, so the viewer's For You is exactly
// those three, and no real member is ever shown to the viewer, let alone pressed. Every button is pressed by
// the id of a throwaway member (ours() refuses any other id). Against a local address the scratch database
// is small, and the matcher ignores a word that 25% or more of 8 or more candidates share, so filler members
// with no matching words keep the three well under that. Production is not seeded with fillers.
//
// Run it one engine at a time (one spec per process: the database pool is shared):
//   cd e2e
//   E2E_APP_URL=https://<preview> E2E_VERCEL_SHARE=<_vercel_share token> E2E_JWT_SECRET=<prod key> \
//     npx playwright test tests/reason-m1.spec.ts
//   E2E_ENGINE=webkit ...                                    (Safari's engine)
//   E2E_ENGINE=webkit E2E_DEVICE='iPhone 14' ...             (the device's own size is then the only size)
//   E2E_SHOTS_DIR=<folder> ...                               (also saves the screenshots, see shot())
// E2E_HEADED=0 runs it headless. E2E_JWT_SECRET must be the signing key of the API the preview talks to, or
// every page below is a sign-in screen. Locally: only through the wrapper (bash /c/dev/_m1-local/run-spec.sh).

import { test, expect, Browser, BrowserContext, Locator, Page, Request } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel, contextOptions } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

// ── What this run is ─────────────────────────────────────────────────────────────────────────

const DEVICE = process.env.E2E_DEVICE;
const SHOTS = process.env.E2E_SHOTS_DIR ? path.resolve(process.env.E2E_SHOTS_DIR) : '';
// A local address is the scratch database: small, so the made-up words can be "generic" (see the header).
const LOCAL = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(APP);
const FILLERS = LOCAL ? 14 : 0;
// First answers can be slow on a preview (a sleeping API wakes in up to a minute): the first wait of a page
// is this long.
const SLOW = 75_000;

interface Size { width: number; height: number }
const SIZES: Size[] = [
  { width: 360, height: 780 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 },
];
// With E2E_DEVICE set, the device's own viewport is the only size.
function sizes(wanted: Size[]): Size[] {
  if (!DEVICE) return wanted;
  return [contextOptions().viewport ?? { width: 390, height: 844 }];
}
const PHONE = sizes([{ width: 390, height: 844 }])[0];

// ── The people ───────────────────────────────────────────────────────────────────────────────

const run = Date.now().toString(36);
// Made-up words, drawn at random per run, that no member's profile can contain: six letters from an alphabet
// with no vowel (a word is never made of those) and none of the letters a plural or an ending is cut at.
// The matcher counts two words as related when they share a stem, or (from eight letters) their first seven
// letters; with six letters and no ending, only an identical word is related, so two words of one run, or of
// two runs, or one of them and a real word, can never be joined.
const LETTERS = 'bcdfhjklmnpqvwxz';
const madeUpWord = () => Array.from({ length: 6 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
const WORDS: string[] = (() => {
  const set = new Set<string>();
  while (set.size < 3) set.add(madeUpWord());
  return [...set];
})();
const THE_WORDS = WORDS.join(' ');
// What every test member privately wants to meet: it must never reach another member's page.
const SECRET = `secret-want-${run}`;
// 65 characters, one 35 letter word that has no place to break, and no photo: the worst name a card or a
// profile gets at 360px. Its initials are W and M.
const LONG_NAME = `Wolfeschlegelsteinhausenbergerdorff Maximilian-Alexander ${run}`;
const NAME = { giver: `Gil Giver ${run}`, secretive: `Sofia Secret ${run}`, met: `Mia Met ${run}`, blocked: `Bea Blocked ${run}` };
const BLOCKED_DATA = { company: `Blocked Co ${run}`, bio: `blocked-bio-${run}`, offer: `blocked-offer-${run}` };
const OFFER = 'Introductions to seed investors';

let browser: Browser | undefined;
const ctxs: BrowserContext[] = [];
// Every throwaway account, pushed the moment it exists, removed by exact id in afterAll.
const made: string[] = [];
let viewer: TestUser;
let giver: TestUser;
let longName: TestUser;
let secretive: TestUser;
let met: TestUser;
let blocked: TestUser;

// Resend refuses @example.com and the server would log an error on every email, so a throwaway member gets
// delivered+label@resend.dev (accepted, never delivered). The id goes into made[] before the address changes,
// so a failure in between cannot leave the account behind.
async function makeUser(label: string): Promise<TestUser> {
  const u = await createTestUser(`m1-${label}`);
  made.push(u.id);
  const email = `delivered+m1-${run}-${label}@resend.dev`;
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, u.id]);
  return { ...u, email };
}

/** The only way a page, a card or a button is picked: by the id of one of this run's throwaway members. */
function ours(id: string): string {
  if (!made.includes(id)) throw new Error(`refusing to touch ${id}: it is not one of this run's throwaway members`);
  return id;
}

async function seed(): Promise<void> {
  viewer = await makeUser('viewer');
  giver = await makeUser('giver');
  longName = await makeUser('long');
  secretive = await makeUser('secret');
  met = await makeUser('met');
  blocked = await makeUser('blocked');
  for (let i = 0; i < FILLERS; i++) await makeUser(`filler-${i}`);

  // The viewer wants three words only the test people share, and no job-category word ("specialists" is a
  // category the matcher gives every analyst on the network, which would rank real members above the test
  // people). Three strong matches means For You shows exactly them.
  await pool.query(`UPDATE users SET who_i_want_to_meet = $1, first_name = 'Vera' WHERE id = $2`, [THE_WORDS, viewer.id]);
  await pool.query(
    `UPDATE users SET expertise_text = $1, what_i_can_help_with = $2, who_i_want_to_meet = $3, display_name = $4, first_name = 'Gil' WHERE id = $5`,
    [THE_WORDS, OFFER, SECRET, NAME.giver, giver.id]);
  await pool.query(
    `UPDATE users SET expertise_text = $1, who_i_want_to_meet = $2, avatar_url = NULL, display_name = $3, first_name = 'Wolfe' WHERE id = $4`,
    [THE_WORDS, SECRET, LONG_NAME, longName.id]);
  await pool.query(
    `UPDATE users SET expertise_text = $1, who_i_want_to_meet = $2, display_name = $3, first_name = 'Sofia' WHERE id = $4`,
    [THE_WORDS, SECRET, NAME.secretive, secretive.id]);
  // A member the viewer has met: not suggested again, and a profile with no match (so no "strong reason").
  const [a, b] = viewer.id < met.id ? [viewer.id, met.id] : [met.id, viewer.id];
  await pool.query(`INSERT INTO encounter_history (id, user_a_id, user_b_id, times_met, last_met_at) VALUES (gen_random_uuid(), $1, $2, 1, NOW())`, [a, b]);
  await pool.query(`UPDATE users SET who_i_want_to_meet = $1, display_name = $2, first_name = 'Mia' WHERE id = $3`, [SECRET, NAME.met, met.id]);
  // A member who blocked the viewer. They offer the made-up words, so the block is the only reason For You
  // does not list them.
  await pool.query(`INSERT INTO user_blocks (id, blocker_id, blocked_id) VALUES (gen_random_uuid(), $1, $2)`, [blocked.id, viewer.id]);
  await pool.query(
    `UPDATE users SET expertise_text = $1, who_i_want_to_meet = $2, display_name = $3, first_name = 'Bea', company = $4, bio = $5, what_i_can_help_with = $6 WHERE id = $7`,
    [THE_WORDS, SECRET, NAME.blocked, BLOCKED_DATA.company, BLOCKED_DATA.bio, BLOCKED_DATA.offer, blocked.id]);
}

/** Back to the state seed() left the viewer in. Only the viewer's own rows, by exact id. */
async function resetViewer(): Promise<void> {
  const id = ours(viewer.id);
  await pool.query(`DELETE FROM person_responses WHERE user_id = $1`, [id]);
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = $1`, [id]);
  await pool.query(`DELETE FROM meeting_outcomes WHERE user_id = $1`, [id]);
}

const responseOf = async (from: TestUser, to: TestUser): Promise<string | undefined> =>
  (await pool.query<{ response: string }>(`SELECT response FROM person_responses WHERE user_id = $1 AND target_user_id = $2`, [from.id, to.id])).rows[0]?.response;
const pokesOf = async (from: TestUser, to: TestUser) =>
  (await pool.query<{ message: string; preferred_format: string | null }>(`SELECT message, preferred_format FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [from.id, to.id])).rows;
const outcomesOf = async (from: TestUser, to: TestUser) =>
  (await pool.query<{ worth_continuing: string; outcome_keys: string[] }>(`SELECT worth_continuing, outcome_keys FROM meeting_outcomes WHERE user_id = $1 AND target_user_id = $2`, [from.id, to.id])).rows;

// What is left of this run's members, in every table that points at them.
async function leftovers(): Promise<Record<string, number>> {
  const r = await pool.query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM users WHERE id = ANY($1)) AS users,
       (SELECT count(*)::int FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)) AS pokes,
       (SELECT count(*)::int FROM person_responses WHERE user_id = ANY($1) OR target_user_id = ANY($1)) AS responses,
       (SELECT count(*)::int FROM meeting_outcomes WHERE user_id = ANY($1) OR target_user_id = ANY($1)) AS outcomes,
       (SELECT count(*)::int FROM encounter_history WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)) AS encounters,
       (SELECT count(*)::int FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)) AS blocks,
       (SELECT count(*)::int FROM notifications WHERE user_id = ANY($1)) AS notifications`,
    [made]);
  return r.rows[0];
}

// ── Watching a page ──────────────────────────────────────────────────────────────────────────

// The browser's own notice that a resize observer needed another frame. Not an application error.
const BENIGN_PAGE_ERROR = /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i;

/**
 * WebKit logs "... due to access control checks." for a request the page itself cancelled by navigating away.
 * That one message, for a request that really was cancelled, is noise; the same words for a request that was
 * not cancelled are a real cross-origin failure, and every other message is a real error.
 */
function isCancelledNoise(text: string, locationUrl: string, cancelled: ReadonlyMap<string, string>): boolean {
  if (!/ due to access control checks\.?$/.test(text)) return false;
  const named = text.match(/https?:\/\/\S+/)?.[0];
  return [named, locationUrl].some((url) => !!url && cancelled.has(url));
}

// What each watched page has in flight, so that "the network is quiet" can be told at any moment: Playwright's
// own waitForLoadState('networkidle') answers once per navigation, and returns at once for every click after it.
const traffic = new WeakMap<Page, { open: Set<Request>; last: number }>();

/** Every script error and console error of every page of one browser context. */
class Quiet {
  private logged: Array<{ kind: 'page' | 'console'; text: string; url: string }> = [];
  private allowed: Array<{ text: RegExp; url: RegExp }> = [];
  private cancelled = new Map<string, string>();

  attach(page: Page): void {
    const t = { open: new Set<Request>(), last: Date.now() };
    traffic.set(page, t);
    // The live connection (socket.io) is not the page asking for something: a long poll would never look quiet.
    page.on('request', (r) => { if (!/\/socket\.io\//.test(r.url())) { t.open.add(r); t.last = Date.now(); } });
    page.on('requestfinished', (r) => { t.open.delete(r); t.last = Date.now(); });
    page.on('pageerror', (e) => {
      if (!BENIGN_PAGE_ERROR.test(e.message)) this.logged.push({ kind: 'page', text: e.message, url: page.url() });
    });
    page.on('console', (m) => {
      if (m.type() === 'error') this.logged.push({ kind: 'console', text: m.text(), url: m.location().url });
    });
    // Remembered, not judged here: the console line can arrive before or after the failure it is about.
    page.on('requestfailed', (r) => {
      t.open.delete(r);
      t.last = Date.now();
      const why = r.failure()?.errorText ?? '';
      if (/cancel|abort/i.test(why)) this.cancelled.set(r.url(), why);
    });
  }

  /** A console error this test makes happen on purpose: that text, from that address. Nothing else is let through. */
  allow(text: RegExp, url: RegExp): void {
    this.allowed.push({ text, url });
  }

  problems(): string[] {
    return this.logged
      .filter((l) => l.kind === 'page'
        || !(isCancelledNoise(l.text, l.url, this.cancelled) || this.allowed.some((a) => a.text.test(l.text) && a.url.test(l.url))))
      .map((l) => `${l.kind === 'page' ? 'script error' : 'console error'}: ${l.text}${l.url ? ` (${l.url})` : ''}`);
  }
}

// ── Opening pages ────────────────────────────────────────────────────────────────────────────

interface Opened { ctx: BrowserContext; page: Page; quiet: Quiet }

async function newPageIn(ctx: BrowserContext, quiet: Quiet): Promise<Page> {
  const page = await ctx.newPage();
  quiet.attach(page);
  return page;
}

// A signed-in browser at a given size (a device's own size when E2E_DEVICE is set).
async function openAs(user: TestUser, size: Size): Promise<Opened> {
  if (!browser) throw new Error('the browser is not open');
  const ctx = await browser.newContext(DEVICE ? contextOptions() : { viewport: size });
  ctxs.push(ctx);
  await primePreview(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: user.accessToken, r: user.refreshToken });
  const quiet = new Quiet();
  const page = await newPageIn(ctx, quiet);
  return { ctx, page, quiet };
}

/** A fresh tab of the same signed-in browser: its history starts empty, as a link opened from an email does. */
const newTab = (o: Opened): Promise<Page> => newPageIn(o.ctx, o.quiet);

async function using(user: TestUser, size: Size, fn: (o: Opened) => Promise<void>): Promise<void> {
  const o = await openAs(user, size);
  try {
    await fn(o);
  } finally {
    await o.ctx.close().catch(() => undefined);
  }
}

/**
 * Waits for the network to go quiet: nothing in flight, and nothing started for half a second, at ANY moment
 * (after a navigation, and after a click that made the page ask for more). A page is only left, and its
 * errors only read, once nothing is in flight: a request cancelled by leaving is what makes WebKit log
 * "access control checks". On a page that never goes quiet this gives up after 15 seconds and carries on.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
  const t = traffic.get(page);
  if (!t) {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    return;
  }
  const until = Date.now() + 15_000;
  while (Date.now() < until && (t.open.size > 0 || Date.now() - t.last < 500)) await page.waitForTimeout(100);
}

async function visit(page: Page, route: string): Promise<void> {
  await settle(page);
  await gotoRetry(page, `${APP}${route}`);
  await settle(page);
}

async function reload(page: Page): Promise<void> {
  await settle(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await settle(page);
}

async function expectQuiet(o: Opened, where: string): Promise<void> {
  await settle(o.page);
  expect(o.quiet.problems(), `${where}: script errors or console errors`).toEqual([]);
}

// ── Looking at For You ───────────────────────────────────────────────────────────────────────

const card = (page: Page, id: string): Locator => page.locator(`[data-person-id="${ours(id)}"]`);
const shownIds = (page: Page): Promise<string[]> =>
  page.locator('[data-person-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-person-id') ?? '').sort());

/**
 * For You lists exactly these people, and every one of them is a throwaway member. This runs before anything
 * on the page is pressed: a real member on the list would mean the made-up words matched someone, or (locally)
 * that the matcher's rule against words that most candidates share switched them off.
 */
async function expectPeople(page: Page, want: TestUser[], why: string): Promise<void> {
  await expect(page.locator('[data-person-id]').first(), `${why}: For You shows no card at all`).toBeVisible({ timeout: SLOW });
  const strangers = (await shownIds(page)).filter((id) => !made.includes(id));
  expect(strangers, `${why}: For You shows ${strangers.length} member(s) that are not this run's throwaway people (${strangers.join(', ')}). Nothing was pressed.`).toEqual([]);
  await expect.poll(() => shownIds(page), {
    message: `${why}: For You must list exactly ${want.length} test people (made-up words ${THE_WORDS}${LOCAL ? `; ${FILLERS} fillers keep them under the matcher's 25% rule` : ''})`,
    timeout: 20_000,
  }).toEqual(want.map((u) => u.id).sort());
}

const secretIn = async (page: Page): Promise<boolean> => (await page.content()).includes(SECRET);
async function expectNoSecret(page: Page, where: string): Promise<void> {
  expect(await secretIn(page), `${where}: the private want "${SECRET}" is in the page`).toBe(false);
}

// The toast stack is the fixed box at the top right; each toast's words are one <p> in it. The stack also holds
// two live regions that are always there and empty, so it is the words that are counted, not the boxes.
const toasts = (page: Page): Locator => page.locator('div.fixed.top-4.right-4 p');
const expectToast = (page: Page, text: string): Promise<void> =>
  expect(page.getByText(text, { exact: true }), `toast "${text}"`).toBeVisible({ timeout: 10_000 });

/**
 * A control is pressed where a finger would land: it is centred first (a lower card sits below the fold), then
 * it must be fully inside the window and the topmost thing at its own centre (not under a fixed bar), and at
 * least 44px tall. A toast sits over the top right corner for a few seconds, so it is let go first.
 * `instant`: the app scrolls smoothly, and a box measured mid-scroll is nowhere.
 */
async function tap(page: Page, target: Locator, label: string, opts: { centre?: boolean; presses?: 1 | 2 } = {}): Promise<void> {
  // Whatever the test says, nothing is pressed on a profile that is not a throwaway member's.
  const profile = new URL(page.url()).pathname.match(/^\/people\/([^/]+)\/?$/);
  if (profile) ours(profile[1].toLowerCase());
  await expect(toasts(page), `${label}: a toast stays on screen`).toHaveCount(0, { timeout: 10_000 });
  // A button that is busy (disabled, or aria-disabled so that it keeps the keyboard focus) is let finish first:
  // one press at a time, and never forced. Playwright counts aria-disabled="true" as not enabled.
  await expect(target, `${label}: is still busy or disabled`).toBeEnabled({ timeout: 10_000 });
  if (opts.centre !== false) await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }));
  const box = await expectReachable(page, target, label);
  expect(box.height, `${label} is ${Math.round(box.height)}px tall, under 44px`).toBeGreaterThanOrEqual(44);
  if (opts.presses === 2) await page.mouse.dblclick(box.cx, box.cy);
  else await page.mouse.click(box.cx, box.cy);
}

// Opening a sheet locks the page's scroll; closing it must give the scroll back (a sheet that left the lock
// on, or two that closed in the wrong order, left a member with a page that would not scroll). The lock must
// be off and stay off, and where the window itself scrolls (the profile) a turn of the wheel must move it.
async function expectScrollable(page: Page, where: string): Promise<void> {
  const locked = () => page.evaluate(() => document.body.style.overflow === 'hidden');
  await expect.poll(locked, { message: `${where}: the page is still locked after the sheet closed` }).toBe(false);
  await page.waitForTimeout(250); // a lock that comes back a moment later is still a lock
  expect(await locked(), `${where}: the page locked again after the sheet closed`).toBe(false);
  // Mobile WebKit has no mouse wheel, so a device is checked by the lock alone. The wheel turns towards
  // whichever end has room: a button centred near the end of a page leaves none below.
  const at = await page.evaluate(() => ({ y: window.scrollY, room: document.documentElement.scrollHeight - window.innerHeight }));
  if (!DEVICE && at.room > 160) {
    await page.mouse.wheel(0, at.y + 120 <= at.room ? 120 : -120);
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: `${where}: a turn of the wheel does not scroll the page` }).not.toBe(at.y);
  }
}

async function inReach(page: Page, target: Locator, label: string, opts: { centre?: boolean } = {}): Promise<void> {
  if (opts.centre !== false) await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }));
  const box = await expectReachable(page, target, label);
  expect(box.height, `${label} is ${Math.round(box.height)}px tall, under 44px`).toBeGreaterThanOrEqual(44);
}

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────

// Neither the window nor the page area (<main>: on For You it is what scrolls) may scroll sideways, and
// nothing in the page may reach past the window's edge.
async function expectNoSideways(page: Page, where: string): Promise<void> {
  const m = await page.evaluate(() => {
    const main = document.querySelector('main');
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('main *'))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue; // screen-reader-only text and empty boxes
      if (r.right > window.innerWidth + 1 || r.left < -1) {
        out.push(`${el.tagName.toLowerCase()} "${(el.innerText || '').replace(/\s+/g, ' ').slice(0, 24)}" ${Math.round(r.left)} to ${Math.round(r.right)}`);
      }
    }
    return {
      docW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      innerW: window.innerWidth,
      mainOver: main ? main.scrollWidth - main.clientWidth : 0,
      out: out.slice(0, 4),
    };
  });
  expect(m.docW - m.innerW, `${where}: the window scrolls sideways (scrollWidth ${m.docW} over ${m.innerW})`).toBeLessThanOrEqual(0);
  expect(m.mainOver, `${where}: the page area scrolls sideways by ${m.mainOver}px`).toBeLessThanOrEqual(1);
  expect(m.out, `${where}: something reaches past the edge of the window`).toEqual([]);
}

// Nothing inside the box sticks out of it, sideways, and no text is wider than its own box. A card hides
// what overflows it, so a long name that does not wrap is cut off, not scrolled to.
async function expectNothingSticksOut(target: Locator, label: string): Promise<void> {
  const bad = await target.evaluate((root) => {
    const box = root.getBoundingClientRect();
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const what = `${el.tagName.toLowerCase()} "${(el.innerText || '').replace(/\s+/g, ' ').slice(0, 24)}"`;
      if (r.right > box.right + 1 || r.left < box.left - 1) out.push(`${what} sticks out (${Math.round(r.left)} to ${Math.round(r.right)} in ${Math.round(box.left)} to ${Math.round(box.right)})`);
      else if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) out.push(`${what} is wider than its box (${el.scrollWidth} over ${el.clientWidth})`);
    }
    return out.slice(0, 4);
  });
  expect(bad, `${label}: things that do not fit`).toEqual([]);
}

async function expectInsideWindow(page: Page, target: Locator, label: string): Promise<void> {
  const box = await target.boundingBox();
  const vp = page.viewportSize();
  expect(box && vp, `${label}: not rendered`).toBeTruthy();
  expect(Math.round(box!.x), `${label}: left edge`).toBeGreaterThanOrEqual(0);
  expect(Math.round(box!.x + box!.width), `${label}: right edge ${Math.round(box!.x + box!.width)} over ${vp!.width}`).toBeLessThanOrEqual(vp!.width);
}

// A phone gets a bottom sheet the width of the window; from 768px a centred dialog no wider than 560px.
// Each reading is ONE snapshot (the sheet's box and the browser's own answer to "is this 768px or wider"),
// and it is read again until it is right or five seconds pass: opening a sheet hides the page's scrollbar,
// and where a scrollbar takes room (Windows WebKit) a window of 768 to 775px changes from one layout to the
// other a frame later. A sheet that never settles into the right layout still fails.
async function expectSheetFits(page: Page, sheet: Locator, where: string): Promise<void> {
  await expect.poll(async () => {
    const m = await sheet.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight, wide: window.matchMedia('(min-width: 768px)').matches };
    });
    const bad: string[] = [];
    if (m.x < -0.5) bad.push(`starts ${Math.round(-m.x)}px left of the window`);
    if (m.y < -0.5) bad.push(`starts ${Math.round(-m.y)}px above the window`);
    if (m.x + m.w > m.vw + 0.5) bad.push(`ends ${Math.round(m.x + m.w - m.vw)}px right of the window`);
    if (m.y + m.h > m.vh + 0.5) bad.push(`ends ${Math.round(m.y + m.h - m.vh)}px below the window`);
    if (!m.wide) {
      if (Math.abs(m.w - m.vw) > 1) bad.push(`a phone's sheet is ${Math.round(m.w)}px wide in a ${m.vw}px window`);
      if (Math.abs(m.y + m.h - m.vh) > 1) bad.push(`a phone's sheet does not sit on the bottom edge (ends at ${Math.round(m.y + m.h)} of ${m.vh})`);
    } else {
      if (m.w > 560.5) bad.push(`a dialog is ${Math.round(m.w)}px wide, over 560px`);
      if (Math.abs(m.x - (m.vw - (m.x + m.w))) > 2) bad.push(`a dialog is not centred (${Math.round(m.x)}px left, ${Math.round(m.vw - m.x - m.w)}px right)`);
    }
    return bad;
  }, { message: `${where}: the sheet does not fit`, timeout: 5_000 }).toEqual([]);
}

// The images in view are the real ones: a missing sheep or logo is a broken-image box.
async function expectImagesLoaded(page: Page, where: string): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    Array.from(document.images)
      .filter((img) => { const r = img.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight; })
      .filter((img) => !(img.complete && img.naturalWidth > 0))
      .map((img) => img.getAttribute('src'))), { message: `${where}: images in view that did not load`, timeout: 10_000 }).toEqual([]);
}

// The navigation that belongs to this width: the bottom bar up to 720px, otherwise the rail (icons) or the
// sidebar (icons and words), eight entries either way.
async function expectChrome(page: Page, width: number, where: string): Promise<void> {
  const bar = page.locator('nav[aria-label="Main"].fixed');
  const icons = page.locator('aside nav a svg');
  if (width <= 720) {
    await expect(page.getByRole('navigation', { name: 'Main' }), `${where}: the bottom bar`).toBeVisible();
    await expect(icons.first(), `${where}: a sidebar on a phone`).toBeHidden();
    return;
  }
  await expect(bar, `${where}: the phone bar above 720px`).toBeHidden();
  expect(await icons.count(), `${where}: eight navigation icons`).toBe(8);
  const box = await icons.first().boundingBox();
  expect(box && box.width > 0 && box.height > 0, `${where}: the icons are drawn`).toBeTruthy();
  const words = await page.locator('aside nav a').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.trim()));
  if (width >= 981) expect(words, `${where}: the sidebar shows its words`).toEqual(['For You', 'People', 'Entities', 'Circles', 'Pods', 'Events', 'Messages', 'Introductions']);
  else expect(words, `${where}: the rail shows icons, not words`).toEqual(Array(8).fill(''));
}

// The context rail beside the list: from 981px, not below.
async function expectRail(page: Page, width: number, where: string): Promise<void> {
  const rail = page.getByRole('complementary', { name: 'Your context' });
  if (width >= 981) await expect(rail, `${where}: the context rail`).toBeVisible();
  else await expect(rail, `${where}: the context rail below 981px`).toBeHidden();
}

// ── Screenshots for the final look (only when E2E_SHOTS_DIR is set) ──────────────────────────

async function shot(page: Page, width: number, what: string, target?: Locator): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-${width}-${what}.png`);
  await (target ?? page).screenshot({ path: file });
}

// ── The profile ──────────────────────────────────────────────────────────────────────────────

const moveBar = (page: Page): Locator => page.getByRole('region', { name: 'Your move' });
const backButton = (page: Page): Locator => page.getByRole('button', { name: '← Back' });
const passButton = (page: Page): Locator => moveBar(page).getByRole('button', { name: /^(Pass: not relevant right now|Undo pass)$/ });
const primaryButton = (page: Page): Locator => moveBar(page).getByRole('button', { name: /^(Meet|Request sent|Respond|Request declined|Continue)$/ });

/** The profile on screen is this member's: its one h1 is their name, and so is the address. */
async function expectProfileOf(page: Page, who: TestUser, name: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name, exact: true }), `the profile of ${name}`).toBeVisible({ timeout: SLOW });
  expect(new URL(page.url()).pathname, 'the address is this member\'s').toBe(`/people/${ours(who.id)}`);
}

const scrollWindowTo = (page: Page, where: 'top' | 'bottom'): Promise<void> =>
  page.evaluate((w) => window.scrollTo({ top: w === 'top' ? 0 : document.documentElement.scrollHeight, left: 0, behavior: 'instant' as ScrollBehavior }), where);

// With the page scrolled to its end, the last section ends above the fixed move bar.
async function expectClearOfMoveBar(page: Page, where: string): Promise<void> {
  const m = await page.evaluate(() => {
    const bar = document.querySelector('[role="region"][aria-label="Your move"]');
    const last = document.querySelector('main')?.lastElementChild;
    if (!bar || !last) return null;
    return { barTop: bar.getBoundingClientRect().top, lastBottom: last.getBoundingClientRect().bottom };
  });
  expect(m, `${where}: the move bar and the page are both there`).not.toBeNull();
  expect(Math.round(m!.lastBottom), `${where}: the end of the page is under the move bar (bar at ${Math.round(m!.barTop)})`).toBeLessThanOrEqual(Math.round(m!.barTop));
}

/** Times the page asks for something, to prove "one press, one request". */
function countRequests(page: Page, method: string, url: RegExp): { count: () => number } {
  let n = 0;
  page.on('request', (r) => { if (r.method() === method && url.test(r.url())) n++; });
  return { count: () => n };
}

/**
 * React Query refetches what is on screen when the window comes back to the front, once its data is 5
 * seconds old (client/src/lib/queryClient.ts). The window "comes back" the way the page hears it, as a
 * visibilitychange, and the refetch is awaited: without it the typed-text check would prove nothing.
 */
async function windowComesBack(page: Page, refetches: RegExp, label: string): Promise<void> {
  await page.waitForTimeout(5_500);
  const asked = page.waitForRequest((r) => r.method() === 'GET' && refetches.test(r.url()), { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await asked.catch(() => { throw new Error(`${label}: the page did not refetch when the window came back (${refetches}); the typed-text check would prove nothing`); });
  await settle(page);
}

const FORCED_500 = { status: 500, contentType: 'application/json', body: '{"success":false,"error":{"code":"INTERNAL","message":"forced by the test"}}' };

// With no connection the browser cannot fetch fonts, pictures or the live connection either: those console
// errors (and only those) are expected in the tests that go offline on purpose.
const OFFLINE_NOISE = /net::ERR_INTERNET_DISCONNECTED|WebKit encountered an internal error/;
// What errors.ts says when a request got no answer at all.
const CONNECTION_SENTENCE = 'Connection lost. Check your internet and try again.';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The console filter (no browser): it is the one piece that cannot be seen at work on a local address
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('console filter: only the "access control checks" line of a cancelled request is let through', () => {
  const cancelled = new Map([['https://api.example.test/api/matches/platform', 'Load request cancelled']]);
  const line = (url: string) => `Fetch API cannot load ${url} due to access control checks.`;
  const xhr = (url: string) => `XMLHttpRequest cannot load ${url} due to access control checks.`;
  expect(isCancelledNoise(line('https://api.example.test/api/matches/platform'), '', cancelled), 'a cancelled fetch').toBe(true);
  expect(isCancelledNoise(xhr('https://api.example.test/api/matches/platform'), '', cancelled), 'a cancelled XHR').toBe(true);
  expect(isCancelledNoise('Something else', 'https://api.example.test/api/matches/platform', cancelled), 'another message about it').toBe(false);
  expect(isCancelledNoise(line('https://api.example.test/api/people/x/brief'), '', cancelled), 'the same words for a request that was not cancelled').toBe(false);
  expect(isCancelledNoise('Failed to load resource: the server responded with a status of 500 (Internal Server Error)', 'https://api.example.test/api/matches/platform', cancelled), 'a 500 on the cancelled address').toBe(false);
  expect(isCancelledNoise(line('https://api.example.test/api/matches/platform'), '', new Map()), 'nothing was cancelled').toBe(false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════

test.describe('REASON milestone 1', () => {
  test.beforeAll(async () => {
    console.log(`[reason-m1] engine=${engineLabel()} app=${APP} words=${THE_WORDS}${LOCAL ? ` (local: ${FILLERS} filler members)` : ''}`);
    await seed();
    browser = await launchBrowser();
  });

  test.beforeEach(async () => {
    await resetViewer();
  });

  test.afterAll(async () => {
    for (const c of ctxs) await c.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (made.length) await cleanup(pool, { ids: made });
    const left = await leftovers();
    console.log(`[reason-m1] clean-up: ${made.length} throwaway members, left behind: ${JSON.stringify(left)}`);
    expect(left, 'a throwaway member, or a row about one, is still in the database').toEqual({ users: 0, pokes: 0, responses: 0, outcomes: 0, encounters: 0, blocks: 0, notifications: 0 });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Every size
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  for (const size of sizes(SIZES)) {
    const { width } = size;
    test(`${engineLabel()} ${width}px: shell, For You, sheets and the Human Profile fit; nothing private leaks`, async () => {
      test.setTimeout(300_000);
      await using(viewer, size, async (o) => {
        const { page } = o;
        const where = `${width}px`;

        await test.step('For You', async () => {
          await visit(page, '/');
          await expect(page.getByRole('heading', { level: 1 }), `${where}: the page's title`).toHaveText('Welcome, Vera.');
          await expectPeople(page, [giver, longName, secretive], where);
          expect(await page.locator('[data-person-id]').count(), `${where}: at most five cards`).toBeLessThanOrEqual(5);
          await expectNoSecret(page, `${where} For You`);
          await expect(page.locator('body'), `${where}: a card shows their offer and your want, never "They need"`).not.toContainText(/They need|You can bring/);
          const g = card(page, giver.id);
          await expect(g, `${where}: Gil's own offer is labelled as what they can bring`).toContainText('They can bring');
          await expect(g, `${where}: Gil's own offer`).toContainText(OFFER);
          await expect(g, `${where}: your own want is labelled as yours`).toContainText('You are looking for');
          for (const w of WORDS) await expect(g, `${where}: the reason is made of your own words`).toContainText(w);
          await expectNoSideways(page, `${where} For You`);
          await expectChrome(page, width, `${where} For You`);
          await expectRail(page, width, `${where} For You`);
          await expectImagesLoaded(page, `${where} For You`);
          await inReach(page, page.getByRole('link', { name: 'View all people' }), `${where} View all`, { centre: false });
          await shot(page, width, 'for-you');
          await shot(page, width, width <= 720 ? 'bar' : width >= 981 ? 'sidebar' : 'rail', width <= 720 ? page.locator('nav[aria-label="Main"].fixed') : page.locator('aside').first());

          // The long name, and no photo: initials, nothing cut off, inside the window.
          const lc = card(page, longName.id);
          await expect(lc.getByText('WM', { exact: true }), `${where}: initials replace the photo`).toBeVisible();
          await expect(lc.locator('img'), `${where}: no photo, so no image in the card`).toHaveCount(0);
          const lb = (await lc.boundingBox())!;
          expect(lb.x >= 0 && lb.x + lb.width <= width + 1, `${where}: the long-name card's right edge ${Math.round(lb.x + lb.width)} is inside the window`).toBeTruthy();
          await expectNothingSticksOut(lc, `${where} long-name card`);
          for (const [person, whose] of [[giver, 'Gil'], [longName, 'the long-name member'], [secretive, 'Sofia']] as Array<[TestUser, string]>) {
            const c = card(page, person.id);
            await inReach(page, c.getByRole('button', { name: /^(Meet|Request sent|Continue)$/ }), `${where} the main button on ${whose}'s card`);
            await inReach(page, c.getByRole('button', { name: /^(Save|Saved)$/ }), `${where} Save on ${whose}'s card`);
          }
          await page.locator('main').evaluate((m) => m.scrollTo({ top: m.scrollHeight, behavior: 'instant' as ScrollBehavior }));
          // On a phone, with the list scrolled to its end, the last card ends above the bottom bar, not under it.
          if (width <= 720) {
            const clearance = await page.evaluate(() => {
              const bar = document.querySelector('nav[aria-label="Main"].fixed');
              const cards = document.querySelectorAll('[data-person-id]');
              const last = cards[cards.length - 1];
              return bar && last ? Math.round(bar.getBoundingClientRect().top - last.getBoundingClientRect().bottom) : null;
            });
            expect(clearance, `${where}: the bar and the last card are both there`).not.toBeNull();
            expect(clearance, `${where}: the end of the list sits ${-(clearance ?? 0)}px under the bottom bar`).toBeGreaterThanOrEqual(0);
          }
          await shot(page, width, 'for-you-bottom');
        });

        await test.step('Meet sheet', async () => {
          await page.locator('main').evaluate((m) => m.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }));
          await tap(page, card(page, giver.id).getByRole('button', { name: 'Meet', exact: true }), `${where} Meet`);
          const sheet = page.getByRole('dialog', { name: `Meet ${NAME.giver}` });
          await expect(sheet, `${where}: the Meet sheet opens`).toBeVisible();
          await expectSheetFits(page, sheet, `${where} Meet sheet`);
          await expectNoSecret(page, `${where} Meet sheet`);
          await inReach(page, sheet.getByRole('button', { name: 'Send request' }), `${where} Send request`, { centre: false });
          await inReach(page, sheet.getByRole('button', { name: 'Cancel' }), `${where} Cancel`, { centre: false });
          await shot(page, width, 'meet');
          await tap(page, sheet.getByRole('button', { name: 'Cancel' }), `${where} Cancel`, { centre: false });
          await expect(sheet, `${where}: Cancel closes the sheet`).toBeHidden();
          await expectScrollable(page, `${where} Meet sheet`);
          expect(await pokesOf(viewer, giver), `${where}: Cancel sent nothing`).toEqual([]);
        });

        await test.step('Human Profile', async () => {
          const link = card(page, longName.id).getByRole('link', { name: LONG_NAME, exact: true });
          await link.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior }));
          await link.click();
          await expect(page, `${where}: the card goes to the profile`).toHaveURL(new RegExp(`/people/${longName.id}\\?from=For%20You$`));
          await expectProfileOf(page, longName, LONG_NAME);
          await settle(page);
          const h1 = page.getByRole('heading', { level: 1 });
          await expectInsideWindow(page, h1, `${where} the profile's name`);
          await expectNothingSticksOut(h1, `${where} the profile's name`);
          await expectNoSideways(page, `${where} profile`);
          await expectNothingSticksOut(page.locator('main'), `${where} profile`);
          await expect(page.locator('main').getByText('WM', { exact: true }), `${where}: initials replace the photo`).toBeVisible();
          // A photo is an image named after the member; the sheep are decorative (empty alt).
          await expect(page.locator('main img:not([alt=""])'), `${where}: no photo`).toHaveCount(0);
          await expect(page.getByText('Strong reason').first(), `${where}: the match badge`).toBeVisible();
          await expectNoSecret(page, `${where} profile`);
          await expectImagesLoaded(page, `${where} profile`);
          await inReach(page, backButton(page), `${where} Back`, { centre: false });
          await inReach(page, primaryButton(page), `${where} the move bar's main button`, { centre: false });
          await inReach(page, moveBar(page).getByRole('button', { name: 'Save', exact: true }), `${where} the move bar's Save`, { centre: false });
          await inReach(page, passButton(page), `${where} the move bar's Pass`, { centre: false });
          await scrollWindowTo(page, 'top');
          await shot(page, width, 'profile-top');
          await scrollWindowTo(page, 'bottom');
          await expectClearOfMoveBar(page, `${where} profile`);
          await shot(page, width, 'profile-bottom');
          await tap(page, backButton(page), `${where} Back`, { centre: false });
          await expect(page, `${where}: Back from a card returns to For You`).toHaveURL(`${APP}/`);
          await expectPeople(page, [giver, longName, secretive], `${where} back on For You`);
        });

        await test.step('What happened? sheet', async () => {
          await visit(page, `/people/${met.id}?from=Messages`);
          await expectProfileOf(page, met, NAME.met);
          await expect(page.getByText('You have met 1 time.'), `${where}: the meeting is counted`).toBeVisible();
          await expect(page.getByText('See what you have in common, and whether there is a reason to meet.'), `${where}: no match, so a neutral reason`).toBeVisible();
          await expect(page.getByText('Strong reason'), `${where}: no match, so no badge`).toHaveCount(0);
          await expectNoSecret(page, `${where} met profile`);
          await expectNoSideways(page, `${where} met profile`);
          await tap(page, page.getByRole('button', { name: 'Record what happened' }), `${where} Record what happened`);
          const sheet = page.getByRole('dialog', { name: `What happened with ${NAME.met}?` });
          await expect(sheet, `${where}: the outcome sheet opens`).toBeVisible();
          await expectSheetFits(page, sheet, `${where} outcome sheet`);
          await expect(sheet.getByRole('button', { name: 'Save outcome' }), `${where}: nothing to save before an answer`).toBeDisabled();
          await inReach(page, sheet.getByRole('button', { name: 'Yes', exact: true }), `${where} Yes`, { centre: false });
          await inReach(page, sheet.getByRole('button', { name: 'Cancel' }), `${where} Cancel`, { centre: false });
          await shot(page, width, 'outcome');
          await tap(page, sheet.getByRole('button', { name: 'Cancel' }), `${where} Cancel`, { centre: false });
          await expect(sheet, `${where}: Cancel closes the sheet`).toBeHidden();
          await expectScrollable(page, `${where} outcome sheet`);
          expect(await outcomesOf(viewer, met), `${where}: Cancel stored nothing`).toEqual([]);
        });

        if (width <= 720) {
          await test.step('More sheet', async () => {
            await visit(page, '/');
            await tap(page, page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }), `${where} More`, { centre: false });
            const sheet = page.getByRole('dialog', { name: 'More' });
            await expect(sheet, `${where}: the More sheet opens`).toBeVisible();
            await expectSheetFits(page, sheet, `${where} More sheet`);
            await shot(page, width, 'more');
            await page.keyboard.press('Escape');
            await expect(sheet, `${where}: Escape closes the sheet`).toBeHidden();
            await expectScrollable(page, `${where} More sheet`);
          });
        }

        await expectQuiet(o, where);
        console.log(`  ✓ ${where}: For You, the Meet sheet, the profile (top and bottom), the outcome sheet${width <= 720 ? ' and More' : ''} fit; nothing sticks out or sits under a bar; every button 44px; no private want in any page.`);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Save
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test(`${engineLabel()} phone: Save persists across a reload, and so does un-saving`, async () => {
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      await visit(page, '/');
      await expectPeople(page, [giver, longName, secretive], 'Save');
      const g = card(page, giver.id);
      const save = g.getByRole('button', { name: 'Save', exact: true });
      const saved = g.getByRole('button', { name: 'Saved', exact: true });
      await expect(save, 'a card nobody saved offers Save').toBeVisible();

      await tap(page, save, 'Save (Gil)');
      await expectToast(page, `${NAME.giver} saved`);
      // Exactly one toast, and it is where tap() looks for toasts, so it can tell when none is left to cover a button.
      await expect(toasts(page), 'one press, one toast (and the helper looks where the toasts are)').toHaveCount(1);
      await expect(saved, 'the card says Saved').toBeVisible();
      expect(await responseOf(viewer, giver), 'the Save is stored').toBe('saved');
      for (const other of [longName, secretive]) {
        await expect(card(page, other.id).getByRole('button', { name: 'Save', exact: true }), 'only that card changed').toBeVisible();
      }

      await reload(page);
      await expectPeople(page, [giver, longName, secretive], 'Save, after a reload');
      await expect(saved, 'Saved survives a reload').toBeVisible();

      await tap(page, saved, 'Saved (Gil)');
      await expectToast(page, `${NAME.giver} removed from saved`);
      await expect(save, 'un-saving brings Save back').toBeVisible();
      expect(await responseOf(viewer, giver), 'the Save is gone').toBeUndefined();

      await reload(page);
      await expectPeople(page, [giver, longName, secretive], 'un-save, after a reload');
      await expect(save, 'un-saving survives a reload').toBeVisible();
      await expectQuiet(o, 'Save');
      console.log('  ✓ Save marks the card Saved with a toast and survives a reload; pressing Saved undoes it, with a toast, and that survives a reload too.');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Pass
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test(`${engineLabel()} phone: Pass on the profile hides the person from For You, and Undo pass brings them back`, async () => {
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      await visit(page, '/');
      await expectPeople(page, [giver, longName, secretive], 'Pass');
      await card(page, giver.id).getByRole('link', { name: NAME.giver, exact: true }).click();
      await expectProfileOf(page, giver, NAME.giver);
      await settle(page);

      await expect(passButton(page), 'a person nobody passed on offers Pass').toHaveAccessibleName('Pass: not relevant right now');
      await tap(page, passButton(page), 'Pass', { centre: false });
      await expectToast(page, 'Gil will not be suggested in For You. You can undo this here.');
      await expect(passButton(page), 'the button turns into Undo pass').toHaveAccessibleName('Undo pass');
      expect(await responseOf(viewer, giver), 'the Pass is stored').toBe('passed');

      await tap(page, backButton(page), 'Back', { centre: false });
      await expect(page, 'Back returns to For You').toHaveURL(`${APP}/`);
      await expectPeople(page, [longName, secretive], 'after Pass');
      await reload(page);
      await expectPeople(page, [longName, secretive], 'after Pass and a reload');

      // Undo from the profile, opened by its own address this time.
      await visit(page, `/people/${giver.id}`);
      await expectProfileOf(page, giver, NAME.giver);
      await expect(passButton(page), 'the profile remembers the Pass').toHaveAccessibleName('Undo pass');
      await tap(page, passButton(page), 'Undo pass', { centre: false });
      await expectToast(page, 'Gil can be suggested in For You again.');
      await expect(passButton(page), 'Undo pass turns back into Pass').toHaveAccessibleName('Pass: not relevant right now');
      expect(await responseOf(viewer, giver), 'the Pass is gone').toBeUndefined();

      await visit(page, '/');
      await expectPeople(page, [giver, longName, secretive], 'after Undo pass');
      await expectQuiet(o, 'Pass');
      console.log('  ✓ Pass hides the person from For You (and after a reload) with a toast; Undo pass brings them back, with a toast.');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Meet
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test(`${engineLabel()} phone: Meet sends one request, the note first and then the format; a private want never reaches the page`, async () => {
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      await visit(page, '/');
      await expectPeople(page, [giver, longName, secretive], 'Meet');
      await expectNoSecret(page, 'For You');

      const s = card(page, secretive.id);
      await tap(page, s.getByRole('button', { name: 'Meet', exact: true }), 'Meet (Sofia)');
      const sheet = page.getByRole('dialog', { name: `Meet ${NAME.secretive}` });
      await expect(sheet, 'the Meet sheet opens').toBeVisible();
      await expectNoSecret(page, 'the open Meet sheet');
      const box = sheet.getByRole('textbox');
      await expect(box, 'the sheet opens with a sentence to start from').not.toHaveValue('');
      const note = `Hello from the preview ${run}`;
      await box.fill(note);
      await sheet.getByRole('combobox').selectOption('coffee');
      await expect(sheet.getByText(`${note.length} / 300`), 'the counter counts the note').toBeVisible();

      const posts = countRequests(page, 'POST', new RegExp(`/api/matches/platform/${secretive.id}/interest$`));
      await tap(page, sheet.getByRole('button', { name: 'Send request' }), 'Send request', { centre: false, presses: 2 });
      await expect(sheet, 'the sheet closes once the request is sent').toBeHidden();
      await expectScrollable(page, 'after the request is sent');
      await expectToast(page, `Meeting request sent to ${NAME.secretive}`);
      await expect(s.getByRole('button', { name: 'Request sent', exact: true }), 'the card says Request sent').toBeDisabled();
      await expectNoSecret(page, 'For You after the request is sent');
      await settle(page);
      expect(posts.count(), 'a double press is ONE request on the wire').toBe(1);
      const rows = await pokesOf(viewer, secretive);
      expect(rows, 'a double press stores ONE request').toHaveLength(1);
      expect(rows[0].message.startsWith(`${note}\n\nWhy REASON suggested this: `), `the stored message is the note, a blank line, then REASON's reason: ${JSON.stringify(rows[0].message)}`).toBe(true);
      for (const w of WORDS) expect(rows[0].message, `the reason is made of the sender's own words (${w})`).toContain(w);
      expect(rows[0].message, 'the request never carries the other member\'s private want').not.toContain(SECRET);
      expect(rows[0].preferred_format, 'the chosen format is stored').toBe('coffee');

      await reload(page);
      await expectPeople(page, [giver, longName, secretive], 'Meet, after a reload');
      await expect(s.getByRole('button', { name: 'Request sent', exact: true }), 'the request is remembered').toBeDisabled();
      await s.getByRole('link', { name: NAME.secretive, exact: true }).click();
      await expectProfileOf(page, secretive, NAME.secretive);
      await expect(primaryButton(page), 'the profile says the request is out').toHaveAccessibleName('Request sent');
      await expect(primaryButton(page)).toBeDisabled();
      await expect(page.getByText('Meeting requested', { exact: true }).first(), 'the profile names the state').toBeVisible();
      await expectNoSecret(page, 'the profile of the member who was asked');
      await expectQuiet(o, 'Meet');
      console.log('  ✓ Meet: a double press is one POST and one stored request (note first, then the format); the private want is nowhere in For You, the open sheet, the sent request or the profile.');
    });
  });

  test(`${engineLabel()} phone: a note being typed, and the chosen format, survive the page refetching when the window comes back`, async () => {
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      const typed = `Typed and kept ${run}`;
      const meetSheet = () => page.getByRole('dialog', { name: `Meet ${NAME.giver}` });
      const expectKept = async (where: string) => {
        await expect(meetSheet(), `${where}: the sheet is still open`).toBeVisible();
        await expect(meetSheet().getByRole('textbox'), `${where}: the typed note is still there`).toHaveValue(typed);
        await expect(meetSheet().getByRole('combobox'), `${where}: the chosen format is still there`).toHaveValue('message_first');
        await expect(meetSheet().getByText(`${typed.length} / 300`), `${where}: the counter follows the note`).toBeVisible();
      };

      // On For You, from a card.
      await visit(page, '/');
      await expectPeople(page, [giver, longName, secretive], 'typing');
      await tap(page, card(page, giver.id).getByRole('button', { name: 'Meet', exact: true }), 'Meet (Gil)');
      await expect(meetSheet()).toBeVisible();
      await meetSheet().getByRole('textbox').fill(typed);
      await meetSheet().getByRole('combobox').selectOption('message_first');
      await windowComesBack(page, /\/api\/matches\/platform$/, 'For You');
      await expectKept('For You');
      await page.keyboard.press('Escape');
      await expect(meetSheet(), 'Escape closes the sheet').toBeHidden();
      await expectScrollable(page, 'after Escape');
      // A sheet opened again starts fresh: the last note is not kept for it.
      await tap(page, card(page, giver.id).getByRole('button', { name: 'Meet', exact: true }), 'Meet (Gil) again');
      await expect(meetSheet().getByRole('textbox'), 'a reopened sheet starts from the sentence again').not.toHaveValue(typed);
      await expect(meetSheet().getByRole('combobox'), 'and from the first format').toHaveValue('video_20');
      await tap(page, meetSheet().getByRole('button', { name: 'Cancel' }), 'Cancel', { centre: false });
      await expect(meetSheet()).toBeHidden();

      // On the profile, from the bar at the bottom.
      await visit(page, `/people/${giver.id}`);
      await expectProfileOf(page, giver, NAME.giver);
      await tap(page, primaryButton(page), 'Meet (Gil, profile)', { centre: false });
      await expect(meetSheet()).toBeVisible();
      await meetSheet().getByRole('textbox').fill(typed);
      await meetSheet().getByRole('combobox').selectOption('message_first');
      await windowComesBack(page, new RegExp(`/api/people/${giver.id}/brief$`), 'the profile');
      await expectKept('the profile');
      await tap(page, meetSheet().getByRole('button', { name: 'Cancel' }), 'Cancel', { centre: false });
      await expect(meetSheet()).toBeHidden();

      expect(await pokesOf(viewer, giver), 'nothing was sent').toEqual([]);
      await expectQuiet(o, 'typing');
      console.log('  ✓ A note and a format chosen in the Meet sheet survive the page refetching on focus, on For You and on the profile; a reopened sheet starts fresh.');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // What happened?
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test(`${engineLabel()} phone: What happened stores one outcome per press, and "Nothing yet" excludes the rest`, async () => {
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      await visit(page, `/people/${met.id}?from=Messages`);
      await expectProfileOf(page, met, NAME.met);
      await expect(page.getByText('You have met 1 time.'), 'the meeting is counted').toBeVisible();
      await expect(page.getByText('You found Mia through Messages'), 'the known source is named').toBeVisible();
      await expect(primaryButton(page), 'people who met are offered Continue').toHaveAccessibleName('Continue');

      await tap(page, page.getByRole('button', { name: 'Record what happened' }), 'Record what happened');
      const sheet = page.getByRole('dialog', { name: `What happened with ${NAME.met}?` });
      await expect(sheet, 'the outcome sheet opens').toBeVisible();
      const save = sheet.getByRole('button', { name: 'Save outcome' });
      const choice = (name: string) => sheet.getByRole('button', { name, exact: true });
      await expect(save, 'nothing to save before an answer').toBeDisabled();
      await tap(page, choice('Yes'), 'Yes', { centre: false });
      await expect(choice('Yes')).toHaveAttribute('aria-pressed', 'true');
      await expect(save, 'an answer is enough to save').toBeEnabled();

      // "Nothing yet" says nothing came of it: it clears the others, and any other outcome clears it.
      await tap(page, choice('Introduction'), 'Introduction', { centre: false });
      await tap(page, choice('Nothing yet'), 'Nothing yet', { centre: false });
      await expect(choice('Nothing yet')).toHaveAttribute('aria-pressed', 'true');
      await expect(choice('Introduction'), 'Nothing yet takes the others off').toHaveAttribute('aria-pressed', 'false');
      await tap(page, choice('Advice'), 'Advice', { centre: false });
      await expect(choice('Nothing yet'), 'another outcome takes Nothing yet off').toHaveAttribute('aria-pressed', 'false');
      await tap(page, choice('Introduction'), 'Introduction', { centre: false });
      await expect(choice('Advice')).toHaveAttribute('aria-pressed', 'true');
      await expect(choice('Introduction')).toHaveAttribute('aria-pressed', 'true');

      const posts = countRequests(page, 'POST', new RegExp(`/api/people/${met.id}/outcome$`));
      await tap(page, save, 'Save outcome', { centre: false, presses: 2 });
      await expect(sheet, 'the sheet closes once it is saved').toBeHidden();
      await expectScrollable(page, 'after the outcome is saved');
      await expectToast(page, `Saved what happened with ${NAME.met}`);
      await expect(page.getByText('Worth continuing', { exact: true }), 'the timeline shows the answer').toBeVisible();
      await expect(page.getByText(/^(Advice, Introduction|Introduction, Advice)$/), 'and what came of it').toBeVisible();
      await settle(page);
      expect(posts.count(), 'a double press is ONE request on the wire').toBe(1);
      const rows = await outcomesOf(viewer, met);
      expect(rows, 'a double press stores ONE outcome').toHaveLength(1);
      expect(rows[0].worth_continuing).toBe('yes');
      expect([...rows[0].outcome_keys].sort(), 'the outcomes chosen are the ones stored').toEqual(['advice', 'introduction']);

      await reload(page);
      await expectProfileOf(page, met, NAME.met);
      await expect(page.getByText('Worth continuing', { exact: true }), 'the outcome is remembered').toBeVisible();
      await expectNoSecret(page, 'the profile after the outcome');
      await expectQuiet(o, 'What happened');
      console.log('  ✓ What happened: Nothing yet and the other outcomes exclude each other; a double press is one POST and one stored outcome, shown on the profile after a reload.');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // A profile that is not there
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test(`${engineLabel()} phone: a blocked member's profile is not available and shows none of their data`, async () => {
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      const briefUrl = new RegExp(`/api/people/${ours(blocked.id)}/brief$`);
      o.quiet.allow(/status of 404/, briefUrl);
      const reply = page.waitForResponse((r) => briefUrl.test(r.url()), { timeout: SLOW });
      await visit(page, `/people/${blocked.id}`);
      const res = await reply;
      expect(res.status(), 'the server answers 404 for a member who blocked the viewer').toBe(404);
      const body = await res.text();
      const theirs = [NAME.blocked, ...Object.values(BLOCKED_DATA), SECRET, THE_WORDS];
      for (const s of theirs) expect(body, `the answer carries none of their data (${s})`).not.toContain(s);

      await expect(page.getByRole('heading', { level: 1, name: 'This profile is not available.' }), 'the page says so').toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('We could not load this profile just now.'), 'and does not offer a retry that cannot help').toHaveCount(0);
      const html = await page.content();
      for (const s of theirs) expect(html.includes(s), `the page shows none of their data (${s})`).toBe(false);
      await expect(moveBar(page), 'no move bar for a profile that is not there').toHaveCount(0);
      await expect(page.getByText('Strong reason'), 'no match badge').toHaveCount(0);
      await expectNoSideways(page, 'not available');

      // The way out: a profile opened by its own address goes to For You, which does not list them either.
      await tap(page, page.getByRole('button', { name: 'Go back' }), 'Go back', { centre: false });
      await expect(page).toHaveURL(`${APP}/`);
      await expectPeople(page, [giver, longName, secretive], 'after leaving the blocked profile');

      // An address that is no member id is answered without asking the server at all.
      const asked = countRequests(page, 'GET', /\/api\/people\/[^/]+\/brief/);
      await visit(page, '/people/not-a-member-id');
      await expect(page.getByRole('heading', { level: 1, name: 'This profile is not available.' }), 'a mistyped address').toBeVisible({ timeout: 15_000 });
      expect(asked.count(), 'a mistyped address sends no request').toBe(0);
      await expectQuiet(o, 'blocked');
      console.log('  ✓ A blocked member\'s profile: the server says 404 with none of their data, the page says "not available" with none of it either; a mistyped address asks nothing.');
    });
  });

  test(`${engineLabel()} phone: a profile opened by a direct link goes back to For You; one opened from a card goes back to where it came from`, async () => {
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      // A direct link in a fresh tab (a link from an email): there is nothing to go back to inside the app.
      const tab = await newTab(o);
      await visit(tab, `/people/${giver.id}`);
      await expectProfileOf(tab, giver, NAME.giver);
      await expect(tab.getByText('About Gil', { exact: true }), 'no known source: the box is about the person').toBeVisible();
      await expect(tab.getByText('Strong reason').first(), 'the match is shown whatever the source').toBeVisible();
      await tap(tab, backButton(tab), 'Back (direct link)', { centre: false });
      await expect(tab, 'Back from a direct link goes to For You').toHaveURL(`${APP}/`);
      await expect(tab.getByRole('heading', { level: 1 }), 'and For You is what it shows').toHaveText('Welcome, Vera.', { timeout: SLOW });

      // ?from= is read from the address, so only the places the app itself writes are ever named.
      const madeUpSource = 'Totally Made Up Source';
      await visit(tab, `/people/${giver.id}?from=${encodeURIComponent(madeUpSource)}`);
      await expectProfileOf(tab, giver, NAME.giver);
      await expect(tab.getByText('About Gil', { exact: true }), 'a made-up source is not a source').toBeVisible();
      expect((await tab.content()).includes(madeUpSource), 'a made-up ?from= is never printed').toBe(false);
      await visit(tab, `/people/${giver.id}?from=People`);
      await expect(tab.getByText('You found Gil through People'), 'a source the app writes is named').toBeVisible();
      await tab.close();

      // From a card: Back is the browser's own step back.
      await visit(page, '/');
      await expectPeople(page, [giver, longName, secretive], 'Back');
      await card(page, giver.id).getByRole('link', { name: NAME.giver, exact: true }).click();
      await expectProfileOf(page, giver, NAME.giver);
      await expect(page, 'the card names where it came from').toHaveURL(/\?from=For%20You$/);
      await expect(page.getByText('You found Gil through For You')).toBeVisible();
      await tap(page, backButton(page), 'Back (from a card)', { centre: false });
      await expect(page, 'Back from a card returns to For You').toHaveURL(`${APP}/`);
      await expectPeople(page, [giver, longName, secretive], 'back on For You');
      await expectQuiet(o, 'Back');
      console.log('  ✓ Back: a direct link in a fresh tab goes to For You; from a card it returns to For You; a made-up ?from= is not printed and a known one is named.');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // When a request fails
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test(`${engineLabel()} phone: if For You cannot load it says so with Try again, and Try again recovers`, async () => {
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      const url = /\/api\/matches\/platform$/;
      let failing = true;
      await page.route(url, (route) => (failing ? route.fulfill(FORCED_500) : route.continue()));
      o.quiet.allow(/status of 500/, url);

      await visit(page, '/');
      const message = page.getByRole('heading', { name: 'We could not load your people just now.' });
      await expect(message, 'a failed request shows its error').toBeVisible({ timeout: 30_000 });
      // The page's own alert: the toast stack has an (empty) alert region of its own, outside <main>.
      await expect(page.getByRole('main').getByRole('alert')).toContainText('We could not load your people just now.');
      await expect(page.locator('[data-person-id]'), 'no card is drawn').toHaveCount(0);
      await expect(page.getByText('No one new to suggest right now.'), 'a failure is not "no one to suggest"').toHaveCount(0);
      await expectNoSideways(page, 'For You error');

      failing = false;
      await tap(page, page.getByRole('button', { name: 'Try again' }), 'Try again');
      await expectPeople(page, [giver, longName, secretive], 'after Try again');
      await expect(message, 'the error goes away').toHaveCount(0);
      await expectQuiet(o, 'For You error');
      console.log('  ✓ For You forced to 500: the error and Try again, no false empty state; Try again recovers once the route is released.');
    });
  });

  test(`${engineLabel()} phone: if a profile cannot load it says so with Try again, and Try again recovers`, async () => {
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      const url = new RegExp(`/api/people/${ours(giver.id)}/brief$`);
      let failing = true;
      await page.route(url, (route) => (failing ? route.fulfill(FORCED_500) : route.continue()));
      o.quiet.allow(/status of 500/, url);

      await visit(page, `/people/${giver.id}?from=For%20You`);
      await expect(page.getByRole('heading', { level: 1, name: 'We could not load this profile just now.' }), 'a failed request shows the retry state').toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('This profile is not available.'), 'a failure is not "not available"').toHaveCount(0);
      await inReach(page, page.getByRole('button', { name: 'Go back' }), 'Go back (retry state)', { centre: false });
      await expectNoSideways(page, 'profile error');

      failing = false;
      await tap(page, page.getByRole('button', { name: 'Try again' }), 'Try again', { centre: false });
      await expectProfileOf(page, giver, NAME.giver);
      await expect(page.getByText('We could not load this profile just now.'), 'the error goes away').toHaveCount(0);
      await expectQuiet(o, 'profile error');
      console.log('  ✓ A profile forced to 500: the retry state (not "not available") and Try again; Try again recovers once the route is released.');
    });
  });

  test(`${engineLabel()} phone: with no connection a Save fails at once and says so, and nothing loaded shows the error state and fills in when the connection returns`, async () => {
    test.setTimeout(240_000);

    // 1. A list on screen, then the connection goes: a Save answers at once and the list stays.
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      o.quiet.allow(OFFLINE_NOISE, /./);
      await visit(page, '/');
      await expectPeople(page, [giver, longName, secretive], 'offline Save');
      await o.ctx.setOffline(true);
      await tap(page, card(page, giver.id).getByRole('button', { name: 'Save', exact: true }), 'Save (Gil), offline');
      await expectToast(page, CONNECTION_SENTENCE);
      await expect(card(page, giver.id).getByRole('button', { name: 'Save', exact: true }), 'nothing was saved').toBeVisible();
      await expectPeople(page, [giver, longName, secretive], 'the list stays when a Save fails');
      expect(await responseOf(viewer, giver), 'nothing was stored').toBeUndefined();

      // 2. A profile opened with no connection and nothing loaded for it: the error state, then it fills in by itself.
      await card(page, giver.id).getByRole('link', { name: NAME.giver, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'We could not load this profile just now.' }), 'offline, nothing loaded: the retry state').toBeVisible({ timeout: 15_000 });
      await inReach(page, page.getByRole('button', { name: 'Try again' }), 'Try again (offline profile)', { centre: false });
      await expect(page.getByText('This profile is not available.'), 'being offline is not "not available"').toHaveCount(0);
      await o.ctx.setOffline(false);
      await expectProfileOf(page, giver, NAME.giver);
      await settle(page);
      await expectQuiet(o, 'offline profile');
    });

    // 3. For You opened with no connection and nothing loaded for it: the error state, never "no one to suggest".
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      o.quiet.allow(OFFLINE_NOISE, /./);
      await visit(page, '/circles');
      await o.ctx.setOffline(true);
      await tap(page, page.getByRole('link', { name: 'For You', exact: true }), 'For You, offline', { centre: false });
      await expect(page.getByRole('heading', { name: 'We could not load your people just now.' }), 'offline, nothing loaded: the error state').toBeVisible({ timeout: 15_000 });
      await inReach(page, page.getByRole('button', { name: 'Try again' }), 'Try again (offline For You)', { centre: false });
      await expect(page.getByText('No one new to suggest right now.'), 'being offline is not "no one to suggest"').toHaveCount(0);
      await o.ctx.setOffline(false);
      await expectPeople(page, [giver, longName, secretive], 'For You fills in when the connection returns');
      await settle(page);
      await expectQuiet(o, 'offline For You');
    });
    console.log('  ✓ Offline: a Save fails at once with the connection sentence and the list stays; a profile and For You with nothing loaded show their error state (never "not available" or "no one to suggest") and fill in by themselves.');
  });

  // KNOWN SCREEN DEFECT, found by this spec on 7 Oct 2026. With no connection and nothing
  // loaded, For You and the profile say a generic sentence ("Could not load that right now. Try again in a
  // moment." / "Try again in a moment.") where the code, its commit message and the milestone notes say the
  // connection sentence. ForYouPage builds CONNECTION_LOST with errorMessage(undefined, ...), which since
  // c1db1cf1 returns the fallback for anything that is not an axios error with no answer, and the profile
  // passes a null error the same way. The two tests below assert the INTENDED behaviour, one for each page, so
  // each turns red on its own the day its page is fixed. test.fail() keeps the run usable while the screen is
  // wrong: when a page is fixed, delete the test.fail() line of its test.
  test(`${engineLabel()} phone: KNOWN DEFECT: offline with nothing loaded, For You says the connection sentence`, async () => {
    test.fail(true, 'defect: For You says "Could not load that right now. Try again in a moment.", not "Connection lost. Check your internet and try again."');
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      o.quiet.allow(OFFLINE_NOISE, /./);
      await visit(page, '/circles');
      await o.ctx.setOffline(true);
      await tap(page, page.getByRole('link', { name: 'For You', exact: true }), 'For You, offline', { centre: false });
      await expect(page.getByRole('heading', { name: 'We could not load your people just now.' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('main').getByRole('alert'), 'For You says the connection was lost').toContainText(CONNECTION_SENTENCE, { timeout: 3_000 });
    });
  });

  test(`${engineLabel()} phone: KNOWN DEFECT: offline with nothing loaded, the profile says the connection sentence`, async () => {
    test.fail(true, 'defect: the profile says "Try again in a moment.", not "Connection lost. Check your internet and try again."');
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      o.quiet.allow(OFFLINE_NOISE, /./);
      await visit(page, '/');
      await expectPeople(page, [giver, longName, secretive], 'offline profile');
      await o.ctx.setOffline(true);
      await card(page, giver.id).getByRole('link', { name: NAME.giver, exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'We could not load this profile just now.' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('main'), 'the profile says the connection was lost').toContainText(CONNECTION_SENTENCE, { timeout: 3_000 });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // The phone's More sheet, and the wide screen's rail
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test(`${engineLabel()} phone: More lists the rest of the app and each entry opens`, async () => {
    test.skip(PHONE.width > 720, 'the More sheet only exists on a phone-sized window');
    test.setTimeout(240_000);
    await using(viewer, PHONE, async (o) => {
      const { page } = o;
      await visit(page, '/');
      const sheet = page.getByRole('dialog', { name: 'More' });
      await tap(page, page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }), 'More', { centre: false });
      await expect(sheet, 'More opens').toBeVisible();
      for (const label of ['Entities', 'Circles', 'Pods', 'Introductions', 'Settings', 'Support']) {
        await inReach(page, sheet.getByRole('link', { name: label, exact: true }), `More: ${label}`, { centre: false });
      }
      await tap(page, sheet.getByRole('link', { name: 'Circles', exact: true }), 'More: Circles', { centre: false });
      await expect(page, 'Circles opens').toHaveURL(/\/circles$/);
      await expect(sheet, 'and the sheet closes').toBeHidden();
      await expectQuiet(o, 'More');
      console.log('  ✓ More lists Entities, Circles, Pods, Introductions, Settings and Support, each 44px and reachable; Circles opens and closes the sheet.');
    });
  });

  test(`${engineLabel()} 1280px: the context rail beside For You, and where it starts`, async () => {
    test.skip(!!DEVICE, 'the rail needs a wide window, and a device has only its own size');
    test.setTimeout(240_000);
    await using(viewer, { width: 1280, height: 800 }, async (o) => {
      const { page } = o;
      await visit(page, '/');
      await expectPeople(page, [giver, longName, secretive], 'the rail');
      const rail = page.getByRole('complementary', { name: 'Your context' });
      await expect(rail, 'the rail is beside the list').toBeVisible();
      for (const title of ['Your next event', 'Your pods', 'Recent introductions']) {
        await expect(rail.getByRole('heading', { name: title }), `the rail's ${title}`).toBeVisible();
      }
      await expect(rail.getByText('You are not in a pod yet.'), 'a member in no pod is told so').toBeVisible();
      await expect(rail.getByText('When someone accepts a meeting request, they show up here.'), 'no introductions yet').toBeVisible();
      // The next event is whatever the network has next, or the sentence that there is none: never "could not load".
      const next = rail.locator('section', { has: page.getByRole('heading', { name: 'Your next event' }) });
      await expect(next.locator('a[href^="/sessions/"]').or(next.getByText('No upcoming event yet. New ones appear here.')), 'the next event has answered').toBeVisible();
      await expect(rail.getByText('We could not load this just now.'), 'nothing in the rail failed').toHaveCount(0);
      for (const [name, href] of [['View all events', '/sessions'], ['View all pods', '/pods'], ['View all introductions', '/messages']]) {
        const link = rail.getByRole('link', { name });
        await expect(link, `${name} goes where it says`).toHaveAttribute('href', href);
        await inReach(page, link, name, { centre: false });
      }
      await shot(page, 1280, 'rail-context');

      // It starts at 981px; one pixel less and the list has the whole width.
      await page.setViewportSize({ width: 981, height: 800 });
      await expect(rail, 'the rail at 981px').toBeVisible();
      await expectNoSideways(page, '981px');
      await page.setViewportSize({ width: 980, height: 800 });
      await expect(rail, 'no rail at 980px').toBeHidden();
      await expectNoSideways(page, '980px');
      await expectQuiet(o, 'rail');
      console.log('  ✓ The context rail: next event, pods and recent introductions with 44px "View all" links, from 981px and not at 980px.');
    });
  });
});
