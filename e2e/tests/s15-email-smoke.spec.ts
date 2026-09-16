import { test, expect } from '@playwright/test';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession } from '../helpers/api';
import axios from 'axios';
import { Pool } from 'pg';

// S15 smoke vs PRODUCTION — duplicate registration-confirmation email.
// Repro (Ali, 2026-06-06): every "Join Live Event" / rejoin-after-leaving
// re-sent the "you're registered" email, because the live page auto-registers
// on mount and a 'left' row flips back to 'registered' via the re-register
// UPDATE — which the route emailed like a fresh signup.
// Assert: fresh register → isNewRegistration true (emails); leave → rejoin →
// 201 with isNewRegistration false (silent). If RESEND_KEY is present, also
// count actual sends to the address via the Resend API.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const RESEND = process.env.RESEND_KEY;

async function resendCountTo(email: string): Promise<number | null> {
  if (!RESEND) return null;
  try {
    const r = await axios.get('https://api.resend.com/emails', {
      headers: { Authorization: `Bearer ${RESEND}` },
      validateStatus: () => true,
    });
    if (r.status !== 200) return null;
    const list: Array<{ to: string | string[] }> = r.data?.data || [];
    return list.filter((e) => (Array.isArray(e.to) ? e.to : [e.to]).includes(email)).length;
  } catch { return null; }
}

let host: TestUser;

test.afterAll(async () => {
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('S15: rejoin after leaving does not re-send the registration email', async () => {
  test.setTimeout(180_000);

  host = await createTestUser('s15host', 'super_admin');
  const user = await createTestUser('s15mail');
  console.log('  test user email:', user.email);
  const pod = await createPod(host, 'E2E S15 Email Pod');
  await addPodMember(host, pod.id, user.id);
  const sess = await createSession(host, pod.id, 'E2E S15 Email Smoke', new Date(Date.now() + 3600_000), {
    numberOfRounds: 1, roundDurationSeconds: 300,
  });

  const auth = { headers: { Authorization: `Bearer ${user.accessToken}` }, validateStatus: () => true as const };

  const r1 = await axios.post(`${SERVER}/api/sessions/${sess.id}/register`, {}, auth);
  console.log(`  fresh register: HTTP ${r1.status} isNewRegistration=${r1.data?.data?.isNewRegistration}`);
  expect(r1.status, 'fresh register succeeds').toBe(201);
  expect(r1.data?.data?.isNewRegistration, 'fresh register IS new').toBe(true);

  await new Promise((r) => setTimeout(r, 8000)); // fire-and-forget send window
  const c1 = await resendCountTo(user.email);
  console.log('  emails after fresh register:', c1);

  // Ali's repro shape: an IN-EVENT leave ("Back to Main Room" / Leave Event /
  // browser close) writes status='left' and KEEPS the row — it does not go
  // through DELETE /register (that's the pre-event cancel, which deletes the
  // row and makes the next register a legitimately fresh one).
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(
    `UPDATE session_participants SET status = 'left', left_at = NOW() WHERE session_id = $1 AND user_id = $2`,
    [sess.id, user.id],
  );
  console.log("  participant flipped to 'left' (in-event leave shape)");

  const r2 = await axios.post(`${SERVER}/api/sessions/${sess.id}/register`, {}, auth);
  console.log(`  rejoin re-register: HTTP ${r2.status} isNewRegistration=${r2.data?.data?.isNewRegistration}`);
  expect(r2.status, 'rejoin re-register succeeds').toBe(201);
  expect(r2.data?.data?.isNewRegistration, 'rejoin is NOT a new registration → no email').toBe(false);

  await new Promise((r) => setTimeout(r, 8000));
  const c2 = await resendCountTo(user.email);
  console.log('  emails after rejoin:', c2);

  // Contrast case: a deliberate CANCEL (row deleted) + re-register IS fresh
  // and deserves a new confirmation + calendar invite.
  const rd = await axios.delete(`${SERVER}/api/sessions/${sess.id}/register`, auth);
  console.log(`  cancel registration: HTTP ${rd.status}`);
  const r3 = await axios.post(`${SERVER}/api/sessions/${sess.id}/register`, {}, auth);
  console.log(`  register after cancel: HTTP ${r3.status} isNewRegistration=${r3.data?.data?.isNewRegistration}`);
  expect(r3.status, 'register after cancel succeeds').toBe(201);
  expect(r3.data?.data?.isNewRegistration, 'register after cancel IS new → emails again (correct)').toBe(true);
  await pool.end();

  if (c1 !== null && c2 !== null) {
    expect(c1, 'exactly one confirmation email for the fresh register').toBe(1);
    expect(c2, 'rejoin sent NO additional email').toBe(c1);
    console.log('✓ S15 FULL PASS — 1 email for fresh, rejoin silent (Resend-verified), cancel+re-register fresh again');
  } else {
    console.log('✓ S15 API PASS — isNewRegistration fresh:true → rejoin:false → cancel+register:true (Resend list unavailable; email gate unit-pinned)');
  }
});
