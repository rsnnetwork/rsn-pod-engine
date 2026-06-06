import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';
import { Pool } from 'pg';

// HEADED smoke for S17 + S18 against PRODUCTION (live-test 2026-06-06, b1):
//   S17 — host mute/unmute must be FAST and must STICK. The unmute relay
//     used to race ahead of the LiveKit permission restore → PublishTrackError
//     → "host unmuted but the tile shows mute". Asserts the target's own mic
//     state flips within seconds in BOTH directions.
//   S18a — a survivor who reloads mid-rating-window must get back exactly
//     the partners they haven't rated (incl. the DEPARTED member) — the
//     replay used to rebuild from slots only and bail after any rating.
//   S18b — terminal states are terminal: after End Event the session status
//     must NEVER flip back (b1: completed → round_rating stomp 3s later).
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

async function waitForBreakout(page: Page, label: string, timeoutMs = 120_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await readBreakoutSeconds(page)) !== null) { console.log(`  ✓ ${label} in breakout`); return; }
    await page.waitForTimeout(1500);
  }
  throw new Error(`${label}: not in breakout within ${timeoutMs}ms`);
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

async function currentPartnerName(page: Page): Promise<string | null> {
  const t = await page.getByText(/How was your chat with/i).first().textContent().catch(() => null);
  return t ? t.replace(/\s+/g, ' ').trim() : null;
}

async function rateOne(page: Page, label: string): Promise<void> {
  const before = await currentPartnerName(page);
  await page.locator('button:has(svg.lucide-star)').nth(3).click();
  await page.getByText('Submit Rating', { exact: true }).first().click();
  const deadline = Date.now() + 12_000;
  let advanced = false;
  while (Date.now() < deadline) {
    const failed = await page.getByText(/Failed to submit/i).first().isVisible().catch(() => false);
    expect(failed, `${label}: rating submit must not fail`).toBe(false);
    const now = await currentPartnerName(page);
    if (now === null || now !== before) { advanced = true; break; }
    await page.waitForTimeout(800);
  }
  expect(advanced, `${label}: the form must ADVANCE after submit`).toBe(true);
  console.log(`  ✓ ${label}: submitted + advanced`);
}

// Wait until the user's OWN mic button reports the wanted state; returns ms taken.
async function waitMicState(page: Page, on: boolean, label: string, timeoutMs: number): Promise<number> {
  const want = on ? 'Mic on' : 'Mic off';
  const t0 = Date.now();
  const end = t0 + timeoutMs;
  while (Date.now() < end) {
    if (await page.locator(`button[aria-label="${want}"]`).first().isVisible().catch(() => false)) {
      const ms = Date.now() - t0;
      console.log(`  ✓ ${label}: mic ${on ? 'ON' : 'OFF'} after ${ms}ms`);
      return ms;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`${label}: mic did not become ${want} within ${timeoutMs}ms`);
}

test.beforeAll(async () => {
  host = await createTestUser('s17host', 'super_admin');
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

test('S17 mute round-trip + S18 mid-rating reload + terminal-state lock', async () => {
  test.setTimeout(600_000);

  const users = await Promise.all(['s17u1', 's17u2', 's17u3'].map((n) => createTestUser(n)));
  const pod = await createPod(host, 'E2E S17S18 Pod');
  for (const u of users) await addPodMember(host, pod.id, u.id);
  const sess = await createSession(host, pod.id, 'E2E S17S18 Smoke', new Date(Date.now() + 60_000), {
    numberOfRounds: 1, roundDurationSeconds: 90,
  });
  const sessionId = sess.id;
  await Promise.all(users.map((u) => registerForSession(u, sessionId)));
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  const sessions = new Map<string, { context: BrowserContext; page: Page }>();
  const hostPg = await openUserPage(host, sessionId);
  for (const u of users) sessions.set(u.id, await openUserPage(u, sessionId));
  await hostPg.page.waitForTimeout(9000);

  // ── S17: mute/unmute round trip on u1 ──
  const u1 = users[0];
  const u1Page = sessions.get(u1.id)!.page;
  // Participants join auto-muted — u1 unmutes themself first.
  await u1Page.locator('button[aria-label="Mic off"]').first().click();
  await waitMicState(u1Page, true, 'u1 self-unmute', 10_000);

  // The host's tile button reflects the LiveKit track — wait for it.
  const muteBtn = hostPg.page.locator(`button[title="Mute ${u1.displayName}"]`).first();
  await expect(muteBtn, 'host sees the Mute button on u1’s tile').toBeVisible({ timeout: 20_000 });
  await muteBtn.click();
  const muteMs = await waitMicState(u1Page, false, 'HOST MUTE → u1 muted', 8_000);
  expect(muteMs, 'mute lands fast').toBeLessThan(6_000);

  // THE FIXED PATH: unmute must restore the mic (pre-fix: PublishTrackError, stuck muted).
  const unmuteBtn = hostPg.page.locator(`button[title="Unmute ${u1.displayName}"]`).first();
  await expect(unmuteBtn, 'host sees Unmute on u1’s tile').toBeVisible({ timeout: 15_000 });
  await unmuteBtn.click();
  const unmuteMs = await waitMicState(u1Page, true, 'HOST UNMUTE → u1 mic restored', 10_000);
  expect(unmuteMs, 'unmute lands fast (permission-before-relay)').toBeLessThan(8_000);
  console.log(`  ✓ S17: mute ${muteMs}ms, unmute ${unmuteMs}ms — both directions stick`);

  // ── S18a: trio → leaver → round end → survivor reloads mid-rating ──
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  let preview = 0;
  hostSock.on('host:match_preview', (d: any) => { preview = (d?.matches || []).length; });
  hostSock.emit('session:join', { sessionId });
  await hostPg.page.waitForTimeout(2000);
  for (let attempt = 1; attempt <= 8 && preview !== 1; attempt++) {
    preview = 0;
    hostSock.emit('host:generate_matches', { sessionId });
    const dl = Date.now() + 10_000;
    while (Date.now() < dl && preview === 0) await hostPg.page.waitForTimeout(500);
    if (preview !== 1) await hostPg.page.waitForTimeout(3000);
  }
  expect(preview, '3 participants form ONE trio').toBe(1);
  hostSock.emit('host:confirm_round', { sessionId });
  for (const u of users) await waitForBreakout(sessions.get(u.id)!.page, u.displayName);

  // u1 leaves the trio after ~35s (room must be >30s old to stay ratable)
  // and submits BOTH early-leave forms.
  await u1Page.waitForTimeout(35_000);
  await u1Page.getByText('Back to Main Room', { exact: true }).first().click();
  await expect(u1Page.getByText(/Rate your conversation/i).first()).toBeVisible({ timeout: 15_000 });
  await rateOne(u1Page, 'leaver form 1');
  await rateOne(u1Page, 'leaver form 2');

  // Round (90s) ends on its own; survivors get 2-partner forms.
  const u2 = users[1];
  const u2Page = sessions.get(u2.id)!.page;
  await expect(u2Page.getByText(/How was your chat with/i).first(), 'survivor u2 gets the round-end form')
    .toBeVisible({ timeout: 120_000 });
  const firstPartner = await currentPartnerName(u2Page);
  await rateOne(u2Page, 'u2 form 1 (before reload)');

  // RELOAD MID-WINDOW — the replay must re-send exactly the UNRATED partner
  // (pre-S18: slots-only list, and any prior rating killed the replay).
  await u2Page.reload({ waitUntil: 'commit' }).catch(() => {});
  await expect(u2Page.getByText(/How was your chat with/i).first(),
    'after reload u2 gets the REMAINING partner form (per-edge replay)')
    .toBeVisible({ timeout: 30_000 });
  const remainingPartner = await currentPartnerName(u2Page);
  expect(remainingPartner, 'the replayed form is for a DIFFERENT (unrated) partner').not.toBe(firstPartner);
  await rateOne(u2Page, 'u2 form 2 (after reload — the departed/unrated partner)');
  console.log('  ✓ S18a: mid-rating reload re-served exactly the unrated partner');

  // ── S18b: End Event → status must stay terminal ──
  hostSock.emit('host:end_session', { sessionId });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const watchEnd = Date.now() + 25_000;
  let sawCompleted = false;
  while (Date.now() < watchEnd) {
    const r = await pool.query(`SELECT status FROM sessions WHERE id = $1`, [sessionId]);
    const st = r.rows[0]?.status;
    if (st === 'completed') sawCompleted = true;
    expect(sawCompleted ? st : 'completed', 'status NEVER leaves completed once terminal (b1 stomp)').toBe('completed');
    await new Promise((r2) => setTimeout(r2, 2000));
  }
  await pool.end();
  console.log('  ✓ S18b: status stayed completed for 25s of post-end churn');

  try { await endSession(host, sessionId); } catch {}
  for (const s of [hostPg, ...sessions.values()]) { await s.context.close().catch(() => {}); }
  console.log('✓ S17+S18 SMOKE COMPLETE');
});
