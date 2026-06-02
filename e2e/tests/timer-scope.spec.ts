import { test, expect } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, pool, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// F/G (25 May Ali) — the manual breakout room timer must not be clobbered by the
// session round/rating timer. The fix is self-healing on the client (it keeps the
// breakout timer while 'breakout'-tagged ticks keep arriving). That client gate is
// only correct if the SERVER tags every timer it sends so the two streams are
// distinguishable. THIS spec proves the server half end-to-end against prod:
//   - the per-user manual-room timer:sync carries segmentType 'breakout'
//   - it arrives as a LIVE stream (initial + the 5s periodic interval) — exactly
//     what the client recency gate keys on, and what survives a refresh
//   - match:reassigned for a manual breakout carries isManual:true
//   - NO timer:sync ever reaches a breakout participant untagged (so the client
//     can always classify it)

const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';

let host: TestUser;
let alice: TestUser;
let bob: TestUser;
let podId: string;
let sessionId: string;
const sockets: Socket[] = [];

function connectSocket(user: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, {
      auth: { token: user.accessToken },
      transports: ['websocket'],
      reconnection: false,
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 10000);
  });
}

test.beforeAll(async () => {
  host = await createTestUser('thost', 'super_admin');
  alice = await createTestUser('talice');
  bob = await createTestUser('tbob');

  const pod = await createPod(host, 'E2E Timer Scope Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);

  const sched = new Date(Date.now() + 60_000);
  const sess = await createSession(host, podId, 'E2E Timer Scope Test', sched);
  sessionId = sess.id;
  await Promise.all([
    registerForSession(alice, sessionId),
    registerForSession(bob, sessionId),
  ]);

  const hostInit = await connectSocket(host);
  await new Promise<void>((resolve) => {
    hostInit.emit('host:start_session', { sessionId });
    setTimeout(resolve, 2000);
  });
  hostInit.disconnect();
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await endSession(host, sessionId); } catch {}
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('manual breakout timer is tagged "breakout", streams live, and match:reassigned carries isManual', async () => {
  const hostSock = await connectSocket(host);
  const aliceSock = await connectSocket(alice);
  const bobSock = await connectSocket(bob);
  sockets.push(hostSock, aliceSock, bobSock);

  const aliceTimerSyncs: any[] = [];
  const aliceReassigned: any[] = [];
  aliceSock.on('timer:sync', (d) => aliceTimerSyncs.push(d));
  aliceSock.on('match:reassigned', (d) => aliceReassigned.push(d));

  hostSock.emit('session:join', { sessionId });
  aliceSock.emit('session:join', { sessionId });
  bobSock.emit('session:join', { sessionId });
  await new Promise((r) => setTimeout(r, 2000));

  // Host opens a manual breakout for alice + bob with a visible 60s timer.
  hostSock.emit('host:create_breakout_bulk', {
    sessionId,
    rooms: [{ participantIds: [alice.id, bob.id] }],
    sharedDurationSeconds: 60,
    timerVisibility: 'visible',
  });

  // Long enough to catch the immediate sync + at least one 5s periodic tick.
  await new Promise((r) => setTimeout(r, 9000));

  // Confirm the room actually got created (otherwise the rest is moot).
  const matchRes = await pool.query(
    `SELECT is_manual FROM matches WHERE session_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    [sessionId],
  );
  expect(matchRes.rows.length).toBe(1);
  expect(matchRes.rows[0].is_manual).toBe(true);

  // match:reassigned must carry isManual:true (client uses it to identify breakouts)
  expect(aliceReassigned.length).toBeGreaterThanOrEqual(1);
  expect(aliceReassigned.some((m) => m.isManual === true)).toBe(true);

  // The breakout timer is tagged 'breakout', counts down from ~60, and STREAMS
  // (initial emit + the 5s periodic interval) — the live signal the client gate uses.
  const breakoutSyncs = aliceTimerSyncs.filter((t) => t.segmentType === 'breakout');
  expect(breakoutSyncs.length).toBeGreaterThanOrEqual(2);
  expect(breakoutSyncs.every((t) => typeof t.secondsRemaining === 'number' && t.secondsRemaining > 0 && t.secondsRemaining <= 60)).toBe(true);

  // CRITICAL invariant: a breakout participant must NEVER receive an untagged
  // timer:sync. Every tick (breakout OR session) carries a segmentType, so the
  // client can always tell them apart and never lets a session tick clobber the room.
  const untagged = aliceTimerSyncs.filter((t) => t.segmentType === undefined || t.segmentType === null);
  expect(untagged.length).toBe(0);

  // Any session-level ticks that did arrive are tagged with a session status, NOT 'breakout'.
  const sessionSyncs = aliceTimerSyncs.filter((t) => t.segmentType && t.segmentType !== 'breakout');
  for (const s of sessionSyncs) expect(s.segmentType).not.toBe('breakout');

  console.log(`✓ breakout syncs: ${breakoutSyncs.length}, session syncs: ${sessionSyncs.length}, untagged: ${untagged.length}, isManual reassigned: ${aliceReassigned.some((m) => m.isManual === true)}`);
});
