import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';
import axios from 'axios';

// HEADED smoke for WS2 slice 2 (kick semantics) against PRODUCTION:
//   Round with 4 participants → 2 pairs. Host kicks P1a mid-round:
//     - P1a sees "removed from this event" (no rating form for the kicked);
//     - the SURVIVOR P1b gets the "didn't return" rating form IMMEDIATELY
//       (the kick used to orphan the match entirely) → skip → main room,
//       and is NOT re-paired;
//     - P1a's re-register attempt is rejected (REMOVED_FROM_EVENT) — kicked
//       users used to be silently resurrected to 'registered'.
//   Pair2 is untouched and keeps the round ROUND_ACTIVE so the survivor's
//   per-cause copy isn't overlaid by a round-end broadcast.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser;
let users: TestUser[] = [];
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

async function readBreakoutSeconds(page: Page): Promise<number | null> {
  const texts = await page.locator('span.font-mono').allInnerTexts().catch(() => [] as string[]);
  for (const t of texts) {
    const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  return null;
}

async function waitForBreakout(page: Page, label: string, timeoutMs = 120_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await readBreakoutSeconds(page)) !== null) { console.log(`  ✓ ${label} in breakout`); return; }
    await page.waitForTimeout(1500);
  }
  throw new Error(`${label}: not in breakout within ${timeoutMs}ms`);
}

async function gotoLive(page: Page): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 45_000 });
      return;
    } catch (e) {
      console.log(`  goto attempt ${i} failed: ${(e as Error).message.slice(0, 90)}`);
      if (i === 3) throw e;
      await page.waitForTimeout(5000);
    }
  }
}

async function openUserPage(user: TestUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoLive(page);
  return { context, page };
}

test.beforeAll(async () => {
  host = await createTestUser('ws2khost', 'super_admin');
  users = await Promise.all(['ws2k1', 'ws2k2', 'ws2k3', 'ws2k4'].map((n) => createTestUser(n)));
  const pod = await createPod(host, 'E2E WS2 Kick Pod');
  podId = pod.id;
  for (const u of users) await addPodMember(host, podId, u.id);
  const sess = await createSession(host, podId, 'E2E WS2 Kick Smoke', new Date(Date.now() + 60_000), {
    numberOfRounds: 1,
    roundDurationSeconds: 600,
  });
  sessionId = sess.id;
  await Promise.all(users.map((u) => registerForSession(u, sessionId)));
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
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
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

test('WS2 kick: survivor rates immediately, kicked user gets no form and cannot re-register', async () => {
  test.setTimeout(420_000);

  const sessions = new Map<string, { context: BrowserContext; page: Page }>();
  for (const u of users) sessions.set(u.id, await openUserPage(u));
  await sessions.get(users[0].id)!.page.waitForTimeout(9000);

  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  let latestPairs: Array<{ a: string; b: string }> = [];
  hostSock.on('host:match_preview', (data: any) => {
    latestPairs = (data?.matches || []).map((m: any) => ({ a: m.participantA?.userId, b: m.participantB?.userId }));
  });
  hostSock.emit('session:join', { sessionId });
  await sessions.get(users[0].id)!.page.waitForTimeout(2000);

  let pairs: Array<{ a: string; b: string }> = [];
  for (let attempt = 1; attempt <= 8; attempt++) {
    latestPairs = [];
    hostSock.emit('host:generate_matches', { sessionId });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && latestPairs.length === 0) {
      await sessions.get(users[0].id)!.page.waitForTimeout(500);
    }
    console.log(`  preview attempt ${attempt}: ${latestPairs.length} pairs`);
    pairs = latestPairs;
    if (pairs.length === 2) break;
    await sessions.get(users[0].id)!.page.waitForTimeout(4000);
  }
  console.log('  pairs:', JSON.stringify(pairs));
  expect(pairs.length, '4 participants must yield 2 pairs').toBe(2);
  hostSock.emit('host:confirm_round', { sessionId });

  const byId = (id: string) => users.find((u) => u.id === id)!;
  const P1a = byId(pairs[0].a), P1b = byId(pairs[0].b);

  for (const u of users) await waitForBreakout(sessions.get(u.id)!.page, u.displayName);

  // ── Host kicks P1a mid-round ──
  console.log(`  host kicks ${P1a.displayName}…`);
  const p1aPage = sessions.get(P1a.id)!.page;
  const p1bPage = sessions.get(P1b.id)!.page;
  const t0 = Date.now();
  hostSock.emit('host:remove_participant', { sessionId, userId: P1a.id, reason: 'e2e kick test' });

  // Survivor: rating form immediately (no grace, no orphaned room).
  await expect(p1bPage.getByText(/didn.t return/i).first(), 'P1b (survivor) gets the rating form immediately')
    .toBeVisible({ timeout: 15_000 });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`  ✓ survivor form appeared ${elapsed}s after the kick`);
  await p1bPage.screenshot({ path: 'test-results/ws2k-01-survivor-rating.png' }).catch(() => {});

  // Kicked user: removal message, and NO rating form.
  await expect(p1aPage.getByText(/removed from this event/i).first(), 'P1a sees the removal message')
    .toBeVisible({ timeout: 15_000 });
  const p1aHasForm = await p1aPage.getByText(/Rate your conversation|didn.t return/i).first().isVisible().catch(() => false);
  expect(p1aHasForm, 'the kicked user must NOT get a rating form').toBe(false);
  await p1aPage.screenshot({ path: 'test-results/ws2k-02-kicked-message.png' }).catch(() => {});

  // Survivor skips → main room, and is NOT re-paired.
  await p1bPage.getByText('Skip', { exact: true }).first().click().catch(() => {});
  await p1bPage.waitForTimeout(3000);
  expect(await readBreakoutSeconds(p1bPage), 'P1b must be OUT of the breakout after rating').toBeNull();
  await p1bPage.waitForTimeout(8000);
  expect(await readBreakoutSeconds(p1bPage), 'P1b must NOT be re-paired into a new room').toBeNull();

  // ── Banned from re-entry: the REST register endpoint must 403 ──
  const reg = await axios.post(`${SERVER}/api/sessions/${sessionId}/register`, {}, {
    headers: { Authorization: `Bearer ${P1a.accessToken}` },
    validateStatus: () => true,
  });
  console.log(`  re-register attempt: HTTP ${reg.status} code=${reg.data?.error?.code}`);
  expect(reg.status, 'kicked user re-register must be rejected').toBe(403);
  expect(reg.data?.error?.code, 'distinct REMOVED_FROM_EVENT code').toBe('REMOVED_FROM_EVENT');

  // S12 — a kicked user RELOADING the live page (socket rejoin path) must be
  // explicitly evicted, never silently half-joined into the lobby.
  await p1aPage.reload({ waitUntil: 'commit' }).catch(() => {});
  await p1aPage.waitForTimeout(8000);
  const backInLobby = await p1aPage.locator('video').count().catch(() => 0);
  console.log(`  kicked user after reload: videos=${backInLobby}`);
  expect(backInLobby, 'kicked user must NOT re-enter the lobby on reload').toBe(0);

  console.log('✓ WS2 kick smoke complete: survivor rated immediately, kicked user formless + banned (REST + socket rejoin)');
});
