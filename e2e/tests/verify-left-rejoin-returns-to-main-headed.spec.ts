import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — Stefan's event (June-12): participants who got into
// a 'left' state (left-and-rejoin, or a stale leave after a network drop) were
// STUCK and never returned to the main room — the June-11 token gate barred
// their lobby token AND the resync evicted them to the recap. 'left' is
// RECOVERABLE in RSN. This opens a real participant browser, puts them into
// 'left', re-enters, and asserts they land back in the MAIN ROOM (not the recap).
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, part: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => { const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('socket timeout')), 10_000); });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: any, url: string) => { for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } } };
const partStatus = async (uid: string) => (await pool.query('SELECT status FROM session_participants WHERE session_id=$1 AND user_id=$2', [sessionId, uid])).rows[0]?.status;
const inMainRoom = async (page: any) => (await page.getByRole('button', { name: /Leave Event/i }).count().catch(() => 0)) > 0;
const onRecap = async (page: any) => (await page.getByText(/removed from this event|recap|people you met/i).count().catch(() => 0)) > 0;

test.beforeAll(async () => {
  host = await createTestUser('lrhost', 'super_admin');
  part = await createTestUser('lrpart');
  const pod = await createPod(host, 'E2E LeftRejoin Pod'); podId = pod.id;
  await addPodMember(host, podId, part.id);
  const sess = await createSession(host, podId, 'VERIFY left-rejoin returns to main', new Date(Date.now() + 60_000), { numberOfRounds: 3 });
  sessionId = sess.id;
  await registerForSession(part, sessionId);
  browser = await chromium.launch({ headless: false, slowMo: 300, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test("a participant in 'left' state re-enters and lands back in the MAIN ROOM (not the recap)", async () => {
  test.setTimeout(180_000);
  const hostSock = await connect(host); sockets.push(hostSock);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: part.accessToken, r: part.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> participant browser opening the live main room <<<');
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await page.waitForTimeout(4000);

  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  await page.reload().catch(() => {}); await wait(4000);
  await expect.poll(async () => await inMainRoom(page), { timeout: 20_000, message: 'participant should be in the main room first' }).toBe(true);
  console.log('  ✓ participant is in the main room.');

  // Put them into the recoverable 'left' state (this is what a leave-and-rejoin,
  // or a stale leave after a drop, produces — NOT a kick, which is 'removed').
  await pool.query("UPDATE session_participants SET status='left', left_at=NOW() WHERE session_id=$1 AND user_id=$2", [sessionId, part.id]);
  expect(await partStatus(part.id), "participant is now 'left'").toBe('left');
  console.log("  participant forced to 'left'; now RE-ENTERING the event...");

  // Re-enter the live page (reconnect → resync). On the bug, resync evicts them
  // to the recap and the token is denied; after the fix they recover to main.
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await expect.poll(async () => await inMainRoom(page), { timeout: 25_000, message: "a 'left' participant must recover into the MAIN ROOM on re-entry" }).toBe(true);
  // And they must NOT have been bounced to the recap.
  for (let i = 0; i < 8; i++) {
    expect(await inMainRoom(page), `participant should stay in the main room ${i}s after re-entry`).toBe(true);
    expect(await onRecap(page), `participant must NOT be on the recap ${i}s after re-entry`).toBe(false);
    await wait(1000);
  }
  await page.screenshot({ path: 'test-results/left-rejoin-main-room.png' }).catch(() => {});
  // The reconnect path should have reset them off 'left'.
  console.log('  participant status after re-entry:', await partStatus(part.id));
  await ctx.close();
  console.log("  ✓ verified: a 'left' participant recovers into the main room on re-entry — no stuck, no recap.");
});
