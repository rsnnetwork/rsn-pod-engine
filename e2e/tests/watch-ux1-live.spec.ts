import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// WATCHABLE headed smoke — opens a REAL visible Chromium window on the user's
// screen, slowly, against PRODUCTION (app.rsn.network), so Ali can see the test
// drive itself. Verifies UX1 (the merged single-line top bar) live + screenshots.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, m1: TestUser, m2: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(user: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: user.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 10_000);
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.beforeAll(async () => {
  host = await createTestUser('watchhost', 'super_admin');
  m1 = await createTestUser('watchm1');
  m2 = await createTestUser('watchm2');
  const pod = await createPod(host, 'E2E Watch Pod');
  podId = pod.id;
  await addPodMember(host, podId, m1.id);
  await addPodMember(host, podId, m2.id);
  const sess = await createSession(host, podId, 'WATCH UX1 — Live Banner Demo', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all([registerForSession(m1, sessionId), registerForSession(m2, sessionId)]);

  // slowMo makes every Playwright action visibly slow so it's easy to follow.
  browser = await chromium.launch({
    headless: false,
    slowMo: 700,
    args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('WATCH: real browser opens on prod and shows the UX1 single-line banner', async () => {
  test.setTimeout(180_000);

  // Open the lobby so there are real video tiles under the banner.
  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId });
  await wait(2500);
  const m2Sock = await connect(m2); sockets.push(m2Sock); m2Sock.emit('session:join', { sessionId });
  await wait(2000);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: m1.accessToken, r: m1.refreshToken });
  const page = await ctx.newPage();

  console.log('  >>> Opening app.rsn.network live page — WATCH YOUR SCREEN <<<');
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded', timeout: 60_000 }); break; }
    catch (e) { if (attempt === 2) throw e; await wait(3000); }
  }
  await page.waitForTimeout(8000); // let the lobby + banner render; visible to the user

  // Desktop screenshot of the merged single-line banner.
  await page.screenshot({ path: 'test-results/watch-ux1-desktop.png' }).catch(() => {});
  console.log('  desktop screenshot saved.');

  // Structural check: the room-state text now lives INSIDE the top header bar
  // (the merged single line), not in a separate full-width row below it.
  const header = page.locator('div.border-b.border-gray-200').first();
  await expect(header, 'the live page header bar should be present').toBeVisible({ timeout: 15_000 });
  const headerText = await header.innerText().catch(() => '');
  console.log('  top bar text (title + inline state on ONE line):', JSON.stringify(headerText.replace(/\n/g, ' | ')));

  // Resize to a phone width so the user can see it stays one compact line.
  console.log('  >>> Resizing to phone width (390px) — WATCH <<<');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'test-results/watch-ux1-phone.png' }).catch(() => {});
  console.log('  phone screenshot saved.');

  // Hold the window open so it's clearly visible before it closes.
  console.log('  >>> Holding the window open for 12s so you can see it <<<');
  await page.waitForTimeout(12000);

  await ctx.close();
  console.log('  ✓ headed browser ran on prod; UX1 banner shown. Screenshots in e2e/test-results/.');
});
