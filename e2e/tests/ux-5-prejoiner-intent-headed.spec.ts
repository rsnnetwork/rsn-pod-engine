import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';
import {
  connectSocket, openParticipant, cleanup, wait,
  inLobby, tilesSeen, intentFormShown, Socket,
} from '../helpers/live-ui';

// HEADED PROD — the "pre-joiner stuck at the waiting page" bug (13 Jul, Ali).
// The EARLIEST participant — who opens the live page BEFORE the host presses
// Start — got stuck on the waiting screen: no intent form, never moved to the
// main room, needed a manual refresh. Everyone who joined AFTER start was fine.
//
// This asserts the pre-joiner (p1) gets the intent form AND lands in the main
// room with the others — WITHOUT any refresh. On the buggy build p1 is stuck.
let browser: Browser;
let host: TestUser;
const P: TestUser[] = [];
const ctxs: BrowserContext[] = [];
let hostSock: Socket;
let podId = '', sessionId = '';
const pageOf = (i: number) => ctxs[i].pages()[0];

test.beforeAll(async () => {
  host = await createTestUser('uxpjhost', 'super_admin');
  for (let i = 1; i <= 2; i++) P.push(await createTestUser(`uxpjp${i}`));
  const pod = await createPod(host, 'E2E UXPreJoin Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY pre-joiner', new Date(Date.now() + 60_000), {
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

test('pre-joiner (joins before host starts) gets the intent form and enters the main room — no refresh', async () => {
  test.setTimeout(300_000);
  hostSock = await connectSocket(host);

  // ── p1 is the PRE-JOINER: opens the live page while the event is still
  //    'scheduled' (host has NOT started), before anyone else. ────────────────
  console.log('  >>> p1 opens the live page BEFORE the host starts (pre-joiner) <<<');
  await openParticipant(browser, ctxs, sessionId, P[0]);
  await wait(18_000); // sit in the waiting room a while, as Ali did

  // The pre-joiner must at least see the intent form while waiting (Ali: he
  // never got it). Assert it appears without any refresh.
  const preJoinerSawForm = await expect.poll(() => intentFormShown(pageOf(0)),
    { timeout: 30_000, message: 'pre-joiner must see the intent form (never got it in Ali\'s run)' }).toBe(true).then(() => true).catch(() => false);
  await pageOf(0).screenshot({ path: 'test-results/uxpj-prejoiner-waiting.png' }).catch(() => {});
  // Dismiss it so it doesn't cover the room (Skip is always safe).
  await pageOf(0).getByRole('button', { name: /^Skip$/i }).first().click().catch(() => {});
  await wait(1000);

  // ── Host starts; a normal joiner (p2) arrives after start. ─────────────────
  hostSock.emit('host:start_session', { sessionId }); await wait(3000);
  console.log('  >>> host started — p2 joins normally (after start) <<<');
  await openParticipant(browser, ctxs, sessionId, P[1]);
  await wait(4000);

  // THE KEY: the pre-joiner (p1) must be in the MAIN room now, WITHOUT a
  // refresh — this is what was stuck. And it must converge with p2.
  await expect.poll(() => inLobby(pageOf(0)),
    { timeout: 45_000, message: 'PRE-JOINER must land in the main room after the host starts (no refresh)' }).toBe(true);
  await expect.poll(() => inLobby(pageOf(1)),
    { timeout: 45_000, message: 'normal joiner must be in the main room' }).toBe(true);
  await expect.poll(async () => (await Promise.all([tilesSeen(pageOf(0)), tilesSeen(pageOf(1))])).filter(c => c >= 2).length,
    { timeout: 45_000, message: 'both must converge in the main room (see each other)' }).toBe(2);

  expect(preJoinerSawForm, 'pre-joiner should have seen the intent form').toBe(true);
  console.log('  ✓ pre-joiner saw the intent form AND entered the main room without a refresh.');

  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(6000);
});
