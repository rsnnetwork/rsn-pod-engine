import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED end-to-end smoke for the rebuilt background effects (27 May).
// Proves on a REAL deployed client + fake camera that:
//   1. Background blur applies in the main room without hanging the tab.
//   2. It survives a full minute of live segmentation (the hang window).
//   3. It PERSISTS into a breakout room (main -> breakout) automatically.
//   4. It survives more time in the breakout, still responsive.
// Throughout: the page must stay responsive (no main-thread freeze) and emit no
// background-apply errors.
//
// Target the feat/bg-perf Vercel preview (has the new code; its *.vercel.app host
// auto-points the client at the prod API/LiveKit via runtimeEndpoints).
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

// The BG pill turns indigo (bg-indigo-500/80) when an effect is active. Read the
// DOM directly (locator.getAttribute flaked here) — works in both rooms.
async function bgActive(page: Page): Promise<boolean> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('button')).some((b) => {
        const tag = (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '') + (b.textContent || '');
        return /\bBG\b|background effects/i.test(tag) && b.className.includes('indigo');
      }),
    )
    .catch(() => false);
}

async function savedPref(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('rsn_bg_preference')).catch(() => null);
}

// The pill must agree with stored state: indigo iff an effect is selected. This
// holds whether the device sustains the effect (stays on) or the safety net
// disabled it (off) — what must never happen is the two disagreeing.
async function assertCoherent(page: Page, label: string): Promise<string | null> {
  const active = await bgActive(page);
  const pref = await savedPref(page);
  const prefOn = !!pref && pref !== '{"mode":"disabled"}';
  expect(active, `${label}: pill active=${active} must match stored pref=${pref}`).toBe(prefOn);
  console.log(`  [${label}] coherent — bgActive=${active} pref=${pref}`);
  return pref;
}

// Poll responsiveness for `ms`. If the main thread is frozen, page.evaluate stalls
// past the timeout and throws — that's our hang detector.
async function holdAndProbe(page: Page, ms: number, label: string, errors: string[]): Promise<void> {
  const end = Date.now() + ms;
  let probes = 0;
  while (Date.now() < end) {
    await page.waitForTimeout(5000);
    const t0 = Date.now();
    await Promise.race([
      page.evaluate(() => performance.now()),
      new Promise((_, r) => setTimeout(() => r(new Error('main-thread frozen >8s')), 8000)),
    ]);
    const dt = Date.now() - t0;
    probes++;
    if (dt > 6000) throw new Error(`${label}: page unresponsive (${dt}ms to evaluate)`);
    console.log(`  [${label}] probe ${probes}: responsive (${dt}ms), bgActive=${await bgActive(page)}, errors=${errors.length}`);
  }
}

test.beforeAll(async () => {
  host = await createTestUser('bghost', 'super_admin');
  alice = await createTestUser('bgalice');
  bob = await createTestUser('bgbob');
  const pod = await createPod(host, 'E2E BG Smoke Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sched = new Date(Date.now() + 60_000);
  const sess = await createSession(host, podId, 'E2E BG Smoke', sched);
  sessionId = sess.id;
  await Promise.all([registerForSession(alice, sessionId), registerForSession(bob, sessionId)]);
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  browser = await chromium.launch({
    headless: false,
    channel: process.env.E2E_CHROME_CHANNEL || undefined, // e.g. 'chrome' for real GPU
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Push for real GPU-backed WebGL (MediaPipe GPU delegate) instead of
      // SwiftShader software rendering, which is too slow for segmentation.
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
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

test('real browser: blur applies, survives 1 min in main room, persists into breakout', async () => {
  test.setTimeout(300_000);
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
    localStorage.setItem('rsn_bg_debug', '1'); // enable [bg] frame-timing logs
  }, { a: alice.accessToken, r: alice.refreshToken });
  const page = await context.newPage();

  const bgErrors: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[bg]')) { console.log('  ' + t.slice(0, 200)); return; }
    if (m.type() !== 'error') return;
    console.log('  [alice console.error]', t.slice(0, 160));
    if (/background|processor|mediapipe|segment|webgl/i.test(t)) bgErrors.push(t);
  });

  // Preview deployments are behind Vercel deployment protection — visit the
  // _vercel_share link first to set the bypass cookie for this context.
  const share = process.env.E2E_VERCEL_SHARE;
  if (share) {
    await page.goto(`${APP}/?_vercel_share=${share}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
  }

  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000); // lobby mounts + camera publishes + capability probe resolves

  // The BG control only renders when supportsModernBackgroundProcessors() === true.
  const bgBtn = page.getByRole('button', { name: 'Background effects' });
  await expect(bgBtn, 'BG button should appear (browser supports the processor)').toBeVisible({ timeout: 20_000 });
  console.log('  BG button present → capability gate passed');

  // Apply blur.
  await bgBtn.click();
  const dialog = page.getByRole('dialog', { name: 'Choose background' });
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.getByText('Blur', { exact: true }).click();
  await page.waitForTimeout(3000);

  await expect.poll(() => savedPref(page), { timeout: 10_000 }).toBe('{"mode":"blur"}');
  await expect.poll(() => bgActive(page), { timeout: 10_000, message: 'BG pill should be active after applying blur' }).toBe(true);
  await page.screenshot({ path: 'test-results/bg-01-blur-applied-main.png' }).catch(() => {});
  console.log('  ✓ blur applied in main room (pref persisted, pill active)');

  // 1) Hold a full minute in the main room with segmentation running. The hard
  //    guarantee: the tab never freezes (holdAndProbe throws if it does).
  await holdAndProbe(page, 60_000, 'main-room', bgErrors);
  const prefAfterMain = await assertCoherent(page, 'after-1min-main');
  await page.screenshot({ path: 'test-results/bg-02-after-1min-main.png' }).catch(() => {});

  // 2) Host opens a breakout for alice + bob → alice is routed to the VideoRoom.
  const hostSock = await connectSocket(host);
  const bobSock = await connectSocket(bob);
  sockets.push(hostSock, bobSock);
  hostSock.emit('session:join', { sessionId });
  bobSock.emit('session:join', { sessionId });
  await page.waitForTimeout(2500);
  hostSock.emit('host:create_breakout_bulk', {
    sessionId,
    rooms: [{ participantIds: [alice.id, bob.id] }],
    sharedDurationSeconds: 300,
    timerVisibility: 'visible',
  });

  let inBreakout: number | null = null;
  for (let i = 0; i < 20 && inBreakout === null; i++) {
    await page.waitForTimeout(1000);
    inBreakout = await readBreakoutSeconds(page);
  }
  expect(inBreakout, 'alice should be routed into the breakout').not.toBeNull();
  console.log(`  ✓ alice entered breakout at ${inBreakout}s`);
  await page.waitForTimeout(8000);

  // 3) PERSISTENCE: whatever the effective state was at the end of the main room
  //    must carry into the breakout — that's the cross-room persistence contract,
  //    independent of whether the device sustained the effect.
  const prefInBreakout = await assertCoherent(page, 'in-breakout');
  expect(prefInBreakout, 'background preference must persist main → breakout').toBe(prefAfterMain);
  await page.screenshot({ path: 'test-results/bg-03-breakout.png' }).catch(() => {});

  // 4) Hold in the breakout too — still no freeze.
  await holdAndProbe(page, 30_000, 'breakout', bgErrors);
  await assertCoherent(page, 'after-breakout-hold');
  await page.screenshot({ path: 'test-results/bg-04-after-breakout-hold.png' }).catch(() => {});

  // No background / processor / webgl errors anywhere in the run.
  expect(bgErrors, `background errors during run:\n${bgErrors.join('\n')}`).toHaveLength(0);
  console.log(`  state through run: applied=blur, end-of-main=${prefAfterMain}, breakout=${prefInBreakout} (persisted)`);

  hostSock.emit('host:end_breakout_all', { sessionId });
  await context.close();
  console.log('✓ BG smoke complete: applied → 1min main → persisted to breakout → held, zero hangs/errors');
});
