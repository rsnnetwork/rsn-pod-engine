import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// THE FIRST AGENT (13 Aug 2026 meeting, Task B2).
//
// "First agent isn't auto-creating after onboarding as it should." A member who
// finished the chat landed on an empty Suggestions page having just described,
// in detail, exactly who they want to meet. This drives the real completion
// endpoint — POST /onboarding/confirm, real Anthropic extraction — and asserts
// OUTCOMES: rows in matching_agents, a search that has actually run, and the
// agent rendered on the page the member lands on. A 503 here means the LLM is
// off or the prepaid Anthropic key is empty; the test says so rather than
// passing vacuously.
//
// Self-contained on purpose (helpers copied, not shared) like the other specs.

let browser: Browser;
let fresh: TestUser;      // brand-new member, never onboarded
let returning: TestUser;  // re-onboarding under migration 083, already holds a Founders agent
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string, viewport = { width: 390, height: 844 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

/** Drive the completion endpoint the way the client does: the transcript minus the opening. */
async function confirm(u: TestUser, memberSaid: string) {
  const r = await apiAs(u, 'POST', '/onboarding/confirm', {
    messages: [
      { role: 'assistant', content: 'What brings you to Reason?' },
      { role: 'user', content: memberSaid },
      { role: 'assistant', content: 'Thank you. I have what I need.' },
      { role: 'user', content: 'Let us wrap up now.' },
    ],
  });
  if (r.status === 503) {
    throw new Error('POST /onboarding/confirm answered 503 LLM_DISABLED — the Anthropic key is off or its prepaid balance is empty. Top up before Monday; this test cannot pass without it.');
  }
  return r;
}

const agentsOf = (u: TestUser) =>
  pool.query(`SELECT id, label, want_text, status, last_matched_at FROM matching_agents WHERE user_id = $1 ORDER BY created_at`, [u.id]);

test.beforeAll(async () => {
  fresh = await createTestUser('firstAgentFresh', 'member', 'not_started');
  await pool.query(`UPDATE users SET onboarding_completed = false WHERE id = $1`, [fresh.id]);

  returning = await createTestUser('firstAgentBack', 'member', 'update_required');
  await pool.query(
    `INSERT INTO matching_agents (user_id, label, want_text, status) VALUES ($1, 'Founders', 'founders and co-founders', 'active')`,
    [returning.id]);

  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [fresh?.id, returning?.id].filter(Boolean);
  await pool.query(`DELETE FROM agent_matches WHERE agent_id IN (SELECT id FROM matching_agents WHERE user_id = ANY($1))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM matching_agents WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  const swept = await cleanupByPrefix(pool, 'e2etest-firstAgent');
  if (swept) console.log(`  swept ${swept} leftover firstAgent* account(s)`);
});

test('finishing onboarding leaves a new member with a first agent that has already searched, and lands them on it', async () => {
  test.setTimeout(300_000);

  const r = await confirm(fresh,
    'I run a small fintech startup in Copenhagen. I am looking for react developers who can build my product with me, and maybe an angel investor who knows fintech. I can help others with go-to-market and pricing.');
  expect(r.status, `confirm accepted: ${JSON.stringify(r.json)}`).toBe(200);
  expect(r.json.data.firstAgents.length, 'the response names what was made').toBeGreaterThan(0);
  expect(r.json.data.firstAgents.filter((a: any) => a.status === 'active').length, 'the response marks exactly one main agent').toBe(1);

  // Stored, built from what they said. 4 Sep 2026: ONE agent searches now (the
  // first kind of person they named); the rest are paused drafts.
  const rows = (await agentsOf(fresh)).rows;
  expect(rows.length, 'at least one agent row').toBeGreaterThan(0);
  expect(rows.length, 'and not a pile of them').toBeLessThanOrEqual(4);
  const active = rows.filter(x => x.status === 'active');
  const drafts = rows.filter(x => x.status === 'paused');
  expect(active.length, 'exactly one main agent').toBe(1);
  expect(active[0].label, 'the main agent is the first thing they asked for').toMatch(/developer|engineer/i);
  expect(active[0].last_matched_at, 'the main agent has actually searched').not.toBeNull();
  expect(drafts.length, 'the investor they also mentioned waits as a draft').toBeGreaterThanOrEqual(1);
  expect(drafts.map(x => x.label).join(' | ')).toMatch(/investor/i);
  console.log(`  ✓ first agents: ${rows.map(x => `${x.label} [${x.status}] ← "${x.want_text}"`).join('; ')}`);

  // The gate flipped: the member is completed, not sent back into onboarding.
  const u = await pool.query(`SELECT onboarding_status, onboarding_completed FROM users WHERE id = $1`, [fresh.id]);
  expect(u.rows[0]).toMatchObject({ onboarding_status: 'completed', onboarding_completed: true });

  // And it is on the page, not just in the database — the 3 Aug lesson.
  const page = await openAs(fresh, '/agents');
  for (const a of rows) {
    await expect(page.getByTestId(`agent-${a.id}`)).toBeVisible({ timeout: 30_000 });
  }
  // Drafts are visibly paused, with a Resume control the member can press.
  for (const d of drafts) {
    await expect(page.getByTestId(`agent-${d.id}`).getByText('Paused')).toBeVisible();
    await expect(page.getByTestId(`agent-${d.id}`).getByRole('button', { name: 'Resume agent' })).toBeVisible();
  }
  await expect(page.getByTestId(`agent-${active[0].id}`).getByText('Paused')).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents/);
  console.log('  ✓ agents rendered on /agents for the new member: one searching, drafts paused.');

  // Resuming a draft is one tap, and it starts searching.
  if (drafts.length) {
    await page.getByTestId(`agent-${drafts[0].id}`).getByRole('button', { name: 'Resume agent' }).click();
    await expect(page.getByTestId(`agent-${drafts[0].id}`).getByText('Paused')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () =>
      (await pool.query(`SELECT status, last_matched_at FROM matching_agents WHERE id = $1`, [drafts[0].id])).rows[0],
      { timeout: 60_000 }).toMatchObject({ status: 'active' });
    console.log('  ✓ a draft resumed from the page is active again.');
  }

  // 360px floor: the landing page fits a small phone.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByTestId(`agent-${rows[0].id}`)).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 360px').toBeLessThanOrEqual(0);
});

test('a member re-onboarding under 083 keeps the agent they had and gains only what is new', async () => {
  test.setTimeout(300_000);
  const before = (await agentsOf(returning)).rows;
  expect(before.map(x => x.label)).toEqual(['Founders']);
  const keptId = before[0].id;

  const r = await confirm(returning,
    'I am a climate-tech operator. I want to meet founders and investors who back early-stage climate companies.');
  expect(r.status, `confirm accepted: ${JSON.stringify(r.json)}`).toBe(200);

  const after = (await agentsOf(returning)).rows;
  const founders = after.filter(x => /^founders$/i.test(x.label));
  expect(founders.length, 'exactly one Founders agent, never a duplicate').toBe(1);
  expect(founders[0].id, 'and it is the one they already had').toBe(keptId);

  const labels = after.map(x => x.label.toLowerCase());
  expect(new Set(labels).size, 'no duplicate labels at all').toBe(labels.length);
  const gained = r.json.data.firstAgents.map((a: { label: string }) => a.label);
  expect(gained, 'Founders was not re-made').not.toContain('Founders');
  console.log(`  ✓ returning member: kept Founders (${keptId.slice(0, 8)}), gained ${gained.length ? gained.join(', ') : 'nothing new'}.`);
});

test('the Suggestions badge and dashboard tile count the first agent from anywhere', async () => {
  test.setTimeout(240_000);
  const rows = (await agentsOf(fresh)).rows;
  test.skip(rows.length === 0, 'first test did not create an agent');
  const matches = await pool.query(
    `SELECT COUNT(*)::int n FROM agent_matches WHERE agent_id = ANY($1)`, [rows.map(x => x.id)]);
  const expected = matches.rows[0].n;

  const page = await openAs(fresh, '/');
  const tile = page.getByTestId('tile-suggestions');
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await expect(tile).toContainText(String(expected));
  if (expected > 0) {
    await expect(page.getByTestId('nav-suggestions-badge').first()).toHaveText(String(expected));
  }
  console.log(`  ✓ dashboard tile shows ${expected} suggestion(s) for the new member.`);
});
