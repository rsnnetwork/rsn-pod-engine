import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for canonical Ship C (token cutover) against PRODUCTION.
// Asserts ON THE WIRE that the legacy token rail is gone while video still
// works end-to-end through the snapshot rail + REST fallback:
//   1. Lobby video connects WITHOUT any lobby:token frame (token must have
//      arrived via the resync/state:snapshot rail).
//   2. Algorithm round: match:assigned frames carry NO token/livekitUrl,
//      yet both participants' breakout video connects.
//   3. F5 mid-breakout still returns to the same room (resync rail).
//   4. End round → main room, no ghost re-pull (30s watch).
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, alice: TestUser, bob: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connectSocket(user: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: user.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => { sockets.push(s); resolve(s); });
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 10000);
  });
}

async function inBreakout(page: Page): Promise<boolean> {
  return (await page.locator('text=Breakout Room').count().catch(() => 0)) > 0;
}

async function waitForBreakout(page: Page, label: string, timeoutMs = 40_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await inBreakout(page)) { console.log(`  ✓ ${label} in breakout`); return; }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label}: not in breakout within ${timeoutMs}ms`);
}

async function waitForVideo(page: Page, label: string, timeoutMs = 30_000): Promise<number> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const n = await page.locator('video').count().catch(() => 0);
    if (n > 0) { console.log(`  ✓ ${label} video connected (${n} tiles)`); return n; }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label}: no video within ${timeoutMs}ms`);
}

const wire = { lobbyTokenFrames: 0, matchAssignedWithToken: 0, matchAssignedFrames: 0 };

async function newUserPage(user: TestUser, errors: string[]): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const p = typeof f.payload === 'string' ? f.payload : f.payload.toString();
      if (p.includes('"lobby:token"') || p.includes("['lobby:token'")) wire.lobbyTokenFrames++;
      if (p.includes('match:assigned')) {
        wire.matchAssignedFrames++;
        // the payload must not carry a token field
        if (/"token"\s*:\s*"e?[\w-]/.test(p)) wire.matchAssignedWithToken++;
      }
    });
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/snapshot|resync|location|room.*token|dual/i.test(t)) errors.push(`[${user.displayName}] ${t.slice(0, 200)}`);
  });
  return page;
}

test.beforeAll(async () => {
  host = await createTestUser('shipchost', 'super_admin');
  alice = await createTestUser('shipcalice');
  bob = await createTestUser('shipcbob');
  const pod = await createPod(host, 'E2E ShipC Smoke Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E ShipC Smoke', new Date(Date.now() + 60_000));
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

test('Ship C: snapshot rail carries every token — lobby + round video work with zero legacy token frames', async () => {
  test.setTimeout(420_000);
  const errors: string[] = [];

  // ── 1. Lobby video over the snapshot rail ──
  const alicePage = await newUserPage(alice, errors);
  const bobPage = await newUserPage(bob, errors);
  await alicePage.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await bobPage.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await waitForVideo(alicePage, 'alice (lobby)');
  await waitForVideo(bobPage, 'bob (lobby)');
  await alicePage.screenshot({ path: 'test-results/shipC-01-lobby-video.png' }).catch(() => {});

  // ── 2. Algorithm round — tokenless match:assigned, video still connects ──
  const hostSock = await connectSocket(host);
  hostSock.on('error', (e: any) => console.log('  [host socket error]', JSON.stringify(e).slice(0, 160)));
  hostSock.emit('session:join', { sessionId });
  await alicePage.waitForTimeout(2000);
  hostSock.emit('host:generate_matches', { sessionId });
  await alicePage.waitForTimeout(6000);
  hostSock.emit('host:confirm_round', { sessionId });

  await waitForBreakout(alicePage, 'alice (round)');
  await waitForBreakout(bobPage, 'bob (round)');
  await waitForVideo(alicePage, 'alice (breakout)');
  await waitForVideo(bobPage, 'bob (breakout)');
  await alicePage.screenshot({ path: 'test-results/shipC-02-breakout-video.png' }).catch(() => {});

  // ── 3. F5 mid-breakout — resync rail brings alice back with video ──
  console.log('  alice F5 mid-breakout…');
  await alicePage.reload({ waitUntil: 'domcontentloaded' });
  await waitForBreakout(alicePage, 'alice (after refresh)', 45_000);
  await waitForVideo(alicePage, 'alice (after refresh)', 35_000);

  // ── 4. End round → main, short ghost watch ──
  hostSock.emit('host:end_session', { sessionId });
  const end = Date.now() + 30_000;
  let backInMain = false;
  while (Date.now() < end) {
    if (!(await inBreakout(alicePage)) && !(await inBreakout(bobPage))) { backInMain = true; break; }
    await alicePage.waitForTimeout(2000);
  }
  expect(backInMain, 'both must return to main after round end').toBe(true);
  await alicePage.waitForTimeout(30_000); // ghost watch
  expect(await inBreakout(alicePage), 'alice must not be ghost-pulled').toBe(false);
  expect(await inBreakout(bobPage), 'bob must not be ghost-pulled').toBe(false);

  // ── Wire contract assertions ──
  console.log(`  wire: lobbyTokenFrames=${wire.lobbyTokenFrames} matchAssigned=${wire.matchAssignedFrames} withToken=${wire.matchAssignedWithToken}`);
  expect(wire.lobbyTokenFrames, 'no lobby:token frame may ever arrive (event retired)').toBe(0);
  expect(wire.matchAssignedFrames, 'match:assigned must still flow (lifecycle)').toBeGreaterThan(0);
  expect(wire.matchAssignedWithToken, 'match:assigned must NOT carry tokens').toBe(0);
  expect(errors, `state errors during run:\n${errors.join('\n')}`).toHaveLength(0);
  console.log('✓ Ship C smoke complete: all tokens via snapshot rail, zero legacy token frames, video everywhere');
});
