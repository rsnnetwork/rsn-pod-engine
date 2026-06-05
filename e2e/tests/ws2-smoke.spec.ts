import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for WS2 "nobody waits alone" against PRODUCTION:
//   Round with 4 participants → 2 pairs (pairing read from host:match_preview).
//   C. RESUME WITHIN GRACE — P1b closes the browser, partner P1a sees the
//      "Waiting for your partner to reconnect…" banner (and does NOT
//      self-eject — the old client auto-left after 5s); P1b reopens within
//      the 15s grace → lands back in the SAME breakout; P1a's banner clears.
//   B. GRACE EXPIRY + LATE RETURN — P2b closes the browser and stays away
//      >15s; P2a sees the banner, then at expiry gets the rating form with
//      the "didn't return" copy → skip → main room (NO re-pairing with
//      anyone). P2b reopens while the round is still active (pair1 still
//      talking) → gets "Rate your last conversation" (late_return) on rejoin.
//   A. DELIBERATE LEAVE — P1a clicks the real "Main Room" button; the
//      survivor P1b gets the "didn't return" rating form IMMEDIATELY (no
//      15s wait, no waiting banner), skips, lands in main.
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

async function openUserPage(user: TestUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  // The "Main Room" leave button uses window.confirm — auto-accept.
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

test.beforeAll(async () => {
  host = await createTestUser('ws2host', 'super_admin');
  users = await Promise.all(['ws2p1', 'ws2p2', 'ws2p3', 'ws2p4'].map((n) => createTestUser(n)));
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

test('WS2: resume within grace; grace expiry → survivor rates, late returner rates; deliberate leave → immediate survivor rating', async () => {
  test.setTimeout(420_000);

  // ── All 4 participants join the main room ──
  const sessions = new Map<string, { context: BrowserContext; page: Page }>();
  for (const u of users) sessions.set(u.id, await openUserPage(u));
  await sessions.get(users[0].id)!.page.waitForTimeout(9000); // lobby mounts + cameras publish

  // ── Host starts a real algorithm round; read the pairing from the preview ──
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  const previewPromise = new Promise<Array<{ a: string; b: string }>>((resolve, reject) => {
    hostSock.on('host:match_preview', (data: any) => {
      const pairs = (data?.matches || []).map((m: any) => ({ a: m.participantA?.userId, b: m.participantB?.userId }));
      if (pairs.length > 0) resolve(pairs);
    });
    setTimeout(() => reject(new Error('no match preview within 30s')), 30_000);
  });
  hostSock.emit('session:join', { sessionId });
  await sessions.get(users[0].id)!.page.waitForTimeout(2000);
  hostSock.emit('host:generate_matches', { sessionId });
  const pairs = await previewPromise;
  console.log('  pairs:', JSON.stringify(pairs));
  expect(pairs.length, '4 participants must yield 2 pairs').toBe(2);
  hostSock.emit('host:confirm_round', { sessionId });

  const byId = (id: string) => users.find((u) => u.id === id)!;
  const P1a = byId(pairs[0].a), P1b = byId(pairs[0].b);
  const P2a = byId(pairs[1].a), P2b = byId(pairs[1].b);

  for (const u of users) await waitForBreakout(sessions.get(u.id)!.page, u.displayName);
  await sessions.get(P1a.id)!.page.screenshot({ path: 'test-results/ws2-01-breakout.png' }).catch(() => {});

  // ── PHASE C: browser close + return WITHIN the 15s grace → room resumes ──
  console.log('  PHASE C: P1b closes browser, returns in ~6s…');
  await sessions.get(P1b.id)!.context.close(); // clean FIN → server disconnect fires now
  const p1aPage = sessions.get(P1a.id)!.page;
  await waitForText(p1aPage, /Waiting for your partner to reconnect/i, 'P1a sees waiting banner', 12_000);
  await p1aPage.screenshot({ path: 'test-results/ws2-02-waiting-banner.png' }).catch(() => {});
  await p1aPage.waitForTimeout(4000);
  sessions.set(P1b.id, await openUserPage(P1b)); // back within the grace
  await waitForBreakout(sessions.get(P1b.id)!.page, 'P1b (after return within grace)', 45_000);
  // Banner must clear promptly (match:partner_reconnected on rejoin) and
  // crucially P1a must STILL be in the breakout (no 5s self-eject).
  await expect(p1aPage.getByText(/Waiting for your partner to reconnect/i), 'P1a banner clears after partner returns')
    .toHaveCount(0, { timeout: 30_000 });
  expect(await readBreakoutSeconds(p1aPage), 'P1a must still be in the breakout (no self-eject)').not.toBeNull();
  console.log('  ✓ PHASE C complete: room resumed, banner cleared');

  // ── PHASE B: browser close >15s → survivor rates at expiry; late returner rates on rejoin ──
  console.log('  PHASE B: P2b closes browser and stays away >15s…');
  await sessions.get(P2b.id)!.context.close();
  const p2aPage = sessions.get(P2a.id)!.page;
  await waitForText(p2aPage, /Waiting for your partner to reconnect/i, 'P2a sees waiting banner', 12_000);
  // At grace expiry the room ENDS for the survivor: rating form, no re-pair.
  await waitForText(p2aPage, /didn.t return/i, 'P2a gets the partner-no-return rating form', 40_000);
  await p2aPage.screenshot({ path: 'test-results/ws2-03-survivor-rating.png' }).catch(() => {});
  await p2aPage.getByText('Skip', { exact: true }).first().click().catch(() => {});
  await p2aPage.waitForTimeout(3000);
  expect(await readBreakoutSeconds(p2aPage), 'P2a must be OUT of the breakout after rating').toBeNull();
  // No re-pairing: P2a must stay in the main room, not land in a new breakout.
  await p2aPage.waitForTimeout(8000);
  expect(await readBreakoutSeconds(p2aPage), 'P2a must NOT be re-paired into a new room').toBeNull();

  // Late returner: round still ROUND_ACTIVE (pair1 still talking).
  console.log('  PHASE B2: P2b returns after the grace…');
  sessions.set(P2b.id, await openUserPage(P2b));
  const p2bPage = sessions.get(P2b.id)!.page;
  await waitForText(p2bPage, /Rate your last conversation/i, 'P2b gets the late-return rating form', 40_000);
  await p2bPage.screenshot({ path: 'test-results/ws2-04-late-return-rating.png' }).catch(() => {});
  await p2bPage.getByText('Skip', { exact: true }).first().click().catch(() => {});
  await p2bPage.waitForTimeout(3000);
  expect(await readBreakoutSeconds(p2bPage), 'P2b lands in main room after late-return rating').toBeNull();
  console.log('  ✓ PHASE B complete: survivor rated at expiry, late returner rated on rejoin');

  // ── PHASE A: deliberate "Main Room" click → survivor rates IMMEDIATELY ──
  console.log('  PHASE A: P1a clicks Main Room…');
  const p1bPage = sessions.get(P1b.id)!.page;
  const t0 = Date.now();
  await p1aPage.getByText('Main Room', { exact: true }).first().click();
  // The leaver gets their own early-leave form.
  await waitForText(p1aPage, /Rate your conversation/i, 'P1a (leaver) gets the early-leave rating form', 15_000);
  // The survivor's room ends NOW — banner-free, no 15s wait.
  await waitForText(p1bPage, /didn.t return/i, 'P1b (survivor) gets the rating form immediately', 12_000);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`  survivor form appeared ${elapsed}s after the click`);
  expect(elapsed, 'survivor form must appear well before the old 15s grace').toBeLessThan(14);
  await p1bPage.screenshot({ path: 'test-results/ws2-05-immediate-survivor-rating.png' }).catch(() => {});

  console.log('✓ WS2 smoke complete: resume-within-grace, expiry→rating→no-re-pair, late-return form, immediate deliberate-leave end');
});
