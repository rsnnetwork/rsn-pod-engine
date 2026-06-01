import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// Does applying blur ACTUALLY change the self-view pixels? (bg-smoke only checked
// button state + that frames processed — not that the user sees a change.) This
// measures self-view sharpness before/after: blur must reduce high-frequency
// detail. Runs against prod by default (what the user is on).
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

// Mean absolute difference between horizontally-adjacent pixels of the self-view
// <video>, downscaled. Higher = sharper; blur lowers it. -1 if no frame yet.
async function selfSharpness(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tile = document.querySelector('[data-self="true"]') || document;
    const v = tile.querySelector('video') as HTMLVideoElement | null;
    if (!v || v.videoWidth === 0) return -1;
    const w = 160, h = 90;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); if (!ctx) return -1;
    ctx.drawImage(v, 0, 0, w, h);
    let data: Uint8ClampedArray;
    try { data = ctx.getImageData(0, 0, w, h).data; } catch { return -2; } // tainted
    let acc = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
      const i = (y * w + x) * 4, j = (y * w + x - 1) * 4;
      acc += Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
      n++;
    }
    return n ? acc / n : -1;
  }).catch(() => -1);
}

async function processorAttached(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // @ts-ignore — reach the livekit room off the window if exposed; else infer
    const vids = Array.from(document.querySelectorAll('[data-self="true"] video')) as HTMLVideoElement[];
    return vids.some((v) => !!(v.srcObject as MediaStream)?.getVideoTracks?.().length);
  }).catch(() => false);
}

test.beforeAll(async () => {
  host = await createTestUser('bvhost', 'super_admin');
  alice = await createTestUser('bvalice');
  bob = await createTestUser('bvbob');
  const pod = await createPod(host, 'E2E BG Visual Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E BG Visual', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all([registerForSession(alice, sessionId), registerForSession(bob, sessionId)]);
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();
  browser = await chromium.launch({
    headless: false,
    channel: process.env.E2E_CHROME_CHANNEL || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('applying blur visibly changes the self-view pixels', async () => {
  test.setTimeout(180_000);
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
    localStorage.setItem('rsn_bg_debug', '1');
  }, { a: alice.accessToken, r: alice.refreshToken });
  const page = await context.newPage();
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[bg]')) console.log('  ' + t.slice(0, 160)); });

  const share = process.env.E2E_VERCEL_SHARE;
  if (share) { await page.goto(`${APP}/?_vercel_share=${share}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500); }
  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);

  // Wait until the self-view actually has frames.
  let s0 = -1;
  for (let i = 0; i < 15 && s0 <= 0; i++) { await page.waitForTimeout(1000); s0 = await selfSharpness(page); }
  console.log(`  self-view sharpness BEFORE blur: ${s0.toFixed(2)} (attached=${await processorAttached(page)})`);
  expect(s0, 'self-view must be showing frames before we test blur').toBeGreaterThan(0);

  // Apply blur.
  const bgBtn = page.getByRole('button', { name: 'Background effects' });
  await expect(bgBtn).toBeVisible({ timeout: 20_000 });
  await bgBtn.click();
  await page.getByRole('dialog', { name: 'Choose background' }).getByText('Blur', { exact: true }).click();

  // Let the processor attach + run for several seconds (past warmup).
  await page.waitForTimeout(8000);
  const pref = await page.evaluate(() => localStorage.getItem('rsn_bg_preference'));
  const s1 = await selfSharpness(page);
  console.log(`  self-view sharpness AFTER blur:  ${s1.toFixed(2)}  pref=${pref}`);
  await page.screenshot({ path: 'test-results/bg-visual-after.png' }).catch(() => {});

  // Blur must measurably reduce sharpness in the SELF-VIEW the user looks at.
  console.log(`  sharpness ratio after/before = ${(s1 / s0).toFixed(3)} (want < 0.85 for visible blur)`);
  expect(s1, 'blur must visibly reduce self-view sharpness').toBeLessThan(s0 * 0.85);

  await context.close();
});
