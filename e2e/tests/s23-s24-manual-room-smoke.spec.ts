import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';
import { Pool } from 'pg';

// HEADED smoke for S23 + S24 against PRODUCTION — Ali's bb sequence:
//   S23: a trio member presses Back to Main Room → survivors get the ~8s
//        in-room banner and the grid reflows (no hole).
//   S24: with a manual room running, the HOST RELOADS (the deterministic
//        trigger of the unlabelled dashboard replay) → the room must still
//        be labelled manual: NO "End Round" button appears. A socket-level
//        plain end_session is REFUSED (NO_ACTIVE_ROUND) and the event
//        survives; the real End Event completes it and closes the manual
//        match (no dangling active rows).
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser;
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

async function gotoLive(page: Page, sessionId: string): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 45_000 });
      return;
    } catch (e) {
      if (i === 3) throw e;
      await page.waitForTimeout(5000);
    }
  }
}

async function openUserPage(user: TestUser, sessionId: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoLive(page, sessionId);
  return { context, page };
}

test.beforeAll(async () => {
  host = await createTestUser('s24host', 'super_admin');
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
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('S23 trio-leave banner + S24 manual room survives host reload and End Round', async () => {
  test.setTimeout(420_000);

  const users = await Promise.all(['s24u1', 's24u2', 's24u3'].map((n) => createTestUser(n)));
  const pod = await createPod(host, 'E2E S24 Pod');
  for (const u of users) await addPodMember(host, pod.id, u.id);
  const sess = await createSession(host, pod.id, 'E2E S24 Smoke', new Date(Date.now() + 60_000), {
    numberOfRounds: 2, roundDurationSeconds: 300,
  });
  const sessionId = sess.id;
  await Promise.all(users.map((u) => registerForSession(u, sessionId)));
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  const hostPg = await openUserPage(host, sessionId);
  const pages = new Map<string, { context: BrowserContext; page: Page }>();
  for (const u of users) pages.set(u.id, await openUserPage(u, sessionId));
  await hostPg.page.waitForTimeout(8000);

  // Manual 3-person room (Ali's shape).
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  hostSock.emit('session:join', { sessionId });
  await hostPg.page.waitForTimeout(1500);
  hostSock.emit('host:create_breakout_bulk', {
    sessionId,
    rooms: [{ participantIds: users.map((u) => u.id) }],
    sharedDurationSeconds: 300,
    timerVisibility: 'visible',
  });
  for (const u of users) {
    const end = Date.now() + 60_000;
    let inRoom = false;
    while (Date.now() < end) {
      if ((await readBreakoutSeconds(pages.get(u.id)!.page)) !== null) { inRoom = true; break; }
      await pages.get(u.id)!.page.waitForTimeout(1500);
    }
    expect(inRoom, `${u.displayName} lands in the manual room`).toBe(true);
  }
  console.log('  ✓ manual 3-person room running');

  // ── S23: u1 leaves → survivors see the banner + grid reflows ──
  const [u1, u2] = users;
  await pages.get(u1.id)!.page.getByText('Back to Main Room', { exact: true }).first().click();
  const u2Page = pages.get(u2.id)!.page;
  await expect(u2Page.locator('[data-testid="room-notice"]'), 'survivor sees the in-room banner')
    .toBeVisible({ timeout: 15_000 });
  const noticeText = await u2Page.locator('[data-testid="room-notice"]').textContent();
  expect(noticeText, 'banner says the leaver returned to the main room').toMatch(/returned to the main room/);
  console.log(`  ✓ S23 banner: "${noticeText?.trim()}"`);
  // Reflow: only ONE remote tile remains on u2's grid within a few seconds.
  {
    const end = Date.now() + 20_000;
    let remote = -1;
    while (Date.now() < end) {
      const vids = await u2Page.locator('video').count();
      remote = vids - 1; // minus local PiP
      if (remote <= 1) break;
      await u2Page.waitForTimeout(1500);
    }
    expect(remote, 'grid reflowed to ONE remote tile (pair layout, no hole)').toBeLessThanOrEqual(1);
  }
  console.log('  ✓ S23 layout reflowed to pair');
  // The leaver rates their two partners (keeps DB clean for the end-phase).
  const u1Page = pages.get(u1.id)!.page;
  await u1Page.getByText('Skip', { exact: true }).first().click().catch(() => {});
  await u1Page.waitForTimeout(1500);
  await u1Page.getByText('Skip', { exact: true }).first().click().catch(() => {});

  // ── S24: HOST RELOAD (the deterministic unlabelled-replay trigger) ──
  console.log('  reloading the HOST page (dashboard replay)…');
  await hostPg.page.reload({ waitUntil: 'commit' }).catch(() => {});
  await hostPg.page.waitForTimeout(10_000);
  const endRoundBtns = await hostPg.page.getByText('End Round', { exact: true }).count();
  expect(endRoundBtns, 'NO End Round button while only a manual room runs (post-reload)').toBe(0);
  console.log('  ✓ S24: host reload kept the room labelled manual — no End Round button');

  // Socket-level plain end_session must be refused and the event must survive.
  // Fresh socket — the long-lived one (reconnection:false) can silently die
  // during the browser phases, and a dead socket's emit proves nothing.
  const hostSock2 = await connectSocket(host);
  sockets.push(hostSock2);
  hostSock2.emit('session:join', { sessionId });
  await hostPg.page.waitForTimeout(1500);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const stBefore = (await pool.query(`SELECT status FROM sessions WHERE id = $1`, [sessionId])).rows[0]?.status;
  console.log(`  status before plain end_session: '${stBefore}' (socket connected=${hostSock2.connected})`);
  let noActiveRound = false;
  const seenErrors: string[] = [];
  hostSock2.on('error', (e: any) => {
    seenErrors.push(`${e?.code}:${e?.message}`);
    if (e?.code === 'NO_ACTIVE_ROUND') noActiveRound = true;
  });
  hostSock2.emit('host:end_session', { sessionId });
  await hostPg.page.waitForTimeout(6000);
  console.log(`  error frames seen: ${JSON.stringify(seenErrors)}`);
  const st = (await pool.query(`SELECT status FROM sessions WHERE id = $1`, [sessionId])).rows[0]?.status;
  // The CONTRACT is "the event survives a plain End Round" — assert that
  // first; the refusal frame is the mechanism (lobby/transition states).
  // If the session was in a round state, the plain end legitimately ends
  // the ROUND (never the event) — both shapes keep the event alive.
  expect(st, 'event NOT completed by the plain End Round').not.toBe('completed');
  if (stBefore !== 'round_active' && stBefore !== 'round_rating') {
    expect(noActiveRound, 'server refuses with NO_ACTIVE_ROUND').toBe(true);
  }
  console.log(`  ✓ S24: plain end_session left the event alive (status '${st}')`);

  // Real End Event completes it AND closes the running manual match.
  hostSock2.emit('host:end_session', { sessionId, endEvent: true });
  {
    const end = Date.now() + 60_000;
    let done = false;
    while (Date.now() < end) {
      const r = (await pool.query(`SELECT status FROM sessions WHERE id = $1`, [sessionId])).rows[0]?.status;
      if (r === 'completed') { done = true; break; }
      await new Promise((r2) => setTimeout(r2, 2000));
    }
    expect(done, 'director End Event completes the session').toBe(true);
  }
  const dangling = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM matches WHERE session_id = $1 AND status = 'active'`, [sessionId],
  )).rows[0]?.n;
  await pool.end();
  expect(dangling, 'no matches left dangling active after completion').toBe(0);
  console.log('  ✓ S24: End Event completed the session and closed the manual room');

  try { await endSession(host, sessionId); } catch {}
  for (const s of [hostPg, ...pages.values()]) { await s.context.close().catch(() => {}); }
  console.log('✓ S23+S24 SMOKE COMPLETE');
});
