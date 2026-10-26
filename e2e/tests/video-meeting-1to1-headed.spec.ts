import { test, expect, chromium, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { io } from 'socket.io-client';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { createPod, addPodMember, apiRequest, registerForSession } from '../helpers/api';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { expectReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// VID-01..04 (25 Oct 2026, Claus and Stefan on production): in a two-person
// "Video Meeting" the director's own camera was a full-width hero tile, the guest
// could only see himself by scrolling, "Compact" was the only fix, the round
// chrome of speed networking was all over it, and the guest "couldn't hang up".
// A video meeting is now its own room. Two real browsers with fake cameras:
//   1. Before the start: the guest waits for the director by name; the director
//      has "Start meeting". No Compact, no round chip, no event plan, no check-in.
//   2. Both see the other person and themselves, fully on screen, at 1280x720,
//      1440x900, 1024x768, 390x844, 360x740 and 844x390 (boundingBox): side by
//      side at equal size on a wide window, otherwise the other person large and
//      yourself small. Leave is in the bottom bar, 44px, reachable.
//   3. A guest's own host:end_session is refused (FORBIDDEN); the event stays live.
//   4. The guest leaves (the event page) while the director stays, and rejoins.
//   5. Four people: equal tiles, nothing scrolls.
//   6. The director ends it for everyone: every screen says "Meeting ended", and
//      the event is completed in the database.
// Runs against the preview (E2E_VERCEL_SHARE set) or production; Chromium only
// (the fake camera). Real two-way video is asserted: every tile's <video> plays.
// ─────────────────────────────────────────────────────────────────────────────

// Chromium >= 147 on Windows loses the fake camera through Media Foundation capture; Chromium honours only the
// last --disable-features switch, so Playwright's own defaults (1.59.1) are repeated before the extra one.
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';

const SIZES: Array<{ w: number; h: number; layout: 'side' | 'pair' }> = [
  { w: 1280, h: 720, layout: 'side' },
  { w: 1440, h: 900, layout: 'side' },
  { w: 1024, h: 768, layout: 'pair' },
  { w: 390, h: 844, layout: 'pair' },
  { w: 360, h: 740, layout: 'pair' },
  { w: 844, h: 390, layout: 'pair' },
];

let browser: Browser;
let director: TestUser, guest: TestUser, third: TestUser, fourth: TestUser;
let podId = '';
let sessionId = '';
const ctxs: BrowserContext[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = async () => (await pool.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [sessionId])).rows[0]?.status;

async function openLive(u: TestUser, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return page;
}

const stage = (page: Page) => page.locator('[data-testid="meeting-stage"]');
const selfTile = (page: Page) => page.locator('[data-testid="meeting-tile"][data-self="true"]');
const otherTiles = (page: Page) => page.locator('[data-testid="meeting-tile"]:not([data-self="true"])');

/** Tiles whose <video> shows real frames from the (fake) camera. */
async function playingTiles(page: Page): Promise<number> {
  return page.locator('[data-testid="meeting-tile"] video').evaluateAll((vs) =>
    (vs as HTMLVideoElement[]).filter((v) => v.readyState >= 2 && v.videoWidth > 0).length);
}

async function expectLayout(page: Page, layout: string, who: string, timeout = 60_000): Promise<void> {
  await expect(stage(page), `${who}: stage layout`).toHaveAttribute('data-layout', layout, { timeout });
}

async function expectInsideWindow(page: Page, tile: Locator, label: string): Promise<{ width: number; height: number }> {
  const box = await tile.boundingBox();
  expect(box, `${label}: not rendered`).not.toBeNull();
  const vp = page.viewportSize()!;
  const b = box!;
  expect(b.x, `${label}: left edge off the window`).toBeGreaterThanOrEqual(0);
  expect(b.y, `${label}: top edge off the window`).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width, `${label}: right edge past ${vp.width}`).toBeLessThanOrEqual(vp.width + 1);
  expect(b.y + b.height, `${label}: bottom edge past ${vp.height}`).toBeLessThanOrEqual(vp.height + 1);
  return { width: b.width, height: b.height };
}

async function expectNoRoundChrome(page: Page, who: string): Promise<void> {
  expect(await page.getByRole('button', { name: 'Compact', exact: true }).count(), `${who}: no Compact`).toBe(0);
  expect(await page.getByText(/Round \d+ of \d+/).count(), `${who}: no round chip`).toBe(0);
  expect(await page.getByText(/^Plan:/).count(), `${who}: no event plan`).toBe(0);
  expect(await page.getByRole('heading', { name: /What brings you here/i }).count(), `${who}: no check-in`).toBe(0);
  expect(await page.getByRole('button', { name: /Match People/ }).count(), `${who}: no Match People`).toBe(0);
}

async function expectNoScroll(page: Page, who: string): Promise<void> {
  const scrolls = await page.evaluate(() => ({
    pageX: document.documentElement.scrollWidth > window.innerWidth,
    pageY: document.documentElement.scrollHeight > window.innerHeight + 1,
  }));
  expect(scrolls, `${who}: the page scrolls`).toEqual({ pageX: false, pageY: false });
  const stageScrolls = await stage(page).evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  expect(stageScrolls, `${who}: the stage scrolls`).toBe(false);
}

test.beforeAll(async () => {
  browser = await chromium.launch({
    headless: process.env.E2E_HEADED === '0',
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--disable-features=${PW_DISABLED},MediaFoundationD3D11VideoCapture`,
    ],
  });
  // An ordinary member directs it, as Claus did.
  director = await createTestUser('vm1dir');
  guest = await createTestUser('vm1guest');
  third = await createTestUser('vm1third');
  fourth = await createTestUser('vm1fourth');
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Claus Meeting', director.id]);
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Stefan Meeting', guest.id]);
  const pod = await createPod(director, 'E2E video meeting pod');
  podId = pod.id;
  for (const u of [guest, third, fourth]) await addPodMember(director, podId, u.id);
  const created = await apiRequest(director, 'POST', '/sessions', {
    podId,
    title: 'E2E video meeting 1to1',
    description: 'VID-01..04',
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    format: 'video_meeting',
    config: { durationMinutes: 60, maxParticipants: 25 },
  });
  sessionId = created.data.id;
  expect(created.data.format, 'the event is stored as a video meeting').toBe('video_meeting');
  for (const u of [guest, third, fourth]) await registerForSession(u, sessionId);
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
  await cleanup(pool, { ids: [director, guest, third, fourth].filter(Boolean).map((u) => u.id), podId: podId || undefined });
});

test('VID-01..04: a two-person video meeting fits every screen, has one way out, and ends for everyone', async () => {
  test.setTimeout(600_000);

  // 1. Before the start.
  const dirPage = await openLive(director, { width: 1280, height: 720 });
  const guestPage = await openLive(guest, { width: 1280, height: 720 });
  await expect(guestPage.getByText('Waiting for Claus Meeting to start the meeting'), 'the guest waits for the director by name')
    .toBeVisible({ timeout: 60_000 });
  const start = dirPage.getByRole('button', { name: /Start meeting/ });
  await expect(start, 'the director can start it').toBeVisible({ timeout: 60_000 });
  expect(await guestPage.getByRole('button', { name: /Start meeting/ }).count(), 'a guest cannot').toBe(0);
  await expectNoRoundChrome(dirPage, 'director, before the start');
  await expectNoRoundChrome(guestPage, 'guest, before the start');
  await start.click();
  await expect.poll(statusOf, { timeout: 30_000, message: 'the meeting is live' }).toBe('lobby_open');

  // 2. Both see each other: two tiles with real video on both screens.
  for (const [page, who] of [[dirPage, 'director'], [guestPage, 'guest']] as const) {
    await expectLayout(page, 'side', who);
    await expect.poll(() => playingTiles(page), { timeout: 90_000, message: `${who}: both cameras play` }).toBe(2);
    await expectNoRoundChrome(page, `${who}, live`);
  }
  await dirPage.screenshot({ path: 'test-results/vm1to1-director-1280x720.png' });

  for (const size of SIZES) {
    for (const [page, who] of [[dirPage, 'director'], [guestPage, 'guest']] as const) {
      const label = `${who} ${size.w}x${size.h}`;
      await page.setViewportSize({ width: size.w, height: size.h });
      await expectLayout(page, size.layout, label, 15_000);
      await wait(600); // the tiles' 200ms move, settled
      const self = await expectInsideWindow(page, selfTile(page), `${label}: own tile`);
      await expect(otherTiles(page), `${label}: one other person`).toHaveCount(1);
      const other = await expectInsideWindow(page, otherTiles(page).first(), `${label}: the other person`);
      if (size.layout === 'pair') {
        expect(other.width * other.height, `${label}: the other person is the large one`).toBeGreaterThan(self.width * self.height);
      } else {
        expect(Math.abs(other.width - self.width), `${label}: the same width`).toBeLessThanOrEqual(1);
        expect(Math.abs(other.height - self.height), `${label}: the same height`).toBeLessThanOrEqual(1);
      }
      const leave = page.getByTestId('meeting-leave');
      const lb = await expectReachable(page, leave, `${label}: Leave`);
      expect(lb.height, `${label}: Leave is 44px`).toBeGreaterThanOrEqual(44);
      expect(lb.width, `${label}: Leave is 44px wide`).toBeGreaterThanOrEqual(44);
      const bar = (await page.getByTestId('meeting-control-bar').boundingBox())!;
      expect(lb.y, `${label}: Leave is in the bottom bar`).toBeGreaterThanOrEqual(bar.y);
      await expectNoScroll(page, label);
      await page.screenshot({ path: `test-results/vm1to1-${who}-${size.w}x${size.h}.png` });
    }
  }
  await dirPage.setViewportSize({ width: 1280, height: 720 });
  await guestPage.setViewportSize({ width: 390, height: 844 });

  // The director can end it for everyone; the guest cannot.
  await expect(dirPage.getByTestId('meeting-end'), 'the director has End for everyone').toBeVisible();
  expect(await guestPage.getByTestId('meeting-end').count(), 'the guest has no End').toBe(0);

  // 3. A guest's own socket asking to end the event is refused, and the event stays live.
  const sock = io(SERVER, { auth: { token: guest.accessToken }, transports: ['websocket'], reconnection: false });
  const refusal = await new Promise<string>((resolve) => {
    sock.on('error', (e: { code?: string }) => resolve(e?.code ?? 'error without a code'));
    sock.on('connect_error', (e) => resolve(`connect_error ${e.message}`));
    // No session:join first: that would replace the guest's own browser tab as their connection.
    sock.on('connect', () => sock.emit('host:end_session', { sessionId, endEvent: true }));
    setTimeout(() => resolve('no answer'), 10_000);
  });
  sock.disconnect();
  expect(refusal, "a guest's host:end_session is refused").toBe('FORBIDDEN');
  await wait(1500);
  expect(await statusOf(), 'the meeting is still live').toBe('lobby_open');

  // 4. The guest leaves: the event page, the meeting carries on for the director; then the guest comes back.
  await guestPage.getByTestId('meeting-leave').click();
  const dialog = guestPage.getByRole('alertdialog', { name: 'Leave the meeting?' });
  await expect(dialog).toContainText('The others can carry on. You can rejoin from the event page.');
  await dialog.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(guestPage, 'the guest lands on the event page').toHaveURL(new RegExp(`/sessions/${sessionId}$`), { timeout: 30_000 });
  await expectLayout(dirPage, 'solo', 'director, alone', 45_000);
  await expect(dirPage.getByText('Waiting for others to join')).toBeVisible();
  expect(await statusOf(), 'the meeting carries on').toBe('lobby_open');
  await gotoRetry(guestPage, `${APP}/session/${sessionId}/live`);
  await expectLayout(guestPage, 'pair', 'guest, back', 60_000);
  await expectLayout(dirPage, 'side', 'director, guest back', 60_000);
  await expect.poll(() => playingTiles(dirPage), { timeout: 90_000, message: 'director: both cameras again' }).toBe(2);

  // 5. Four people: an even grid, equal tiles, nothing scrolls.
  const thirdPage = await openLive(third, { width: 1024, height: 768 });
  const fourthPage = await openLive(fourth, { width: 1024, height: 768 });
  for (const [page, who] of [[dirPage, 'director 1280x720'], [guestPage, 'guest 390x844'], [thirdPage, 'third 1024x768']] as const) {
    await expectLayout(page, 'grid', who, 90_000);
    await expect(page.locator('[data-testid="meeting-tile"]'), `${who}: four tiles`).toHaveCount(4, { timeout: 60_000 });
    await wait(600);
    const sizes: Array<{ width: number; height: number }> = [];
    for (const t of await page.locator('[data-testid="meeting-tile"]').all()) sizes.push(await expectInsideWindow(page, t, `${who}: a tile`));
    for (const s of sizes) {
      expect(Math.abs(s.width - sizes[0].width), `${who}: equal tile widths`).toBeLessThanOrEqual(1);
      expect(Math.abs(s.height - sizes[0].height), `${who}: equal tile heights`).toBeLessThanOrEqual(1);
    }
    await expectNoScroll(page, who);
  }
  await expect.poll(() => playingTiles(dirPage), { timeout: 90_000, message: 'director: four cameras play' }).toBe(4);
  await dirPage.screenshot({ path: 'test-results/vm1to1-director-4-people.png' });
  await guestPage.screenshot({ path: 'test-results/vm1to1-guest-4-people-390x844.png' });

  // 6. The director ends it for everyone.
  await dirPage.getByTestId('meeting-end').click();
  const endDialog = dirPage.getByRole('alertdialog', { name: 'End the meeting for everyone?' });
  await expect(endDialog).toContainText('Everyone will be disconnected.');
  await endDialog.getByRole('button', { name: 'End for everyone' }).click();
  for (const [page, who] of [[dirPage, 'director'], [guestPage, 'guest'], [thirdPage, 'third'], [fourthPage, 'fourth']] as const) {
    await expect(page.getByRole('heading', { name: 'Meeting ended' }), `${who}: Meeting ended`).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Back to event' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to pod' })).toBeVisible();
  }
  await expect.poll(statusOf, { timeout: 30_000, message: 'the event is completed' }).toBe('completed');
  await guestPage.screenshot({ path: 'test-results/vm1to1-guest-ended.png' });
  console.log('  ✓ VID-01..04: two people fit six screens, one way out, a guest cannot end it, four people in an even grid, ended for everyone.');
});
