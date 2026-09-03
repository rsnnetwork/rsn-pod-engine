import { test, chromium, Browser, BrowserContext } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// Evidence shots for the 13 Aug overhaul report. Opt-in only (SHOTS=1), so a
// normal run never spends time on it. Writes PNGs to e2e/shots/.

test.skip(!process.env.SHOTS, 'set SHOTS=1 to capture report screenshots');

let browser: Browser;
let viewer: TestUser;
let subject: TestUser;
const ctxs: BrowserContext[] = [];

async function shot(u: TestUser, path: string, width: number, name: string, before?: (p: any) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}${path}`);
  await page.waitForTimeout(1500);
  if (before) await before(page);
  await page.screenshot({ path: `shots/${name}.png`, fullPage: true });
  await ctx.close();
}

test.beforeAll(async () => {
  viewer = await createTestUser('shotsviewer');
  subject = await createTestUser('shotssubject');
  await pool.query(
    `UPDATE users SET display_name = $2, job_title = $3, company = $4, location = $5, bio = $6,
       expertise_text = $7, who_i_want_to_meet = $8, interests = $9, reasons_to_connect = $10,
       what_i_care_about = $11, what_i_can_help_with = $12 WHERE id = $1`,
    [subject.id, 'Astrid Lindqvist', 'Head of Product', 'Fjord Analytics', 'Copenhagen',
     'I run product at a small analytics company that helps mid-sized manufacturers see their energy use in real time. Before this I spent six years in consulting, which taught me how much of a company\'s decision-making happens on the strength of one slide. I am here to meet operators who have taken a product from a handful of pilots to a repeatable sale, and I am happy to trade notes on pricing, onboarding and the unglamorous parts of B2B.',
     'product strategy, pricing, B2B onboarding', 'operators who have scaled a B2B product past its first ten customers',
     ['Energy', 'Manufacturing', 'Product'], ['Find Co-founder', 'Expand Network'],
     'Products that make invisible costs visible', 'Pricing, onboarding flows, and running a small product team']);
  browser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [viewer?.id, subject?.id].filter(Boolean) });
  await cleanupByPrefix(pool, 'e2etest-shots');
});

test('capture', async () => {
  test.setTimeout(240_000);
  await shot(viewer, `/profile/${subject.id}`, 390, 'profile-card-390');
  await shot(viewer, `/profile/${subject.id}`, 1280, 'profile-card-1280');
  await shot(viewer, '/search', 390, 'search-390', async (p) => {
    await p.getByPlaceholder(/Search people/i).fill('Astrid');
    await p.getByTestId(`search-result-${subject.id}`).waitFor({ timeout: 30_000 });
  });
  await shot(viewer, '/', 390, 'dashboard-390');
  await shot(viewer, '/', 1280, 'dashboard-1280');
});
