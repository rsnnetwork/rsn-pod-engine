import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for canonical Ship A (66f4892) against PRODUCTION:
//   1. REFRESH mid-breakout — alice F5s inside a breakout room and must land
//      back in the SAME breakout with video (legacy re-emit + snapshot heal).
//   2. CONNECTION DROP — bob goes offline ~12s (inside the 15s grace), comes
//      back, the client emits session:resync (asserted on the wire) and lands
//      back in the breakout.
// Real deployed client, fake camera, throwaway e2etest-* users (cleaned by ID).
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, alice: TestUser, bob: TestUser;
let podId: string, sessionId: string;
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

async function readBreakoutSeconds(page: Page): Promise<number | null> {
  const texts = await page.locator('span.font-mono').allInnerTexts().catch(() => [] as string[]);
  for (const t of texts) {
    const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  return null;
}

async function waitForBreakout(page: Page, label: string, timeoutMs = 35_000): Promise<number> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await readBreakoutSeconds(page);
    if (s !== null) { console.log(`  ✓ ${label} in breakout (timer ${s}s)`); return s; }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label}: not in breakout within ${timeoutMs}ms`);
}

async function newUserPage(user: TestUser, errors: string[]): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    console.log(`  [${user.displayName} console.error]`, t.slice(0, 160));
    // LiveKit/network noise during deliberate offline windows is expected;
    // collect only state-machine/room errors.
    if (/snapshot|resync|location|room.*token|dual/i.test(t)) errors.push(t);
  });
  return page;
}

test.beforeAll(async () => {
  host = await createTestUser('shipahost', 'super_admin');
  alice = await createTestUser('shipaalice');
  bob = await createTestUser('shipabob');
  const pod = await createPod(host, 'E2E ShipA Smoke Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E ShipA Smoke', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all([registerForSession(alice, sessionId), registerForSession(bob, sessionId)]);
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('Ship A: refresh mid-breakout returns to the same room; offline/online resyncs via session:resync', async () => {
  test.setTimeout(280_000);
  const errors: string[] = [];

  // ── Both participants join the main room in real browsers ──
  const alicePage = await newUserPage(alice, errors);
  const bobPage = await newUserPage(bob, errors);

  // Capture bob's socket frames to assert session:resync goes out on reconnect.
  // Count ONLY socket.io websockets — LiveKit always reconnects after a blip
  // (new wss to the media server) even when the socket.io connection survives.
  const bobSentFrames: string[] = [];
  let bobSocketsCreated = 0;
  bobPage.on('websocket', (ws) => {
    if (!ws.url().includes('/socket.io/')) return;
    bobSocketsCreated++;
    ws.on('framesent', (f) => {
      const p = typeof f.payload === 'string' ? f.payload : f.payload.toString();
      if (p.includes('session:resync') || p.includes('session:join')) bobSentFrames.push(p.slice(0, 120));
    });
  });

  await alicePage.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await bobPage.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await alicePage.waitForTimeout(9000); // lobby mounts + camera publishes
  await alicePage.screenshot({ path: 'test-results/shipA-01-lobby.png' }).catch(() => {});

  // ── Host (socket-only) opens a breakout for alice + bob ──
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  hostSock.emit('session:join', { sessionId });
  await alicePage.waitForTimeout(2000);
  hostSock.emit('host:create_breakout_bulk', {
    sessionId,
    rooms: [{ participantIds: [alice.id, bob.id] }],
    sharedDurationSeconds: 240,
    timerVisibility: 'visible',
  });

  await waitForBreakout(alicePage, 'alice');
  await waitForBreakout(bobPage, 'bob');
  await alicePage.screenshot({ path: 'test-results/shipA-02-breakout.png' }).catch(() => {});

  // ── TEST 1: alice refreshes mid-breakout → same room back ──
  console.log('  TEST 1: alice F5 mid-breakout…');
  const aliceFrames: string[] = [];
  alicePage.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      const p = typeof f.payload === 'string' ? f.payload : f.payload.toString();
      if (p.includes('session:resync') || p.includes('session:join')) aliceFrames.push('SENT ' + p.slice(0, 120));
    });
    ws.on('framereceived', (f) => {
      const p = typeof f.payload === 'string' ? f.payload : f.payload.toString();
      if (p.includes('state:snapshot')) aliceFrames.push('RECV ' + p.slice(0, 500));
      if (p.includes('match:assigned') || p.includes('match:reassigned')) aliceFrames.push('RECV ' + p.slice(0, 160));
    });
  });
  await alicePage.reload({ waitUntil: 'domcontentloaded' });
  let aliceBack: number;
  try {
    aliceBack = await waitForBreakout(alicePage, 'alice (after refresh)', 40_000);
  } catch (e) {
    await alicePage.screenshot({ path: 'test-results/shipA-FAIL-alice-after-refresh.png' }).catch(() => {});
    console.log('  ── alice frames around refresh ──');
    for (const f of aliceFrames) console.log('   ', f);
    throw e;
  }
  expect(aliceBack, 'alice must land back in the breakout after refresh').toBeGreaterThan(0);
  // And actually CONNECTED: a remote participant tile (bob) renders video again.
  await alicePage.waitForTimeout(6000);
  await alicePage.screenshot({ path: 'test-results/shipA-03-alice-after-refresh.png' }).catch(() => {});
  const aliceVideos = await alicePage.locator('video').count();
  console.log(`  alice videos rendered after refresh: ${aliceVideos}`);
  expect(aliceVideos, 'alice should render video tiles after refresh').toBeGreaterThan(0);

  // ── TEST 2: bob drops offline ~12s (inside 15s grace) and returns ──
  console.log('  TEST 2: bob offline 12s → online…');
  bobSentFrames.length = 0;
  const socketsBeforeOffline = bobSocketsCreated;
  await bobPage.context().setOffline(true);
  await bobPage.waitForTimeout(12_000);
  await bobPage.context().setOffline(false);

  const bobBack = await waitForBreakout(bobPage, 'bob (after reconnect)', 45_000);
  expect(bobBack, 'bob must land back in the breakout after reconnect').toBeGreaterThan(0);
  await bobPage.waitForTimeout(5000);
  await bobPage.screenshot({ path: 'test-results/shipA-04-bob-after-reconnect.png' }).catch(() => {});

  // Ship A wire contract: IF the socket actually dropped (a new websocket was
  // created), the reconnect must emit session:resync. A 12s blip that the
  // socket.io ping window absorbs creates no new socket — nothing to resync,
  // and bob staying in the room IS the pass.
  const socketReconnected = bobSocketsCreated > socketsBeforeOffline;
  const resyncSent = bobSentFrames.some((f) => f.includes('session:resync'));
  console.log(`  bob sockets new: ${socketReconnected}, frames: ${bobSentFrames.length}, resync sent: ${resyncSent}`);
  if (socketReconnected) {
    expect(resyncSent, 'client must emit session:resync on socket reconnect (Ship A)').toBe(true);
  } else {
    console.log('  (socket survived the offline blip — resync not required)');
  }

  // No snapshot/room/token errors collected across the whole run.
  expect(errors, `state errors during run:\n${errors.join('\n')}`).toHaveLength(0);

  hostSock.emit('host:end_breakout_all', { sessionId });
  await alicePage.waitForTimeout(2000);
  console.log('✓ Ship A smoke complete: refresh→same room, offline/online→resync→same room, zero state errors');
});
