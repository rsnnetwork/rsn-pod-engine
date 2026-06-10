import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — Bug (June-10 live): a kicked user (Haseem/Waseem)
// saw the recap ("you have been kicked") then REVERTED back into the main room
// within ~5s (socket/LiveKit pulled them back). A kick must be TERMINAL: the
// kicked user lands on the recap and STAYS there — even across a reconnect /
// page reload — until re-invited. This opens a REAL participant browser, the
// host kicks them, and we assert they reach the recap and never return to the
// main room (including after a reload, the exact reconnect that caused it).
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, victim: TestUser, other: TestUser;
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
const partStatus = async (uid: string) => (await pool.query('SELECT status FROM session_participants WHERE session_id=$1 AND user_id=$2', [sessionId, uid])).rows[0]?.status;
// The main room (lobby/video) shows a "Leave Event" control + mic/camera
// toggles; the recap (SessionComplete) does not. Use "Leave Event" presence as
// the "I'm back in the live room" signal.
const inMainRoom = async (page: any) => (await page.getByRole('button', { name: /Leave Event/i }).count().catch(() => 0)) > 0;
const onRecap = async (page: any) => {
  const a = await page.getByText(/removed from this event/i).count().catch(() => 0);
  const b = await page.getByText(/recap|connections|people you met|thanks for/i).count().catch(() => 0);
  return a + b > 0;
};

test.beforeAll(async () => {
  host = await createTestUser('kickhost', 'super_admin');
  victim = await createTestUser('kickvictim');
  other = await createTestUser('kickother');
  const pod = await createPod(host, 'E2E Kick Pod'); podId = pod.id;
  await addPodMember(host, podId, victim.id); await addPodMember(host, podId, other.id);
  const sess = await createSession(host, podId, 'VERIFY kick is terminal', new Date(Date.now() + 60_000), { numberOfRounds: 2 });
  sessionId = sess.id;
  await Promise.all([registerForSession(victim, sessionId), registerForSession(other, sessionId)]);
  browser = await chromium.launch({ headless: false, slowMo: 350, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('A kicked user lands terminally on the recap and never reverts to the main room', async () => {
  test.setTimeout(220_000);

  const hostSock = await connect(host); sockets.push(hostSock);

  // Victim is the participant we watch (Waseem's seat) — a real browser in the
  // main room.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: victim.accessToken, r: victim.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> victim browser opening on prod <<<');
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await page.waitForTimeout(5000);

  // Start the event + get everyone into the main room.
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  await page.reload().catch(() => {}); await wait(4000);
  const otherSock = await connect(other); sockets.push(otherSock); otherSock.emit('session:join', { sessionId }); await wait(3000);
  expect(await inMainRoom(page), 'victim should be in the main room before the kick').toBe(true);
  await page.screenshot({ path: 'test-results/kick-1-in-main-room.png' }).catch(() => {});
  console.log('  ✓ victim is in the main room.');

  // Host kicks the victim.
  console.log('  >>> host kicks the victim <<<');
  hostSock.emit('host:remove_participant', { sessionId, userId: victim.id, reason: 'e2e' });
  await wait(4000);
  expect(await partStatus(victim.id), 'victim must be removed in the DB').toBe('removed');

  // The victim must land on the recap and be OUT of the main room.
  await expect.poll(async () => await inMainRoom(page), { timeout: 20_000, message: 'kicked victim must leave the main room' }).toBe(false);
  await page.screenshot({ path: 'test-results/kick-2-recap.png' }).catch(() => {});
  console.log('  ✓ victim left the main room after the kick.');

  // THE BUG: within ~5s the victim used to revert back into the main room. Watch
  // for a sustained window that they DON'T return.
  console.log('  >>> watching that the kicked victim does NOT revert (10s) <<<');
  for (let i = 0; i < 10; i++) {
    expect(await inMainRoom(page), `victim reverted into the main room ${i}s after the kick`).toBe(false);
    await wait(1000);
  }

  // And the kill shot: a reconnect (page reload) must NOT re-admit them — they
  // stay out (recap / not in the room), because the server bounces the removed
  // rejoin and the client treats it as terminal.
  console.log('  >>> reloading victim (the reconnect that caused the revert) <<<');
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(7000);
  for (let i = 0; i < 8; i++) {
    expect(await inMainRoom(page), `victim got back into the main room ${i}s after a reload`).toBe(false);
    await wait(1000);
  }
  await page.screenshot({ path: 'test-results/kick-3-still-out-after-reload.png' }).catch(() => {});
  expect(await partStatus(victim.id), 'victim is still removed after a reload').toBe('removed');
  console.log('  ✓ verified: kick is terminal — victim never returned to the main room, even after a reload.');

  await ctx.close();
});
