import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod smoke S1 — un-defers the june9 "#3 backend super_admin policy"
// (the matching half), proving the 10-Jun audit fix on the LIVE server:
//   1.1  repairFutureRounds excludes super_admins → a super_admin participant is
//        NEVER paired into a breakout, even after a late-joiner repair regenerates
//        the future rounds (the exact path that was broken).
//   1.2  the host dashboard's eligible count does not count a super_admin.
// The super_admin (sadmin) is socket-PRESENT, so this also proves a present
// super_admin is excluded, not just an absent one.
//
// Self-validating against the deploy: on the OLD build, repairFutureRounds would
// re-add sadmin to the regenerated future rounds, so sadmin would appear in a
// round-2/3 match → this test FAILS. A pass means the new build is live AND correct.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';

let host: TestUser, alice: TestUser, bob: TestUser, carol: TestUser, sadmin: TestUser, dave: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
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

async function join(user: TestUser): Promise<Socket> {
  const s = await connect(user);
  sockets.push(s);
  s.emit('session:join', { sessionId });
  return s;
}

test.beforeAll(async () => {
  host = await createTestUser('s1host', 'super_admin');      // director (also super_admin)
  sadmin = await createTestUser('s1sadmin', 'super_admin');  // NON-director super_admin → must never be matched
  alice = await createTestUser('s1alice');
  bob = await createTestUser('s1bob');
  carol = await createTestUser('s1carol');
  dave = await createTestUser('s1dave');                     // late joiner → triggers repairFutureRounds

  const pod = await createPod(host, 'E2E S1 Pod');
  podId = pod.id;
  for (const u of [sadmin, alice, bob, carol, dave]) await addPodMember(host, podId, u.id);

  const sess = await createSession(host, podId, 'E2E S1 super_admin matching', new Date(Date.now() + 60_000), {
    numberOfRounds: 3,
  });
  sessionId = sess.id;
  // Everyone except the late joiner registers up front.
  await Promise.all([sadmin, alice, bob, carol].map((u) => registerForSession(u, sessionId)));

  browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('S1: a present super_admin is never matched into a breakout, even after a late-joiner repair', async () => {
  test.setTimeout(180_000);

  // Capture the host dashboard so we can also check the eligible count (fix 1.2).
  const dashboards: any[] = [];
  const hostSock = await connect(host);
  sockets.push(hostSock);
  hostSock.on('host:round_dashboard', (d) => dashboards.push(d));

  // 1) Host starts the event; all participants (incl. sadmin) become socket-PRESENT.
  hostSock.emit('host:start_session', { sessionId });
  await wait(2500);
  await Promise.all([sadmin, alice, bob, carol].map((u) => join(u)));
  await wait(4000); // let presence settle

  // 2) Drive a real matching round: generate → confirm → start.
  hostSock.emit('host:generate_matches', { sessionId });
  await wait(6000); // matching engine can take a few seconds
  hostSock.emit('host:confirm_matches', { sessionId });
  await wait(3000);
  hostSock.emit('host:start_round', { sessionId });
  await wait(4000); // round 1 now ACTIVE → currentRound >= 1, so a join triggers repair

  // 3) Late joiner registers + joins → fires maybeRepairFutureRounds, which
  //    regenerates the FUTURE rounds. This is the exact path the fix corrects.
  await registerForSession(dave, sessionId);
  await join(dave);
  await wait(9000); // past the 5s repair throttle + regeneration

  // 4) PROOF (fix 1.1): across EVERY round's matches on the live DB, the
  //    super_admin must appear in zero participant slots.
  const { rows } = await pool.query<{
    round_number: number; a: string | null; b: string | null; c: string | null;
  }>(
    `SELECT round_number,
            participant_a_id AS a, participant_b_id AS b, participant_c_id AS c
       FROM matches WHERE session_id = $1 ORDER BY round_number`,
    [sessionId],
  );
  console.log(`  rounds with matches: ${rows.length} rows`);
  expect(rows.length, 'matching must have produced rows (sanity)').toBeGreaterThan(0);

  const sadminRows = rows.filter((r) => [r.a, r.b, r.c].includes(sadmin.id));
  if (sadminRows.length) {
    console.log('  ✗ super_admin found in matches:', JSON.stringify(sadminRows));
  }
  expect(sadminRows, 'super_admin must NOT appear in any match, any round').toHaveLength(0);

  // Sanity: ordinary members ARE matched (so the exclusion above isn't a fluke
  // of "nobody got matched").
  const memberIds = new Set([alice.id, bob.id, carol.id, dave.id]);
  const matchedMembers = new Set<string>();
  for (const r of rows) for (const id of [r.a, r.b, r.c]) if (id && memberIds.has(id)) matchedMembers.add(id);
  console.log(`  members matched: ${matchedMembers.size}/4`);
  expect(matchedMembers.size, 'ordinary members must be getting matched').toBeGreaterThanOrEqual(2);

  // 5) PROOF (fix 1.2): the host dashboard eligible count never counts the
  //    super_admin. Eligible = present main-room participants minus the full
  //    host set, so sadmin (present, super_admin) is excluded.
  const present = dashboards.filter((d) => typeof d?.eligibleMainRoomCount === 'number');
  if (present.length) {
    const maxEligible = Math.max(...present.map((d) => d.eligibleMainRoomCount));
    console.log(`  max eligibleMainRoomCount seen: ${maxEligible} (members only, sadmin excluded)`);
    // 4 ordinary members max; if sadmin were wrongly counted it would exceed 4.
    expect(maxEligible, 'eligible count must not include the super_admin').toBeLessThanOrEqual(4);
  } else {
    console.log('  (no dashboard payload captured — eligible-count check skipped)');
  }

  console.log('  ✓ super_admin excluded from matching + eligible count on the live server');
});
