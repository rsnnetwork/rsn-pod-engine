import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — FIX #5: when a rating window wedges (present
// participants who don't rate), the HOST gets a "Skip Ratings" button that
// force-advances the event. A real host browser opens; you watch the button
// appear and the event advance out of rating the moment it's clicked.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, m1: TestUser, m2: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket timeout')), 10_000);
  });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: any, url: string) => {
  for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } }
};
const status = async () => (await pool.query('SELECT status FROM sessions WHERE id=$1', [sessionId])).rows[0]?.status;

test.beforeAll(async () => {
  host = await createTestUser('v5host', 'super_admin');
  m1 = await createTestUser('v5m1');
  m2 = await createTestUser('v5m2');
  const pod = await createPod(host, 'E2E Verify5 Pod'); podId = pod.id;
  await addPodMember(host, podId, m1.id); await addPodMember(host, podId, m2.id);
  const sess = await createSession(host, podId, 'VERIFY #5 rating force-close', new Date(Date.now() + 60_000), { numberOfRounds: 2 });
  sessionId = sess.id;
  await Promise.all([registerForSession(m1, sessionId), registerForSession(m2, sessionId)]);
  browser = await chromium.launch({ headless: false, slowMo: 400, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('FIX #5: host "Skip Ratings" advances a wedged rating window', async () => {
  test.setTimeout(180_000);

  const hostSock = await connect(host); sockets.push(hostSock);

  // Host browser opens (you watch this one).
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: host.accessToken, r: host.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> host browser opening on prod <<<');
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await page.waitForTimeout(5000);

  // Bring the event into a round, then end the round → rating window.
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  const m1s = await connect(m1); sockets.push(m1s); m1s.emit('session:join', { sessionId });
  const m2s = await connect(m2); sockets.push(m2s); m2s.emit('session:join', { sessionId });
  await wait(4000);
  console.log('  host: match → start round → end round (→ rating)...');
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(5000);
  hostSock.emit('host:end_session', { sessionId }); await wait(4000); // end round → ROUND_RATING

  // Nobody rates → wedged. Confirm + watch the host's Skip Ratings button appear.
  expect(await status(), 'event should be in the rating window').toBe('round_rating');
  await page.waitForTimeout(5000);
  const skipBtn = page.getByRole('button', { name: /Skip Ratings/i });
  await expect(skipBtn, 'host must see a "Skip Ratings" control during the wedged rating window').toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: 'test-results/verify5-skip-ratings-button.png' }).catch(() => {});

  // Click it — the event must advance out of rating immediately (not wait the 90s backstop).
  console.log('  >>> clicking "Skip Ratings" — WATCH the event advance <<<');
  await skipBtn.click();
  let after = 'round_rating';
  for (let i = 0; i < 12 && after === 'round_rating'; i++) { await wait(1000); after = await status(); }
  console.log('  event status after Skip Ratings:', after);
  expect(after, 'Skip Ratings must advance the event out of the rating window').not.toBe('round_rating');
  await page.waitForTimeout(4000);

  await ctx.close();
  console.log('  ✓ FIX #5 verified headed on prod: host Skip Ratings advanced a wedged rating window to', after);
});
