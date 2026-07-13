import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';
import {
  connectSocket, openParticipant, rateViaForm, cleanup, wait,
  inLobby, inRating, inBreakout, tilesSeen, gotoRetry, APP, Socket,
} from '../helpers/live-ui';

// HEADED PROD — refresh recovery (Stefan #3). A participant hits F5 mid-event:
//   (a) during the between-rounds lobby, and
//   (b) during the closing lobby.
// Assert they RECOVER — land back in a converged main room, see the others,
// enter the next round, never stuck on a stale/"old live session" screen.
let browser: Browser;
let host: TestUser;
const P: TestUser[] = [];
const ctxs: BrowserContext[] = [];
let hostSock: Socket;
let podId = '', sessionId = '';
const NP = 4;
const pageOf = (i: number) => ctxs[i].pages()[0];

async function pollAll(fn: (p: Page) => Promise<boolean>, label: string, timeout = 45_000) {
  await expect.poll(async () => (await Promise.all(P.map((_, i) => fn(pageOf(i))))).filter(Boolean).length,
    { timeout, message: label }).toBe(NP);
}
async function pollConverged(label: string, timeout = 60_000) {
  await expect.poll(async () => (await Promise.all(P.map((_, i) => tilesSeen(pageOf(i))))).filter(c => c >= 2).length,
    { timeout, message: label }).toBe(NP);
}
async function rateAll() {
  for (let i = 0; i < NP; i++) await rateViaForm(pageOf(i), { stars: 5, meetAgain: i % 2 === 0 });
}

test.beforeAll(async () => {
  host = await createTestUser('uxrhost', 'super_admin');
  for (let i = 1; i <= NP; i++) P.push(await createTestUser(`uxrp${i}`));
  const pod = await createPod(host, 'E2E UXRefresh Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY refresh recovery', new Date(Date.now() + 60_000), {
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

test('F5 refresh recovers to a converged room — between rounds AND in the closing lobby', async () => {
  test.setTimeout(600_000);
  hostSock = await connectSocket(host);
  for (const u of P) await openParticipant(browser, ctxs, sessionId, u);
  await wait(5000);
  hostSock.emit('host:start_session', { sessionId }); await wait(3000);
  await pollAll(inLobby, 'all in lobby after start');

  // ── Round 1 → rating → all rate → between-rounds lobby ──────────────────────
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(7000);
  await pollAll(inBreakout, 'round 1: all in breakouts');
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  await pollAll(inRating, 'round 1: rating form shown');
  await rateAll();
  await pollAll(inLobby, 'round 1: back to lobby (between rounds)');
  await pollConverged('round 1: between-rounds lobby converged (pre-refresh)');

  // ── (a) REFRESH during the between-rounds lobby ─────────────────────────────
  console.log('  >>> F5 refresh p1 during the between-rounds lobby <<<');
  await gotoRetry(pageOf(0), `${APP}/session/${sessionId}/live`);
  await expect.poll(() => inLobby(pageOf(0)), { timeout: 45_000, message: 'refreshed p1 must recover to the lobby (not a stale/old-session screen)' }).toBe(true);
  await expect.poll(() => tilesSeen(pageOf(0)), { timeout: 45_000, message: 'refreshed p1 must see the others again' }).toBeGreaterThanOrEqual(2);
  console.log('  ✓ (a) between-rounds F5 recovered to a converged lobby.');

  // The refreshed participant must still be able to enter the NEXT round.
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(7000);
  await pollAll(inBreakout, 'round 2: refreshed participant + all enter breakouts');
  console.log('  ✓ refreshed p1 entered round 2 normally.');

  // ── Round 2 (last) → rating → all rate → closing lobby ──────────────────────
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  await pollAll(inRating, 'round 2: rating form shown');
  await rateAll();
  await pollConverged('round 2: closing lobby converged (pre-refresh)');

  // ── (b) REFRESH during the closing lobby ────────────────────────────────────
  console.log('  >>> F5 refresh p2 during the closing lobby <<<');
  await gotoRetry(pageOf(1), `${APP}/session/${sessionId}/live`);
  await expect.poll(() => tilesSeen(pageOf(1)), { timeout: 60_000, message: 'refreshed p2 must recover into the converged closing lobby' }).toBeGreaterThanOrEqual(2);
  console.log('  ✓ (b) closing-lobby F5 recovered to a converged lobby.');

  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(7000);
  await expect.poll(async () => (await Promise.all(P.map((_, i) => inBreakout(pageOf(i))))).filter(Boolean).length,
    { timeout: 45_000, message: 'no one stuck in a breakout after End Event' }).toBe(0);
  console.log('  ✓ event ended cleanly after both refreshes.');
});
