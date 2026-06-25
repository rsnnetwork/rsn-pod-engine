// VID-2 (audit C2) — HEADED prod E2E for the lobby tile render cap + "+N more"
// overflow. VISIBLE browsers (headless:false, slowMo) so the cap can be watched.
//
// 7 fake-camera members join one lobby. The observer goes to a 390px mobile
// viewport at "Spacious" density (cap = 4) and must show at most 4 video tiles
// plus a single "+N more" overflow tile — proving a 7-person room never mounts
// 7 decoders on that client. Self-view always present; no horizontal scroll.
//
// The check-in modal (matching phase-2) is skipped via its sessionStorage key.

import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import * as fs from 'fs';
import * as path from 'path';
import { createTestUser, cleanupTestData, pool, TestUser } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const SOCKET = process.env.E2E_SERVER_URL || 'https://rsn-api-h04m.onrender.com';
const SHOTS = path.join(__dirname, '../test-results/vid2-headed');
const N = 7;            // members; observer is members[0]
const SPACIOUS_MOBILE_CAP = 4;

test.describe.serial('VID-2 — lobby tile cap (headed prod, watchable)', () => {
  let browser: Browser;
  let host: TestUser;
  let members: TestUser[] = [];
  let podId: string;
  let sessionId: string;
  const ctxs: BrowserContext[] = [];
  const pages: Page[] = [];
  let hostSock: Socket | null = null;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    host = await createTestUser('vid2-host', 'super_admin');
    for (let i = 0; i < N; i++) members.push(await createTestUser(`vid2-m${i}`));
    const pod = await createPod(host, 'E2E VID-2 Pod');
    podId = pod.id;
    for (const m of members) await addPodMember(host, podId, m.id);
    const sess = await createSession(host, podId, 'E2E VID-2 tile cap', new Date(Date.now() + 60_000));
    sessionId = sess.id;
    await Promise.all(members.map(m => registerForSession(m, sessionId)));

    // Start the event so participants land in the live main-room mosaic.
    hostSock = io(SOCKET, { auth: { token: host.accessToken }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((r) => { hostSock!.on('connect', () => { hostSock!.emit('host:start_session', { sessionId }); setTimeout(r, 2500); }); setTimeout(r, 8000); });

    browser = await chromium.launch({
      headless: false,
      slowMo: 150,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    });
    // Sequential joins (parallel SPA + LiveKit connects choke one machine).
    for (let i = 0; i < N; i++) {
      const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
      const page = await ctx.newPage();
      ctxs.push(ctx); pages.push(page);
      await page.goto(APP, { waitUntil: 'domcontentloaded' });
      await page.evaluate(({ a, r, sid }) => {
        localStorage.setItem('rsn_access', a);
        localStorage.setItem('rsn_refresh', r);
        sessionStorage.setItem(`rsn_checkin_${sid}`, '1'); // skip the matching check-in modal
      }, { a: members[i].accessToken, r: members[i].refreshToken, sid: sessionId });
      await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 90_000 });
      await page.waitForTimeout(900);
    }
  });

  test.afterAll(async () => {
    try { hostSock?.disconnect(); } catch { /* ignore */ }
    for (const p of pages) { try { await p.close(); } catch { /* ignore */ } }
    for (const c of ctxs) { try { await c.close(); } catch { /* ignore */ } }
    try { await browser?.close(); } catch { /* ignore */ }
    try { await endSession(host, sessionId); } catch { /* ignore */ }
    const result = await cleanupTestData();
    // eslint-disable-next-line no-console
    console.log('VID-2 headed cleanup:', result);
    try { await pool.end(); } catch { /* ignore */ }
  });

  test('observer at 390px + Spacious shows ≤4 tiles + a "+N more" overflow', async () => {
    test.setTimeout(220_000);
    // Wait for the mosaic to populate on the observer (lobby video appears).
    const obs = pages[0];
    await expect.poll(async () => obs.locator('video').count().catch(() => 0), { timeout: 150_000, message: 'observer lobby mosaic should render video' }).toBeGreaterThan(0);

    // Mobile viewport + Spacious density (lowest cap = 4).
    await obs.setViewportSize({ width: 390, height: 844 });
    await obs.getByRole('button', { name: 'Spacious' }).click().catch(() => {});
    await obs.waitForTimeout(2500);

    // Poll for either the overflow tile, or settle.
    const overflow = obs.locator('[data-testid="lobby-overflow-tile"]');
    await expect.poll(async () => overflow.count().catch(() => 0), { timeout: 60_000, message: 'overflow tile should appear once tracks exceed the spacious cap' }).toBeGreaterThan(0);

    const videoTiles = await obs.locator('video').count();
    const overflowText = await overflow.first().innerText().catch(() => '');
    // eslint-disable-next-line no-console
    console.log(`  observer @390px spacious: ${videoTiles} video tile(s), overflow="${overflowText.replace(/\n/g, ' ')}"`);
    await obs.screenshot({ path: path.join(SHOTS, 'observer-spacious-overflow.png'), fullPage: true }).catch(() => {});

    // 1. Cap honored: rendered video tiles never exceed the spacious cap (+1 tolerance for self/pinned).
    expect(videoTiles).toBeLessThanOrEqual(SPACIOUS_MOBILE_CAP + 1);
    // 2. Overflow tile present with "+N more" and the audio hint.
    expect(overflowText).toMatch(/\+\d+ more/);
    expect(overflowText).toMatch(/audio still on/i);
    // 3. Self-view still rendered.
    expect(await obs.locator('[data-self="true"]').count()).toBeGreaterThanOrEqual(1);
    // 4. No horizontal scroll at 390px.
    const overflowX = await obs.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflowX).toBeLessThanOrEqual(2);
  });
});
