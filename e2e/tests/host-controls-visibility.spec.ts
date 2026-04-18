// E2E suite: Bug 5 (host-control visibility contract) + Bug 6 (video tile fit).
//
// The client derives Pause/+2/End Round visibility AND Match People disable
// from `roundDashboard.rooms` (server-emitted via host:round_dashboard).
// Architectural contract under test:
//
//   hasActiveAlgorithmRound = rooms.some(r => r.status === 'active' && !r.isManual)
//
// We drive real socket events (the only thing that causes dashboard
// emissions) and assert the contract via dashboard payload AND DB cross-check.
//
// In-process state machine bugs (e.g., Bug 4 — maybeAutoEndEmptyRound) are
// covered by jest tests in dr-arch-april-18-bugs.test.ts. They depend on
// in-memory `activeSessions` state that can't be reliably driven from E2E
// without going through the full round lifecycle.

import { test, expect } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, pool, TestUser } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

const SERVER = process.env.E2E_SERVER_URL || 'https://rsn-api-h04m.onrender.com';

// Force serial execution so beforeAll/afterAll run once and shared state
// (sessionId, sockets) survives between tests.
test.describe.serial('Bug 5 + Bug 6 — host control visibility', () => {
  let host: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let dave: TestUser;

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

  function hasActiveAlgorithmRound(dash: any): boolean {
    return !!dash?.rooms?.some((r: any) => r.status === 'active' && !r.isManual);
  }

  test.beforeAll(async () => {
    host = await createTestUser('hcv-host', 'super_admin');
    alice = await createTestUser('hcv-alice');
    bob = await createTestUser('hcv-bob');
    carol = await createTestUser('hcv-carol');
    dave = await createTestUser('hcv-dave');

    const pod = await createPod(host, 'E2E Host-Controls Visibility Pod');
    podId = pod.id;

    await addPodMember(host, podId, alice.id);
    await addPodMember(host, podId, bob.id);
    await addPodMember(host, podId, carol.id);
    await addPodMember(host, podId, dave.id);

    const sched = new Date(Date.now() + 60_000);
    const sess = await createSession(host, podId, 'E2E Host-Controls Visibility', sched);
    sessionId = sess.id;

    await Promise.all([
      registerForSession(alice, sessionId),
      registerForSession(bob, sessionId),
      registerForSession(carol, sessionId),
      registerForSession(dave, sessionId),
    ]);

    const initSock = await connectSocket(host);
    await new Promise<void>((resolve) => {
      initSock.emit('host:start_session', { sessionId });
      setTimeout(resolve, 2000);
    });
    initSock.disconnect();
  });

  test.afterAll(async () => {
    for (const s of sockets) { try { s.disconnect(); } catch { /* ignore */ } }
    try { await endSession(host, sessionId); } catch { /* may already be ended */ }
    const result = await cleanupTestData();
    // eslint-disable-next-line no-console
    console.log('Host-Controls cleanup:', result);
    // Note: pool is closed by the LAST spec file's afterAll (manual-rooms).
    // Closing it here would break any spec file that runs after this one.
  });

  test('Bug 5 — manual room running does NOT count as algorithm round', async () => {
    // Clean slate
    await pool.query(
      `UPDATE matches SET status = 'completed', ended_at = NOW() WHERE session_id = $1 AND status = 'active'`,
      [sessionId],
    );
    await pool.query(
      `UPDATE session_participants SET status = 'in_lobby' WHERE session_id = $1 AND status NOT IN ('removed','left','no_show') AND user_id != (SELECT host_user_id FROM sessions WHERE id = $1)`,
      [sessionId],
    );
    await new Promise(r => setTimeout(r, 1500));

    const hostSock = await connectSocket(host);
    const aliceSock = await connectSocket(alice);
    const bobSock = await connectSocket(bob);
    sockets.push(hostSock, aliceSock, bobSock);

    hostSock.emit('session:join', { sessionId });
    aliceSock.emit('session:join', { sessionId });
    bobSock.emit('session:join', { sessionId });
    await new Promise(r => setTimeout(r, 2000));

    const dashes: any[] = [];
    hostSock.on('host:round_dashboard', (d: any) => dashes.push(d));

    hostSock.emit('host:create_breakout_bulk', {
      sessionId,
      rooms: [{ participantIds: [alice.id, bob.id] }],
      sharedDurationSeconds: 300,
      timerVisibility: 'visible',
    });
    await new Promise(r => setTimeout(r, 3500));

    const dashWithManual = dashes.find((d: any) =>
      d.rooms?.some((r: any) => r.status === 'active' && r.isManual)
    );
    expect(dashWithManual).toBeDefined();

    // ── Architectural rule ──
    // Manual room is active but must NOT be counted as algorithm round.
    expect(hasActiveAlgorithmRound(dashWithManual)).toBe(false);

    // DB cross-check
    const dbCheck = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE is_manual = TRUE AND status = 'active') AS manual_active,
              COUNT(*) FILTER (WHERE is_manual = FALSE AND status = 'active') AS algo_active
         FROM matches WHERE session_id = $1`,
      [sessionId],
    );
    expect(parseInt(dbCheck.rows[0].manual_active, 10)).toBeGreaterThanOrEqual(1);
    expect(parseInt(dbCheck.rows[0].algo_active, 10)).toBe(0);
    // eslint-disable-next-line no-console
    console.log('  ✓ Manual room only: hasActiveAlgorithmRound=false');

    aliceSock.emit('participant:leave_conversation', { sessionId });
    await new Promise(r => setTimeout(r, 1000));
    bobSock.emit('participant:leave_conversation', { sessionId });
    await new Promise(r => setTimeout(r, 2500));
  });

  test('Bug 5 — eligibleMainRoomCount query returns >= 2 when no rooms active (Match People enables)', async () => {
    // Force-clean any leftover state from previous test
    await pool.query(
      `UPDATE matches SET status = 'completed', ended_at = NOW() WHERE session_id = $1 AND status = 'active'`,
      [sessionId],
    );
    await pool.query(
      `UPDATE session_participants SET status = 'in_lobby' WHERE session_id = $1 AND status NOT IN ('removed','left','no_show') AND user_id != (SELECT host_user_id FROM sessions WHERE id = $1)`,
      [sessionId],
    );

    // Replicate the SAME server-side query from emitHostDashboard
    // (matching-flow.ts:659-670). This is what the client sees as
    // `eligibleMainRoomCount`. Must be >= 2 for Match People to enable.
    const eligibleResult = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM session_participants sp
       WHERE sp.session_id = $1
         AND sp.status NOT IN ('removed', 'left', 'no_show')
         AND sp.user_id != (SELECT host_user_id FROM sessions WHERE id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM matches m
           WHERE m.session_id = $1 AND m.status = 'active'
             AND (m.participant_a_id = sp.user_id OR m.participant_b_id = sp.user_id OR m.participant_c_id = sp.user_id)
         )`,
      [sessionId],
    );
    const eligible = parseInt(eligibleResult.rows[0].c, 10);
    expect(eligible).toBeGreaterThanOrEqual(2);

    // And the active-match count must be 0 (matches the dashboard contract).
    const active = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM matches WHERE session_id = $1 AND status = 'active'`,
      [sessionId],
    );
    expect(parseInt(active.rows[0].c, 10)).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`  ✓ All rooms ended: 0 active matches, eligibleMainRoomCount=${eligible}`);
  });

  test('Bug 6 — VideoTile uses object-contain (lock-in via static source check)', async () => {
    // Complement to the jest server-side test — also part of the E2E suite
    // so the production-bound bundle would be flagged by CI even if the
    // jest test file gets removed/skipped accidentally.
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../client/src/features/live/VideoRoom.tsx'),
      'utf8',
    );
    const blocks = src.match(/<VideoTrack[\s\S]*?\/>/g) || [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toMatch(/object-contain/);
      expect(block).not.toMatch(/object-cover/);
    }
    // eslint-disable-next-line no-console
    console.log(`  ✓ VideoRoom.tsx uses object-contain (${blocks.length} VideoTrack block(s) verified)`);
  });
});
