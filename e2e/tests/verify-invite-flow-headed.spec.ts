import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — invite flow.
//   #1  a session invite lands on the event DETAILS page (/sessions/:id), NOT in
//       the live room with camera/mic. A real browser confirms the details page +
//       "Enter Event" button, and that it is NOT the live room.
//   #4B a kicked user's old personal invite is revoked (old link dies); a FRESH
//       personal invite re-admits them; a SHARED link never re-admits a removed user.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, invitee: TestUser, victim: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: any) {
  const res = await fetch(`${API}/api${path}`, { method, headers: { Authorization: `Bearer ${u.accessToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json };
}
function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => { const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('socket timeout')), 10_000); });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: any, url: string) => { for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } } };

test.beforeAll(async () => {
  host = await createTestUser('invhost', 'super_admin');
  invitee = await createTestUser('invitee');
  victim = await createTestUser('invvictim');
  const pod = await createPod(host, 'E2E Invite Pod'); podId = pod.id;
  const sess = await createSession(host, podId, 'VERIFY invite flow', new Date(Date.now() + 60_000), { numberOfRounds: 1 });
  sessionId = sess.id;
  browser = await chromium.launch({ headless: false, slowMo: 400, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

const partStatus = async (uid: string) => (await pool.query('SELECT status FROM session_participants WHERE session_id=$1 AND user_id=$2', [sessionId, uid])).rows[0]?.status;
const inviteStatus = async (code: string) => (await pool.query('SELECT status FROM invites WHERE code=$1', [code])).rows[0]?.status;

test('#1: a session invite lands on the event details page, NOT the live room', async () => {
  test.setTimeout(150_000);
  // Host sends a personal invite to the invitee.
  const created = await apiAs(host, 'POST', '/invites', { type: 'session', sessionId, inviteeEmail: invitee.email, maxUses: 1, expiresInHours: 168 });
  expect(created.ok, `invite create failed: ${JSON.stringify(created.json)}`).toBe(true);
  const code = created.json?.data?.code;

  // Invitee accepts → redirectTo must be the DETAILS page, not the live room.
  const accept = await apiAs(invitee, 'POST', `/invites/${code}/accept`);
  expect(accept.ok, `accept failed: ${JSON.stringify(accept.json)}`).toBe(true);
  const redirectTo = accept.json?.data?.redirectTo;
  console.log('  accept redirectTo:', redirectTo);
  expect(redirectTo, 'invite must land on the event DETAILS page').toBe(`/sessions/${sessionId}`);
  expect(redirectTo, 'invite must NOT drop straight into the live room').not.toContain('/live');

  // Headed: open where the invite lands; confirm it's the details page (Enter Event), not the live room.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: invitee.accessToken, r: invitee.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> invitee browser opening the invite landing page <<<');
  await gotoRetry(page, `${APP}${redirectTo}`);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'test-results/verify-invite-landing.png' }).catch(() => {});
  await expect(page.getByRole('button', { name: /Enter Event|Enter Live Event/i }).first(), 'details page should offer an explicit "Enter Event" button').toBeVisible({ timeout: 20_000 });
  // It must NOT be the live room (no "Leave Event" control which only the live page shows).
  expect(await page.getByRole('button', { name: /Leave Event/i }).count(), 'must not be inside the live room yet').toBe(0);
  console.log('  ✓ #1: landed on the event details page with an Enter Event button; not in the room.');
  await ctx.close();
});

test('#4B: kick revokes the old invite; a fresh personal invite re-admits; a shared link does not', async () => {
  test.setTimeout(150_000);
  // Victim joins via a personal invite, then is present in the event.
  const inv1 = await apiAs(host, 'POST', '/invites', { type: 'session', sessionId, inviteeEmail: victim.email, maxUses: 1, expiresInHours: 168 });
  const code1 = inv1.json?.data?.code;
  await apiAs(victim, 'POST', `/invites/${code1}/accept`);
  expect(await partStatus(victim.id), 'victim should be registered after accepting').toBe('registered');

  // Host kicks the victim.
  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  const vs = await connect(victim); sockets.push(vs); vs.emit('session:join', { sessionId }); await wait(2500);
  hostSock.emit('host:remove_participant', { sessionId, userId: victim.id, reason: 'e2e' }); await wait(4000);
  expect(await partStatus(victim.id), 'victim should be removed after the kick').toBe('removed');

  // The old personal invite is now revoked → re-accepting it fails.
  console.log('  old invite status:', await inviteStatus(code1));
  expect(await inviteStatus(code1), 'kick must revoke the old personal invite').toBe('revoked');
  const reuseOld = await apiAs(victim, 'POST', `/invites/${code1}/accept`);
  console.log('  re-accept old (revoked) link:', reuseOld.status, reuseOld.json?.error?.code);
  expect(reuseOld.ok, 'a revoked old link must NOT let the kicked user back in').toBe(false);
  expect(await partStatus(victim.id), 'victim stays removed after trying the old link').toBe('removed');

  // A SHARED link must NOT re-admit a removed user.
  const shared = await apiAs(host, 'POST', '/invites', { type: 'session', sessionId, maxUses: 50, expiresInHours: 168 });
  const sharedCode = shared.json?.data?.code;
  const viaShared = await apiAs(victim, 'POST', `/invites/${sharedCode}/accept`);
  console.log('  removed user via SHARED link:', viaShared.status, viaShared.json?.error?.code);
  expect(viaShared.ok, 'a shared link must NOT re-admit a removed user').toBe(false);
  expect(await partStatus(victim.id), 'victim still removed after a shared link').toBe('removed');

  // A FRESH PERSONAL invite from the host re-admits the kicked user.
  const inv2 = await apiAs(host, 'POST', '/invites', { type: 'session', sessionId, inviteeEmail: victim.email, maxUses: 1, expiresInHours: 168 });
  console.log('  inv2 CREATE:', inv2.status, JSON.stringify(inv2.json));
  const code2 = inv2.json?.data?.code;
  const readmit = await apiAs(victim, 'POST', `/invites/${code2}/accept`);
  console.log('  fresh personal invite accept:', readmit.status, JSON.stringify(readmit.json));
  expect(readmit.ok, 'a fresh personal invite must re-admit the kicked user').toBe(true);
  expect(await partStatus(victim.id), 'victim re-admitted (registered) via the fresh personal invite').toBe('registered');

  console.log('  ✓ #4B: old link revoked, shared link blocked, fresh personal invite re-admits.');
});
