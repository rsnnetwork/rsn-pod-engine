import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED cross-device smoke for the background feature (2026-06-09). Five
// scenarios A–E, run on a REAL deployed client + fake camera, proving the
// 2026-06-09 fixes hold on every device class Ali's users are on:
//   A — Desktop (modern API): blur applies, self-view actually blurs, the
//       no-flash transformer is the one running (no first-frame raw flash).
//   B — Desktop image background: the image FULLY covers the frame (no
//       letterbox / no real-room edges) — "fully fitted".
//   C — iOS / older-Android EQUIVALENT: the modern stream APIs are removed
//       before load to force the canvas.captureStream fallback path, and the
//       no-flash transformer now runs THERE too (the fix). Pre-fix this path
//       used the stock processor, which flashes the raw room on apply.
//   D — Persistence: a background carries main → breakout unchanged.
//   E — Sustained: image segmentation runs for a minute without freezing the
//       tab (the never-freeze guarantee) and never silently drops to incoherent.
//
// Target a Vercel preview of the branch (E2E_APP_URL) which auto-points at the
// prod API/LiveKit; defaults to prod for a post-merge re-run.
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

// ── shared probes ────────────────────────────────────────────────────────────

async function bgActive(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).some((b) => {
      const tag = (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '') + (b.textContent || '');
      return /\bBG\b|background effects/i.test(tag) && b.className.includes('indigo');
    }),
  ).catch(() => false);
}

async function savedPref(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('rsn_bg_preference')).catch(() => null);
}

async function assertCoherent(page: Page, label: string): Promise<string | null> {
  const active = await bgActive(page);
  const pref = await savedPref(page);
  const prefOn = !!pref && pref !== '{"mode":"disabled"}';
  expect(active, `${label}: pill active=${active} must match stored pref=${pref}`).toBe(prefOn);
  return pref;
}

// Mean absolute difference between horizontally-adjacent self-view pixels.
// Higher = sharper; blur lowers it; an image replaces the content entirely.
// -1 no frame yet, -2 tainted (cross-origin — shouldn't happen for local cam).
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
    try { data = ctx.getImageData(0, 0, w, h).data; } catch { return -2; }
    let acc = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 1; x < w; x++) {
      const i = (y * w + x) * 4, j = (y * w + x - 1) * 4;
      acc += Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]);
      n++;
    }
    return n ? acc / n : -1;
  }).catch(() => -1);
}

// Fraction of the frame's outer border that is ~black. A letterboxed (not-
// covering) background shows black bars or raw edges; a fully-fitted image
// fills edge-to-edge. Returns 0..1 (lower = better coverage). -1 no frame.
async function borderBlackRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const tile = document.querySelector('[data-self="true"]') || document;
    const v = tile.querySelector('video') as HTMLVideoElement | null;
    if (!v || v.videoWidth === 0) return -1;
    const w = 120, h = 68;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); if (!ctx) return -1;
    ctx.drawImage(v, 0, 0, w, h);
    let data: Uint8ClampedArray;
    try { data = ctx.getImageData(0, 0, w, h).data; } catch { return -1; }
    let black = 0, total = 0;
    const isBorder = (x: number, y: number) => x < 3 || y < 3 || x >= w - 3 || y >= h - 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!isBorder(x, y)) continue;
      const i = (y * w + x) * 4;
      total++;
      if (data[i] < 16 && data[i + 1] < 16 && data[i + 2] < 16) black++;
    }
    return total ? black / total : -1;
  }).catch(() => -1);
}

// Poll responsiveness for `ms`; throws if the main thread freezes (the hang test).
async function holdAndProbe(page: Page, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.waitForTimeout(5000);
    const t0 = Date.now();
    await Promise.race([
      page.evaluate(() => performance.now()),
      new Promise((_, r) => setTimeout(() => r(new Error('main-thread frozen >8s')), 8000)),
    ]);
    const dt = Date.now() - t0;
    if (dt > 6000) throw new Error(`${label}: page unresponsive (${dt}ms)`);
    console.log(`  [${label}] responsive (${dt}ms) bgActive=${await bgActive(page)}`);
  }
}

interface Harness { page: Page; context: BrowserContext; bgErrors: string[]; bgLog: string[]; }

// Build a logged-in alice page. `forceFallback` removes the modern stream APIs
// BEFORE app code runs, so both our engine and the library take the iOS /
// older-Android canvas.captureStream path.
async function openAlice(forceFallback = false): Promise<Harness> {
  const context = await browser.newContext();
  await context.addInitScript(([toks, fb]: [{ a: string; r: string }, boolean]) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
    localStorage.setItem('rsn_bg_debug', '1');
    if (fb) {
      // Emulate a browser without MediaStreamTrackGenerator/Processor (iOS Safari,
      // older Android) so the fallback path is exercised in Chromium.
      try { Object.defineProperty(window, 'MediaStreamTrackGenerator', { value: undefined, configurable: true }); } catch {}
      try { Object.defineProperty(window, 'MediaStreamTrackProcessor', { value: undefined, configurable: true }); } catch {}
    }
  }, [{ a: alice.accessToken, r: alice.refreshToken }, forceFallback] as [{ a: string; r: string }, boolean]);

  const page = await context.newPage();
  const bgErrors: string[] = [];
  const bgLog: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[bg]')) { bgLog.push(t); console.log('   ' + t.slice(0, 180)); return; }
    if (m.type() !== 'error') return;
    if (/background|processor|mediapipe|segment|webgl/i.test(t)) bgErrors.push(t);
  });

  const share = process.env.E2E_VERCEL_SHARE;
  if (share) {
    await page.goto(`${APP}/?_vercel_share=${share}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
  }
  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
  return { page, context, bgErrors, bgLog };
}

async function applyPreset(page: Page, name: string): Promise<void> {
  const bgBtn = page.getByRole('button', { name: 'Background effects' });
  await expect(bgBtn, 'BG button must appear (capability gate incl. fallback)').toBeVisible({ timeout: 20_000 });
  await bgBtn.click();
  const dialog = page.getByRole('dialog', { name: 'Choose background' });
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.getByText(name, { exact: true }).click();
}

// Sample sharpness rapidly across the apply window and return the peak. If a raw
// (sharp, real-room) frame ever leaked, the peak spikes toward the raw baseline.
async function peakSharpnessDuringApply(page: Page, ms = 2000): Promise<number> {
  const end = Date.now() + ms;
  let peak = -1;
  while (Date.now() < end) {
    const s = await selfSharpness(page);
    if (s > peak) peak = s;
    await page.waitForTimeout(60);
  }
  return peak;
}

test.beforeAll(async () => {
  host = await createTestUser('bgxhost', 'super_admin');
  alice = await createTestUser('bgxalice');
  bob = await createTestUser('bgxbob');
  const pod = await createPod(host, 'E2E BG Cross-Device Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E BG Cross-Device', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all([registerForSession(alice, sessionId), registerForSession(bob, sessionId)]);
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  browser = await chromium.launch({
    headless: false,
    channel: process.env.E2E_CHROME_CHANNEL || undefined,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
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
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

// ── A — Desktop modern path: blur applies, no first-frame raw flash ───────────
test('A: desktop — blur applies, self-view blurs, no-flash transformer runs', async () => {
  test.setTimeout(120_000);
  const { page, context, bgErrors, bgLog } = await openAlice(false);
  try {
    const raw = await selfSharpness(page);
    console.log(`  baseline (raw) sharpness=${raw.toFixed(1)}`);
    await applyPreset(page, 'Blur');
    const peak = await peakSharpnessDuringApply(page, 2000);
    await expect.poll(() => savedPref(page), { timeout: 10_000 }).toBe('{"mode":"blur"}');
    await expect.poll(() => bgActive(page), { timeout: 10_000 }).toBe(true);
    const after = await selfSharpness(page);
    await page.screenshot({ path: 'test-results/bgx-A-desktop-blur.png' }).catch(() => {});
    console.log(`  apply-window peak=${peak.toFixed(1)} after=${after.toFixed(1)}`);

    expect(after, 'blur must reduce self-view sharpness').toBeLessThan(raw * 0.85);
    // No raw flash: the sharpest frame during apply never reached the raw room.
    if (raw > 0) expect(peak, 'no sharp raw-room frame during apply').toBeLessThan(raw * 0.95);
    // The vendored no-flash transformer is the one that built the pipeline.
    expect(bgLog.some((l) => /pipeline built/.test(l) && /noflash/.test(l)),
      `expected a 'noflash' pipeline build; got:\n${bgLog.join('\n')}`).toBe(true);
    expect(bgErrors, `bg errors:\n${bgErrors.join('\n')}`).toHaveLength(0);
  } finally { await context.close(); }
});

// ── B — Desktop image background fully covers the frame ───────────────────────
test('B: desktop — image background is fully fitted (no letterbox / real-room edges)', async () => {
  test.setTimeout(120_000);
  const { page, context, bgErrors } = await openAlice(false);
  try {
    await applyPreset(page, 'Office');
    await expect.poll(() => savedPref(page), { timeout: 10_000 }).toBe('{"mode":"image","imageUrl":"/backgrounds/office.jpg"}');
    await expect.poll(() => bgActive(page), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(2500); // let the cover-cropped image settle
    const borderBlack = await borderBlackRatio(page);
    await page.screenshot({ path: 'test-results/bgx-B-desktop-image-cover.png' }).catch(() => {});
    console.log(`  border-black ratio=${borderBlack.toFixed(3)} (low = fully covered, no letterbox)`);
    // A covered image fills the border; letterbox/uncovered would push this high.
    expect(borderBlack, 'image background must cover the frame edges (no letterbox bars)').toBeLessThan(0.2);
    expect(bgErrors, `bg errors:\n${bgErrors.join('\n')}`).toHaveLength(0);
  } finally { await context.close(); }
});

// ── C — iOS / older-Android fallback path: no-flash now runs there too ────────
test('C: fallback path (iOS-equivalent) — BG button shows, no-flash runs, no raw flash', async () => {
  test.setTimeout(120_000);
  const { page, context, bgErrors, bgLog } = await openAlice(true);
  try {
    const raw = await selfSharpness(page);
    console.log(`  [fallback] baseline (raw) sharpness=${raw.toFixed(1)}`);
    await applyPreset(page, 'Blur'); // button must appear at all → fallback supported
    const peak = await peakSharpnessDuringApply(page, 2500);
    await expect.poll(() => savedPref(page), { timeout: 12_000 }).toBe('{"mode":"blur"}');
    await page.waitForTimeout(1500);
    const after = await selfSharpness(page);
    await page.screenshot({ path: 'test-results/bgx-C-fallback-blur.png' }).catch(() => {});
    console.log(`  [fallback] peak=${peak.toFixed(1)} after=${after.toFixed(1)}`);

    // THE FIX: the no-flash transformer built the pipeline on the FALLBACK path.
    // Pre-fix this log line said 'stock fallback' and the raw room flashed.
    expect(bgLog.some((l) => /pipeline built/.test(l) && /noflash/.test(l) && /fallback/.test(l)),
      `expected 'noflash ... fallback' build on the iOS-equivalent path; got:\n${bgLog.join('\n')}`).toBe(true);
    if (raw > 0 && after > 0) {
      expect(after, 'blur must reduce sharpness on the fallback path').toBeLessThan(raw * 0.9);
      expect(peak, 'no sharp raw-room frame during fallback apply').toBeLessThan(raw * 0.95);
    }
    expect(bgErrors, `bg errors:\n${bgErrors.join('\n')}`).toHaveLength(0);
  } finally { await context.close(); }
});

// ── D — Persistence: background carries main → breakout ───────────────────────
test('D: background persists main → breakout unchanged', async () => {
  test.setTimeout(180_000);
  const { page, context, bgErrors } = await openAlice(false);
  try {
    await applyPreset(page, 'Blur');
    await expect.poll(() => savedPref(page), { timeout: 10_000 }).toBe('{"mode":"blur"}');
    const prefMain = await assertCoherent(page, 'main');

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

    let entered = false;
    for (let i = 0; i < 20 && !entered; i++) {
      await page.waitForTimeout(1000);
      const texts = await page.locator('span.font-mono').allInnerTexts().catch(() => [] as string[]);
      entered = texts.some((t) => /^\d{1,2}:\d{2}$/.test(t.trim()));
    }
    expect(entered, 'alice should enter the breakout').toBe(true);
    await page.waitForTimeout(8000);
    const prefBreakout = await assertCoherent(page, 'breakout');
    await page.screenshot({ path: 'test-results/bgx-D-breakout-persist.png' }).catch(() => {});
    expect(prefBreakout, 'pref must persist main → breakout').toBe(prefMain);
    hostSock.emit('host:end_breakout_all', { sessionId });
    expect(bgErrors, `bg errors:\n${bgErrors.join('\n')}`).toHaveLength(0);
  } finally { await context.close(); }
});

// ── E — Sustained: image segmentation a full minute, no freeze ────────────────
test('E: sustained image background ~1 min — no tab freeze, stays coherent', async () => {
  test.setTimeout(180_000);
  const { page, context, bgErrors } = await openAlice(false);
  try {
    await applyPreset(page, 'Nature');
    await expect.poll(() => savedPref(page), { timeout: 10_000 }).toBe('{"mode":"image","imageUrl":"/backgrounds/nature.jpg"}');
    await holdAndProbe(page, 60_000, 'sustained');
    await assertCoherent(page, 'after-sustained');
    await page.screenshot({ path: 'test-results/bgx-E-sustained.png' }).catch(() => {});
    expect(bgErrors, `bg errors:\n${bgErrors.join('\n')}`).toHaveLength(0);
  } finally { await context.close(); }
});
