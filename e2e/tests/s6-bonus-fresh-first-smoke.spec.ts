import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod smoke S6 (#6 June-10 debrief) — the first "Match People" of a bonus
// round must use fresh pairs whenever they exist, never showing met-1x/2x when a
// fresh pairing is available. Reproduces today's TESTEVENT round-5 shape: TWO
// users (m1, m3) have already met everyone, so exactly ONE repeat is forced —
// the optimal pairing is m1+m3 (the two constrained) plus two fresh pairs. A
// naive fresh-first greedy lands TWO repeats; the new reduceRepeatPairs 2-opt
// must bring it to ONE. Self-validating: the old build shows 2 met pairs.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, m: TestUser[] = [];
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

test.beforeAll(async () => {
  host = await createTestUser('s6host', 'super_admin');
  for (let i = 0; i < 6; i++) m.push(await createTestUser(`s6m${i + 1}`)); // m[0]=m1 … m[5]=m6
  const pod = await createPod(host, 'E2E S6 Pod');
  podId = pod.id;
  for (const u of m) await addPodMember(host, podId, u.id);
  // platform_wide forces the LIVE engine (generateSingleRound) on the first
  // "Match People" — it never surfaces the pre-plan — while still applying the
  // within-event exclusion. That is the exact code path a bonus round uses, so
  // it deterministically exercises the #6 2-opt without having to play out
  // multiple rounds first. numberOfRounds:1 keeps the pre-plan from seeding
  // extra exclusions across future rounds.
  const sess = await createSession(host, podId, 'E2E S6 bonus fresh-first', new Date(Date.now() + 60_000), {
    matchingPolicy: 'platform_wide',
    numberOfRounds: 1,
  });
  sessionId = sess.id;
  await Promise.all(m.map((u) => registerForSession(u, sessionId)));

  // Seed prior within-event matches so m1 and m3 have each met EVERYONE.
  // Stored under a high round_number so generating round 1 excludes them all.
  const metPairs: [string, string][] = [
    [m[0].id, m[1].id], [m[0].id, m[2].id], [m[0].id, m[3].id], [m[0].id, m[4].id], [m[0].id, m[5].id], // m1 met all
    [m[2].id, m[1].id], [m[2].id, m[3].id], [m[2].id, m[4].id], [m[2].id, m[5].id],                     // m3 met all
  ];
  for (const [a, b] of metPairs) {
    await pool.query(
      `INSERT INTO matches (session_id, round_number, participant_a_id, participant_b_id, status, is_manual)
       VALUES ($1, 99, $2, $3, 'completed', false)`,
      [sessionId, a, b],
    );
  }

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

test('S6: first Match People uses fresh pairs — only the one forced repeat appears', async () => {
  test.setTimeout(150_000);

  const hostSock = await connect(host); sockets.push(hostSock);
  let preview: any = null;
  hostSock.on('host:match_preview', (p) => { preview = p; });

  // Open the lobby; bring all 6 members present.
  hostSock.emit('host:start_session', { sessionId });
  await wait(2500);
  for (const u of m) { const s = await connect(u); sockets.push(s); s.emit('session:join', { sessionId }); }
  await wait(4000);

  // Headed: the host is really on the live page (visual confirmation of the preview).
  const ctx = await browser.newContext();
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: host.accessToken, r: host.refreshToken });
  const page = await ctx.newPage();
  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);

  // FIRST "Match People" click.
  hostSock.emit('host:generate_matches', { sessionId });
  for (let i = 0; i < 20 && !preview; i++) await wait(1000);
  expect(preview, 'host should receive a match preview').toBeTruthy();

  // Assert on the ACTUAL pairing against the seeded met-set (the cross-event
  // `metBefore` flag does not reflect within-event seeds, so we compute repeats
  // ourselves from who-met-whom).
  const pk = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const metSet = new Set([
    pk(m[0].id, m[1].id), pk(m[0].id, m[2].id), pk(m[0].id, m[3].id), pk(m[0].id, m[4].id), pk(m[0].id, m[5].id),
    pk(m[2].id, m[1].id), pk(m[2].id, m[3].id), pk(m[2].id, m[4].id), pk(m[2].id, m[5].id),
  ]);
  // Diagnostics: resolved policy + how the round was generated (fallback_l4 proves
  // the live engine + 2-opt ran; a pre-plan surface would not have those reasons).
  const cfg = (await pool.query('SELECT config FROM sessions WHERE id=$1', [sessionId])).rows[0]?.config;
  const reasons = (await pool.query(
    "SELECT round_number, match_reason, status FROM matches WHERE session_id=$1 AND round_number != 99 ORDER BY round_number",
    [sessionId],
  )).rows;
  console.log('  session matchingPolicy:', cfg?.matchingPolicy, '| numberOfRounds:', cfg?.numberOfRounds);
  console.log('  generated match_reasons:', JSON.stringify(reasons));
  // Actual persisted round-1 pairs (post-2-opt) straight from the DB.
  const pkx = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const metSetDbg = new Set([
    pkx(m[0].id, m[1].id), pkx(m[0].id, m[2].id), pkx(m[0].id, m[3].id), pkx(m[0].id, m[4].id), pkx(m[0].id, m[5].id),
    pkx(m[2].id, m[1].id), pkx(m[2].id, m[3].id), pkx(m[2].id, m[4].id), pkx(m[2].id, m[5].id),
  ]);
  const dbPairs = (await pool.query(
    "SELECT participant_a_id a, participant_b_id b FROM matches WHERE session_id=$1 AND round_number=1 AND status='scheduled'",
    [sessionId],
  )).rows;
  const lab = (id: string) => `m${m.findIndex((u) => u.id === id) + 1}`;
  const dbRepeats = dbPairs.filter((r: any) => metSetDbg.has(pkx(r.a, r.b))).length;
  console.log('  DB round-1 pairs:', dbPairs.map((r: any) => `${lab(r.a)}+${lab(r.b)}${metSetDbg.has(pkx(r.a, r.b)) ? '(R)' : ''}`).join(' '), '=> repeats', dbRepeats);

  const matches = preview.matches || [];
  const idOf = (x: any, side: 'A' | 'B') => x[`participant${side}`]?.userId;
  const repeats = matches.filter((x: any) => metSet.has(pk(idOf(x, 'A'), idOf(x, 'B'))));
  const label = (id: string) => `m${m.findIndex((u) => u.id === id) + 1}`;
  console.log(`  preview pairs: ${matches.length} | repeats vs seed: ${repeats.length} | usedRepeats=${preview.usedRepeats}`);
  matches.forEach((x: any) => {
    const a = idOf(x, 'A'), b = idOf(x, 'B');
    console.log(`    ${label(a)} + ${label(b)}  ${metSet.has(pk(a, b)) ? '(REPEAT)' : '(fresh)'}`);
  });

  // THE FIX: m1 and m3 have each met everyone, so exactly ONE repeat is forced
  // (optimally m1+m3). A naive fresh-first greedy lands TWO; the 2-opt must reach
  // exactly one.
  expect(matches.length, 'three pairs for six present members').toBe(3);
  expect(repeats.length, 'must minimize to the one forced repeat, not leave a fresh pairing on the table').toBe(1);

  // Visual record of the host preview (headed). The on-tile "Met Nx" badge reads
  // the cross-event metBefore flag, so it won't tag these within-event seeds —
  // the load-bearing assertion is the pairing above.
  await page.screenshot({ path: 'test-results/s6-bonus-preview.png' }).catch(() => {});

  await ctx.close();
  console.log('  ✓ bonus round used fresh pairs — minimized to the one forced repeat');
});
