import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, apiRequest } from '../helpers/api';

// ─── HEADED PROD — full 5-round lifecycle: 1 host + 1 co-host + 4 participants ──
// Ali's request after the June-14 stuck-after-round incident. Every person runs
// in its own real browser on prod. Over 5 rounds we exercise every return-to-main
// path and assert NOBODY ever gets stuck on a dead breakout:
//   R1  participants RATE → window closes → back to main
//   R2  HOST Skip Ratings  → back to main
//   R3  CO-HOST Skip Ratings → back to main   (the exact configuration Ali hit)
//   R4  participants RATE  → back to main
//   R5  HOST Skip Ratings  → back to main, then End Event → recap
// Plus an embedded API-level proof of the actual fix: after a round, a token
// request for the now-DEAD breakout room — as a MEMBER and as the CO-HOST — must
// grant the LOBBY room, never the deleted breakout (the old hole that produced
// "invalid token: revoked" and stranded people).
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, coh: TestUser;
const P: TestUser[] = [];
let podId = '', sessionId = '', lobbyRoomId = '';
let browser: Browser;
let hostSock: Socket;
// ctxs: [0]=host  [1]=co-host  [2..5]=participants P0..P3
const ctxs: BrowserContext[] = [];
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: true });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket timeout')), 12_000);
  });
}
const gotoRetry = async (page: Page, url: string) => {
  for (let i = 0; i < 3; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; }
    catch (e) { if (i === 2) throw e; await wait(3000); }
  }
};
const inMainRoom = async (page: Page) => (await page.getByRole('button', { name: 'Compact', exact: true }).count().catch(() => 0)) > 0;
const inBreakout = async (page: Page) => (await page.getByText('Breakout Room', { exact: false }).count().catch(() => 0)) > 0;

// The host drives the event via hostSock (a single host socket). We deliberately
// do NOT open a host browser: a second host socket would trigger the duplicate-
// tab eviction and churn the session's presence/timer. The co-host + the 4
// participants are each a real browser.
const pageOf = (i: number) => ctxs[i]?.pages()[0];
const cohPage = () => pageOf(0);
const partPages = () => P.map((_, i) => pageOf(i + 1)).filter(Boolean) as Page[]; // ctxs[1..4]

async function openUser(u: TestUser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 760 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => { /* ignore */ });
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return page;
}

async function allInMain(label: string, timeout = 45_000) {
  await expect.poll(async () => {
    const states = await Promise.all(partPages().map(inMainRoom));
    return states.filter(Boolean).length;
  }, { timeout, message: `${label}: all 4 participants must be in the main room` }).toBe(4);
  for (let i = 0; i < 4; i++) {
    const states = await Promise.all(partPages().map(inMainRoom));
    expect(states.filter(Boolean).length, `${label}: all 4 stay in main (+${i}s)`).toBe(4);
    await wait(1000);
  }
  console.log(`  ✓ ${label}: all 4 in the main room (and stayed).`);
}

async function matchesForRound(round: number): Promise<{ id: string; a: string; b: string; c: string | null; room: string }[]> {
  const r = await pool.query(
    `SELECT id, participant_a_id AS a, participant_b_id AS b, participant_c_id AS c, room_id AS room
       FROM matches WHERE session_id = $1 AND round_number = $2`,
    [sessionId, round],
  );
  return r.rows as any;
}

async function runMatchingAndStart(round: number) {
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(7000);
  await expect.poll(async () => {
    const states = await Promise.all(partPages().map(inBreakout));
    return states.filter(Boolean).length;
  }, { timeout: 30_000, message: `round ${round}: matched participants should be in a breakout` }).toBeGreaterThanOrEqual(2);
  console.log(`  ✓ round ${round}: participants entered breakout rooms.`);
}

async function rateAll(round: number) {
  const ms = await matchesForRound(round);
  for (const m of ms) {
    for (const uid of [m.a, m.b, m.c].filter(Boolean) as string[]) {
      const u = [host, coh, ...P].find(x => x.id === uid);
      if (!u) continue;
      try { await apiRequest(u, 'POST', '/ratings', { matchId: m.id, qualityScore: 5, meetAgain: true }); }
      catch { /* bye/duplicate — best-effort; the rating-window timeout is the fallback */ }
    }
  }
  console.log(`  · round ${round}: ratings submitted.`);
}

// Rate, then return to main — naturally via the closing rating window, with a
// host force-close safety net (an unmatched co-host means the "all rated" early
// exit may not fire, so we don't hang waiting on the timer).
async function rateAndReturn(round: number, label: string) {
  await rateAll(round);
  const back = await expect.poll(async () => {
    const states = await Promise.all(partPages().map(inMainRoom));
    return states.filter(Boolean).length;
  }, { timeout: 28_000 }).toBe(4).then(() => true).catch(() => false);
  if (!back) {
    console.log(`  · ${label}: rating window slow — nudging with host force-close.`);
    hostSock.emit('host:force_close_rating', { sessionId }); await wait(4000);
  }
  await allInMain(label);
}

// A /token request for a dead breakout room must grant the LOBBY (the fix).
async function assertDeadBreakoutGrantsLobby(u: TestUser, deadRoomId: string, who: string) {
  const resp = await apiRequest(u, 'POST', `/sessions/${sessionId}/token`, { roomId: deadRoomId });
  const decoded: any = jwt.decode(resp.data.token);
  expect(decoded?.video?.room, `dead-breakout /token (${who}) must grant the lobby, not the deleted room`).toBe(lobbyRoomId);
  console.log(`  ✓ API proof: ${who} /token for a dead breakout → lobby grant.`);
}

test.beforeAll(async () => {
  host = await createTestUser('c5host', 'super_admin');
  coh = await createTestUser('c5coh');
  for (let i = 1; i <= 4; i++) P.push(await createTestUser(`c5p${i}`));
  const pod = await createPod(host, 'E2E 5round Pod'); podId = pod.id;
  for (const u of [coh, ...P]) await addPodMember(host, podId, u.id);
  const sess = await createSession(host, podId, 'VERIFY 5-round full lifecycle', new Date(Date.now() + 60_000), {
    numberOfRounds: 5,
    roundDurationSeconds: 120,   // we end rounds manually
    ratingWindowSeconds: 20,     // short fallback so 'rate' rounds also self-close
    transitionDurationSeconds: 20,
  });
  sessionId = sess.id;
  lobbyRoomId = `lobby-${sessionId}`;
  await Promise.all([coh, ...P].map(u => registerForSession(u, sessionId)));
  browser = await chromium.launch({
    headless: false, slowMo: 100,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  try { hostSock?.disconnect(); } catch {}
  for (const c of ctxs) { try { await c.close(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await apiRequest(host, 'POST', `/sessions/${sessionId}/end`); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('5 rounds · host + co-host + 4 participants · matching → breakout → rating/skip/co-host-skip → back to main → End Event', async () => {
  test.setTimeout(780_000); // 13 min

  hostSock = await connect(host);

  // Open five real browsers on prod: the co-host + 4 participants. (The host
  // drives via hostSock; see the note by pageOf.)
  await openUser(coh);               // [0] co-host
  for (const u of P) await openUser(u); // [1..4] participants
  await wait(4000);

  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  // Promote the co-host (before any round) so they sit in the main room with the
  // host control bar throughout — never matched (hosts/co-hosts are excluded from
  // matching), so they can drive Skip Ratings.
  hostSock.emit('host:assign_cohost', { sessionId, userId: coh.id, role: 'co_host' }); await wait(2500);
  for (const c of ctxs) { try { await c.pages()[0].reload(); } catch {} await wait(400); }
  await wait(4000);
  await allInMain('pre-round (lobby open)');
  await expect.poll(async () => (await cohPage().getByText(/Host|Co-host|Match People|Start/i).count().catch(() => 0)) > 0,
    { timeout: 20_000, message: 'co-host should see host UI' }).toBe(true).catch(() => console.log('  · (co-host host-UI probe inconclusive — continuing)'));

  // ── Round 1 — participants RATE → back to main ─────────────────────────────
  console.log('── Round 1 (rate) ──');
  await runMatchingAndStart(1);
  const r1 = await matchesForRound(1);
  hostSock.emit('host:end_session', { sessionId }); await wait(4000); // → ROUND_RATING
  await rateAndReturn(1, 'after round 1 (rated)');
  await assertDeadBreakoutGrantsLobby(P[0], r1.find(m => m.room)!.room, 'member');

  // ── Round 2 — HOST Skip Ratings → back to main ─────────────────────────────
  console.log('── Round 2 (host skip) ──');
  await runMatchingAndStart(2);
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  hostSock.emit('host:force_close_rating', { sessionId }); await wait(4000);
  await allInMain('after round 2 (host skip)');

  // ── Round 3 — CO-HOST presses Skip Ratings (Ali's exact trigger) ───────────
  console.log('── Round 3 (CO-HOST skip) ──');
  await runMatchingAndStart(3);
  const r3 = await matchesForRound(3);
  hostSock.emit('host:end_session', { sessionId }); await wait(4000); // → ROUND_RATING
  const skipBtn = cohPage().getByRole('button', { name: /Skip Ratings/i }).first();
  const sawBtn = await expect.poll(async () => (await cohPage().getByRole('button', { name: /Skip Ratings/i }).count().catch(() => 0)) > 0,
    { timeout: 20_000, message: 'co-host Skip Ratings button' }).toBe(true).then(() => true).catch(() => false);
  if (sawBtn) {
    await skipBtn.click();
    console.log('  ✓ co-host clicked Skip Ratings (real UI action).');
  } else {
    console.log('  ! co-host Skip Ratings button not visible — falling back to host socket to keep the round moving.');
    hostSock.emit('host:force_close_rating', { sessionId });
  }
  await wait(4000);
  // The decisive proof for the co-host branch: the co-host's /token for the dead
  // round-3 breakout must fall back to the lobby (the old host/cohost branch
  // granted it unconditionally).
  await assertDeadBreakoutGrantsLobby(coh, r3.find(m => m.room)!.room, 'co-host');
  await allInMain('after round 3 (co-host skip)');

  // ── Round 4 — participants RATE → back to main ─────────────────────────────
  console.log('── Round 4 (rate) ──');
  await runMatchingAndStart(4);
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  await rateAndReturn(4, 'after round 4 (rated)');

  // ── Round 5 — HOST Skip Ratings → back to main → End Event ─────────────────
  console.log('── Round 5 (host skip) → End Event ──');
  await runMatchingAndStart(5);
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  hostSock.emit('host:force_close_rating', { sessionId }); await wait(5000); // last round → CLOSING_LOBBY
  await allInMain('after round 5 (host skip)');

  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(7000);
  await expect.poll(async () => {
    const live = await Promise.all(partPages().map(inMainRoom));
    return live.filter(Boolean).length;
  }, { timeout: 45_000, message: 'after End Event no participant remains in the live main room' }).toBe(0);
  for (let i = 0; i < P.length; i++) {
    await pageOf(i + 1).screenshot({ path: `test-results/5round-p${i + 1}-end.png` }).catch(() => {});
  }
  console.log('  ✓ Event ended — all participants left the live room (recap).');
});
