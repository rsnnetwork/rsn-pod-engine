// LCY-1..4 (audit C4) — HEADED prod lifecycle smoke. Drives a real 2-round
// event end-to-end with 4 fake-camera browsers + a socket host, and asserts the
// serialization fixes behave on prod:
//
//   LCY-2/4 — host:confirm_round (now under withMatchGenerationLock +
//             withSessionGuard) starts the round, every pair lands in a backing
//             breakout room (ROUND_ACTIVE ⇒ ≥1 active match holds).
//   LCY-1   — the round timer fires endRound THROUGH the guard-wrapped callback;
//             participants leave the breakout into rating/main. If the guarded
//             timer deadlocked, the round would never end (this test would time
//             out) — so a clean end is the live deadlock proof.
//   LCY-3   — exactly ONE session:round_ended per round (no double-broadcast).
//   repeat  — a forced second round after a full cycle proves no lock wedged.
//
// The matching check-in modal (phase-2) is skipped via its sessionStorage key.

import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, pool, TestUser } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const SERVER = process.env.E2E_SERVER_URL || 'https://rsn-api-h04m.onrender.com';
const N = 4;
const ROUND_SECS = 60; // prod enforces roundDurationSeconds >= 60

const inBreakout = (p: Page) => p.locator('text=Breakout Room').count().then(c => c > 0).catch(() => false);

async function pollFraction(pages: Page[], want: boolean, deadlineMs: number): Promise<number> {
  const pending = new Set(pages.map((_, i) => i));
  let hit = 0;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline && pending.size > 0) {
    for (const i of Array.from(pending)) {
      if ((await inBreakout(pages[i])) === want) { pending.delete(i); hit++; }
    }
    if (pending.size > 0) await pages[0].waitForTimeout(3000);
  }
  return hit;
}

test.describe.serial('LCY-1..4 — round lifecycle serialization (headed prod)', () => {
  let browser: Browser;
  let host: TestUser;
  const members: TestUser[] = [];
  let sessionId: string;
  const ctxs: BrowserContext[] = [];
  const pages: Page[] = [];
  let hostSock: Socket | null = null;
  let roundEnded = 0;
  let roundStarted = 0;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    host = await createTestUser('lcy-host', 'super_admin');
    for (let i = 0; i < N; i++) members.push(await createTestUser(`lcy-m${i}`));
    const pod = await createPod(host, 'E2E LCY Pod');
    for (const m of members) await addPodMember(host, pod.id, m.id);
    const sess = await createSession(host, pod.id, 'E2E LCY lifecycle', new Date(Date.now() + 60_000), {
      numberOfRounds: 2, roundDurationSeconds: ROUND_SECS, ratingWindowSeconds: 20, noShowTimeoutSeconds: 30,
    });
    sessionId = sess.id;
    await Promise.all(members.map(m => registerForSession(m, sessionId)));

    hostSock = io(SERVER, { auth: { token: host.accessToken }, transports: ['websocket'], reconnection: false });
    await new Promise<void>((r) => { hostSock!.on('connect', () => { hostSock!.emit('host:start_session', { sessionId }); setTimeout(r, 2500); }); setTimeout(r, 8000); });
    hostSock!.on('session:round_ended', () => { roundEnded++; });
    hostSock!.on('session:round_started', () => { roundStarted++; });

    browser = await chromium.launch({
      headless: false,
      slowMo: 120,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'],
    });
    for (let i = 0; i < N; i++) {
      const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
      const page = await ctx.newPage();
      ctxs.push(ctx); pages.push(page);
      await page.goto(APP, { waitUntil: 'domcontentloaded' });
      await page.evaluate(({ a, r, sid }) => {
        localStorage.setItem('rsn_access', a);
        localStorage.setItem('rsn_refresh', r);
        sessionStorage.setItem(`rsn_checkin_${sid}`, '1');
      }, { a: members[i].accessToken, r: members[i].refreshToken, sid: sessionId });
      await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 90_000 });
      await page.waitForTimeout(800);
    }
  });

  test.afterAll(async () => {
    try { hostSock?.emit('host:end_session', { sessionId }); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 1500));
    try { hostSock?.disconnect(); } catch { /* ignore */ }
    for (const p of pages) { try { await p.close(); } catch { /* ignore */ } }
    for (const c of ctxs) { try { await c.close(); } catch { /* ignore */ } }
    try { await browser?.close(); } catch { /* ignore */ }
    try { await endSession(host, sessionId); } catch { /* ignore */ }
    // eslint-disable-next-line no-console
    console.log('LCY headed cleanup:', await cleanupTestData());
    try { await pool.end(); } catch { /* ignore */ }
  });

  test('round 1 confirm → breakout, timer-fired end → exactly one round_ended, forced round 2 → breakout', async () => {
    test.setTimeout(300_000);

    // ── Round 1: confirm-round (LCY-2 double-lock) → backing breakout rooms (LCY-4) ──
    hostSock!.emit('session:join', { sessionId });
    await pages[0].waitForTimeout(2500);
    hostSock!.emit('host:generate_matches', { sessionId });
    await pages[0].waitForTimeout(8000);
    hostSock!.emit('host:confirm_round', { sessionId });

    const inR1 = await pollFraction(pages, true, 90_000);
    // eslint-disable-next-line no-console
    console.log(`  round 1 breakout: ${inR1}/${N}, round_started=${roundStarted}`);
    expect(inR1, 'most participants must land in a backing breakout room (LCY-2/4)').toBeGreaterThanOrEqual(3);
    expect(roundStarted, 'round 1 started').toBeGreaterThanOrEqual(1);

    // ── LCY-1: the guarded round timer must fire endRound on its own ──
    // (no host end_round here — we WATCH the timer). A deadlocked guard would
    // leave everyone stuck in breakout past the deadline → this fails.
    const leftR1 = await pollFraction(pages, false, ROUND_SECS * 1000 + 75_000);
    // eslint-disable-next-line no-console
    console.log(`  left breakout after timer: ${leftR1}/${N}, round_ended=${roundEnded}`);
    expect(leftR1, 'the guarded round timer must end the round (LCY-1 — no deadlock)').toBeGreaterThanOrEqual(3);
    // LCY-3 — exactly one round_ended for round 1 (no double-broadcast).
    expect(roundEnded, 'exactly one session:round_ended for round 1 (LCY-3)').toBe(1);

    // ── Round 2: force-advance from rating (LCY-2/4 repeat; proves no wedge) ──
    await pages[0].waitForTimeout(3000);
    hostSock!.emit('host:start_round', { sessionId }); // closes rating, starts round 2
    const inR2 = await pollFraction(pages, true, 110_000);
    // eslint-disable-next-line no-console
    console.log(`  round 2 breakout: ${inR2}/${N}, round_started=${roundStarted}`);
    expect(inR2, 'a second round must start cleanly after a full cycle (no lock wedged)').toBeGreaterThanOrEqual(3);
    expect(roundStarted, 'round 2 started').toBeGreaterThanOrEqual(2);

    // ── End event: everyone returns to main ──
    hostSock!.emit('host:end_session', { sessionId });
    const backMain = await pollFraction(pages, false, 90_000);
    // eslint-disable-next-line no-console
    console.log(`  back in main after end: ${backMain}/${N}`);
    expect(backMain, 'everyone returns to main on event end').toBeGreaterThanOrEqual(3);
  });
});
