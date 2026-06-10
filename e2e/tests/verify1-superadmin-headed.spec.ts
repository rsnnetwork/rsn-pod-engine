import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — FIX #1: a super_admin is NEVER matched into a
// breakout, even after a late-joiner repair. A real browser opens as the
// non-director super_admin (sadmin); you watch them stay in the main room while
// the members get paired into breakouts. DB assertion backs the visual.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, sadmin: TestUser, m1: TestUser, m2: TestUser, late: TestUser;
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

test.beforeAll(async () => {
  host = await createTestUser('v1host', 'super_admin');
  sadmin = await createTestUser('v1sadmin', 'super_admin'); // non-director super_admin — must NEVER be matched
  m1 = await createTestUser('v1m1');
  m2 = await createTestUser('v1m2');
  late = await createTestUser('v1late');
  const pod = await createPod(host, 'E2E Verify1 Pod'); podId = pod.id;
  for (const u of [sadmin, m1, m2, late]) await addPodMember(host, podId, u.id);
  const sess = await createSession(host, podId, 'VERIFY #1 super_admin', new Date(Date.now() + 60_000), { numberOfRounds: 3 });
  sessionId = sess.id;
  await Promise.all([sadmin, m1, m2].map(u => registerForSession(u, sessionId)));
  browser = await chromium.launch({ headless: false, slowMo: 400, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

const sadminMatchCount = async () => (await pool.query(
  `SELECT COUNT(*)::int c FROM matches WHERE session_id=$1 AND (participant_a_id=$2 OR participant_b_id=$2 OR participant_c_id=$2)`,
  [sessionId, sadmin.id])).rows[0].c;

test('FIX #1: a present super_admin is never matched into a breakout (+ late-joiner repair)', async () => {
  test.setTimeout(180_000);

  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  const m1s = await connect(m1); sockets.push(m1s); m1s.emit('session:join', { sessionId });
  const m2s = await connect(m2); sockets.push(m2s); m2s.emit('session:join', { sessionId });

  // Real browser: the non-director super_admin joins and is visible to you.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: sadmin.accessToken, r: sadmin.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> super_admin browser opening on prod <<<');
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await page.waitForTimeout(7000);

  // Host runs a matching round.
  console.log('  host generating + starting round 1...');
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(7000);

  // The members are now in a breakout; the super_admin must still be in the main room.
  await page.screenshot({ path: 'test-results/verify1-superadmin-mainroom.png' }).catch(() => {});
  expect(await sadminMatchCount(), 'super_admin must be in ZERO matches after round 1').toBe(0);
  // The super_admin's page must NOT have entered the breakout (matched) view.
  const inBreakout = await page.getByRole('button', { name: /Back to Main Room|Leave Conversation/i }).count().catch(() => 0);
  console.log(`  super_admin in-breakout UI elements: ${inBreakout} (expect 0) | matches: 0`);
  expect(inBreakout, 'super_admin must NOT be in a breakout room').toBe(0);

  // EDGE CASE — a late joiner triggers repairFutureRounds; super_admin must STILL be excluded.
  console.log('  EDGE: late joiner arrives → repair → super_admin must stay excluded...');
  await registerForSession(late, sessionId);
  const ls = await connect(late); sockets.push(ls); ls.emit('session:join', { sessionId });
  await wait(9000);
  expect(await sadminMatchCount(), 'super_admin still in ZERO matches after the late-joiner repair').toBe(0);
  await page.waitForTimeout(4000);

  await ctx.close();
  console.log('  ✓ FIX #1 verified headed on prod: super_admin stayed in the main room, 0 matches, through a repair.');
});
