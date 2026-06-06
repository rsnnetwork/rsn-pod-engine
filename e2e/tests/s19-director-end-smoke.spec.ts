import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';
import axios from 'axios';
import { Pool } from 'pg';

// HEADED smoke for S19 against PRODUCTION — only the DIRECTOR ends the event.
//   1. Co-host's End Event button is DISABLED with the why.
//   2. Co-host's direct socket host:end_session {endEvent:true} is REFUSED
//      (DIRECTOR_ONLY) and the session status never completes.
//   3. Co-host can still END A ROUND (round control stays).
//   4. The director's End Event completes the session.
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
  host = await createTestUser('s19host', 'super_admin');
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

test('S19: co-host cannot end the event (button disabled + server refusal); director can', async () => {
  test.setTimeout(420_000);

  // Three users: u1 becomes a CO-HOST (excluded from matching), so u2+u3
  // remain the matchable pair for the round-control phase.
  const users = await Promise.all(['s19u1', 's19u2', 's19u3'].map((n) => createTestUser(n)));
  const [u1, u2] = users;
  const pod = await createPod(host, 'E2E S19 Pod');
  for (const u of users) await addPodMember(host, pod.id, u.id);
  const sess = await createSession(host, pod.id, 'E2E S19 Smoke', new Date(Date.now() + 60_000), {
    numberOfRounds: 2, roundDurationSeconds: 300,
  });
  const sessionId = sess.id;
  await Promise.all(users.map((u) => registerForSession(u, sessionId)));

  // Promote u1 to co-host via the S16 REST endpoint.
  await axios.post(`${SERVER}/api/sessions/${sessionId}/cohosts/${u1.id}`, {}, {
    headers: { Authorization: `Bearer ${host.accessToken}` },
  });

  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  const u1Pg = await openUserPage(u1, sessionId);
  const u2Pg = await openUserPage(u2, sessionId);
  const u3Pg = await openUserPage(users[2], sessionId);
  await u1Pg.page.waitForTimeout(8000);

  // 1. Co-host sees End Event DISABLED with the why.
  const endBtn = u1Pg.page.locator('button[title="Only the host can end the event"]').first();
  await expect(endBtn, 'co-host End Event button carries the director-only tooltip').toBeVisible({ timeout: 20_000 });
  await expect(endBtn, 'co-host End Event button is disabled').toBeDisabled();
  console.log('  ✓ co-host sees End Event DISABLED ("Only the host can end the event")');

  // 2. Direct socket attempt is refused.
  const u1Sock = await connectSocket(u1);
  sockets.push(u1Sock);
  let directorOnlyError = false;
  u1Sock.on('error', (e: any) => { if (e?.code === 'DIRECTOR_ONLY') directorOnlyError = true; });
  u1Sock.emit('session:join', { sessionId });
  await u1Pg.page.waitForTimeout(1500);
  u1Sock.emit('host:end_session', { sessionId, endEvent: true });
  await u1Pg.page.waitForTimeout(5000);
  expect(directorOnlyError, 'server refuses with DIRECTOR_ONLY').toBe(true);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const st1 = (await pool.query(`SELECT status FROM sessions WHERE id = $1`, [sessionId])).rows[0]?.status;
  expect(st1, 'session NOT completed by the co-host').not.toBe('completed');
  console.log(`  ✓ co-host end-event REFUSED (status stays '${st1}')`);

  // 3. Co-host round control still works: start a round, then co-host ends it.
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  let preview = 0;
  hostSock.on('host:match_preview', (d: any) => { preview = (d?.matches || []).length; });
  hostSock.emit('session:join', { sessionId });
  await u1Pg.page.waitForTimeout(1500);
  for (let attempt = 1; attempt <= 8 && preview !== 1; attempt++) {
    preview = 0;
    hostSock.emit('host:generate_matches', { sessionId });
    const dl = Date.now() + 10_000;
    while (Date.now() < dl && preview === 0) await u1Pg.page.waitForTimeout(500);
    if (preview !== 1) await u1Pg.page.waitForTimeout(3000);
  }
  expect(preview, '2 participants form one pair').toBe(1);
  hostSock.emit('host:confirm_round', { sessionId });
  {
    const end = Date.now() + 90_000;
    let inRoom = false;
    while (Date.now() < end) {
      if ((await readBreakoutSeconds(u2Pg.page)) !== null) { inRoom = true; break; }
      await u2Pg.page.waitForTimeout(1500);
    }
    expect(inRoom, 'pair lands in a breakout').toBe(true);
  }
  // Past 30s so the round-end is ratable, then the CO-HOST ends the round.
  await u2Pg.page.waitForTimeout(32_000);
  u1Sock.emit('host:end_session', { sessionId }); // no endEvent — round end only
  await expect(u2Pg.page.getByText(/How was your chat with/i).first(),
    'co-host END ROUND still works (rating form appears)').toBeVisible({ timeout: 20_000 });
  console.log('  ✓ co-host can still end a ROUND (round control intact)');

  // 4. The DIRECTOR ends the event (one press, from rating phase).
  hostSock.emit('host:end_session', { sessionId, endEvent: true });
  {
    const end = Date.now() + 60_000;
    let completed = false;
    while (Date.now() < end) {
      const st = (await pool.query(`SELECT status FROM sessions WHERE id = $1`, [sessionId])).rows[0]?.status;
      if (st === 'completed') { completed = true; break; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(completed, "director's End Event completes the session").toBe(true);
  }
  await pool.end();
  console.log('  ✓ director End Event completed the session');

  try { await endSession(host, sessionId); } catch {}
  for (const s of [u1Pg, u2Pg, u3Pg]) { await s.context.close().catch(() => {}); }
  console.log('✓ S19 SMOKE COMPLETE: director-only end-event browser-proven');
});
