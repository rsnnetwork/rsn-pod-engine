import { test, expect, Browser, BrowserContext, Page, Locator } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// 19 Sep 2026 (Stefan + Shradha): "Both saved availability, both saw a green
// overlapping slot, one picked it, and nothing happened."
//
// The scheduler panel could not shrink inside the fixed-height thread column,
// so on a laptop-height window "Save availability", the green chips, "Confirm
// meeting" and the message box were pushed past the column's clip edge. Every
// earlier spec ran at 1200x950 and clicked with locator.click(), which scrolls
// clipped ancestors, so they stayed green.
//
// This spec measures what a person can actually press, at real window sizes,
// without scrolling, and presses by coordinates. No LLM, safe across engines.
// ─────────────────────────────────────────────────────────────────────────────

const VIEWPORTS = [
  { width: 360, height: 640 },   // small Android
  { width: 390, height: 844 },   // iPhone
  { width: 768, height: 1024 },  // tablet portrait
  { width: 1024, height: 600 },  // short landscape / split window
  { width: 1280, height: 720 },  // small laptop
  { width: 1366, height: 768 },  // the most common laptop
];

let browser: Browser;
let a: TestUser, b: TestUser;
let convId: string;
let KEY: string;
let NEXT: string;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
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

/** A 30-minute slot three days out at 14:00 local: on the grid, never past. */
function futureSlot(daysAhead: number, hour: number, minute = 0): string {
  const dt = new Date();
  dt.setHours(hour, minute, 0, 0);
  dt.setDate(dt.getDate() + daysAhead);
  return dt.toISOString().replace('.000Z', 'Z');
}

/** The message box. Its placeholder shortens to "Message…" at 379px and under. */
const messageBox = (page: Page) => page.getByPlaceholder(/^(Type a message\.\.\.|Message…)$/);

/** Opening the panel is not what is under test, so plain clicks are fine here. */
async function openScheduler(page: Page): Promise<void> {
  const findTime = page.getByRole('button', { name: /Find a time to meet/i });
  const more = page.getByRole('button', { name: 'More actions' });
  await findTime.or(more).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (await more.isVisible().catch(() => false)) await more.click();
  await findTime.filter({ visible: true }).first().click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('slot-grid').getByText('Both can').first()).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async () => {
  a = await createTestUser('svfa');
  b = await createTestUser('svfb');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Fit Ana', a.id]);
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Fit Bo', b.id]);
  console.log(`[scheduler-viewport-fit] engine=${engineLabel()} app=${APP}`);

  // Connect the pair (ask → accept), then both save the same time: a green slot.
  const sent = await apiAs(a, 'POST', '/pokes', { recipientId: b.id, message: 'Coffee?' });
  expect(sent.status).toBe(201);
  expect((await apiAs(b, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
  const conv = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
    [a.id, b.id],
  );
  convId = conv.rows[0]?.id;
  expect(convId).toBeTruthy();
  KEY = futureSlot(3, 14);
  NEXT = futureSlot(3, 14, 30);
  expect((await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);
  expect((await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);

  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  await cleanup(pool, { ids: [a.id, b.id] });
  await cleanupByPrefix(pool, 'e2etest-svf');
  await pool.end().catch(() => {});
});

test('every scheduler action can be pressed without scrolling, at every window size', async () => {
  test.setTimeout(480_000);
  const problems: string[] = [];

  for (const vp of VIEWPORTS) {
    const size = `${vp.width}x${vp.height}`;
    const page = await openAs(a, `/messages/${convId}`, vp);
    await openScheduler(page);

    // Measure every control; keep going after a miss so one run reports them all.
    const reach = async (target: Locator, label: string): Promise<boolean> => {
      try {
        const box = await expectReachable(page, target, label);
        console.log(`  ${size}  ok      ${label}  bottom=${Math.round(box.y + box.height)}/${vp.height}`);
        return true;
      } catch (e) {
        const why = String((e as Error).message).split('\n')[0];
        const box = await target.boundingBox().catch(() => null);
        console.log(`  ${size}  MISSED  ${label}  bottom=${box ? Math.round(box.y + box.height) : 'n/a'}/${vp.height}  (${why})`);
        problems.push(`${size}: ${why}`);
        return false;
      }
    };
    // Press by coordinates when reachable; otherwise fall back so the rest of
    // this window size still gets measured (the miss is already recorded).
    const press = async (target: Locator, label: string) => {
      if (await reach(target, label)) {
        const box = (await target.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await target.click();
      }
    };

    // 1. Both saved → a green chip is offered. Pressing it opens the confirm step.
    await press(page.getByTestId('overlap-list').getByRole('button', { name: /^Confirm / }).first(), 'green time chip');
    await expect(page.getByTestId('confirm-card')).toBeVisible();
    // 2. The button that actually creates the meeting.
    await reach(page.getByRole('button', { name: /^Confirm meeting$/ }), '"Confirm meeting" button');
    await press(page.getByTestId('confirm-card').getByRole('button', { name: /^Cancel$/ }), 'confirm step Cancel');
    // 3. The panel must not swallow the message box ("no way out").
    await reach(messageBox(page), 'message box while the panel is open');
    // 4. Pick a time, then Save.
    await press(page.locator(`[data-slot="${NEXT}"]`), 'a free time in the grid');
    await press(page.getByRole('button', { name: /Save availability/i }), '"Save availability" button');
    await expect(page.getByText(/Availability saved/i)).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: `test-results/scheduler-fit-${size}-${engineLabel().replace(/[^a-z0-9]+/gi, '-')}.png` }).catch(() => {});
    await page.context().close().catch(() => {});
  }

  expect(problems, `controls a person could not press:\n${problems.join('\n')}`).toEqual([]);
});

test('on a laptop-height window, picking the green time and pressing Confirm creates the meeting', async () => {
  test.setTimeout(180_000);
  const page = await openAs(a, `/messages/${convId}`, { width: 1366, height: 768 });
  await openScheduler(page);

  // Strict: every press must land where a person could press it. No fallbacks.
  await tapReachable(page, page.getByTestId('overlap-list').getByRole('button', { name: /^Confirm / }).first(), 'green time chip');
  await tapReachable(page, page.getByRole('button', { name: /^Confirm meeting$/ }), '"Confirm meeting" button');

  // The meeting exists: toast, pinned banner with Join, a line in the thread, and the row in the DB.
  await expect(page.getByText(/Meeting confirmed!/i)).toBeVisible({ timeout: 20_000 });
  const thread = page.locator('[data-message-id]').filter({ hasText: 'Meeting confirmed' }).first();
  await expect(thread).toBeVisible({ timeout: 20_000 });
  const row = (await pool.query<{ meeting_start_at: Date | null }>(
    `SELECT meeting_start_at FROM dm_conversations WHERE id=$1`, [convId],
  )).rows[0];
  expect(row.meeting_start_at?.toISOString().replace('.000Z', 'Z')).toBe(KEY);
  // And the person can still type afterwards.
  await expectReachable(page, messageBox(page), 'message box after confirming');
});
