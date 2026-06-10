import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { RoomServiceClient } from 'livekit-server-sdk';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// PROD smoke S4 (#4 June-10 debrief) — a kick must remove the participant from the
// LiveKit SFU, not just from matching. Reproduces today's TESTEVENT: the victim
// really joins the lobby LiveKit room (headed browser, fake media); the host
// kicks them; we assert via the LiveKit RoomServiceClient that the victim is gone
// from the room (the eviction the old kick path never performed), plus DB
// status=removed and a barred re-entry.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const LK_HOST = (process.env.LIVEKIT_URL || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const lk = new RoomServiceClient(LK_HOST, process.env.LIVEKIT_API_KEY || '', process.env.LIVEKIT_API_SECRET || '');

let host: TestUser, victim: TestUser, bystander: TestUser;
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
const lobbyRoom = () => `lobby-${sessionId}`;
const idsInLobby = async (): Promise<string[]> => {
  try { return (await lk.listParticipants(lobbyRoom())).map((p) => p.identity); } catch { return []; }
};

test.beforeAll(async () => {
  host = await createTestUser('s4host', 'super_admin');
  victim = await createTestUser('s4victim');
  bystander = await createTestUser('s4bystander');
  const pod = await createPod(host, 'E2E S4 Pod');
  podId = pod.id;
  await addPodMember(host, podId, victim.id);
  await addPodMember(host, podId, bystander.id);
  const sess = await createSession(host, podId, 'E2E S4 kick eviction', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all([registerForSession(victim, sessionId), registerForSession(bystander, sessionId)]);
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

test('S4: kicking a participant evicts them from the LiveKit room, removes them, and bars re-entry', async () => {
  test.setTimeout(150_000);

  // Host opens the lobby.
  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId });
  await wait(3000);

  // Victim really joins the lobby LiveKit room via the app (headed, fake media).
  const ctx = await browser.newContext();
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: victim.accessToken, r: victim.refreshToken });
  const page = await ctx.newPage();
  await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });

  // Wait until the victim is actually present in the LiveKit lobby room.
  let present = false;
  for (let i = 0; i < 30 && !present; i++) { await wait(2000); present = (await idsInLobby()).includes(victim.id); }
  console.log(`  victim in LiveKit lobby before kick: ${present}`);
  expect(present, 'victim should have joined the LiveKit lobby room').toBe(true);

  // Host kicks the victim.
  hostSock.emit('host:remove_participant', { sessionId, userId: victim.id, reason: 'e2e kick test' });

  // PROOF (the fix): the victim is evicted from the LiveKit room.
  let gone = false;
  for (let i = 0; i < 15 && !gone; i++) { await wait(1000); gone = !(await idsInLobby()).includes(victim.id); }
  console.log(`  victim gone from LiveKit lobby after kick: ${gone}`);
  expect(gone, 'kicked victim must be evicted from the LiveKit SFU room').toBe(true);

  // DB: they are unregistered (removed).
  const status = (await pool.query('SELECT status FROM session_participants WHERE session_id=$1 AND user_id=$2', [sessionId, victim.id])).rows[0]?.status;
  console.log(`  victim DB status after kick: ${status}`);
  expect(status, 'kicked victim must be marked removed').toBe('removed');

  // Re-entry bar: a fresh socket join is rejected (they need a new host invite).
  const rejoin = await connect(victim); sockets.push(rejoin);
  let evicted = false;
  rejoin.on('session:evicted', () => { evicted = true; });
  rejoin.emit('session:join', { sessionId });
  for (let i = 0; i < 8 && !evicted; i++) await wait(700);
  console.log(`  victim re-join blocked (session:evicted): ${evicted}`);
  expect(evicted, 'a kicked victim must not be able to walk back in on their own').toBe(true);

  await ctx.close();
  console.log('  ✓ kick evicted from SFU + unregistered + barred re-entry');
});
