import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';

// HEADED PROD — 3 Jul lifecycle fixes, mobile slice:
//   #6 landscape: a landscape phone (844×390) must use the COMPACT layout, not
//      the desktop one it was wrongly getting (width > md breakpoint). Assert
//      the breakout renders .vr-mobile-layout (desktop hidden) + no h-scroll.
//   #2 terminal: after End Event every participant reaches 'left' (never a
//      stranded 'disconnected').
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const SERVER = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';

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
async function openLandscape(u: TestUser): Promise<Page> {
  // Landscape phone: wider than the md (768) breakpoint, short height.
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return page;
}

test.beforeAll(async () => {
  host = await createTestUser('mobhost', 'super_admin');
  for (let i = 1; i <= 2; i++) P.push(await createTestUser(`mobp${i}`));
  const pod = await createPod(host, 'E2E Mobile Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY mobile landscape lifecycle', new Date(Date.now() + 60_000), {
    numberOfRounds: 1, roundDurationSeconds: 120, ratingWindowSeconds: 20,
  });
  sessionId = sess.id;
  await Promise.all(P.map(u => registerForSession(u, sessionId)));
  browser = await chromium.launch({ headless: false, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--start-maximized'] });
});

test.afterAll(async () => {
  try { hostSock?.close(); } catch {}
  try { await browser?.close(); } catch {}
  const ids = [host?.id, ...P.map(p => p.id)].filter(Boolean);
  if (sessionId) { await pool.query(`DELETE FROM invites WHERE session_id = $1`, [sessionId]).catch(() => {}); await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]).catch(() => {}); }
  if (podId) { await pool.query(`DELETE FROM pod_members WHERE pod_id = $1`, [podId]).catch(() => {}); await pool.query(`DELETE FROM pods WHERE id = $1`, [podId]).catch(() => {}); }
  if (ids.length) {
    await pool.query(`DELETE FROM encounter_history WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM audit_log WHERE actor_id = ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM refresh_tokens WHERE user_id = ANY($1)`, [ids]).catch(() => {});
    const del = await pool.query(`DELETE FROM users WHERE id = ANY($1) RETURNING id`, [ids]);
    console.log(`Cleanup: ${del.rows.length} users, session ${sessionId}, pod ${podId}`);
  }
});

test('landscape phone uses compact breakout layout (no overflow) + participants end terminal', async () => {
  test.setTimeout(300_000);
  hostSock = await connect(host);
  const p1 = await openLandscape(P[0]);
  const p2 = await openLandscape(P[1]);
  await wait(4000);

  hostSock.emit('host:start_session', { sessionId }); await wait(3000);
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(8000);

  // ── #6: in the breakout at 844×390, the COMPACT layout must be the one shown ──
  const desktopLayout = p1.locator('.vr-desktop-layout');
  const mobileLayout = p1.locator('.vr-mobile-layout');
  await expect.poll(async () => mobileLayout.count().catch(() => 0), { timeout: 30_000, message: 'breakout should render' }).toBeGreaterThan(0);
  // desktop layout must be display:none (media query hid it), compact visible.
  expect(await desktopLayout.isVisible().catch(() => false), 'desktop layout must be HIDDEN on a landscape phone').toBe(false);
  expect(await mobileLayout.first().isVisible().catch(() => false), 'compact mobile layout must be VISIBLE on a landscape phone').toBe(true);

  // No horizontal scroll at 844px.
  const hOverflow = await p1.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(hOverflow, 'no horizontal scroll in landscape breakout').toBe(false);

  // Self-PIP fits inside the viewport (top-right, safe-area aware).
  const pip = p1.locator('.vr-self-pip').first();
  if (await pip.count() > 0) {
    const box = await pip.boundingBox();
    if (box) {
      expect(box.x + box.width, 'self-PIP must not overflow the right edge').toBeLessThanOrEqual(844 + 1);
      expect(box.y, 'self-PIP must be at the top').toBeLessThan(200);
    }
  }
  await p1.screenshot({ path: 'test-results/mobile-landscape-breakout.png' }).catch(() => {});
  console.log('  ✓ #6: landscape breakout uses compact layout, no overflow, PIP fits.');

  // ── #2: End the event → every participant reaches terminal 'left' ────────────
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);        // → ROUND_RATING
  hostSock.emit('host:force_close_rating', { sessionId }); await wait(5000); // last round → CLOSING_LOBBY
  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(8000); // → COMPLETED
  await expect.poll(async () => {
    const r = await pool.query(`SELECT status FROM session_participants WHERE session_id = $1 AND user_id = ANY($2)`, [sessionId, P.map(p => p.id)]);
    return r.rows.filter((x: any) => x.status === 'left').length;
  }, { timeout: 40_000, message: 'all participants must reach terminal left' }).toBe(2);
  // And NONE stranded non-terminal.
  const stranded = await pool.query(`SELECT COUNT(*)::int c FROM session_participants WHERE session_id = $1 AND status IN ('disconnected','in_round','checked_in')`, [sessionId]);
  expect(stranded.rows[0].c, 'no participant left in a non-terminal state').toBe(0);
  console.log('  ✓ #2: all participants reached terminal left, none stranded.');
});
