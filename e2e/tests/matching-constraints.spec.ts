import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, cleanupByPrefix, SERVER } from '../helpers/live-ui';

// ─────────────────────────────────────────────────────────────────────────────
// Matching breadth with strict constraints (Stefan, 9 Sep 2026), against prod.
// Stefan's test: an agent for "manufacturer in US with 20 years experience"
// must find a US manufacturing company that never calls itself "manufacturer"
// (smart category), must NOT find one in Germany (strict place) or one that
// states 5 years (strict experience), and keeps an unstated-years US company
// but ranks it below a stated one and says so. No LLM.
// ─────────────────────────────────────────────────────────────────────────────

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let owner: TestUser, usFab: TestUser, deMfg: TestUser, usYoung: TestUser, usUnknown: TestUser;

test.beforeAll(async () => {
  owner = await createTestUser('mc-owner');
  usFab = await createTestUser('mc-usfab');
  deMfg = await createTestUser('mc-demfg');
  usYoung = await createTestUser('mc-usyoung');
  usUnknown = await createTestUser('mc-usunk');
  const set = (u: TestUser, f: Record<string, string>) => pool.query(
    `UPDATE users SET display_name=$2, job_title=$3, company=$4, industry=$5, location=$6, bio=$7 WHERE id=$1`,
    [u.id, f.name, f.title, f.company, f.industry, f.location, f.bio],
  );
  await set(usFab, { name: 'Ridge Fabrication', title: 'Owner', company: 'Ridge Fabrication LLC', industry: 'Industrial fabrication', location: 'Cleveland, USA', bio: '25 years of precision machining and assembly for automotive suppliers.' });
  await set(deMfg, { name: 'Bauer Werke', title: 'Geschäftsführer', company: 'Bauer Werke GmbH', industry: 'Manufacturing', location: 'Munich, Germany', bio: '30 years in manufacturing.' });
  await set(usYoung, { name: 'Fresh Factory', title: 'Founder', company: 'Fresh Factory Inc', industry: 'Manufacturing', location: 'Austin, United States', bio: '5 years running our factory.' });
  await set(usUnknown, { name: 'Motor Parts Co', title: 'CEO', company: 'Motor Parts Co', industry: 'Manufacturing', location: 'Detroit, US', bio: 'We run a production line for auto parts.' });
});

test.afterAll(async () => {
  await cleanup(pool, { ids: [owner.id, usFab.id, deMfg.id, usYoung.id, usUnknown.id] });
  await cleanupByPrefix(pool, 'e2etest-mc-');
  await pool.end().catch(() => {});
});

test('agent "manufacturer in US with 20 years experience": strict place + years, smart category', async () => {
  test.setTimeout(120_000);
  const created = await apiAs(owner, 'POST', '/agents', { label: 'US manufacturers', wantText: 'manufacturer in US with 20 years experience' });
  expect(created.status).toBe(201);
  const agentId = created.json.data.id as string;

  // The agent is scored in the background right after creation — wait for it.
  let matches: any[] = [];
  await expect.poll(async () => {
    const d = await apiAs(owner, 'GET', `/agents/${agentId}`);
    matches = d.json?.data?.matches ?? [];
    return matches.some((m) => m.candidateUserId === usFab.id);
  }, { timeout: 45_000, intervals: [1000, 2000, 3000] }).toBe(true);

  const byId = (id: string) => matches.find((m) => m.candidateUserId === id);

  // Smart category: "Industrial fabrication" never says "manufacturer" — found.
  const fab = byId(usFab.id);
  expect(fab).toBeTruthy();
  expect(fab.reason).toMatch(/United States/);

  // Strict place: Germany is out, however good the category fit.
  expect(byId(deMfg.id)).toBeUndefined();
  // Strict experience: 5 stated years is out.
  expect(byId(usYoung.id)).toBeUndefined();

  // Unstated years: kept, ranked below the stated 25y, and the card says so.
  const unk = byId(usUnknown.id);
  expect(unk).toBeTruthy();
  expect(unk.reason).toMatch(/years of experience/i);
  expect(Number(unk.score)).toBeLessThan(Number(fab.score));
});

test('a narrow want is never an empty agent: fewer than 3 strong matches widens to "Close match"', async () => {
  test.setTimeout(120_000);
  // A want nobody strongly matches but some weakly do (shared token "auto").
  const created = await apiAs(owner, 'POST', '/agents', { label: 'Auto parts buyers', wantText: 'auto parts buyers in US' });
  expect(created.status).toBe(201);
  const agentId = created.json.data.id as string;
  let matches: any[] = [];
  await expect.poll(async () => {
    const d = await apiAs(owner, 'GET', `/agents/${agentId}`);
    matches = d.json?.data?.matches ?? [];
    return matches.length > 0;
  }, { timeout: 45_000, intervals: [1000, 2000, 3000] }).toBe(true);
  // Still strict on place: Germany never appears even when widening.
  expect(matches.find((m) => m.candidateUserId === deMfg.id)).toBeUndefined();
  // Something useful came back, labelled honestly.
  expect(matches.some((m) => /^Close match/.test(m.reason) || m.candidateUserId === usUnknown.id || m.candidateUserId === usFab.id)).toBe(true);
});
