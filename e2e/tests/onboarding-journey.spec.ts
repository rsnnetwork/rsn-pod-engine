import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// THE WHOLE ONBOARDING, IN THE BROWSER, ON PRODUCTION (3 Sep 2026).
//
// Every other onboarding spec either stubs the status or drives the API. This
// one does what a new member does on a phone: lands on /onboarding, skips the
// LinkedIn ask, types three answers into the real chat against the real
// model, presses "I'm done", presses "Yes, use this", and must land on
// Suggestions with a toast naming the agents that were just built (B2's
// client half) and those agents rendered on the page.
//
// Costs a few cents of Anthropic credit per run. A 503 anywhere means the
// prepaid balance is empty again.

let browser: Browser;
let member: TestUser;
const ctxs: BrowserContext[] = [];

const bubbles = (page: Page) => page.locator('.whitespace-pre-wrap');

async function say(page: Page, text: string) {
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
  try { await browser?.close(); } catch {}
  const ids = [member?.id].filter(Boolean);
  await pool.query(`DELETE FROM agent_matches WHERE agent_id IN (SELECT id FROM matching_agents WHERE user_id = ANY($1))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM matching_agents WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  await cleanupByPrefix(pool, 'e2etest-journey');
});

test('a new member chats, confirms, and lands on Suggestions with their agents named and rendered', async () => {
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
  await expect(bubbles(page).first()).toBeVisible({ timeout: 30_000 });
  console.log(`  HOST:   ${((await bubbles(page).first().textContent()) || '').trim()}`);

  await say(page, 'I run a small fintech startup in Copenhagen, eight people, invoicing for freelancers.');
  await say(page, 'I want to meet senior React developers who have shipped consumer products, and maybe an angel investor who knows Nordic fintech.');
  await say(page, 'I can help others with pricing and with landing their first hundred paying customers.');

  // Wrap up. The first press is soft (the host may ask one last, skippable
  // thing); press until the confirm box appears.
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
  await confirmBtn.click();

  // B2's client half: land on Suggestions with the agents named.
  await expect(page).toHaveURL(/\/agents/, { timeout: 60_000 });
  const toast = page.getByText(/searching now/i).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  const toastText = (await toast.textContent()) || '';
  console.log(`  TOAST:  ${toastText.trim()}`);
  expect(toastText).toMatch(/Developers|Investors/);

  // And the agents are real: rows, searched, rendered.
  const rows = await pool.query(`SELECT id, label, last_matched_at FROM matching_agents WHERE user_id = $1 ORDER BY created_at`, [member.id]);
  expect(rows.rows.length).toBeGreaterThan(0);
  for (const a of rows.rows) {
    expect(a.last_matched_at, `${a.label} has searched`).not.toBeNull();
    await expect(page.getByTestId(`agent-${a.id}`)).toBeVisible({ timeout: 30_000 });
  }
  console.log(`  AGENTS: ${rows.rows.map(r => r.label).join(' | ')}`);

  // The gate is open now: the member is completed and not sent back.
  const u = await pool.query(`SELECT onboarding_status::text s, onboarding_completed c FROM users WHERE id = $1`, [member.id]);
  expect(u.rows[0]).toEqual({ s: 'completed', c: true });

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 390px').toBeLessThanOrEqual(0);
});
