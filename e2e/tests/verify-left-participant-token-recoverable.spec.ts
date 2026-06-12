import { test, expect } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession } from '../helpers/api';

// VERIFY (regression) — a participant with status='left' (a recoverable disconnect / leave-and-
// rejoin state in RSN) must still be able to come back to the main room. The
// June-11 token gate treats 'left' as terminal, so on current prod:
//   • POST /token → 403 (no lobby video → stuck)
//   • session:resync → session:evicted (bounced to recap)
// This proves the regression; after the fix both should behave normally.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => { const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('socket timeout')), 10_000); });
}
async function apiAs(u: TestUser, method: string, path: string, body?: any) {
  const res = await fetch(`${API}/api${path}`, { method, headers: { Authorization: `Bearer ${u.accessToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json };
}

test("a 'left' participant can still get a lobby token and is NOT evicted on resync", async () => {
  test.setTimeout(90_000);
  const host = await createTestUser('lshost', 'super_admin');
  const part = await createTestUser('lspart');
  const pod = await createPod(host, 'E2E LeftStuck Pod');
  await addPodMember(host, pod.id, part.id);
  const sess = await createSession(host, pod.id, 'repro left-stuck', new Date(Date.now() + 60_000), { numberOfRounds: 2 });
  await registerForSession(part, sess.id);

  const hostSock = await connect(host); hostSock.emit('host:start_session', { sessionId: sess.id }); await wait(2000);
  const ps = await connect(part); ps.emit('session:join', { sessionId: sess.id }); await wait(2500);

  // Simulate a recoverable 'left' state (they hit Leave / their tab dropped and a
  // stale leave landed). This is NOT a kick — kicks set status='removed'.
  await pool.query("UPDATE session_participants SET status='left', left_at=NOW() WHERE session_id=$1 AND user_id=$2", [sess.id, part.id]);
  console.log("  participant status forced to 'left' (recoverable)");

  // (1) Token request — a returning 'left' participant must be granted a token.
  const tok = await apiAs(part, 'POST', `/sessions/${sess.id}/token`, {});
  console.log('  POST /token for left participant →', tok.status, tok.json?.error?.code || '(ok)');

  // (2) Resync — must NOT evict a 'left' participant.
  let evicted = false;
  const ps2 = await connect(part);
  ps2.on('session:evicted', () => { evicted = true; });
  ps2.emit('session:resync', { sessionId: sess.id });
  await wait(3000);
  console.log('  resync evicted the left participant?', evicted);

  try { hostSock.disconnect(); ps.disconnect(); ps2.disconnect(); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();

  // Assertions describe the CORRECT behaviour (these FAIL on current prod, PASS after the fix).
  expect(tok.ok, "a returning 'left' participant must be granted a lobby token").toBe(true);
  expect(evicted, "a 'left' participant must NOT be evicted to the recap on resync").toBe(false);
});
