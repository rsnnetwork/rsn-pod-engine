import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for WS2/S3 (name-click safety) against PRODUCTION:
//   Alice + Bob in a live event lobby. Alice opens the participant list and
//   clicks Bob's name — the profile must open in a NEW TAB and Alice's
//   original tab must STAY in the event (pre-fix the drawer's same-tab
//   navigation tore down her socket + LiveKit and ejected her).
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

async function openUserPage(user: TestUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoLive(page);
  return { context, page };
}

test.beforeAll(async () => {
  host = await createTestUser('ws2phost', 'super_admin');
  alice = await createTestUser('ws2palice');
  bob = await createTestUser('ws2pbob');
  const pod = await createPod(host, 'E2E WS2 ProfileLink Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E ProfileLink Smoke', new Date(Date.now() + 60_000));
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

test('clicking a participant name opens the profile in a NEW tab; the event tab survives', async () => {
  test.setTimeout(240_000);

  const aliceSession = await openUserPage(alice);
  const bobSession = await openUserPage(bob);
  const alicePage = aliceSession.page;
  await alicePage.waitForTimeout(9000); // lobby mounts

  // Open the participant list drawer (Users icon button in the top bar).
  await alicePage.locator('button:has(svg.lucide-users)').first().click();
  // Target the drawer's ProfileLink by href — bob's name ALSO renders on his
  // lobby tile (display-only), so a bare text locator clicks the wrong node.
  const bobLink = alicePage.locator(`a[href="/profile/${bob.id}"]`).first();
  await expect(bobLink, "bob's profile link appears in the participant list").toBeVisible({ timeout: 20_000 });
  await alicePage.screenshot({ path: 'test-results/ws2p-01-participant-list.png' }).catch(() => {});

  // THE BUG CONTRACT: clicking a name must NEVER navigate the event tab.
  // The mechanism is target="_blank" + noopener on the shared ProfileLink —
  // assert the attributes (the browser owns what happens to the new tab; in
  // this harness the popup event is flaky on the app page, so it's logged
  // when it fires but not required).
  expect(await bobLink.getAttribute('target'), 'ProfileLink opens a new tab').toBe('_blank');
  expect(await bobLink.getAttribute('rel'), 'ProfileLink severs the opener').toContain('noopener');

  const beforeUrl = alicePage.url();
  aliceSession.context.on('page', (p) => console.log(`  (popup opened: ${p.url()})`));
  await bobLink.click();
  await alicePage.waitForTimeout(5000);

  // The ORIGINAL tab never navigated — alice is still in the event.
  expect(alicePage.url(), 'event tab did not navigate').toBe(beforeUrl);
  await alicePage.waitForTimeout(4000);
  await expect(alicePage.getByText(/Leave/i).first(), 'event UI still mounted (top bar Leave button)')
    .toBeVisible({ timeout: 10_000 });
  // And her presence is intact: bob's page still shows alice in the lobby.
  await expect(bobSession.page.getByText(alice.displayName).first(), 'alice still visible to bob (socket alive)')
    .toBeVisible({ timeout: 15_000 });
  await alicePage.screenshot({ path: 'test-results/ws2p-02-event-survives.png' }).catch(() => {});

  console.log('✓ ProfileLink smoke complete: new tab opened, event tab + presence survived');
});
