import { test, expect, chromium } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, gotoRetry, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// 14 Sep 2026 (Shradha): a cached ScrapingDog payload with no headline, no
// role and no About (confidence 0.7) was reflected as "found" by every path
// that reads the cache, while the live path had called it partial. On
// production: a member whose fresh cache is hollow asks /onboarding/enrich
// and is told partial; a member whose cache is full is still told found.

const URL = 'https://www.linkedin.com/in/e2e-hollow-cache';
const blob = (profile: Record<string, unknown>, confidence: number) => ({
  profile: {
    fullName: 'Hollow Cache', headline: null, currentRole: null, currentCompany: null, industry: null, location: null,
    summary: null, pastRoles: [], education: [], skills: [], likelyWantsToMeet: [], likelyOffers: [],
    conversationStarters: [], questionsToVerify: [], linkedinUrl: URL, photoUrl: null, ...profile,
  },
  confidence, sources: ['scrapingdog:e2e-hollow-cache'], foundLinkedinUrl: URL, requestedLinkedinUrl: URL,
  enrichedAt: new Date().toISOString(), provider: 'scrapingdog',
});

const users: TestUser[] = [];
test.afterAll(async () => {
  await cleanup(pool, { ids: users.map((u) => u.id) });
});

async function seeded(name: string, enriched: unknown): Promise<TestUser> {
  const u = await createTestUser(name, 'member', 'not_started');
  users.push(u);
  // A saved title or company wins over the page (rightly), so the fixture must hold none.
  await pool.query(`UPDATE users SET linkedin_url = $2, onboarding_completed = false, job_title = NULL, company = NULL, bio = NULL, industry = NULL WHERE id = $1`, [u.id, URL]);
  await pool.query(
    `INSERT INTO user_intent_profiles (user_id, inferred_profile, enrichment_status, enrichment_source, enrichment_completed_at, updated_at)
       VALUES ($1, jsonb_build_object('enriched', $2::jsonb), 'found', 'scrapingdog', NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET inferred_profile = jsonb_build_object('enriched', $2::jsonb), enrichment_status = 'found', updated_at = NOW()`,
    [u.id, JSON.stringify(enriched)]);
  return u;
}

async function enrich(u: TestUser) {
  const r = await fetch(`${SERVER}/api/onboarding/enrich`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: JSON.stringify({ linkedinUrl: URL }),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

test('a hollow cached profile is reported as partial, a full one as found', async () => {
  test.setTimeout(120_000);
  const hollow = await seeded('hollowcache', blob({ headline: '', currentRole: '', currentCompany: 'Raw Speed Networking | RSN' }, 0.7));
  const full = await seeded('fullcache', blob({ headline: 'Writer at VOKT', currentRole: 'Writer', currentCompany: 'VOKT' }, 0.95));

  const h = await enrich(hollow);
  expect(h.status, JSON.stringify(h.json)).toBe(200);
  expect(h.json.data.status).toBe('partial');

  const f = await enrich(full);
  expect(f.status, JSON.stringify(f.json)).toBe(200);
  expect(f.json.data.status).toBe('found');

  // The orchestrator's own cache reflect (fired by the same call) lands the same verdict.
  await expect.poll(async () =>
    (await pool.query(`SELECT enrichment_status::text s FROM user_intent_profiles WHERE user_id = $1`, [hollow.id])).rows[0]?.s,
    { timeout: 30_000 }).toBe('partial');
  await expect.poll(async () =>
    (await pool.query(`SELECT enrichment_status::text s FROM user_intent_profiles WHERE user_id = $1`, [full.id])).rows[0]?.s,
    { timeout: 30_000 }).toBe('found');
  console.log(`  hollow → ${h.json.data.status} | full → ${f.json.data.status}`);
});

// 14 Sep 2026 (Ali: "for those it cannot get the role can be empty and user
// can edit that"). A member whose page gave no role sees the Role row say so
// and can add it; a role read out of the rest of the page is labelled a guess.
test('the card says the role is not on the page and lets the member add it; an inferred role is labelled a guess', async () => {
  test.setTimeout(180_000);
  const noRole = await seeded('norole', blob({ headline: '', currentRole: '', currentCompany: 'Vokt', summary: 'Businesses today have more tools than ever…' }, 0.7));
  const guessed = await seeded('guessedrole', blob({ headline: '', currentRole: 'Head of Business Development', roleSource: 'inferred', currentCompany: 'Vokt', summary: 'x' }, 0.7));
  const browser = await chromium.launch({ headless: false });
  try {
    for (const [u, expectText] of [[noRole, 'Not on your LinkedIn page'], [guessed, 'a guess, fix if wrong']] as const) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx.addInitScript((t: { a: string; r: string }) => {
        localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
      }, { a: u.accessToken, r: u.refreshToken });
      await primePreview(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', () => {});
      await gotoRetry(page, `${APP}/onboarding`);
      await expect(page.getByRole('button', { name: /Yes, continue/i })).toBeVisible({ timeout: 90_000 });
      const body = (await page.locator('body').textContent()) || '';
      expect(body, expectText).toContain(expectText);
      await page.screenshot({ path: `shots/card-role-${u === noRole ? 'empty' : 'guessed'}.png`, fullPage: true }).catch(() => {});
      console.log(`  ${u === noRole ? 'no role' : 'inferred role'}: "${expectText}" shown`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
