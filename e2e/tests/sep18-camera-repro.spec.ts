import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';
import { primePreview } from '../helpers/preview-bypass';

// HEADED prod reproduction — Shradha's 18 Sep 2026 review, findings 3 + 4:
//   3. main room: "the camera function was not working" (Chrome showed the
//      camera IN USE while both tiles showed the camera-off avatar)
//   4. breakout: "need to refresh to turn off the camera. Icon shows it's
//      turned off, but then I could see me on screen"
//
// The member's OWN view is what she reported, so every step asserts the
// self tile (data-self) and the real capture state — a getUserMedia shim
// counts live camera MediaStreamTracks, which is what drives the browser's
// camera-in-use indicator. Camera off must mean: self tile shows the avatar,
// the button says off, and NO live camera track remains. Camera on must
// mean: self tile shows video and the button says on. The icon must never
// disagree with the tile.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const WITH_BG = process.env.E2E_CAMERA_BG === '1';

let host: TestUser, cam: TestUser, obs: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket timeout')), 10_000);
  });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: Page, url: string) => {
  for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } }
};

const camBtn = (page: Page) => page.locator('button[aria-label="Camera on"], button[aria-label="Camera off"], button[aria-label="Starting camera"]').first();
const selfVideo = (page: Page) => page.locator('[data-self="true"] video');
const liveCams = (page: Page) => page.evaluate(() => (window as any).__liveCams() as number);
const camLabel = (page: Page) => camBtn(page).getAttribute('aria-label', { timeout: 30_000 }).catch(() => null);

async function snapshot(page: Page, label: string): Promise<{ label: string | null; selfVideos: number; live: number; videos: number }> {
  const s = {
    label: await camLabel(page),
    selfVideos: await selfVideo(page).count(),
    live: await liveCams(page),
    videos: await page.locator('video').count(),
  };
  console.log(`  [${label}] button=${s.label} selfTileVideo=${s.selfVideos} liveCameraTracks=${s.live} videoElements=${s.videos}`);
  return s;
}

// Wait for the room to settle (camera published and reported ON) and report
// the gap between "camera captured" (light on) and "camera on" (published).
async function settle(page: Page, where: string) {
  const t0 = Date.now();
  let capturedAt: number | null = null;
  let last = '';
  // Settled means all three agree: the button reads ON, the self tile shows
  // video, and exactly one camera track is live. Every state change on the
  // way is logged, so a lying label is visible in the run output.
  await expect.poll(async () => {
    const label = await camBtn(page).getAttribute('aria-label', { timeout: 5_000 }).catch(() => null);
    const live = await liveCams(page);
    const self = await selfVideo(page).count();
    if (capturedAt === null && live >= 1) capturedAt = Date.now();
    const state = `button=${label} selfTileVideo=${self} liveCameraTracks=${live}`;
    if (state !== last) { last = state; console.log(`  [${where} +${Date.now() - t0}ms] ${state}`); }
    return label === 'Camera on' && self >= 1 && live >= 1;
  }, { timeout: 60_000, intervals: [250, 500, 1000], message: `${where}: camera must publish, read ON and show the self video` }).toBe(true);
  console.log(`  [${where}] captured after ${capturedAt === null ? '?' : capturedAt - t0}ms, settled after ${Date.now() - t0}ms`);
}

// One off → on cycle with outcome asserts on the member's own page.
async function cycle(page: Page, obsPage: Page, where: string, errors: string[]) {
  const before = await snapshot(page, `${where} before`);
  expect(before.label, `${where}: camera must read ON`).toBe('Camera on');
  expect(before.selfVideos, `${where}: self tile must show video while ON`).toBeGreaterThan(0);

  await camBtn(page).click({ timeout: 30_000 });
  await expect.poll(() => camLabel(page), { timeout: 30_000 }).toBe('Camera off');
  await page.waitForTimeout(1500);
  const off = await snapshot(page, `${where} OFF`);
  await page.screenshot({ path: `test-results/sep18-${where.replace(/\W+/g, '-')}-off.png` }).catch(() => {});
  expect(off.selfVideos, `${where}: self tile must NOT show video after camera off (finding 4)`).toBe(0);
  expect(off.live, `${where}: no live camera track may remain after camera off (camera light)`).toBe(0);
  const obsOffText = obsPage.getByText(new RegExp(`${cam.displayName}\\s*—\\s*camera off`, 'i'));
  if (where.startsWith('breakout')) {
    await expect(obsOffText.first(), `${where}: partner must see "camera off"`).toBeVisible({ timeout: 20_000 });
  }

  await camBtn(page).click({ timeout: 30_000 });
  await expect.poll(() => camLabel(page), { timeout: 30_000 }).toBe('Camera on');
  await expect.poll(() => selfVideo(page).count(), { timeout: 30_000, message: `${where}: self tile must show video again after camera on (finding 3)` }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  const on = await snapshot(page, `${where} ON again`);
  await page.screenshot({ path: `test-results/sep18-${where.replace(/\W+/g, '-')}-on.png` }).catch(() => {});
  expect(on.live, `${where}: exactly one live camera track after camera on (no leaked captures)`).toBe(1);
  if (where.startsWith('breakout')) {
    await expect(obsOffText, `${where}: partner must see video again`).toHaveCount(0, { timeout: 20_000 });
  }
  expect(errors, `${where}: no camera errors in the console:\n${errors.join('\n')}`).toHaveLength(0);
}

async function applyBg(page: Page, label: 'Blur' | 'None') {
  const bgBtn = page.getByRole('button', { name: 'Background effects' });
  await expect(bgBtn, 'BG button present').toBeVisible({ timeout: 30_000 });
  await bgBtn.click({ timeout: 30_000 });
  const dialog = page.getByRole('dialog', { name: 'Choose background' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByText(label, { exact: true }).click({ timeout: 30_000 });
  const want = label === 'Blur' ? '{"mode":"blur"}' : '{"mode":"disabled"}';
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rsn_bg_preference')), { timeout: 40_000 }).toBe(want);
  console.log(`  [bg] applied ${label}`);
  await page.waitForTimeout(2000);
}

test.beforeAll(async () => {
  host = await createTestUser('s18host', 'super_admin');
  cam = await createTestUser('s18cam');
  obs = await createTestUser('s18obs');
  const pod = await createPod(host, 'E2E Sep18 Camera Pod'); podId = pod.id;
  await addPodMember(host, podId, cam.id); await addPodMember(host, podId, obs.id);
  const sess = await createSession(host, podId, 'Sep18 camera repro', new Date(Date.now() + 60_000), { numberOfRounds: 1, roundDurationSeconds: 300 });
  sessionId = sess.id;
  await Promise.all([registerForSession(cam, sessionId), registerForSession(obs, sessionId)]);
  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy',
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

test('Sep18: camera off/on is truthful in the main room and a breakout', async () => {
  test.setTimeout(480_000);

  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);

  const mk = async (u: TestUser) => {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    await ctx.addInitScript((t: { a: string; r: string; sid: string }) => {
      localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
      localStorage.setItem('rsn_bg_debug', '1');
      sessionStorage.setItem(`rsn_checkin_${t.sid}`, '1'); // the per-event check-in modal is not under test here
      const w = window as any;
      w.__camTracks = [];
      const md = navigator.mediaDevices;
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (c: MediaStreamConstraints) => {
        const s = await orig(c);
        s.getVideoTracks().forEach((tr) => w.__camTracks.push(tr));
        return s;
      };
      w.__liveCams = () => w.__camTracks.filter((tr: MediaStreamTrack) => tr.readyState === 'live').length;
    }, { a: u.accessToken, r: u.refreshToken, sid: sessionId });
    await primePreview(ctx);
    return ctx.newPage();
  };
  const camPage = await mk(cam);
  const obsPage = await mk(obs);
  const errors: string[] = [];
  camPage.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[bg')) { console.log('  ' + t.slice(0, 160)); return; }
    if (m.type() === 'error') { console.log('  [cam console.error]', t.slice(0, 200)); if (/camera/i.test(t)) errors.push(t); }
  });

  await gotoRetry(camPage, `${APP}/session/${sessionId}/live`);
  await gotoRetry(obsPage, `${APP}/session/${sessionId}/live`);
  await settle(camPage, 'main');
  await camPage.waitForTimeout(2000);

  // ── MAIN ROOM, no background ────────────────────────────────────────────
  await cycle(camPage, obsPage, 'main no-bg', errors);

  // ── BREAKOUT (round match), no background ───────────────────────────────
  console.log('  host: match → confirm → start round');
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId });
  await expect(camPage.locator('.vr-video-area').first(), 'member routed into the breakout').toBeVisible({ timeout: 40_000 });
  // Finding 4 evidence: the icon the instant the breakout opens vs. the tile.
  const first = await snapshot(camPage, 'breakout first paint');
  await camPage.screenshot({ path: 'test-results/sep18-breakout-first-paint.png' }).catch(() => {});
  await settle(camPage, 'breakout');
  await camPage.waitForTimeout(2000);
  const settled = await snapshot(camPage, 'breakout settled');
  expect(settled.selfVideos, 'breakout: self video published').toBeGreaterThan(0);
  if (first.label !== 'Camera on' && first.selfVideos > 0) {
    console.log('  !! finding 4 reproduced at first paint: icon said OFF while the self tile showed video');
  }
  await cycle(camPage, obsPage, 'breakout no-bg', errors);
  // The icon must agree with reality from the first paint (finding 4): the
  // camera is captured but not yet published, so it reads "Starting camera"
  // (or "Camera on" once published), never "Camera off" over a live camera.
  expect(['Starting camera', 'Camera on'], 'breakout first paint: never "Camera off" while the camera is live').toContain(first.label);
  if (first.label === 'Starting camera') {
    expect(first.selfVideos, 'starting: nothing published yet').toBe(0);
    expect(first.live, 'starting: the camera is captured').toBeGreaterThanOrEqual(1);
  } else {
    expect(first.selfVideos, 'on: the self tile shows video').toBeGreaterThan(0);
  }

  if (WITH_BG) {
    // ── BREAKOUT with blur (processor attached to the engine track) ────────
    await applyBg(camPage, 'Blur');
    await cycle(camPage, obsPage, 'breakout blur', errors);
    await applyBg(camPage, 'None');
  }

  console.log('  ✓ Sep18 camera repro complete');
});
