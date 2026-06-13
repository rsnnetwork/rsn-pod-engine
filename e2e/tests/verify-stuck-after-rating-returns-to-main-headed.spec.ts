import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';
import { RoomServiceClient } from 'livekit-server-sdk';

// VERIFY (regression, headed) — after a round, the partner (Waseem) leaves and rejoins during the
// rating phase; the other (Saif) rates and should return to the MAIN ROOM, but
// Ali reports Saif gets STUCK on the breakout stream. Capture which LiveKit
// room each ends in + whether they render the lobby.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const LK = (process.env.LIVEKIT_URL || '').replace('wss://', 'https://').replace('ws://', 'http://');
const svc = new RoomServiceClient(LK, process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!);

let host: TestUser, saif: TestUser, waseem: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => { const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('socket timeout')), 10_000); });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: Page, url: string) => { for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } } };
async function open(u: TestUser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.addInitScript((t: any) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: u.accessToken, r: u.refreshToken });
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return { ctx, page };
}
async function lkRooms() {
  const rooms = (await svc.listRooms()).filter(r => r.name.includes(sessionId));
  const out: Record<string, string[]> = {};
  for (const r of rooms) { try { out[r.name] = (await svc.listParticipants(r.name)).map(p => p.identity); } catch { out[r.name] = ['<gone>']; } }
  return out;
}
const inMainRoom = async (page: Page) => (await page.getByRole('button', { name: 'Compact', exact: true }).count().catch(() => 0)) > 0;

test.beforeAll(async () => {
  host = await createTestUser('srhost', 'super_admin');
  saif = await createTestUser('srsaif');
  waseem = await createTestUser('srwaseem');
  const pod = await createPod(host, 'E2E SR Pod'); podId = pod.id;
  await addPodMember(host, podId, saif.id); await addPodMember(host, podId, waseem.id);
  const sess = await createSession(host, podId, 't-sr', new Date(Date.now() + 60_000), { numberOfRounds: 5 });
  sessionId = sess.id;
  await Promise.all([registerForSession(saif, sessionId), registerForSession(waseem, sessionId)]);
  browser = await chromium.launch({ headless: false, slowMo: 200, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('partner leaves+rejoins during rating; the other rates and returns to the main room', async () => {
  test.setTimeout(280_000);
  const hostSock = await connect(host); sockets.push(hostSock);
  const ps = await open(saif);
  let pw = await open(waseem);
  await wait(4000);

  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  await ps.page.reload().catch(() => {}); await pw.page.reload().catch(() => {}); await wait(4000);

  // Round 1: match saif+waseem → breakout → end round → RATING.
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(6000);
  console.log('rooms during round:', JSON.stringify(await lkRooms()));
  hostSock.emit('host:end_session', { sessionId }); await wait(5000);   // → ROUND_RATING
  console.log('  >>> in RATING phase. Waseem LEAVES and REJOINS <<<');

  // Waseem leaves (close tab) then rejoins during the rating window.
  await pw.ctx.close(); await wait(3000);
  pw = await open(waseem); await wait(5000);

  // Host closes the rating → everyone should return to the MAIN ROOM and see
  // each other (not be stuck without video). The participant who STAYED is the
  // one that regressed.
  console.log('  >>> host closes rating <<<');
  const tiles = async (page: Page) => await page.locator('[data-testid="tile-pin-button"], [data-testid="tile-unpin-button"]').count().catch(() => -1);
  hostSock.emit('host:force_close_rating', { sessionId });
  // Recover within 22s, then HOLD steady (allow a brief reconnect settle, but it
  // must end stable — not the persistent stuck Ali hit, where it never recovered).
  await expect.poll(async () => await tiles(ps.page), { timeout: 22_000, message: 'saif must recover into the main room after rating' }).toBeGreaterThanOrEqual(2);
  await wait(8000); // let the reconnect settle past any brief flicker
  for (let i = 0; i < 5; i++) { expect(await tiles(ps.page), `saif must STAY in the main room (settled), check ${i}`).toBeGreaterThanOrEqual(2); await wait(1000); }
  expect(await tiles(pw.page), 'waseem in the main room too').toBeGreaterThanOrEqual(2);
  console.log('  ✓ saif recovered into the main room after rating and held steady.');
  await ps.ctx.close(); await pw.ctx.close();
});
