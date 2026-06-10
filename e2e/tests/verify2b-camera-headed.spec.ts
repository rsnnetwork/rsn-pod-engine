import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — UX2 (camera, both rooms). A member toggles their
// CAMERA; the observer's tile must show it ON when on and OFF when off, in the
// MAIN ROOM and in a BREAKOUT room. Turning a camera off mutes (not unpublishes)
// the track, so the fix had to be mute-aware in both views.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

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
const gotoRetry = async (page: any, url: string) => {
  for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } }
};

test.beforeAll(async () => {
  host = await createTestUser('v2chost', 'super_admin');
  cam = await createTestUser('v2ccam');   // member who toggles their camera
  obs = await createTestUser('v2cobs');    // member who observes
  const pod = await createPod(host, 'E2E UX2 Camera Pod'); podId = pod.id;
  await addPodMember(host, podId, cam.id); await addPodMember(host, podId, obs.id);
  const sess = await createSession(host, podId, 'VERIFY UX2 camera', new Date(Date.now() + 60_000), { numberOfRounds: 1 });
  sessionId = sess.id;
  await Promise.all([registerForSession(cam, sessionId), registerForSession(obs, sessionId)]);
  browser = await chromium.launch({ headless: false, slowMo: 400, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

const camBtn = (page: any) => page.locator('button[aria-label="Camera on"], button[aria-label="Camera off"]').first();
const ensureCamOn = async (page: any) => { if ((await camBtn(page).getAttribute('aria-label')) === 'Camera off') { await camBtn(page).click(); await page.waitForTimeout(2500); } };

test('UX2 camera: tile shows camera ON/OFF correctly in the main room AND a breakout', async () => {
  test.setTimeout(220_000);

  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);

  const camCtx = await browser.newContext({ viewport: { width: 800, height: 720 } });
  await camCtx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: cam.accessToken, r: cam.refreshToken });
  const camPage = await camCtx.newPage();
  const obsCtx = await browser.newContext({ viewport: { width: 800, height: 720 } });
  await obsCtx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: obs.accessToken, r: obs.refreshToken });
  const obsPage = await obsCtx.newPage();

  console.log('  >>> opening camera + observer browsers on prod <<<');
  await gotoRetry(camPage, `${APP}/session/${sessionId}/live`);
  await gotoRetry(obsPage, `${APP}/session/${sessionId}/live`);
  await camPage.waitForTimeout(9000);

  // ── MAIN ROOM ──────────────────────────────────────────────────────────────
  await ensureCamOn(camPage);
  await obsPage.waitForTimeout(2500);
  const videosOn = await obsPage.locator('video').count();
  console.log(`  [main room] camera ON → observer sees ${videosOn} video element(s)`);
  await obsPage.screenshot({ path: 'test-results/verify2b-main-camON.png' }).catch(() => {});

  console.log('  >>> [main room] member turns camera OFF — WATCH the observer tile go to avatar <<<');
  await camBtn(camPage).click(); // Camera on → off
  await expect.poll(async () => obsPage.locator('video').count(), { timeout: 20_000, message: 'observer should lose the member video when the camera goes off' }).toBeLessThan(videosOn);
  await obsPage.screenshot({ path: 'test-results/verify2b-main-camOFF.png' }).catch(() => {});
  console.log('  [main room] ✓ camera off reflected (video count dropped)');

  await camBtn(camPage).click(); // back on
  await expect.poll(async () => obsPage.locator('video').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(videosOn);
  console.log('  [main room] ✓ camera back on reflected');

  // ── BREAKOUT ROOM ──────────────────────────────────────────────────────────
  console.log('  host: match → start round → cam+obs into a breakout...');
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(9000);

  await ensureCamOn(camPage);
  await obsPage.waitForTimeout(2500);
  // In the breakout, the observer's tile for the member shows the member's name;
  // when the camera is OFF it shows "<name> — camera off".
  const camOffText = obsPage.getByText(new RegExp(`${cam.displayName}\\s*—\\s*camera off`, 'i'));
  await expect(camOffText, 'before turning off, the member should NOT show "camera off"').toHaveCount(0);

  console.log('  >>> [breakout] member turns camera OFF — WATCH observer tile show "camera off" <<<');
  await camBtn(camPage).click(); // off
  await expect(camOffText.first(), 'breakout observer tile must show "<member> — camera off" when the camera is off (THE FIX)').toBeVisible({ timeout: 20_000 });
  await obsPage.screenshot({ path: 'test-results/verify2b-breakout-camOFF.png' }).catch(() => {});
  console.log('  [breakout] ✓ "camera off" shown');

  await camBtn(camPage).click(); // on
  await expect(camOffText, 'breakout observer tile must return to video when the camera is back on').toHaveCount(0, { timeout: 20_000 });
  console.log('  [breakout] ✓ camera back on reflected');
  await obsPage.waitForTimeout(3000);

  await camCtx.close(); await obsCtx.close();
  console.log('  ✓ UX2 CAMERA verified headed on prod: accurate ON/OFF in main room AND breakout.');
});
