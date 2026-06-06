import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for S21 against PRODUCTION — the main-room grid must HOLD the
// last roster (with a "Reconnecting…" badge) while the viewer's own
// connection blips, instead of flashing "0 participants + 1 host" (z1, 12
// local browsers saturating the uplink). We cut the HOST page's network for
// ~5s with three tiles up and assert the held grid + badge appear and the
// live grid returns after recovery.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser;
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

async function gotoLive(page: Page, sessionId: string): Promise<void> {
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

async function openUserPage(user: TestUser, sessionId: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoLive(page, sessionId);
  return { context, page };
}

test.beforeAll(async () => {
  host = await createTestUser('s21host', 'super_admin');
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
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('S21: host network blip → grid holds with Reconnecting badge, then recovers', async () => {
  test.setTimeout(300_000);

  const users = await Promise.all(['s21u1', 's21u2'].map((n) => createTestUser(n)));
  const pod = await createPod(host, 'E2E S21 Pod');
  for (const u of users) await addPodMember(host, pod.id, u.id);
  const sess = await createSession(host, pod.id, 'E2E S21 Smoke', new Date(Date.now() + 60_000), {
    numberOfRounds: 1, roundDurationSeconds: 300,
  });
  const sessionId = sess.id;
  await Promise.all(users.map((u) => registerForSession(u, sessionId)));
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  const hostPg = await openUserPage(host, sessionId);
  const u1Pg = await openUserPage(users[0], sessionId);
  const u2Pg = await openUserPage(users[1], sessionId);
  await hostPg.page.waitForTimeout(8000);

  // All three tiles up on the host's grid (video elements present).
  {
    const end = Date.now() + 60_000;
    let n = 0;
    while (Date.now() < end) {
      n = await hostPg.page.locator('video').count();
      if (n >= 3) break;
      await hostPg.page.waitForTimeout(1500);
    }
    expect(n, 'host sees 3 video tiles before the blip').toBeGreaterThanOrEqual(3);
    console.log(`  ✓ pre-blip: host grid shows ${n} video tiles`);
  }

  // ── CUT the host's network ──
  console.log('  cutting host network…');
  await hostPg.context.setOffline(true);

  // The held grid + badge must appear (and show the last roster, not zero).
  const hold = hostPg.page.locator('[data-testid="lobby-reconnect-hold"]');
  await expect(hold, 'held grid appears during the blip').toBeVisible({ timeout: 20_000 });
  await expect(hostPg.page.getByText('Reconnecting…').first(), 'Reconnecting badge visible').toBeVisible({ timeout: 5_000 });
  const heldTiles = await hold.locator('.aspect-video').count();
  console.log(`  ✓ during blip: held grid with ${heldTiles} placeholder tiles + badge`);
  expect(heldTiles, 'held grid keeps the last roster (no zero-flash)').toBeGreaterThanOrEqual(3);

  // ── RESTORE ──
  await hostPg.page.waitForTimeout(4000);
  console.log('  restoring host network…');
  await hostPg.context.setOffline(false);

  // Live grid returns (hold disappears, video tiles back).
  {
    const end = Date.now() + 60_000;
    let recovered = false;
    while (Date.now() < end) {
      const holdVisible = await hold.isVisible().catch(() => false);
      const vids = await hostPg.page.locator('video').count();
      if (!holdVisible && vids >= 2) { recovered = true; console.log(`  ✓ recovered: ${vids} live video tiles, hold gone`); break; }
      await hostPg.page.waitForTimeout(2000);
    }
    expect(recovered, 'live grid returns after the blip').toBe(true);
  }

  try { await endSession(host, sessionId); } catch {}
  for (const s of [hostPg, u1Pg, u2Pg]) { await s.context.close().catch(() => {}); }
  console.log('✓ S21 SMOKE COMPLETE: reconnect hold browser-proven');
});
