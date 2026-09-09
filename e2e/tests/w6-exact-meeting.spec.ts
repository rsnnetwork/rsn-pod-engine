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
  // 9 Sep 2026: a concrete 30-min slot (UTC instant) at a LOCAL hour the picker shows.
  const dt = new Date();
  dt.setHours(({ morning: 9, afternoon: 14, evening: 18 } as Record<string, number>)[daypart] ?? 14, 0, 0, 0);
  dt.setDate(dt.getDate() + daysAhead);
  return dt.toISOString().replace('.000Z', 'Z');
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

  // A opens the thread and the scheduler. On phone widths the header actions
  // collapse into a "More actions" menu, so open that first if present. Wait for
  // the header to render either control before deciding (avoids a load race).
  const page = await openAs(a, `/messages/${convId}`);
  const findTime = page.getByRole('button', { name: /Find a time to meet/i });
  const more = page.getByRole('button', { name: 'More actions' });
  await findTime.or(more).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (await more.isVisible().catch(() => false)) {
    await more.click();
  }
  const openScheduler = async () => {
    if (await more.isVisible().catch(() => false)) await more.click();
    await findTime.filter({ visible: true }).first().click();
    await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
  };
  await findTime.filter({ visible: true }).first().click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });

  // The length is typed up front, visible the moment the panel opens (Ali,
  // 9 Sep: "what if the user only has 10 minutes").
  const minutes = page.locator('#meeting-minutes');
  await expect(minutes).toBeVisible();
  await minutes.fill('10');

  // 9 Sep 2026: the overlap IS a concrete time. The grid shows it green on the
  // right day, the chip is labelled in local time, and confirming asks only
  // for audio/video — the exact time and length are shown before commit.
  await expect(page.getByTestId('slot-grid').getByText('Both can').first()).toBeVisible({ timeout: 20_000 });

  // Any time of day (Ali, 9 Sep): a time outside the quick grid, typed into
  // the 24-hour field, becomes a selected chip on this day and saves.
  const keyDay = new Date(KEY);
  const EARLY = new Date(keyDay.getFullYear(), keyDay.getMonth(), keyDay.getDate(), 6, 30).toISOString().replace('.000Z', 'Z');
  const early = page.locator(`[data-slot="${EARLY}"]`);
  // The whole day is one scrollable timeline: 06:30 exists already but sits
  // above the opening position (the 2 PM "Both can" slot) — out of the frame.
  const inFrame = () => early.evaluate((el: HTMLElement) => {
    const box = el.closest('[data-testid="slot-grid"]') as HTMLElement;
    const top = el.offsetTop, bottom = top + el.offsetHeight;
    return top >= box.scrollTop - 1 && bottom <= box.scrollTop + box.clientHeight + 1;
  });
  await expect(early).toHaveAttribute('aria-pressed', 'false');
  expect(await inFrame(), '06:30 starts out of the frame').toBe(false);
  await page.locator('#custom-time').fill('06:30');
  await page.getByRole('button', { name: /^Add time$/ }).click();
  await expect(early).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(inFrame, { message: 'the typed time is scrolled into the frame' }).toBe(true);
  await page.screenshot({ path: `shots/meeting/15-timeline-typed-time-${engineLabel()}.png` }).catch(() => {});
  await expect(early).toContainText(new Date(EARLY).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  await page.getByRole('button', { name: /Save availability/i }).click();
  await expect(page.getByText(/Availability saved/i)).toBeVisible({ timeout: 15_000 });
  const saved = await apiAs(a, 'GET', `/dm/conversations/${convId}/scheduling`);
  expect(saved.json.data.mine).toContain(EARLY);
  expect(saved.json.data.mine).toContain(KEY);

  const chip = page.getByRole('button', { name: /^Confirm / }).first();
  const localLabel = new Date(KEY).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  await page.screenshot({ path: `shots/meeting/13-scheduler-slots-${engineLabel()}.png` }).catch(() => {});
  await expect(chip).toContainText(localLabel);
  await chip.click();
  await page.screenshot({ path: `shots/meeting/14-confirm-card-${engineLabel()}.png` }).catch(() => {});
  // The 10 typed at the top is what the confirm shows.
  await expect(page.getByTestId('confirm-summary')).toContainText(`${localLabel} · 10 min · Video call`);
  // Out-of-range lengths are refused before the request is ever sent.
  await page.locator('#meeting-minutes').fill('3');
  await expect(page.getByRole('button', { name: /Confirm meeting/i })).toBeDisabled();
  await page.locator('#meeting-minutes').fill('20');
  await expect(page.getByTestId('confirm-summary')).toContainText(`${localLabel} · 20 min · Video call`);
  await page.getByRole('button', { name: /Confirm meeting/i }).click();

  // The confirmed banner shows a local time + duration + a universal calendar file.
  const banner = page.locator('[data-testid="meeting-scheduler"]');
  await expect(banner.getByText(/Meeting confirmed/i)).toBeVisible({ timeout: 20_000 });
  await expect(banner.getByText(/20 minutes · shown in your local time/i)).toBeVisible();
  await expect(banner.getByRole('button', { name: /Add to calendar/i })).toBeVisible();
  await expect(page.getByText(/Google Calendar/i)).toHaveCount(0);

  // The thread line carries the instant and is rendered in MY local time, not raw ISO.
  const thread = page.locator('[data-message-id]').filter({ hasText: 'Meeting confirmed' }).first();
  await expect(thread).toBeVisible({ timeout: 15_000 });
  await expect(thread).toContainText(localLabel);
  await expect(thread).not.toContainText(/\d{4}-\d{2}-\d{2}T/);

  // The DB pinned the slot itself as the instant + the custom duration.
  const row = (await pool.query<{ meeting_start_at: Date | null; meeting_duration_min: number | null }>(
    `SELECT meeting_start_at, meeting_duration_min FROM dm_conversations WHERE id=$1`, [convId],
  )).rows[0];
  expect(row.meeting_start_at?.toISOString().replace('.000Z', 'Z')).toBe(KEY);
  expect(row.meeting_duration_min).toBe(20);
});
