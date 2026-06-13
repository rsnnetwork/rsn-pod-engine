import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';
import { RoomServiceClient } from 'livekit-server-sdk';

// VERIFY (regression, headed) — after a round, one participant lands in the main room and the other is
// ISOLATED (sees only themself). Suspected: a tab that drops during the
// round-end (throttled background tab) reconnects to a stale/wrong room. This
// runs a real round, drops Waseem's tab during the round-end, reconnects, then
// asks LiveKit which ROOM each person is actually in.
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
  for (const r of rooms) {
    try { const parts = await svc.listParticipants(r.name); out[r.name] = parts.map(p => p.identity); }
    catch { out[r.name] = ['<gone>']; }
  }
  return out;
}

test.beforeAll(async () => {
  host = await createTestUser('isohost', 'super_admin');
  saif = await createTestUser('isosaif');
  waseem = await createTestUser('isowaseem');
  const pod = await createPod(host, 'E2E Iso Pod'); podId = pod.id;
  await addPodMember(host, podId, saif.id); await addPodMember(host, podId, waseem.id);
  const sess = await createSession(host, podId, 't-iso', new Date(Date.now() + 60_000), { numberOfRounds: 5 });
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

test('after a round + a drop during the round-end, both participants share the lobby room', async () => {
  test.setTimeout(260_000);
  const hostSock = await connect(host); sockets.push(hostSock);
  const ps = await open(saif);
  let pw = await open(waseem);
  await wait(4000);

  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  await ps.page.reload().catch(() => {}); await pw.page.reload().catch(() => {}); await wait(4000);
  console.log('lobby rooms before round:', JSON.stringify(await lkRooms()));

  console.log('  match saif+waseem → start round (breakout)...');
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(6000);
  console.log('rooms during round:', JSON.stringify(await lkRooms()));

  // THROTTLED-TAB SIM — Waseem's tab stays OPEN but goes offline during the
  // round-end (its in-memory state still thinks it's in the breakout). When it
  // comes back online it re-asserts the stale breakout location.
  const cdp = await pw.ctx.newCDPSession(pw.page);
  console.log('  >>> Waseem goes OFFLINE (tab stays open) during the round-end <<<');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  hostSock.emit('host:end_session', { sessionId }); await wait(6000);        // end round → rating
  hostSock.emit('host:force_close_rating', { sessionId }); await wait(6000);  // → main
  console.log('  >>> Waseem back ONLINE (re-asserts stale breakout) <<<');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await wait(12000); // let the reconnect + lobby video settle

  const rooms = await lkRooms();
  console.log('FINAL LiveKit rooms:', JSON.stringify(rooms));
  const lobby = `lobby-${sessionId}`;
  const saifRoom = Object.entries(rooms).find(([, ids]) => ids.includes(saif.id))?.[0];
  const waseemRoom = Object.entries(rooms).find(([, ids]) => ids.includes(waseem.id))?.[0];
  // count rendered video tiles on each page (pin buttons mark each tile)
  const tiles = async (page: Page) => await page.locator('[data-testid="tile-pin-button"], [data-testid="tile-unpin-button"]').count().catch(() => -1);
  const saifTiles = await tiles(ps.page);
  const waseemTiles = await tiles(pw.page);
  console.log(`LiveKit: saif=${saifRoom} waseem=${waseemRoom} (lobby=${lobby})`);
  console.log(`RENDERED tiles: saif sees ${saifTiles}, waseem sees ${waseemTiles} (each should see 2: self + the other)`);
  await ps.page.screenshot({ path: 'test-results/iso-saif.png' }).catch(() => {});
  await pw.page.screenshot({ path: 'test-results/iso-waseem.png' }).catch(() => {});

  expect(saifRoom, 'saif in lobby').toBe(lobby);
  expect(waseemRoom, 'waseem in lobby (same room)').toBe(lobby);
  expect(waseemTiles, 'waseem must RENDER both tiles (self + saif), not be isolated').toBeGreaterThanOrEqual(2);
  expect(saifTiles, 'saif must render both tiles').toBeGreaterThanOrEqual(2);
  await ps.ctx.close(); await pw.ctx.close();
});
