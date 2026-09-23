import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, cleanupByPrefix, SERVER } from '../helpers/live-ui';

// THE LINKEDIN PHOTO IS OFFERED, NEVER APPLIED FOR THEM (23 Sep 2026).
//
// Shradha's deck: nothing reaches a profile unless the member confirms it. It
// came from Stefan's own test, where the LinkedIn match was the wrong person.
// Until 23 Sep this spec proved the opposite: that the scraped photo landed on
// the account automatically at sign-in.
//
// Both tests drive the REAL path on production with a real LinkedIn profile:
// join form, admin approval (the preload scrape), a genuine magic-link sign-in
// through /auth/verify, then the photo is offered and the member says yes.
//
// The second is the race that hit Ali's own account on 23 Sep: he signed in
// 23s after approving, the scrape took 25s, and the one-time copy onto the
// account found nothing. The photo sat on the join request, never read again.

const LINKEDIN = 'https://www.linkedin.com/in/alihamzaraja/';
let admin: TestUser;
const emails: string[] = [];
const userIds: string[] = [];

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Request to join, and have an admin approve it, which starts the scrape. */
async function applyAndApprove(email: string): Promise<string> {
  const jr = await api('POST', '/join-requests', { fullName: 'Ali Hamza Raja', email, linkedinUrl: LINKEDIN, reason: 'testing the LinkedIn photo offer' });
  expect(jr.status, JSON.stringify(jr.json)).toBe(201);
  const approve = await api('PATCH', `/join-requests/${jr.json.data.id}/review`, { decision: 'approved' }, admin.accessToken);
  expect(approve.status, JSON.stringify(approve.json)).toBe(200);
  return jr.json.data.id;
}

/** The real one-click sign-in an approved member uses. */
async function signIn(email: string): Promise<{ access: string; id: string }> {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [email, crypto.createHash('sha256').update(token).digest('hex')]);
  const verify = await api('POST', '/auth/verify', { token });
  expect(verify.status, JSON.stringify(verify.json)).toBe(200);
  const access: string = verify.json.data?.accessToken ?? verify.json.data?.tokens?.accessToken ?? verify.json.accessToken;
  expect(access, 'verify returned an access token').toBeTruthy();
  const u = await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, [email.toLowerCase()]);
  userIds.push(u.rows[0].id);
  return { access, id: u.rows[0].id };
}

const hasPhoto = async (id: string) =>
  (await pool.query(`SELECT avatar_blob IS NOT NULL AS has FROM users WHERE id = $1`, [id])).rows[0].has as boolean;

const scrapeLanded = async (requestId: string) =>
  (await pool.query(`SELECT enriched IS NOT NULL AS done FROM join_requests WHERE id = $1`, [requestId])).rows[0].done as boolean;

/** The member says "that's me", and it is really theirs: stored and served. */
async function confirmAndCheck(id: string, access: string) {
  const offer = await api('GET', '/onboarding/linkedin-photo', undefined, access);
  expect(offer.status).toBe(200);
  expect(offer.json.data.photoUrl, 'the photo is offered').toMatch(/^https:\/\/media\.licdn\.com\//);

  const use = await api('POST', '/onboarding/linkedin-photo', undefined, access);
  expect(use.status, JSON.stringify(use.json)).toBe(200);
  expect(await hasPhoto(id), 'after yes it is their photo').toBe(true);

  const after = await pool.query(`SELECT avatar_url, avatar_blob_type FROM users WHERE id = $1`, [id]);
  expect(after.rows[0].avatar_blob_type).toMatch(/^image\//);
  const served = await fetch(after.rows[0].avatar_url.startsWith('http') ? after.rows[0].avatar_url : `${SERVER}${after.rows[0].avatar_url}`);
  expect(served.status).toBe(200);
  expect(served.headers.get('content-type') || '').toMatch(/^image\//);

  const ev = await pool.query(
    `SELECT detail FROM onboarding_stage_events WHERE user_id = $1 AND stage::text = 'photo_captured' ORDER BY created_at DESC LIMIT 1`, [id]);
  expect(ev.rows[0]?.detail).toEqual({ source: 'linkedin_confirmed' });
}

test.beforeAll(async () => {
  admin = await createTestUser('avataradmin', 'super_admin');
});

test.afterAll(async () => {
  for (const email of emails) {
    await pool.query(`DELETE FROM magic_links WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
    await pool.query(`DELETE FROM join_requests WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
  }
  const ids = [admin?.id, ...userIds].filter(Boolean);
  await pool.query(`DELETE FROM onboarding_stage_events WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM user_intent_profiles WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  await cleanupByPrefix(pool, 'e2etest-avatar');
  await pool.end().catch(() => {});
});

test('the LinkedIn photo is offered, not applied, and used only after the member says yes', async () => {
  test.setTimeout(420_000);
  const email = `e2etest-avatar-${Date.now()}@example.com`;
  emails.push(email);
  const requestId = await applyAndApprove(email);

  // The usual order: the scrape finishes long before they sign in.
  await expect.poll(() => scrapeLanded(requestId), { timeout: 240_000, intervals: [5_000] }).toBe(true);
  const { access, id } = await signIn(email);

  // Signing in used to put the photo on them. It must not now. Give the
  // fire-and-forget copy time to do its worst before looking.
  await new Promise(r => setTimeout(r, 8_000));
  expect(await hasPhoto(id), 'signing in does not put their LinkedIn photo on them').toBe(false);

  // Nor does the enrichment orchestrator's cached path, which also used to.
  const enrich = await api('POST', '/onboarding/enrich', { linkedinUrl: LINKEDIN }, access);
  expect([200, 202]).toContain(enrich.status);
  await new Promise(r => setTimeout(r, 8_000));
  expect(await hasPhoto(id), 'the orchestrator does not either').toBe(false);
  console.log('  ✓ nothing applied at sign-in or by the orchestrator');

  await confirmAndCheck(id, access);
  console.log('  ✓ offered, then used only after the member said yes');
});

test('THE RACE: signing in before the scrape finishes still gets the offer', async () => {
  test.setTimeout(420_000);
  const email = `e2etest-avatar-race-${Date.now()}@example.com`;
  emails.push(email);
  const requestId = await applyAndApprove(email);

  // Sign in straight away, the way Ali did.
  const { access, id } = await signIn(email);
  const wonTheRace = !(await scrapeLanded(requestId));
  console.log(`  signed in ${wonTheRace ? 'BEFORE' : 'after'} the scrape finished`);
  expect(wonTheRace, 'this test only means something if sign-in beat the scrape').toBe(true);

  // Nothing to offer yet: the scrape had not landed when they signed in.
  const early = await api('GET', '/onboarding/linkedin-photo', undefined, access);
  expect(early.json.data.photoUrl).toBeNull();

  // The scrape lands on the join request afterwards, and is found there even
  // though it was never copied onto the account.
  await expect.poll(() => scrapeLanded(requestId), { timeout: 240_000, intervals: [5_000] }).toBe(true);
  await confirmAndCheck(id, access);
  console.log('  ✓ the late scrape was still offered, and used');
});
