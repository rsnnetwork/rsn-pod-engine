import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED browser proof of the F/G timer fix (25 May Ali). A real browser runs the
// DEPLOYED client (the self-healing recency gate). The host drives a manual breakout
// over a socket; we then read the breakout countdown in alice's browser over ~14s and
// assert it ticks DOWN steadily — never jumping upward (the flicker was 4:23<->8:23).
//
// Note: this loads prod app.rsn.network, so it can only use selectors that already
// ship there. Auth is injected via localStorage (rsn_access/rsn_refresh) — the app
// boots authenticated from those keys.

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

// Read the M:SS countdown from the breakout header (deployed markup:
// <span class="font-mono ...">{formatTime(timerSeconds)}</span>).
async function readTimerSeconds(page: Page): Promise<number | null> {
  const texts = await page.locator('span.font-mono').allInnerTexts().catch(() => [] as string[]);
  for (const t of texts) {
    const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  return null;
}

test.beforeAll(async () => {
  host = await createTestUser('bthost', 'super_admin');
  alice = await createTestUser('btalice');
  bob = await createTestUser('btbob');
  const pod = await createPod(host, 'E2E Browser Timer Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sched = new Date(Date.now() + 60_000);
  const sess = await createSession(host, podId, 'E2E Browser Timer Test', sched);
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

test('real browser: breakout countdown ticks down steadily (no flicker)', async () => {
  // alice joins in a real browser, authenticated via injected tokens.
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: alice.accessToken, r: alice.refreshToken });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [alice console.error]', m.text().slice(0, 160)); });

  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  // Give the app time to boot, authenticate, connect its socket and join the session.
  await page.waitForTimeout(6000);

  // bob present via socket so the breakout has both participants.
  const hostSock = await connectSocket(host);
  const bobSock = await connectSocket(bob);
  sockets.push(hostSock, bobSock);
  hostSock.emit('session:join', { sessionId });
  bobSock.emit('session:join', { sessionId });
  await new Promise((r) => setTimeout(r, 2500));

  // Host opens a manual breakout with a visible 180s timer.
  hostSock.emit('host:create_breakout_bulk', {
    sessionId,
    rooms: [{ participantIds: [alice.id, bob.id] }],
    sharedDurationSeconds: 180,
    timerVisibility: 'visible',
  });

  // Wait for alice's browser to enter the breakout and render a countdown.
  let first: number | null = null;
  for (let i = 0; i < 20 && first === null; i++) {
    await page.waitForTimeout(1000);
    first = await readTimerSeconds(page);
  }
  expect(first, 'breakout countdown should be visible in the browser').not.toBeNull();
  expect(first!).toBeGreaterThan(60);
  expect(first!).toBeLessThanOrEqual(180);

  // Sample the countdown for ~12s. The flicker showed as an UPWARD jump of minutes;
  // a healthy timer only ever decreases (allow 1s rounding noise).
  const readings: number[] = [first!];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    const v = await readTimerSeconds(page);
    if (v !== null) readings.push(v);
  }
  console.log('  timer readings (s):', readings.join(' -> '));

  expect(readings.length).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < readings.length; i++) {
    // never jump UP by more than 1s (rounding); the bug jumped up by minutes.
    expect(readings[i], `tick ${i} must not jump up`).toBeLessThanOrEqual(readings[i - 1] + 1);
  }
  // and it must have actually counted down over the window.
  expect(readings[readings.length - 1]).toBeLessThan(readings[0]);
  console.log('✓ breakout countdown steady & monotonic in a real browser — no flicker');

  await context.close();
});
