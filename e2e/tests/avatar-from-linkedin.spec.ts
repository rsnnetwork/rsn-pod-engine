import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, cleanupByPrefix, SERVER } from '../helpers/live-ui';

// THE PHOTO COMES WITH THE PROFILE (7 Sep 2026, Ali: "why is it not getting
// my image from LinkedIn?").
//
// A member approved before their first login carries the approval-time
// enrichment cache into onboarding, and that cached path never captured the
// photo the scrape had found. This drives exactly that path on production
// with a real LinkedIn profile that has a photo: join form → admin approval
// (preload) → one-click link → onboarding enrichment (cache hit) → the photo
// is stored and served as the member's avatar. API only, no browser.

const LINKEDIN = 'https://www.linkedin.com/in/alihamzaraja/';
let admin: TestUser;
let email = '';
let userId = '';

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test.beforeAll(async () => {
  admin = await createTestUser('avataradmin', 'super_admin');
  email = `e2etest-avatar-${Date.now()}@example.com`;
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM magic_links WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
  await pool.query(`DELETE FROM join_requests WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
  const ids = [admin?.id, userId].filter(Boolean);
  await pool.query(`DELETE FROM onboarding_stage_events WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM user_intent_profiles WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  await cleanupByPrefix(pool, 'e2etest-avatar');
});

test('a member approved before login gets their LinkedIn photo as their avatar through the cached path', async () => {
  test.setTimeout(420_000);

  const jr = await api('POST', '/join-requests', { fullName: 'Ali Hamza Raja', email, linkedinUrl: LINKEDIN, reason: 'testing that the photo comes with the profile' });
  expect(jr.status, JSON.stringify(jr.json)).toBe(201);
  const requestId = jr.json.data.id;

  const approve = await api('PATCH', `/join-requests/${requestId}/review`, { decision: 'approved' }, admin.accessToken);
  expect(approve.status, JSON.stringify(approve.json)).toBe(200);

  // The approval preloads the enrichment; the scrape brings the photo URL with it.
  await expect.poll(async () =>
    (await pool.query(`SELECT enriched IS NOT NULL AS done FROM join_requests WHERE id = $1`, [requestId])).rows[0].done,
    { timeout: 240_000, intervals: [5_000] }).toBe(true);
  const cached = await pool.query(`SELECT enriched->'profile'->>'photoUrl' AS photo, enriched->>'confidence' AS confidence FROM join_requests WHERE id = $1`, [requestId]);
  console.log(`  preload: confidence ${cached.rows[0].confidence}, photo ${String(cached.rows[0].photo).slice(0, 60)}…`);
  expect(cached.rows[0].photo, 'the scrape found a real photo (media.licdn.com), not the grey placeholder').toMatch(/^https:\/\/media\.licdn\.com\//);

  // One-click link, the real login path for an approved member.
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [email, crypto.createHash('sha256').update(token).digest('hex')]);
  const verify = await api('POST', '/auth/verify', { token });
  expect(verify.status, JSON.stringify(verify.json)).toBe(200);
  const access: string = verify.json.data?.accessToken ?? verify.json.data?.tokens?.accessToken ?? verify.json.accessToken;
  expect(access, 'verify returned an access token').toBeTruthy();
  const u = await pool.query(`SELECT id, avatar_url, avatar_blob IS NOT NULL AS has_blob FROM users WHERE lower(email) = $1`, [email.toLowerCase()]);
  userId = u.rows[0].id;
  expect(u.rows[0].has_blob, 'no photo yet at login').toBe(false);

  // Onboarding asks for the enrichment; the fresh cache answers, and the photo is captured.
  const enrich = await api('POST', '/onboarding/enrich', { linkedinUrl: LINKEDIN }, access);
  expect([200, 202]).toContain(enrich.status);
  await expect.poll(async () =>
    (await pool.query(`SELECT avatar_blob IS NOT NULL AS has_blob FROM users WHERE id = $1`, [userId])).rows[0].has_blob,
    { timeout: 90_000, intervals: [3_000] }).toBe(true);
  const after = await pool.query(`SELECT avatar_url, avatar_blob_type FROM users WHERE id = $1`, [userId]);
  console.log(`  captured: ${after.rows[0].avatar_blob_type}, served at ${after.rows[0].avatar_url}`);
  expect(after.rows[0].avatar_blob_type).toMatch(/^image\//);
  expect(after.rows[0].avatar_url).toBeTruthy();

  // It is served, and it is an image.
  const served = await fetch(after.rows[0].avatar_url.startsWith('http') ? after.rows[0].avatar_url : `${SERVER}${after.rows[0].avatar_url}`);
  expect(served.status).toBe(200);
  expect(served.headers.get('content-type') || '').toMatch(/^image\//);

  const ev = await pool.query(`SELECT stage::text, detail FROM onboarding_stage_events WHERE user_id = $1 AND stage::text IN ('photo_captured','photo_failed') ORDER BY created_at DESC LIMIT 1`, [userId]);
  expect(ev.rows[0]?.stage).toBe('photo_captured');
  console.log(`  ✓ photo captured through the cached path (${JSON.stringify(ev.rows[0].detail)}).`);
});
