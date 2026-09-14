import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, SERVER } from '../helpers/live-ui';

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
  await pool.query(`UPDATE users SET linkedin_url = $2, onboarding_completed = false WHERE id = $1`, [u.id, URL]);
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
