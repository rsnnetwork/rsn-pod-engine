import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { pool } from '../helpers/auth';
import { SERVER, cleanup, teardown } from '../helpers/live-ui';

// CONFIRM IT'S YOU BEFORE A SENSITIVE CHANGE (10 Nov 2026 spec, Part 3 Task 2): over the API only (the production client
// sends nothing new yet; the dialogs come with the preview client).
//
// A throwaway member A (<uuid>@rsn-e2e.invalid, a reserved address: production stores every code but sends no email)
// signs in by sign-in code for a real token pair. It asks for a change_email confirmation code; the spec writes the
// keyed hash of a code it chose onto A's newest reauth row (as n1-t4-signin-code.spec.ts does for sign-in) and verifies:
// a reauth token. POST /users/me/email/code with a fresh reserved address and the token is 200; the same token again is
// 403 REAUTH_REQUIRED. The spec writes a code onto the email_change row and verifies: a new token pair. GET /users/me
// shows the new address, and the old refresh token no longer refreshes. Then close without a token is 403, and with a
// fresh close_account proof 200, after which the next signed-in call fails. Cleanup deletes A by id, and the magic links
// of A's two exact addresses.

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const RUN = Date.now().toString(36);
const firstEmail = `p3t2-${RUN}-${uuid()}@rsn-e2e.invalid`;
const secondEmail = `p3t2-${RUN}-${uuid()}@rsn-e2e.invalid`;
let memberId = '';

async function call(method: string, p: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Put the keyed hash of a code the spec chose on the newest row `where` picks, and answer the code. */
async function knownCode(where: string, params: unknown[]): Promise<string> {
  const row = await pool.query<{ id: string; token_hash: string }>(
    `SELECT id, token_hash FROM magic_links WHERE ${where} ORDER BY created_at DESC LIMIT 1`,
    params,
  );
  expect(row.rows[0], `a magic_links row where ${where}`).toBeTruthy();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const hash = crypto.createHmac('sha256', SECRET).update(`sign-in-code:${row.rows[0].token_hash}:${code}`).digest('hex');
  await pool.query(`UPDATE magic_links SET code_hash = $2 WHERE id = $1`, [row.rows[0].id, hash]);
  return code;
}

/** Ask for a confirmation code for `scope`, type a known one, and answer the reauth token. */
async function proofFor(accessToken: string, scope: 'change_email' | 'close_account'): Promise<string> {
  const asked = await call('POST', '/auth/reauth/code', { token: accessToken, body: { scope } });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(asked.json.data).toEqual({ sent: true });
  const code = await knownCode(`target_user_id = $1 AND purpose = 'reauth' AND action = $2`, [memberId, scope]);
  const verified = await call('POST', '/auth/reauth/verify', { token: accessToken, body: { scope, code } });
  expect(verified.status, JSON.stringify(verified.json)).toBe(200);
  expect(typeof verified.json.data.reauthToken).toBe('string');
  return verified.json.data.reauthToken as string;
}

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to set known codes').toBeTruthy();
  memberId = uuid();
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, 'P3T2 Member', 'Member', 'Test', 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Lisbon, Portugal')`,
    [memberId, firstEmail],
  );
});

test.afterAll(async () => {
  await teardown(
    () => pool.query(`DELETE FROM magic_links WHERE email = ANY($1::text[])`, [[firstEmail, secondEmail]]),
    () => cleanup(pool, { ids: memberId ? [memberId] : [] }),
  );
});

test('a member confirms it is them to change their sign-in email and to close their account; each proof works once', async () => {
  test.setTimeout(180_000);

  // A signs in by sign-in code: a real token pair, its refresh token stored.
  const signIn = await call('POST', '/auth/magic-link', { body: { email: firstEmail } });
  expect(signIn.status, JSON.stringify(signIn.json)).toBe(200);
  const signInCode = await knownCode(`email = $1 AND purpose = 'login'`, [firstEmail]);
  const session = await call('POST', '/auth/magic-link/code', { body: { email: firstEmail, code: signInCode } });
  expect(session.status, JSON.stringify(session.json)).toBe(200);
  const firstPair = session.json.data as { accessToken: string; refreshToken: string };

  // A change without a proof is refused, in words, naming the proof it needs.
  const bare = await call('POST', '/users/me/email/code', { token: firstPair.accessToken, body: { newEmail: secondEmail } });
  expect(bare.status).toBe(403);
  expect(bare.json.error).toEqual({
    code: 'REAUTH_REQUIRED', message: "Confirm it's you first. We'll email you a code.", details: { scope: 'change_email' },
  });
  // The proof is not a session.
  const emailProof = await proofFor(firstPair.accessToken, 'change_email');
  expect((await call('GET', '/users/me', { token: emailProof })).status).toBe(401);

  // The code goes to the new address; the same proof again is refused.
  const asked = await call('POST', '/users/me/email/code', { token: firstPair.accessToken, body: { newEmail: secondEmail, reauthToken: emailProof } });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(asked.json.data).toEqual({ sent: true });
  const replay = await call('POST', '/users/me/email/code', { token: firstPair.accessToken, body: { newEmail: secondEmail, reauthToken: emailProof } });
  expect(replay.status).toBe(403);
  expect(replay.json.error.code).toBe('REAUTH_REQUIRED');
  const changeRow = await pool.query(`SELECT email FROM magic_links WHERE target_user_id = $1 AND purpose = 'email_change'`, [memberId]);
  expect(changeRow.rows.map((r) => r.email)).toEqual([secondEmail]);

  // The new address's code makes the change and answers a fresh pair.
  const changeCode = await knownCode(`target_user_id = $1 AND purpose = 'email_change'`, [memberId]);
  const changed = await call('POST', '/users/me/email/verify', { token: firstPair.accessToken, body: { code: changeCode } });
  expect(changed.status, JSON.stringify(changed.json)).toBe(200);
  const secondPair = changed.json.data as { accessToken: string; refreshToken: string };
  expect(secondPair.accessToken).toBeTruthy();
  const me = await call('GET', '/users/me', { token: secondPair.accessToken });
  expect(me.status).toBe(200);
  expect(me.json.data.email).toBe(secondEmail);
  // Every earlier session is over.
  const oldRefresh = await call('POST', '/auth/refresh', { body: { refreshToken: firstPair.refreshToken } });
  expect(oldRefresh.status).toBe(401);
  // On record by id only.
  const record = await pool.query(`SELECT details::text AS details FROM audit_log WHERE actor_id = $1 AND action = 'user.email_changed'`, [memberId]);
  expect(record.rows).toHaveLength(1);
  expect(record.rows[0].details).not.toContain('@');

  // Closing: refused without a proof, done with a fresh close_account one, and the account then signs nothing in.
  const closeBare = await call('POST', '/users/me/close', { token: secondPair.accessToken, body: {} });
  expect(closeBare.status).toBe(403);
  expect(closeBare.json.error).toMatchObject({ code: 'REAUTH_REQUIRED', details: { scope: 'close_account' } });
  const closeProof = await proofFor(secondPair.accessToken, 'close_account');
  const closed = await call('POST', '/users/me/close', { token: secondPair.accessToken, body: { reauthToken: closeProof } });
  expect(closed.status, JSON.stringify(closed.json)).toBe(200);
  expect(closed.json.data).toEqual({ closed: true });
  const after = await call('GET', '/users/me', { token: secondPair.accessToken });
  expect(after.status).toBe(401);
  const row = await pool.query(`SELECT status FROM users WHERE id = $1`, [memberId]);
  expect(row.rows[0].status).toBe('deactivated');
});
