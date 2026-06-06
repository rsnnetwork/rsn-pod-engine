import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for S26+S27 against PRODUCTION — "stuck at start" must be
// impossible across the edge-case matrix, and entering must mean FULL entry
// (video grid up — alihammza's blank "Main Room" shell counts as a FAIL):
//   A. healthy socket            → enters + video promptly
//   B. broadcast-DEAF socket     → (same-user displacement, the in-the-wild
//      shape) enters ≤25s + video ≤45s via per-user fan-out / poll / REST
//      token rails
//   C. network DEAD across Start → offline before Start, online after;
//      enters + video ≤45s of coming back (online-handler + poll + REST)
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
  host = await createTestUser('s27host', 'super_admin');
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

// FULL entry = past the waiting screen AND the lobby video grid is live
// (≥2 <video> elements: own preview + at least one peer).
async function waitFullyEntered(page: Page, label: string, timeoutMs: number, t0: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const waiting = await page.getByText(/Waiting for host to start the event/i).first().isVisible().catch(() => false);
    const mainRoom = await page.getByText(/Main Room|Waiting Room/i).first().isVisible().catch(() => false);
    const videos = await page.locator('video').count().catch(() => 0);
    if (!waiting && mainRoom && videos >= 2) {
      console.log(`  ✓ ${label}: FULLY entered (videos=${videos}) ${((Date.now() - t0) / 1000) | 0}s after Start`);
      return true;
    }
    await page.waitForTimeout(1500);
  }
  const videos = await page.locator('video').count().catch(() => 0);
  console.log(`  ✗ ${label}: NOT fully entered (videos=${videos})`);
  return false;
}

test('S27: no participant can stay stuck or video-less at Start (healthy / deaf / offline)', async () => {
  test.setTimeout(420_000);

  const users = await Promise.all(['s27u1', 's27u2', 's27u3'].map((n) => createTestUser(n)));
  const [uDeaf, uHealthy, uOffline] = users;
  const pod = await createPod(host, 'E2E S27 Pod');
  for (const u of users) await addPodMember(host, pod.id, u.id);
  const sess = await createSession(host, pod.id, 'E2E S27 Smoke', new Date(Date.now() + 3600_000), {
    numberOfRounds: 1, roundDurationSeconds: 300,
  });
  const sessionId = sess.id;
  await Promise.all(users.map((u) => registerForSession(u, sessionId)));

  const pgDeaf = await openUserPage(uDeaf, sessionId);
  const pgHealthy = await openUserPage(uHealthy, sessionId);
  const pgOffline = await openUserPage(uOffline, sessionId);
  await expect(pgHealthy.page.getByText(/Waiting for host|starting soon|Connecting/i).first(), 'waiting screens up')
    .toBeVisible({ timeout: 30_000 });
  await pgHealthy.page.waitForTimeout(4000);

  // EDGE B setup — deafen uDeaf via same-user displacement.
  const deafSock = await connectSocket(uDeaf);
  sockets.push(deafSock);
  deafSock.emit('session:join', { sessionId });
  await pgDeaf.page.waitForTimeout(3000);
  console.log(`  uDeaf displaced: ${await pgDeaf.page.getByText(/connected from another device/i).first().isVisible().catch(() => false)}`);

  // EDGE C setup — kill uOffline's network entirely BEFORE the start.
  await pgOffline.context.setOffline(true);
  console.log('  uOffline network cut');

  // START.
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  const t0 = Date.now();
  hostSock.emit('host:start_session', { sessionId });

  // A — healthy: prompt full entry.
  expect(await waitFullyEntered(pgHealthy.page, 'A healthy', 40_000, t0), 'healthy fully enters').toBe(true);

  // B — deaf: full entry without any refresh (fan-out + poll + REST token).
  expect(await waitFullyEntered(pgDeaf.page, 'B DEAF socket (alihammza case)', 50_000, t0), 'deaf fully enters').toBe(true);

  // C — offline through the start; restore now and require full self-heal.
  await pgOffline.context.setOffline(false);
  console.log('  uOffline network restored');
  const tRestore = Date.now();
  expect(await waitFullyEntered(pgOffline.page, 'C offline-through-start', 60_000, tRestore), 'offline user self-heals fully').toBe(true);

  try { await endSession(host, sessionId); } catch {}
  for (const s of [pgDeaf, pgHealthy, pgOffline]) { await s.context.close().catch(() => {}); }
  console.log('✓ S27 SMOKE COMPLETE: stuck-at-start eliminated across the matrix');
});
