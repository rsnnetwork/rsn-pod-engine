import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for canonical Ship B (087ba44) + the room-end location fix
// (9a496c2) against PRODUCTION. Covers the 4-Jun live-test regression:
//   1. ALGORITHM round full cycle — generate → start → both in breakout →
//      host ends round → both return to main and are NOT pulled back into
//      the dead room over a 75s observation window (pre-fix the snapshot/
//      resync wire re-pulled them ~10-30s after round end).
//   2. MANUAL breakout — room-scope chat reaches the roommate but NOT the
//      host in main (Ship B canonical-location chat routing), then
//      end-all → no ghost re-pull over 45s.
//   3. VOLUNTARY LEAVE mid-room — leaver returns to main and stays out
//      (leave-conversation canonical clear).
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

async function waitForMain(page: Page, label: string, timeoutMs = 45_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let clearStreak = 0;
  while (Date.now() < end) {
    if (!(await inBreakout(page))) {
      clearStreak++;
      if (clearStreak >= 3) { console.log(`  ✓ ${label} back in main room`); return; }
    } else clearStreak = 0;
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label}: did not return to main room within ${timeoutMs}ms`);
}

/** THE regression assertion: nobody gets pulled back into a dead room. */
async function assertNoGhostRePull(
  pages: { page: Page; label: string }[],
  durationMs: number,
  tag: string,
): Promise<void> {
  console.log(`  observing ${Math.round(durationMs / 1000)}s for ghost re-pull (${tag})…`);
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    for (const { page, label } of pages) {
      if (await inBreakout(page)) {
        await page.screenshot({ path: `test-results/shipB-GHOST-${tag}-${label}.png` }).catch(() => {});
        throw new Error(`GHOST RE-PULL (${tag}): ${label} re-entered a dead breakout room`);
      }
    }
    await pages[0].page.waitForTimeout(3000);
  }
  console.log(`  ✓ no ghost re-pull during ${tag} window`);
}

/**
 * Click the rating form for real (5th star → Submit). Also guards the
 * "overlay rendered but un-clickable" bug class (transform-trapped modals).
 */
async function submitRatingIfPresent(page: Page, label: string): Promise<boolean> {
  const form = page.locator('div:has(> h2:has-text("Rate your conversation"))').first();
  if (!(await form.isVisible({ timeout: 8000 }).catch(() => false))) return false;
  await form.locator('button').nth(4).click({ timeout: 5000 }); // 5th star
  const submit = page.getByRole('button', { name: 'Submit Rating' });
  await submit.click({ timeout: 5000 });
  console.log(`  ✓ ${label} submitted a 5-star rating through the real form`);
  return true;
}

const chatFrames: string[] = []; // wire-level chat evidence across all pages

async function newUserPage(user: TestUser, errors: string[]): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      const p = typeof f.payload === 'string' ? f.payload : f.payload.toString();
      if (p.includes('chat:send')) chatFrames.push(`${user.displayName} SENT ${p.slice(0, 250)}`);
    });
    ws.on('framereceived', (f) => {
      const p = typeof f.payload === 'string' ? f.payload : f.payload.toString();
      if (p.includes('chat:message')) chatFrames.push(`${user.displayName} RECV ${p.slice(0, 250)}`);
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
  host = await createTestUser('shipbhost', 'super_admin');
  alice = await createTestUser('shipbalice');
  bob = await createTestUser('shipbbob');
  const pod = await createPod(host, 'E2E ShipB Smoke Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E ShipB Smoke', new Date(Date.now() + 60_000));
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

test('Ship B: round end + manual end + leave never ghost-pull; room chat stays room-scoped', async () => {
  test.setTimeout(600_000);
  const errors: string[] = [];

  const alicePage = await newUserPage(alice, errors);
  const bobPage = await newUserPage(bob, errors);
  await alicePage.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await bobPage.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await alicePage.waitForTimeout(9000); // lobby mounts + camera publishes

  const hostSock = await connectSocket(host);
  hostSock.on('error', (e: any) => console.log('  [host socket error]', JSON.stringify(e).slice(0, 200)));
  hostSock.emit('session:join', { sessionId });
  await alicePage.waitForTimeout(2000);

  // ── TEST 1: algorithm round — generate → start → end → NO ghost (the 4-Jun repro) ──
  console.log('  TEST 1: algorithm round cycle…');
  hostSock.emit('host:generate_matches', { sessionId });
  await alicePage.waitForTimeout(6000); // engine + preview
  hostSock.emit('host:confirm_round', { sessionId }); // = "Start Round"

  await waitForBreakout(alicePage, 'alice (round 1)');
  await waitForBreakout(bobPage, 'bob (round 1)');
  await alicePage.screenshot({ path: 'test-results/shipB-01-round-active.png' }).catch(() => {});

  hostSock.emit('host:end_session', { sessionId }); // = "End Round" (no endEvent flag)
  await waitForMain(alicePage, 'alice (after round end)');
  await waitForMain(bobPage, 'bob (after round end)');
  await alicePage.screenshot({ path: 'test-results/shipB-02-back-in-main.png' }).catch(() => {});

  // Rate through the REAL form on both sides — asserts the rating overlay is
  // actually clickable (catches transform-trapped modal regressions) and
  // exercises the rating dedup path end-to-end.
  const aliceRated = await submitRatingIfPresent(alicePage, 'alice');
  const bobRated = await submitRatingIfPresent(bobPage, 'bob');
  expect(aliceRated || bobRated, 'at least one rating form must appear and be clickable after round end').toBe(true);

  // Pre-fix, the stale canonical location re-pulled clients ~10-30s after
  // round end (10s client guard + snapshot/resync cadence). 75s covers the
  // guard expiry, several co-emit cycles AND the 30s REST resync net.
  await assertNoGhostRePull(
    [{ page: alicePage, label: 'alice' }, { page: bobPage, label: 'bob' }],
    75_000, 'round-end',
  );

  // ── TEST 2: manual breakout — room chat scoping, then end-all → NO ghost ──
  console.log('  TEST 2: manual breakout + chat scoping…');
  hostSock.emit('host:create_breakout_bulk', {
    sessionId,
    rooms: [{ participantIds: [alice.id, bob.id] }],
    sharedDurationSeconds: 300,
    timerVisibility: 'visible',
  });
  await waitForBreakout(alicePage, 'alice (manual room)');
  await waitForBreakout(bobPage, 'bob (manual room)');

  // Ship B chat routing: alice sends a room-scope message THROUGH THE REAL
  // CHAT UI; bob (same canonical room) must see it in HIS chat UI; the host
  // (in main) must NOT receive it (asserted on the host listener socket).
  const hostGot: string[] = [];
  hostSock.on('chat:message', (m: any) => hostGot.push(m?.message));
  const probe = `room-scope-probe-${Date.now()}`;

  await alicePage.locator('[aria-label="Open chat"]').click({ timeout: 10_000 });
  const aliceInput = alicePage.locator('input[placeholder="Message your room..."], textarea[placeholder="Message your room..."]').first();
  await aliceInput.fill(probe, { timeout: 10_000 });
  await aliceInput.press('Enter');
  console.log('  alice sent room-scope message through the chat UI');

  await bobPage.locator('[aria-label="Open chat"]').click({ timeout: 10_000 });
  await bobPage.waitForTimeout(8000);
  console.log('  ── chat wire evidence ──');
  for (const f of chatFrames.filter((x) => x.includes(probe) || x.includes('chat:send'))) console.log('   ', f);
  await expect(bobPage.getByText(probe), 'bob (roommate) must see the room-scope message in his chat UI')
    .toBeVisible({ timeout: 7_000 });
  expect(hostGot, 'host (main room) must NOT receive the room-scope message').not.toContain(probe);
  console.log('  ✓ room chat scoped: bob sees it in the UI, host did not receive it');

  hostSock.emit('host:end_breakout_all', { sessionId });
  await waitForMain(alicePage, 'alice (after end-all)');
  await waitForMain(bobPage, 'bob (after end-all)');
  await assertNoGhostRePull(
    [{ page: alicePage, label: 'alice' }, { page: bobPage, label: 'bob' }],
    45_000, 'manual-end-all',
  );

  // ── TEST 3: voluntary leave mid-room — leaver stays out ──
  console.log(`  TEST 3: voluntary leave mid-room… (hostSock.connected=${hostSock.connected})`);
  // Long-lived sockets with reconnection:false can silently die mid-run —
  // use a fresh host socket for the final room so the emit can't be lost.
  const hostSock2 = hostSock.connected ? hostSock : await connectSocket(host);
  if (hostSock2 !== hostSock) {
    hostSock2.on('error', (e: any) => console.log('  [host2 socket error]', JSON.stringify(e).slice(0, 160)));
    hostSock2.emit('session:join', { sessionId });
    await alicePage.waitForTimeout(2000);
  }
  hostSock2.emit('host:create_breakout_bulk', {
    sessionId,
    rooms: [{ participantIds: [alice.id, bob.id] }],
    sharedDurationSeconds: 300,
    timerVisibility: 'visible',
  });
  await waitForBreakout(alicePage, 'alice (room 3)');
  await waitForBreakout(bobPage, 'bob (room 3)');

  // Leave through the REAL UI — the breakout header's "Main Room" button.
  await alicePage.locator('[title="Return to the main room"]').click({ timeout: 10_000 });
  await waitForMain(alicePage, 'alice (after leave)');
  await assertNoGhostRePull([{ page: alicePage, label: 'alice' }], 30_000, 'voluntary-leave');
  await alicePage.screenshot({ path: 'test-results/shipB-03-after-leave.png' }).catch(() => {});

  expect(errors, `state errors during run:\n${errors.join('\n')}`).toHaveLength(0);
  console.log('✓ Ship B smoke complete: no ghost re-pull (round end / end-all / leave), chat room-scoped, zero state errors');
});
