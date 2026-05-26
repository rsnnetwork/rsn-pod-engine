import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, pool, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED browser proof of the breakout->rating transition on the DEPLOYED client.
// The old "rating timer flashes 158 then 43" flicker was fixed at the ROOT by
// REMOVING the rating countdown entirely (06a8e79, Ali's decision — the user fills
// the rating form at their own pace). So the assertion flipped: alice sits in a
// manual breakout, the host ends all rooms, alice is routed to the rating FORM,
// and we assert the form opens and NO countdown pill ever renders — there is no
// rating timer left to clobber, so the flicker is structurally impossible.

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

test('real browser: rating form opens after a breakout ends with NO countdown (flicker structurally impossible)', async () => {
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

  // The rating FORM must appear. The rating phase intentionally shows NO countdown
  // (removed in 06a8e79 — the user rates at their own pace), so the old
  // "rating pill flickers 158->43" failure mode is now structurally impossible:
  // there is no rating timer to be clobbered by a leftover breakout tick.
  const ratingHeading = page.getByText('Rate your conversation', { exact: false });
  await expect(ratingHeading).toBeVisible({ timeout: 20_000 });
  console.log('  rating form opened (no countdown — by design)');

  // Regression guard: no "Ns" rating-countdown pill should EVER render during the
  // rating phase. Sample repeatedly to catch any pill that might flash in.
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1500);
    const pill = await readRatingSeconds(page);
    expect(pill, `rating phase must show NO countdown pill (saw ${pill}s)`).toBeNull();
  }
  console.log('✓ rating form steady, zero countdown rendered — no timer left to flicker');

  await context.close();
});
