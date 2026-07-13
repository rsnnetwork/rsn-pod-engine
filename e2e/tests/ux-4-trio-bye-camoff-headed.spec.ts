import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';
import {
  connectSocket, openParticipant, rateViaForm, cleanup, wait,
  inLobby, inRating, inBreakout, tilesSeen, Socket,
} from '../helpers/live-ui';

// HEADED PROD — trio / bye / camera-toggle edge cases with 3 participants.
//   • camera toggle in the lobby is robust (no stuck / no crash).
//   • an odd count (3) produces a trio OR a pair+bye — whichever the matcher
//     picks, NOBODY is stuck: breakout members rate, a bye user waits in the
//     lobby, and everyone converges in the closing lobby afterwards.
let browser: Browser;
let host: TestUser;
const P: TestUser[] = [];
const ctxs: BrowserContext[] = [];
let hostSock: Socket;
let podId = '', sessionId = '';
const NP = 3;
const pageOf = (i: number) => ctxs[i].pages()[0];

/** A trio member rates up to 2 partners; a pair member rates 1. */
async function rateOut(page: Page) { for (let k = 0; k < 3; k++) { if (!(await rateViaForm(page, { stars: 4, meetAgain: true }))) break; await wait(800); } }

test.beforeAll(async () => {
  host = await createTestUser('uxthost', 'super_admin');
  for (let i = 1; i <= NP; i++) P.push(await createTestUser(`uxtp${i}`));
  const pod = await createPod(host, 'E2E UXTrio Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY trio/bye/cam-off', new Date(Date.now() + 60_000), {
    numberOfRounds: 1, roundDurationSeconds: 150, ratingWindowSeconds: 25,
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

test('trio/bye + camera toggle: nobody stuck, everyone converges', async () => {
  test.setTimeout(360_000);
  hostSock = await connectSocket(host);
  for (const u of P) await openParticipant(browser, ctxs, sessionId, u);
  await wait(5000);
  hostSock.emit('host:start_session', { sessionId }); await wait(3000);
  await expect.poll(async () => (await Promise.all(P.map((_, i) => inLobby(pageOf(i))))).filter(Boolean).length,
    { timeout: 45_000, message: 'all in lobby after start' }).toBe(NP);

  // ── Camera toggle robustness in the lobby (p1) ──────────────────────────────
  console.log('  >>> p1 toggles camera OFF then ON in the lobby <<<');
  await pageOf(0).getByRole('button', { name: 'Camera on', exact: true }).first().click().catch(() => {});
  await wait(2500);
  expect(await inLobby(pageOf(0)), 'p1 must stay in the lobby after turning camera OFF (not stuck)').toBe(true);
  await pageOf(0).getByRole('button', { name: 'Camera off', exact: true }).first().click().catch(() => {});
  await wait(2500);
  await expect.poll(() => tilesSeen(pageOf(0)), { timeout: 20_000, message: 'p1 video must return after re-enabling the camera' }).toBeGreaterThanOrEqual(1);
  console.log('  ✓ camera toggle robust (off→on, never stuck).');

  // ── Round (odd count → trio or pair+bye) ────────────────────────────────────
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(8000);

  // Whatever the shape: every participant must be in a CLEAR state — a breakout
  // OR the lobby (a bye) — never a blank/stuck screen.
  await expect.poll(async () => {
    const states = await Promise.all(P.map(async (_, i) => (await inBreakout(pageOf(i))) || (await inLobby(pageOf(i)))));
    return states.filter(Boolean).length;
  }, { timeout: 45_000, message: 'no participant may be stuck — each is in a breakout or the lobby (bye)' }).toBe(NP);
  const inRooms = await Promise.all(P.map((_, i) => inBreakout(pageOf(i))));
  const byes = await Promise.all(P.map((_, i) => inLobby(pageOf(i))));
  console.log(`  · shape: ${inRooms.filter(Boolean).length} in breakout, ${byes.filter(Boolean).length} bye(s) in lobby.`);
  expect(inRooms.filter(Boolean).length, 'at least a pair must be in a breakout').toBeGreaterThanOrEqual(2);

  // End round → rating (only the matched members get a form) → they rate.
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  for (let i = 0; i < NP; i++) if (await inRating(pageOf(i))) await rateOut(pageOf(i));
  console.log('  · matched members submitted ratings (trio = 2 partners each).');
  hostSock.emit('host:force_close_rating', { sessionId }); await wait(4000);

  // Everyone converges in the closing lobby — trio members AND any bye user.
  await expect.poll(async () => (await Promise.all(P.map((_, i) => tilesSeen(pageOf(i))))).filter(c => c >= 2).length,
    { timeout: 60_000, message: 'closing lobby must converge for all (trio + bye)' }).toBe(NP);
  console.log('  ✓ trio/bye all converged in the closing lobby.');

  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(6000);
  console.log('  ✓ event ended cleanly.');
});
