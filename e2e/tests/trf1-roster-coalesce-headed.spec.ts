// TRF-1 (audit C3) — HEADED prod E2E for the roster:changed coalescer + the
// convergence guarantee.
//
// Setup on prod: a live event with 3 real browser "observers" already in the
// lobby. Then 8 throwaway users join in a burst (socket session:join, ~1/s),
// each firing a server roster:changed broadcast to the room.
//
// Asserts (outcome-based, via network interception — not DOM selectors):
//   1. COALESCE: each observer issues FAR fewer than 8 GET /state fetches
//      during the burst (<= 6: leading+trailing per 3s window + at most one
//      periodic resync), proving it no longer refetches once per roster:changed.
//   2. TRAILING / CONVERGENCE-IN-TIME: each observer issues at least one
//      GET /state that STARTS after the last join — so it converges to the
//      final roster, never starves.
//   3. CONVERGENCE: every observer's LAST /state response reports the SAME
//      connectedParticipants count — no two users stuck on different numbers.
//   4. NO BACKWARDS REGRESSION: reload one observer after the burst; its final
//      count equals the others (the stale-response guard holds).
//
// Run: JWT_SECRET=<prod> npx playwright test trf1-roster-coalesce-headed

import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, pool, TestUser } from '../helpers/auth';
import { createPod, addPodMember, registerForSession, createSession, startSession, endSession } from '../helpers/api';

const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const SOCKET = process.env.E2E_SERVER_URL || 'https://rsn-api-h04m.onrender.com';
const N_OBSERVERS = 3;
const N_JOINERS = 8;

interface Observer { user: TestUser; ctx: BrowserContext; page: Page; stateReqs: number[]; lastCount: number | null; }

test.describe.serial('TRF-1 — roster coalescer + convergence (headed prod)', () => {
  let browser: Browser;
  let host: TestUser;
  let observers: Observer[] = [];
  let joiners: TestUser[] = [];
  let podId: string;
  let sessionId: string;
  const sockets: Socket[] = [];

  function trackState(o: Observer) {
    o.page.on('request', (req) => {
      if (req.method() === 'GET' && /\/sessions\/[^/]+\/state(\?|$)/.test(req.url())) o.stateReqs.push(Date.now());
    });
    o.page.on('response', async (res) => {
      if (/\/sessions\/[^/]+\/state(\?|$)/.test(res.url()) && res.status() === 200) {
        try { const b = await res.json(); const n = b?.data?.connectedParticipants?.length; if (typeof n === 'number') o.lastCount = n; } catch { /* ignore */ }
      }
    });
  }

  test.beforeAll(async () => {
    host = await createTestUser('trf1-host', 'super_admin');
    for (let i = 0; i < N_OBSERVERS; i++) observers.push({ user: await createTestUser(`trf1-obs-${i}`), ctx: null as any, page: null as any, stateReqs: [], lastCount: null });
    for (let i = 0; i < N_JOINERS; i++) joiners.push(await createTestUser(`trf1-join-${i}`));

    const pod = await createPod(host, 'E2E TRF-1 Pod');
    podId = pod.id;
    for (const o of observers) await addPodMember(host, podId, o.user.id);
    for (const j of joiners) await addPodMember(host, podId, j.id);

    const sess = await createSession(host, podId, 'E2E TRF-1 roster coalesce', new Date(Date.now() + 60_000));
    sessionId = sess.id;
    await Promise.all([...observers.map(o => registerForSession(o.user, sessionId)), ...joiners.map(j => registerForSession(j, sessionId))]);
    try { await startSession(host, sessionId); } catch { /* may already be live */ }

    browser = await chromium.launch({ headless: false });
    for (const o of observers) {
      o.ctx = await browser.newContext();
      o.page = await o.ctx.newPage();
      await o.page.goto(APP, { waitUntil: 'domcontentloaded' });
      await o.page.evaluate(({ a, r }) => { localStorage.setItem('rsn_access', a); localStorage.setItem('rsn_refresh', r); }, { a: o.user.accessToken, r: o.user.refreshToken });
      await o.page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
    }
    // Let all observers fully hydrate + settle their INITIAL fetches before we measure.
    await new Promise(r => setTimeout(r, 8000));
    observers.forEach(trackState);
  });

  test.afterAll(async () => {
    for (const s of sockets) { try { s.disconnect(); } catch { /* ignore */ } }
    for (const o of observers) { try { await o.page?.close(); } catch { /* ignore */ } try { await o.ctx?.close(); } catch { /* ignore */ } }
    try { await browser?.close(); } catch { /* ignore */ }
    try { await endSession(host, sessionId); } catch { /* ignore */ }
    const result = await cleanupTestData();
    // eslint-disable-next-line no-console
    console.log('TRF-1 headed cleanup:', result);
    try { await pool.end(); } catch { /* ignore */ }
  });

  test('a burst of joins is coalesced and all observers converge to the same count', async () => {
    const measureStart = Date.now();
    observers.forEach(o => { o.stateReqs.length = 0; });

    // Fire all 8 joiners in PARALLEL for a TIGHT burst (~2-3s) — each join
    // triggers a server roster:changed to the room. A tight burst is the real
    // 30-50-person arrival scenario and keeps the window inside one coalesce
    // cycle so the per-join-vs-coalesced contrast is unambiguous.
    await Promise.all(joiners.map(j => new Promise<void>((resolve) => {
      const s = io(SOCKET, { auth: { token: j.accessToken }, transports: ['websocket'], reconnection: false });
      sockets.push(s);
      s.on('connect', () => { s.emit('session:join', { sessionId }); setTimeout(resolve, 200); });
      s.on('connect_error', () => resolve());
      setTimeout(resolve, 8000);
    })));
    const lastJoinAt = Date.now();
    // Wait out the trailing-edge window (3s) + jitter (1s) + settle.
    await new Promise(r => setTimeout(r, 8000));

    const burstSecs = Math.round((lastJoinAt - measureStart) / 100) / 10;
    for (let i = 0; i < observers.length; i++) {
      const o = observers[i];
      const duringBurst = o.stateReqs.filter(t => t >= measureStart);
      const afterLastJoin = duringBurst.filter(t => t > lastJoinAt);
      const deltas = duringBurst.map(t => Math.round((t - measureStart) / 100) / 10);
      const gaps = deltas.slice(1).map((d, k) => Math.round((d - deltas[k]) * 10) / 10);
      // eslint-disable-next-line no-console
      console.log(`  observer ${i}: ${duringBurst.length} /state for ${N_JOINERS} joins (burst ${burstSecs}s) | after-last-join:${afterLastJoin.length} | count:${o.lastCount}\n     fetch@s: [${deltas.join(', ')}]\n     gaps:   [${gaps.join(', ')}]`);
      // 1. COALESCE — a tight burst of 8 joins yields the leading + a trailing
      //    roster fetch (~2), plus at most ~1 Lobby 10s-poll converge in the
      //    window. One-per-join would be >=8. Assert strictly better than
      //    one-per-join, and within the coalesced+poll budget.
      expect(duringBurst.length).toBeLessThan(N_JOINERS);
      expect(duringBurst.length).toBeLessThanOrEqual(5);
      // 2. TRAILING — at least one fetch STARTS after the final join, so the
      //    client converges to the final roster (never starves).
      expect(afterLastJoin.length).toBeGreaterThanOrEqual(1);
    }

    // 3. CONVERGENCE — every observer ended on the SAME participant count.
    const counts = observers.map(o => o.lastCount);
    // eslint-disable-next-line no-console
    console.log('  final counts:', counts);
    counts.forEach(c => expect(typeof c).toBe('number'));
    expect(new Set(counts).size).toBe(1);
  });

  test('reloading an observer after the burst lands on the same count (no stale regression)', async () => {
    const reference = observers[1].lastCount;
    const o = observers[0];
    o.lastCount = null;
    await o.page.reload({ waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 6000));
    // eslint-disable-next-line no-console
    console.log(`  reloaded observer 0 -> ${o.lastCount} | reference ${reference}`);
    expect(o.lastCount).toBe(reference);
  });
});
