import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — co-host parity (Ali, June-11): a CO-HOST can do
// everything a host can EXCEPT (a) end the event and (b) assign new co-hosts.
//   • Co-host presses "Skip Ratings" → the rating window closes (host action works).
//   • Co-host tries to End the Event → refused (event keeps running).
//   • Co-host tries to assign another co-host → refused.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let director: TestUser, cohost: TestUser, p1: TestUser, p2: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => { const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('socket timeout')), 10_000); });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: any, url: string) => { for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } } };
const sessStatus = async () => (await pool.query('SELECT status FROM sessions WHERE id=$1', [sessionId])).rows[0]?.status;
const isCohostInDb = async (uid: string) => (await pool.query('SELECT 1 FROM session_cohosts WHERE session_id=$1 AND user_id=$2', [sessionId, uid])).rowCount! > 0;

test.beforeAll(async () => {
  director = await createTestUser('cphost', 'super_admin');
  cohost = await createTestUser('cpcohost');
  p1 = await createTestUser('cpp1');
  p2 = await createTestUser('cpp2');
  const pod = await createPod(director, 'E2E Cohost Pod'); podId = pod.id;
  await Promise.all([addPodMember(director, podId, cohost.id), addPodMember(director, podId, p1.id), addPodMember(director, podId, p2.id)]);
  const sess = await createSession(director, podId, 'VERIFY cohost parity', new Date(Date.now() + 60_000), { numberOfRounds: 3 });
  sessionId = sess.id;
  await Promise.all([registerForSession(cohost, sessionId), registerForSession(p1, sessionId), registerForSession(p2, sessionId)]);
  browser = await chromium.launch({ headless: false, slowMo: 350, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(director, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('Co-host can Skip Ratings, but cannot End Event or assign co-hosts', async () => {
  test.setTimeout(260_000);
  const dirSock = await connect(director); sockets.push(dirSock);

  // Co-host opens a real browser (we watch this one press Skip Ratings).
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: cohost.accessToken, r: cohost.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> co-host browser opening on prod <<<');
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await page.waitForTimeout(5000);

  // Director starts the event and PROMOTES the co-host (before matching, so the
  // co-host is excluded from pairing and stays in the main room as a host).
  dirSock.emit('host:start_session', { sessionId }); await wait(2500);
  await page.reload().catch(() => {}); await wait(4000);
  const p1s = await connect(p1); sockets.push(p1s); p1s.emit('session:join', { sessionId });
  const p2s = await connect(p2); sockets.push(p2s); p2s.emit('session:join', { sessionId });
  await wait(3000);
  console.log('  director promotes the co-host...');
  dirSock.emit('host:assign_cohost', { sessionId, userId: cohost.id, role: 'co_host' }); await wait(3000);
  expect(await isCohostInDb(cohost.id), 'co-host should be assigned in DB').toBe(true);

  // Run a round between p1 and p2, end it → rating window.
  console.log('  director: match p1+p2 → start round → end round (→ rating)...');
  dirSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  dirSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  dirSock.emit('host:start_round', { sessionId }); await wait(5000);
  dirSock.emit('host:end_session', { sessionId }); await wait(5000);
  expect(await sessStatus(), 'event should be in the rating window').toBe('round_rating');

  // ── (1) Co-host presses Skip Ratings — the host action must WORK. ──
  console.log('  >>> co-host clicks Skip Ratings — WATCH the event advance <<<');
  const skipBtn = page.getByRole('button', { name: /Skip Ratings/i });
  await expect(skipBtn, 'the co-host must SEE the Skip Ratings control').toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: 'test-results/cohost-skip-ratings.png' }).catch(() => {});
  await skipBtn.click();
  let after = 'round_rating';
  for (let i = 0; i < 12 && after === 'round_rating'; i++) { await wait(1000); after = await sessStatus(); }
  console.log('  event status after co-host Skip Ratings:', after);
  expect(after, 'a co-host Skip Ratings must advance the event out of rating').not.toBe('round_rating');
  console.log('  ✓ co-host Skip Ratings works.');

  // Close the browser so the co-host has a single (socket) connection for the
  // negative tests — avoids duplicate-connection eviction noise.
  await ctx.close();
  const coSock = await connect(cohost); sockets.push(coSock); coSock.emit('session:join', { sessionId }); await wait(2500);

  // ── (2) Co-host tries to END THE EVENT — must be refused. ──
  console.log('  >>> co-host attempts End Event (should be refused) <<<');
  const statusBefore = await sessStatus();
  coSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(4000);
  const statusAfter = await sessStatus();
  console.log('  event status before/after co-host End Event:', statusBefore, '/', statusAfter);
  expect(statusAfter, 'a co-host must NOT be able to complete the event').not.toBe('completed');

  // ── (3) Co-host tries to ASSIGN a new co-host — must be refused. ──
  console.log('  >>> co-host attempts to assign p1 as co-host (should be refused) <<<');
  coSock.emit('host:assign_cohost', { sessionId, userId: p1.id, role: 'co_host' }); await wait(3500);
  expect(await isCohostInDb(p1.id), 'a co-host must NOT be able to assign new co-hosts').toBe(false);

  console.log('  ✓ verified: co-host can Skip Ratings; cannot End Event; cannot assign co-hosts.');
});
