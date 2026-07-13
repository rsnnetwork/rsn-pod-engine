import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';
import {
  connectSocket, openParticipant, rateViaForm, skipRating, cleanup, wait,
  inLobby, inRating, inBreakout, tilesSeen, Socket,
} from '../helpers/live-ui';

// HEADED PROD — user-driven full journey. Participants CLICK the real rating
// forms (stars + meet-again + Submit), some skip, one never rates (mixed
// submission — Ali's exact scenario). Over 3 rounds we assert NOBODY is ever
// stuck: they enter breakouts, see + submit the rating form, and RETURN to a
// converged main room after every round (last round → closing lobby), ending
// at the recap. Host orchestrates via socket; the participants drive the UI.
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

test.beforeAll(async () => {
  host = await createTestUser('uxjhost', 'super_admin');
  for (let i = 1; i <= NP; i++) P.push(await createTestUser(`uxjp${i}`));
  const pod = await createPod(host, 'E2E UXJourney Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY full user journey', new Date(Date.now() + 60_000), {
    numberOfRounds: 3, roundDurationSeconds: 150, ratingWindowSeconds: 25,
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

test('full journey · participants submit real rating forms (mixed) · never stuck · converge each round', async () => {
  test.setTimeout(480_000);
  hostSock = await connectSocket(host);
  for (const u of P) await openParticipant(browser, ctxs, sessionId, u);
  await wait(5000);

  hostSock.emit('host:start_session', { sessionId }); await wait(3000);
  await pollAll(inLobby, 'all participants must reach the lobby after start');
  console.log('  ✓ all in lobby (event started).');

  for (let round = 1; round <= 3; round++) {
    const isLast = round === 3;
    console.log(`── Round ${round}${isLast ? ' (last)' : ''} ──`);

    hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
    hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
    hostSock.emit('host:start_round', { sessionId }); await wait(7000);
    await pollAll(inBreakout, `round ${round}: everyone must enter their breakout (not stuck at matching)`, 45_000);
    console.log(`  ✓ round ${round}: all entered breakouts.`);

    hostSock.emit('host:end_session', { sessionId }); await wait(4000); // → ROUND_RATING
    await pollAll(inRating, `round ${round}: everyone must see the rating FORM (not stuck in breakout)`, 40_000);
    console.log(`  ✓ round ${round}: rating form shown to all.`);

    // MIXED submission via the REAL form: p0 rates high+meet, p1 rates low,
    // p2 skips, p3 does NOTHING (the stuck-trigger from Ali's event).
    expect(await rateViaForm(pageOf(0), { stars: 5, meetAgain: true }), `p1 must submit a rating`).toBe(true);
    expect(await rateViaForm(pageOf(1), { stars: 3, meetAgain: false }), `p2 must submit a rating`).toBe(true);
    await skipRating(pageOf(2));
    // p3: intentionally left on the form.
    console.log(`  · round ${round}: p1 rated 5★, p2 rated 3★, p3 skipped, p4 left the form open.`);

    hostSock.emit('host:force_close_rating', { sessionId }); await wait(4000);

    if (!isLast) {
      await pollAll(inLobby, `round ${round}: everyone must RETURN to the main room (not stuck after rating)`, 45_000);
      await expect.poll(async () => (await Promise.all(P.map((_, i) => tilesSeen(pageOf(i))))).filter(c => c >= 2).length,
        { timeout: 45_000, message: `round ${round}: main room must converge (everyone sees others)` }).toBe(NP);
      console.log(`  ✓ round ${round}: all returned to a CONVERGED main room.`);
    } else {
      // Last round → closing lobby: converge (the bug we just fixed).
      await expect.poll(async () => (await Promise.all(P.map((_, i) => tilesSeen(pageOf(i))))).filter(c => c >= 2).length,
        { timeout: 60_000, message: 'closing lobby must converge (everyone sees others)' }).toBe(NP);
      console.log('  ✓ last round: closing lobby CONVERGED.');
    }
  }

  // End the event → participants leave the live room (recap / no longer live).
  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(7000);
  await expect.poll(async () => (await Promise.all(P.map((_, i) => inBreakout(pageOf(i))))).filter(Boolean).length,
    { timeout: 45_000, message: 'no participant may remain in a breakout after End Event' }).toBe(0);
  for (let i = 0; i < NP; i++) await pageOf(i).screenshot({ path: `test-results/uxj-p${i + 1}-end.png` }).catch(() => {});
  console.log('  ✓ event ended — all participants left the live room.');
});
