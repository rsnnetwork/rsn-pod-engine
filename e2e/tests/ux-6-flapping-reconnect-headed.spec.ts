import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';
import {
  connectSocket, openParticipant, rateViaForm, cleanup, wait,
  inLobby, inRating, inBreakout, tilesSeen, Socket,
} from '../helpers/live-ui';

// HEADED PROD — 14 Jul live test: alihammza on a slow mobile had his socket
// DROP + reconnect 7+ times in 4 minutes (a reconnect storm). The server kept
// re-sending him to the main room, but each drop reset his client before it
// landed, so he was STUCK at 'checked_in' after round 1 — and refresh couldn't
// outrun the drops.
//
// This reproduces that: p1's connection FLAPS (offline/online) through the
// round-end, then STEADIES. The bar: once the network steadies, p1 must
// recover into the main room on its own within a few seconds — never stuck.
let browser: Browser;
let host: TestUser;
const P: TestUser[] = [];
const ctxs: BrowserContext[] = [];
let hostSock: Socket;
let podId = '', sessionId = '';
const NP = 3;
const pageOf = (i: number) => ctxs[i].pages()[0];

async function pollAll(fn: (p: Page) => Promise<boolean>, label: string, timeout = 60_000) {
  await expect.poll(async () => (await Promise.all(P.map((_, i) => fn(pageOf(i))))).filter(Boolean).length,
    { timeout, message: label }).toBe(NP);
}
/** Simulate a reconnect storm on one context: offline/online cycles. */
async function flap(ctx: BrowserContext, cycles: number, offMs = 4000, onMs = 3000) {
  for (let i = 0; i < cycles; i++) {
    await ctx.setOffline(true); await wait(offMs);
    await ctx.setOffline(false); await wait(onMs);
  }
}

test.beforeAll(async () => {
  host = await createTestUser('uxfhost', 'super_admin');
  for (let i = 1; i <= NP; i++) P.push(await createTestUser(`uxfp${i}`));
  const pod = await createPod(host, 'E2E UXFlap Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY flapping reconnect', new Date(Date.now() + 60_000), {
    numberOfRounds: 2, roundDurationSeconds: 150, ratingWindowSeconds: 25,
  });
  sessionId = sess.id;
  await Promise.all(P.map(u => registerForSession(u, sessionId)));
  browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  try { hostSock?.close(); } catch {}
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [host?.id, ...P.map(p => p.id)].filter(Boolean), podId });
});

test('a flapping mobile connection is never left stuck — auto-recovers to the main room when it steadies', async () => {
  test.setTimeout(360_000);
  hostSock = await connectSocket(host);
  for (const u of P) await openParticipant(browser, ctxs, sessionId, u);
  await wait(5000);
  hostSock.emit('host:start_session', { sessionId }); await wait(3000);
  await pollAll(inLobby, 'all in lobby after start');

  // Round 1 → breakouts.
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(7000);
  await pollAll(inBreakout, 'round 1: all in breakouts');

  // Round 1 ends → everyone returns to main (round_transition).
  hostSock.emit('host:end_session', { sessionId }); await wait(4000); // → ROUND_RATING
  for (let i = 0; i < NP; i++) if (await inRating(pageOf(i))) await rateViaForm(pageOf(i), { stars: 4 });
  hostSock.emit('host:force_close_rating', { sessionId });            // → ROUND_TRANSITION
  await pollAll(inLobby, 'round 1: all returned to main (pre-storm)', 45_000);

  // ── p1's connection STORMS: long offline windows that EXPIRE the 15s
  //    disconnect grace (→ marked 'left'), then short churny reconnects —
  //    exactly alihammza's trace (dropped 7+ times, marked 'left' at 15:33:47).
  console.log('  >>> p1 storm: 18s offline (grace expires → left) + churn, x2 <<<');
  await flap(ctxs[0], 2, 18_000, 6_000); // 2 long drops past the 15s grace, then reconnect
  await ctxs[0].setOffline(false); // network now STEADY
  console.log('  >>> p1 network steadied — a churned/"left" client must recover to main, no refresh <<<');

  // THE BAR: p1 auto-recovers into the main room within seconds of steadying.
  await expect.poll(() => inLobby(pageOf(0)),
    { timeout: 45_000, message: 'flapping p1 must RECOVER into the main room once the network steadies (never stuck)' }).toBe(true);
  await expect.poll(() => tilesSeen(pageOf(0)),
    { timeout: 45_000, message: 'recovered p1 must see the others (converged, not alone)' }).toBeGreaterThanOrEqual(2);
  await pageOf(0).screenshot({ path: 'test-results/uxf-recovered.png' }).catch(() => {});
  console.log('  ✓ p1 recovered into a converged main room after the reconnect storm.');

  // And p1 can still take part in round 2.
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(7000);
  await pollAll(inBreakout, 'round 2: recovered p1 + all enter breakouts');
  console.log('  ✓ recovered p1 joined round 2 normally.');

  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  for (let i = 0; i < NP; i++) if (await inRating(pageOf(i))) await rateViaForm(pageOf(i), { stars: 4 });
  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(6000);
});
