import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// WAVE 1 + WAVE 2 — THE EDGES (6 Aug 2026).
//
// The existing specs walk the happy paths. This one walks what happens when a
// member does the wrong thing, the unusual thing, or the same thing twice:
// validation, ownership, self-introduction, declining, asking twice, reaching an
// archived agent by URL, a candidate who deactivates, and the profile's
// meeting-request states.
//
// Every assertion is an OUTCOME (stored row, count, rendered state), never mere
// visibility — a visible element proves nothing about what the server did.

let browser: Browser;
let owner: TestUser, target: TestUser, other: TestUser;
const ctxs: BrowserContext[] = [];
const agentIds: string[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function setProfile(u: TestUser, cols: Record<string, string | string[] | null>) {
  const keys = Object.keys(cols);
  await pool.query(
    `UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [u.id, ...keys.map(k => cols[k])],
  );
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

/** Create an agent through the API and wait for its first search to land. */
async function makeAgent(u: TestUser, label: string, wantText: string): Promise<string> {
  const r = await apiAs(u, 'POST', '/agents', { label, wantText });
  expect(r.status, `creating "${label}"`).toBe(201);
  const id = r.json.data.id;
  agentIds.push(id);
  for (let i = 0; i < 20; i++) {
    const a = await pool.query(`SELECT last_matched_at FROM matching_agents WHERE id = $1`, [id]);
    if (a.rows[0]?.last_matched_at) break;
    await new Promise(res => setTimeout(res, 1500));
  }
  return id;
}

const countOf = async (u: TestUser, id: string) => {
  const r = await apiAs(u, 'GET', '/agents');
  return (r.json?.data ?? []).find((a: any) => a.id === id)?.matchCount ?? -1;
};

test.beforeAll(async () => {
  owner = await createTestUser('edgeOwner');
  target = await createTestUser('edgeTarget');
  other = await createTestUser('edgeOther');
  // A clear, unambiguous developer so the fixtures cannot drift into matching
  // by accident — the "Test Engineer" trap from 5 Aug.
  await setProfile(target, {
    professional_role: ['Developer'], job_title: 'Senior React Developer',
    expertise_text: 'react typescript', what_i_can_help_with: 'building web products',
  });
  await setProfile(other, {
    professional_role: ['Pastry Chef'], job_title: 'Head Pastry Chef',
    expertise_text: 'sourdough croissants',
  });
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [owner?.id, target?.id, other?.id].filter(Boolean);
  await pool.query(`DELETE FROM agent_matches WHERE agent_id = ANY($1)`, [agentIds]).catch(() => {});
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM matching_agents WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  const swept = await cleanupByPrefix(pool, 'e2etest-edge');
  if (swept) console.log(`  swept ${swept} leftover edge* account(s)`);
});

// ─── Validation and ownership ────────────────────────────────────────────────

test('an agent cannot be created empty, from the UI or the API', async () => {
  test.setTimeout(180_000);
  const page = await openAs(owner, '/agents');
  await page.getByRole('button', { name: /Create your first agent|New agent/i }).first().click();

  const start = page.getByRole('button', { name: /Start searching/i });
  await expect(start, 'nothing filled in').toBeDisabled();

  await page.getByLabel('Agent name').fill('   ');
  await page.getByLabel('Who you are looking for').fill('   ');
  await expect(start, 'whitespace is not a name').toBeDisabled();

  await page.getByLabel('Agent name').fill('Developers');
  await expect(start, 'still no want text').toBeDisabled();

  // And the server does not rely on the button being disabled.
  for (const body of [
    { label: '  ', wantText: 'x' },
    { label: 'Developers' },
    { label: 'D'.repeat(200), wantText: 'react developers' },
  ]) {
    const r = await apiAs(owner, 'POST', '/agents', body);
    expect(r.status, `rejected: ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
  }
  console.log('  ✓ empty, whitespace and over-long agents rejected client and server side.');
});

test('one member cannot read or change another member\'s agent', async () => {
  test.setTimeout(180_000);
  const mine = await makeAgent(owner, 'Private', 'react developers');

  expect((await apiAs(other, 'GET', `/agents/${mine}`)).status, 'read').toBe(404);
  expect((await apiAs(other, 'PATCH', `/agents/${mine}`, { wantText: 'anything' })).status, 'edit').toBe(404);
  expect((await apiAs(other, 'POST', `/agents/${mine}/status`, { status: 'archived' })).status, 'archive').toBe(404);
  expect((await apiAs(other, 'POST', `/agents/${mine}/interest`, { userId: target.id })).status, 'introduce').toBe(404);

  const still = await pool.query(`SELECT status, want_text FROM matching_agents WHERE id = $1`, [mine]);
  expect(still.rows[0].status, 'untouched').toBe('active');
  expect(still.rows[0].want_text).toBe('react developers');
  console.log('  ✓ ownership enforced on every verb, and nothing was mutated.');
});

test('an agent cannot introduce you to yourself, or accept a nonsense status', async () => {
  test.setTimeout(180_000);
  const id = await makeAgent(owner, 'SelfCheck', 'react developers');
  expect((await apiAs(owner, 'POST', `/agents/${id}/interest`, { userId: owner.id })).status).toBe(400);
  expect((await apiAs(owner, 'POST', `/agents/${id}/interest`, { userId: 'not-a-uuid' })).status).toBe(400);
  expect((await apiAs(owner, 'POST', `/agents/${id}/status`, { status: 'deleted' })).status).toBe(400);
  console.log('  ✓ self-introduction, bad id and bad status all refused.');
});

// ─── Declining, and asking twice ─────────────────────────────────────────────

test('a decline removes them for good, and a re-search does not bring them back', async () => {
  test.setTimeout(300_000);
  // Its OWN candidate. A decline is global for the pair by design, so declining
  // the shared `target` here would silently poison every later test — which is
  // exactly what happened on the first run of this spec.
  const declinee = await createTestUser('edgeDeclinee');
  await setProfile(declinee, {
    professional_role: ['Developer'], job_title: 'Senior React Developer',
    expertise_text: 'react typescript',
  });
  const id = await makeAgent(owner, 'DeclineCase', 'a senior react developer to build my product');
  expect(await countOf(owner, id), 'the developer was found').toBeGreaterThan(0);

  const intro = await apiAs(owner, 'POST', `/agents/${id}/interest`, { userId: declinee.id });
  expect(intro.status).toBe(201);
  const dec = await apiAs(declinee, 'POST', `/pokes/${intro.json.data.id}/decline`);
  expect(dec.status, 'they decline').toBeLessThan(300);

  // Force a full re-search — the sweep must honour the decline.
  await apiAs(owner, 'POST', `/agents/${id}/status`, { status: 'paused' });
  await apiAs(owner, 'POST', `/agents/${id}/status`, { status: 'active' });
  await new Promise(r => setTimeout(r, 8000));

  const stored = await pool.query(
    `SELECT 1 FROM agent_matches WHERE agent_id = $1 AND candidate_user_id = $2`, [id, declinee.id]);
  expect(stored.rows.length, 'a decline is an answer — gone, and stays gone').toBe(0);

  const page = await openAs(owner, `/agents/${id}`);
  await expect(page.getByTestId(`agent-match-${declinee.id}`)).toHaveCount(0);
  console.log('  ✓ decline honoured in the pool, the store and the screen.');

  await pool.query(`DELETE FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [owner.id, declinee.id]).catch(() => {});
  await cleanup(pool, { ids: [declinee.id] });
});

test('asking the same person twice does not double up or break', async () => {
  test.setTimeout(300_000);
  const id = await makeAgent(owner, 'TwiceCase', 'a senior react developer to build my product');
  expect(await countOf(owner, id)).toBeGreaterThan(0);

  const first = await apiAs(owner, 'POST', `/agents/${id}/interest`, { userId: target.id });
  expect(first.status).toBe(201);
  const second = await apiAs(owner, 'POST', `/agents/${id}/interest`, { userId: target.id });
  // Either answer is defensible; what is NOT defensible is two pending requests.
  expect([200, 201, 400, 409]).toContain(second.status);

  const pending = await pool.query(
    `SELECT COUNT(*)::int AS n FROM user_pokes
      WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'`, [owner.id, target.id]);
  expect(pending.rows[0].n, 'exactly one pending request between them').toBe(1);

  const page = await openAs(owner, `/agents/${id}`);
  await expect(page.getByTestId(`agent-match-${target.id}`)).toHaveCount(1);
  console.log('  ✓ asking twice leaves one request and one card.');
});

// ─── Reaching an archived agent, and a candidate who leaves ──────────────────

test('an archived agent is still reachable by URL and says so', async () => {
  test.setTimeout(240_000);
  const id = await makeAgent(owner, 'Shelved', 'a senior react developer to build my product');
  await apiAs(owner, 'POST', `/agents/${id}/status`, { status: 'archived' });

  // Not on the dashboard...
  const dash = await openAs(owner, '/agents');
  await expect(dash.getByTestId(`agent-${id}`)).toHaveCount(0, { timeout: 30_000 });

  // ...but the URL still works rather than 404ing on the member.
  const page = await openAs(owner, `/agents/${id}`);
  await expect(page.getByRole('heading', { name: 'Shelved' })).toBeVisible({ timeout: 30_000 });
  expect((await apiAs(owner, 'GET', `/agents/${id}`)).status).toBe(200);

  // And an archived agent never quietly starts searching again.
  const before = await pool.query(`SELECT last_matched_at FROM matching_agents WHERE id = $1`, [id]);
  await apiAs(owner, 'GET', '/agents?includeArchived=1');
  await new Promise(r => setTimeout(r, 4000));
  const after = await pool.query(`SELECT last_matched_at, status FROM matching_agents WHERE id = $1`, [id]);
  expect(after.rows[0].status).toBe('archived');
  expect(String(after.rows[0].last_matched_at)).toBe(String(before.rows[0].last_matched_at));
  console.log('  ✓ archived agent readable by URL, still archived, still not searching.');
});

test('a candidate who deactivates leaves both the count and the list', async () => {
  test.setTimeout(300_000);
  const leaver = await createTestUser('edgeLeaver');
  await setProfile(leaver, {
    professional_role: ['Developer'], job_title: 'React Developer',
    expertise_text: 'react typescript',
  });
  const id = await makeAgent(owner, 'Attrition', 'a senior react developer to build my product');

  const before = await countOf(owner, id);
  expect(before, 'the leaver counts while active').toBeGreaterThan(0);
  const listedBefore = await apiAs(owner, 'GET', `/agents/${id}`);
  expect(listedBefore.json.data.matches.map((m: any) => m.candidateUserId)).toContain(leaver.id);

  await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [leaver.id]);

  // The count and the list must agree — they disagreed until 5 Aug, because the
  // count ignored user status while the list filtered on it.
  const after = await countOf(owner, id);
  const listedAfter = await apiAs(owner, 'GET', `/agents/${id}`);
  expect(after, 'dropped from the count').toBe(before - 1);
  expect(listedAfter.json.data.matches.map((m: any) => m.candidateUserId)).not.toContain(leaver.id);
  console.log(`  ✓ deactivation drops them from both: ${before} → ${after}, and off the list.`);

  await pool.query(`DELETE FROM agent_matches WHERE candidate_user_id = $1`, [leaver.id]).catch(() => {});
  await cleanup(pool, { ids: [leaver.id] });
});

// ─── The profile's meeting-request states (Wave 1 follow-up) ─────────────────

test('a profile offers a way through instead of a dead button, and tracks the request', async () => {
  test.setTimeout(300_000);
  // Fresh pair so no request exists between them yet.
  const asker = await createTestUser('edgeAsker');
  const askee = await createTestUser('edgeAskee');
  await setProfile(askee, { professional_role: ['Developer'], job_title: 'React Developer' });

  // 1. Nothing sent yet — the page offers to ask, not a disabled button.
  const page = await openAs(asker, `/profile/${askee.id}`);
  const state = page.getByTestId('meet-state');
  await expect(state).toBeVisible({ timeout: 30_000 });
  await expect(state).toHaveText(/I want to meet/i);
  await expect(state).toBeEnabled();

  // 2. Ask — the state flips and a real request exists.
  await state.click();
  await expect(state).toHaveText(/Meeting request sent/i, { timeout: 30_000 });
  const sent = await pool.query(
    `SELECT status FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [asker.id, askee.id]);
  expect(sent.rows[0]?.status, 'a real pending request, not just a label').toBe('pending');

  // 3. The other side sees that it is waiting on THEM, not on nobody.
  const theirs = await openAs(askee, `/profile/${asker.id}`);
  await expect(theirs.getByTestId('meet-state')).toHaveText(/respond/i, { timeout: 30_000 });

  // 4. A 44px tap target on a phone, per the mobile-first rule.
  const box = await state.boundingBox();
  expect(box!.height, 'tap target').toBeGreaterThanOrEqual(44);
  console.log('  ✓ profile: ask → sent → "respond" on the other side, 44px target.');

  await pool.query(`DELETE FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [asker.id, askee.id]).catch(() => {});
  await cleanup(pool, { ids: [asker.id, askee.id] });
});
