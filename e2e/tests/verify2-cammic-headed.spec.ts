import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — UX2: a remote tile's mic indicator stays in sync
// with LiveKit. Two real browsers: a member (mic) and a super_admin observer.
// The observer sees the member's per-tile mic control reflect "Mute" (mic on);
// when the member mutes, the observer's view must flip to "Unmute" — the
// reactive update the fix added (previously the remote tile could stay stale).
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, mic: TestUser, obs: TestUser;
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
  host = await createTestUser('ux2host', 'super_admin');
  mic = await createTestUser('ux2mic');            // member who toggles their mic
  obs = await createTestUser('ux2obs', 'super_admin'); // observer (host) who sees the per-tile control
  const pod = await createPod(host, 'E2E UX2 Pod'); podId = pod.id;
  await addPodMember(host, podId, mic.id); await addPodMember(host, podId, obs.id);
  const sess = await createSession(host, podId, 'VERIFY UX2 cam/mic', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all([registerForSession(mic, sessionId), registerForSession(obs, sessionId)]);
  browser = await chromium.launch({ headless: false, slowMo: 400, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('UX2: a member muting flips their mic indicator in the observer\'s view', async () => {
  test.setTimeout(180_000);

  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);

  // Two real browsers, side by side.
  const micCtx = await browser.newContext({ viewport: { width: 760, height: 720 } });
  await micCtx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: mic.accessToken, r: mic.refreshToken });
  const micPage = await micCtx.newPage();
  const obsCtx = await browser.newContext({ viewport: { width: 760, height: 720 } });
  await obsCtx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: obs.accessToken, r: obs.refreshToken });
  const obsPage = await obsCtx.newPage();

  console.log('  >>> opening member + observer browsers on prod <<<');
  await gotoRetry(micPage, `${APP}/session/${sessionId}/live`);
  await gotoRetry(obsPage, `${APP}/session/${sessionId}/live`);
  await micPage.waitForTimeout(9000); // let both join the LiveKit lobby
  await obsPage.waitForTimeout(2000);

  // The observer's per-tile control for the member: "Mute <name>" when mic is ON,
  // "Unmute <name>" when mic is OFF — it must track the member's real LiveKit state.
  const muteCtrl = obsPage.getByRole('button', { name: new RegExp(`Mute ${mic.displayName}`, 'i') });
  const unmuteCtrl = obsPage.getByRole('button', { name: new RegExp(`Unmute ${mic.displayName}`, 'i') });
  const micBtn = () => micPage.locator('button[aria-label="Mic on"], button[aria-label="Mic off"]').first();
  await expect(micBtn(), 'member should have a Mic toggle').toBeVisible({ timeout: 25_000 });

  // Baseline: drive the member mic ON, then confirm the observer reflects it ("Mute").
  if ((await micBtn().getAttribute('aria-label')) === 'Mic off') { await micBtn().click(); await micPage.waitForTimeout(2000); }
  await expect(muteCtrl, 'observer should reflect the member as mic-ON').toBeVisible({ timeout: 20_000 });
  await obsPage.screenshot({ path: 'test-results/verify2-before-mute.png' }).catch(() => {});
  console.log('  baseline set: member mic ON, observer shows "Mute".');

  // THE FIX: member mutes → observer's view must REACTIVELY flip to "Unmute".
  console.log('  >>> member clicks Mute — WATCH the observer\'s tile control flip <<<');
  await micBtn().click(); // Mic on → mute
  await expect(unmuteCtrl, 'observer\'s view must reactively flip to "Unmute" when the member mutes (THE FIX)').toBeVisible({ timeout: 20_000 });
  await obsPage.screenshot({ path: 'test-results/verify2-after-mute.png' }).catch(() => {});
  console.log('  observer reactively updated to "Unmute" — indicator in sync.');
  await obsPage.waitForTimeout(4000);

  await micCtx.close(); await obsCtx.close();
  console.log('  ✓ UX2 verified headed on prod: remote mic indicator updated live on mute.');
});
