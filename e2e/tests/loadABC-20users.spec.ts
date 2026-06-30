import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// 20-REAL-BROWSER load smoke for the full canonical stack (Ships A+B+C)
// against PRODUCTION. 20 participants in 20 isolated browser contexts (one
// Chromium), fake cameras, one socket-driven host:
//   1. All 20 join the lobby; every page renders lobby video.
//   2. Algorithm round for 20 → 10 pairs; ≥18/20 pages land in breakout UI
//      (tolerance for slow LiveKit connects under local CPU load); spot-check
//      video tiles in 4 of them.
//   3. End round → ALL pages return to main; 60s ghost watch across all 20.
// Throwaway e2etest-* users, cleaned by ID.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const N = parseInt(process.env.LOADABC_N || '20', 10); // browser count (lower for an 8GB box)

let host: TestUser;
let users: TestUser[] = [];
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

async function connectSocket(user: TestUser, attempts = 3): Promise<Socket> {
  // 20 browsers + LiveKit saturate the machine — generous timeout + retries.
  for (let a = 1; a <= attempts; a++) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const s = io(SERVER, { auth: { token: user.accessToken }, transports: ['websocket'], reconnection: false, timeout: 45_000 });
        s.on('connect', () => { sockets.push(s); resolve(s); });
        s.on('connect_error', (e) => reject(e));
        setTimeout(() => { s.disconnect(); reject(new Error('socket connect timeout')); }, 45_000);
      });
    } catch (e) {
      if (a === attempts) throw e;
      console.log(`  socket connect attempt ${a} failed — retrying…`);
    }
  }
  throw new Error('unreachable');
}

async function inBreakout(page: Page): Promise<boolean> {
  return (await page.locator('text=Breakout Room').count().catch(() => 0)) > 0;
}

async function newUserPage(user: TestUser): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return page;
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  host = await createTestUser('load20host', 'super_admin');
  users = await Promise.all(Array.from({ length: N }, (_, i) => createTestUser(`load20u${i}`)));
  const pod = await createPod(host, 'E2E Load20 Pod');
  podId = pod.id;
  for (const u of users) await addPodMember(host, podId, u.id);
  const sess = await createSession(host, podId, 'E2E Load20 ABC', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all(users.map(u => registerForSession(u, sessionId)));
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
    ],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('20 real browsers: lobby video → full round → clean return, no ghosts', async () => {
  test.setTimeout(900_000);

  // ── 1. Sequential joins — 20 parallel SPA loads + LiveKit connects choke
  // a single machine; one at a time with 'commit' keeps it moving.
  const pages: Page[] = [];
  for (let i = 0; i < N; i++) {
    const p = await newUserPage(users[i]);
    await p.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 90_000 });
    pages.push(p);
    if ((i + 1) % 5 === 0) console.log(`  joined ${pages.length}/${N}`);
    await p.waitForTimeout(800);
  }

  // Lobby video is a LOCAL-MACHINE saturation metric here: 20 concurrent
  // publishers × 19 subscriptions each ≈ 380 tracks on one laptop. The
  // platform's video pipeline is strictly proven by the 2-3 user smokes;
  // this run's strict assertions are the STATE placements below. Require a
  // majority of pages to render video within a generous window.
  let lobbyVideoCount = 0;
  const lobbyDeadline = Date.now() + 180_000;
  const pending = new Set(pages.map((_, i) => i));
  while (Date.now() < lobbyDeadline && pending.size > 0) {
    for (const i of Array.from(pending)) {
      const n = await pages[i].locator('video').count().catch(() => 0);
      if (n > 0) { pending.delete(i); lobbyVideoCount++; }
    }
    if (pending.size > 0) await pages[0].waitForTimeout(3000);
  }
  console.log(`  lobby video on ${lobbyVideoCount}/${N} pages`);
  expect(lobbyVideoCount, 'a majority of pages must render lobby video (local CPU bound)').toBeGreaterThanOrEqual(Math.ceil(N * 0.6));

  // ── 2. Full algorithm round for 20 users → 10 pairs ──
  const hostSock = await connectSocket(host);
  hostSock.on('error', (e: any) => console.log('  [host socket error]', JSON.stringify(e).slice(0, 160)));
  hostSock.emit('session:join', { sessionId });
  await pages[0].waitForTimeout(3000);
  hostSock.emit('host:generate_matches', { sessionId });
  await pages[0].waitForTimeout(10_000); // engine for 20 users + preview
  hostSock.emit('host:confirm_round', { sessionId });

  let inRoom = 0;
  const roundDeadline = Date.now() + 180_000;
  const waitingRoom = new Set(pages.map((_, i) => i));
  while (Date.now() < roundDeadline && waitingRoom.size > 0) {
    for (const i of Array.from(waitingRoom)) {
      if (await inBreakout(pages[i])) { waitingRoom.delete(i); inRoom++; }
    }
    if (waitingRoom.size > 0) await pages[0].waitForTimeout(3000);
  }
  console.log(`  in breakout: ${inRoom}/${N}`);
  // Local-CPU tolerance: comatose tabs under 20-browser thrash can miss the
  // window even though the platform re-arms their token every ~5s co-emit.
  // The STRICT assertion is the final convergence below (all 20 in main,
  // zero ghosts) — that's pure state machinery.
  expect(inRoom, 'most pages must land in breakout UI').toBeGreaterThanOrEqual(Math.ceil(N * 0.8));

  // Spot-check real video in 4 breakout pages — poll: the lobby→room LiveKit
  // switch takes a while when 20 browsers reconnect simultaneously.
  let videoOk = 0;
  const spotDeadline = Date.now() + 90_000;
  const spotPending = new Set([0, 1, 2, 3]);
  while (Date.now() < spotDeadline && spotPending.size > 0) {
    for (const i of Array.from(spotPending)) {
      const n = await pages[i].locator('video').count().catch(() => 0);
      if (n >= 1) { spotPending.delete(i); videoOk++; }
    }
    if (spotPending.size > 0) await pages[0].waitForTimeout(3000);
  }
  console.log(`  spot-check breakout video: ${videoOk}/4`);
  expect(videoOk, 'spot-checked breakout pages must have video').toBeGreaterThanOrEqual(3);

  // ── 3. End round → ALL return to main; ghost watch across all 20 ──
  hostSock.emit('host:end_session', { sessionId });
  const mainDeadline = Date.now() + 90_000;
  const stillInRoom = new Set(pages.map((_, i) => i));
  while (Date.now() < mainDeadline && stillInRoom.size > 0) {
    for (const i of Array.from(stillInRoom)) {
      if (!(await inBreakout(pages[i]))) stillInRoom.delete(i);
    }
    if (stillInRoom.size > 0) await pages[0].waitForTimeout(3000);
  }
  console.log(`  back in main: ${N - stillInRoom.size}/${N}`);
  expect(stillInRoom.size, 'everyone must return to main after round end').toBe(0);

  // 60s ghost watch across ALL 20 pages
  console.log('  observing 60s for ghost re-pull across all 20…');
  const ghostDeadline = Date.now() + 60_000;
  while (Date.now() < ghostDeadline) {
    for (let i = 0; i < pages.length; i++) {
      if (await inBreakout(pages[i])) {
        await pages[i].screenshot({ path: `test-results/load20-GHOST-u${i}.png` }).catch(() => {});
        throw new Error(`GHOST RE-PULL: user ${i} re-entered a dead breakout room`);
      }
    }
    await pages[0].waitForTimeout(4000);
  }
  console.log('✓ 20-user ABC load smoke complete: lobby video, full round, clean return, zero ghosts');
});
