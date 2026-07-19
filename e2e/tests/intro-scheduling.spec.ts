import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, wait, APP, SERVER } from '../helpers/live-ui';

// PROD VERIFICATION — REASON v1 Phase 2 (19 Jul 2026):
//   (a) "we introduce them to each other" — accepting an introduction seeds the
//       intro as the FIRST message of the new thread (pre-fix the chat opened
//       cold and the intro died with the poke);
//   (b) "setup availability to be introduced" — both sides pick time windows,
//       the overlap shows, one side confirms → conversation pinned, a message
//       lands in the thread, the partner gets a bell notification.
//
// REST drives the investor; the founder drives the REAL UI headed at 390px.

let browser: Browser;
let founder: TestUser, investor: TestUser;
const ctxs: BrowserContext[] = [];
let conversationId = '';

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const dayKey = (offsetDays: number, part: string) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}:${part}`;
};

test.beforeAll(async () => {
  founder = await createTestUser('schfounder');
  investor = await createTestUser('schinvestor');
  await pool.query(
    `UPDATE users SET professional_role = $2, who_i_want_to_meet = $3 WHERE id = $1`,
    [founder.id, ['Founder'], 'investors for my seed round'],
  );
  await pool.query(
    `UPDATE users SET professional_role = $2, expertise_text = $3 WHERE id = $1`,
    [investor.id, ['Angel Investor'], 'early stage investing'],
  );
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [founder?.id, investor?.id].filter(Boolean);
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
});

test('intro lands in the thread, both set availability, overlap confirms — full Phase 2 loop', async () => {
  test.setTimeout(300_000);

  // (1) Introduction: founder expresses interest → investor accepts.
  const interest = await apiAs(founder, 'POST', `/matches/platform/${investor.id}/interest`);
  expect(interest.status).toBe(201);
  const inbox = await apiAs(investor, 'GET', '/pokes/received');
  const poke = inbox.json.data.find((p: any) => p.senderId === founder.id);
  expect(poke).toBeTruthy();
  const accept = await apiAs(investor, 'POST', `/pokes/${poke.id}/accept`);
  expect(accept.status).toBe(200);
  conversationId = accept.json.data.conversationId;
  console.log('  ✓ introduction accepted, conversation:', conversationId);

  // (2) THE INTRO IS THE FIRST MESSAGE of the thread (Phase 2a).
  const msgs = await apiAs(investor, 'GET', `/dm/conversations/${conversationId}/messages`);
  expect(msgs.status).toBe(200);
  const introMsg = (msgs.json.data?.messages ?? msgs.json.data ?? []).find?.((m: any) => /should meet/i.test(m.content));
  expect(introMsg, 'the introduction must be seeded into the thread').toBeTruthy();
  console.log(`  ✓ intro seeded into the thread: "${introMsg.content.slice(0, 60)}..."`);

  // (3) Availability via REST: investor picks two windows.
  const W_OVERLAP = dayKey(2, 'evening');
  const invSet = await apiAs(investor, 'PUT', `/dm/conversations/${conversationId}/scheduling/availability`,
    { windows: [W_OVERLAP, dayKey(4, 'morning')] });
  expect(invSet.status).toBe(200);
  // Founder picks two too — one overlapping.
  const fSet = await apiAs(founder, 'PUT', `/dm/conversations/${conversationId}/scheduling/availability`,
    { windows: [W_OVERLAP, dayKey(3, 'morning')] });
  expect(fSet.status).toBe(200);
  expect(fSet.json.data.overlap).toEqual([W_OVERLAP]);
  console.log('  ✓ both sides saved availability — overlap:', fSet.json.data.overlap);

  // (4) A non-overlap window cannot be confirmed (server gate).
  const bad = await apiAs(founder, 'POST', `/dm/conversations/${conversationId}/scheduling/confirm`,
    { window: dayKey(3, 'morning') });
  expect(bad.status).toBe(400);
  console.log('  ✓ confirming a one-sided window is rejected.');

  // (5) HEADED — the founder opens the real thread on a phone width, sees the
  //     intro message and the scheduler with the green overlap, confirms it.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: founder.accessToken, r: founder.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/messages/${conversationId}`);

  await expect(page.getByText(/should meet/i).first()).toBeVisible({ timeout: 20_000 });
  console.log('  ✓ headed: intro message visible in the thread.');

  await page.getByRole('button', { name: /Find a time to meet/i }).click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Both can').first()).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: 'test-results/sch-grid-overlap.png' }).catch(() => {});
  console.log('  ✓ headed: scheduler grid shows the green "Both can" overlap.');

  await page.getByRole('button', { name: /^Confirm / }).first().click();
  await expect(page.getByText(/Meeting confirmed:/i).first()).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: 'test-results/sch-confirmed.png' }).catch(() => {});
  console.log('  ✓ headed: founder confirmed the overlap — banner shown.');

  // (6) The confirmation is REAL: conversation pinned, thread message dropped,
  //     partner bell-notified.
  const conv = await pool.query(
    `SELECT meeting_confirmed_window, meeting_confirmed_by FROM dm_conversations WHERE id = $1`,
    [conversationId]);
  expect(conv.rows[0].meeting_confirmed_window).toBe(W_OVERLAP);
  expect(conv.rows[0].meeting_confirmed_by).toBe(founder.id);
  const msgs2 = await apiAs(investor, 'GET', `/dm/conversations/${conversationId}/messages`);
  const confirmMsg = (msgs2.json.data?.messages ?? msgs2.json.data ?? []).find?.((m: any) => /Meeting confirmed/i.test(m.content));
  expect(confirmMsg, 'confirmation must live in the thread history').toBeTruthy();
  const notif = await pool.query(
    `SELECT id FROM notifications WHERE user_id = $1 AND type = 'meeting_confirmed'`, [investor.id]);
  expect(notif.rows.length).toBeGreaterThanOrEqual(1);
  console.log('  ✓ conversation pinned + thread message + partner notification. Phase 2 loop closes.');
});
