import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// 8 Sep 2026 (Ali): three fixes, verified against prod.
//  A) "Already asked" is PER-AGENT: a person asked through agent A shows as
//     already-asked on A, but as a fresh match on agent B.
//  B) A member report reaches the admin Moderation Queue (it used to write to a
//     table the queue never read), carries the conversation it came from, and an
//     admin can resolve it.
//  C) Blocking someone from the chat works (the same API the chat button calls).
// No LLM — safe across engines.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await browser.newContext(contextOptions({ width: 1200, height: 950 }));
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  console.log(`[agent-report-block] engine=${engineLabel()} app=${APP}`);
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanupByPrefix(pool, 'e2etest-arb');
  await pool.end().catch(() => {});
});

test('A) already asked is per-agent — asked on one agent, fresh on another', async () => {
  test.setTimeout(90_000);
  const owner = await createTestUser('arb-owner');
  const cand = await createTestUser('arb-cand');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['ARB Candidate', cand.id]);

  // Two agents for the owner.
  const a1 = (await apiAs(owner, 'POST', '/agents', { label: 'Agent One', wantText: 'react developers' })).json.data;
  const a2 = (await apiAs(owner, 'POST', '/agents', { label: 'Agent Two', wantText: 'react developers' })).json.data;
  expect(a1?.id && a2?.id).toBeTruthy();

  // The candidate is a stored match on BOTH agents (insert directly so the test
  // doesn't depend on the scorer).
  for (const ag of [a1.id, a2.id]) {
    await pool.query(
      `INSERT INTO agent_matches (agent_id, candidate_user_id, score, reason)
       VALUES ($1, $2, 0.9, 'test') ON CONFLICT (agent_id, candidate_user_id) DO NOTHING`,
      [ag, cand.id],
    );
  }
  // The owner asked the candidate THROUGH agent one only.
  await pool.query(
    `INSERT INTO user_pokes (id, sender_id, recipient_id, message, status, agent_id)
     VALUES (gen_random_uuid(), $1, $2, 'hi', 'pending', $3)`,
    [owner.id, cand.id, a1.id],
  );

  // Agent one: the candidate is already-asked (pokeStatus set).
  const d1 = await apiAs(owner, 'GET', `/agents/${a1.id}`);
  const m1 = (d1.json.data.matches as any[]).find(m => m.candidateUserId === cand.id);
  expect(m1, 'candidate present on agent one').toBeTruthy();
  expect(m1.pokeStatus, 'already asked on the agent it was asked through').toBe('pending');

  // Agent two: the SAME candidate is a fresh match (no poke via this agent).
  const d2 = await apiAs(owner, 'GET', `/agents/${a2.id}`);
  const m2 = (d2.json.data.matches as any[]).find(m => m.candidateUserId === cand.id);
  expect(m2, 'candidate present on agent two').toBeTruthy();
  expect(m2.pokeStatus, 'NOT already asked on an agent it was never asked through').toBeNull();

  // Card counts agree: agent one counts them as asked, agent two as outstanding.
  const agents = (await apiAs(owner, 'GET', '/agents')).json.data as any[];
  const card1 = agents.find(a => a.id === a1.id);
  const card2 = agents.find(a => a.id === a2.id);
  expect(card1.askedCount).toBeGreaterThanOrEqual(1);
  expect(card2.matchCount).toBeGreaterThanOrEqual(1);
  expect(card2.askedCount).toBe(0);

  await cleanup(pool, { ids: [owner.id, cand.id] });
});

test('B) a member report reaches the moderation queue, carries the chat, and resolves', async () => {
  test.setTimeout(90_000);
  const reporter = await createTestUser('arb-reporter');
  const reported = await createTestUser('arb-reported');
  const admin = await createTestUser('arb-admin', 'admin');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['ARB Reported', reported.id]);

  // A conversation between reporter and reported (poke → accept).
  const sent = await apiAs(reporter, 'POST', '/pokes', { recipientId: reported.id, message: 'hey' });
  await apiAs(reported, 'POST', `/pokes/${sent.json.data.id}/accept`);
  const conv = (await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
    [reporter.id, reported.id],
  )).rows[0];
  expect(conv?.id).toBeTruthy();

  // The reporter files a report FROM the chat.
  const rep = await apiAs(reporter, 'POST', '/reports', {
    reportedId: reported.id, reason: 'harassment', description: 'was rude', conversationId: conv.id,
  });
  expect(rep.status).toBe(201);

  // It shows in the admin moderation queue, tagged as a member report, with the
  // conversation attached.
  const queue = await apiAs(admin, 'GET', '/admin/violations?status=open');
  expect(queue.status).toBe(200);
  const row = (queue.json.data as any[]).find(v => v.reportedUserId === reported.id && v.source === 'report');
  expect(row, 'the member report is in the queue').toBeTruthy();
  expect(row.reason).toBe('harassment');
  expect(row.conversationId).toBe(conv.id);

  // The admin can read the conversation behind it.
  const msgs = await apiAs(admin, 'GET', `/admin/conversations/${conv.id}/messages`);
  expect(msgs.status).toBe(200);
  expect(Array.isArray(msgs.json.data)).toBe(true);

  // The admin resolves it (source = report), and it leaves the open queue.
  const resolved = await apiAs(admin, 'POST', `/admin/violations/${row.id}/resolve`, { action: 'dismiss', source: 'report', adminNotes: 'handled' });
  expect(resolved.status).toBe(200);
  const after = await apiAs(admin, 'GET', '/admin/violations?status=open');
  expect((after.json.data as any[]).some(v => v.id === row.id)).toBe(false);

  await cleanup(pool, { ids: [reporter.id, reported.id, admin.id] });
});

test('C) blocking from the chat blocks the member', async () => {
  test.setTimeout(60_000);
  const me = await createTestUser('arb-blocker');
  const them = await createTestUser('arb-blocked');

  const before = await apiAs(me, 'GET', `/users/${them.id}/block-status`);
  expect(before.json.data.hasBlocked).toBe(false);

  const block = await apiAs(me, 'POST', `/users/${them.id}/block`, { reason: 'test' });
  expect(block.status).toBe(200);

  const after = await apiAs(me, 'GET', `/users/${them.id}/block-status`);
  expect(after.json.data.hasBlocked).toBe(true);

  await cleanup(pool, { ids: [me.id, them.id] });
});

test('D) the moderation queue UI shows the report and opens the conversation', async () => {
  test.setTimeout(120_000);
  const reporter = await createTestUser('arb-uir');
  const reported = await createTestUser('arb-uid');
  const admin = await createTestUser('arb-uiadmin', 'admin');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['UI Reported Person', reported.id]);

  const sent = await apiAs(reporter, 'POST', '/pokes', { recipientId: reported.id, message: 'hello there' });
  await apiAs(reported, 'POST', `/pokes/${sent.json.data.id}/accept`);
  const conv = (await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
    [reporter.id, reported.id],
  )).rows[0];
  await apiAs(reporter, 'POST', '/reports', { reportedId: reported.id, reason: 'spam', description: 'spammy', conversationId: conv.id });

  const page = await openAs(admin, '/admin/moderation');
  const card = page.getByText(/Report against UI Reported Person/i);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/member report/i).first()).toBeVisible();

  // Open the conversation behind the report and see the message.
  await page.getByRole('button', { name: /View the conversation/i }).first().click();
  await expect(page.getByText(/hello there/i)).toBeVisible({ timeout: 15_000 });

  await cleanup(pool, { ids: [reporter.id, reported.id, admin.id] });
});
