import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED prod verification — Bug (June-11 live): a user kicked AFTER round 1 saw
// the recap, then on REFRESH landed back in the main room. Server matching
// correctly excluded them, but generateLiveKitToken gated on row-existence not
// status, so their LiveKit token was re-minted on reconnect and the SFU pulled
// them back. A kicked user must be terminally out — across refresh, URL paste,
// and a direct token request — whether kicked by the host OR a co-host.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, victim: TestUser, other: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => { const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('socket timeout')), 10_000); });
}
async function apiAs(u: TestUser, method: string, path: string, body?: any) {
  const res = await fetch(`${API}/api${path}`, { method, headers: { Authorization: `Bearer ${u.accessToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json };
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: any, url: string) => { for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } } };
const partStatus = async (uid: string) => (await pool.query('SELECT status FROM session_participants WHERE session_id=$1 AND user_id=$2', [sessionId, uid])).rows[0]?.status;
const inMainRoom = async (page: any) => (await page.getByRole('button', { name: /Leave Event/i }).count().catch(() => 0)) > 0;

test.beforeAll(async () => {
  host = await createTestUser('krhost', 'super_admin');
  victim = await createTestUser('krvictim');
  other = await createTestUser('krother');
  const pod = await createPod(host, 'E2E KickRound Pod'); podId = pod.id;
  await addPodMember(host, podId, victim.id); await addPodMember(host, podId, other.id);
  const sess = await createSession(host, podId, 'VERIFY kick terminal after round', new Date(Date.now() + 60_000), { numberOfRounds: 3 });
  sessionId = sess.id;
  await Promise.all([registerForSession(victim, sessionId), registerForSession(other, sessionId)]);
  browser = await chromium.launch({ headless: false, slowMo: 300, args: ['--start-maximized', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('Kicked AFTER a round: terminal across refresh, URL paste, and a direct token request', async () => {
  test.setTimeout(280_000);
  const hostSock = await connect(host); sockets.push(hostSock);

  // Victim is the real browser we watch.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: victim.accessToken, r: victim.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> victim browser opening on prod <<<');
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await page.waitForTimeout(5000);

  // Run a FULL round 1, then return the victim to the main room (this is the
  // state the bug needed — not a fresh lobby).
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);
  await page.reload().catch(() => {}); await wait(4000);
  const otherSock = await connect(other); sockets.push(otherSock); otherSock.emit('session:join', { sessionId }); await wait(3000);
  console.log('  host: match → start round 1 → end round → skip ratings...');
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(6000);
  hostSock.emit('host:end_session', { sessionId }); await wait(5000);       // end round → ROUND_RATING
  hostSock.emit('host:force_close_rating', { sessionId }); await wait(5000); // → ROUND_TRANSITION, victim back to main
  await expect.poll(async () => await inMainRoom(page), { timeout: 25_000, message: 'victim should be back in the main room after round 1' }).toBe(true);
  console.log('  ✓ victim is back in the main room after round 1.');

  // Host kicks the victim (now in the main room, post round 1).
  console.log('  >>> host kicks the victim (post round 1) <<<');
  hostSock.emit('host:remove_participant', { sessionId, userId: victim.id, reason: 'e2e' }); await wait(4000);
  expect(await partStatus(victim.id), 'victim removed in DB').toBe('removed');
  await expect.poll(async () => await inMainRoom(page), { timeout: 20_000, message: 'kicked victim must leave the main room' }).toBe(false);
  console.log('  ✓ victim left the main room after the kick.');

  // (1) A direct token request must be refused — the SFU-rejoin hole.
  const tok = await apiAs(victim, 'POST', `/sessions/${sessionId}/token`, {});
  console.log('  direct /token for removed victim →', tok.status, tok.json?.error?.code);
  expect(tok.ok, 'a removed user must NOT be granted a LiveKit token').toBe(false);
  expect(tok.status, 'token request should be forbidden').toBe(403);

  // (2) REFRESH must not pull them back.
  console.log('  >>> refresh <<<');
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await expect.poll(async () => await inMainRoom(page), { timeout: 25_000, message: 'after refresh the victim must settle OUT of the main room' }).toBe(false);
  for (let i = 0; i < 8; i++) { expect(await inMainRoom(page), `victim reverted ${i}s after refresh`).toBe(false); await wait(1000); }
  console.log('  ✓ victim stayed out after refresh.');

  // (3) URL paste in a brand-new context must not let them in either.
  console.log('  >>> URL paste in a fresh browser context <<<');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx2.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: victim.accessToken, r: victim.refreshToken });
  const page2 = await ctx2.newPage();
  await gotoRetry(page2, `${APP}/session/${sessionId}/live`);
  // Let the COLD fresh context fully load (connect → auto-register 403 →
  // terminal recap) before asserting — the brief loading shell is not a rejoin
  // (no token is possible: the direct /token above already 403'd). Then require
  // a sustained OUT.
  await page2.waitForTimeout(14000);
  for (let i = 0; i < 8; i++) { expect(await inMainRoom(page2), `victim got into the main room via URL paste, ${i}s after settling`).toBe(false); await wait(1000); }
  expect(await partStatus(victim.id), 'victim still removed').toBe('removed');
  await page2.screenshot({ path: 'test-results/kickround-urlpaste-out.png' }).catch(() => {});
  await ctx2.close();
  await ctx.close();
  console.log('  ✓ verified: kicked-after-round victim is terminal across refresh, URL paste, and direct token.');
});
