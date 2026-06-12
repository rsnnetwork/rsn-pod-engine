import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — the NORMAL path (no leave): two participants run a
// round, the host ends it + skips ratings, and BOTH must return to the main
// room (lobby with the density toggle), not get stuck on a transition screen.
// Rules out a round-transition return bug independent of the 'left' fix.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, a: TestUser, b: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => { const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('socket timeout')), 10_000); });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: Page, url: string) => { for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } } };
// In the main room, the lobby renders the density toggle (Compact/Normal/Spacious).
const inMainRoom = async (page: Page) => (await page.getByRole('button', { name: 'Compact', exact: true }).count().catch(() => 0)) > 0;

async function openParticipant(u: TestUser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: u.accessToken, r: u.refreshToken });
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return { ctx, page };
}

test.beforeAll(async () => {
  host = await createTestUser('rrhost', 'super_admin');
  a = await createTestUser('rra');
  b = await createTestUser('rrb');
  const pod = await createPod(host, 'E2E RoundReturn Pod'); podId = pod.id;
  await addPodMember(host, podId, a.id); await addPodMember(host, podId, b.id);
  const sess = await createSession(host, podId, 'VERIFY round return to main', new Date(Date.now() + 60_000), { numberOfRounds: 3 });
  sessionId = sess.id;
  await Promise.all([registerForSession(a, sessionId), registerForSession(b, sessionId)]);
  browser = await chromium.launch({ headless: false, slowMo: 250, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('after a round + skip ratings, both participants return to the main room', async () => {
  test.setTimeout(220_000);
  const hostSock = await connect(host); sockets.push(hostSock);

  const pa = await openParticipant(a);
  const pb = await openParticipant(b);
  await wait(4000);

  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  await pa.page.reload().catch(() => {}); await pb.page.reload().catch(() => {}); await wait(4000);
  await expect.poll(async () => (await inMainRoom(pa.page)) && (await inMainRoom(pb.page)), { timeout: 25_000, message: 'both should be in the main room before the round' }).toBe(true);
  console.log('  ✓ both participants in the main room.');

  console.log('  host: match → start round → end round → skip ratings...');
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(6000);
  hostSock.emit('host:end_session', { sessionId }); await wait(5000);       // → ROUND_RATING
  hostSock.emit('host:force_close_rating', { sessionId }); await wait(5000); // → ROUND_TRANSITION

  // THE CHECK — both must come BACK to the main room after the round.
  await expect.poll(async () => await inMainRoom(pa.page), { timeout: 30_000, message: 'participant A must return to the main room after the round' }).toBe(true);
  await expect.poll(async () => await inMainRoom(pb.page), { timeout: 30_000, message: 'participant B must return to the main room after the round' }).toBe(true);
  // And stay there.
  for (let i = 0; i < 6; i++) {
    expect(await inMainRoom(pa.page), `A stays in the main room ${i}s`).toBe(true);
    expect(await inMainRoom(pb.page), `B stays in the main room ${i}s`).toBe(true);
    await wait(1000);
  }
  await pa.page.screenshot({ path: 'test-results/round-return-A.png' }).catch(() => {});
  await pb.page.screenshot({ path: 'test-results/round-return-B.png' }).catch(() => {});
  console.log('  ✓ both participants returned to the main room after the round.');

  await pa.ctx.close(); await pb.ctx.close();
});
