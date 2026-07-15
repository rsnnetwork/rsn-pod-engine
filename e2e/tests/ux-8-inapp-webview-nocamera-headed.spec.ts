import { test, expect, chromium, webkit, devices, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';
import {
  connectSocket, gotoRetry, cleanup, wait, APP,
  inLobby, inBreakout, Socket,
} from '../helpers/live-ui';

// HEADED PROD — the "in-app browser" trap (found 14 Jul while building ux-7).
//
// The Lobby's DeviceTest widget ("Check your camera and mic before the event
// starts") called `navigator.mediaDevices.getUserMedia(...)` with only a
// `.catch()`. `.catch()` handles a REJECTED promise (permission denied) — but
// when `navigator.mediaDevices` is UNDEFINED the property access throws a
// SYNCHRONOUS TypeError before any promise exists, so it escapes the effect and
// trips the Lobby error boundary → "Something went wrong in Lobby". React error
// boundaries don't self-heal, so that user is stuck FOREVER and can never enter
// the event — not even after the host starts.
//
// `navigator.mediaDevices` is undefined in in-app browsers/WebViews (opening the
// event link inside TikTok / Instagram / LinkedIn) and in non-secure contexts.
//
// Playwright's WebKit exposes no mediaDevices either — which makes it a faithful
// simulation. NOTE: unlike ux-7, this spec deliberately does NOT polyfill a
// synthetic camera. The whole point is a browser with NO camera API at all.
//
// THE BAR: a camera-less/in-app-browser user must join gracefully (receiver
// mode) — never a crashed Lobby, and never blocked from the event.

let webkitB: Browser, chromeB: Browser;
let host: TestUser; let webview: TestUser; let desk: TestUser;
const ctxs: BrowserContext[] = [];
let pW: Page, pD: Page;
let hostSock: Socket;
let podId = '', sessionId = '';

/** The Lobby error boundary's crash state — must NEVER appear. */
const lobbyCrashed = (page: Page) =>
  page.getByText(/Something went wrong in Lobby/i).count().then(c => c > 0).catch(() => false);

async function open(browser: Browser, u: TestUser, mobile: boolean): Promise<Page> {
  const ctx = await browser.newContext(
    mobile ? { ...devices['iPhone 13'] } : { viewport: { width: 1280, height: 800 } },
  );
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return page;
}

test.beforeAll(async () => {
  host = await createTestUser('ux8host', 'super_admin');
  webview = await createTestUser('ux8webview');
  desk = await createTestUser('ux8desk');
  const pod = await createPod(host, 'E2E UX8 InApp Pod'); podId = pod.id;
  await addPodMember(host, podId, webview.id);
  await addPodMember(host, podId, desk.id);
  const sess = await createSession(host, podId, 'VERIFY in-app webview no camera', new Date(Date.now() + 60_000), {
    numberOfRounds: 1, roundDurationSeconds: 150, ratingWindowSeconds: 25,
  });
  sessionId = sess.id;
  await registerForSession(webview, sessionId);
  await registerForSession(desk, sessionId);
  webkitB = await webkit.launch({ headless: false });
  chromeB = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  try { hostSock?.close(); } catch {}
  try { await webkitB?.close(); } catch {}
  try { await chromeB?.close(); } catch {}
  await cleanup(pool, { ids: [host?.id, webview?.id, desk?.id].filter(Boolean), podId });
});

test('a camera-less in-app browser joins the event gracefully — Lobby never crashes, user never blocked', async () => {
  test.setTimeout(300_000);
  hostSock = await connectSocket(host);

  // The in-app-browser user (WebKit, NO camera API at all) + a normal desktop user.
  pW = await open(webkitB, webview, true);
  pD = await open(chromeB, desk, false);
  await wait(10_000);

  // (1) WAITING ROOM — the DeviceTest preview renders here, which is where the
  //     crash struck. A camera-less browser must degrade, not blow up.
  await pW.screenshot({ path: 'test-results/ux8-webview-waiting.png' }).catch(() => {});
  expect(await lobbyCrashed(pW),
    'in-app browser (no camera API) must NOT crash the Lobby in the waiting room').toBe(false);
  console.log('  ✓ waiting room: no Lobby crash on a camera-less in-app browser.');

  // (2) HOST STARTS — the camera-less user must reach the main room like anyone
  //     else. On the buggy build the error boundary is stuck and never does.
  hostSock.emit('host:start_session', { sessionId }); await wait(4000);
  await expect.poll(() => inLobby(pW),
    { timeout: 60_000, message: 'camera-less in-app-browser user MUST reach the main room (was permanently stuck on the crashed Lobby)' }).toBe(true);
  await expect.poll(() => inLobby(pD),
    { timeout: 60_000, message: 'normal desktop user must reach the main room' }).toBe(true);
  expect(await lobbyCrashed(pW), 'no Lobby crash in the main room either').toBe(false);
  await pW.screenshot({ path: 'test-results/ux8-webview-mainroom.png' }).catch(() => {});
  console.log('  ✓ camera-less user reached the main room (receiver mode).');

  // (3) ROUND 1 — a camera-less participant is still a real participant: they
  //     get matched and enter their breakout.
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(8000);
  await expect.poll(() => inBreakout(pW),
    { timeout: 60_000, message: 'camera-less user must be matched into a breakout like anyone else' }).toBe(true);
  expect(await lobbyCrashed(pW), 'no Lobby crash after the round starts').toBe(false);
  console.log('  ✓ camera-less user entered its breakout — a full participant, just without video.');

  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(5000);
});
