import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — Bug (June-10 live): after the host pressed "Skip
// Ratings", desktop users were pulled to the main room and then REVERTED to the
// rating form within a few seconds (a reconnect/"Rejoin here" replayed the
// closed window). This opens a REAL participant browser, runs a round, ends it
// into rating, force-closes the rating, then RELOADS the participant (the exact
// reconnect that caused the revert) and asserts the rating form does NOT come
// back — the participant stays in the main room.
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
// The rating form is on screen if either the per-partner heading or the submit
// control is visible.
const ratingFormVisible = async (page: any) => {
  const a = await page.getByText(/How was your chat with/i).count().catch(() => 0);
  const b = await page.getByRole('button', { name: /Submit Rating/i }).count().catch(() => 0);
  const c = await page.getByText(/Rate your (last )?conversation/i).count().catch(() => 0);
  return a + b + c > 0;
};

test.beforeAll(async () => {
  host = await createTestUser('revhost', 'super_admin');
  m1 = await createTestUser('revm1');
  m2 = await createTestUser('revm2');
  const pod = await createPod(host, 'E2E Revert Pod'); podId = pod.id;
  await addPodMember(host, podId, m1.id); await addPodMember(host, podId, m2.id);
  // 2 rounds so a force-close lands in ROUND_TRANSITION (the exact state the
  // reconnect replay used to re-open), not a completed event.
  const sess = await createSession(host, podId, 'VERIFY skip-ratings no revert', new Date(Date.now() + 60_000), { numberOfRounds: 2 });
  sessionId = sess.id;
  await Promise.all([registerForSession(m1, sessionId), registerForSession(m2, sessionId)]);
  browser = await chromium.launch({ headless: false, slowMo: 350, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('Skip Ratings: a reconnecting desktop user does NOT revert to the rating form', async () => {
  test.setTimeout(240_000);

  const hostSock = await connect(host); sockets.push(hostSock);

  // m1 is the DESKTOP participant we watch (Waseem's seat).
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: m1.accessToken, r: m1.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> desktop participant (m1) browser opening on prod <<<');
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await page.waitForTimeout(5000);

  // Bring the event into a live round between m1 and m2.
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  page.reload().catch(() => {}); await wait(4000); // ensure m1 is joined post-start
  const m2s = await connect(m2); sockets.push(m2s); m2s.emit('session:join', { sessionId }); await wait(3000);
  console.log('  host: generate → confirm → start round...');
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(6000);

  // End the round → ROUND_RATING. m1 should now see the rating form.
  hostSock.emit('host:end_session', { sessionId }); await wait(5000);
  expect(await status(), 'event should be in the rating window after the round ends').toBe('round_rating');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/revert-1-rating-form.png' }).catch(() => {});
  expect(await ratingFormVisible(page), 'm1 must be on the rating form once the round ends').toBe(true);
  console.log('  ✓ m1 is on the rating form (as expected).');

  // Host presses Skip Ratings — m1 should be pulled to the main room.
  console.log('  >>> host force-closes the rating window (Skip Ratings) <<<');
  hostSock.emit('host:force_close_rating', { sessionId });
  let after = 'round_rating';
  for (let i = 0; i < 15 && after === 'round_rating'; i++) { await wait(1000); after = await status(); }
  console.log('  event status after Skip Ratings:', after);
  expect(after, 'Skip Ratings must advance the event out of rating').not.toBe('round_rating');
  // m1 leaves the rating form for the main room.
  await expect.poll(async () => await ratingFormVisible(page), { timeout: 20_000, message: 'm1 should leave the rating form for the main room after Skip Ratings' }).toBe(false);
  await page.screenshot({ path: 'test-results/revert-2-back-to-main.png' }).catch(() => {});
  console.log('  ✓ m1 returned to the main room (rating form gone).');

  // THE BUG: a reconnect ("connected from another device — Rejoin here", or a
  // simple page reload) during ROUND_TRANSITION used to replay the closed
  // rating window and snap m1 back into the form. Reload now and assert it
  // does NOT come back, for a sustained window.
  console.log('  >>> reloading m1 (the reconnect that caused the revert) <<<');
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(6000);
  expect(page.url(), 'm1 must still be in the live room, not bounced').toContain('/live');
  for (let i = 0; i < 10; i++) {
    const reverted = await ratingFormVisible(page);
    expect(reverted, `m1 reverted to the rating form ${i}s after reconnect — the revert bug`).toBe(false);
    await wait(1000);
  }
  await page.screenshot({ path: 'test-results/revert-3-no-revert-after-reload.png' }).catch(() => {});
  console.log('  ✓ verified: after Skip Ratings + reconnect, m1 stayed in the main room — no revert.');

  await ctx.close();
});
