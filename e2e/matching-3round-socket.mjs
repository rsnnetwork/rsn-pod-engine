// Clean 3-round proof — drives the REAL host lifecycle via sockets, the way an
// event actually runs: start_round -> round plays its timer -> round_rating ->
// rate -> round_transition -> start_round (auto-generates the next round fresh,
// excluding completed rounds). Proves 3 PLAYED rounds with NO repeat pairings,
// driven by onboarding data. (The headed run already proved the in-event UX:
// check-in, breakout rooms, chat, BG, ratings, analytics.)
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { io } from 'socket.io-client';
import { config as dc } from 'dotenv';

const { Pool } = pkg;
dc({ path: 'C:/Users/ARFA TECH/Desktop/RSN-dev/server/.env' });
const RT = process.env.RENDER_TOKEN, SVC = process.env.RENDER_SVC;
const API = 'https://rsn-api-h04m.onrender.com', SOCKET = 'https://api.rsn.network';
const FIRST_Q = 'What is your reason for joining? One sentence is enough.';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function prodSecret() {
  const r = await fetch(`https://api.render.com/v1/services/${SVC}/env-vars?limit=100`, { headers: { Authorization: `Bearer ${RT}` } });
  for (const it of await r.json()) { const ev = it.envVar || it; if (ev.key === 'JWT_SECRET' && ev.value) return ev.value; }
  throw new Error('no prod JWT_SECRET');
}
const SECRET = await prodSecret();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 20000, statement_timeout: 20000, keepAlive: true, max: 4 });
async function q(sql, params, tries = 5) { let last; for (let i = 0; i < tries; i++) { try { return await pool.query(sql, params); } catch (e) { last = e; await wait(3000); } } throw last; }
const made = [];
const tok = (id, email, role) => jwt.sign({ sub: id, email, role, displayName: email, sessionId: uuid() }, SECRET, { expiresIn: '5h' });
async function createUser(suffix, role = 'member') {
  const id = uuid(), email = `e2etest-3r-${suffix}-${Date.now()}@example.com`;
  await q(`INSERT INTO users (id,email,display_name,first_name,last_name,status,role,profile_complete,onboarding_completed,email_verified) VALUES ($1,$2,$3,'E2E',$4,'active',$5,false,false,true)`, [id, email, suffix, suffix, role]);
  made.push(id);
  return { id, email, role, name: suffix, token: tok(id, email, role) };
}
async function rest(u, m, p, b) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${API}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: b ? JSON.stringify(b) : undefined, signal: AbortSignal.timeout(45000) });
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${m} ${p} ${r.status}: ${t.slice(0, 100)}`);
      return t ? JSON.parse(t) : null;
    } catch (e) { last = e; if ((e.message || '').startsWith('HTTP ')) throw e; await wait(3000); }
  }
  throw last;
}
async function onboard(u, a) { return rest(u, 'POST', '/onboarding/confirm', { messages: [{ role: 'assistant', content: FIRST_Q }, { role: 'user', content: a }] }); }
function connect(u) { return new Promise((res, rej) => { const s = io(SOCKET, { auth: { token: u.token }, transports: ['websocket'], reconnection: true }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('sock timeout')), 15000); }); }
function pk(a, b) { return a < b ? `${a}:${b}` : `${b}:${a}`; }

let SID = null;
async function sessStatus() { try { return (await q('SELECT status, current_round FROM sessions WHERE id=$1', [SID])).rows[0]; } catch { return {}; } }
async function waitStatus(want, ms) { const end = Date.now() + ms; while (Date.now() < end) { const s = await sessStatus(); if (s.status === want) return s; await wait(3000); } return null; }

const sockets = [];
let pass = false;
const byRound = {};
try {
  console.log('1) create + onboard 6 + host');
  const host = await createUser('host', 'super_admin');
  const defs = [
    ['m1founder', 'I am the founder of a SaaS startup. I want to meet investors who back SaaS.'],
    ['m2investor', 'I am an angel investor backing SaaS startups. I want to meet SaaS founders.'],
    ['m3founder', 'I am a fintech founder. I want to meet investors and advisors.'],
    ['m4operator', 'I am a head of growth and operator. I want to meet founders.'],
    ['m5advisor', 'I am a startup advisor and mentor. I want to meet founders.'],
    ['m6investor', 'I am an investor at a VC fund. I want to meet founders and operators.'],
  ];
  const members = [];
  for (const [n, a] of defs) { const u = await createUser(n); await onboard(u, a); members.push(u); }
  const byId = Object.fromEntries(members.map((u) => [u.id, u]));
  const tag = Object.fromEntries(members.map((u) => [u.id, u.name])); tag[host.id] = 'HOST';

  console.log('2) pod + 3-round session (60s rounds) + register');
  const pod = (await rest(host, 'POST', '/pods', { name: 'E2E 3R Pod', description: '3r', visibility: 'private', podType: 'speed_networking', orchestrationMode: 'timed_rounds', communicationMode: 'hybrid' })).data;
  for (const u of members) await rest(host, 'POST', `/pods/${pod.id}/members`, { userId: u.id, role: 'member' });
  const sess = (await rest(host, 'POST', '/sessions', { podId: pod.id, title: 'E2E 3R', description: '3r', scheduledAt: new Date(Date.now() + 60000).toISOString(), config: { eventType: 'speed_networking', numberOfRounds: 3, maxParticipants: 50, roundDurationSeconds: 60, lobbyDurationSeconds: 900, ratingWindowSeconds: 20, transitionDurationSeconds: 10, noShowTimeoutSeconds: 120 } })).data;
  SID = sess.id;
  for (const u of members) await rest(u, 'POST', `/sessions/${SID}/register`);

  console.log('3) host start_session + members join');
  const hs = await connect(host); sockets.push(hs);
  hs.emit('host:start_session', { sessionId: SID }); await wait(2500);
  for (const u of members) { const s = await connect(u); sockets.push(s); s.emit('session:join', { sessionId: SID }); await wait(300); }
  await wait(4000);

  async function rateRound(n) {
    const rows = (await q(`SELECT id, participant_a_id a, participant_b_id b, participant_c_id c FROM matches WHERE session_id=$1 AND round_number=$2 AND status <> 'cancelled'`, [SID, n])).rows;
    let ok = 0;
    for (const r of rows) { const ids = [r.a, r.b, r.c].filter(Boolean); for (const uid of ids) { const u = byId[uid]; if (!u) continue; const partner = ids.find((x) => x !== uid); try { await rest(u, 'POST', '/ratings', { matchId: r.id, toUserId: partner, qualityScore: 5, meetAgain: true }); ok++; } catch {} } }
    return ok;
  }

  for (let n = 1; n <= 3; n++) {
    console.log(`4.${n}) start round ${n}`);
    hs.emit('host:start_round', { sessionId: SID });
    const active = await waitStatus('round_active', 40000);
    if (!active) { console.log(`   round ${n} never went active; status=${(await sessStatus()).status}`); break; }
    const cr = active.current_round;
    byRound[n] = (await q(`SELECT participant_a_id a, participant_b_id b, participant_c_id c, confidence, reason_tags FROM matches WHERE session_id=$1 AND round_number=$2 AND status <> 'cancelled'`, [SID, cr])).rows;
    for (const r of byRound[n]) console.log(`     R${n}(db round ${cr}): ${tag[r.a]||'-'} + ${tag[r.b]||'-'}${r.c?' + '+(tag[r.c]||'-'):''} | conf=${r.confidence} | ${JSON.stringify(r.reason_tags)}`);
    // round plays its 60s timer -> round_rating
    const rating = await waitStatus('round_rating', 90000);
    if (rating) { const ok = await rateRound(n); console.log(`     rated ${ok}`); hs.emit('host:force_close_rating', { sessionId: SID }); }
    else console.log(`     round ${n} did not reach rating; status=${(await sessStatus()).status}`);
    if (n < 3) { const t = await waitStatus('round_transition', 40000); console.log(`     -> transition ready: ${!!t}`); }
    await wait(2000);
  }

  console.log('5) assertions');
  const all = [].concat(byRound[1] || [], byRound[2] || [], byRound[3] || []);
  const roundsPlayed = [1, 2, 3].filter((n) => (byRound[n] || []).length > 0).length;
  const seen = new Set(); let repeat = false;
  for (const r of all) { const ks = [pk(r.a, r.b)]; if (r.c) ks.push(pk(r.a, r.c), pk(r.b, r.c)); for (const k of ks) { if (seen.has(k)) repeat = true; seen.add(k); } }
  const distinctRounds = JSON.stringify((byRound[1] || []).map((r) => pk(r.a, r.b)).sort()) !== JSON.stringify((byRound[2] || []).map((r) => pk(r.a, r.b)).sort());
  console.log(`   rounds played: ${roundsPlayed}/3 | total pairs: ${all.length} | noRepeat: ${!repeat} | R1!=R2: ${distinctRounds}`);
  pass = roundsPlayed === 3 && !repeat;
  console.log(pass ? '3ROUND: PASS — 3 distinct PLAYED rounds, no repeats' : '3ROUND: FAIL');
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try {
    if (SID) { await q('DELETE FROM ratings WHERE match_id IN (SELECT id FROM matches WHERE session_id=$1)', [SID]).catch(() => {}); await q('DELETE FROM sessions WHERE id=$1', [SID]).catch(() => {}); }
    await q('DELETE FROM pods WHERE created_by = ANY($1)', [made]).catch(() => {});
    await q('DELETE FROM encounter_history WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)', [made]).catch(() => {});
    await q('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made]).catch(() => {});
    await q('DELETE FROM refresh_tokens WHERE user_id = ANY($1)', [made]).catch(() => {});
    await q('DELETE FROM users WHERE id = ANY($1)', [made]).catch(() => {});
  } catch (e) { console.error('cleanup err', e.message); }
  await pool.end();
  console.log(pass ? 'RESULT: PASS (cleaned up)' : 'RESULT: see above (cleaned up)');
}
