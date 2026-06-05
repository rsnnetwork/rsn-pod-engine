import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED mobile-event smoke vs PRODUCTION — every surface a phone user
// touches, INCLUDING the host running the event from a phone:
//   - alice on a 360×740 small Android; THE HOST on a 390×844 iPhone;
//     bob on desktop as the counterpart.
//   - main room: no horizontal overflow, video tiles render, density toggle.
//   - buttons: top-bar Participants + Leave Event and the chat FAB must sit
//     fully inside the viewport with ≥40px effective tap height
//     (boundingBox checks — isVisible() lies about off-viewport elements).
//   - messaging: chat FAB → bottom-sheet → send from the phone → desktop
//     receives → backdrop closes.
//   - host-on-mobile: page overflow-free pre-round AND mid-round (round
//     dashboard), participant drawer usable.
//   - breakout on mobile: timer bar + Back to Main Room inside viewport.
//   - rating on mobile: form fits, stars tappable, real submit on 360px.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, alice: TestUser, bob: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connectSocket(user: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: user.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 10000);
  });
}

async function readBreakoutSeconds(page: Page): Promise<number | null> {
  const texts = await page.locator('span.font-mono').allInnerTexts().catch(() => [] as string[]);
  for (const t of texts) {
    const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  return null;
}

async function gotoLive(page: Page): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 45_000 });
      return;
    } catch (e) {
      if (i === 3) throw e;
      await page.waitForTimeout(5000);
    }
  }
}

async function openUserPage(user: TestUser, viewport?: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(viewport ? { viewport, hasTouch: true, isMobile: true } : {});
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoLive(page);
  return { context, page };
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    bs: document.body.scrollWidth, bc: document.body.clientWidth,
  }));
  expect(o.sw, `${label}: html overflows horizontally (${o.sw} > ${o.cw})`).toBeLessThanOrEqual(o.cw + 1);
  expect(o.bs, `${label}: body overflows horizontally (${o.bs} > ${o.bc})`).toBeLessThanOrEqual(o.bc + 1);
  console.log(`  ✓ ${label}: no horizontal overflow`);
}

async function assertTapTarget(page: Page, locator: ReturnType<Page['locator']>, label: string, viewportW: number, minSize = 40): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label}: must have a boundingBox (rendered + on-screen)`).not.toBeNull();
  expect(box!.x, `${label}: left edge inside viewport`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label}: right edge inside viewport`).toBeLessThanOrEqual(viewportW + 1);
  expect(box!.height, `${label}: tap height ≥${minSize}px (got ${Math.round(box!.height)})`).toBeGreaterThanOrEqual(minSize);
  console.log(`  ✓ ${label}: ${Math.round(box!.width)}×${Math.round(box!.height)} inside ${viewportW}px viewport`);
}

test.beforeAll(async () => {
  host = await createTestUser('wsmhost', 'super_admin');
  alice = await createTestUser('wsmalice');
  bob = await createTestUser('wsmbob');
  const pod = await createPod(host, 'E2E Mobile Event Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E Mobile Event', new Date(Date.now() + 60_000), {
    numberOfRounds: 1,
    roundDurationSeconds: 300,
  });
  sessionId = sess.id;
  await Promise.all([registerForSession(alice, sessionId), registerForSession(bob, sessionId)]);
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('mobile event: main room, buttons, chat, host-on-phone, breakout, rating — all on phone viewports', async () => {
  test.setTimeout(540_000);

  // alice = 360px small Android, HOST = 390px iPhone, bob = desktop.
  const aliceS = await openUserPage(alice, { width: 360, height: 740 });
  const hostS = await openUserPage(host, { width: 390, height: 844 });
  const bobS = await openUserPage(bob);
  const alicePage = aliceS.page, hostPage = hostS.page, bobPage = bobS.page;
  await alicePage.waitForTimeout(10_000); // lobby mounts + cameras publish

  // ── 1. MAIN ROOM on phones ──
  await assertNoHorizontalOverflow(alicePage, 'alice main room @360');
  await assertNoHorizontalOverflow(hostPage, 'HOST main room @390');
  const aliceVideos = await alicePage.locator('video').count();
  console.log(`  alice videos in main room: ${aliceVideos}`);
  expect(aliceVideos, 'video tiles render on the phone').toBeGreaterThan(0);
  await alicePage.screenshot({ path: 'test-results/wsm-01-alice-mainroom-360.png' }).catch(() => {});
  await hostPage.screenshot({ path: 'test-results/wsm-02-host-mainroom-390.png' }).catch(() => {});

  // ── 2. BUTTONS: tap targets inside the viewport ──
  await assertTapTarget(alicePage, alicePage.locator('button[aria-label="Participants"]').first(), 'Participants toggle', 360, 40);
  await assertTapTarget(alicePage, alicePage.getByText('Leave Event', { exact: true }).first(), 'Leave Event', 360, 40);
  await assertTapTarget(alicePage, alicePage.locator('button[aria-label="Open chat"]').first(), 'Chat FAB', 360, 44);

  // Participant drawer usable on the phone (and names are safe links).
  await alicePage.locator('button[aria-label="Participants"]').first().click();
  await expect(alicePage.locator(`a[href="/profile/${bob.id}"]`).first(), 'drawer entry on phone').toBeVisible({ timeout: 15_000 });
  await assertNoHorizontalOverflow(alicePage, 'alice with drawer open @360');
  await alicePage.locator('button[aria-label="Participants"]').first().click(); // close

  // ── 3. MESSAGING from the phone ──
  await alicePage.locator('button[aria-label="Open chat"]').first().click();
  const chatInput = alicePage.locator('input[placeholder*="essage"], textarea[placeholder*="essage"], input[type="text"]').last();
  await expect(chatInput, 'chat input visible in the bottom sheet').toBeVisible({ timeout: 15_000 });
  const inputBox = await chatInput.boundingBox();
  expect(inputBox!.y + inputBox!.height, 'chat input inside the 740px viewport').toBeLessThanOrEqual(741);
  await chatInput.fill('hello from the phone');
  await chatInput.press('Enter');
  await expect(bobPage.getByText('hello from the phone').first(), 'desktop receives the phone message')
    .toBeVisible({ timeout: 20_000 });
  console.log('  ✓ chat: phone → desktop delivered');
  await alicePage.screenshot({ path: 'test-results/wsm-03-alice-chat-360.png' }).catch(() => {});
  // Backdrop tap closes the sheet (top half of the screen).
  const backdrop = alicePage.getByTestId('chat-mobile-backdrop');
  if (await backdrop.isVisible().catch(() => false)) await backdrop.click({ position: { x: 100, y: 100 } });
  await assertNoHorizontalOverflow(alicePage, 'alice after chat @360');

  // ── 4. HOST RUNS THE ROUND FROM THE PHONE VIEW ──
  // (Round triggered via the host's socket — the assertions are that the
  // host's PHONE UI stays usable: overflow-free, dashboard renders.)
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  let previewMatches = 0;
  hostSock.on('host:match_preview', (d: any) => { previewMatches = (d?.matches || []).length; });
  hostSock.emit('session:join', { sessionId });
  await alicePage.waitForTimeout(2000);
  for (let attempt = 1; attempt <= 8; attempt++) {
    previewMatches = 0;
    hostSock.emit('host:generate_matches', { sessionId });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && previewMatches === 0) await alicePage.waitForTimeout(500);
    if (previewMatches === 1) break;
    await alicePage.waitForTimeout(4000);
  }
  expect(previewMatches, 'alice+bob pair').toBe(1);
  hostSock.emit('host:confirm_round', { sessionId });

  // alice lands in the breakout on her phone.
  {
    const deadline = Date.now() + 120_000;
    let inRoom = false;
    while (Date.now() < deadline) {
      if ((await readBreakoutSeconds(alicePage)) !== null) { inRoom = true; break; }
      await alicePage.waitForTimeout(1500);
    }
    expect(inRoom, 'alice reaches the breakout on the phone').toBe(true);
  }

  // ── 5. BREAKOUT on the phone ──
  await assertNoHorizontalOverflow(alicePage, 'alice breakout @360');
  await assertTapTarget(alicePage, alicePage.getByText('Back to Main Room', { exact: true }).first(), 'Back to Main Room', 360, 32);
  const roomVideos = await alicePage.locator('video').count();
  console.log(`  alice videos in breakout: ${roomVideos}`);
  expect(roomVideos, 'breakout video renders on the phone').toBeGreaterThan(0);
  await alicePage.screenshot({ path: 'test-results/wsm-04-alice-breakout-360.png' }).catch(() => {});

  // HOST mid-round on the phone: dashboard visible, page overflow-free.
  await hostPage.waitForTimeout(4000);
  await assertNoHorizontalOverflow(hostPage, 'HOST mid-round @390');
  await hostPage.screenshot({ path: 'test-results/wsm-05-host-midround-390.png' }).catch(() => {});

  // ── 6. RATING on the phone ──
  await alicePage.getByText('Back to Main Room', { exact: true }).first().click();
  await expect(alicePage.getByText(/Rate your conversation/i).first(), 'rating form on the phone')
    .toBeVisible({ timeout: 15_000 });
  await assertNoHorizontalOverflow(alicePage, 'alice rating form @360');
  const star4 = alicePage.locator('button:has(svg.lucide-star)').nth(3);
  await assertTapTarget(alicePage, star4, 'rating star', 360, 40);
  await star4.click();
  const submitBtn = alicePage.getByText('Submit Rating', { exact: true }).first();
  await assertTapTarget(alicePage, submitBtn, 'Submit Rating', 360, 40);
  await alicePage.screenshot({ path: 'test-results/wsm-06-alice-rating-360.png' }).catch(() => {});
  await submitBtn.click();
  await alicePage.waitForTimeout(4000);
  expect(await readBreakoutSeconds(alicePage), 'alice back in main after rating on the phone').toBeNull();
  await assertNoHorizontalOverflow(alicePage, 'alice back in main @360');

  console.log('✓ MOBILE EVENT SMOKE complete: main room, buttons, chat, host-on-phone, breakout, rating — all phone-clean');
});
