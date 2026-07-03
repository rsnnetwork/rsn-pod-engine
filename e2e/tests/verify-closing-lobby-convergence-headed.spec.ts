import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';

// HEADED PROD — 3 Jul (Stefan/Ali live event): after the LAST round, the host
// pressed Skip Ratings and the participants got STUCK — each alone on a
// closing-lobby screen (their own tile only), until the host force-ended.
//
// Reproduction: last round → rating → host force-close → CLOSING_LOBBY, then
// assert every participant CONVERGES in the shared lobby (sees the others'
// video tiles), not just that a layout toggle exists (my earlier spec's
// false-pass). On the buggy build each participant sees only itself.
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const SERVER = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const NP = 4; // participants (host drives via socket)

let browser: Browser;
let host: TestUser;
const P: TestUser[] = [];
const ctxs: BrowserContext[] = [];
let hostSock: Socket;
let podId = '', sessionId = '';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: Page, url: string) => {
  for (let i = 0; i < 3; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; }
    catch (e) { if (i === 2) throw e; await wait(3000); }
  }
};
function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: true });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket timeout')), 12_000);
  });
}
async function openUser(u: TestUser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 760 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return page;
}
const pageOf = (i: number) => ctxs[i]?.pages()[0];
// How many participant video tiles does this page see? (self + remotes).
const tilesSeen = (page: Page) => page.locator('video').count().catch(() => 0);

test.beforeAll(async () => {
  host = await createTestUser('clhost', 'super_admin');
  for (let i = 1; i <= NP; i++) P.push(await createTestUser(`clp${i}`));
  const pod = await createPod(host, 'E2E ClosingLobby Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY closing-lobby convergence', new Date(Date.now() + 60_000), {
    numberOfRounds: 1, roundDurationSeconds: 120, ratingWindowSeconds: 20,
  });
  sessionId = sess.id;
  await Promise.all(P.map(u => registerForSession(u, sessionId)));
  browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
});

test.afterAll(async () => {
  try { hostSock?.close(); } catch {}
  try { await browser?.close(); } catch {}
  const ids = [host?.id, ...P.map(p => p.id)].filter(Boolean);
  if (podId) {
    // Delete EVERY session under the pod (not just the tracked id) so no
    // sessions.pod_id FK blocks the pod delete, then members, then the pod.
    const sess = await pool.query(`SELECT id FROM sessions WHERE pod_id=$1`, [podId]).catch(() => ({ rows: [] as any[] }));
    for (const s of sess.rows) {
      await pool.query(`DELETE FROM invites WHERE session_id=$1`, [s.id]).catch(()=>{});
      await pool.query(`DELETE FROM encounter_history WHERE last_session_id=$1`, [s.id]).catch(()=>{});
      await pool.query(`DELETE FROM sessions WHERE id=$1`, [s.id]).catch(()=>{});
    }
    await pool.query(`DELETE FROM pod_members WHERE pod_id=$1`, [podId]).catch(()=>{});
    await pool.query(`DELETE FROM pods WHERE id=$1`, [podId]).catch(()=>{});
  }
  if (ids.length) {
    await pool.query(`DELETE FROM encounter_history WHERE user_a_id=ANY($1) OR user_b_id=ANY($1)`, [ids]).catch(()=>{});
    await pool.query(`DELETE FROM audit_log WHERE actor_id=ANY($1)`, [ids]).catch(()=>{});
    await pool.query(`DELETE FROM refresh_tokens WHERE user_id=ANY($1)`, [ids]).catch(()=>{});
    const del = await pool.query(`DELETE FROM users WHERE id=ANY($1) RETURNING id`, [ids]);
    console.log(`Cleanup: ${del.rows.length} users, session ${sessionId}, pod ${podId}`);
  }
});

test('after the last round the closing lobby converges — everyone sees each other', async () => {
  test.setTimeout(300_000);
  hostSock = await connect(host);
  for (const u of P) await openUser(u);
  await wait(5000);

  hostSock.emit('host:start_session', { sessionId }); await wait(3000);
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(8000);
  console.log('  · round 1 started (last round).');

  // End the last round → rating, then host SKIPS ratings → CLOSING_LOBBY.
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);        // → ROUND_RATING
  hostSock.emit('host:force_close_rating', { sessionId }); await wait(2000); // last round → CLOSING_LOBBY
  console.log('  · host skipped ratings — session should be CLOSING_LOBBY.');

  // The decisive assertion: within a reasonable window, EVERY participant must
  // see more than just their own tile (convergence in the shared lobby).
  await expect.poll(async () => {
    const counts = await Promise.all(P.map((_, i) => tilesSeen(pageOf(i))));
    console.log('    closing-lobby tiles seen per participant:', counts.join(', '));
    return counts.filter(c => c >= 2).length; // how many see at least one OTHER
  }, { timeout: 60_000, message: 'every participant must see the others in the closing lobby' }).toBe(NP);

  for (let i = 0; i < NP; i++) await pageOf(i).screenshot({ path: `test-results/closing-lobby-p${i + 1}.png` }).catch(() => {});
  console.log('  ✓ closing lobby converged — all participants see each other.');

  // Wrap up cleanly so afterAll teardown leaves no live session.
  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(6000);
});
