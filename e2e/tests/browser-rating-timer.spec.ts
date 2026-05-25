import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, pool, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED browser proof of the RATING timer across the breakout->rating transition
// (the "rating timer flashes 158 then 43" report). A real browser runs the deployed
// client: alice sits in a manual breakout, the host ends all rooms, alice is routed
// to the rating window, and we read the rating countdown pill ("Ns") over time and
// assert it ticks DOWN steadily — i.e. leftover breakout ticks no longer fight it.

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

// Breakout header reads as "M:SS"; the rating pill reads as "Ns". This returns the
// rating-pill seconds (only present on the rating screen), null otherwise.
async function readRatingSeconds(page: Page): Promise<number | null> {
  const texts = await page.locator('span').allInnerTexts().catch(() => [] as string[]);
  for (const t of texts) {
    const m = t.trim().match(/^(\d{1,3})s$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}
async function readBreakoutSeconds(page: Page): Promise<number | null> {
  const texts = await page.locator('span.font-mono').allInnerTexts().catch(() => [] as string[]);
  for (const t of texts) {
    const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  return null;
}

test.beforeAll(async () => {
  host = await createTestUser('rthost', 'super_admin');
  alice = await createTestUser('rtalice');
  bob = await createTestUser('rtbob');
  const pod = await createPod(host, 'E2E Rating Timer Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sched = new Date(Date.now() + 60_000);
  const sess = await createSession(host, podId, 'E2E Rating Timer Test', sched);
  sessionId = sess.id;
  await Promise.all([registerForSession(alice, sessionId), registerForSession(bob, sessionId)]);
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
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

test('real browser: rating timer after a breakout ends counts down steadily (no flicker)', async () => {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: alice.accessToken, r: alice.refreshToken });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [alice console.error]', m.text().slice(0, 140)); });

  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const hostSock = await connectSocket(host);
  const bobSock = await connectSocket(bob);
  sockets.push(hostSock, bobSock);
  hostSock.emit('session:join', { sessionId });
  bobSock.emit('session:join', { sessionId });
  await new Promise((r) => setTimeout(r, 2500));

  // Open a manual breakout with a visible 180s timer, then confirm alice is in it.
  hostSock.emit('host:create_breakout_bulk', {
    sessionId,
    rooms: [{ participantIds: [alice.id, bob.id] }],
    sharedDurationSeconds: 180,
    timerVisibility: 'visible',
  });
  let inBreakout: number | null = null;
  for (let i = 0; i < 20 && inBreakout === null; i++) {
    await page.waitForTimeout(1000);
    inBreakout = await readBreakoutSeconds(page);
  }
  expect(inBreakout, 'alice should be in the breakout first').not.toBeNull();
  console.log(`  alice in breakout at ${inBreakout}s`);

  // Host ends all manual rooms -> participants are routed to the rating window.
  hostSock.emit('host:end_breakout_all', { sessionId });

  // Wait for the rating pill ("Ns") to appear.
  let firstRating: number | null = null;
  for (let i = 0; i < 20 && firstRating === null; i++) {
    await page.waitForTimeout(1000);
    firstRating = await readRatingSeconds(page);
  }
  expect(firstRating, 'rating countdown pill should appear after the breakout ends').not.toBeNull();
  console.log(`  rating window opened at ${firstRating}s`);

  // Sample the rating countdown — it must only ever decrease (the flicker was an
  // upward jump). A breakout tick leaking in would show as a jump or a freeze.
  const readings: number[] = [firstRating!];
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(2000);
    const v = await readRatingSeconds(page);
    if (v !== null) readings.push(v);
  }
  console.log('  rating readings (s):', readings.join(' -> '));

  expect(readings.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < readings.length; i++) {
    expect(readings[i], `rating tick ${i} must not jump up`).toBeLessThanOrEqual(readings[i - 1] + 1);
  }
  expect(readings[readings.length - 1]).toBeLessThan(readings[0]);
  console.log('✓ rating countdown steady & monotonic after breakout end — no flicker');

  await context.close();
});
