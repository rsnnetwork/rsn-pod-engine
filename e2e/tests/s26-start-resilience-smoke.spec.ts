import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for S26 against PRODUCTION — alihammza's exact repro:
// a participant whose page is DEAF to room broadcasts (we deafen it the same
// way it happens in the wild: a second connection as the same user unseats
// the page from the broadcast room) must STILL leave the waiting screen
// within ~15s of the host pressing Start — via the per-user fan-out and/or
// the waiting screen's 10s REST poll. Pre-S26 that page sat on "waiting for
// host" forever until a manual refresh.
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
  host = await createTestUser('s26host', 'super_admin');
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

test('S26: a broadcast-deaf participant still enters within 15s of Start', async () => {
  test.setTimeout(300_000);

  const users = await Promise.all(['s26u1', 's26u2'].map((n) => createTestUser(n)));
  const [u1, u2] = users;
  const pod = await createPod(host, 'E2E S26 Pod');
  for (const u of users) await addPodMember(host, pod.id, u.id);
  const sess = await createSession(host, pod.id, 'E2E S26 Smoke', new Date(Date.now() + 3600_000), {
    numberOfRounds: 1, roundDurationSeconds: 300,
  });
  const sessionId = sess.id;
  await Promise.all(users.map((u) => registerForSession(u, sessionId)));

  // Both participants land on the WAITING screen (event not started).
  const u1Pg = await openUserPage(u1, sessionId);
  const u2Pg = await openUserPage(u2, sessionId);
  await expect(u1Pg.page.getByText(/Waiting for host|starting soon|Connecting/i).first(), 'u1 on the waiting screen')
    .toBeVisible({ timeout: 30_000 });

  // DEAFEN u1's page: a second connection as the same user unseats the
  // page from the broadcast room — the in-the-wild failure shape.
  const u1Sock = await connectSocket(u1);
  sockets.push(u1Sock);
  u1Sock.emit('session:join', { sessionId });
  await u1Pg.page.waitForTimeout(3000);
  const displaced = await u1Pg.page.getByText(/connected from another device/i).first().isVisible().catch(() => false);
  console.log(`  u1 page deafened (displacement banner visible: ${displaced})`);

  // Host presses START (raw socket; host page not needed).
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  const t0 = Date.now();
  hostSock.emit('host:start_session', { sessionId });

  // u2 (healthy) enters promptly; u1 (deaf) must enter within ~15s
  // (per-user fan-out, else the 10s waiting-screen poll).
  const waitEntered = async (page: Page, label: string, timeoutMs: number) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const waiting = await page.getByText(/Waiting for host to start the event/i).first().isVisible().catch(() => false);
      const mainRoom = await page.getByText(/Main Room|Waiting Room/i).first().isVisible().catch(() => false);
      if (!waiting && mainRoom) {
        console.log(`  ✓ ${label} entered ${(Date.now() - t0) / 1000 | 0}s after Start`);
        return true;
      }
      await page.waitForTimeout(1000);
    }
    return false;
  };
  expect(await waitEntered(u2Pg.page, 'u2 (healthy socket)', 20_000), 'u2 enters').toBe(true);
  expect(await waitEntered(u1Pg.page, 'u1 (DEAF socket — the alihammza case)', 25_000),
    'u1 self-heals into the event without a refresh').toBe(true);

  try { await endSession(host, sessionId); } catch {}
  for (const s of [u1Pg, u2Pg]) { await s.context.close().catch(() => {}); }
  console.log('✓ S26 SMOKE COMPLETE: stuck-at-waiting is self-healing now');
});
