// e2e/tests/reason-m1-shell.spec.ts
//
// REASON milestone 1, task B2: the new signed-in shell, proven on the Vercel preview.
//
//   1  every width     no sideways scroll on the shell pages at 360, 390, 430, 768, 1024,
//                      1280, 1440 and 1920; the right navigation for the width; the official
//                      sheep logo; every navigation target at least 44px
//   2  phone bar       up to 720px: For You, People, Events, Messages, More; the More sheet
//                      lists Entities, Circles, Pods, Introductions, Settings, Support and
//                      each one navigates
//   3  breakpoints     720 / 721 and 980 / 981: where the bar, the icon rail (eight named icons,
//                      no words) and the full sidebar (labels) start and stop
//   4  People          the four people pages sit under one row of four tabs
//   5  top search      opens Find people with the words already typed
//   6  profile nudge   a member who has not finished onboarding is asked to, on every page but
//                      For You and Messages; one who has finished is not asked anywhere
//   7  Messages        no nudge there, and the message box is fully visible above the bar with the
//                      page area at the top, in a thread from 360x548 to 1280x800 and when writing
//                      a new message at 360x640 (a pinned nudge pushed it under the bar on phone
//                      windows about 640px tall); on a short landscape phone the page area scrolls
//                      and the box is fully inside the window once it is scrolled to its end
//   8  old pages       Circles, Events, Messages, Settings, Pods and Support render inside
//                      the shell with no script errors
//   9  account menu    Invite and Log out stay reachable (Admin only for admins); the account
//                      button and More are marked current on Invite
//  10  unread count    the Messages link names its unread count (bar, rail and sidebar)
//
// Two throwaway members, no admin. Both are created in the database this run talks to and
// removed by exact id in afterAll. The preview reads and writes PRODUCTION data, so nothing
// here sends a request to another member: the one conversation the Messages checks need is
// written straight into the two throwaway members' own rows (and removed with them).
//
// Run it against the Vercel preview, one engine at a time (one spec per process: the pool is
// shared):
//   cd e2e
//   E2E_APP_URL=https://<preview> E2E_VERCEL_SHARE=<_vercel_share token> E2E_JWT_SECRET=<prod key> \
//     npx playwright test tests/reason-m1-shell.spec.ts
//   E2E_ENGINE=webkit ... npx playwright test tests/reason-m1-shell.spec.ts
//   E2E_ENGINE=webkit E2E_DEVICE='iPhone 14' ... (the device's own size is then the only size)
// E2E_HEADED=0 runs it headless. E2E_JWT_SECRET must be the signing key of the API the
// preview talks to, or every page below is a sign-in screen.

import { test, expect, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, wait, APP } from '../helpers/live-ui';
import { launchBrowser, engineLabel, contextOptions } from '../helpers/engine';
import { primePreview } from '../helpers/preview-bypass';
import { expectReachable } from '../helpers/viewport-fit';

const SHOTS = path.resolve(__dirname, '../../workspace/scratch/2026-10-05-reason-shell-preview-shots');

let browser: Browser | undefined;
const ctxs: BrowserContext[] = [];
// Every throwaway account, pushed the moment it exists, removed by exact id in afterAll.
const made: string[] = [];
let member: TestUser;
let unfinished: TestUser;

// ── The shell's own vocabulary (client/src/features/reason/shell/nav.ts) ─────────────────────

const MAIN = ['For You', 'People', 'Entities', 'Circles', 'Pods', 'Events', 'Messages', 'Introductions'];
const SUB = ['Profile', 'Settings', 'Support'];
const BAR = ['For You', 'People', 'Events', 'Messages', 'More'];
const MORE = ['Entities', 'Circles', 'Pods', 'Introductions', 'Settings', 'Support'];
const PEOPLE_TABS = [
  { to: '/search', label: 'Find people' },
  { to: '/agents', label: 'Your searches' },
  { to: '/matches', label: 'Everyone who fits' },
  { to: '/encounters', label: 'People you have met' },
];

// Breakpoints: the bar up to 720px, the icon rail 721 to 980px, the full sidebar from 981px.
type Mode = 'phone' | 'rail' | 'sidebar';
const modeOf = (width: number): Mode => (width <= 720 ? 'phone' : width <= 980 ? 'rail' : 'sidebar');

interface Size { width: number; height: number }
const WIDTHS: Size[] = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

// With E2E_DEVICE set, the device's own viewport is the only size.
const DEVICE = process.env.E2E_DEVICE;
function sizes(wanted: Size[]): Size[] {
  if (!DEVICE) return wanted;
  return [contextOptions().viewport ?? { width: 390, height: 844 }];
}

// The browser's own notice that a resize observer needed another frame. Not an application error.
const BENIGN_PAGE_ERROR = /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i;

// ── Accounts and pages ───────────────────────────────────────────────────────────────────────

// One conversation between the two throwaway members, written straight into their own rows, so a
// real thread (with its real composer) can be opened. Nothing is sent and nobody is told. The
// message is marked read; cleanup() removes both rows with the members.
let threadId: string | undefined;
async function thread(): Promise<string> {
  if (threadId) return threadId;
  const made1 = await pool.query<{ id: string }>(
    `INSERT INTO dm_conversations (user_a_id, user_b_id, last_message_at)
     VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), NOW()) RETURNING id`,
    [member.id, unfinished.id],
  );
  threadId = made1.rows[0].id;
  await pool.query(
    `INSERT INTO direct_messages (conversation_id, from_user_id, content, read_at) VALUES ($1, $2, $3, NOW())`,
    [threadId, member.id, 'Hello from the shell spec.'],
  );
  return threadId;
}

async function makeMember(label: string, opts: { finishedOnboarding: boolean }): Promise<TestUser> {
  const u = await createTestUser(`m1shell-${label}`);
  made.push(u.id);
  // The sign-in gate (ProtectedRoute) keys on onboarding_status, which stays 'completed' so the
  // member can use the app; the profile nudge keys on onboarding_completed, the flag this flips.
  if (!opts.finishedOnboarding) await pool.query(`UPDATE users SET onboarding_completed = false WHERE id = $1`, [u.id]);
  return u;
}

interface Opened { page: Page; ctx: BrowserContext; errors: string[] }

// A signed-in browser at a given size. Script errors are collected, never swallowed.
async function openAs(u: TestUser, size: Size): Promise<Opened> {
  if (!browser) throw new Error('the browser is not open');
  const ctx = await browser.newContext(DEVICE ? contextOptions() : { viewport: size });
  ctxs.push(ctx);
  await primePreview(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    if (!BENIGN_PAGE_ERROR.test(e.message)) errors.push(`${size.width}px ${page.url()}: ${e.message}`);
  });
  return { page, ctx, errors };
}

// Opens a page and waits until the shell has drawn: the Main bar on a phone, the sidebar otherwise.
// The shell's own styles must be on first: a development server injects them a moment after the
// first paint, and until then the sidebar and the phone bar are both on screen, so a role query
// for "Main" finds two navigations and fails at once. (A production build ships its styles in the
// page head and never shows that frame.) The sidebar is position: fixed once the styles are on,
// whether or not it is displayed.
async function visit(page: Page, route: string, width: number): Promise<void> {
  await gotoRetry(page, `${APP}${route}`);
  await page.waitForFunction(() => {
    const aside = document.querySelector('aside');
    return !!aside && getComputedStyle(aside).position === 'fixed';
  }, undefined, { timeout: 30_000 }).catch(() => {
    throw new Error(`${width}px ${route}: the shell did not draw (is the member signed in? now at ${page.url()})`);
  });
  const chrome = modeOf(width) === 'phone' ? page.getByRole('navigation', { name: 'Main' }) : page.locator('aside');
  await expect(chrome, `${width}px ${route}: the shell did not draw (is the member signed in? now at ${page.url()})`).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('load');
  await page.evaluate(async () => { await document.fonts.ready; });
  await wait(900); // let the page's own data arrive before anything is measured
}

const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split('\n')[0];

// ── Checks ───────────────────────────────────────────────────────────────────────────────────

// The window must not scroll at all (the page area, <main>, is what scrolls), and neither may the
// page area scroll sideways, which is what a too-wide screen would push on instead. On a phone,
// once the page area is scrolled to its end, nothing of the page may sit under the bottom bar.
async function expectContained(page: Page, where: string): Promise<void> {
  const m = await page.evaluate(() => {
    const main = document.querySelector('main');
    const bar = document.querySelector('nav[aria-label="Main"].fixed') as HTMLElement | null;
    const wrapper = main?.firstElementChild as HTMLElement | null;
    let clearance: number | null = null;
    if (main && bar && wrapper && getComputedStyle(bar).display !== 'none') {
      main.scrollTop = main.scrollHeight;
      clearance = Math.round(bar.getBoundingClientRect().top - wrapper.getBoundingClientRect().bottom);
      main.scrollTop = 0;
    }
    return {
      docW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      docH: document.documentElement.scrollHeight,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      mainOver: main ? main.scrollWidth - main.clientWidth : 0,
      clearance,
    };
  });
  expect(m.docW, `${where}: the window scrolls sideways (scrollWidth ${m.docW} over ${m.innerW})`).toBeLessThanOrEqual(m.innerW);
  expect(m.docH, `${where}: the window scrolls up and down (height ${m.docH} over ${m.innerH}); only the page area should`).toBeLessThanOrEqual(m.innerH + 1);
  expect(m.mainOver, `${where}: the page area scrolls sideways by ${m.mainOver}px`).toBeLessThanOrEqual(1);
  if (m.clearance !== null) expect(m.clearance, `${where}: the end of the page sits ${-m.clearance}px under the bottom bar`).toBeGreaterThanOrEqual(0);
}

// Every target at least 44px each way, measured the way a finger meets it.
async function expectTapSize(targets: Array<{ name: string; loc: Locator }>, where: string): Promise<void> {
  const bad: string[] = [];
  for (const t of targets) {
    const box = await t.loc.boundingBox();
    if (!box) { bad.push(`${t.name}: not rendered`); continue; }
    if (box.width < 43.5 || box.height < 43.5) bad.push(`${t.name}: ${Math.round(box.width)}x${Math.round(box.height)}px`);
  }
  expect(bad, `${where}: targets under 44px\n${bad.join('\n')}`).toEqual([]);
}

// The official sheep mark, loaded, from /rsn-sheep.png.
async function expectOfficialLogo(page: Page, where: string): Promise<void> {
  const logo = page.locator('img[src="/rsn-sheep.png"]:visible').first();
  await expect(logo, `${where}: the official sheep logo is not on screen`).toBeVisible();
  const loaded = await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  expect(loaded, `${where}: /rsn-sheep.png did not load`).toBe(true);
}

// The navigation that belongs to this width, and none of the other two.
async function expectChrome(page: Page, width: number, where: string): Promise<void> {
  const mode = modeOf(width);
  const aside = page.locator('aside');
  const nav = page.getByRole('navigation', { name: 'Main' }); // the visible one only

  if (mode === 'phone') {
    await expect(aside, `${where}: a sidebar on a phone`).toBeHidden();
    await expect(nav, `${where}: the Main bar`).toBeVisible();
    const items = nav.locator('a, button');
    await expect(items, `${where}: the bar holds five items`).toHaveCount(5);
    expect((await items.allInnerTexts()).map((t) => t.trim()), `${where}: the bar's items`).toEqual(BAR);
    const bar = await nav.boundingBox();
    const vp = page.viewportSize();
    expect(bar && vp && Math.round(bar.y + bar.height), `${where}: the bar sits on the bottom edge`).toBe(vp?.height);
    expect(bar && Math.round(bar.width), `${where}: the bar spans the window`).toBe(vp?.width);
    await expectTapSize(BAR.map((name) => ({ name: `bar ${name}`, loc: name === 'More' ? nav.getByRole('button', { name }) : nav.getByRole('link', { name }) })), where);
    return;
  }

  await expect(nav, `${where}: the sidebar's Main list`).toBeVisible(); // above 720px the only visible Main navigation
  await expect(aside, `${where}: the sidebar`).toBeVisible();
  const bar = page.locator('nav[aria-label="Main"].fixed');
  await expect(bar, `${where}: the phone bar must be gone above 720px`).toBeHidden();

  const links = aside.getByRole('navigation', { name: 'Main' }).getByRole('link');
  await expect(links, `${where}: eight main entries`).toHaveCount(8);
  // An entry is named by its label; Messages adds its unread count when there is one ("Messages, 3 unread").
  expect(await links.evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? '').replace(/, \d+ unread$/, ''))), `${where}: every entry is named`).toEqual(MAIN);
  const words = (await links.evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.trim())));
  if (mode === 'rail') {
    expect(words, `${where}: the rail shows icons, not words`).toEqual(MAIN.map(() => ''));
    await expect(aside.getByRole('navigation', { name: 'Main' }).locator('svg'), `${where}: one icon per entry`).toHaveCount(8);
    const rail = await aside.boundingBox();
    expect(rail && Math.round(rail.width), `${where}: the rail is 82px wide`).toBe(82);
  } else {
    expect(words, `${where}: the sidebar shows its labels`).toEqual(MAIN);
    await expect(aside.locator('strong', { hasText: 'REASON' }), `${where}: the wordmark`).toBeVisible();
    const side = await aside.boundingBox();
    expect(side && Math.round(side.width), `${where}: the sidebar is 232px wide`).toBe(232);
  }
  for (const label of SUB) {
    const link = aside.getByRole('link', { name: label, exact: true });
    await expect(link, `${where}: ${label} in the sidebar`).toBeVisible();
    if (mode === 'rail') expect((await link.innerText()).trim(), `${where}: ${label} has no word on the rail`).toBe('');
    else await expect(link, `${where}: ${label} label`).toHaveText(label);
  }
  const targets = [
    ...MAIN.map((name) => ({ name: `sidebar ${name}`, loc: links.nth(MAIN.indexOf(name)) })),
    ...SUB.map((name) => ({ name: `sidebar ${name}`, loc: aside.getByRole('link', { name, exact: true }) })),
    { name: 'sidebar account', loc: aside.getByRole('button', { name: 'Your account' }) },
    { name: 'sidebar logo (home)', loc: aside.getByRole('link', { name: 'REASON home' }) },
  ];
  await expectTapSize(targets, where);
}

// The top bar: home mark (phones), search, bell, profile. All 44px.
async function expectTopbar(page: Page, width: number, where: string): Promise<void> {
  const targets = [
    { name: 'search field', loc: page.getByRole('textbox', { name: 'Search REASON' }) },
    { name: 'notifications', loc: page.getByRole('button', { name: 'Notifications' }) },
    { name: 'your profile', loc: page.getByRole('link', { name: 'Your profile' }) },
  ];
  if (modeOf(width) === 'phone') targets.push({ name: 'REASON home', loc: page.getByRole('link', { name: 'REASON home' }) });
  await expectTapSize(targets, where);
}

// ── Hooks ────────────────────────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  console.log(`[reason-m1-shell] engine=${engineLabel()} app=${APP}`);
  member = await makeMember('member', { finishedOnboarding: true });
  unfinished = await makeMember('unfinished', { finishedOnboarding: false });
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (made.length) await cleanup(pool, { ids: made });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. Every width
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('1 every width: no sideways scroll, the right navigation, the official logo, 44px targets', async () => {
  test.setTimeout(1_500_000);
  const routes = ['/', '/entities', '/introductions', '/search', '/circles', '/sessions', '/messages', '/settings'];
  const problems: string[] = [];
  const label = engineLabel().replace(/[^a-z0-9]+/gi, '-');

  for (const size of sizes(WIDTHS)) {
    const { page, ctx, errors } = await openAs(member, size);
    try {
      for (const route of routes) {
        const where = `${size.width}x${size.height} ${route}`;
        try {
          await visit(page, route, size.width);
          await expectContained(page, where);
          if (route === '/') {
            await expectChrome(page, size.width, where);
            await expectTopbar(page, size.width, where);
            await expectOfficialLogo(page, where);
            const current = modeOf(size.width) === 'phone'
              ? page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'For You' })
              : page.locator('aside').getByRole('link', { name: 'For You', exact: true });
            await expect(current, `${where}: For You is the current page`).toHaveAttribute('aria-current', 'page');
          }
          if (route === '/circles') await page.screenshot({ path: path.join(SHOTS, `${label}-${size.width}-circles.png`) });
        } catch (e) {
          problems.push(`${where}: ${firstLine(e)}`);
          console.log(`  ✗ ${where}: ${firstLine(e)}`);
          await page.screenshot({ path: path.join(SHOTS, `${label}-${size.width}-${route.replace(/\W+/g, '_')}-FAILED.png`) }).catch(() => undefined);
        }
      }
      if (!problems.some((p) => p.startsWith(`${size.width}x${size.height}`))) {
        console.log(`  ✓ ${size.width}x${size.height} (${modeOf(size.width)}): ${routes.length} pages, no sideways scroll, ${modeOf(size.width)} navigation, logo, targets 44px.`);
      }
      expect(errors, `${size.width}px: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
  expect(problems, `problems:\n${problems.join('\n')}`).toEqual([]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. The phone bar and the More sheet
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('2 phone bar and More sheet: five tabs, the rest in More, each entry navigates', async () => {
  test.setTimeout(600_000);
  const phones = sizes([{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 430, height: 932 }]).filter((s) => modeOf(s.width) === 'phone');
  test.skip(phones.length === 0, 'More only exists on a phone-sized window');

  for (const size of phones) {
    const where = `${size.width}x${size.height}`;
    const { page, ctx, errors } = await openAs(member, size);
    try {
      await visit(page, '/', size.width);
      const bar = page.getByRole('navigation', { name: 'Main' });
      const more = bar.getByRole('button', { name: 'More' });
      const sheet = page.getByRole('dialog', { name: 'More' });

      await expect(more, `${where}: More says it is closed`).toHaveAttribute('aria-expanded', 'false');
      await expect(more, `${where}: More is not marked current on For You`).not.toHaveAttribute('aria-current', 'true');
      await more.click();
      await expect(sheet, `${where}: the More sheet opens`).toBeVisible();
      await expect(more, `${where}: More says it is open`).toHaveAttribute('aria-expanded', 'true');
      for (const label of MORE) await expect(sheet.getByRole('link', { name: label, exact: true }), `${where}: More lists ${label}`).toBeVisible();
      await expect(sheet.getByRole('link', { name: 'Invite someone' }), `${where}: Invite is in More`).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Log out' }), `${where}: Log out is in More`).toBeVisible();
      await expect(sheet.getByRole('link', { name: 'Admin' }), `${where}: Admin is for admins only`).toHaveCount(0);
      await expectTapSize([
        ...MORE.map((name) => ({ name: `More ${name}`, loc: sheet.getByRole('link', { name, exact: true }) })),
        { name: 'More Invite someone', loc: sheet.getByRole('link', { name: 'Invite someone' }) },
        { name: 'More Log out', loc: sheet.getByRole('button', { name: 'Log out' }) },
        { name: 'More Close', loc: sheet.getByRole('button', { name: 'Close' }) },
      ], `${where} More sheet`);

      // It sits fully inside the window, and above the bar (not under it).
      const hit = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"][aria-label="More"]') as HTMLElement | null;
        const bar = document.querySelector('nav[aria-label="Main"].fixed') as HTMLElement | null;
        if (!d || !bar) return null;
        const r = d.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        const overBar = document.elementFromPoint(window.innerWidth / 2, b.top + b.height / 2);
        return { top: r.top, bottom: r.bottom, vh: window.innerHeight, barUnderSheet: !!overBar && !bar.contains(overBar) };
      });
      expect(hit, `${where}: the sheet and the bar are both in the page`).not.toBeNull();
      expect(hit!.top, `${where}: the sheet starts inside the window`).toBeGreaterThanOrEqual(0);
      expect(Math.round(hit!.bottom), `${where}: the sheet ends inside the window`).toBeLessThanOrEqual(hit!.vh + 1);
      expect(hit!.barUnderSheet, `${where}: the bar paints over the open sheet`).toBe(true);
      await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-${size.width}-more.png`) });

      // Closing: Escape, then the backdrop.
      await page.keyboard.press('Escape');
      await expect(sheet, `${where}: Escape closes the sheet`).toBeHidden();
      await expect(more, `${where}: More says it is closed again`).toHaveAttribute('aria-expanded', 'false');
      await more.click();
      await expect(sheet).toBeVisible();
      await page.mouse.click(size.width / 2, 8);
      await expect(sheet, `${where}: a tap on the backdrop closes the sheet`).toBeHidden();

      // Every entry in More goes where it says and closes the sheet.
      const destinations: Array<{ label: string; url: RegExp; see: () => Locator }> = [
        { label: 'Entities', url: /\/entities$/, see: () => page.getByRole('heading', { name: 'Entities matter.' }) },
        { label: 'Circles', url: /\/circles$/, see: () => page.getByRole('heading', { name: 'Circles', level: 1 }) },
        { label: 'Pods', url: /\/pods$/, see: () => page.getByRole('main').getByRole('heading', { level: 1 }) },
        { label: 'Introductions', url: /\/introductions$/, see: () => page.getByRole('heading', { name: 'Introductions create leverage.' }) },
        { label: 'Settings', url: /\/settings$/, see: () => page.getByRole('heading', { name: 'Settings', level: 1 }) },
        { label: 'Support', url: /\/support$/, see: () => page.getByRole('heading', { name: 'Support', level: 1 }) },
      ];
      for (const d of destinations) {
        await bar.getByRole('button', { name: 'More' }).click();
        await expect(sheet).toBeVisible();
        await sheet.getByRole('link', { name: d.label, exact: true }).click();
        await expect(page, `${where}: More > ${d.label}`).toHaveURL(d.url);
        await expect(sheet, `${where}: the sheet closes after ${d.label}`).toBeHidden();
        await expect(d.see().first(), `${where}: ${d.label} renders inside the shell`).toBeVisible({ timeout: 20_000 });
        await expect(bar, `${where}: the bar is still there on ${d.label}`).toBeVisible();
        await expect(bar.getByRole('button', { name: 'More' }), `${where}: More is marked current on ${d.label}`).toHaveAttribute('aria-current', 'true');
        await expectContained(page, `${where} ${d.label}`);
      }

      // Invite is not a tab or a tile: it lives under the member's name in More, and More is the current entry there.
      await bar.getByRole('button', { name: 'More' }).click();
      await expect(sheet).toBeVisible();
      await sheet.getByRole('link', { name: 'Invite someone' }).click();
      await expect(page, `${where}: More > Invite someone`).toHaveURL(/\/invites$/);
      await expect(bar.getByRole('button', { name: 'More' }), `${where}: More is marked current on Invite`).toHaveAttribute('aria-current', 'true');
      await bar.getByRole('button', { name: 'More' }).click();
      await expect(sheet.getByRole('link', { name: 'Invite someone' }), `${where}: Invite someone is marked in the sheet`).toHaveAttribute('aria-current', 'page');
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();

      // The tabs on the bar go where they say, and mark the current one.
      for (const tab of [{ name: 'People', url: /\/search$/ }, { name: 'Events', url: /\/sessions$/ }, { name: 'Messages', url: /\/messages$/ }, { name: 'For You', url: /\/$/ }]) {
        await bar.getByRole('link', { name: tab.name }).click();
        await expect(page, `${where}: tab ${tab.name}`).toHaveURL(tab.url);
        await expect(bar.getByRole('link', { name: tab.name }), `${where}: ${tab.name} is marked as the current page`).toHaveAttribute('aria-current', 'page');
      }
      console.log(`  ✓ ${where}: five tabs, More holds the rest, every entry navigates and closes the sheet, the bar stays under dialogs.`);
      expect(errors, `${where}: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. Breakpoints: the bar, the rail and the sidebar
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('3 breakpoints: bar to 720px, named icons 721 to 980px, labels from 981px', async () => {
  test.setTimeout(600_000);
  const edges: Size[] = [
    { width: 720, height: 800 },
    { width: 721, height: 800 },
    { width: 768, height: 1024 },
    { width: 900, height: 800 },
    { width: 980, height: 800 },
    { width: 981, height: 800 },
  ];
  for (const size of sizes(edges)) {
    const where = `${size.width}x${size.height} (${modeOf(size.width)})`;
    const { page, ctx, errors } = await openAs(member, size);
    try {
      await visit(page, '/circles', size.width);
      await expectChrome(page, size.width, where);
      await expectTopbar(page, size.width, where);
      await expectOfficialLogo(page, where);
      await expectContained(page, where);
      const circles = modeOf(size.width) === 'phone'
        ? null
        : page.locator('aside').getByRole('link', { name: 'Circles', exact: true });
      if (circles) await expect(circles, `${where}: Circles is the current page`).toHaveAttribute('aria-current', 'page');
      console.log(`  ✓ ${where}: ${modeOf(size.width) === 'phone' ? 'five-tab bar' : modeOf(size.width) === 'rail' ? 'rail with eight named icons and no words' : 'sidebar with labels'}.`);
      expect(errors, `${where}: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. People: four pages, four tabs
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('4 People: Find people, Your searches, Everyone who fits and People you have met sit under four tabs', async () => {
  test.setTimeout(600_000);
  for (const size of sizes([{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 1280, height: 800 }])) {
    const { page, ctx, errors } = await openAs(member, size);
    const phone = modeOf(size.width) === 'phone';
    try {
      for (const tab of PEOPLE_TABS) {
        const where = `${size.width}px ${tab.to}`;
        await visit(page, tab.to, size.width);
        const tabs = page.getByRole('navigation', { name: 'People' });
        await expect(tabs, `${where}: the People tabs`).toBeVisible();
        const links = tabs.getByRole('link');
        await expect(links, `${where}: four tabs`).toHaveCount(4);
        expect((await links.allInnerTexts()).map((t) => t.trim()), `${where}: tab names and order`).toEqual(PEOPLE_TABS.map((t) => t.label));
        await expect(tabs.getByRole('link', { name: tab.label }), `${where}: this page's tab is marked`).toHaveAttribute('aria-current', 'page');
        await expectTapSize(PEOPLE_TABS.map((t, i) => ({ name: `tab ${t.label}`, loc: links.nth(i) })), where);
        // On a phone the strip scrolls. The page's own tab is in view as soon as the page opens,
        // with nothing scrolled by hand, and the last tab can be reached.
        const mine = await tabs.getByRole('link', { name: tab.label }).boundingBox();
        expect(mine && mine.x >= 0 && Math.round(mine.x + mine.width) <= size.width + 1, `${where}: this page's own tab is in view without scrolling (${mine && Math.round(mine.x)} to ${mine && Math.round(mine.x + mine.width)} of ${size.width})`).toBe(true);
        const last = links.nth(3);
        await last.scrollIntoViewIfNeeded();
        const box = await last.boundingBox();
        expect(box && Math.round(box.x + box.width), `${where}: the last tab can be reached`).toBeLessThanOrEqual(size.width + 1);
        // The main navigation marks People as current on every one of the four pages.
        const people = phone
          ? page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'People' })
          : page.locator('aside').getByRole('link', { name: 'People', exact: true });
        await expect(people, `${where}: People is the current entry`).toHaveAttribute('aria-current', 'page');
        await expectContained(page, where);
      }
      // And the tabs belong to People only.
      await visit(page, '/circles', size.width);
      await expect(page.getByRole('navigation', { name: 'People' }), `${size.width}px: People tabs on Circles`).toHaveCount(0);
      console.log(`  ✓ ${size.width}px: four people pages, four tabs, the right one marked, the last reachable.`);
      expect(errors, `${size.width}px: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. The top search opens Find people with the words in
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('5 top search: Enter opens Find people with the words already typed, a second search replaces them', async () => {
  test.setTimeout(300_000);
  for (const size of sizes([{ width: 390, height: 844 }, { width: 1280, height: 800 }])) {
    const where = `${size.width}px`;
    const { page, ctx, errors } = await openAs(member, size);
    try {
      await visit(page, '/circles', size.width);
      const top = page.getByRole('textbox', { name: 'Search REASON' });
      await top.fill('Zed Probe');
      await top.press('Enter');
      await expect(page, `${where}: the search goes to Find people`).toHaveURL(/\/search\?q=Zed%20Probe$/);
      const box = page.getByRole('textbox', { name: 'Search people' });
      await expect(box, `${where}: Find people starts with the typed words`).toHaveValue('Zed Probe');

      await top.fill('Marta');
      await top.press('Enter');
      await expect(page, `${where}: a second search`).toHaveURL(/\/search\?q=Marta$/);
      await expect(box, `${where}: the new words replace the old`).toHaveValue('Marta');

      const before = page.url();
      await top.fill('   ');
      await top.press('Enter');
      await wait(400);
      expect(page.url(), `${where}: an empty search goes nowhere`).toBe(before);
      console.log(`  ✓ ${where}: Enter on the top search opens Find people with the words in; a new search replaces them; blank does nothing.`);
      expect(errors, `${where}: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6. "Complete your profile"
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('6 profile nudge: asked to finish on every page but For You and Messages, and only if not finished', async () => {
  test.setTimeout(300_000);
  for (const size of sizes([{ width: 390, height: 844 }, { width: 1280, height: 800 }])) {
    const where = `${size.width}px`;
    const todo = await openAs(unfinished, size);
    try {
      const nudge = todo.page.getByText('Complete your profile');
      for (const route of ['/circles', '/sessions', '/settings']) {
        await visit(todo.page, route, size.width);
        await expect(nudge, `${where} ${route}: the nudge`).toBeVisible();
        const go = todo.page.getByRole('link', { name: 'Complete now' });
        await expect(go, `${where} ${route}: the button goes to onboarding`).toHaveAttribute('href', '/onboarding');
        await expectTapSize([{ name: 'Complete now', loc: go }], `${where} ${route}`);
        await expectContained(todo.page, `${where} ${route}`);
      }
      // Messages does without it: its page sizes itself to what the page area has left, and a pinned
      // nudge above it pushed the message box under the bar on a window as short as 360x640.
      await visit(todo.page, '/messages', size.width);
      await expect(nudge, `${where} /messages: the nudge is shown on Messages`).toHaveCount(0);
      await expectContained(todo.page, `${where} /messages`);
      // And it follows the member from page to page without a reload: back on Events, gone again on Messages.
      const entry = (name: string) => (modeOf(size.width) === 'phone' ? todo.page.getByRole('navigation', { name: 'Main' }) : todo.page.locator('aside')).getByRole('link', { name });
      await entry('Events').click();
      await expect(todo.page, `${where}: Events`).toHaveURL(/\/sessions$/);
      await expect(nudge, `${where} /sessions after Messages: the nudge is back`).toBeVisible();
      await entry('Messages').click();
      await expect(todo.page, `${where}: Messages`).toHaveURL(/\/messages$/);
      await expect(nudge, `${where} /messages again: the nudge is gone`).toHaveCount(0);
      await todo.page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-${size.width}-nudge.png`) });
      expect(todo.errors, `${where}: script errors`).toEqual([]);
    } finally {
      await todo.ctx.close().catch(() => undefined);
    }

    const done = await openAs(member, size);
    try {
      await visit(done.page, '/circles', size.width);
      await expect(done.page.getByText('Complete your profile'), `${where}: a member who finished is not nudged`).toHaveCount(0);
      expect(done.errors, `${where}: script errors`).toEqual([]);
    } finally {
      await done.ctx.close().catch(() => undefined);
    }
    console.log(`  ✓ ${where}: the nudge shows on Circles, Events and Settings for a member who has not finished, with a 44px button to /onboarding, and not on Messages; a member who has finished sees none.`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7. Messages: no nudge, and the message box fits
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The Messages page sizes itself to what <main> has left (never less than 320px), so anything above
// it takes room from its message box. The profile nudge did, in two ways. Inside <main> it made the
// page taller than its page area for exactly the members shown it: at 360x780 the message box sat at
// y 770 to 812, under the bar at 711. Pinned above <main> it still left too little room on a window as
// short as a common Android phone: at 360x640 the box sat 8px under the bar, at 360x548 31px off the
// screen, at 844x390 101px below the window. So Messages and every route under it does without the
// nudge (it stays on every other page but For You), and this test opens Messages as both kinds of
// member with the page area at the top: the page scrolls its newest message into view as it opens,
// which hides the fault.

// <main> can only hold the page when the page's own 320px floor leaves room: below it (a phone on its
// side) the page is that floor tall by design, and its area scrolls.
async function expectMessagesFit(page: Page, where: string): Promise<void> {
  const m = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return null;
    const cs = getComputedStyle(main);
    return {
      overflow: main.scrollHeight - main.clientHeight,
      room: main.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
    };
  });
  expect(m, `${where}: the page area is on the page`).not.toBeNull();
  if (m!.room >= 320) {
    expect(m!.overflow, `${where}: the page is ${m!.overflow}px taller than its page area (something else sits inside <main>)`).toBeLessThanOrEqual(1);
  }
}

// Every pixel of the box above the phone bar (or inside the window where there is no bar), not just its
// centre: a message box 8px under the bar still has a centre that can be pressed.
async function expectAboveBar(page: Page, target: Locator, label: string): Promise<void> {
  const box = await target.boundingBox();
  expect(box, `${label}: not rendered`).not.toBeNull();
  const bar = page.locator('nav[aria-label="Main"].fixed');
  const barBox = (await bar.isVisible()) ? await bar.boundingBox() : null;
  const limit = Math.round(barBox ? barBox.y : page.viewportSize()!.height);
  const bottom = Math.round(box!.y + box!.height);
  expect(bottom, `${label} ends at ${bottom}px, ${barBox ? `under the bottom bar (its top is at ${limit}px)` : `below the window (${limit}px)`}`).toBeLessThanOrEqual(limit);
}

// The page area back at the top, after the page has scrolled its newest message into view.
async function backToTop(page: Page, where: string): Promise<void> {
  await wait(1500);
  await page.evaluate(() => { const main = document.querySelector('main'); if (main) main.scrollTop = 0; });
  await wait(300);
  expect(await page.evaluate(() => document.querySelector('main')?.scrollTop ?? -1), `${where}: the page area is at the top`).toBe(0);
}

test('7 Messages: no nudge, and the message box is fully visible above the bar with the page area at the top', async () => {
  test.setTimeout(900_000);
  // Every problem is collected, so one failing run shows every size and member at once.
  const problems: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { const line = firstLine(e); problems.push(line.startsWith(what.split(',')[0]) ? line : `${what}: ${line}`); }
  };
  const noNudge = (page: Page, where: string) => expect(page.getByText('Complete your profile'), `${where}: the nudge is shown on Messages`).toHaveCount(0);
  // The message box and Send: inside the window with nothing over their centre, and wholly above the bar.
  const boxChecks = async (page: Page, composer: Locator, where: string) => {
    const send = page.getByRole('button', { name: 'Send message' });
    await attempt(`${where}, message box`, async () => {
      await expectReachable(page, composer, `${where} the message box`);
      await expectAboveBar(page, composer, `${where} the message box`);
    });
    await attempt(`${where}, Send`, async () => {
      await expectReachable(page, send, `${where} Send`);
      await expectAboveBar(page, send, `${where} Send`);
    });
  };
  const done = (where: string, what: string) => {
    if (!problems.some((x) => x.startsWith(where))) console.log(`  ✓ ${where}: ${what}`);
  };

  // a. Writing a new message, while the two members have no conversation yet (once they do, the page
  //    sends them to it): a member who is shown the nudge elsewhere, on a 360x640 phone. Not at 548px
  //    tall: there the page stacks the inbox list (empty-inbox text, 203px) above the new-message panel,
  //    which is left 102px for its header and message box, so the box is clipped for every member,
  //    nudge or not. That is the Messages page's own layout, and nothing to do with the nudge.
  for (const size of sizes([{ width: 360, height: 640 }])) {
    const where = `${size.width}x${size.height} member who has not finished onboarding, new message`;
    const { page, ctx, errors } = await openAs(unfinished, size);
    try {
      const composer = page.getByRole('main').locator('textarea');
      await attempt(`${where}, page`, async () => {
        await visit(page, `/messages/new/${member.id}`, size.width);
        await expect(composer, `${where}: the message box is on the page`).toBeVisible({ timeout: 30_000 });
        await backToTop(page, where);
        await noNudge(page, where);
      });
      await boxChecks(page, composer, where);
      expect(errors, `${where}: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
    done(where, 'no nudge, and the message box is fully above the bar with the page area at the top.');
  }

  // b. A thread, as a member who has not finished onboarding and as one who has.
  const id = await thread();
  const viewers = [
    { label: 'who has not finished onboarding', user: unfinished },
    { label: 'who has finished', user: member },
  ];
  for (const size of sizes([{ width: 360, height: 548 }, { width: 360, height: 640 }, { width: 360, height: 780 }, { width: 390, height: 844 }, { width: 1280, height: 800 }])) {
    for (const viewer of viewers) {
      const where = `${size.width}x${size.height} member ${viewer.label}`;
      const { page, ctx, errors } = await openAs(viewer.user, size);
      try {
        // The inbox: nothing may be taller than the page area, and there is no nudge.
        await attempt(`${where}, inbox`, async () => {
          await visit(page, '/messages', size.width);
          await expect(page.getByRole('main').getByRole('heading', { name: 'Messages', level: 2 }), `${where}: the inbox`).toBeVisible({ timeout: 25_000 });
          await noNudge(page, `${where} inbox`);
          await expectMessagesFit(page, `${where} inbox`);
        });

        // The thread, with its real message box, page area at the top.
        const composer = page.getByRole('main').locator('textarea');
        let threadOpen = false;
        await attempt(`${where}, thread`, async () => {
          await visit(page, `/messages/${id}`, size.width);
          await expect(composer, `${where}: the message box is on the page`).toBeVisible({ timeout: 30_000 });
          threadOpen = true;
          await backToTop(page, where);
        });
        if (threadOpen) {
          await attempt(`${where}, nudge`, () => noNudge(page, `${where} thread`));
          await boxChecks(page, composer, where);
          await attempt(`${where}, thread fit`, () => expectMessagesFit(page, `${where} thread`));
          await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-${size.width}x${size.height}-thread-${viewer.user === unfinished ? 'unfinished' : 'finished'}.png`) });
        }
        expect(errors, `${where}: script errors`).toEqual([]);
      } finally {
        await ctx.close().catch(() => undefined);
      }
      done(where, 'no nudge, and the message box and Send are fully above the bar with the page area at the top, and the page fits its page area.');
    }
  }

  // c. A phone on its side (844x390). The window leaves the page less than its own 320px minimum, so
  //    its area scrolls, as it does for a member who has finished. What matters is that the nudge takes
  //    nothing more, and that with the area scrolled to its end the message box is fully inside the window.
  if (!DEVICE) {
    const size = { width: 844, height: 390 };
    const where = `${size.width}x${size.height} member who has not finished onboarding, thread`;
    const { page, ctx, errors } = await openAs(unfinished, size);
    try {
      const composer = page.getByRole('main').locator('textarea');
      await attempt(`${where}, page`, async () => {
        await visit(page, `/messages/${id}`, size.width);
        await expect(composer, `${where}: the message box is on the page`).toBeVisible({ timeout: 30_000 });
        await wait(1500);
        await noNudge(page, where);
        await page.evaluate(() => { const main = document.querySelector('main'); if (main) main.scrollTop = main.scrollHeight; });
        await wait(300);
      });
      await boxChecks(page, composer, where);
      expect(errors, `${where}: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
    done(where, 'no nudge, and with the page area scrolled to its end the message box and Send are fully inside the window.');
  }

  expect(problems, `Messages is wrong for a member who has not finished onboarding:\n${problems.join('\n')}`).toEqual([]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8. Old pages inside the shell
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('8 old pages: Circles, Events, Messages, Settings, Pods and Support render inside the shell with no script errors', async () => {
  test.setTimeout(600_000);
  const pages: Array<{ route: string; see: (p: Page) => Locator; name: string }> = [
    { route: '/circles', name: 'Circles', see: (p) => p.getByRole('main').getByRole('heading', { name: 'Circles', level: 1 }) },
    { route: '/sessions', name: 'Events', see: (p) => p.getByRole('main').getByRole('heading', { name: 'Events', level: 1 }) },
    { route: '/messages', name: 'Messages', see: (p) => p.getByRole('main').getByRole('heading', { name: 'Messages', level: 2 }) },
    { route: '/settings', name: 'Settings', see: (p) => p.getByRole('main').getByRole('heading', { name: 'Settings', level: 1 }) },
    { route: '/pods', name: 'Pods', see: (p) => p.getByRole('main').getByRole('heading', { level: 1 }) },
    { route: '/support', name: 'Support', see: (p) => p.getByRole('main').getByRole('heading', { name: 'Support', level: 1 }) },
  ];
  for (const size of sizes([{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }])) {
    const { page, ctx, errors } = await openAs(member, size);
    try {
      for (const p of pages) {
        const where = `${size.width}px ${p.name}`;
        await visit(page, p.route, size.width);
        await expect(p.see(page).first(), `${where}: the page's own heading is inside the shell`).toBeVisible({ timeout: 25_000 });
        await expect(page.getByRole('main'), `${where}: inside the shell's page area`).toBeVisible();
        await expect(page.locator('header').first(), `${where}: the top bar`).toBeVisible();
        await expectContained(page, where);
        console.log(`  ✓ ${where}: renders inside the shell.`);
      }
      expect(errors, `${size.width}px: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 9. The account menu
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('9 account menu: Invite and Log out stay reachable, Admin is not offered to a member, and the current page is marked', async () => {
  test.setTimeout(300_000);
  const wide = sizes([{ width: 768, height: 1024 }, { width: 1280, height: 800 }]).filter((s) => modeOf(s.width) !== 'phone');
  test.skip(wide.length === 0, 'the account menu lives in the sidebar, which a phone does not have (its Invite and Log out are in More)');
  for (const size of wide) {
    const where = `${size.width}px`;
    const { page, ctx, errors } = await openAs(member, size);
    try {
      await visit(page, '/circles', size.width);
      const account = page.getByRole('button', { name: 'Your account' });
      const menu = page.getByRole('menu');

      await account.click();
      await expect(menu, `${where}: the account menu opens`).toBeVisible();
      expect((await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim()), `${where}: the menu's entries`).toEqual(['View profile', 'Invite someone', 'Log out']);
      await expectTapSize(['View profile', 'Invite someone', 'Log out'].map((name) => ({ name: `menu ${name}`, loc: menu.getByRole('menuitem', { name }) })), `${where} account menu`);
      const inside = await menu.boundingBox();
      expect(inside && inside.x >= 0 && inside.y >= 0 && Math.round(inside.x + inside.width) <= size.width, `${where}: the menu is inside the window`).toBe(true);

      await page.keyboard.press('Escape');
      await expect(menu, `${where}: Escape closes the menu`).toBeHidden();
      await account.click();
      await expect(menu).toBeVisible();
      await page.mouse.click(size.width - 40, size.height - 60);
      await expect(menu, `${where}: a tap outside closes the menu`).toBeHidden();

      await expect(account, `${where}: the account button is not marked on Circles`).not.toHaveAttribute('aria-current', 'true');
      await account.click();
      await menu.getByRole('menuitem', { name: 'Invite someone' }).click();
      await expect(page, `${where}: Invite someone`).toHaveURL(/\/invites$/);
      await expect(menu, `${where}: the menu closes after a choice`).toBeHidden();
      // Nothing in the lists is Invite, so the account button is the current entry, and so is the item in its menu.
      await expect(account, `${where}: the account button is marked current on Invite`).toHaveAttribute('aria-current', 'true');
      await account.click();
      await expect(menu.getByRole('menuitem', { name: 'Invite someone' }), `${where}: Invite someone is marked in the menu`).toHaveAttribute('aria-current', 'page');
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();

      await account.click();
      await menu.getByRole('menuitem', { name: 'Log out' }).click();
      const sheet = page.getByRole('dialog', { name: 'Log out?' });
      await expect(sheet, `${where}: Log out asks first`).toBeVisible();
      await sheet.getByRole('button', { name: 'Cancel' }).click();
      await expect(sheet, `${where}: Cancel closes it`).toBeHidden();
      await expect(page, `${where}: still on the same page, still signed in`).toHaveURL(/\/invites$/);
      console.log(`  ✓ ${where}: menu opens, Escape and an outside tap close it, Invite navigates, Log out asks first and Cancel keeps the member signed in, no Admin entry for a member.`);
      expect(errors, `${where}: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 10. The Messages link names its unread count
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('10 unread count: the Messages link says how many messages are waiting (bar, rail and sidebar)', async () => {
  test.setTimeout(300_000);
  const id = await thread();
  // One unread message from the other throwaway member, written straight into the table.
  await pool.query(`INSERT INTO direct_messages (conversation_id, from_user_id, content) VALUES ($1, $2, $3)`, [id, unfinished.id, 'Are you there?']);
  for (const size of sizes([{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }])) {
    const where = `${size.width}px`;
    const { page, ctx, errors } = await openAs(member, size);
    try {
      await visit(page, '/circles', size.width);
      const root = modeOf(size.width) === 'phone' ? page.getByRole('navigation', { name: 'Main' }) : page.locator('aside');
      const link = root.getByRole('link', { name: 'Messages, 1 unread', exact: true });
      await expect(link, `${where}: the Messages link names its unread count`).toBeVisible({ timeout: 20_000 });
      await expectTapSize([{ name: 'Messages link', loc: link }], where);
      console.log(`  ✓ ${where}: the ${modeOf(size.width)} Messages link reads "Messages, 1 unread".`);
      expect(errors, `${where}: script errors`).toEqual([]);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  }
});
