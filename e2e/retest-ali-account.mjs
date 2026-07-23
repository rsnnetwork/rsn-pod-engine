// One-off headed retest of the real alihammza143 account after the fix wave.
// Proves: (1) self-heal — the stored 'failed' enrichment retries on entering
// onboarding and lands the real LinkedIn data; (2) instant — a reload shows
// the found card immediately from cache. Read-only except the enrichment the
// retry itself performs. Does NOT enter the chat (left for Ali).
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const EMAIL = 'alihammza143@gmail.com';
const APP = 'https://app.rsn.network';
const SECRET = process.env.E2E_JWT_SECRET;
const DB = process.env.DATABASE_URL;
if (!SECRET || !DB) { console.error('need E2E_JWT_SECRET and DATABASE_URL'); process.exit(1); }

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } });
const state = async (uid) => (await pool.query(
  'SELECT enrichment_status, enrichment_source, enrichment_error FROM user_intent_profiles WHERE user_id = $1', [uid])).rows[0];

const { rows } = await pool.query('SELECT id, email, role, display_name, linkedin_url FROM users WHERE email = $1', [EMAIL]);
if (rows.length !== 1) { console.error('user not found'); process.exit(1); }
const u = rows[0];
console.log('ACCOUNT:', u.email, '| URL on file:', u.linkedin_url);
console.log('BEFORE :', JSON.stringify(await state(u.id)));

const claims = { sub: u.id, email: u.email, role: u.role, displayName: u.display_name, sessionId: 'retest-' + Math.random().toString(36).slice(2) };
const access = jwt.sign(claims, SECRET, { expiresIn: '2h' });
const refresh = jwt.sign(claims, SECRET, { expiresIn: '2h' });

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript((t) => {
  localStorage.setItem('rsn_access', t.a);
  localStorage.setItem('rsn_refresh', t.r);
}, { a: access, r: refresh });
const page = await ctx.newPage();

// --- Pass 1: self-heal (stored failed -> retry -> found) ---
const t0 = Date.now();
await page.goto(`${APP}/onboarding`, { waitUntil: 'domcontentloaded' });
const searching = page.getByText('I am retrieving your public profile');
const card = page.getByText(/Is it right\?/i);
const sawSearching = await searching.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
console.log('PASS1: searching card shown:', sawSearching, `(+${((Date.now()-t0)/1000).toFixed(1)}s)`);
await card.waitFor({ state: 'visible', timeout: 150_000 });
console.log(`PASS1: confirm card visible after ${((Date.now()-t0)/1000).toFixed(1)}s`);
await page.waitForTimeout(1500);
const cardText = await page.locator('div.rounded-2xl.border').first().innerText().catch(() => '<no card>');
console.log('PASS1 CARD:\n' + cardText.split('\n').slice(0, 16).join('\n'));
await page.screenshot({ path: process.env.SHOT1 || 'retest-selfheal.png', fullPage: false });
console.log('MID   :', JSON.stringify(await state(u.id)));

// --- Pass 2: instant (cache -> found with no meaningful wait) ---
const t1 = Date.now();
await page.reload({ waitUntil: 'domcontentloaded' });
await card.waitFor({ state: 'visible', timeout: 30_000 });
console.log(`PASS2: confirm card visible after reload in ${((Date.now()-t1)/1000).toFixed(1)}s`);
await page.screenshot({ path: process.env.SHOT2 || 'retest-instant.png', fullPage: false });

console.log('AFTER :', JSON.stringify(await state(u.id)));
const ev = await pool.query('SELECT stage, detail, created_at FROM onboarding_stage_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 4', [u.id]);
ev.rows.forEach(e => console.log('  event:', e.stage, '|', JSON.stringify(e.detail).slice(0, 120)));

await browser.close();
await pool.end();
console.log('RETEST COMPLETE — chat left untouched for Ali.');
