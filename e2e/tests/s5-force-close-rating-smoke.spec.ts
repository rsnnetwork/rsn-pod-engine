import { test, expect } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// PROD smoke S5 (#5 June-10 debrief) — host can force-close a wedged rating window.
// Reproduces today's TESTEVENT wedge: participants present in rating but NOT rating,
// so the all-rated early-close never fires. Without the fix the round sits on the
// silent 90s backstop; with host:force_close_rating the host advances it instantly.
// Self-validating against deploy: the OLD build has no such handler, so the status
// would stay 'round_rating' and this test fails.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';

let host: TestUser, alice: TestUser, bob: TestUser;
let podId: string, sessionId: string;
const sockets: Socket[] = [];

function connect(user: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: user.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 10_000);
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = async (): Promise<string> =>
  (await pool.query('SELECT status FROM sessions WHERE id=$1', [sessionId])).rows[0]?.status;

test.beforeAll(async () => {
  host = await createTestUser('s5host', 'super_admin');
  alice = await createTestUser('s5alice');
  bob = await createTestUser('s5bob');
  const pod = await createPod(host, 'E2E S5 Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  const sess = await createSession(host, podId, 'E2E S5 force-close rating', new Date(Date.now() + 60_000), {
    numberOfRounds: 2,
  });
  sessionId = sess.id;
  await Promise.all([registerForSession(alice, sessionId), registerForSession(bob, sessionId)]);
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('S5: host force-closes a wedged rating window and the event advances immediately', async () => {
  test.setTimeout(120_000);
  const hostSock = await connect(host); sockets.push(hostSock);

  // Start event; both members become socket-present.
  hostSock.emit('host:start_session', { sessionId });
  await wait(2500);
  for (const u of [alice, bob]) { const s = await connect(u); sockets.push(s); s.emit('session:join', { sessionId }); }
  await wait(4000);

  // Run round 1: generate → confirm → start.
  hostSock.emit('host:generate_matches', { sessionId });
  await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId });
  await wait(3000);
  hostSock.emit('host:start_round', { sessionId });
  await wait(4000);

  // End round 1 early → enters the rating window.
  hostSock.emit('host:end_session', { sessionId });
  await wait(4000);

  const beforeStatus = await statusOf();
  console.log('  status after ending round (should be round_rating):', beforeStatus);
  expect(beforeStatus, 'round should be in the rating window').toBe('round_rating');

  // The wedge: nobody rates. Confirm it does NOT auto-advance on its own in a short window
  // (the early-close cannot fire — present participants still owe ratings).
  await wait(6000);
  const stillStuck = await statusOf();
  console.log('  status 6s later with no ratings (the wedge):', stillStuck);
  expect(stillStuck, 'without rating, the window stays open (would sit on the 90s backstop)').toBe('round_rating');

  // THE FIX: host force-closes the rating window.
  hostSock.emit('host:force_close_rating', { sessionId });

  // Assert it advances out of rating quickly — NOT after the 90s backstop.
  let after = stillStuck;
  for (let i = 0; i < 12 && after === 'round_rating'; i++) { await wait(1000); after = await statusOf(); }
  console.log('  status after host:force_close_rating:', after);
  expect(after, 'force-close must advance out of the rating window').not.toBe('round_rating');
  // Round 1 of 2 → next is a transition/lobby state, never stuck in rating.
  expect(['round_transition', 'lobby_open', 'closing_lobby', 'round_active'].includes(after),
    `expected a post-rating state, got ${after}`).toBe(true);

  console.log('  ✓ host force-closed the rating window; event advanced to', after);
});
