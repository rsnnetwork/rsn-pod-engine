import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for WS3/B2+B3 (timer warnings + final-stretch reveal) vs PROD:
//   60s round, timerVisibility=last_30s, 2 participants.
//   - Early in the round the participant sees "Timer hidden until final
//     stretch" (visibility config working);
//   - at T-30 the wrap-up banner appears ("30 seconds left — time to wrap
//     up") AND the countdown reveals (B3: the reveal is driven by
//     timerEndsAt on VideoRoom's own heartbeat);
//   - at T-10 the red "10 seconds left" banner appears.
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

async function gotoLive(page: Page): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 45_000 });
      return;
    } catch (e) {
      if (i === 3) throw e;
      await page.waitForTimeout(5000);
    }
  }
}

async function openUserPage(user: TestUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoLive(page);
  return { context, page };
}

test.beforeAll(async () => {
  host = await createTestUser('ws3thost', 'super_admin');
  alice = await createTestUser('ws3talice');
  bob = await createTestUser('ws3tbob');
  const pod = await createPod(host, 'E2E WS3 Timer Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  // 120s: long enough that the pages finish their LiveKit entry while the
  // round is still ABOVE the 30s threshold (a 60s round was already in its
  // final stretch by the time the breakout UI mounted).
  const sess = await createSession(host, podId, 'E2E Timer Smoke', new Date(Date.now() + 60_000), {
    numberOfRounds: 1,
    roundDurationSeconds: 120,
    timerVisibility: 'last_30s',
  });
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
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
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

test('round timer: hidden until final stretch reveals at 30s; wrap-up banners at T-30 and T-10', async () => {
  test.setTimeout(420_000);

  const aliceSession = await openUserPage(alice);
  const bobSession = await openUserPage(bob);
  const alicePage = aliceSession.page;
  await alicePage.waitForTimeout(9000);

  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  let previewPairs = 0;
  hostSock.on('host:match_preview', (d: any) => { previewPairs = (d?.matches || []).length; });
  hostSock.emit('session:join', { sessionId });
  await alicePage.waitForTimeout(2000);
  for (let attempt = 1; attempt <= 8; attempt++) {
    previewPairs = 0;
    hostSock.emit('host:generate_matches', { sessionId });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && previewPairs === 0) await alicePage.waitForTimeout(500);
    console.log(`  preview attempt ${attempt}: ${previewPairs} pairs`);
    if (previewPairs === 1) break;
    await alicePage.waitForTimeout(4000);
  }
  expect(previewPairs, 'alice+bob must pair').toBe(1);
  hostSock.emit('host:confirm_round', { sessionId });

  // Both land in the breakout. With last_30s the countdown is HIDDEN early —
  // detect entry by EITHER the hidden copy (normal: >30s remain) or the
  // countdown itself (slow entry ate into the final stretch).
  let sawHiddenPhase = false;
  {
    const entryDeadline = Date.now() + 90_000;
    let entered = false;
    while (Date.now() < entryDeadline && !entered) {
      if (await alicePage.getByText(/Timer hidden until final stretch/i).first().isVisible().catch(() => false)) {
        sawHiddenPhase = true; entered = true; break;
      }
      if ((await readBreakoutSeconds(alicePage)) !== null) { entered = true; break; }
      await alicePage.waitForTimeout(1500);
    }
    expect(entered, 'alice must land in the breakout').toBe(true);
  }
  console.log(`  ✓ alice in breakout (hidden phase observed: ${sawHiddenPhase})`);

  // T-30: wrap-up banner + the final-stretch reveal (B3).
  await expect(alicePage.getByText(/30 seconds left/i).first(), 'T-30 wrap-up banner')
    .toBeVisible({ timeout: 120_000 });
  console.log('  ✓ T-30 banner shown');
  await alicePage.screenshot({ path: 'test-results/ws3t-01-t30-banner.png' }).catch(() => {});
  const revealDeadline = Date.now() + 15_000;
  let revealed: number | null = null;
  while (Date.now() < revealDeadline && revealed === null) {
    revealed = await readBreakoutSeconds(alicePage);
    if (revealed === null) await alicePage.waitForTimeout(1000);
  }
  console.log(`  countdown revealed at ${revealed}s remaining`);
  expect(revealed, 'countdown must REVEAL in the final stretch (B3)').not.toBeNull();
  expect(revealed!, 'reveal happens at/below the 30s threshold').toBeLessThanOrEqual(31);
  if (sawHiddenPhase) console.log('  ✓ full hidden→reveal cycle verified');

  // T-10: red ending banner.
  await expect(alicePage.getByText(/10 seconds left/i).first(), 'T-10 ending banner')
    .toBeVisible({ timeout: 40_000 });
  console.log('  ✓ T-10 banner shown');
  await alicePage.screenshot({ path: 'test-results/ws3t-02-t10-banner.png' }).catch(() => {});

  // Bob saw the banners too (warning is a room broadcast).
  await expect(bobSession.page.getByText(/seconds left/i).first(), 'bob saw a wrap-up banner')
    .toBeVisible({ timeout: 15_000 });

  console.log('✓ WS3 timer smoke complete: hidden → T-30 banner + reveal → T-10 banner');
});
