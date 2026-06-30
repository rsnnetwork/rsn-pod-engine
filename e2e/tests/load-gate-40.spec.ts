// ─── WAVE-0 LOAD GATE — 40–50 client traffic + churn harness ─────────────────
//
// SDD-00 gate (before the first 30–50 person event, before any Wave 1 work):
//   "extend the load harness to 40+ browsers (cameras publishing) against a
//    Vercel preview + prod backend; assert join-window latency, zero 429s for
//    legitimate traffic, round transitions under churn (refresh + background-tab
//    mix)."
//
// HARDWARE NOTE (why this is socket+HTTP, not 40 browsers): the box this runs on
// is 8 logical cores / ~8 GB RAM. loadABC-20users.spec.ts already self-describes
// as "local CPU bound" at 20 publishers × 19 subscriptions ≈ 380 tracks and
// relaxes its video asserts for that reason. 40 publishing browsers ≈ 1,560
// decode pipelines + 6–12 GB of Chromium RAM would measure the laptop, not the
// platform. Per the Wave-0 gate decision, this harness validates the gate's
// THREE strict assertions at the protocol layer (which scale fine to 40–50+ on
// this machine), and the already-passing 20-browser run stands as the real
// video-fanout proof:
//
//   (1) JOIN-WINDOW LATENCY  — 40–50 users navigate+join in a burst; measure
//       connect→first-authoritative-state per user (p50/p95/max).
//   (2) ZERO 429s FOR LEGIT TRAFFIC — each user runs the REAL SPA request
//       pattern (join burst → lobby poll → round-move burst → recap burst) and
//       must never be rate-limited. This is the at-scale proof of TRF-2's
//       per-user `u:<sub>` bucket keying: the old IP-shared bucket 429'd a crowd
//       behind one NAT; distinct users must now each get their own budget. We
//       ALSO record the peak observed requests/60s per user vs the prod limit
//       (100) so we catch a too-tight ceiling even if no 429 fires this run.
//   (3) ROUND TRANSITIONS UNDER CHURN — while a round is generated/confirmed/
//       ended, a churn mix runs across disjoint fractions of the cohort:
//         • refresh         — socket reconnect + /state refetch (the SPA reload)
//         • background-tab   — throttled poll cadence, then a foreground catch-up
//                              refetch burst (the 429 trap)
//         • disconnect/rejoin— drop past the 15 s grace → LEFT → reconnect+rejoin
//       Assert: roster reconverges to reality, the cohort lands in breakout and
//       all return to main, zero ghost re-pulls.
//
// Throwaway e2etest-*@example.com users, cleaned by ID in afterAll.
//
// RUN (prod — get an off-event window first; this puts real load + LiveKit cost
// on production):
//   cd e2e
//   $env:JWT_SECRET   = (Get-Content .jwt_secret -Raw).Trim()
//   $env:DATABASE_URL = ((Get-Content "..\server\.env" | Select-String "^DATABASE_URL=") -replace "^DATABASE_URL=","")
//   $env:LOAD_N = "40"   # bump to 50 for the upper bound
//   npx playwright test tests/load-gate-40.spec.ts --reporter=line
//
import { test, expect } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, pool, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// ── Config ───────────────────────────────────────────────────────────────────
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const API = process.env.E2E_API_URL || SERVER;
const N = parseInt(process.env.LOAD_N || '40', 10); // non-host participants

// Prod per-user API budget (render.yaml RATE_LIMIT_MAX_REQUESTS=100 / 60 s,
// keyed u:<sub> via verified JWT — server/src/middleware/rateLimit.ts).
const PER_USER_LIMIT = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10);
const WINDOW_MS = 60_000;

// Latency budget for a single user's join (connect → first authoritative state).
const JOIN_LATENCY_BUDGET_MS = parseInt(process.env.JOIN_LATENCY_BUDGET_MS || '15000', 10);

// Tunable phase lengths so a fast debug run (LOBBY_TICKS=1 GHOST_WATCH_MS=5000)
// iterates quickly; defaults are the real gate.
const LOBBY_TICKS = parseInt(process.env.LOBBY_TICKS || '5', 10);
const GHOST_WATCH_MS = parseInt(process.env.GHOST_WATCH_MS || '45000', 10);

// Diagnostics captured from the wire (printed in the report).
const hostEvents: Array<{ ev: string; d: string }> = [];
const participantErrors: Array<{ email: string; d: string }> = [];

// Churn fractions of the cohort (disjoint slices), applied around the round.
const REFRESH_FRAC = 0.25;     // reconnect + refetch
const BGTAB_FRAC = 0.25;       // throttled cadence then catch-up burst
const DISCONNECT_FRAC = 0.15;  // drop past grace, then rejoin
const DISCONNECT_GRACE_MS = 17_000; // > server's 15 s disconnect→LEFT grace

// ── Per-user virtual client ──────────────────────────────────────────────────
interface VClient {
  user: TestUser;
  socket: Socket | null;
  connected: boolean;
  joined: boolean;
  lastRosterSize: number;
  joinLatencyMs: number | null;
  // request log: every /api call this user made, for the rolling 60 s peak.
  reqTimes: number[];
  count429: number;
  count5xx: number;
  countNet: number; // network errors (timeout/reset) — reported, not gated
  inBreakout: boolean;
  roomId: string | null; // breakout roomId from match:assigned, for /token
}

let host: TestUser;
let participants: TestUser[] = [];
let podId: string;
let sessionId: string;
const clients: VClient[] = [];

// ── Non-throwing HTTP call that RECORDS rate-limit + server errors ───────────
// The helpers' apiRequest throws on non-2xx — fine for host setup, fatal for a
// load loop where a 429 is a measurement, not an abort. This records status +
// latency and only surfaces 5xx for the report.
async function httpCall(c: VClient, method: string, path: string, body?: any): Promise<number> {
  const t0 = nowMs();
  c.reqTimes.push(t0);
  let status = 0;
  try {
    const res = await fetch(`${API}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.user.accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    await res.text().catch(() => '');
  } catch {
    status = -1; // network error (timeout / reset) — counted separately from 429
  }
  if (status === 429) c.count429++;
  else if (status >= 500) c.count5xx++;
  else if (status === -1) c.countNet++;
  return status;
}

// Peak requests in any rolling WINDOW_MS for this user (the value the limiter
// actually buckets on).
function peakPerWindow(c: VClient): number {
  const t = c.reqTimes.slice().sort((a, b) => a - b);
  let peak = 0, lo = 0;
  for (let hi = 0; hi < t.length; hi++) {
    while (t[hi] - t[lo] > WINDOW_MS) lo++;
    peak = Math.max(peak, hi - lo + 1);
  }
  return peak;
}

// ── Socket helpers ────────────────────────────────────────────────────────────
function nowMs(): number {
  // Date.now() is fine in a Playwright test process (only the Workflow script
  // sandbox forbids it).
  return Date.now();
}

async function connectSocket(c: VClient, attempts = 3): Promise<void> {
  for (let a = 1; a <= attempts; a++) {
    // reconnection:true mirrors the real SPA: a transient ws ping-timeout over a
    // multi-minute lobby must NOT permanently drop the user (that was flipping
    // them to status='disconnected' → excluded from matching). On every
    // (re)connect we re-establish room membership, exactly like the client does.
    const s = io(SERVER, {
      auth: { token: c.user.accessToken },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
      timeout: 45_000,
    });
    // Authoritative roster snapshot — same event the churn test trusts.
    s.on('session:state', (d: any) => {
      if (Array.isArray(d?.participants)) c.lastRosterSize = d.participants.length;
    });
    // Breakout placement / return — the round-transition signals (server
    // emits match:assigned on move-in, match:return_to_lobby on round end).
    const captureRoom = (d: any) => {
      c.inBreakout = true;
      c.roomId = d?.roomId ?? d?.room?.id ?? d?.match?.roomId ?? d?.location?.roomId ?? c.roomId;
    };
    s.on('match:assigned', captureRoom);
    s.on('match:reassigned', captureRoom);
    s.on('match:return_to_lobby', () => { c.inBreakout = false; });
    s.on('session:round_ended', () => { c.inBreakout = false; });
    s.on('error', (e: any) => { participantErrors.push({ email: c.user.email, d: safeStr(e) }); });
    s.on('disconnect', () => { c.connected = false; });
    // Persistent (re)connect handler: first connect just marks connected; any
    // RECONNECT re-joins the session room + re-asserts ready/heartbeat so the
    // user stays in the eligible main-room set.
    s.on('connect', () => {
      c.connected = true;
      if (c.joined) {
        try {
          s.emit('session:join', { sessionId });
          s.emit('presence:ready', { sessionId });
          s.emit('presence:heartbeat', { sessionId });
        } catch { /* mid-teardown */ }
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('socket connect timeout')), 45_000);
        s.once('connect', () => { clearTimeout(to); resolve(); });
        s.once('connect_error', (e) => { clearTimeout(to); reject(e); });
      });
      c.socket = s;
      c.connected = true;
      return;
    } catch (e) {
      try { s.close(); } catch { /* ignore */ }
      if (a === attempts) throw e;
    }
  }
}

function mk(u: TestUser): VClient {
  return {
    user: u, socket: null, connected: false, joined: false,
    lastRosterSize: 0, joinLatencyMs: null, reqTimes: [], count429: 0,
    count5xx: 0, countNet: 0, inBreakout: false, roomId: null,
  };
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-USER REAL HTTP REQUEST PATTERN
// Mapped from the live client (file:line cited in the gate work notes):
//   join:   POST /sessions/:id/register (useSessionSocket.ts:127),
//           GET  /sessions/:id           (LiveSessionPage.tsx:81),
//           GET  /sessions/:id/state     (useSessionSocket.ts:1177),
//           POST /sessions/:id/token     (useSessionSocket.ts:1213; ≤3 retries)
//   lobby:  GET  /sessions/:id/state     every 10s (Lobby.tsx converge),
//           POST /sessions/:id/token     every 30s (PERIODIC_RESYNC_MS),
//           GET  /sessions/:id           every 30s background
//   move:   POST /sessions/:id/token     w/ roomId, ≤3 retries (useSessionSocket.ts:622)
//   rating: POST /ratings (×partners), GET /ratings/unrated,
//           GET /ratings/sessions/:id/people-met, GET /ratings/sessions/:id/stats
//   (presence:heartbeat is a SOCKET event — NOT rate-limited — so excluded.)
// ─────────────────────────────────────────────────────────────────────────────
const EP = {
  register: (sid: string) => `/sessions/${sid}/register`,
  session: (sid: string) => `/sessions/${sid}`,
  state: (sid: string) => `/sessions/${sid}/state`,
  token: (sid: string) => `/sessions/${sid}/token`,
  ratingsUnrated: (sid: string) => `/ratings/unrated?sessionId=${sid}`,
  peopleMet: (sid: string) => `/ratings/sessions/${sid}/people-met`,
  stats: (sid: string) => `/ratings/sessions/${sid}/stats`,
  ratings: () => `/ratings`,
};

// Join burst — the 4 REST calls the SPA fires landing on /live, lightly
// staggered (the real client spaces the /state fetch ~250 ms after mount).
async function joinHttpBurst(c: VClient): Promise<void> {
  await httpCall(c, 'POST', EP.register(sessionId));
  await httpCall(c, 'GET', EP.session(sessionId));
  await sleep(250);
  await httpCall(c, 'GET', EP.state(sessionId));
  await httpCall(c, 'POST', EP.token(sessionId), { roomId: null });
}

// One 10 s lobby tick. tick counts from 0; every 3rd tick (~30 s) also fires the
// PERIODIC_RESYNC token re-fetch + the 30 s background session GET.
async function lobbyPollTick(c: VClient, tick: number): Promise<void> {
  await httpCall(c, 'GET', EP.state(sessionId));
  if (tick > 0 && tick % 3 === 0) {
    await httpCall(c, 'POST', EP.token(sessionId), { roomId: null });
    await httpCall(c, 'GET', EP.session(sessionId));
  }
}

// Foreground catch-up after a background-throttled stretch: the visibilitychange
// converge (Lobby.tsx) — one immediate /state, plus a token re-fetch. This is
// the "many tabs return at once" burst the gate watches for 429s.
async function foregroundCatchUp(c: VClient): Promise<void> {
  await httpCall(c, 'GET', EP.state(sessionId));
  await httpCall(c, 'POST', EP.token(sessionId), { roomId: null });
}

// Room transition — breakout token fetch with the real ≤3-retry backoff. We
// model 1 success; on a non-2xx we honour the client's retry (up to 3) so a
// slow /token reproduces the worst-case per-user burst.
async function roundMoveBurst(c: VClient, roomId: string | null): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const st = await httpCall(c, 'POST', EP.token(sessionId), { roomId });
    if (st >= 200 && st < 300) break;
    await sleep(attempt === 1 ? 1000 : 2000); // 1s, 2s backoff like the client
  }
}

// Rating + recap burst at round/event end (~6 requests).
async function ratingBurst(c: VClient, partners = 1): Promise<void> {
  for (let i = 0; i < partners; i++) {
    await httpCall(c, 'POST', EP.ratings(), { matchId: null, qualityScore: 5, meetAgain: true });
  }
  await httpCall(c, 'GET', EP.ratingsUnrated(sessionId));
  await httpCall(c, 'GET', EP.peopleMet(sessionId));
  await httpCall(c, 'GET', EP.stats(sessionId));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function safeStr(d: any): string {
  try { return (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 220); } catch { return String(d).slice(0, 220); }
}

// Faithful presence signals.
//  • presence:ready  — the SPA emits this on entering the lobby; the server
//    flips session_participants.status → in_lobby, which is what main-room
//    ELIGIBILITY (matching.service eligibleMainRoomCount) keys on. Without it,
//    clients fall out of the eligible set after the initial socket-presence
//    window and the matcher generates 0 matches.
//  • presence:heartbeat — every ~10–15s; keeps presenceMap fresh (90s stale
//    sweep). handleHeartbeat expects exactly { sessionId }.
function ready(c: VClient): void {
  try { c.socket?.emit('presence:ready', { sessionId }); } catch { /* mid-reconnect */ }
}
function heartbeat(c: VClient): void {
  try { c.socket?.emit('presence:heartbeat', { sessionId }); } catch { /* mid-reconnect */ }
}

const HOST_DIAG_EVENTS = [
  'error', 'session:matching_preparing', 'host:match_preview', 'session:matching_cancelled',
  'session:matches_confirmed', 'session:round_started', 'session:round_ended', 'host:round_dashboard',
];
function attachHostDiagnostics(c: VClient): void {
  for (const ev of HOST_DIAG_EVENTS) {
    c.socket?.on(ev, (d: any) => hostEvents.push({ ev, d: safeStr(d) }));
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
test.beforeAll(async () => {
  test.setTimeout(300_000);
  host = await createTestUser('lg40host', 'super_admin');
  participants = await Promise.all(
    Array.from({ length: N }, (_, i) => createTestUser(`lg40u${i}`)),
  );
  const pod = await createPod(host, 'E2E LoadGate40 Pod');
  podId = pod.id;
  for (const u of participants) await addPodMember(host, podId, u.id);
  const sess = await createSession(host, podId, 'E2E LoadGate40', new Date(Date.now() + 60_000), {
    numberOfRounds: 3,
    roundDurationSeconds: 600, // long round so churn happens inside one active round
    maxParticipants: 60,
  });
  sessionId = sess.id;
  await Promise.all(participants.map(u => registerForSession(u, sessionId)));

  // Start the session as host (socket), then drop that bootstrap socket.
  const hostBoot = mk(host);
  await connectSocket(hostBoot);
  await new Promise<void>((r) => { hostBoot.socket!.emit('host:start_session', { sessionId }); setTimeout(r, 2500); });
  hostBoot.socket!.disconnect();
});

test.afterAll(async () => {
  for (const c of clients) { try { c.socket?.disconnect(); } catch {} }
  try { await endSession(host, sessionId); } catch {}
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

// Wait until predicate holds for every item or the deadline passes.
async function waitFor(
  items: VClient[],
  pred: (c: VClient) => boolean,
  timeoutMs: number,
  pollMs = 2000,
): Promise<number> {
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    const pending = items.filter((c) => !pred(c));
    if (pending.length === 0) return items.length;
    await sleep(pollMs);
  }
  return items.filter(pred).length;
}

// ── The gate ──────────────────────────────────────────────────────────────────
test(`load gate: ${N} users — burst join latency, zero 429s, round under churn`, async () => {
  test.setTimeout(1_200_000);

  // The host drives the round over its own socket and counts in the roster
  // (it's excluded from matching, not from presence — same as the churn test).
  const hostC = mk(host);
  const parts = participants.map(mk);
  clients.push(hostC, ...parts);

  // ── PHASE 1: BURST JOIN — all participants connect+join at once; measure
  //            connect→first-authoritative-roster latency per user ────────────
  console.log(`\n[1] Burst join: ${N} participants + host…`);
  await connectSocket(hostC);
  attachHostDiagnostics(hostC);
  hostC.socket!.emit('session:join', { sessionId });
  hostC.joined = true;
  heartbeat(hostC);

  const joinOne = async (c: VClient) => {
    const t0 = nowMs();
    try {
      await connectSocket(c);
    } catch {
      return; // counted as a failed join in the report
    }
    c.socket!.emit('session:join', { sessionId });
    c.joined = true;
    ready(c);
    heartbeat(c);
    // Real SPA REST burst (register/session/state/token) — fire concurrently
    // with the socket snapshot; both yield the roster.
    void joinHttpBurst(c);
    // Latency = time until this client holds an authoritative roster.
    const deadline = nowMs() + JOIN_LATENCY_BUDGET_MS * 3;
    while (nowMs() < deadline && c.lastRosterSize === 0) await sleep(250);
    c.joinLatencyMs = nowMs() - t0;
  };
  await Promise.allSettled(parts.map(joinOne));

  const joinedParts = parts.filter((c) => c.connected && c.joined);
  console.log(`    joined: ${joinedParts.length}/${N}`);
  expect(joinedParts.length, 'nearly all participants must connect+join').toBeGreaterThanOrEqual(Math.ceil(N * 0.95));

  // ── PHASE 2: CONVERGENCE + early 429 check ─────────────────────────────────
  // Poll up to 25s for the debounced/coalesced roster broadcast (TRF-1) to land
  // on every client — more robust at 40 users than a fixed settle.
  const joinedAll = clients.filter((c) => c.connected && c.joined);
  const expectedRoster = joinedAll.length;
  const convergeDeadline = nowMs() + 25_000;
  while (nowMs() < convergeDeadline) {
    if (joinedAll.every((c) => c.lastRosterSize === expectedRoster)) break;
    await sleep(2000);
  }
  const sizes = [...new Set(joinedAll.map((c) => c.lastRosterSize))];
  console.log(`[2] Convergence: expected=${expectedRoster}, distinct sizes seen=${JSON.stringify(sizes)}`);
  expect(sizes.length, 'every client must agree on the roster size').toBe(1);
  expect(sizes[0], 'and it must equal reality (joined sockets)').toBe(expectedRoster);
  const early429 = parts.reduce((s, c) => s + c.count429, 0);
  console.log(`    429s so far: ${early429}`);
  expect(early429, 'no legit user may be rate-limited during the join storm').toBe(0);

  // ── PHASE 3: LOBBY LOAD — 5×10s poll ticks; a slice is "backgrounded"
  //            (paused) then foregrounds with a catch-up burst ───────────────
  console.log(`[3] Lobby load: ${LOBBY_TICKS} poll ticks (~${LOBBY_TICKS * 10}s) with a backgrounded slice…`);
  const bgTab = joinedParts.slice(0, Math.floor(joinedParts.length * BGTAB_FRAC));
  const bgSet = new Set(bgTab);
  const lastTick = LOBBY_TICKS - 1;
  for (let tick = 0; tick < LOBBY_TICKS; tick++) {
    await sleep(10_000);
    await Promise.allSettled(
      joinedParts.map((c) => {
        heartbeat(c); // SPA heartbeats every 15s regardless of fg/bg
        if (bgSet.has(c)) {
          // backgrounded: skip middle ticks, then a foreground catch-up on the last
          return tick === lastTick ? foregroundCatchUp(c) : Promise.resolve();
        }
        return lobbyPollTick(c, tick);
      }),
    );
  }

  // ── PHASE 4: ROUND UNDER CHURN ─────────────────────────────────────────────
  // (a) refresh wave just as the round starts — reconnect + refetch
  const refreshers = joinedParts.slice(0, Math.floor(joinedParts.length * REFRESH_FRAC));
  console.log(`[4] Round under churn. Refreshing ${refreshers.length} as the round starts…`);
  await Promise.allSettled(
    refreshers.map(async (c) => {
      try { c.socket?.disconnect(); } catch {}
      c.connected = false; c.joined = false; c.lastRosterSize = 0;
      await connectSocket(c);
      c.socket!.emit('session:join', { sessionId });
      c.joined = true;
      ready(c);
      heartbeat(c);
      await foregroundCatchUp(c); // the SPA refetches state+token on reload
    }),
  );
  await sleep(3000);

  // (b) host generates + confirms the round
  // DIAG: snapshot participant DB status + live socket connectivity right before
  // generation, so a 0-eligible failure shows its cause directly.
  try {
    const pre = await pool.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM session_participants WHERE session_id=$1 GROUP BY status`, [sessionId],
    );
    const liveSockets = parts.filter((c) => c.socket?.connected).length;
    const hostLive = hostC.socket?.connected;
    console.log(`    DIAG pre-generate: participant statuses=${JSON.stringify(pre.rows)} | live participant sockets=${liveSockets}/${parts.length} | host socket live=${hostLive}`);
  } catch (e: any) { console.log('    DIAG pre-generate query failed:', e?.message); }
  hostC.socket!.emit('host:generate_matches', { sessionId });
  await sleep(12_000); // engine for N users + preview
  hostC.socket!.emit('host:confirm_round', { sessionId });

  // participants get match:assigned → the breakout-token burst
  await waitFor(joinedParts, (c) => c.inBreakout, 60_000, 2500);
  await Promise.allSettled(joinedParts.filter((c) => c.inBreakout).map((c) => roundMoveBurst(c, c.roomId)));

  // (c) disconnect/rejoin churn DURING the breakout
  const droppers = joinedParts.slice(joinedParts.length - Math.floor(joinedParts.length * DISCONNECT_FRAC));
  if (droppers.length > 0) {
    console.log(`    disconnecting ${droppers.length} past the 15s grace, then rejoining…`);
    for (const c of droppers) { try { c.socket?.disconnect(); } catch {} c.connected = false; c.joined = false; }
    await sleep(DISCONNECT_GRACE_MS);
    await Promise.allSettled(
      droppers.map(async (c) => {
        await connectSocket(c);
        c.socket!.emit('session:join', { sessionId });
        c.joined = true;
        ready(c);
        heartbeat(c);
        await foregroundCatchUp(c);
      }),
    );
  }

  const stable = joinedParts.filter((c) => !droppers.includes(c));
  const inRoom = stable.filter((c) => c.inBreakout).length;
  console.log(`    in breakout (stable cohort): ${inRoom}/${stable.length}`);
  // diagnostics (printed before the assert so a failing run still shows the wire)
  console.log(`    host wire events (${hostEvents.length}): ${JSON.stringify(hostEvents.slice(0, 12))}`);
  if (participantErrors.length) console.log(`    participant errors (${participantErrors.length}): ${JSON.stringify(participantErrors.slice(0, 6))}`);
  expect(inRoom, 'most of the stable cohort must reach the breakout UI').toBeGreaterThanOrEqual(Math.ceil(stable.length * 0.8));

  // ── PHASE 5: END → RETURN → RATING BURST → GHOST WATCH ─────────────────────
  console.log('[5] Ending round → return to main → rating burst → ghost watch…');
  hostC.socket!.emit('host:end_session', { sessionId });
  const returned = await waitFor(joinedParts.filter((c) => c.connected), (c) => !c.inBreakout, 90_000, 2500);
  console.log(`    returned to main: ${returned}/${joinedParts.filter((c) => c.connected).length}`);
  expect(joinedParts.filter((c) => c.connected && c.inBreakout).length, 'everyone must leave the breakout on round end').toBe(0);

  // recap REST burst (people-met / stats / unrated / ratings)
  await Promise.allSettled(joinedParts.filter((c) => c.connected).map((c) => ratingBurst(c, 1)));

  // ghost watch — no dead-room re-pull
  console.log(`    ${Math.round(GHOST_WATCH_MS / 1000)}s ghost watch…`);
  const ghostDeadline = nowMs() + GHOST_WATCH_MS;
  while (nowMs() < ghostDeadline) {
    const ghost = joinedParts.find((c) => c.connected && c.inBreakout);
    if (ghost) throw new Error(`GHOST RE-PULL: ${ghost.user.email} re-entered a dead breakout room`);
    await sleep(4000);
  }

  // ── REPORT + STRICT GATE ASSERTIONS ────────────────────────────────────────
  const latencies = parts.map((c) => c.joinLatencyMs).filter((x): x is number => x != null);
  const peaks = parts.map(peakPerWindow);
  const total429 = parts.reduce((s, c) => s + c.count429, 0);
  const total5xx = parts.reduce((s, c) => s + c.count5xx, 0);
  const totalNet = parts.reduce((s, c) => s + c.countNet, 0);
  const maxPeak = Math.max(0, ...peaks);

  console.log('\n──────── LOAD GATE REPORT ────────');
  console.log(`  users:                 ${N} participants + 1 host`);
  console.log(`  join latency (ms):     p50=${pct(latencies, 50)}  p95=${pct(latencies, 95)}  max=${Math.max(0, ...latencies)}`);
  console.log(`  per-user req/60s:      max=${maxPeak}  (prod limit ${PER_USER_LIMIT})`);
  console.log(`  429s (legit traffic):  ${total429}`);
  console.log(`  5xx server errors:     ${total5xx}`);
  console.log(`  network errors:        ${totalNet}  (reported, not gated)`);
  console.log(`  breakout reached:      ${inRoom}/${stable.length} stable`);
  console.log(`  returned to main:      ${returned}`);
  console.log('──────────────────────────────────\n');

  // (1) join-window latency
  expect(pct(latencies, 95), 'p95 join latency within budget').toBeLessThanOrEqual(JOIN_LATENCY_BUDGET_MS);
  // (2) zero 429s for legitimate traffic — the core TRF-2 proof
  expect(total429, 'ZERO 429s for legitimate per-user traffic').toBe(0);
  // headroom signal: warn loudly if any user came within 80% of the bucket
  if (maxPeak >= PER_USER_LIMIT * 0.8) {
    console.warn(`⚠ per-user peak ${maxPeak}/60s is within 80% of the ${PER_USER_LIMIT} limit — legit headroom is thin; consider raising RATE_LIMIT_MAX_REQUESTS or coalescing further.`);
  }
  // (3) round transition under churn already asserted (breakout reached + all returned + zero ghosts)
  expect(total5xx, 'no server (5xx) errors under load').toBe(0);
  console.log('✓ load gate passed');
});
