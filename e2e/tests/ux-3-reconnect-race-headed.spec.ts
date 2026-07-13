import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';
import {
  connectSocket, openParticipant, rateViaForm, cleanup, wait,
  inLobby, inRating, inBreakout, tilesSeen, Socket,
} from '../helpers/live-ui';

// HEADED PROD — reconnect race (#4 dual presence). A participant's network
// DROPS mid-round then comes back (Ali's flaky-mobile scenario). Assert they
// recover into their ONE breakout (not stuck, not kicked, not doubled), their
// partner still sees them, and everyone returns to a converged main room after
// the round — i.e. no lasting stuck/ghost state.
let browser: Browser;
let host: TestUser;
const P: TestUser[] = [];
const ctxs: BrowserContext[] = [];
let hostSock: Socket;
let podId = '', sessionId = '';
const NP = 4;
const pageOf = (i: number) => ctxs[i].pages()[0];

async function pollAll(fn: (p: Page) => Promise<boolean>, label: string, timeout = 60_000) {
  await expect.poll(async () => (await Promise.all(P.map((_, i) => fn(pageOf(i))))).filter(Boolean).length,
    { timeout, message: label }).toBe(NP);
}
async function rateAll() { for (let i = 0; i < NP; i++) await rateViaForm(pageOf(i), { stars: 4, meetAgain: true }); }

test.beforeAll(async () => {
  host = await createTestUser('uxdhost', 'super_admin');
  for (let i = 1; i <= NP; i++) P.push(await createTestUser(`uxdp${i}`));
  const pod = await createPod(host, 'E2E UXDrop Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY reconnect race', new Date(Date.now() + 60_000), {
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

test('mid-round network drop + reconnect recovers into ONE room and returns to main', async () => {
  test.setTimeout(600_000);
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

  // ── p1's network DROPS for ~10s, then returns ──────────────────────────────
  console.log('  >>> p1 goes OFFLINE mid-round (network drop) <<<');
  await ctxs[0].setOffline(true);
  await wait(10_000);
  console.log('  >>> p1 back ONLINE — must recover into its ONE breakout <<<');
  await ctxs[0].setOffline(false);

  // p1 must recover into a breakout (not stuck, not evicted to lobby/kicked).
  await expect.poll(() => inBreakout(pageOf(0)), { timeout: 60_000, message: 'p1 must recover into its breakout after reconnect (one active room)' }).toBe(true);
  // p1's page must NOT simultaneously be showing the lobby (dual state).
  expect(await inLobby(pageOf(0)), 'p1 must not be in the lobby AND a breakout at once').toBe(false);
  // The pair is intact — p1 sees a partner (>= 2 tiles), not sitting alone.
  await expect.poll(() => tilesSeen(pageOf(0)), { timeout: 30_000, message: 'reconnected p1 must see its partner (pair intact)' }).toBeGreaterThanOrEqual(2);
  await pageOf(0).screenshot({ path: 'test-results/uxd-p1-reconnected.png' }).catch(() => {});
  console.log('  ✓ p1 reconnected into its single breakout, partner still there.');

  // End round → everyone (incl. the reconnecter) returns to a converged main room.
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  await pollAll(inRating, 'round 1: rating form shown (incl. reconnecter)');
  await rateAll();
  await pollAll(inLobby, 'round 1: all return to main (incl. reconnecter)');
  await expect.poll(async () => (await Promise.all(P.map((_, i) => tilesSeen(pageOf(i))))).filter(c => c >= 2).length,
    { timeout: 60_000, message: 'main room converged after the reconnect' }).toBe(NP);
  console.log('  ✓ reconnecter returned to a converged main room.');

  // Round 2 still works normally for the reconnecter, then end.
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(7000);
  await pollAll(inBreakout, 'round 2: reconnecter + all enter breakouts');
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  await pollAll(inRating, 'round 2: rating form shown');
  await rateAll();
  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(7000);
  console.log('  ✓ event completed normally after the reconnect race.');
});
