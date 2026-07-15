import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';
import { connectSocket, cleanup, wait, Socket } from '../helpers/live-ui';

// PROD VERIFICATION — 15 Jul live event "mn" lost trio encounters.
//
// A trio is ONE match row holding THREE people = THREE pairs who met (a-b,
// a-c, b-c). finalizeSessionEncounters only read participant_a/participant_b,
// so the two pairs involving the third person were never written to
// encounter_history — the cross-event "have these two already met" memory the
// matcher reads. Real fallout: Chief Developer met Waseem and jack in the
// rounds-1/4 trio of "mn" and ended the event with no row for either pair.
//
// This runs a real 3-person event on prod (3 participants => the matcher builds
// exactly one trio), ends it, then asserts ALL THREE pairs exist in
// encounter_history. Participants are socket-only: the defect is server-side
// encounter recording, so no browser/video is needed.

let host: TestUser;
const P: TestUser[] = [];
const socks: Socket[] = [];
let podId = '', sessionId = '';
const key = (a: string, b: string) => [a, b].sort().join('|');

test.beforeAll(async () => {
  host = await createTestUser('triohost', 'super_admin');
  for (let i = 1; i <= 3; i++) P.push(await createTestUser(`triop${i}`));
  const pod = await createPod(host, 'E2E Trio Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY trio encounters', new Date(Date.now() + 60_000), {
    numberOfRounds: 1, roundDurationSeconds: 60, ratingWindowSeconds: 20,
  });
  sessionId = sess.id;
  await Promise.all(P.map(u => registerForSession(u, sessionId)));
});

test.afterAll(async () => {
  for (const s of socks) { try { s.close(); } catch {} }
  await cleanup(pool, { ids: [host?.id, ...P.map(p => p.id)].filter(Boolean), podId });
});

test('every pair of a trio is recorded in encounter_history — nobody is forgotten', async () => {
  test.setTimeout(240_000);

  const hostSock = await connectSocket(host); socks.push(hostSock);
  for (const u of P) {
    const s = await connectSocket(u); socks.push(s);
    s.emit('session:join', { sessionId });
  }
  await wait(4000);

  hostSock.emit('host:start_session', { sessionId }); await wait(3000);
  for (const s of socks.slice(1)) s.emit('session:join', { sessionId });
  await wait(2500);

  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(6000);

  // 3 present participants => exactly one trio. Assert that's what we built,
  // otherwise this test would silently verify nothing.
  const m = await pool.query(
    `SELECT participant_a_id a, participant_b_id b, participant_c_id c, status
       FROM matches WHERE session_id=$1`, [sessionId]);
  console.log(`  matches built: ${m.rows.length} | trio: ${m.rows.some(r => r.c) ? 'yes' : 'NO'}`);
  expect(m.rows.some(r => r.c), 'the matcher must build a trio for 3 participants (else nothing is verified)').toBe(true);

  // End the event -> completeSession fires finalizeSessionEncounters.
  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(9000);

  const trio = m.rows.find(r => r.c)!;
  const expected = [key(trio.a, trio.b), key(trio.a, trio.c), key(trio.b, trio.c)].sort();

  // encounter_history is fire-and-forget from completeSession, so poll briefly.
  await expect.poll(async () => {
    const eh = await pool.query(
      `SELECT user_a_id, user_b_id FROM encounter_history
        WHERE user_a_id = ANY($1) AND user_b_id = ANY($1)`, [P.map(p => p.id)]);
    return eh.rows.map(r => key(r.user_a_id, r.user_b_id)).sort();
  }, { timeout: 30_000, message: 'all three trio pairs must be recorded (a-c and b-c were dropped pre-fix)' })
    .toEqual(expected);

  const rows = await pool.query(
    `SELECT user_a_id, user_b_id, times_met, last_session_id FROM encounter_history
      WHERE user_a_id = ANY($1) AND user_b_id = ANY($1)`, [P.map(p => p.id)]);
  rows.rows.forEach(r => console.log(`  pair recorded | times_met: ${r.times_met} | last_session matches event: ${r.last_session_id === sessionId}`));
  // The pair who met here must point at THIS event, not a stale earlier one.
  expect(rows.rows.every(r => r.last_session_id === sessionId),
    'last_session_id must name the event they just met in').toBe(true);
  console.log('  ✓ all three trio pairs recorded, each pointing at this event.');
});
