import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// W6 (7 Sep 2026): a confirmed meeting has a real time, duration and timezone,
// shown to each person in their OWN local time, plus a calendar link. Stefan:
// "meeting updates do not clearly show time, timezone or duration."
// No LLM — safe to run across engines.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let a: TestUser, b: TestUser;
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

function futureWindowKey(daysAhead = 3, daypart = 'afternoon'): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.toISOString().slice(0, 10)}:${daypart}`;
}

async function convBetween(x: string, y: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
    [x, y],
  );
  return r.rows[0]?.id;
}

test.beforeAll(async () => {
  a = await createTestUser('w6a');
  b = await createTestUser('w6b');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['W6 Ana', a.id]);
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['W6 Bo', b.id]);
  console.log(`[w6-exact-meeting] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanup(pool, { ids: [a.id, b.id] });
  await cleanupByPrefix(pool, 'e2etest-w6');
  await pool.end().catch(() => {});
});

test('confirming a meeting pins an exact local time + duration and offers a calendar link', async () => {
  test.setTimeout(120_000);

  // Connect A + B (poke → accept via API).
  const sent = await apiAs(a, 'POST', '/pokes', { recipientId: b.id, message: 'Coffee?' });
  expect(sent.status).toBe(201);
  const accepted = await apiAs(b, 'POST', `/pokes/${sent.json.data.id}/accept`);
  expect(accepted.status).toBe(200);
  const convId = await convBetween(a.id, b.id);
  expect(convId).toBeTruthy();

  // Both save the same window, so it is a confirmable overlap.
  const KEY = futureWindowKey(3, 'afternoon');
  expect((await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);
  expect((await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);

  // A opens the thread and the scheduler.
  const page = await openAs(a, `/messages/${convId}`);
  await page.getByRole('button', { name: /Find a time to meet/i }).click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });

  // Confirm the overlap window → exact-time step → confirm.
  await page.getByRole('button', { name: /^Confirm .*(morning|afternoon|evening)/i }).first().click();
  await page.locator('input[type="time"]').fill('15:30');
  await page.getByRole('button', { name: /Confirm meeting/i }).click();

  // The confirmed banner shows a local time + duration + a Google Calendar link.
  const banner = page.locator('[data-testid="meeting-scheduler"]');
  await expect(banner.getByText(/Meeting confirmed/i)).toBeVisible({ timeout: 20_000 });
  await expect(banner.getByText(/minutes · shown in your local time/i)).toBeVisible();
  await expect(banner.getByRole('link', { name: /Add to Google Calendar/i })).toBeVisible();

  // The DB pinned an absolute instant + duration.
  const row = (await pool.query<{ meeting_start_at: Date | null; meeting_duration_min: number | null }>(
    `SELECT meeting_start_at, meeting_duration_min FROM dm_conversations WHERE id=$1`, [convId],
  )).rows[0];
  expect(row.meeting_start_at, 'an exact instant is stored').toBeTruthy();
  expect(row.meeting_duration_min).toBeGreaterThanOrEqual(15);
});
