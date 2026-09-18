import { test, expect, chromium, webkit, devices, Browser, BrowserContext, Page } from '@playwright/test';
import type { BrowserContextOptions } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';
import { primePreview } from '../helpers/preview-bypass';
import { gotoRetry } from '../helpers/live-ui';

// HEADED prod device matrix for the 18 Sep camera fixes (Shradha tested on a
// Mac, in Chrome, with three tabs sharing one camera; Stefan's team is on
// iPhones and Macs). The member under test runs on each of:
//   iPhone 14 Safari, iPad Safari (landscape), Mac Safari, Mac Chrome
// through LiveKit on production, and a fifth scenario opens THREE tabs in ONE
// Mac Chrome browser (host + two members) so all three capture the same camera.
//
// Playwright's WebKit on Windows has no camera device at all (navigator.
// mediaDevices is undefined), so WebKit contexts get a synthetic canvas camera
// before the app loads, the same way ux-7 does. On every engine a shim counts
// live camera tracks: that count is what drives the browser's camera light.
//
// The invariant at every step, in both rooms: the camera button, the self
// tile and the live-track count agree. "Camera off" = avatar + 0 live tracks.
// "Camera on" = visible self video + 1 live track. "Starting camera" = 1 live
// track, nothing published yet, never "Camera off" over a live camera.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const ONLY = process.env.E2E_DEVICE; // run one profile, e.g. E2E_DEVICE=iphone-14-safari

const MAC_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

interface Profile { name: string; engine: 'chromium' | 'webkit'; ctx: BrowserContextOptions; mobile: boolean }
const PROFILES: Profile[] = [
  { name: 'iphone-14-safari', engine: 'webkit', ctx: { ...devices['iPhone 14'] }, mobile: true },
  { name: 'ipad-landscape-safari', engine: 'webkit', ctx: { ...devices['iPad (gen 7) landscape'] }, mobile: false },
  { name: 'mac-safari', engine: 'webkit', ctx: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } }, mobile: false },
  { name: 'mac-chrome', engine: 'chromium', ctx: { viewport: { width: 1440, height: 900 }, userAgent: MAC_CHROME_UA }, mobile: false },
];

let chromiumB: Browser; let webkitB: Browser | null = null;
const sockets: Socket[] = [];
const contexts: BrowserContext[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket timeout')), 10_000);
  });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// Installed before any app code: a synthetic camera where the engine has none
// (WebKit), and on every engine a counter of live camera tracks.
const CAMERA_SHIM = (t: { a: string; r: string; sid: string }) => {
  localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  localStorage.setItem('rsn_bg_debug', '1');
  sessionStorage.setItem(`rsn_checkin_${t.sid}`, '1');
  const w = window as any;
  if (!(navigator as any).mediaDevices) {
    const makeStream = () => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 480;
      const g = c.getContext('2d');
      let hue = 0;
      setInterval(() => { if (g) { hue = (hue + 7) % 360; g.fillStyle = `hsl(${hue} 60% 40%)`; g.fillRect(0, 0, 640, 480); g.fillStyle = '#fff'; g.fillRect(200, 140, 240, 200); } }, 100);
      return (c as any).captureStream ? (c as any).captureStream(15) : new MediaStream();
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => makeStream(),
        enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'synthetic', label: 'Synthetic camera', groupId: 'g' }],
        getSupportedConstraints: () => ({}),
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
      },
    });
  }
  w.__camTracks = [];
  const md = navigator.mediaDevices;
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async (c: MediaStreamConstraints) => {
    const s = await orig(c);
    s.getVideoTracks().forEach((tr: MediaStreamTrack) => w.__camTracks.push(tr));
    return s;
  };
  w.__liveCams = () => w.__camTracks.filter((tr: MediaStreamTrack) => tr.readyState === 'live').length;
};

async function open(browser: Browser, opts: BrowserContextOptions, u: TestUser, sid: string): Promise<Page> {
  // Chromium wants the media permissions granted up front; WebKit rejects the
  // names ("Unknown permission: camera") and needs no grant for the shim.
  const isChromium = browser.browserType().name() === 'chromium';
  const ctx = await browser.newContext(isChromium ? { ...opts, permissions: ['camera', 'microphone'] } : opts);
  contexts.push(ctx);
  await ctx.addInitScript(CAMERA_SHIM, { a: u.accessToken, r: u.refreshToken, sid });
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  return page;
}

const camBtn = (page: Page) => page.locator('button[aria-label="Camera on"], button[aria-label="Camera off"], button[aria-label="Starting camera"]').first();
const camLabel = (page: Page) => camBtn(page).getAttribute('aria-label', { timeout: 5_000 }).catch(() => null);
// The self tile: data-self in the lobby and the desktop breakout, the mobile
// breakout's own PIP otherwise. Only the visible one counts.
const selfVideos = (page: Page) => page.locator('[data-self="true"] video, .vr-self-pip video').filter({ visible: true }).count();
const liveCams = (page: Page) => page.evaluate(() => (window as any).__liveCams() as number);

async function state(page: Page) {
  return { label: await camLabel(page), self: await selfVideos(page), live: await liveCams(page) };
}
function assertTruthful(s: { label: string | null; self: number; live: number }, where: string) {
  if (s.label === 'Camera on') { expect(s.self, `${where}: ON shows the self video`).toBeGreaterThan(0); expect(s.live, `${where}: ON has one live camera`).toBe(1); }
  else if (s.label === 'Camera off') { expect(s.self, `${where}: OFF shows no self video`).toBe(0); expect(s.live, `${where}: OFF leaves no live camera (light off)`).toBe(0); }
  else if (s.label === 'Starting camera') { expect(s.self, `${where}: starting shows no self video yet`).toBe(0); expect(s.live, `${where}: starting has captured the camera`).toBeGreaterThanOrEqual(1); }
}

async function settle(page: Page, where: string) {
  const t0 = Date.now(); let last = '';
  await expect.poll(async () => {
    const s = await state(page);
    const line = `button=${s.label} selfVideo=${s.self} liveCameras=${s.live}`;
    if (line !== last) { last = line; console.log(`    [${where} +${Date.now() - t0}ms] ${line}`); assertTruthful(s, where); }
    return s.label === 'Camera on' && s.self >= 1 && s.live >= 1;
  }, { timeout: 75_000, intervals: [250, 500, 1000], message: `${where}: camera must publish, read ON and show the self video` }).toBe(true);
}

async function cycle(page: Page, obsPage: Page | null, who: TestUser, where: string) {
  const before = await state(page);
  expect(before.label, `${where}: starts ON`).toBe('Camera on');
  await camBtn(page).click({ timeout: 30_000 });
  await expect.poll(() => camLabel(page), { timeout: 30_000 }).toBe('Camera off');
  await page.waitForTimeout(1500);
  const off = await state(page);
  console.log(`    [${where} OFF] button=${off.label} selfVideo=${off.self} liveCameras=${off.live}`);
  assertTruthful(off, `${where} OFF`);
  const offText = obsPage ? obsPage.getByText(new RegExp(`${who.displayName}\\s*—\\s*camera off`, 'i')) : null;
  if (offText && where.includes('breakout')) await expect(offText.first(), `${where}: partner sees camera off`).toBeVisible({ timeout: 20_000 });

  await camBtn(page).click({ timeout: 30_000 });
  await expect.poll(async () => { const s = await state(page); return s.label === 'Camera on' && s.self >= 1; }, { timeout: 30_000, message: `${where}: back ON with video` }).toBe(true);
  await page.waitForTimeout(1500);
  const on = await state(page);
  console.log(`    [${where} ON again] button=${on.label} selfVideo=${on.self} liveCameras=${on.live}`);
  assertTruthful(on, `${where} ON again`);
  if (offText && where.includes('breakout')) await expect(offText, `${where}: partner sees video again`).toHaveCount(0, { timeout: 20_000 });
}

async function tapTargets(page: Page, where: string) {
  const btns = await page.locator('button[aria-label="Camera on"], button[aria-label="Camera off"], button[aria-label="Mic on"], button[aria-label="Mic off"]').filter({ visible: true }).all();
  const sizes = [];
  for (const b of btns) { const box = await b.boundingBox(); if (box) sizes.push(`${await b.getAttribute('aria-label')}=${Math.round(box.width)}x${Math.round(box.height)}`); }
  console.log(`    [${where} tap targets] ${sizes.join(', ')}`);
  const vw = page.viewportSize()!.width;
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow, `${where}: no horizontal overflow at ${vw}px`).toBe(false);
  // The visible pill is small by design; its invisible hit box must reach 44px:
  // a tap 9px above the pill's top edge (outside the drawn button) toggles the
  // mic. boundingBox cannot see a pseudo-element, so this is the real check.
  // (E2E_HITBOX=0 skips it against a build that predates the hit box.)
  if (process.env.E2E_HITBOX === '0') return;
  const mic = page.locator('button[aria-label="Mic on"], button[aria-label="Mic off"]').filter({ visible: true }).first();
  const before = await mic.getAttribute('aria-label');
  const box = (await mic.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y - 9);
  await expect.poll(() => mic.getAttribute('aria-label'), { timeout: 10_000, message: `${where}: a tap just above the mic pill must still hit it (44px hit box)` }).not.toBe(before);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // restore
  await expect.poll(() => mic.getAttribute('aria-label'), { timeout: 10_000 }).toBe(before);
  console.log(`    [${where} hit box] a tap 9px above the ${Math.round(box.height)}px mic pill toggled it`);
}

async function eventFixture(tag: string) {
  const host = await createTestUser(`s18d${tag}h`, 'super_admin');
  const cam = await createTestUser(`s18d${tag}c`);
  const obs = await createTestUser(`s18d${tag}o`);
  const pod = await createPod(host, `E2E Sep18 devices ${tag}`);
  await addPodMember(host, pod.id, cam.id); await addPodMember(host, pod.id, obs.id);
  const sess = await createSession(host, pod.id, `Sep18 devices ${tag}`, new Date(Date.now() + 60_000), { numberOfRounds: 1, roundDurationSeconds: 300 });
  await Promise.all([registerForSession(cam, sess.id), registerForSession(obs, sess.id)]);
  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId: sess.id }); await wait(2500);
  return { host, cam, obs, sessionId: sess.id as string, hostSock };
}

test.beforeAll(async () => {
  chromiumB = await chromium.launch({ headless: false, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  try { webkitB = await webkit.launch({ headless: false }); } catch (e) { console.log(`  (webkit not available: ${(e as Error).message.split('\n')[0]})`); }
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  for (const c of contexts) { try { await c.close(); } catch {} }
  try { await chromiumB?.close(); } catch {}
  try { await webkitB?.close(); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

for (const p of PROFILES) {
  if (ONLY && ONLY !== p.name) continue;
  test(`camera is truthful on ${p.name}: main room and breakout, off and on`, async () => {
    test.setTimeout(420_000);
    const browser = p.engine === 'webkit' ? webkitB : chromiumB;
    test.skip(!browser, 'webkit not installed');
    const f = await eventFixture(p.name.slice(0, 6).replace(/-/g, ''));
    const camPage = await open(browser!, p.ctx, f.cam, f.sessionId);
    const obsPage = await open(chromiumB, { viewport: { width: 1100, height: 760 } }, f.obs, f.sessionId);
    const errors: string[] = [];
    camPage.on('console', (m) => { if (m.type() === 'error' && /camera|publish/i.test(m.text())) errors.push(m.text()); });

    await gotoRetry(camPage, `${APP}/session/${f.sessionId}/live`);
    await gotoRetry(obsPage, `${APP}/session/${f.sessionId}/live`);
    await settle(camPage, `${p.name} main`);
    await tapTargets(camPage, `${p.name} main`);
    await camPage.screenshot({ path: `test-results/sep18-dev-${p.name}-main.png` }).catch(() => {});
    await cycle(camPage, obsPage, f.cam, `${p.name} main`);

    f.hostSock.emit('host:generate_matches', { sessionId: f.sessionId }); await wait(6000);
    f.hostSock.emit('host:confirm_matches', { sessionId: f.sessionId }); await wait(3000);
    f.hostSock.emit('host:start_round', { sessionId: f.sessionId });
    await expect(camPage.locator('.vr-video-area').first(), `${p.name}: routed into the breakout`).toBeVisible({ timeout: 45_000 });
    const first = await state(camPage);
    console.log(`    [${p.name} breakout first paint] button=${first.label} selfVideo=${first.self} liveCameras=${first.live}`);
    expect(['Starting camera', 'Camera on', null], `${p.name} breakout first paint: never "Camera off" over a live camera`).toContain(first.label);
    await settle(camPage, `${p.name} breakout`);
    await tapTargets(camPage, `${p.name} breakout`);
    await camPage.screenshot({ path: `test-results/sep18-dev-${p.name}-breakout.png` }).catch(() => {});
    await cycle(camPage, obsPage, f.cam, `${p.name} breakout`);
    expect(errors, `${p.name}: no camera errors`).toHaveLength(0);
    try { f.hostSock.emit('host:end_session', { sessionId: f.sessionId, endEvent: true }); } catch {}
    await endSession(f.host, f.sessionId).catch(() => {});
    console.log(`  ✓ ${p.name}`);
  });
}

// Shradha's actual setup: one Mac Chrome browser, three tabs (host + two
// members), all sharing the one camera.
test(ONLY && ONLY !== 'shared-tabs' ? 'skipped' : 'three tabs in one Mac Chrome browser share the camera: host sees all three, breakout toggles stay truthful', async () => {
  test.skip(!!ONLY && ONLY !== 'shared-tabs');
  test.setTimeout(420_000);
  const f = await eventFixture('tabs');
  // Three signed-in identities cannot share one origin's storage (the app
  // syncs auth across tabs), which is also why Shradha used a second Chrome
  // profile. Three contexts in ONE Chromium instance are the faithful stand-in:
  // separate profiles, one browser process, one camera device shared by all.
  const tab = async (u: TestUser) => open(chromiumB, { viewport: { width: 1440, height: 900 }, userAgent: MAC_CHROME_UA }, u, f.sessionId);
  const hostPage = await tab(f.host); await gotoRetry(hostPage, `${APP}/session/${f.sessionId}/live`);
  const aPage = await tab(f.cam); await gotoRetry(aPage, `${APP}/session/${f.sessionId}/live`);
  const bPage = await tab(f.obs); await gotoRetry(bPage, `${APP}/session/${f.sessionId}/live`);

  await settle(hostPage, 'tabs host main');
  await settle(aPage, 'tabs A main');
  await settle(bPage, 'tabs B main');
  // Every tab holds its own capture; the host sees three tiles with video.
  await expect.poll(() => hostPage.locator('video').filter({ visible: true }).count(), { timeout: 30_000, message: 'host sees three videos (own + two members)' }).toBeGreaterThanOrEqual(3);
  console.log(`    [tabs] live cameras per tab: host=${await liveCams(hostPage)} A=${await liveCams(aPage)} B=${await liveCams(bPage)}`);
  await hostPage.screenshot({ path: 'test-results/sep18-dev-tabs-host-main.png' }).catch(() => {});

  await cycle(aPage, bPage, f.cam, 'tabs A main');

  f.hostSock.emit('host:generate_matches', { sessionId: f.sessionId }); await wait(6000);
  f.hostSock.emit('host:confirm_matches', { sessionId: f.sessionId }); await wait(3000);
  f.hostSock.emit('host:start_round', { sessionId: f.sessionId });
  await expect(aPage.locator('.vr-video-area').first(), 'A routed into the breakout').toBeVisible({ timeout: 45_000 });
  const first = await state(aPage);
  console.log(`    [tabs A breakout first paint] button=${first.label} selfVideo=${first.self} liveCameras=${first.live}`);
  expect(['Starting camera', 'Camera on', null]).toContain(first.label);
  await settle(aPage, 'tabs A breakout');
  await settle(bPage, 'tabs B breakout');
  await cycle(aPage, bPage, f.cam, 'tabs A breakout');
  // The host, still in the main room in the same browser, keeps a truthful camera.
  const hostState = await state(hostPage);
  console.log(`    [tabs host during round] button=${hostState.label} selfVideo=${hostState.self} liveCameras=${hostState.live}`);
  assertTruthful(hostState, 'tabs host during round');
  await hostPage.screenshot({ path: 'test-results/sep18-dev-tabs-host-round.png' }).catch(() => {});
  try { f.hostSock.emit('host:end_session', { sessionId: f.sessionId, endEvent: true }); } catch {}
  await endSession(f.host, f.sessionId).catch(() => {});
  console.log('  ✓ shared-tabs');
});

// The host on an iPhone: the live Invite modal still hands out a real link
// and fits the phone.
test(ONLY && ONLY !== 'iphone-invite' ? 'skipped invite' : 'the live Invite modal on an iPhone shares a real invite link and fits the screen', async () => {
  test.skip(!!ONLY && ONLY !== 'iphone-invite');
  test.skip(!webkitB, 'webkit not installed');
  test.setTimeout(240_000);
  const host = await createTestUser('s18dinvh', 'super_admin');
  const pod = await createPod(host, 'E2E Sep18 devices invite');
  const sess = await createSession(host, pod.id, 'Sep18 devices invite', new Date(Date.now() + 60_000), { numberOfRounds: 1 });
  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId: sess.id }); await wait(2500);
  const page = await open(webkitB!, { ...devices['iPhone 14'] }, host, sess.id);
  await gotoRetry(page, `${APP}/session/${sess.id}/live`);
  await page.waitForTimeout(6000);
  await page.getByTitle('Open Host Control Center').click({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Invite', exact: true }).click({ timeout: 30_000 });
  const link = page.getByTestId('live-invite-link');
  await expect.poll(() => link.inputValue(), { timeout: 30_000 }).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
  const copy = page.getByRole('button', { name: 'Copy link' });
  await expect(copy).toBeEnabled();
  const box = await copy.boundingBox();
  const vw = page.viewportSize()!.width;
  console.log(`    [iphone invite] link=${await link.inputValue()} copy=${Math.round(box!.width)}x${Math.round(box!.height)} viewport=${vw}`);
  expect(box!.height, 'Copy is a 44px tap target').toBeGreaterThanOrEqual(44);
  expect(box!.x + box!.width, 'Copy fits inside the phone width').toBeLessThanOrEqual(vw + 1);
  const linkBox = await link.boundingBox();
  expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(vw + 1);
  await page.screenshot({ path: 'test-results/sep18-dev-iphone-invite.png' }).catch(() => {});
  await endSession(host, sess.id).catch(() => {});
  console.log('  ✓ iphone-invite');
});
