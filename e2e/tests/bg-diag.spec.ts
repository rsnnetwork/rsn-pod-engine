import { test, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// One-off diagnostic: what does the live page actually show on the preview?
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, alice: TestUser;
let podId: string, sessionId: string;
let browser: Browser;

function connectSocket(user: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: user.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 10000);
  });
}

test.beforeAll(async () => {
  host = await createTestUser('bgdhost', 'super_admin');
  alice = await createTestUser('bgdalice');
  const pod = await createPod(host, 'E2E BG Diag Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  const sess = await createSession(host, podId, 'E2E BG Diag', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await registerForSession(alice, sessionId);
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();
  browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist'],
  });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('diagnose live page state on preview', async () => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
    localStorage.setItem('rsn_bg_debug', '1');
  }, { a: alice.accessToken, r: alice.refreshToken });
  const page = await context.newPage();
  page.on('console', (m) => console.log(`  [${m.type()}] ${m.text().slice(0, 200)}`));
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));

  const share = process.env.E2E_VERCEL_SHARE;
  if (share) {
    const resp = await page.goto(`${APP}/?_vercel_share=${share}`, { waitUntil: 'domcontentloaded' });
    console.log(`  share goto status=${resp?.status()} url=${page.url().slice(0, 100)}`);
    await page.waitForTimeout(1500);
  }
  const resp2 = await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  console.log(`  live goto status=${resp2?.status()} url=${page.url().slice(0, 120)}`);
  await page.waitForTimeout(12_000);

  const state = await page.evaluate(() => ({
    url: location.href.slice(0, 120),
    title: document.title,
    bodySnippet: (document.body.innerText || '').slice(0, 400).replace(/\n+/g, ' | '),
    videoCount: document.querySelectorAll('video').length,
    videosWithFrames: Array.from(document.querySelectorAll('video')).filter((v) => (v as HTMLVideoElement).videoWidth > 0).length,
    selfTiles: document.querySelectorAll('[data-self="true"]').length,
    bgButtons: Array.from(document.querySelectorAll('button')).filter((b) =>
      /background effects/i.test((b.getAttribute('aria-label') || '') + (b.getAttribute('title') || ''))).length,
  }));
  console.log('  PAGE STATE:', JSON.stringify(state, null, 2));
  await page.screenshot({ path: 'test-results/bg-diag.png', fullPage: true }).catch(() => {});
  await context.close();
});
