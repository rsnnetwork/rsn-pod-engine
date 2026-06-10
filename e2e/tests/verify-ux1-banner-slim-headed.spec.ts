import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — Bug 1 (June-10): above the video tiles the main room
// showed a "Main Room · Click Match People" heading and a "X participants · Y host"
// count, eating vertical space. Move the count into the TOP BAR (next to the
// room-state chip) and leave ONLY the Compact/Normal/Spacious density toggle
// above the tiles. A real host browser opens; we screenshot and assert the new
// layout.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, m1: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => { const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('to')), 10_000); });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: any, url: string) => { for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } } };

test.beforeAll(async () => {
  host = await createTestUser('ux1host', 'super_admin');
  m1 = await createTestUser('ux1m1');
  const pod = await createPod(host, 'E2E UX1 Pod'); podId = pod.id;
  await addPodMember(host, podId, m1.id);
  const sess = await createSession(host, podId, 'VERIFY UX1 banner slim', new Date(Date.now() + 60_000), { numberOfRounds: 2 });
  sessionId = sess.id;
  await registerForSession(m1, sessionId);
  browser = await chromium.launch({ headless: false, slowMo: 300, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('Main room: count is in the top bar; above the tiles only the density toggle', async () => {
  test.setTimeout(150_000);
  const hostSock = await connect(host); sockets.push(hostSock);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: host.accessToken, r: host.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> host browser opening the main room <<<');
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await page.waitForTimeout(4000);

  // Bring everyone into the main room (lobby with tiles).
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  await page.reload().catch(() => {}); await wait(4000);
  const m1s = await connect(m1); sockets.push(m1s); m1s.emit('session:join', { sessionId }); await wait(4000);
  await page.screenshot({ path: 'test-results/ux1-main-room.png', fullPage: false }).catch(() => {});

  // The density toggle is above the tiles.
  await expect(page.getByRole('button', { name: 'Compact', exact: true }), 'density toggle should be above the tiles').toBeVisible({ timeout: 15_000 });
  for (const d of ['Normal', 'Spacious']) {
    expect(await page.getByRole('button', { name: d, exact: true }).count(), `${d} density button present`).toBeGreaterThan(0);
  }

  // The participant count is now in the top bar (a "participant" pill exists).
  await expect(page.getByText(/\d+\s+participant/i).first(), 'participant count should be visible (now in the top bar)').toBeVisible({ timeout: 15_000 });

  // The old above-tiles heading copy is GONE.
  expect(await page.getByText(/Click Match People/i).count(), 'the "Click Match People" heading must be removed').toBe(0);

  // Sanity: the count pill sits ABOVE the density toggle (top bar is higher than
  // the above-tiles controls), proving the count moved up out of the grid header.
  const countBox = await page.getByText(/\d+\s+participant/i).first().boundingBox();
  const compactBox = await page.getByRole('button', { name: 'Compact', exact: true }).boundingBox();
  console.log('  count.y=', countBox?.y, ' compact.y=', compactBox?.y);
  if (countBox && compactBox) {
    expect(countBox.y, 'the count should sit in the top bar, above the density toggle').toBeLessThan(compactBox.y);
  }

  await page.waitForTimeout(2000);
  await ctx.close();
  console.log('  ✓ UX1 verified: count in the top bar, only the density toggle above the tiles, no "Click Match People".');
});
