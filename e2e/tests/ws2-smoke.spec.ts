import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for WS2 "nobody waits alone" against PRODUCTION.
//
// Round with 8 participants → 4 pairs (pairing read from host:match_preview):
//   pair1 — PHASE C: P1b closes the page; P1a sees "Waiting for your partner
//           to reconnect…" and does NOT self-eject (the old client auto-left
//           after 5s). P1b reopens as fast as the network allows. BOTH server
//           outcomes are valid and asserted coherently:
//             resumed — P1b back inside the grace → same breakout, P1a's
//                       banner clears;
//             ended   — the reopen outran the 15s grace (this uplink stalls
//                       under 8 video streams) → P1a gets the
//                       partner-no-return form, P1b gets the late-return
//                       form / main-room placement.
//   pair2 — PHASE B (strict): P2b closes and stays away >15s. P2a waits
//           (banner), then at expiry gets the "didn't return" form → skip →
//           main, and is NOT re-paired. P2b reopens while the round is still
//           active → "Rate your last conversation" (late_return).
//   pair3 — PHASE A (strict): P3a clicks the real "Main Room" button; the
//           survivor P3b gets the "didn't return" form IMMEDIATELY (no 15s
//           wait), P3a gets the early-leave form.
//   pair4 — untouched; keeps the round ROUND_ACTIVE through every phase so
//           no per-cause copy gets overlaid by a round-end broadcast.
//
// Real deployed client, fake camera, throwaway e2etest-* users (cleaned by ID).
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser;
let users: TestUser[] = [];
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

async function waitForBreakout(page: Page, label: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await readBreakoutSeconds(page)) !== null) { console.log(`  ✓ ${label} in breakout`); return; }
    await page.waitForTimeout(1500);
  }
  throw new Error(`${label}: not in breakout within ${timeoutMs}ms`);
}

async function waitForText(page: Page, re: RegExp, label: string, timeoutMs: number): Promise<void> {
  await expect(page.getByText(re).first(), label).toBeVisible({ timeout: timeoutMs });
  console.log(`  ✓ ${label}`);
}

// Navigation rides out transient uplink stalls (8 fake-video publishers
// saturate this machine's connection): 'commit' resolves as soon as the
// response starts; the breakout/banner waits poll the app state themselves.
async function gotoLive(page: Page): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 45_000 });
      return;
    } catch (e) {
      console.log(`  goto attempt ${i} failed: ${(e as Error).message.slice(0, 90)}`);
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
  // The "Main Room" leave button uses window.confirm — auto-accept.
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoLive(page);
  return { context, page };
}

// "Browser close" simulation: closing just the PAGE sends a clean websocket
// FIN (server disconnect fires immediately) while the context — HTTP cache +
// localStorage tokens — survives, so the reopened page boots warm.
// Reopened pages capture their rejoin wire so a failure says WHY.
async function reopenPage(entry: { context: BrowserContext; page: Page }, frames?: string[]): Promise<Page> {
  const page = await entry.context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  if (frames) {
    page.on('websocket', (ws) => {
      if (!ws.url().includes('/socket.io/')) return;
      ws.on('framesent', (f) => {
        const p = typeof f.payload === 'string' ? f.payload : f.payload.toString();
        if (/session:join|session:resync/.test(p)) frames.push('SENT ' + p.slice(0, 140));
      });
      ws.on('framereceived', (f) => {
        const p = typeof f.payload === 'string' ? f.payload : f.payload.toString();
        if (/match:assigned|rating:window_open|match:return_to_lobby/.test(p)) frames.push('RECV ' + p.slice(0, 220));
      });
    });
    page.on('console', (m) => { if (m.type() === 'error') frames.push('CONSOLE ' + m.text().slice(0, 160)); });
  }
  await gotoLive(page);
  entry.page = page;
  return page;
}

async function dumpPageState(page: Page, frames: string[], label: string): Promise<void> {
  await page.screenshot({ path: `test-results/ws2-FAIL-${label}.png` }).catch(() => {});
  console.log(`  ── ${label} frames ──`);
  for (const f of frames) console.log('   ', f);
  const bodyText = await page.locator('body').innerText().catch(() => '');
  console.log(`  ── ${label} page text (first 400) ──\n`, bodyText.slice(0, 400));
}

test.beforeAll(async () => {
  host = await createTestUser('ws2host', 'super_admin');
  users = await Promise.all(
    ['ws2p1', 'ws2p2', 'ws2p3', 'ws2p4', 'ws2p5', 'ws2p6', 'ws2p7', 'ws2p8'].map((n) => createTestUser(n)),
  );
  const pod = await createPod(host, 'E2E WS2 Smoke Pod');
  podId = pod.id;
  for (const u of users) await addPodMember(host, podId, u.id);
  const sess = await createSession(host, podId, 'E2E WS2 Smoke', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all(users.map((u) => registerForSession(u, sessionId)));
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Headed windows stack — without these the occluded ones get
      // background-throttled and their socket/LiveKit joins stall.
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

test('WS2: waiting banner + grace; expiry → survivor rates, late returner rates, no re-pair; deliberate leave → immediate survivor rating', async () => {
  test.setTimeout(540_000);

  // ── All 8 participants join the main room ──
  const sessions = new Map<string, { context: BrowserContext; page: Page }>();
  for (const u of users) sessions.set(u.id, await openUserPage(u));
  await sessions.get(users[0].id)!.page.waitForTimeout(9000); // lobby mounts + cameras publish

  // ── Host starts a real algorithm round; read the pairing from the preview ──
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  let latestPairs: Array<{ a: string; b: string }> = [];
  hostSock.on('host:match_preview', (data: any) => {
    latestPairs = (data?.matches || []).map((m: any) => ({ a: m.participantA?.userId, b: m.participantB?.userId }));
  });
  hostSock.emit('session:join', { sessionId });
  await sessions.get(users[0].id)!.page.waitForTimeout(2000);

  // Matching is presence-gated (Phase 1a): slow-booting pages aren't eligible
  // yet. Regenerate the preview until all 8 present → 4 pairs (max ~80s).
  let pairs: Array<{ a: string; b: string }> = [];
  for (let attempt = 1; attempt <= 10; attempt++) {
    latestPairs = [];
    hostSock.emit('host:generate_matches', { sessionId });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && latestPairs.length === 0) {
      await sessions.get(users[0].id)!.page.waitForTimeout(500);
    }
    console.log(`  preview attempt ${attempt}: ${latestPairs.length} pairs`);
    if (latestPairs.length === 4) { pairs = latestPairs; break; }
    await sessions.get(users[0].id)!.page.waitForTimeout(4000); // let stragglers finish booting
  }
  console.log('  pairs:', JSON.stringify(pairs));
  expect(pairs.length, '8 participants must yield 4 pairs (after presence settles)').toBe(4);
  hostSock.emit('host:confirm_round', { sessionId });

  const byId = (id: string) => users.find((u) => u.id === id)!;
  const P1a = byId(pairs[0].a), P1b = byId(pairs[0].b);
  const P2a = byId(pairs[1].a), P2b = byId(pairs[1].b);
  const P3a = byId(pairs[2].a), P3b = byId(pairs[2].b);

  for (const u of users) await waitForBreakout(sessions.get(u.id)!.page, u.displayName, 120_000);
  await sessions.get(P1a.id)!.page.screenshot({ path: 'test-results/ws2-01-breakout.png' }).catch(() => {});

  // ── PHASE C: page close + return — banner shows, NO self-eject, coherent outcome ──
  console.log('  PHASE C: P1b closes the page, returns as fast as the uplink allows…');
  const p1aPage = sessions.get(P1a.id)!.page;
  const p1aBannerShown = expect(
    p1aPage.getByText(/Waiting for your partner to reconnect/i).first(),
    'P1a sees waiting banner',
  ).toBeVisible({ timeout: 20_000 });
  await sessions.get(P1b.id)!.page.close(); // clean FIN → server disconnect fires now
  await p1aBannerShown;
  console.log('  ✓ P1a sees waiting banner');
  await p1aPage.screenshot({ path: 'test-results/ws2-02-waiting-banner.png' }).catch(() => {});
  const p1bPage = await reopenPage(sessions.get(P1b.id)!);

  // Outcome is timing-dependent on this uplink — both are correct; assert coherence.
  let p1Outcome: 'resumed' | 'ended' | null = null;
  {
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline && p1Outcome === null) {
      if ((await readBreakoutSeconds(p1bPage)) !== null) { p1Outcome = 'resumed'; break; }
      const lateForm = await p1bPage.getByText(/Rate your last conversation/i).first().isVisible().catch(() => false);
      const p1aForm = await p1aPage.getByText(/didn.t return/i).first().isVisible().catch(() => false);
      if (lateForm || p1aForm) { p1Outcome = 'ended'; break; }
      await p1bPage.waitForTimeout(1500);
    }
  }
  console.log(`  PHASE C outcome: ${p1Outcome}`);
  expect(p1Outcome, 'P1b must either resume the room or land in the ended flow').not.toBeNull();
  if (p1Outcome === 'resumed') {
    // Banner clears (match:partner_reconnected on rejoin); P1a still in room (no self-eject).
    await expect(p1aPage.getByText(/Waiting for your partner to reconnect/i), 'P1a banner clears after partner returns')
      .toHaveCount(0, { timeout: 30_000 });
    expect(await readBreakoutSeconds(p1aPage), 'P1a must still be in the breakout (no self-eject)').not.toBeNull();
  } else {
    // Grace expired while the reopen crawled: survivor gets the form, both land in main.
    await waitForText(p1aPage, /didn.t return/i, 'P1a gets the partner-no-return form (grace expired)', 40_000);
    await p1aPage.getByText('Skip', { exact: true }).first().click().catch(() => {});
  }
  console.log('  ✓ PHASE C complete');

  // ── PHASE B (strict): close >15s → survivor rates at expiry; late returner rates on rejoin ──
  console.log('  PHASE B: P2b closes the page and stays away >15s…');
  const p2aPage = sessions.get(P2a.id)!.page;
  const p2aBannerShown = expect(
    p2aPage.getByText(/Waiting for your partner to reconnect/i).first(),
    'P2a sees waiting banner',
  ).toBeVisible({ timeout: 20_000 });
  await sessions.get(P2b.id)!.page.close();
  await p2aBannerShown;
  console.log('  ✓ P2a sees waiting banner');
  await waitForText(p2aPage, /didn.t return/i, 'P2a gets the partner-no-return rating form', 40_000);
  await p2aPage.screenshot({ path: 'test-results/ws2-03-survivor-rating.png' }).catch(() => {});
  await p2aPage.getByText('Skip', { exact: true }).first().click().catch(() => {});
  await p2aPage.waitForTimeout(3000);
  expect(await readBreakoutSeconds(p2aPage), 'P2a must be OUT of the breakout after rating').toBeNull();
  // No re-pairing: P2a must stay in the main room, not land in a new breakout.
  await p2aPage.waitForTimeout(8000);
  expect(await readBreakoutSeconds(p2aPage), 'P2a must NOT be re-paired into a new room').toBeNull();

  console.log('  PHASE B2: P2b returns after the grace…');
  const p2bFrames: string[] = [];
  const p2bPage = await reopenPage(sessions.get(P2b.id)!, p2bFrames);
  try {
    await waitForText(p2bPage, /Rate your last conversation/i, 'P2b gets the late-return rating form', 90_000);
  } catch (e) {
    await dumpPageState(p2bPage, p2bFrames, 'p2b-late-return');
    throw e;
  }
  await p2bPage.screenshot({ path: 'test-results/ws2-04-late-return-rating.png' }).catch(() => {});
  await p2bPage.getByText('Skip', { exact: true }).first().click().catch(() => {});
  await p2bPage.waitForTimeout(3000);
  expect(await readBreakoutSeconds(p2bPage), 'P2b lands in main room after late-return rating').toBeNull();
  console.log('  ✓ PHASE B complete: survivor rated at expiry, late returner rated on rejoin');

  // ── PHASE A (strict): deliberate "Main Room" click → survivor rates IMMEDIATELY ──
  console.log('  PHASE A: P3a clicks Main Room…');
  const p3aPage = sessions.get(P3a.id)!.page;
  const p3bPage = sessions.get(P3b.id)!.page;
  const t0 = Date.now();
  await p3aPage.getByText('Main Room', { exact: true }).first().click();
  // The leaver gets their own early-leave form.
  await waitForText(p3aPage, /Rate your conversation/i, 'P3a (leaver) gets the early-leave rating form', 15_000);
  // The survivor's room ends NOW — no waiting banner, no 15s wait.
  await waitForText(p3bPage, /didn.t return/i, 'P3b (survivor) gets the rating form immediately', 12_000);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`  survivor form appeared ${elapsed}s after the click`);
  expect(elapsed, 'survivor form must appear well before the old 15s grace').toBeLessThan(14);
  await p3bPage.screenshot({ path: 'test-results/ws2-05-immediate-survivor-rating.png' }).catch(() => {});

  console.log('✓ WS2 smoke complete: banner+grace coherent, expiry→rating→no-re-pair, late-return form, immediate deliberate-leave end');
});
