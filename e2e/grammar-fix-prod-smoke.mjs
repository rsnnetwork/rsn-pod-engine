// Headed prod smoke for the extraction fix (schema-in-prompt, transcript-safe).
// A brand-new member goes through the REAL chat on app.rsn.network and we
// assert Ali's exact complaint is gone:
//   1. the live card populates after EVERY answer (wants/offers/role),
//   2. confirm ("Yes, use this") completes onboarding — no form fallback,
//   3. the transcript + intent are persisted (turns > 0),
//   4. zero extract_failed stage events for the user.
// Cleans up its throwaway user at the end.
import { chromium } from '@playwright/test';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { config as dc } from 'dotenv';

const { Pool } = pkg;
dc({ path: 'C:/Users/ARFA TECH/Desktop/RSN-dev/server/.env' });
const RT = process.env.RENDER_TOKEN, SVC = process.env.RENDER_SVC;
const APP = 'https://app.rsn.network';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function prodSecret() {
  const r = await fetch(`https://api.render.com/v1/services/${SVC}/env-vars?limit=100`, { headers: { Authorization: `Bearer ${RT}` } });
  for (const it of await r.json()) { const ev = it.envVar || it; if (ev.key === 'JWT_SECRET' && ev.value) return ev.value; }
  throw new Error('no prod JWT_SECRET');
}
const SECRET = await prodSecret();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const id = uuid();
const email = `e2etest-grammar-${Date.now()}@example.com`;
await pool.query(
  `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed, onboarding_status, email_verified)
   VALUES ($1, $2, 'Grammar Probe', 'Grammar', 'Probe', 'active', 'member', false, false, 'not_started', true)`,
  [id, email]
);
console.log('USER:', email);

const claims = { sub: id, email, role: 'member', displayName: 'Grammar Probe', sessionId: uuid() };
const access = jwt.sign(claims, SECRET, { expiresIn: '2h' });
const refresh = jwt.sign({ sub: id, sessionId: claims.sessionId, type: 'refresh' }, SECRET, { expiresIn: '1d' });

const failures = [];
const check = (ok, label) => { console.log(`${ok ? '  ✓' : '  ✗'} ${label}`); if (!ok) failures.push(label); };

const browser = await chromium.launch({ headless: false });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  await ctx.addInitScript((t) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
  }, { a: access, r: refresh });
  const page = await ctx.newPage();

  await page.goto(`${APP}/onboarding`, { waitUntil: 'domcontentloaded' });

  // No LinkedIn URL on file -> asklink stage. Skip into the honest chat path.
  await page.getByText('Skip for now').waitFor({ state: 'visible', timeout: 30_000 });
  check(true, 'asklink stage shown for URL-less member');
  await page.getByText('Skip for now').click();

  const inputBox = page.getByLabel('Your answer');
  await inputBox.waitFor({ state: 'visible', timeout: 60_000 });
  check(true, 'chat opened after skip');

  const card = page.locator('aside');
  async function answer(text, expectOnCard, label) {
    await inputBox.fill(text);
    await page.getByLabel('Send').click();
    // Host reply lands, then the decoupled /profile call fills the card.
    if (expectOnCard) {
      const re = new RegExp(expectOnCard, 'i');
      const ok = await page
        .waitForFunction(
          ({ re }) => {
            const el = document.querySelector('aside');
            return el && new RegExp(re, 'i').test(el.innerText);
          },
          { re: expectOnCard },
          { timeout: 45_000 }
        )
        .then(() => true)
        .catch(() => false);
      check(ok, label);
      if (!ok) console.log('    card text was:', (await card.innerText().catch(() => '<none>')).replace(/\n/g, ' | ').slice(0, 200));
    } else {
      await wait(4000);
    }
  }

  await answer('I build software and applications for clients.', 'software', 'card populated after answer 1 (software)');
  await answer('I want to meet early stage investors and funding companies for a business idea.', 'investor', 'card populated after answer 2 (investors)');
  await answer('I can offer development. I build web and mobile apps for other members.', 'development|web|mobile', 'card populated after answer 3 (offers)');

  // Drive to the confirm block; nudge with "I'm done" if the host keeps asking.
  const confirmBlock = page.getByText('Should we use this for your matching?');
  let confirmVisible = await confirmBlock.waitFor({ state: 'visible', timeout: 25_000 }).then(() => true).catch(() => false);
  if (!confirmVisible) {
    await page.getByText("I'm done").click().catch(() => {});
    confirmVisible = await confirmBlock.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true).catch(() => false);
  }
  check(confirmVisible, 'confirm block reached');
  await page.screenshot({ path: 'grammar-smoke-confirm.png' });

  await page.getByRole('button', { name: 'Yes, use this' }).click();
  // Success = we leave /onboarding for the app; failure = the form fallback.
  const left = await page.waitForURL((u) => !u.pathname.startsWith('/onboarding'), { timeout: 90_000 }).then(() => true).catch(() => false);
  const formShown = await page.getByText('About You').isVisible().catch(() => false);
  check(left && !formShown, 'confirm completed onboarding (no form fallback)');
  await page.screenshot({ path: 'grammar-smoke-done.png' });
} finally {
  await browser.close();
}

// ── DB truth ────────────────────────────────────────────────────────────────
const u = await pool.query('SELECT onboarding_status, onboarding_completed FROM users WHERE id = $1', [id]);
check(u.rows[0]?.onboarding_status === 'completed', `users.onboarding_status = completed (got ${u.rows[0]?.onboarding_status})`);

const p = await pool.query(
  `SELECT matching_intent IS NOT NULL AS has_intent,
          COALESCE(jsonb_array_length(onboarding_conversation), 0) AS turns,
          profile_summary
   FROM user_intent_profiles WHERE user_id = $1`, [id]
);
check(!!p.rows[0]?.has_intent, 'matching intent persisted');
check((p.rows[0]?.turns ?? 0) > 0, `transcript persisted (turns=${p.rows[0]?.turns})`);
console.log('  summary:', (p.rows[0]?.profile_summary || '').slice(0, 100));

const ev = await pool.query(
  `SELECT stage, COUNT(*)::int AS n FROM onboarding_stage_events WHERE user_id = $1 GROUP BY stage ORDER BY stage`, [id]
);
const stages = Object.fromEntries(ev.rows.map((r) => [r.stage, r.n]));
console.log('  stage events:', JSON.stringify(stages));
check(!stages.extract_failed, 'zero extract_failed events');
check(!!stages.confirmed, 'confirmed stage event recorded');

// ── Cleanup ─────────────────────────────────────────────────────────────────
await pool.query('DELETE FROM onboarding_stage_events WHERE user_id = $1', [id]);
await pool.query('DELETE FROM user_intent_profiles WHERE user_id = $1', [id]);
await pool.query('DELETE FROM users WHERE id = $1', [id]);
await pool.end();
console.log(failures.length ? `SMOKE FAILED: ${failures.length} failure(s)` : 'SMOKE PASSED');
process.exit(failures.length ? 1 : 0);
