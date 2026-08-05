import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// WAVE 2 — MATCHING AGENTS (3 Aug 2026), driven through the real UI.
//
// Plan: docs/superpowers/plans/2026-08-03-wave2-matching-agents.md
// "RSN is no longer merely matching profiles. It is allowing every person to
//  create active reasons for meeting people, then continually searching the
//  network for those people."
//
// Covers: several concurrent agents with their own counts, create, edit,
// pause/resume, archive, introductions scoped per agent (decision D3), the
// empty state, a member joining later becoming a match automatically, and
// phone + desktop widths.

let browser: Browser;
let owner: TestUser, dev: TestUser, investor: TestUser, chef: TestUser;
const ctxs: BrowserContext[] = [];
const createdAgentIds: string[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function setProfile(u: TestUser, cols: Record<string, string | string[]>) {
  const keys = Object.keys(cols);
  await pool.query(
    `UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [u.id, ...keys.map(k => cols[k])],
  );
}

async function openAs(u: TestUser, path = '/agents', viewport = { width: 390, height: 844 }): Promise<Page> {
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

/** Look an agent up by name, failing loudly with what actually exists. */
async function agentByLabel(u: TestUser, label: string): Promise<any> {
  const r = await apiAs(u, 'GET', '/agents');
  const list = r.json?.data;
  if (!Array.isArray(list)) {
    throw new Error(`GET /agents did not return a list (status ${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
  }
  const found = list.find((a: any) => a.label === label);
  if (!found) {
    throw new Error(`no agent named "${label}". Existing: ${list.map((a: any) => `${a.label}(${a.status})`).join(', ') || 'none'}`);
  }
  return found;
}

/** Poll the API until an agent's stored count settles (scoring is async). */
async function countFor(u: TestUser, agentId: string, timeoutMs = 45_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const r = await apiAs(u, 'GET', '/agents');
    const a = (r.json?.data ?? []).find((x: any) => x.id === agentId);
    last = a?.matchCount ?? -1;
    if (last > 0) return last;
    await new Promise(res => setTimeout(res, 2000));
  }
  return last;
}

/** Read an agent's count once, without waiting for it to become non-zero. */
async function countNow(u: TestUser, agentId: string): Promise<number> {
  const r = await apiAs(u, 'GET', '/agents');
  const a = (r.json?.data ?? []).find((x: any) => x.id === agentId);
  return a?.matchCount ?? -1;
}

test.beforeAll(async () => {
  owner = await createTestUser('agOwner');
  dev = await createTestUser('agDev');
  investor = await createTestUser('agInvestor');
  chef = await createTestUser('agChef');
  await setProfile(dev, {
    professional_role: ['Developer'], job_title: 'Senior React Engineer',
    expertise_text: 'react typescript node', what_i_can_help_with: 'building web products',
  });
  // Set job_title too, not just professional_role: the matcher buckets BOTH,
  // so leaving the factory default in place hands every fixture a second,
  // unintended role.
  await setProfile(investor, {
    professional_role: ['Angel Investor'], job_title: 'Angel Investor',
    expertise_text: 'early stage saas investing',
  });
  await setProfile(chef, {
    professional_role: ['Pastry Chef'], job_title: 'Head Pastry Chef',
    expertise_text: 'sourdough croissants',
  });
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [owner?.id, dev?.id, investor?.id, chef?.id].filter(Boolean);
  await pool.query(`DELETE FROM agent_matches WHERE agent_id = ANY($1)`, [createdAgentIds]).catch(() => {});
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM matching_agents WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  // Belt: users created INSIDE a test (the late joiner, the generalist) are
  // cleaned on that test's last line, which never runs if an assertion above
  // fails. Sweep the whole prefix so nothing is left in the live network.
  const swept = await cleanupByPrefix(pool, 'e2etest-ag');
  if (swept) console.log(`  swept ${swept} leftover ag* test account(s)`);
});

test('a member with no agents is invited to create their first one', async () => {
  test.setTimeout(120_000);
  const page = await openAs(owner);
  await expect(page.getByText(/You have no agents yet/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Create your first agent/i })).toBeVisible();
  console.log('  ✓ empty state invites the first agent.');
});

test('creating an agent from the UI starts a search and shows a real count', async () => {
  test.setTimeout(240_000);
  const page = await openAs(owner);
  await page.getByRole('button', { name: /Create your first agent|New agent/i }).first().click();
  await page.getByLabel('Agent name').fill('Developers');
  await page.getByLabel('Who you are looking for').fill('a senior react developer to build my product');
  await page.getByRole('button', { name: /Start searching/i }).click();

  await expect(page.getByText('Developers')).toBeVisible({ timeout: 30_000 });

  const list = await apiAs(owner, 'GET', '/agents');
  const agent = list.json.data.find((a: any) => a.label === 'Developers');
  expect(agent, 'the agent must exist').toBeTruthy();
  createdAgentIds.push(agent.id);

  // Scoring runs in the background; the developer must land in it.
  const count = await countFor(owner, agent.id);
  expect(count, 'the developer should be found').toBeGreaterThanOrEqual(1);

  const stored = await pool.query(
    `SELECT candidate_user_id FROM agent_matches WHERE agent_id = $1`, [agent.id]);
  expect(stored.rows.map(r => r.candidate_user_id)).toContain(dev.id);
  expect(stored.rows.map(r => r.candidate_user_id), 'the chef fits nothing here').not.toContain(chef.id);

  await page.reload();
  await expect(page.getByTestId(`agent-count-${agent.id}`)).toContainText(/[1-9]\d* potential match/, { timeout: 30_000 });
  await page.screenshot({ path: 'test-results/agents-dashboard.png' }).catch(() => {});
  console.log(`  ✓ created via UI, scored in background, count rendered (${count}).`);
});

test('several agents run at once, each with its own count', async () => {
  test.setTimeout(240_000);
  const created = await apiAs(owner, 'POST', '/agents', {
    label: 'Investors', wantText: 'angel investors for a seed round',
  });
  expect(created.status).toBe(201);
  createdAgentIds.push(created.json.data.id);
  await countFor(owner, created.json.data.id);

  const devAgent = await agentByLabel(owner, 'Developers');
  const invAgent = await agentByLabel(owner, 'Investors');

  const page = await openAs(owner);
  // Scope to the cards: the want text also contains the word "investors", so a
  // bare text match is ambiguous by design here.
  await expect(page.getByTestId(`agent-${devAgent.id}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`agent-${invAgent.id}`)).toBeVisible();

  expect(devAgent.id).not.toBe(invAgent.id);
  // Each agent found its own kind of person, independently.
  const devMatches = await pool.query(`SELECT candidate_user_id FROM agent_matches WHERE agent_id = $1`, [devAgent.id]);
  const invMatches = await pool.query(`SELECT candidate_user_id FROM agent_matches WHERE agent_id = $1`, [invAgent.id]);
  expect(devMatches.rows.map(r => r.candidate_user_id)).toContain(dev.id);
  expect(invMatches.rows.map(r => r.candidate_user_id)).toContain(investor.id);
  console.log('  ✓ two concurrent agents, each holding its own matches.');
});

// Ali, 5 Aug: he asked jack rajaa to meet through his Developers agent and jack
// disappeared from it. Asking someone is not an answer — they stay, carrying
// the state of the introduction, and stop counting as outstanding.
test('asking someone to meet keeps them on the agent, badged, and drops the count', async () => {
  test.setTimeout(240_000);
  const stayDev = await createTestUser('agStay');
  await setProfile(stayDev, {
    professional_role: ['Developer'],
    job_title: 'Senior React Developer',
    expertise_text: 'react and typescript',
  });

  const devAgent = await agentByLabel(owner, 'Developers');
  await apiAs(owner, 'POST', `/agents/${devAgent.id}/status`, { status: 'active' });
  const before = await countFor(owner, devAgent.id);
  expect(before, 'the new developer is an outstanding match').toBeGreaterThan(0);

  const page = await openAs(owner, `/agents/${devAgent.id}`);
  const card = page.getByTestId(`agent-match-${stayDev.id}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: 'I want to meet' }).click();

  // Still on the agent, now with its state — not deleted.
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId(`agent-match-state-${stayDev.id}`)).toHaveText(/Invite sent/i, { timeout: 20_000 });
  await expect(card.getByRole('button', { name: 'I want to meet' })).toHaveCount(0);
  await expect(page.getByText('Already asked')).toBeVisible();

  const stillStored = await pool.query(
    `SELECT 1 FROM agent_matches WHERE agent_id = $1 AND candidate_user_id = $2`, [devAgent.id, stayDev.id]);
  expect(stillStored.rows.length, 'the match row survives the introduction').toBe(1);

  // The headline count drops, because it counts people not yet asked.
  const after = await countNow(owner, devAgent.id);
  expect(after, 'no longer outstanding').toBe(before - 1);

  await pool.query(`DELETE FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [owner.id, stayDev.id]).catch(() => {});
  await cleanup(pool, { ids: [stayDev.id] });
});

// The introduction has to state the cause it actually came from. jack rajaa was
// told "You're looking to meet founders — Raja Ali King is a Founder": true of
// his own profile, and the wrong reason — what reached him was a DEVELOPERS
// agent.
test('the introduction names the agent that caused it, in the recipient\'s voice', async () => {
  test.setTimeout(240_000);
  const voiceDev = await createTestUser('agVoice');
  await setProfile(voiceDev, {
    professional_role: ['Manager'],
    job_title: 'frontend engineer',
    // He wants founders, exactly like jack. This must NOT become the reason.
    who_i_want_to_meet: 'founders building something new',
  });

  const devAgent = await agentByLabel(owner, 'Developers');
  await apiAs(owner, 'POST', `/agents/${devAgent.id}/status`, { status: 'active' });
  await countFor(owner, devAgent.id);

  const intro = await apiAs(owner, 'POST', `/agents/${devAgent.id}/interest`, { userId: voiceDev.id });
  expect(intro.status).toBe(201);

  const msg = await pool.query<{ message: string }>(
    `SELECT message FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2
      ORDER BY created_at DESC LIMIT 1`, [owner.id, voiceDev.id]);
  const text = msg.rows[0]?.message ?? '';
  console.log(`  introduction sent: "${text}"`);
  expect(text, 'names the sender as the one looking').toMatch(/is looking to meet/);
  expect(text, 'addressed to the reader').not.toMatch(/^You're looking to meet/);
  expect(text, 'the cause was the developer agent').toMatch(/developers and engineers/i);
  expect(text, 'his own want must not be passed off as the cause').not.toMatch(/founders/i);

  await pool.query(`DELETE FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [owner.id, voiceDev.id]).catch(() => {});
  await cleanup(pool, { ids: [voiceDev.id] });
});

test('an introduction from one agent does not hide the person from another', async () => {
  test.setTimeout(240_000);
  // Someone who fits BOTH searches.
  const generalist = await createTestUser('agBoth');
  await setProfile(generalist, {
    professional_role: ['Developer', 'Angel Investor'],
    expertise_text: 'react engineering and angel investing',
  });

  const devAgent = await agentByLabel(owner, 'Developers');
  const invAgent = await agentByLabel(owner, 'Investors');
  await apiAs(owner, 'POST', `/agents/${devAgent.id}/status`, { status: 'active' });
  await apiAs(owner, 'POST', `/agents/${invAgent.id}/status`, { status: 'active' });
  await countFor(owner, devAgent.id);
  await countFor(owner, invAgent.id);

  const inDev = await pool.query(
    `SELECT 1 FROM agent_matches WHERE agent_id = $1 AND candidate_user_id = $2`, [devAgent.id, generalist.id]);
  const inInv = await pool.query(
    `SELECT 1 FROM agent_matches WHERE agent_id = $1 AND candidate_user_id = $2`, [invAgent.id, generalist.id]);
  expect(inDev.rows.length, 'fits the developer search').toBe(1);
  expect(inInv.rows.length, 'fits the investor search too').toBe(1);

  const devBefore = await countNow(owner, devAgent.id);
  const invBefore = await countNow(owner, invAgent.id);

  // Ask to meet them THROUGH the developer agent only.
  const intro = await apiAs(owner, 'POST', `/agents/${devAgent.id}/interest`, { userId: generalist.id });
  expect(intro.status).toBe(201);

  const poke = await pool.query(
    `SELECT agent_id FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [owner.id, generalist.id]);
  expect(poke.rows[0]?.agent_id, 'the poke records which agent introduced them').toBe(devAgent.id);

  const afterDev = await pool.query(
    `SELECT 1 FROM agent_matches WHERE agent_id = $1 AND candidate_user_id = $2`, [devAgent.id, generalist.id]);
  const afterInv = await pool.query(
    `SELECT 1 FROM agent_matches WHERE agent_id = $1 AND candidate_user_id = $2`, [invAgent.id, generalist.id]);
  expect(afterDev.rows.length, 'stays on the agent that introduced them, badged').toBe(1);
  expect(afterInv.rows.length, 'and stays on the other one, still relevant there').toBe(1);

  // Asked once is asked: they stop being OUTSTANDING on both agents, so each
  // count drops by exactly one. Everyone else on those agents is untouched.
  const devAfter = await countNow(owner, devAgent.id);
  const invAfter = await countNow(owner, invAgent.id);
  expect(devAfter, 'asked, so no longer outstanding here').toBe(devBefore - 1);
  expect(invAfter, 'and not outstanding there either').toBe(invBefore - 1);
  console.log(`  ✓ kept on both agents; counts ${devBefore}→${devAfter} and ${invBefore}→${invAfter}.`);

  await pool.query(`DELETE FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [owner.id, generalist.id]).catch(() => {});
  await cleanup(pool, { ids: [generalist.id] });
});

test('editing what an agent looks for re-runs the search', async () => {
  test.setTimeout(240_000);
  const created = await apiAs(owner, 'POST', '/agents', { label: 'Bakers', wantText: 'nobody at all xyzzy' });
  const agentId = created.json.data.id;
  createdAgentIds.push(agentId);
  await new Promise(r => setTimeout(r, 4000));

  const page = await openAs(owner, `/agents/${agentId}`);
  await expect(page.getByText(/Nobody fits this yet/i)).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /Edit what this agent looks for/i }).click();
  await page.getByLabel('Who you are looking for').fill('a pastry chef who bakes sourdough croissants');
  await page.getByRole('button', { name: /^Save$/ }).click();

  const count = await countFor(owner, agentId);
  expect(count, 'the chef now fits').toBeGreaterThanOrEqual(1);
  const stored = await pool.query(`SELECT candidate_user_id FROM agent_matches WHERE agent_id = $1`, [agentId]);
  expect(stored.rows.map(r => r.candidate_user_id)).toContain(chef.id);
  console.log('  ✓ edit rescored: an empty agent found someone after its want changed.');
});

test('pause stops it appearing as active, resume brings it back', async () => {
  test.setTimeout(240_000);
  const agent = await agentByLabel(owner, 'Bakers');

  const page = await openAs(owner);
  const card = page.getByTestId(`agent-${agent.id}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: /Pause agent/i }).click();
  await expect(card.getByText(/Paused/i)).toBeVisible({ timeout: 20_000 });

  const paused = await pool.query(`SELECT status FROM matching_agents WHERE id = $1`, [agent.id]);
  expect(paused.rows[0].status).toBe('paused');

  await card.getByRole('button', { name: /Resume agent/i }).click();
  await expect(card.getByText(/Paused/i)).toHaveCount(0, { timeout: 20_000 });
  const resumed = await pool.query(`SELECT status FROM matching_agents WHERE id = $1`, [agent.id]);
  expect(resumed.rows[0].status).toBe('active');
  console.log('  ✓ pause and resume, both persisted.');
});

test('archiving removes it from the dashboard without destroying it', async () => {
  test.setTimeout(240_000);
  const agent = await agentByLabel(owner, 'Bakers');

  const page = await openAs(owner);
  const card = page.getByTestId(`agent-${agent.id}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: /Archive agent/i }).click();
  await expect(card).toHaveCount(0, { timeout: 20_000 });

  const row = await pool.query(`SELECT status, archived_at FROM matching_agents WHERE id = $1`, [agent.id]);
  expect(row.rows[0].status).toBe('archived');
  expect(row.rows[0].archived_at, 'archived, never deleted').toBeTruthy();
  console.log('  ✓ archive hides it and keeps the record.');
});

// Archiving is reversible by design, but the dashboard hid archived agents and
// offered no route back, so archiving was a one-way door in the app.
test('an archived agent can be found again and reactivated from the UI', async () => {
  test.setTimeout(240_000);
  const created = await apiAs(owner, 'POST', '/agents', {
    label: 'Recoverable', wantText: 'react developers and engineers',
  });
  const agentId = created.json.data.id;
  createdAgentIds.push(agentId);
  await apiAs(owner, 'POST', `/agents/${agentId}/status`, { status: 'archived' });

  const page = await openAs(owner);
  // Hidden by default...
  await expect(page.getByTestId(`agent-${agentId}`)).toHaveCount(0, { timeout: 30_000 });
  // ...but reachable, and reversible.
  await page.getByRole('button', { name: /View archived agents/i }).click();
  const card = page.getByTestId(`agent-${agentId}`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(/Archived/i)).toBeVisible();
  // The archived view shows ONLY archived agents — an active one must not leak in.
  const active = await agentByLabel(owner, 'Investors').catch(() => null);
  if (active) await expect(page.getByTestId(`agent-${active.id}`)).toHaveCount(0);
  await card.getByRole('button', { name: /Reactivate/i }).click();

  await expect.poll(async () => {
    const r = await pool.query(`SELECT status FROM matching_agents WHERE id = $1`, [agentId]);
    return r.rows[0]?.status;
  }, { timeout: 30_000 }).toBe('active');

  // Back on the normal dashboard without the toggle, and searching again.
  const fresh = await openAs(owner);
  await expect(fresh.getByTestId(`agent-${agentId}`)).toBeVisible({ timeout: 30_000 });
  const count = await countFor(owner, agentId);
  expect(count, 'a reactivated agent searches again').toBeGreaterThanOrEqual(1);
  console.log(`  ✓ archived agent recovered and re-searched (${count}).`);
});

test('someone joining later becomes a match automatically', async () => {
  test.setTimeout(300_000);
  const devAgent = await agentByLabel(owner, 'Developers');

  // A brand-new developer appears AFTER the agent was created.
  const latecomer = await createTestUser('agLate');
  await setProfile(latecomer, {
    professional_role: ['Developer'], job_title: 'React Developer',
    expertise_text: 'react typescript', what_i_can_help_with: 'building products',
  });

  await pool.query(
    `UPDATE users SET onboarding_completed = true, status = 'active' WHERE id = $1`, [latecomer.id]);

  // In production the fan-out fires from onboarding completion
  // (notifyAgentsOfNewUser, unit-tested separately). Here we assert the other
  // half of the promise: a STANDING agent, created before this person existed,
  // picks them up when it next runs. Resuming triggers that same rescore.
  await apiAs(owner, 'POST', `/agents/${devAgent.id}/status`, { status: 'active' });
  await new Promise(r => setTimeout(r, 6000));
  const stored = await pool.query(
    `SELECT candidate_user_id FROM agent_matches WHERE agent_id = $1`, [devAgent.id]);
  expect(stored.rows.map(r => r.candidate_user_id), 'the late joiner is now a match').toContain(latecomer.id);
  console.log('  ✓ a member who joined later was picked up by the standing agent.');

  await pool.query(`DELETE FROM agent_matches WHERE candidate_user_id = $1`, [latecomer.id]).catch(() => {});
  await cleanup(pool, { ids: [latecomer.id] });
});

// The 3 Aug miss: migration 086 seeded one agent per existing member straight
// into SQL. Creating an agent through the API runs a search; INSERTing a row
// does not, so all 38 seeded agents sat at "0 potential matches" and the smoke
// never noticed because every agent it tested had been created through the API.
// This test builds an agent the way the MIGRATION does and demands it works.
test('an agent inserted directly, as the migration seeds them, still gets scored', async () => {
  test.setTimeout(240_000);
  const seeded = await createTestUser('agSeeded');
  await setProfile(seeded, { who_i_want_to_meet: 'react developers who can build my product' });

  // Exactly what migration 086 does: a row, and nothing else.
  const ins = await pool.query(
    `INSERT INTO matching_agents (user_id, label, want_text, status)
     VALUES ($1, 'Developers', 'react developers who can build my product', 'active')
     RETURNING id`,
    [seeded.id],
  );
  const agentId = ins.rows[0].id;
  createdAgentIds.push(agentId);

  const before = await pool.query(`SELECT last_matched_at FROM matching_agents WHERE id = $1`, [agentId]);
  expect(before.rows[0].last_matched_at, 'a seeded agent starts unscored').toBeNull();

  // Opening the dashboard must be enough to make it work.
  const page = await openAs(seeded);
  await expect(page.getByTestId(`agent-${agentId}`)).toBeVisible({ timeout: 30_000 });

  const count = await countFor(seeded, agentId);
  expect(count, 'a seeded agent must find people, not sit at zero').toBeGreaterThanOrEqual(1);

  const stored = await pool.query(`SELECT candidate_user_id FROM agent_matches WHERE agent_id = $1`, [agentId]);
  expect(stored.rows.map(r => r.candidate_user_id)).toContain(dev.id);

  await expect(page.getByTestId(`agent-count-${agentId}`)).toContainText(/[1-9]\d* potential match/, { timeout: 30_000 });
  console.log(`  ✓ migration-seeded agent scored itself on first view (${count}).`);

  await pool.query(`DELETE FROM agent_matches WHERE agent_id = $1`, [agentId]).catch(() => {});
  await pool.query(`DELETE FROM matching_agents WHERE id = $1`, [agentId]).catch(() => {});
  await cleanup(pool, { ids: [seeded.id] });
});

test('the dashboard fits phone and desktop widths with no overflow', async () => {
  test.setTimeout(240_000);
  const devAgent = await agentByLabel(owner, 'Developers');
  for (const vp of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }]) {
    const page = await openAs(owner, '/agents', vp);
    await expect(page.getByTestId(`agent-${devAgent.id}`)).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `no horizontal scroll at ${vp.width}px`).toBeLessThanOrEqual(1);
  }
  console.log('  ✓ 360 / 390 / 768 / 1280 all clean.');
});
