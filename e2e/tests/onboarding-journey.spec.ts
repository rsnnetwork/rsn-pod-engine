import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// THE WHOLE ONBOARDING, IN THE BROWSER, ON PRODUCTION, WITH THE REAL MODEL.
//
// 10 Sep 2026 (Claus): the host holds a short spoken-style conversation on
// three OPEN questions. The opening is universal and fixed, in Claus's words;
// the second and third are adaptive. The host never asks the member to
// describe their profile or to list who they want to meet: the profile,
// wishes and desires are READ out of the answers. This spec talks like Claus's
// own example ("I recently sold my company and I'm trying to figure out what
// to build next") and checks what a member would see, plus what came out the
// other end: a completed member with a seeded agent built from INFERRED wants.
//
// Costs a few cents of Anthropic credit per run. A 503 anywhere means the
// prepaid balance is empty again.

let browser: Browser;
let member: TestUser;
let known: TestUser; // a member whose card already holds a reason and a company
const ctxs: BrowserContext[] = [];

const OPENING_QUESTION = "We believe you're here for a reason. Do you mind sharing what brought you here?";
const KNOWN_LEAD = "We've already put together a first version of your profile. But before we get into that, we'd rather hear from you.";
const NOT_FOUND = 'We could not identify your profile, so let us build it together.';

const bubbles = (page: Page) => page.locator('.whitespace-pre-wrap');

/** What every host turn must look like under Claus's model. */
function expectHostTurn(reply: string, label: string) {
  const r = reply.trim();
  const questions = (r.match(/\?/g) || []).length;
  expect(questions, `${label}: exactly one question`).toBe(1);
  expect(r.split(/\s+/).length, `${label}: short enough to read`).toBeLessThanOrEqual(45);
  expect(r, `${label}: never asks them to list who they want to meet`).not.toMatch(/who (do|would) you (want|like) to meet/i);
  expect(r, `${label}: never asks them to describe what they offer`).not.toMatch(/what can you (offer|help)/i);
  expect(r, `${label}: never reads the answer back`).not.toMatch(/^(so you|you're |you are |you want |sounds like|it sounds like)/i);
  expect(r, `${label}: no dashes`).not.toMatch(/[—–]/);
}

async function say(page: Page, text: string, label: string) {
  const before = await bubbles(page).count();
  const box = page.locator('textarea[aria-label="Your answer"]');
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  // My bubble, then the host's reply: two more than before.
  await expect(bubbles(page)).toHaveCount(before + 2, { timeout: 60_000 });
  const reply = (await bubbles(page).last().textContent()) || '';
  if (reply.includes('503') || /unavailable right now/i.test(reply)) {
    throw new Error('the host answered with the LLM-disabled fallback: Anthropic balance empty?');
  }
  console.log(`  MEMBER: ${text}\n  HOST:   ${reply.trim()}`);
  const done = await page.getByRole('button', { name: /Yes, use this/i }).isVisible().catch(() => false);
  if (!done) expectHostTurn(reply, label);
  return reply;
}

test.beforeAll(async () => {
  member = await createTestUser('journey', 'member', 'not_started');
  await pool.query(
    `UPDATE users SET onboarding_completed = false, company = NULL, job_title = NULL, bio = NULL,
       industry = NULL, location = NULL, linkedin_url = NULL WHERE id = $1`,
    [member.id]);
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  const ids = [member?.id, known?.id].filter(Boolean);
  await pool.query(`DELETE FROM agent_matches WHERE agent_id IN (SELECT id FROM matching_agents WHERE user_id = ANY($1))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM matching_agents WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  await cleanupByPrefix(pool, 'e2etest-journey');
});

test('a member with a profile on file hears the universal opening, then an adaptive second question', async () => {
  test.setTimeout(300_000);
  known = await createTestUser('journeyknown', 'member', 'not_started');
  await pool.query(
    `UPDATE users SET onboarding_completed = false, company = 'Fjord Analytics', job_title = NULL, bio = NULL,
       industry = NULL, location = NULL, linkedin_url = NULL, why_i_want_to_meet = 'because i want to meet recruiters'
     WHERE id = $1`, [known.id]);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: known.accessToken, r: known.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/onboarding`);

  // No LinkedIn: the ask screen, skip; company on file settles the card; accept it.
  await expect(page.locator('input[aria-label="Your LinkedIn URL"]')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Skip for now/i }).click();
  const cont = page.getByRole('button', { name: /Yes, continue/i });
  await expect(cont).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('because i want to meet recruiters')).toBeVisible();
  await cont.click();

  // Claus: the opening is universal, in his words, even when a reason is on file.
  await expect(bubbles(page).first()).toBeVisible({ timeout: 60_000 });
  const opening = ((await bubbles(page).first().textContent()) || '').trim();
  console.log(`  HOST (profile known): ${opening}`);
  expect(opening).toBe(`${KNOWN_LEAD} ${OPENING_QUESTION}`);
  await expect(bubbles(page)).toHaveCount(1);

  // The second question adapts to the answer; it is not the default read out.
  const second = await say(page, "I recently sold my company and I'm trying to figure out what I want to build next.", 'second question');
  expect(second.trim()).not.toBe("What's taking up your attention these days?");
});

test('a new member talks through three open questions, confirms, and lands on Suggestions with an agent built from what they said', async () => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: member.accessToken, r: member.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});

  // The gate sends a not-started member here from anywhere.
  await gotoRetry(page, `${APP}/`);
  await expect(page).toHaveURL(/\/onboarding/, { timeout: 30_000 });

  // No LinkedIn on file: the ask screen, then skip into the chat.
  await expect(page.locator('input[aria-label="Your LinkedIn URL"]')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Skip for now/i }).click();
  await expect(bubbles(page).first()).toBeVisible({ timeout: 60_000 });
  const opening = ((await bubbles(page).first().textContent()) || '').trim();
  console.log(`  HOST:   ${opening}`);
  expect(opening).toBe(`${NOT_FOUND} ${OPENING_QUESTION}`);

  // Claus's example member. Never told who they want to meet in so many words.
  await say(page, "I recently sold my fintech company in Copenhagen and I'm trying to figure out what I want to build next.", 'turn 1');
  await say(page, "Mostly the question of whether to start again or join an early team as an operator. I keep getting pulled into climate.", 'turn 2');
  await say(page, "A couple of honest conversations with people who have done a second company, and maybe one person who would back it early.", 'turn 3');

  // Wrap up. The first press is soft (the host may ask the value question once
  // if it is still open); press until the confirm box appears.
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
  // The whole chat stayed inside the budget: at most six host turns.
  const hostTurns = await bubbles(page).evaluateAll((els) => els.filter((e) => !e.closest('[data-from="me"]')).length);
  expect(hostTurns, 'host turns incl. the opening and the summary').toBeLessThanOrEqual(8);
  await confirmBtn.click();

  // Land on Suggestions with an agent named.
  await expect(page).toHaveURL(/\/agents/, { timeout: 60_000 });
  const toast = page.getByText(/searching now/i).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  console.log(`  TOAST:  ${((await toast.textContent()) || '').trim()}`);

  // The profile was READ, not asked: wants and offers inferred from the answers.
  const u = await pool.query(
    `SELECT onboarding_status::text s, onboarding_completed c, who_i_want_to_meet w, why_i_want_to_meet y, what_i_can_help_with h
       FROM users WHERE id = $1`, [member.id]);
  expect(u.rows[0].s).toBe('completed');
  expect(u.rows[0].c).toBe(true);
  expect(u.rows[0].w, 'who they want to meet was inferred').toBeTruthy();
  expect(u.rows[0].y, 'why they are here, in their words').toBeTruthy();
  console.log(`  READ:   wants="${u.rows[0].w}" | why="${u.rows[0].y}" | offers="${u.rows[0].h}"`);

  const rows = await pool.query(`SELECT id, label, status, last_matched_at FROM matching_agents WHERE user_id = $1 ORDER BY created_at`, [member.id]);
  expect(rows.rows.length).toBeGreaterThan(0);
  expect(rows.rows.filter(r => r.status === 'active').length, 'exactly one main agent').toBe(1);
  for (const a of rows.rows) {
    if (a.status === 'active') expect(a.last_matched_at, `${a.label} has searched`).not.toBeNull();
    await expect(page.getByTestId(`agent-${a.id}`)).toBeVisible({ timeout: 30_000 });
  }
  console.log(`  AGENTS: ${rows.rows.map(r => `${r.label} [${r.status}]`).join(' | ')}`);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 390px').toBeLessThanOrEqual(0);
});
