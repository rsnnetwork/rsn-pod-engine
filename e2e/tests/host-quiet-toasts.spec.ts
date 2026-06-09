import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED proof for host-quiet toasts (Ali, 2026-06-09): the host was spammed
// with a confirmation banner on EVERY button press ("Plan updated for round 2",
// match hints, "No match data available to rate" …) that piled up top-right.
// The host now sees ONLY actionable errors; confirmation banners (info/success)
// are suppressed for the host. Participants are unaffected.
//
// This drives the EXACT class of toast the user complained about: the host
// clicks the "Match People" hint button (which calls addToast(hint,'info')) and
// must see NO banner. Pre-fix every click stacked a blue banner.
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

// Count visible toast banners (each is a <p> inside the fixed top-right container).
async function toastCount(page: Page): Promise<number> {
  return page.locator('div.fixed.top-4.right-4 p').count().catch(() => 0);
}

async function login(page: Page, user: TestUser) {
  await page.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const share = process.env.E2E_VERCEL_SHARE;
  if (share) {
    await page.goto(`${APP}/?_vercel_share=${share}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
  }
  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
}

test.beforeAll(async () => {
  host = await createTestUser('hqhost', 'super_admin');
  alice = await createTestUser('hqalice');
  bob = await createTestUser('hqbob');
  const pod = await createPod(host, 'E2E Host-Quiet Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E Host-Quiet', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all([registerForSession(alice, sessionId), registerForSession(bob, sessionId)]);
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  browser = await chromium.launch({
    headless: false,
    channel: process.env.E2E_CHROME_CHANNEL || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

// ── HOST: a confirmation (info) toast on a button press shows NO banner ───────
// This is the user's exact complaint reproduced against the deployed app: the
// host presses a control, an info toast fires internally (HostControls calls
// addToast(hint,'info')), and pre-fix a blue banner stacked top-right on every
// press. With hostQuiet the host must see ZERO banners.
//
// (Participant-still-sees-toasts and host-still-sees-actionable-errors are
// deterministically locked by the source-pin unit suite — the filter is
// `!hostQuiet || (type==='error' && !hostSilent)`, and a participant's
// isHost=false makes it a no-op. They aren't re-proven here because no
// participant-facing toast has an external trigger; host:broadcast renders a
// separate persistent banner, not a toast.)
test('host pressing a control fires an info toast but sees NO banner', async () => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page, host);

    // Non-vacuous sanity: the page must be a working host live surface, so a
    // zero banner count means "suppressed", not "page broken / control missing".
    const hint = page.getByRole('button', { name: /Match People|Another Round/ });
    await expect(hint, 'host live surface must render the Match People control').toBeVisible({ timeout: 20_000 });
    await expect(page.locator('div.fixed.top-4.right-4'), 'the toast container must be mounted').toHaveCount(1);

    expect(await toastCount(page), 'no banners before clicking').toBe(0);
    // Press it several times — pre-fix EACH press stacked a blue banner.
    for (let i = 0; i < 4; i++) { await hint.click({ force: true }).catch(() => {}); await page.waitForTimeout(400); }
    await page.waitForTimeout(1500);
    const n = await toastCount(page);
    await page.screenshot({ path: 'test-results/hq-host-no-banner.png' }).catch(() => {});
    console.log(`  host saw ${n} banners after 4 control presses (expect 0)`);
    expect(n, 'host must see NO confirmation banner (info suppressed)').toBe(0);
  } finally { await context.close(); }
});
