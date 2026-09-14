import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, cleanupByPrefix, SERVER } from '../helpers/live-ui';

// THE RECENT PAGE, NOT SCRAPINGDOG'S OLD COPY (14 Sep 2026, Ali: "get all
// info which is available on the LinkedIn page and the recent one"). Shradha's
// slug: ScrapingDog's cached copy still said RSN while her page said Vokt. A
// live scrape (a linkId with its casing changed misses their cache) says
// Vokt. On production: a join request with her slug, approved, must preload
// the live page: Vokt as the current company, and the page's certifications
// and volunteering carried as highlights. API only, no browser.

const LINKEDIN = 'https://www.linkedin.com/in/shradhadhikari';
let admin: TestUser;
let email = '';

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test.beforeAll(async () => {
  admin = await createTestUser('freshadmin', 'super_admin');
  email = `e2etest-fresh-${Date.now()}@example.com`;
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM magic_links WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
  await pool.query(`DELETE FROM join_requests WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
  await cleanup(pool, { ids: [admin?.id].filter(Boolean) });
  await cleanupByPrefix(pool, 'e2etest-fresh');
});

test('the approval preload reads the live LinkedIn page: the recent company, and the whole page', async () => {
  test.setTimeout(420_000);

  const jr = await api('POST', '/join-requests', { fullName: 'Shradha Adhikari', email, linkedinUrl: LINKEDIN, reason: 'checking the live page' });
  expect(jr.status, JSON.stringify(jr.json)).toBe(201);
  const requestId = jr.json.data.id;
  const approve = await api('PATCH', `/join-requests/${requestId}/review`, { decision: 'approved' }, admin.accessToken);
  expect(approve.status, JSON.stringify(approve.json)).toBe(200);

  await expect.poll(async () =>
    (await pool.query(`SELECT enriched IS NOT NULL AS done FROM join_requests WHERE id = $1`, [requestId])).rows[0].done,
    { timeout: 300_000, intervals: [5_000] }).toBe(true);
  const e = (await pool.query(`SELECT enriched FROM join_requests WHERE id = $1`, [requestId])).rows[0].enriched;
  const p = e.profile || {};
  console.log(`  company=${p.currentCompany} | role=${p.currentRole} | headline=${p.headline} | about=${String(p.summary || '').slice(0, 80)}\n  sources=${JSON.stringify(e.sources)}\n  certs=${JSON.stringify(p.certifications)}\n  volunteering=${JSON.stringify(p.volunteering)}\n  pastRoles=${JSON.stringify(p.pastRoles)}\n  highlights=${JSON.stringify(p.highlights)}`);

  expect(String(p.currentCompany || ''), 'the live page, not the cached copy').toMatch(/vokt/i);
  expect(e.sources.join(' '), 'the live scrape was the source').toContain(':live');
  expect((p.certifications || []).length, 'certifications carried').toBeGreaterThanOrEqual(3);
  expect((p.volunteering || []).join(' '), 'volunteering carried').toMatch(/Robin Hood Army/i);
  expect((p.highlights || []).join(' '), 'highlights built').toMatch(/Certified/);
  expect(p.pastRoles.join(' '), 'a masked entry is never a past role').not.toMatch(/\*\*\*/);
  expect((p.recommendations || []).length, 'recommendations carried with their text').toBeGreaterThanOrEqual(1);
  expect((p.recommendations || []).join(' '), 'the expanded text, not the collapsed copy').not.toMatch(/Show more|Show less/);
  expect((p.publications || []).join(' '), 'the publication carries its summary').toMatch(/Springer|book chapter/i);
  console.log(`  recommendations=${JSON.stringify(p.recommendations)}\n  publications=${JSON.stringify(p.publications)}`);
});
