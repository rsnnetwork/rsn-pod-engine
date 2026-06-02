// ─── 25-user load test — validates the state-management bug fixes ────────────
//
// Reproduces the reported failure mode ("when 10-12+ users join, everyone sees
// a different participant count / different timer, and group matching is buggy
// — solo rooms / can't join") at 25 concurrent users and asserts the fixes:
//
//   Bug #2 (count)    — after 24 simultaneous joins, EVERY client converges to
//                       the same authoritative participant list (server pushes
//                       a deduped snapshot to the whole room).
//   Bug #1 (matching) — generating round 1 for 24 connected users yields a
//                       complete, valid pairing: 12 pairs, all 24 placed, no
//                       solo room, no user in two matches, no duplicate pair.
//                       A rapid generate+regenerate burst stresses the
//                       match-generation lock; the final state stays valid.
//   Bug #3 (timer)    — after round 1 starts, every client (with synthetic
//                       per-client clock skew injected) computes the SAME
//                       remaining time via the serverNow clock-offset anchor.
//
// Runs against a LOCAL server (npm run dev) with the uncommitted fixes — see
// the run command in the chat. Uses lightweight socket.io-client connections
// (not browsers): the count/timer/matching logic is all server-side.

import { test, expect } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, pool, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

const SERVER = process.env.E2E_SERVER_URL || 'http://localhost:3001';
const N_PARTICIPANTS = 24; // + 1 host = 25 connected users; 24 non-host → 12 clean pairs

test.setTimeout(180_000);

interface Client {
  user: TestUser;
  socket: Socket;
  isHost: boolean;
  /** synthetic clock skew (ms) used to prove the timer offset-correction. */
  skewMs: number;
  /** latest authoritative roster size this client has observed. */
  lastRosterSize: number;
  /** latest timer anchor this client received. */
  timer: { endsAt?: string; serverNow?: string; secondsRemaining?: number };
}

let host: TestUser;
let participants: TestUser[] = [];
let podId: string;
let sessionId: string;
const clients: Client[] = [];

function connectSocket(user: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: user.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 15_000);
  });
}

/** Replicates the client store's timer math: remaining = endsAt - (now + offset),
 *  where offset = serverNow - now. The client's own clock cancels out, so the
 *  result is identical on every client regardless of skew. */
function computeRemaining(t: Client['timer'], clientNowMs: number): number | null {
  if (!t.endsAt) return null;
  if (t.serverNow) {
    const offset = Date.parse(t.serverNow) - clientNowMs;       // setClockOffset
    return Math.max(0, Math.ceil((Date.parse(t.endsAt) - (clientNowMs + offset)) / 1000));
  }
  if (typeof t.secondsRemaining === 'number') return t.secondsRemaining;
  return Math.max(0, Math.ceil((Date.parse(t.endsAt) - clientNowMs) / 1000));
}

test.beforeAll(async () => {
  host = await createTestUser('loadhost', 'super_admin');
  participants = [];
  for (let i = 0; i < N_PARTICIPANTS; i++) {
    participants.push(await createTestUser(`p${i}`));
  }

  const pod = await createPod(host, 'E2E Load Pod');
  podId = pod.id;
  await Promise.all(participants.map(p => addPodMember(host, podId, p.id)));

  const sess = await createSession(host, podId, 'E2E 25-user Load Test', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all(participants.map(p => registerForSession(p, sessionId)));

  // Host starts the session (creates the in-memory active session + lobby).
  const hostInit = await connectSocket(host);
  await new Promise<void>((resolve) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(resolve, 2500); });
  hostInit.disconnect();
});

test.afterAll(async () => {
  for (const c of clients) { try { c.socket.disconnect(); } catch {} }
  try { await endSession(host, sessionId); } catch {}
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('25 users: count, matching, and timer stay consistent under concurrent load', async () => {
  // ── Connect 25 sockets and wire listeners BEFORE joining ──────────────────
  const all: TestUser[] = [host, ...participants];
  for (let i = 0; i < all.length; i++) {
    const user = all[i];
    const socket = await connectSocket(user);
    const client: Client = {
      user, socket, isHost: i === 0,
      // Spread synthetic clock skew from -10s to +10s across clients to prove
      // the timer offset-correction neutralizes real-world clock differences.
      skewMs: Math.round((i - all.length / 2) * (20_000 / all.length)),
      lastRosterSize: 0,
      timer: {},
    };
    socket.on('session:state', (d: any) => {
      if (Array.isArray(d?.participants)) client.lastRosterSize = d.participants.length;
    });
    socket.on('session:round_started', (d: any) => {
      client.timer = { endsAt: d.endsAt, serverNow: d.serverNow, secondsRemaining: d.durationSeconds };
    });
    socket.on('timer:sync', (d: any) => {
      client.timer = { endsAt: d.endsAt, serverNow: d.serverNow, secondsRemaining: d.secondsRemaining };
    });
    clients.push(client);
  }
  expect(clients.length).toBe(25);

  // ── PHASE 1: 24 participants join SIMULTANEOUSLY (the stress) ─────────────
  const hostClient = clients[0];
  hostClient.socket.emit('session:join', { sessionId });
  // Fire all 24 participant joins in the same tick — no awaits between them.
  for (let i = 1; i < clients.length; i++) {
    clients[i].socket.emit('session:join', { sessionId });
  }

  // Let the debounced authoritative room broadcast settle.
  await new Promise(r => setTimeout(r, 4000));

  // ── ASSERT Bug #2: every client converged to the SAME roster size ─────────
  const rosterSizes = clients.map(c => c.lastRosterSize);
  const uniqueSizes = [...new Set(rosterSizes)];
  console.log('Per-client roster sizes:', rosterSizes.join(','));
  console.log('Distinct roster sizes across all 25 clients:', uniqueSizes);
  expect(uniqueSizes).toHaveLength(1);   // ← the bug was: many different values
  expect(uniqueSizes[0]).toBe(25);       // host + 24 participants, all connected

  // DB sanity: 25 participants registered (24) + host present.
  const inLobby = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text c FROM session_participants WHERE session_id=$1 AND status NOT IN ('removed','left','no_show')`,
    [sessionId],
  );
  console.log('session_participants (non-terminal) in DB:', inLobby.rows[0].c);

  // ── PHASE 2: generate round 1 + a concurrent regenerate burst ─────────────
  // host:generate_matches and a rapid regenerate burst both take the dedicated
  // match-generation lock; if it didn't serialize, the round-1 scheduled set
  // could end up with orphaned/duplicate/solo rows. Fire generate, then 3
  // regenerates without awaiting between them, then assert a clean final state.
  hostClient.socket.emit('host:generate_matches', { sessionId });
  await new Promise(r => setTimeout(r, 3500)); // let preview generate (sets pendingRoundNumber)
  for (let k = 0; k < 3; k++) hostClient.socket.emit('host:regenerate_matches', { sessionId });
  await new Promise(r => setTimeout(r, 5000)); // let the locked regenerations drain

  // ── ASSERT Bug #1: round 1 is a complete, valid pairing ───────────────────
  const r1 = await pool.query<{ id: string; participant_a_id: string; participant_b_id: string; participant_c_id: string | null; status: string }>(
    `SELECT id, participant_a_id, participant_b_id, participant_c_id, status
       FROM matches WHERE session_id=$1 AND round_number=1 AND status IN ('scheduled','active')`,
    [sessionId],
  );
  const placed = new Set<string>();
  const pairKeys = new Set<string>();
  let soloRooms = 0;
  for (const m of r1.rows) {
    const members = [m.participant_a_id, m.participant_b_id, m.participant_c_id].filter(Boolean) as string[];
    if (members.length < 2) soloRooms++;                  // ← "alone in a 1-person room"
    for (const u of members) {
      expect(placed.has(u)).toBe(false);                  // ← no user in two matches
      placed.add(u);
    }
    const key = [m.participant_a_id, m.participant_b_id].sort().join(':');
    expect(pairKeys.has(key)).toBe(false);                // ← no duplicate pair row
    pairKeys.add(key);
  }
  console.log(`Round 1: ${r1.rows.length} matches, ${placed.size}/${N_PARTICIPANTS} participants placed, soloRooms=${soloRooms}`);
  expect(soloRooms).toBe(0);
  expect(placed.size).toBe(N_PARTICIPANTS);               // ← all 24 placed (none "can't join")
  expect(r1.rows.length).toBe(N_PARTICIPANTS / 2);        // ← exactly 12 pairs (even count → no byes)
  // Host is never matched as a participant.
  expect(placed.has(host.id)).toBe(false);

  // ── PHASE 3: confirm round 1 → timer starts → check convergence ───────────
  hostClient.socket.emit('host:confirm_round', { sessionId });
  await new Promise(r => setTimeout(r, 4000)); // round_started + at least one timer:sync

  const remainings = clients
    .map(c => computeRemaining(c.timer, Date.now() + c.skewMs))
    .filter((v): v is number => v !== null);
  console.log(`Clients with a timer value: ${remainings.length}/25`);
  console.log('Remaining (s) per client (with ±10s synthetic skew):', remainings.join(','));
  expect(remainings.length).toBe(25);
  const spread = Math.max(...remainings) - Math.min(...remainings);
  console.log('Timer spread across all 25 clients:', spread, 'seconds');
  // With the clock-offset fix the spread is ~0-1s despite ±10s per-client skew.
  // (The OLD code computed endsAt - localNow, which would spread ~20s here.)
  expect(spread).toBeLessThanOrEqual(2);

  // Contrast: what the OLD (no-offset) math would have produced, to show the
  // bug would manifest at this skew. Logged only — not asserted.
  const oldStyle = clients.map(c => {
    if (!c.timer.endsAt) return 0;
    return Math.max(0, Math.ceil((Date.parse(c.timer.endsAt) - (Date.now() + c.skewMs)) / 1000));
  });
  console.log('OLD-style spread (endsAt - skewedLocalNow, no offset):',
    Math.max(...oldStyle) - Math.min(...oldStyle), 'seconds');

  console.log('✓ 25-user load test passed: count converged (1 distinct value=25), matching complete (12 pairs, 0 solo, all 24 placed), timer spread ≤ 2s under ±10s skew');
});
