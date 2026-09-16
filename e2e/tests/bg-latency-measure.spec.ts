import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// MEASUREMENT spec (no pass/fail thresholds beyond sanity) — quantifies the
// current BG pipeline on prod so the architectural fix has a hard baseline:
//   M1 first apply:   click Office → processed track attached → visually applied
//   M2 switch:        Office → Nature with pipeline live (switchTo path)
//   M3 off→on:        None then Blur (current destroy → full MediaPipe rebuild cost)
//   M4 transition:    main → breakout — gap until BG is back on the new room's track
//   M5 memory:        JS heap at each checkpoint
// Prints a table at the end. Run headed.
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

/** id of the MediaStreamTrack currently feeding the self-view video element.
 *  When a processor attaches, LiveKit swaps the element's track to the
 *  generator's output — the id change is the precise "pipeline attached" signal. */
async function selfTrackId(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const vids = Array.from(document.querySelectorAll('video')) as HTMLVideoElement[];
      for (const v of vids) {
        const ms = v.srcObject as MediaStream | null;
        const t = ms?.getVideoTracks?.()[0];
        if (t) return t.id; // first video tile = self-view in both rooms for alice
      }
      return null;
    })
    .catch(() => null);
}

/** Temporal activity of the self-view: mean abs pixel diff between two frames
 *  ~250ms apart, downscaled. The fake camera is an animated pattern (high);
 *  a static virtual background collapses most of the frame to static (low). */
async function temporalActivity(page: Page): Promise<number> {
  return page
    .evaluate(async () => {
      const v = document.querySelector('video') as HTMLVideoElement | null;
      if (!v || v.videoWidth === 0) return -1;
      const w = 120, h = 68;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) return -1;
      ctx.drawImage(v, 0, 0, w, h);
      const a = ctx.getImageData(0, 0, w, h).data;
      await new Promise((r) => setTimeout(r, 250));
      ctx.drawImage(v, 0, 0, w, h);
      const b = ctx.getImageData(0, 0, w, h).data;
      let acc = 0;
      for (let i = 0; i < a.length; i += 4) acc += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      return acc / (w * h);
    })
    .catch(() => -1);
}

async function heapMB(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const m = (performance as any).memory;
      return m ? Math.round(m.usedJSHeapSize / 1048576) : -1;
    })
    .catch(() => -1);
}

async function savedPref(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('rsn_bg_preference')).catch(() => null);
}

async function readBreakoutSeconds(page: Page): Promise<number | null> {
  const texts = await page.locator('span.font-mono').allInnerTexts().catch(() => [] as string[]);
  for (const t of texts) {
    const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  return null;
}

/** Poll until predicate returns truthy; resolve elapsed ms (or -1 on timeout). */
async function timeUntil(fn: () => Promise<boolean>, timeoutMs: number, pollMs = 150): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return -1;
}

test.beforeAll(async () => {
  host = await createTestUser('bglhost', 'super_admin');
  alice = await createTestUser('bglalice');
  bob = await createTestUser('bglbob');
  const pod = await createPod(host, 'E2E BG Latency Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E BG Latency', new Date(Date.now() + 60_000));
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
      '--enable-precise-memory-info',
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

test('measure BG apply / switch / rebuild / transition latencies on prod', async () => {
  test.setTimeout(420_000);
  const M: Record<string, number | string> = {};

  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
    localStorage.setItem('rsn_bg_debug', '1');
  }, { a: alice.accessToken, r: alice.refreshToken });
  const page = await context.newPage();
  let bgTimeouts = 0;
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('bg_timeout')) bgTimeouts++;
    if (t.startsWith('[bg]')) console.log('  ' + t.slice(0, 180));
    else if (m.type() === 'error') console.log('  [console.error]', t.slice(0, 160));
  });

  const share = process.env.E2E_VERCEL_SHARE;
  if (share) { await page.goto(`${APP}/?_vercel_share=${share}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500); }
  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);

  const bgBtn = page.getByRole('button', { name: 'Background effects' });
  await expect(bgBtn).toBeVisible({ timeout: 20_000 });

  // Wait for self-view frames.
  await expect.poll(() => selfTrackId(page), { timeout: 20_000 }).not.toBeNull();
  const rawTrack = await selfTrackId(page);
  const actRaw = await temporalActivity(page);
  M['heap_baseline_MB'] = await heapMB(page);
  M['temporal_raw'] = actRaw.toFixed(1);
  console.log(`baseline: track=${rawTrack} activity=${actRaw.toFixed(1)} heap=${M['heap_baseline_MB']}MB`);

  // ---- M1: first apply (Office image) — full pipeline init path ----
  await bgBtn.click();
  const dialog = page.getByRole('dialog', { name: 'Choose background' });
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const t1 = Date.now();
  await dialog.getByText('Office', { exact: true }).click();
  M['M1_attach_ms'] = await timeUntil(async () => (await selfTrackId(page)) !== rawTrack, 45_000);
  // visual confirmation: activity collapses once a static image dominates
  M['M1_visual_ms'] = await timeUntil(async () => {
    const a = await temporalActivity(page);
    return a >= 0 && a < actRaw * 0.45;
  }, 45_000, 300);
  M['M1_total_click_to_visual_ms'] = Date.now() - t1;
  M['heap_after_apply_MB'] = await heapMB(page);
  M['M1_bg_timeout_fired'] = String(bgTimeouts > 0);
  M['M1_pref_after_apply'] = (await savedPref(page)) ?? 'null';
  await page.screenshot({ path: 'test-results/bgl-01-office.png' }).catch(() => {});
  console.log(`M1 first apply: attach=${M['M1_attach_ms']}ms visual=${M['M1_visual_ms']}ms timeouts=${bgTimeouts} pref=${M['M1_pref_after_apply']} heap=${M['heap_after_apply_MB']}MB`);

  // If the first apply hit bg_timeout the pref was never saved even though the
  // processor attached late (state divergence — a key finding). Do what a real
  // user does: click it again. Measures the warm-retry path.
  if (!String(M['M1_pref_after_apply']).includes('office')) {
    await bgBtn.click();
    await expect(dialog).toBeVisible({ timeout: 5000 });
    const tRetry = Date.now();
    await dialog.getByText('Office', { exact: true }).click();
    M['M1b_retry_pref_ms'] = await timeUntil(async () => ((await savedPref(page)) ?? '').includes('office'), 30_000, 100);
    M['M1b_retry_total_ms'] = Date.now() - tRetry;
    console.log(`M1b warm retry: pref=${M['M1b_retry_pref_ms']}ms`);
  }

  // ---- M2: live switch Office → Nature (switchTo path) ----
  await page.waitForTimeout(4000); // let pipeline settle past warmup
  const trackBeforeSwitch = await selfTrackId(page);
  await bgBtn.click();
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const t2 = Date.now();
  await dialog.getByText('Nature', { exact: true }).click();
  M['M2_pref_ms'] = await timeUntil(async () => ((await savedPref(page)) ?? '').includes('nature'), 20_000, 100);
  M['M2_total_ms'] = Date.now() - t2;
  M['M2_track_changed'] = String((await selfTrackId(page)) !== trackBeforeSwitch);
  console.log(`M2 switch: pref=${M['M2_pref_ms']}ms total=${M['M2_total_ms']}ms trackChanged=${M['M2_track_changed']}`);

  // ---- M3: None → Blur (current destroy + full rebuild cost) ----
  await page.waitForTimeout(2000);
  await bgBtn.click();
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.getByText('None', { exact: true }).click();
  await expect.poll(() => savedPref(page), { timeout: 15_000 }).toBe('{"mode":"disabled"}');
  await page.waitForTimeout(2000);
  const trackAfterOff = await selfTrackId(page);
  const actOff = await temporalActivity(page);
  await bgBtn.click();
  await expect(dialog).toBeVisible({ timeout: 5000 });
  const t3 = Date.now();
  await dialog.getByText('Blur', { exact: true }).click();
  M['M3_attach_ms'] = await timeUntil(async () => (await selfTrackId(page)) !== trackAfterOff, 45_000);
  M['M3_total_ms'] = Date.now() - t3;
  M['heap_after_reenable_MB'] = await heapMB(page);
  console.log(`M3 off→on rebuild: attach=${M['M3_attach_ms']}ms (off activity=${actOff.toFixed(1)}) heap=${M['heap_after_reenable_MB']}MB`);

  // ---- M4: main → breakout transition gap ----
  const hostSock = await connectSocket(host);
  const bobSock = await connectSocket(bob);
  sockets.push(hostSock, bobSock);
  hostSock.emit('session:join', { sessionId });
  bobSock.emit('session:join', { sessionId });
  await page.waitForTimeout(2500);
  const tBreakoutCmd = Date.now();
  hostSock.emit('host:create_breakout_bulk', {
    sessionId,
    rooms: [{ participantIds: [alice.id, bob.id] }],
    sharedDurationSeconds: 300,
    timerVisibility: 'visible',
  });

  let inBreakout: number | null = null;
  for (let i = 0; i < 25 && inBreakout === null; i++) {
    await page.waitForTimeout(1000);
    inBreakout = await readBreakoutSeconds(page);
  }
  expect(inBreakout, 'alice should be routed into the breakout').not.toBeNull();
  M['M4_routed_ms'] = Date.now() - tBreakoutCmd;

  // time until breakout video frames exist at all
  const tVid = Date.now();
  await expect.poll(() => selfTrackId(page), { timeout: 30_000 }).not.toBeNull();
  M['M4_video_live_ms'] = Date.now() - tVid;
  const breakoutRawTrack = await selfTrackId(page);

  // time until the processor re-attaches in the breakout (track swaps again)
  M['M4_bg_reattach_ms'] = await timeUntil(async () => {
    const id = await selfTrackId(page);
    return id !== null && id !== breakoutRawTrack;
  }, 60_000, 200);
  M['M4_total_cmd_to_bg_ms'] = Date.now() - tBreakoutCmd;
  M['heap_in_breakout_MB'] = await heapMB(page);
  await page.screenshot({ path: 'test-results/bgl-02-breakout.png' }).catch(() => {});
  console.log(`M4 transition: routed=${M['M4_routed_ms']}ms videoLive=${M['M4_video_live_ms']}ms bgReattach=${M['M4_bg_reattach_ms']}ms`);

  // ---- report ----
  console.log('\n================ BG LATENCY BASELINE (prod, current architecture) ================');
  for (const [k, v] of Object.entries(M)) console.log(`  ${k.padEnd(34)} ${v}`);
  console.log('==================================================================================\n');

  hostSock.emit('host:end_breakout_all', { sessionId });
  await context.close();
});
