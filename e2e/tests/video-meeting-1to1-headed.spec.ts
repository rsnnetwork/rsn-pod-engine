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
// A video meeting is now its own room. Real browsers with fake cameras:
//   1. Before the start: the guest waits for the director by name; the director
//      has "Start meeting". None of speed networking's chrome.
//   2. Both see the other person and themselves, fully on screen, at 1280x720,
//      1440x900, 1024x768, 390x844, 360x740 and 844x390 (boundingBox): side by
//      side at equal size in a window at least 1024px wide and landscape (1024x768
//      included), otherwise the other person large and yourself small. Leave is in
//      the bottom bar, 44px, reachable. Still none of speed networking's chrome.
//   3. A guest's own host:end_session is refused (FORBIDDEN); the event stays live.
//   4. A muted guest who loads the page again comes back muted (the mic choice is
//      applied once per room connection, never re-opened by the room itself).
//   5. The guest leaves (the event page) while the director stays, and rejoins.
//   6. Four people, one of them in a browser that may use only the camera: equal
//      tiles, nothing scrolls; that person is told their microphone did not turn
//      on and stays in, and their tile does not reconnect over and over.
//   7. The director ends it for everyone: every screen says "Meeting ended", and
//      the event is completed in the database.
// No page throws an uncaught error along the way.
// Runs against the preview (E2E_VERCEL_SHARE set) or production; Chromium only
// (the fake camera). Real two-way video is asserted: the tiles' <video> play.
// ─────────────────────────────────────────────────────────────────────────────

// Chromium >= 147 on Windows loses the fake camera through Media Foundation capture; Chromium honours only the
// last --disable-features switch, so Playwright's own defaults (1.59.1) are repeated before the extra one.
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';
const HEADLESS = process.env.E2E_HEADED === '0';
const MIC_FAILED = "Your microphone didn't turn on. Check that this site may use it in your browser settings.";

const SIZES: Array<{ w: number; h: number; layout: 'side' | 'pair' }> = [
  { w: 1280, h: 720, layout: 'side' },
  { w: 1440, h: 900, layout: 'side' },
  { w: 1024, h: 768, layout: 'side' },
  { w: 390, h: 844, layout: 'pair' },
  { w: 360, h: 740, layout: 'pair' },
  { w: 844, h: 390, layout: 'pair' },
];

let browser: Browser;
// A browser that asks the page's permissions (no fake permission UI): its context grants only the camera, so the
// microphone is refused (headed: NotAllowedError; headless Chromium offers no devices at all without the fake UI).
let cameraOnlyBrowser: Browser;
let director: TestUser, guest: TestUser, third: TestUser, fourth: TestUser;
let podId = '';
let sessionId = '';
const ctxs: BrowserContext[] = [];
const pageErrors: string[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = async () => (await pool.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [sessionId])).rows[0]?.status;

async function openLive(u: TestUser, who: string, viewport: { width: number; height: number }, opts: { cameraOnly?: boolean } = {}): Promise<Page> {
  const ctx = opts.cameraOnly
    ? await cameraOnlyBrowser.newContext({ viewport, permissions: ['camera'] })
    : await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`));
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return page;
}

const stage = (page: Page) => page.locator('[data-testid="meeting-stage"]');
const selfTile = (page: Page) => page.locator('[data-testid="meeting-tile"][data-self="true"]');
const otherTiles = (page: Page) => page.locator('[data-testid="meeting-tile"]:not([data-self="true"])');
const tileOf = (page: Page, u: TestUser) => page.locator(`[data-testid="meeting-tile"][data-user-id="${u.id}"]`);
const micButton = (page: Page) => page.getByTestId('meeting-control-bar').getByRole('button', { name: /^Mic (on|off)$/ });

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

/**
 * None of speed networking's live page: its top-bar Leave Event, room chip and density toggle, its host bar (Match
 * People, Control Center, End Event, the event plan), its floating chat and reaction buttons, its check-in. Every
 * one of these renders on the speed-networking page from the moment it is live, so a leak cannot hide from this.
 */
async function expectNoSpeedNetworkingChrome(page: Page, who: string): Promise<void> {
  const absent: Array<[string, Locator]> = [
    ['Leave Event', page.getByRole('button', { name: 'Leave Event' })],
    ['End Event', page.getByRole('button', { name: /^End Event$/ })],
    ['Control Center', page.getByRole('button', { name: /Control Center/ })],
    ['Match People', page.getByRole('button', { name: /Match People|Another Round/ })],
    ['Start Event', page.getByRole('button', { name: /^Start Event$/ })],
    ['the floating chat button', page.getByRole('button', { name: 'Open chat' })],
    ['the reaction button', page.getByTitle('Reactions')],
    ['Compact / Normal / Spacious', page.getByRole('button', { name: /^(Compact|Normal|Spacious)$/ })],
    ['the room chip', page.getByText(/^(Main Room|Waiting to start)( ·.*)?$/)],
    ['the event plan', page.getByText(/^Plan:/)],
    ['the check-in', page.getByRole('heading', { name: /What brings you here/i })],
  ];
  for (const [what, loc] of absent) expect(await loc.count(), `${who}: ${what} leaked into the meeting`).toBe(0);
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
  const camera = ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--disable-features=${PW_DISABLED},MediaFoundationD3D11VideoCapture`];
  browser = await chromium.launch({ headless: HEADLESS, args: [...camera, '--use-fake-ui-for-media-stream'] });
  cameraOnlyBrowser = await chromium.launch({ headless: HEADLESS, args: camera });
  // An ordinary member directs it, as Claus did.
  director = await createTestUser('vm1dir');
  guest = await createTestUser('vm1guest');
  third = await createTestUser('vm1third');
  fourth = await createTestUser('vm1fourth');
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Claus Meeting', director.id]);
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Stefan Meeting', guest.id]);
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Mira Nomic', fourth.id]);
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
  await cameraOnlyBrowser?.close().catch(() => {});
  await cleanup(pool, { ids: [director, guest, third, fourth].filter(Boolean).map((u) => u.id), podId: podId || undefined });
});

test('VID-01..04: a two-person video meeting fits every screen, has one way out, and ends for everyone', async () => {
  test.setTimeout(720_000);

  // 1. Before the start.
  const dirPage = await openLive(director, 'director', { width: 1280, height: 720 });
  const guestPage = await openLive(guest, 'guest', { width: 1280, height: 720 });
  await expect(guestPage.getByText('Waiting for Claus Meeting to start the meeting'), 'the guest waits for the director by name')
    .toBeVisible({ timeout: 60_000 });
  const start = dirPage.getByRole('button', { name: /Start meeting/ });
  await expect(start, 'the director can start it').toBeVisible({ timeout: 60_000 });
  expect(await guestPage.getByRole('button', { name: /Start meeting/ }).count(), 'a guest cannot').toBe(0);
  await expectNoSpeedNetworkingChrome(dirPage, 'director, before the start');
  await expectNoSpeedNetworkingChrome(guestPage, 'guest, before the start');
  await start.click();
  await expect.poll(statusOf, { timeout: 30_000, message: 'the meeting is live' }).toBe('lobby_open');

  // 2. Both see each other: two tiles with real video on both screens.
  for (const [page, who] of [[dirPage, 'director'], [guestPage, 'guest']] as const) {
    await expectLayout(page, 'side', who);
    await expect.poll(() => playingTiles(page), { timeout: 90_000, message: `${who}: both cameras play` }).toBe(2);
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
  // The meeting has been live for a while now: still nothing of speed networking on either screen.
  await expectNoSpeedNetworkingChrome(dirPage, 'director, live');
  await expectNoSpeedNetworkingChrome(guestPage, 'guest, live');
  expect(pageErrors, 'no page has thrown').toEqual([]);

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

  // 4. A muted guest who connects again comes back muted, and the director sees it.
  await expect(micButton(guestPage), 'the guest joined with the mic on').toHaveAttribute('aria-label', 'Mic on', { timeout: 30_000 });
  await micButton(guestPage).click();
  await expect(micButton(guestPage)).toHaveAttribute('aria-label', 'Mic off', { timeout: 15_000 });
  const guestMuted = dirPage.getByTitle("Stefan Meeting's microphone is off");
  await expect(guestMuted, 'the director sees the guest muted').toBeVisible({ timeout: 20_000 });
  await gotoRetry(guestPage, `${APP}/session/${sessionId}/live`);
  await expectLayout(guestPage, 'pair', 'guest, reloaded', 60_000);
  await expect.poll(() => playingTiles(guestPage), { timeout: 90_000, message: 'guest: both cameras again' }).toBe(2);
  await wait(3000); // past the moment the mic choice is applied
  await expect(micButton(guestPage), 'still muted after connecting again').toHaveAttribute('aria-label', 'Mic off');
  await expect(guestMuted, 'the director still sees the guest muted').toBeVisible({ timeout: 20_000 });
  await micButton(guestPage).click();
  await expect(micButton(guestPage)).toHaveAttribute('aria-label', 'Mic on', { timeout: 15_000 });
  await expect(guestMuted, 'unmuted again, the director sees it').toHaveCount(0, { timeout: 20_000 });

  // 5. The guest leaves: the event page, the meeting carries on for the director; then the guest comes back.
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

  // 6. Four people, the fourth in a browser that may use only the camera.
  const thirdPage = await openLive(third, 'third', { width: 1024, height: 768 });
  const tokenPosts: string[] = [];
  const fourthPage = await openLive(fourth, 'fourth (camera only)', { width: 1024, height: 768 }, { cameraOnly: true });
  fourthPage.on('request', (r) => { if (r.method() === 'POST' && /\/sessions\/[^/]+\/token$/.test(new URL(r.url()).pathname)) tokenPosts.push(r.url()); });
  // Told at once that the microphone did not turn on (the toast shows for six seconds once the room connects).
  await expect(fourthPage.getByText(MIC_FAILED), 'the fourth is told the microphone did not turn on').toBeVisible({ timeout: 60_000 });
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
  // Without the fake permission UI a headless Chromium has no camera either, so the fourth may show no picture then.
  await expect.poll(() => playingTiles(dirPage), { timeout: 90_000, message: 'director: the cameras play' })
    .toBeGreaterThanOrEqual(HEADLESS ? 3 : 4);
  await dirPage.screenshot({ path: 'test-results/vm1to1-director-4-people.png' });
  await guestPage.screenshot({ path: 'test-results/vm1to1-guest-4-people-390x844.png' });

  // The fourth stays in with the mic off, and their tile does not reconnect over and over: the same tile element
  // stays on the director's screen for 20 seconds, and the fourth asks for no new room token.
  await expect(micButton(fourthPage), 'the fourth stays in with the mic off').toHaveAttribute('aria-label', 'Mic off');
  await expect(tileOf(dirPage, fourth), "the director sees the fourth's tile").toHaveCount(1);
  await tileOf(dirPage, fourth).evaluate((el) => el.setAttribute('data-e2e-mark', 'first'));
  const tokensBefore = tokenPosts.length;
  await wait(20_000);
  await expect(tileOf(dirPage, fourth), 'still one tile for the fourth').toHaveCount(1);
  await expect(tileOf(dirPage, fourth), 'the same tile element: no reconnect').toHaveAttribute('data-e2e-mark', 'first');
  expect(tokenPosts.length - tokensBefore, 'the fourth asked for no new room token').toBe(0);
  await expect(fourthPage.locator('[data-testid="meeting-stage"]'), 'the fourth is still in the meeting').toHaveAttribute('data-layout', 'grid');
  await fourthPage.screenshot({ path: 'test-results/vm1to1-fourth-camera-only.png' });

  // 7. The director ends it for everyone.
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
  expect(pageErrors, 'no page has thrown').toEqual([]);
  console.log('  ✓ VID-01..04: two people fit six screens, one way out, a guest cannot end it, a mute survives connecting again, four people in an even grid, a mic that cannot open leaves the room steady, ended for everyone.');
});
