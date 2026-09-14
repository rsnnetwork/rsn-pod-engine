import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import crypto from 'node:crypto';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// THE WHOLE MEMBER FLOW, HEADED, ON PRODUCTION, WITH A REAL LINKEDIN (14 Sep
// 2026, Ali: "do the headed prod smokes for users for full flow using some
// random linkedIn"). Public join form → admin approval in the browser (the
// approval preloads the LinkedIn enrichment) → the one-click login link →
// the enrichment card → Claus's chat → confirm → Suggestions with an agent.
// Screenshots at every step under e2e/shots/fullflow/. Costs one ScrapingDog
// scrape and a few cents of Anthropic credit.

const LINKEDIN = 'https://www.linkedin.com/in/williamhgates/';
const FULL_NAME = 'Bill Gates';
const SHOTS = 'shots/fullflow';

let browser: Browser;
let admin: TestUser;
let email = '';
let userId = '';
let requestId = '';
const ctxs: BrowserContext[] = [];
let shotNo = 0;
async function shot(page: Page, name: string) {
  shotNo += 1;
  await page.screenshot({ path: `${SHOTS}/${String(shotNo).padStart(2, '0')}-${name}.png`, fullPage: true }).catch(() => {});
}
const bubbles = (page: Page) => page.locator('.whitespace-pre-wrap');

async function say(page: Page, text: string) {
  const before = await bubbles(page).count();
  const box = page.locator('textarea[aria-label="Your answer"]');
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(bubbles(page)).toHaveCount(before + 2, { timeout: 60_000 });
  const reply = ((await bubbles(page).last().textContent()) || '').trim();
  if (reply.includes('503') || /unavailable right now/i.test(reply)) throw new Error('LLM-disabled fallback: Anthropic balance empty?');
  console.log(`  MEMBER: ${text}\n  HOST:   ${reply}`);
  return reply;
}

test.beforeAll(async () => {
  admin = await createTestUser('fullflowadmin', 'super_admin');
  email = `e2etest-fullflow-${Date.now()}@example.com`;
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  await pool.query(`DELETE FROM magic_links WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
  await pool.query(`DELETE FROM join_requests WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
  const ids = [admin?.id, userId].filter(Boolean);
  await pool.query(`DELETE FROM agent_matches WHERE agent_id IN (SELECT id FROM matching_agents WHERE user_id = ANY($1))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM matching_agents WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM onboarding_stage_events WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM user_intent_profiles WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  await cleanupByPrefix(pool, 'e2etest-fullflow');
});

test('join request → approval → LinkedIn card → chat → confirm → agent, in the browser', async () => {
  test.setTimeout(900_000);

  // 1. The public join form, on a phone.
  const pub = await browser.newContext({ viewport: { width: 390, height: 844 } });
  ctxs.push(pub);
  await primePreview(pub);
  const form = await pub.newPage();
  await gotoRetry(form, `${APP}/request-to-join`);
  await form.getByPlaceholder('Your full name').fill(FULL_NAME);
  await form.getByPlaceholder('you@example.com').fill(email);
  await form.getByPlaceholder('your-username').fill(LINKEDIN);
  await form.getByPlaceholder(/Tell us about yourself/i).fill('I want to meet founders working on global health and climate, and I can help with strategy and funding.');
  await shot(form, 'join-form-filled');
  await form.locator('button[type="submit"]').click();
  await expect(form.getByText(/Thank you for your interest in RSN/i)).toBeVisible({ timeout: 30_000 });
  await shot(form, 'join-submitted');
  const jr = await pool.query(`SELECT id, status::text, linkedin_url FROM join_requests WHERE lower(email) = $1`, [email.toLowerCase()]);
  expect(jr.rows.length, 'the request is stored').toBe(1);
  requestId = jr.rows[0].id;
  expect(jr.rows[0].status).toBe('pending');
  console.log(`  request ${requestId} stored with ${jr.rows[0].linkedin_url}`);

  // 2. An admin approves it from the admin page.
  const adm = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await adm.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: admin.accessToken, r: admin.refreshToken });
  ctxs.push(adm);
  await primePreview(adm);
  const ap = await adm.newPage();
  await gotoRetry(ap, `${APP}/admin/join-requests`);
  const row = ap.locator('div').filter({ hasText: email }).filter({ has: ap.getByRole('button', { name: /Approve/ }) }).last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await shot(ap, 'admin-pending-request');
  await row.getByRole('button', { name: /^\s*Approve\s*$/ }).click();
  await expect.poll(async () =>
    (await pool.query(`SELECT status::text s FROM join_requests WHERE id = $1`, [requestId])).rows[0].s,
    { timeout: 30_000 }).toBe('approved');
  await shot(ap, 'admin-approved');
  console.log('  approved from the admin page');

  // 3. The approval preloads the LinkedIn enrichment (a real ScrapingDog scrape).
  await expect.poll(async () =>
    (await pool.query(`SELECT enriched IS NOT NULL AS done FROM join_requests WHERE id = $1`, [requestId])).rows[0].done,
    { timeout: 240_000, intervals: [5_000] }).toBe(true);
  const pre = (await pool.query(`SELECT enriched FROM join_requests WHERE id = $1`, [requestId])).rows[0].enriched;
  const p = pre.profile || {};
  console.log(`  preload: confidence ${pre.confidence} | name=${p.fullName} | headline=${p.headline} | role=${p.currentRole} | company=${p.currentCompany} | about=${String(p.summary || '').slice(0, 80)}… | photo=${!!p.photoUrl}`);
  expect(p.fullName, 'the scrape identified the person').toBeTruthy();

  // 4. The one-click link (the real login path for an approved member).
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [email, crypto.createHash('sha256').update(token).digest('hex')]);
  const mem = await browser.newContext({ viewport: { width: 390, height: 844 } });
  ctxs.push(mem);
  await primePreview(mem);
  const page = await mem.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/auth/verify?token=${token}`);
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 60_000 });
  const u = await pool.query(`SELECT id, display_name, linkedin_url FROM users WHERE lower(email) = $1`, [email.toLowerCase()]);
  userId = u.rows[0].id;
  console.log(`  logged in as ${u.rows[0].display_name} (${userId}), linkedin ${u.rows[0].linkedin_url}`);

  // 5. The enrichment card: what we found, to confirm.
  const cont = page.getByRole('button', { name: /Yes, continue/i });
  await expect(cont).toBeVisible({ timeout: 120_000 });
  await shot(page, 'enrichment-card');
  const cardText = (await page.locator('body').textContent()) || '';
  expect(cardText, 'the card carries the name').toContain(FULL_NAME.split(' ')[0]);
  const state = (await pool.query(`SELECT enrichment_status::text s FROM user_intent_profiles WHERE user_id = $1`, [userId])).rows[0];
  console.log(`  card state: ${state?.s} | card text: ${cardText.replace(/\s+/g, ' ').slice(0, 320)}`);
  expect(['found', 'partial'], 'a real profile reads found or partial, never not_found').toContain(state?.s);
  await expect.poll(async () =>
    (await pool.query(`SELECT avatar_blob IS NOT NULL AS b FROM users WHERE id = $1`, [userId])).rows[0].b,
    { timeout: 90_000, intervals: [3_000] }).toBe(true);
  console.log('  photo captured from LinkedIn');
  await cont.click();

  // 6. Claus's chat. The opening acknowledges the profile on file.
  await expect(bubbles(page).first()).toBeVisible({ timeout: 60_000 });
  const opening = ((await bubbles(page).first().textContent()) || '').trim();
  console.log(`  HOST:   ${opening}`);
  expect(opening).toMatch(/already put together a first version of your profile/i);
  await shot(page, 'chat-opening');
  // Shradha's shape on purpose: two one-word answers. The chat gives almost
  // nothing; the LinkedIn result has to make the profile strong on its own.
  await say(page, 'networking');
  await say(page, 'philanthropy');
  const confirmBtn = page.getByRole('button', { name: /Yes, use this/i });
  for (let i = 0; i < 3 && !(await confirmBtn.isVisible().catch(() => false)); i++) {
    const done = page.getByRole('button', { name: /I'm done/i });
    if (await done.isVisible().catch(() => false)) {
      const before = await bubbles(page).count();
      await done.click();
      await expect(bubbles(page)).toHaveCount(before + 2, { timeout: 60_000 });
      console.log(`  (I'm done)\n  HOST:   ${((await bubbles(page).last().textContent()) || '').trim()}`);
    }
  }
  await expect(confirmBtn).toBeVisible({ timeout: 30_000 });
  const closing = ((await bubbles(page).last().textContent()) || '').trim();
  expect(closing, 'the closing is a statement').not.toContain('?');
  await expect(page.locator('textarea[aria-label="Your answer"]')).toHaveCount(0);
  await shot(page, 'chat-closing');
  await confirmBtn.click();

  // 7. Suggestions, with an agent already searching.
  await expect(page).toHaveURL(/\/agents/, { timeout: 60_000 });
  const toast = page.getByText(/searching now/i).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  console.log(`  TOAST:  ${((await toast.textContent()) || '').trim()}`);
  await shot(page, 'agents');
  const agents = await pool.query(`SELECT id, label, want_text, status, last_matched_at FROM matching_agents WHERE user_id = $1 ORDER BY created_at`, [userId]);
  expect(agents.rows.length).toBeGreaterThan(0);
  const active = agents.rows.filter(r => r.status === 'active');
  expect(active.length, 'exactly one main agent').toBe(1);
  expect(active[0].last_matched_at, 'the main agent has searched').not.toBeNull();
  await expect(page.getByTestId(`agent-${active[0].id}`)).toBeVisible({ timeout: 30_000 });
  console.log(`  AGENTS: ${agents.rows.map(r => `${r.label} [${r.status}] "${r.want_text}"`).join(' | ')}`);

  // 8. What landed on the member's record.
  const after = (await pool.query(
    `SELECT onboarding_status::text s, onboarding_completed c, company, job_title, bio, linkedin_url, avatar_url,
            who_i_want_to_meet w, why_i_want_to_meet y FROM users WHERE id = $1`, [userId])).rows[0];
  expect(after.s).toBe('completed');
  expect(after.c).toBe(true);
  expect(after.linkedin_url).toContain('williamhgates');
  expect(after.avatar_url).toBeTruthy();
  const stages = (await pool.query(`SELECT stage::text FROM onboarding_stage_events WHERE user_id = $1 ORDER BY created_at`, [userId])).rows.map(r => r.stage);
  console.log(`  RECORD: company=${after.company} | role=${after.job_title} | bio=${String(after.bio || '').slice(0, 60)}… | wants=${after.w} | why=${after.y}\n  STAGES: ${stages.join(' → ')}`);
  expect(stages).toContain('confirmed');
  expect(stages).toContain('photo_captured');

  // The LinkedIn result made the profile strong despite a two-word chat.
  expect(after.company, 'company from LinkedIn').toMatch(/Gates Foundation/i);
  expect(after.job_title, 'role from LinkedIn').toMatch(/Chair/i);
  expect(String(after.bio || ''), 'About from LinkedIn').toMatch(/Gates Foundation|Breakthrough Energy|Microsoft/i);
  const ip = (await pool.query(`SELECT matching_intent mi, matching_tags t, embedding_text e, profile_summary s FROM user_intent_profiles WHERE user_id = $1`, [userId])).rows[0];
  const mi = ip.mi || {};
  console.log(`  INTENT: role=${mi.userRole} | company=${mi.userCompany} | industry=${mi.userIndustry} | expertise=${JSON.stringify(mi.userExpertise)} | wants=${JSON.stringify(mi.desiredPeople)} | tags=${JSON.stringify(ip.t)}\n  SUMMARY: ${ip.s}\n  EMBED: ${String(ip.e || '').slice(0, 160)}`);
  expect(String(mi.userRole || ''), 'intent role').toMatch(/Chair/i);
  expect(String(mi.userCompany || ''), 'intent company').toMatch(/Gates Foundation/i);
  expect(String(ip.s || ip.e || ''), 'a summary or embedding text exists').not.toBe('');
  expect((mi.userExpertise || []).length + (ip.t || []).length, 'expertise or tags carried from LinkedIn').toBeGreaterThan(2);

  // Mobile floor: no sideways scroll on the page they land on.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 390px').toBeLessThanOrEqual(0);
});
