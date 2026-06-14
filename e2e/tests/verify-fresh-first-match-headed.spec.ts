import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, apiRequest } from '../helpers/api';

// ─── HEADED PROD — first "Match People" press must show FRESH pairs ───────────
// Ali's 6-round/bonus test bug: after a round, the FIRST Match press surfaced an
// already-met pair ("Met 1x") while fresh pairings were still available; fresh
// only appeared on Re-match. Root cause: pre-planned 'scheduled' future rounds
// were counted as already-met, forcing the fallback ladder to L4. With 4 people
// there are exactly 3 distinct pairings, so rounds 2 AND 3 must be FRESH on the
// first press (only rounds 4+ are forced to repeat). This drives a real event on
// prod and asserts the host's first preview each round carries no metBefore pair
// until fresh pairings are genuinely exhausted.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser;
const P: TestUser[] = [];
let podId = '', sessionId = '';
let browser: Browser;
let hostSock: Socket;
const ctxs: BrowserContext[] = [];
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: true });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket timeout')), 12_000);
  });
}
const gotoRetry = async (page: Page, url: string) => {
  for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } }
};
const partPages = () => ctxs.map(c => c.pages()[0]);
const inMain = async (p: Page) => (await p.getByRole('button', { name: 'Compact', exact: true }).count().catch(() => 0)) > 0;

async function openUser(u: TestUser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 760 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return page;
}

// Resolve with the NEXT host:match_preview after `trigger` runs.
function nextPreview(trigger: () => void, timeout = 30_000): Promise<{ matches: any[]; usedRepeats?: boolean }> {
  return new Promise((res, rej) => {
    const onPrev = (data: any) => { hostSock.off('host:match_preview', onPrev); res(data); };
    hostSock.on('host:match_preview', onPrev);
    setTimeout(() => { hostSock.off('host:match_preview', onPrev); rej(new Error('no host:match_preview within timeout')); }, timeout);
    trigger();
  });
}

test.beforeAll(async () => {
  host = await createTestUser('ffhost', 'super_admin');
  for (let i = 1; i <= 4; i++) P.push(await createTestUser(`ffp${i}`));
  const pod = await createPod(host, 'E2E FreshFirst Pod'); podId = pod.id;
  for (const u of P) await addPodMember(host, podId, u.id);
  const sess = await createSession(host, podId, 'VERIFY fresh-first match', new Date(Date.now() + 60_000), {
    numberOfRounds: 5, roundDurationSeconds: 120, ratingWindowSeconds: 20, transitionDurationSeconds: 20,
  });
  sessionId = sess.id;
  await Promise.all(P.map(u => registerForSession(u, sessionId)));
  browser = await chromium.launch({ headless: false, slowMo: 100, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  try { hostSock?.disconnect(); } catch {}
  for (const c of ctxs) { try { await c.close(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await apiRequest(host, 'POST', `/sessions/${sessionId}/end`); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

const pairsOf = (mp: any[]) => mp.map(m => `${(m.participantA?.displayName||'').slice(-2)}+${(m.participantB?.displayName||'').slice(-2)}${m.metBefore ? ' (MET '+m.timesMet+'x)' : ''}`).join(', ');

test('first Match press shows fresh pairs until fresh pairings are exhausted', async () => {
  test.setTimeout(360_000);
  hostSock = await connect(host);
  for (const u of P) await openUser(u);
  await wait(4000);
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  for (const c of ctxs) { try { await c.pages()[0].reload(); } catch {} await wait(300); }
  await wait(4000);
  await expect.poll(async () => (await Promise.all(partPages().map(inMain))).filter(Boolean).length, { timeout: 30_000 }).toBe(4);
  console.log('  ✓ all 4 in the main room.');

  // Helper to run one round to completion after its preview is captured.
  async function playRoundAfterPreview() {
    hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
    hostSock.emit('host:start_round', { sessionId }); await wait(5000);
    hostSock.emit('host:end_session', { sessionId }); await wait(3500);     // → rating
    hostSock.emit('host:force_close_rating', { sessionId }); await wait(4500); // → transition
    await expect.poll(async () => (await Promise.all(partPages().map(inMain))).filter(Boolean).length, { timeout: 30_000 }).toBe(4);
  }

  // Round 1 — first round is always fresh.
  const r1 = await nextPreview(() => hostSock.emit('host:generate_matches', { sessionId }));
  console.log(`  R1 first preview: ${pairsOf(r1.matches)}`);
  expect(r1.matches.every((m: any) => !m.metBefore), 'round 1 first preview must be all fresh').toBe(true);
  await playRoundAfterPreview();

  // Round 2 — THE BUG: must be FRESH on the first press (2 fresh matchings remain).
  const r2 = await nextPreview(() => hostSock.emit('host:generate_matches', { sessionId }));
  console.log(`  R2 first preview: ${pairsOf(r2.matches)}`);
  expect(r2.matches.every((m: any) => !m.metBefore), 'round 2 FIRST press must show fresh pairs (no Met 1x)').toBe(true);
  await playRoundAfterPreview();

  // Round 3 — still one fresh matching left; first press must be fresh.
  const r3 = await nextPreview(() => hostSock.emit('host:generate_matches', { sessionId }));
  console.log(`  R3 first preview: ${pairsOf(r3.matches)}`);
  expect(r3.matches.every((m: any) => !m.metBefore), 'round 3 FIRST press must show fresh pairs').toBe(true);
  await playRoundAfterPreview();

  // Round 4 — all 3 distinct pairings now used; a repeat here is CORRECT.
  const r4 = await nextPreview(() => hostSock.emit('host:generate_matches', { sessionId }));
  console.log(`  R4 first preview: ${pairsOf(r4.matches)} (a repeat here is expected — fresh exhausted)`);
  console.log('  ✓ fresh-first verified: rounds 1-3 fresh on first press; repeats only once fresh pairings ran out.');
});
