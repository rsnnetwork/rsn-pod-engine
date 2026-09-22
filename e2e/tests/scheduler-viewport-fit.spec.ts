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
let c: TestUser, d: TestUser;
let convId: string;
let convCd: string;
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
async function openScheduler(page: Page, gridShows: 'Both can' | 'They can' = 'Both can'): Promise<void> {
  const findTime = page.getByRole('button', { name: /Find a time to meet/i });
  const more = page.getByRole('button', { name: 'More actions' });
  await findTime.or(more).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (await more.isVisible().catch(() => false)) await more.click();
  await findTime.filter({ visible: true }).first().click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('slot-grid').getByText(gridShows).first()).toBeVisible({ timeout: 20_000 });
}

/** Connect two people (ask → accept) and return their conversation id. */
async function connect(x: TestUser, y: TestUser): Promise<string> {
  const sent = await apiAs(x, 'POST', '/pokes', { recipientId: y.id, message: 'Coffee?' });
  expect(sent.status).toBe(201);
  expect((await apiAs(y, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
  const conv = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
    [x.id, y.id],
  );
  expect(conv.rows[0]?.id).toBeTruthy();
  return conv.rows[0].id;
}

/** Scroll the panel the way a person would: wheel over it, outside the timeline. */
async function wheelPanel(page: Page, dy: number): Promise<void> {
  const label = await page.locator('label[for="meeting-minutes"]').boundingBox();
  expect(label, 'the meeting length label anchors the wheel').not.toBeNull();
  await page.mouse.move(label!.x + 4, Math.max(1, label!.y + 4));
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(400);
}

test.beforeAll(async () => {
  a = await createTestUser('svfa');
  b = await createTestUser('svfb');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Fit Ana', a.id]);
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Fit Bo', b.id]);
  console.log(`[scheduler-viewport-fit] engine=${engineLabel()} app=${APP}`);

  // Pair A+B: both saved the same time, so a green slot is already on offer.
  convId = await connect(a, b);
  KEY = futureSlot(3, 14);
  NEXT = futureSlot(3, 14, 30);
  expect((await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);
  expect((await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);

  // Pair C+D: only D has saved. C is the second saver, whose own Save press
  // is what creates the green time.
  c = await createTestUser('svfc');
  d = await createTestUser('svfd');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Fit Cy', c.id]);
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Fit Di', d.id]);
  convCd = await connect(c, d);
  expect((await apiAs(d, 'PUT', `/dm/conversations/${convCd}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);

  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const x of ctxs) { try { await x.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  await cleanup(pool, { ids: [a.id, b.id, c.id, d.id] });
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
    // 4. Pick a time. The timeline is content, not a finishing action: on a
    //    short window a person may scroll the panel once to bring it up. Do it
    //    the way a person would — wheel over the panel, outside the timeline's
    //    own scroller. (The old panel could not scroll at all, so this still
    //    fails there.)
    const slot = page.locator(`[data-slot="${NEXT}"]`);
    const inReach = await expectReachable(page, slot, 'probe').then(() => true, () => false);
    if (!inReach) await wheelPanel(page, 220);
    await press(slot, inReach ? 'a free time in the grid' : 'a free time in the grid (after one scroll of the panel)');
    // Hold the thread column itself: sending closes the panel (21 Sep), so
    // after that there is no [data-scheduler-panel] left to reach it through.
    const column = await page.locator('[data-scheduler-panel]')
      .evaluateHandle(el => el.parentElement as HTMLElement);
    // 5. Unsaved picks → Save is pinned in reach.
    await press(page.getByRole('button', { name: /Save and send availability/i }), '"Save availability" button');
    await expect(page.getByText(/they can see when you are free/i)).toBeVisible({ timeout: 15_000 });

    // 6. Nothing above may ever scroll the thread column itself: it clips its
    //    overflow, so a scrolled column slides the header and the name away.
    const columnScroll = await column.evaluate((el: HTMLElement) => el.scrollTop);
    if (columnScroll !== 0) {
      console.log(`  ${size}  MISSED  thread column scrolled by ${columnScroll}px`);
      problems.push(`${size}: the thread column itself was scrolled by ${columnScroll}px (header pushed out of view)`);
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// The panel is a scroller with another scroller (the timeline) inside it. Three
// ways that can still leave someone stuck, each pinned here.
// ─────────────────────────────────────────────────────────────────────────────

test('nested scroll: on a small phone, scrolling from inside the timeline still moves the panel', async () => {
  test.setTimeout(180_000);
  // 375x548 is an iPhone SE with Safari's bars showing: the panel's frame is
  // shorter than the 300px timeline, so the timeline can cover all of it.
  const page = await openAs(a, `/messages/${convId}`, { width: 375, height: 548 });
  await openScheduler(page);
  const panel = page.getByTestId('meeting-scheduler');
  const grid = page.getByTestId('slot-grid');

  // Bring the timeline to the top of the panel's frame and put it at its own end.
  await panel.evaluate((p: HTMLElement) => {
    const g = p.querySelector('[data-testid="slot-grid"]') as HTMLElement;
    p.scrollTop += g.getBoundingClientRect().top - p.getBoundingClientRect().top;
    g.scrollTop = g.scrollHeight;
  });
  await page.waitForTimeout(800); // let any scroll latch from setup expire
  const frame = (await panel.boundingBox())!;
  const g = (await grid.boundingBox())!;
  console.log(`  375x548  panel frame=${Math.round(frame.height)}px  timeline=${Math.round(g.height)}px`);
  const before = await panel.evaluate((p: HTMLElement) => p.scrollTop);
  const room = await panel.evaluate((p: HTMLElement) => p.scrollHeight - p.clientHeight - p.scrollTop);
  expect(room, 'the panel has further to scroll').toBeGreaterThan(20);

  // A person's finger or wheel is on the timeline. It is already at its end,
  // so the gesture has to carry on into the panel, not die there.
  const top = Math.max(frame.y, g.y);
  const bottom = Math.min(frame.y + frame.height, g.y + g.height);
  await page.mouse.move(g.x + g.width / 2, (top + bottom) / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(600);
  const after = await panel.evaluate((p: HTMLElement) => p.scrollTop);
  console.log(`  375x548  panel scrollTop ${Math.round(before)} -> ${Math.round(after)}`);
  expect(after, 'a scroll that starts on the timeline (already at its end) must move the panel').toBeGreaterThan(before);
});

test('second saver: my Save creates the green time, and its chip is in reach without scrolling back', async () => {
  test.setTimeout(180_000);
  // A small phone: the panel's frame is far shorter than the timeline, so
  // picking a time really does mean scrolling away from the top of the panel.
  const page = await openAs(c, `/messages/${convCd}`, { width: 375, height: 548 });
  await openScheduler(page, 'They can');
  await expect(page.getByTestId('overlap-list')).toHaveCount(0);
  const panel = page.getByTestId('meeting-scheduler');

  // Pick the time they offered, scrolling the panel to it the way a person
  // would if it is not already in front of them.
  const slot = page.locator(`[data-slot="${KEY}"]`);
  for (let i = 0; i < 6; i++) {
    if (await expectReachable(page, slot, 'probe').then(() => true, () => false)) break;
    await wheelPanel(page, 120);
  }
  await tapReachable(page, slot, 'the time they can');

  // Now be where this person really is when they press Save: down the panel,
  // among the times, nowhere near its top. Set it outright so the state under
  // test is the same on every engine.
  const scrolled = await panel.evaluate((p: HTMLElement) => {
    p.scrollTop = p.scrollHeight;
    return p.scrollTop;
  });
  console.log(`  375x548  panel scrolled to ${Math.round(scrolled)} before Save`);
  expect(scrolled, 'the panel is scrolled away from its top').toBeGreaterThan(40);
  await tapReachable(page, page.getByRole('button', { name: /Save and send availability/i }), '"Save availability" button');
  await expect(page.getByText(/they can see when you are free/i)).toBeVisible({ timeout: 15_000 });

  // Sending is where this job ends, so the panel hands the thread back (21 Sep).
  // The guarantee is unchanged: the next step has to be in front of this person,
  // not somewhere they would have to go looking for. It is now the card the send
  // just wrote, with the times on it.
  await expect(page.getByTestId('meeting-scheduler')).toHaveCount(0, { timeout: 15_000 });
  const card = page.getByTestId('system-message-card').filter({ hasText: /You are both free/i });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(300);
  await expectReachable(page, card.getByRole('button').first(), 'a time to confirm, right after my send');
});

test('pinned bar: a control focused by keyboard is never left hidden under the Save bar', async () => {
  test.setTimeout(180_000);
  const page = await openAs(a, `/messages/${convId}`, { width: 1366, height: 768 });
  await openScheduler(page);
  const next = page.locator(`[data-slot="${NEXT}"]`);
  if (!(await expectReachable(page, next, 'probe').then(() => true, () => false))) await wheelPanel(page, 220);
  await tapReachable(page, next, 'a free time in the grid');
  const save = page.getByRole('button', { name: /Save and send availability/i });
  await expectReachable(page, save, '"Save availability" button');

  // The bar is pinned flush to the bottom of the panel's frame.
  const geo = await page.getByTestId('meeting-scheduler').evaluate((p: HTMLElement) => {
    const bar = p.querySelector('[data-pinned="true"]') as HTMLElement;
    const pr = p.getBoundingClientRect(); const br = bar.getBoundingClientRect();
    return { panelBottom: pr.bottom - parseFloat(getComputedStyle(p).borderBottomWidth), barBottom: br.bottom, barTop: br.top };
  });
  console.log(`  1366x768  pinned bar bottom=${geo.barBottom.toFixed(1)}  panel inner bottom=${geo.panelBottom.toFixed(1)}`);
  expect(Math.abs(geo.barBottom - geo.panelBottom), 'the pinned bar sits flush on the panel frame').toBeLessThanOrEqual(1.5);

  // Find a time whose box lies under the bar, move keyboard focus to it, and
  // require the browser to have brought it out from under the bar.
  const covered = await page.getByTestId('slot-grid').evaluate((g: HTMLElement, barTop: number) => {
    const hit = [...g.querySelectorAll<HTMLElement>('[data-slot]:not([disabled])')]
      .find(el => { const r = el.getBoundingClientRect(); return r.bottom > barTop + 2 && r.top < barTop + 40; });
    return hit?.dataset.slot ?? null;
  }, geo.barTop);
  test.skip(!covered, 'no time lies under the pinned bar at this size');
  const target = page.locator(`[data-slot="${covered}"]`);
  await target.focus();
  await page.waitForTimeout(300);
  const after = await target.evaluate((el: HTMLElement) => {
    const bar = document.querySelector('[data-pinned="true"]') as HTMLElement;
    return { bottom: el.getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top };
  });
  console.log(`  1366x768  focused time bottom=${after.bottom.toFixed(1)}  bar top=${after.barTop.toFixed(1)}`);
  expect(after.bottom, 'the focused time is clear of the pinned Save bar').toBeLessThanOrEqual(after.barTop + 1);
});
