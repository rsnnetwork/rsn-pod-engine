// Real-account verification of the LinkedIn photo offer, on production.
//
// Ali asked for it on his own test account, alihammza143@gmail.com, and that
// account is the exact race case: he signed in 23s after approving and the
// scrape took 25s, so nothing was ever copied onto the account. Its LinkedIn
// photo lives only on the join request.
//
// He chose his Google photo, so this snapshots it first and puts it back at
// the end whatever happens. Headed, at phone width.
//
//   cd e2e && node verify-linkedin-photo-alihammza.mjs

import { chromium } from '@playwright/test';
import pg from 'pg';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { readFileSync, mkdirSync } from 'fs';
import { config } from 'dotenv';
config({ path: 'C:/dev/RSN/server/.env' });

const EMAIL = 'alihammza143@gmail.com';
const APP = 'https://app.rsn.network';
const SERVER = 'https://api.rsn.network';
const SECRET = readFileSync('C:/dev/RSN/e2e/.jwt_secret', 'utf8').trim();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
mkdirSync('test-results', { recursive: true });

const results = [];
const check = (ok, what) => { results.push({ ok, what }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`); };

const u = (await pool.query(`SELECT id, display_name FROM users WHERE lower(email) = $1`, [EMAIL])).rows[0];
if (!u) { console.error('account not found'); process.exit(1); }
const token = jwt.sign({ sub: u.id, email: EMAIL, role: 'member', displayName: u.display_name, sessionId: randomUUID() }, SECRET, { expiresIn: '1h' });
const api = async (method, path) => {
  const r = await fetch(`${SERVER}/api${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, json: await r.json().catch(() => null) };
};

// 1. Keep his chosen photo so it can go back exactly as it was.
const snap = (await pool.query(`SELECT avatar_url, avatar_blob, avatar_blob_type FROM users WHERE id = $1`, [u.id])).rows[0];
console.log(`snapshot: his photo is ${snap.avatar_blob ? `${snap.avatar_blob.length} bytes (${snap.avatar_blob_type})` : 'none'}`);

let browser;
try {
  // 2. The race fix, on the very account that hit it: nothing was ever copied
  //    onto it, yet the photo is found on the join request.
  const onAccount = (await pool.query(
    `SELECT inferred_profile->'enriched'->'profile'->>'photoUrl' AS url FROM user_intent_profiles WHERE user_id = $1`, [u.id])).rows[0]?.url ?? null;
  check(!onAccount, 'the photo was never copied onto the account (the race happened)');
  const offer = await api('GET', '/onboarding/linkedin-photo');
  check(offer.status === 200 && /^https:\/\/media\.licdn\.com\//.test(offer.json?.data?.photoUrl ?? ''),
    'the API still finds his LinkedIn photo, on the join request');

  // 3. As a new member who signed in by email would be: no photo yet.
  await pool.query(`UPDATE users SET avatar_blob = NULL, avatar_blob_type = NULL, avatar_url = NULL WHERE id = $1`, [u.id]);

  browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(t => {
    localStorage.setItem('rsn_access', t); localStorage.setItem('rsn_refresh', t);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t, refresh: t }));
  }, token);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});

  // 4. The confirm step of onboarding: the moment the deck is about.
  await page.goto(`${APP}/onboarding?step=confirm`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('linkedin-photo-offer');
  await card.waitFor({ timeout: 30_000 }).catch(() => {});
  check(await card.isVisible().catch(() => false), 'the confirm step asks "Is this you?"');
  check(await page.getByText('Is this you?').isVisible().catch(() => false), 'in those words');
  const loaded = await card.locator('img').evaluate(img => img.complete && img.naturalWidth > 0).catch(() => false);
  check(loaded, 'and shows his actual LinkedIn photo, loaded (not a broken image)');

  // Every control a thumb can reach: inside the window and not covered.
  const yes = page.getByRole('button', { name: /Yes, use it/i });
  const reach = await yes.evaluate(el => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
             onTop: el === top || el.contains(top), h: Math.round(r.height) };
  }).catch(() => ({ inside: false, onTop: false, h: 0 }));
  check(reach.inside && reach.onTop, '"Yes, use it" is on screen and not covered at 390px');
  check(reach.h >= 44, `"Yes, use it" is a ${reach.h}px target (44 minimum)`);
  check(await page.getByRole('button', { name: /^Not me$/ }).isVisible().catch(() => false), '"Not me" is offered too');
  await page.screenshot({ path: 'test-results/li-offer-confirm-step.png' });

  // 5. He says yes.
  const box = await yes.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await card.waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
  check(!(await card.isVisible().catch(() => false)), 'the card goes away once he has said yes');

  const after = (await pool.query(`SELECT avatar_url, avatar_blob_type, length(avatar_blob) AS n FROM users WHERE id = $1`, [u.id])).rows[0];
  check(!!after.n && /^image\//.test(after.avatar_blob_type || ''), `the LinkedIn photo is now stored as his (${after.n} bytes, ${after.avatar_blob_type})`);
  const served = await fetch(after.avatar_url?.startsWith('http') ? after.avatar_url : `${SERVER}${after.avatar_url}`);
  check(served.status === 200 && /^image\//.test(served.headers.get('content-type') || ''), 'and it is served as an image');
  const ev = (await pool.query(
    `SELECT detail FROM onboarding_stage_events WHERE user_id = $1 AND stage::text = 'photo_captured' ORDER BY created_at DESC LIMIT 1`, [u.id])).rows[0];
  check(ev?.detail?.source === 'linkedin_confirmed', 'recorded as confirmed by him, not applied for him');
  await page.screenshot({ path: 'test-results/li-offer-after-yes.png' });

  // 6. The profile page: the choice is always there, and "Not me" changes nothing.
  await page.goto(`${APP}/profile`, { waitUntil: 'domcontentloaded' });
  const btn = page.getByTestId('use-linkedin-photo');
  await btn.waitFor({ timeout: 30_000 }).catch(() => {});
  check(await btn.isVisible().catch(() => false), 'the profile page offers "Use my LinkedIn photo"');
  await btn.click().catch(() => {});
  const pCard = page.getByTestId('linkedin-photo-offer');
  check(await pCard.isVisible().catch(() => false), 'which opens the same "Is this you?" card');
  const beforeNotMe = (await pool.query(`SELECT length(avatar_blob) AS n FROM users WHERE id = $1`, [u.id])).rows[0].n;
  await page.getByRole('button', { name: /^Not me$/ }).click().catch(() => {});
  await page.waitForTimeout(1500);
  const afterNotMe = (await pool.query(`SELECT length(avatar_blob) AS n FROM users WHERE id = $1`, [u.id])).rows[0].n;
  check(!(await pCard.isVisible().catch(() => false)) && beforeNotMe === afterNotMe, '"Not me" closes it and changes nothing');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, 'no sideways scroll on the profile page at 390px');
  await page.screenshot({ path: 'test-results/li-offer-profile.png' });
} finally {
  try { await browser?.close(); } catch { /* noop */ }
  // 7. His Google photo, back exactly as it was.
  await pool.query(`UPDATE users SET avatar_url = $2, avatar_blob = $3, avatar_blob_type = $4 WHERE id = $1`,
    [u.id, snap.avatar_url, snap.avatar_blob, snap.avatar_blob_type]);
  const back = (await pool.query(`SELECT length(avatar_blob) AS n, avatar_blob_type t FROM users WHERE id = $1`, [u.id])).rows[0];
  console.log(`restored: his photo is ${back.n ? `${back.n} bytes (${back.t})` : 'none'}, as it was`);
  await pool.end();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
