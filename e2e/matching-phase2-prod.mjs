// Phase 2 prod E2E — covers each use case + edge case:
//  P2-1 storage: every match row carries a 0..1 confidence + template column.
//  P2-3 check-in intent: a member's per-event intention is stored + drives pairing.
//  P2-5 designation: structured founder<->investor pairing.
//  P2-2 analytics: GET /admin/analytics/matching returns data after a round.
//  P2-6 cooldown: a pair that met recently is excluded under matchingPolicy='cooldown'.
// Plus headed screenshots of the check-in modal + the analytics Matching tab.
import { chromium } from '@playwright/test';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { io } from 'socket.io-client';
import { config as dc } from 'dotenv';

const { Pool } = pkg;
dc({ path: 'C:/Users/ARFA TECH/Desktop/RSN-dev/server/.env' });
const RT = process.env.RENDER_TOKEN, SVC = process.env.RENDER_SVC;
const API = 'https://rsn-api-h04m.onrender.com', SOCKET = 'https://api.rsn.network', APP = 'https://app.rsn.network';
const OUT = process.env.OUT_DIR || '.';
const FIRST_Q = 'What is your reason for joining? One sentence is enough.';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function prodSecret() {
  const r = await fetch(`https://api.render.com/v1/services/${SVC}/env-vars?limit=100`, { headers: { Authorization: `Bearer ${RT}` } });
  for (const it of await r.json()) { const ev = it.envVar || it; if (ev.key === 'JWT_SECRET' && ev.value) return ev.value; }
  throw new Error('no prod JWT_SECRET');
}
const SECRET = await prodSecret();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const made = [];
const tok = (id, email, role) => jwt.sign({ sub: id, email, role, displayName: email, sessionId: uuid() }, SECRET, { expiresIn: '3h' });
async function createUser(suffix, role = 'member') {
  const id = uuid(), email = `e2etest-p2-${suffix}-${Date.now()}@example.com`;
  await pool.query(`INSERT INTO users (id,email,display_name,first_name,last_name,status,role,profile_complete,onboarding_completed,email_verified) VALUES ($1,$2,$3,'E2E',$4,'active',$5,false,false,true)`, [id, email, suffix, suffix, role]);
  made.push(id);
  return { id, email, role, token: tok(id, email, role), refresh: jwt.sign({ sub: id, sessionId: uuid(), type: 'refresh' }, SECRET, { expiresIn: '1d' }) };
}
async function onboard(u, a) { const r = await fetch(`${API}/api/onboarding/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: JSON.stringify({ messages: [{ role: 'assistant', content: FIRST_Q }, { role: 'user', content: a }] }) }); if (!r.ok) throw new Error('onboard ' + r.status); }
async function rest(u, m, p, b) { const r = await fetch(`${API}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); if (!r.ok) throw new Error(`${m} ${p} ${r.status}: ${t.slice(0, 150)}`); return t ? JSON.parse(t) : null; }
function connect(u) { return new Promise((res, rej) => { const s = io(SOCKET, { auth: { token: u.token }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', rej); setTimeout(() => rej(new Error('sock timeout')), 12000); }); }
const sockets = [];
async function runRound(host, sessionId, members) {
  const hs = await connect(host); sockets.push(hs);
  hs.emit('host:start_session', { sessionId }); await wait(2500);
  for (const u of members) { const s = await connect(u); sockets.push(s); s.emit('session:join', { sessionId }); }
  await wait(4000);
  hs.emit('host:generate_matches', { sessionId }); await wait(7000);
  hs.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hs.emit('host:start_round', { sessionId }); await wait(4000);
}
const cfg = (over) => ({ eventType: 'speed_networking', numberOfRounds: 1, maxParticipants: 50, roundDurationSeconds: 60, lobbyDurationSeconds: 600, ratingWindowSeconds: 20, transitionDurationSeconds: 15, closingLobbyDurationSeconds: 300, noShowTimeoutSeconds: 90, ...over });

let browser, pass = false;
const checks = {};
try {
  console.log('1) create + onboard');
  const host = await createUser('host', 'super_admin');
  const A = await createUser('founderA'), B = await createUser('investorB'), C = await createUser('founderC'), D = await createUser('recruiterD');
  const E = await createUser('memberE'), F = await createUser('memberF');
  await onboard(A, 'I am the founder of a SaaS startup. I want to meet investors who back SaaS. Do not match me with recruiters.');
  await onboard(B, 'I am an angel investor backing SaaS startups. I want to meet SaaS founders.');
  await onboard(C, 'I am a fintech founder looking to meet investors.');
  await onboard(D, 'I am a technical recruiter hiring engineers.');
  const tag = { [A.id]: 'A/founder', [B.id]: 'B/investor', [C.id]: 'C/founder', [D.id]: 'D/recruiter', [E.id]: 'E', [F.id]: 'F', [host.id]: 'HOST' };

  console.log('2) pod + session1 (default) + register + set A check-in intention');
  const pod = (await rest(host, 'POST', '/pods', { name: 'E2E P2 Pod', description: 'p2', visibility: 'private', podType: 'speed_networking', orchestrationMode: 'timed_rounds', communicationMode: 'hybrid' })).data;
  for (const u of [A, B, C, D, E, F]) await rest(host, 'POST', `/pods/${pod.id}/members`, { userId: u.id, role: 'member' });
  const s1 = (await rest(host, 'POST', '/sessions', { podId: pod.id, title: 'E2E P2 s1', description: 'p2', scheduledAt: new Date(Date.now() + 60000).toISOString(), config: cfg() })).data;
  for (const u of [A, B, C, D]) await rest(u, 'POST', `/sessions/${s1.id}/register`);
  await rest(A, 'POST', `/sessions/${s1.id}/intention`, { intention: 'meet investors', openness: 'only_relevant' });

  console.log('3) run round 1');
  await runRound(host, s1.id, [A, B, C, D]);

  console.log('4) assert storage + intent + designation');
  const m1 = (await pool.query(`SELECT participant_a_id a, participant_b_id b, participant_c_id c, confidence, matching_template_id, reason_tags FROM matches WHERE session_id=$1`, [s1.id])).rows;
  for (const r of m1) console.log(`   ${tag[r.a]||'-'} + ${tag[r.b]||'-'} | conf=${r.confidence} | tpl=${r.matching_template_id} | tags=${JSON.stringify(r.reason_tags)}`);
  checks.storageConfidence = m1.length > 0 && m1.every((r) => r.confidence !== null && Number(r.confidence) >= 0 && Number(r.confidence) <= 1);
  const aRow = m1.find((r) => [r.a, r.b, r.c].includes(A.id));
  checks.intentPairing = !!aRow && [aRow.a, aRow.b, aRow.c].includes(B.id);
  checks.designationTag = !!aRow && (aRow.reason_tags || []).some((t) => t.startsWith('designation:') || t === 'mutual_intent' || t === 'event_intent');
  const aSp = (await pool.query(`SELECT event_intention, openness FROM session_participants WHERE session_id=$1 AND user_id=$2`, [s1.id, A.id])).rows[0];
  checks.intentionStored = aSp?.event_intention === 'meet investors' && aSp?.openness === 'only_relevant';
  console.log('   storageConfidence:', checks.storageConfidence, '| intentPairing(A+B):', checks.intentPairing, '| designation/intent tag:', checks.designationTag, '| intentionStored:', checks.intentionStored);

  console.log('5) assert analytics endpoint');
  const an = await fetch(`${API}/api/admin/analytics/matching`, { headers: { Authorization: `Bearer ${host.token}` } });
  const anData = (await an.json().catch(() => null))?.data;
  checks.analytics = an.status === 200 && anData && typeof anData.totalMatches === 'number' && anData.totalMatches >= 1 && Array.isArray(anData.byTemplate);
  console.log('   analytics http:', an.status, '| totalMatches:', anData?.totalMatches, '| ok:', checks.analytics);

  console.log('6) cooldown edge case: seed recent encounter A-B, run a cooldown session, assert A-B excluded');
  const [lo, hi] = A.id < B.id ? [A.id, B.id] : [B.id, A.id];
  await pool.query(
    `INSERT INTO encounter_history (user_a_id, user_b_id, times_met, last_met_at, last_session_id, mutual_meet_again, created_at, updated_at)
     VALUES ($1,$2,1,NOW(),$3,false,NOW(),NOW())
     ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET times_met=1, last_met_at=NOW()`,
    [lo, hi, s1.id]
  );
  const s2 = (await rest(host, 'POST', '/sessions', { podId: pod.id, title: 'E2E P2 cooldown', description: 'p2cd', scheduledAt: new Date(Date.now() + 60000).toISOString(), config: cfg({ matchingPolicy: 'cooldown', cooldownMonths: 12 }) })).data;
  for (const u of [A, B, E, F]) await rest(u, 'POST', `/sessions/${s2.id}/register`);
  await runRound(host, s2.id, [A, B, E, F]);
  const m2 = (await pool.query(`SELECT participant_a_id a, participant_b_id b, participant_c_id c FROM matches WHERE session_id=$1`, [s2.id])).rows;
  for (const r of m2) console.log(`   cooldown round: ${tag[r.a]||'-'} + ${tag[r.b]||'-'}${r.c?' + '+(tag[r.c]||'-'):''}`);
  const abPaired = m2.some((r) => [r.a, r.b, r.c].includes(A.id) && [r.a, r.b, r.c].includes(B.id));
  checks.cooldownExcluded = m2.length > 0 && !abPaired;
  console.log('   A-B NOT paired under cooldown (recent encounter excluded):', checks.cooldownExcluded);

  console.log('7) headed screenshots: check-in modal + analytics Matching tab');
  try {
    browser = await chromium.launch({ headless: !process.env.HEADED, slowMo: process.env.HEADED ? 120 : 0, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
    // check-in modal (fresh member E browser on the live session)
    const ec = await browser.newContext({ viewport: { width: 720, height: 760 }, permissions: ['camera', 'microphone'] });
    await ec.addInitScript(([a, r]) => { localStorage.setItem('rsn_access', a); localStorage.setItem('rsn_refresh', r); }, [E.token, E.refresh]);
    const ep = await ec.newPage();
    await ep.goto(`${APP}/session/${s1.id}/live`, { waitUntil: 'domcontentloaded' });
    const modalSeen = await ep.getByText(/What brings you here today/i).first().isVisible({ timeout: 12000 }).catch(() => false);
    checks.checkinModal = modalSeen;
    await ep.screenshot({ path: `${OUT}/p2-checkin.png` });
    console.log('   check-in modal visible:', modalSeen);
    // analytics Matching tab (host browser)
    const hc = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await hc.addInitScript(([a, r]) => { localStorage.setItem('rsn_access', a); localStorage.setItem('rsn_refresh', r); }, [host.token, host.refresh]);
    const hp = await hc.newPage();
    await hp.goto(`${APP}/admin/analytics`, { waitUntil: 'domcontentloaded' });
    await hp.getByRole('button', { name: /Matching/i }).click({ timeout: 12000 }).catch(() => {});
    await wait(1500);
    const tabSeen = await hp.getByText(/By template|matching engine/i).first().isVisible().catch(() => false);
    checks.analyticsTab = tabSeen;
    await hp.screenshot({ path: `${OUT}/p2-analytics.png` });
    console.log('   analytics Matching tab visible:', tabSeen);
  } catch (e) { console.log('   headed visuals error (non-fatal):', e.message); }

  pass = checks.storageConfidence && checks.intentPairing && checks.intentionStored && checks.analytics && checks.cooldownExcluded;
  console.log('--- SUMMARY ---', JSON.stringify(checks));
  console.log(pass ? 'PHASE2_PROD: PASS' : 'PHASE2_PROD: FAIL');
} catch (e) {
  console.error('ERROR:', e.message);
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  if (browser) await browser.close().catch(() => {});
  try {
    const s = await pool.query('SELECT id FROM sessions WHERE host_user_id = ANY($1)', [made]);
    const sids = s.rows.map((r) => r.id);
    if (sids.length) { await pool.query('DELETE FROM encounter_history WHERE last_session_id = ANY($1)', [sids]).catch(() => {}); await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [sids]).catch(() => {}); }
    await pool.query('DELETE FROM pods WHERE created_by = ANY($1)', [made]).catch(() => {});
    await pool.query('DELETE FROM encounter_history WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)', [made]).catch(() => {});
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [made]).catch(() => {});
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = ANY($1)', [made]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [made]).catch(() => {});
  } catch (e) { console.error('cleanup err', e.message); }
  await pool.end();
  console.log(pass ? 'RESULT: PASS (cleaned up)' : 'RESULT: FAIL (cleaned up)');
}
