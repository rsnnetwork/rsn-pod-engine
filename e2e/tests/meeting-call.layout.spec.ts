import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser } from '../helpers/engine';
import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Layout sweep (Ali's permanent rule, 9 Sep 2026): every UI change must be right
// on Android (360), large phone (390/414), tablet portrait (768), tablet
// landscape (1024) and desktop (1280) — no horizontal overflow, ≥44px tap
// targets on the controls, key elements visible. Runs the chat in BOTH states:
// locked (scheduler, no calls) and unlocked (calls, no scheduler), plus the
// request dialog and the call room. Chromium; screenshots per width.
// ─────────────────────────────────────────────────────────────────────────────

const OUT = path.resolve(__dirname, '../shots/layout');
const WIDTHS = [
  { name: 'android-360', width: 360, height: 780 },
  { name: 'phone-390', width: 390, height: 844 },
  { name: 'phone-414', width: 414, height: 896 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'tablet-1024', width: 1024, height: 768 },
  { name: 'desktop-1280', width: 1280, height: 900 },
];

let browser: Browser;
let a: TestUser, b: TestUser;
let convId: string;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function pageAt(u: TestUser, p: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 1024 });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${p}`);
  return page;
}
function futureWindowKey(daysAhead = 3, daypart = 'afternoon'): string {
  // 9 Sep 2026: a concrete 30-min slot (UTC instant) at a LOCAL hour the picker shows.
  const dt = new Date();
  dt.setHours(({ morning: 9, afternoon: 14, evening: 18 } as Record<string, number>)[daypart] ?? 14, 0, 0, 0);
  dt.setDate(dt.getDate() + daysAhead);
  return dt.toISOString().replace('.000Z', 'Z');
}
/** Server clock, not this PC's (a skewed local clock puts "now + 1 min" in the server's past). */
async function serverNowMs(): Promise<number> {
  return new Date((await pool.query<{ n: Date }>('SELECT NOW() AS n')).rows[0].n).getTime();
}
function dayKeyAt(ms: number, _daypart = 'afternoon'): string {
  // The 30-min slot at or after `ms`, as the slot key the server stores.
  return new Date(Math.ceil(ms / 1_800_000) * 1_800_000).toISOString().replace('.000Z', 'Z');
}

/** No horizontal scroll anywhere on the page. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `${label}: horizontal overflow of ${over}px`).toBeLessThanOrEqual(1);
}

/** Every visible button in the thread header + pinned card is at least 44px tall. */
async function expectTapTargets(page: Page, label: string) {
  const sizes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && b.offsetParent !== null; })
      .filter((b) => /Join|Call|Accept|Decline|Send request|Find a time|More actions|Add to calendar|video call|audio call/i.test(b.getAttribute('aria-label') || b.textContent || ''))
      .map((b) => ({ label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40), h: Math.round(b.getBoundingClientRect().height), w: Math.round(b.getBoundingClientRect().width) })),
  );
  for (const s of sizes) {
    expect(s.h, `${label}: "${s.label}" is only ${s.h}px tall`).toBeGreaterThanOrEqual(44);
  }
}

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  a = await createTestUser('layouta');
  b = await createTestUser('layoutb');
  await pool.query(`UPDATE users SET display_name=$1, job_title=$2, company=$3 WHERE id=$4`, ['Ana Rivera', 'Product Lead', 'Northwind', a.id]);
  await pool.query(`UPDATE users SET display_name=$1, job_title=$2, company=$3 WHERE id=$4`, ['Bo Meyer', 'Founder', 'Lumen', b.id]);
  const sent = await apiAs(a, 'POST', '/pokes', { recipientId: b.id, message: 'Coffee?' });
  await apiAs(b, 'POST', `/pokes/${sent.json.data.id}/accept`);
  convId = (await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`, [a.id, b.id],
  )).rows[0].id;
  // A confirmed meeting 3 days out (locked state shows the pinned card).
  const KEY = futureWindowKey(3, 'afternoon');
  await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] });
  await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] });
  await apiAs(a, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, {
    window: KEY, startAt: new Date(`${KEY.split(':')[0]}T15:30:00`).toISOString(), durationMin: 45, type: 'video',
  });
  browser = await launchBrowser();
});

// Close every page after each test, pass or fail — a failed test must not leave
// contexts (and their sockets/polls) piling up and slowing the next widths.
test.afterEach(async () => {
  for (const c of ctxs.splice(0)) { try { await c.close(); } catch { /* noop */ } }
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanup(pool, { ids: [a.id, b.id] });
  await cleanupByPrefix(pool, 'e2etest-layout');
  await pool.end().catch(() => {});
});

for (const vp of WIDTHS) {
  test(`locked chat (scheduler, no calls) fits at ${vp.name}`, async () => {
    test.setTimeout(90_000);
    const page = await pageAt(a, `/messages/${convId}`, vp);
    await expect(page.getByTestId('thread-meeting-banner')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole('button', { name: /Start a video call now|Start an audio call now/i })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, `locked ${vp.name}`);
    await expectTapTargets(page, `locked ${vp.name}`);
    await page.screenshot({ path: path.join(OUT, `locked-${vp.name}.png`) });
    // The pinned Join card's button is fully inside the viewport.
    const join = page.getByTestId('thread-meeting-banner').getByRole('button', { name: /^Join$/ });
    const box = await join.boundingBox();
    expect(box, 'Join button has a box').toBeTruthy();
    expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);
    await page.close();
  });
}

test('unlock calls for the layout pair', async () => {
  test.setTimeout(60_000);
  const now = await serverNowMs();
  const TODAY = dayKeyAt(now);
  await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [TODAY] });
  await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [TODAY] });
  const confirmed = await apiAs(a, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, {
    window: TODAY, startAt: new Date(now + 2 * 60_000).toISOString(), durationMin: 30, type: 'video',
  });
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  await apiAs(a, 'POST', `/dm/conversations/${convId}/call-token`, { kind: 'video' });
  await apiAs(b, 'POST', `/dm/conversations/${convId}/call-token`, { kind: 'video' });
  expect((await apiAs(a, 'GET', `/dm/conversations/${convId}/scheduling`)).json.data.callsUnlocked).toBe(true);
});

for (const vp of WIDTHS) {
  test(`unlocked chat + request dialog fit at ${vp.name}`, async () => {
    test.setTimeout(120_000);
    // B online so the call buttons are enabled.
    const bPage = await pageAt(b, '/', { width: 800, height: 600 });
    await bPage.waitForTimeout(2000);
    const page = await pageAt(a, `/messages/${convId}`, vp);
    await expect(page.getByTestId('partner-presence')).toContainText(/Online/i, { timeout: 35_000 });
    // Evidence either way: what the API says, and what the screen shows, right
    // before asserting the scheduler has stepped aside.
    const sched = await apiAs(a, 'GET', `/dm/conversations/${convId}/scheduling`);
    console.log(`[layout ${vp.name}] API callsUnlocked=${sched.json?.data?.callsUnlocked}`);
    await page.screenshot({ path: path.join(OUT, `unlocked-${vp.name}-pre.png`) });
    await expect(page.getByRole('button', { name: /Find a time to meet/i })).toHaveCount(0, { timeout: 20_000 });
    await expectNoHorizontalOverflow(page, `unlocked ${vp.name}`);
    await expectTapTargets(page, `unlocked ${vp.name}`);
    await page.screenshot({ path: path.join(OUT, `unlocked-${vp.name}.png`) });

    // Open the request dialog (header button on ≥640px, More-actions menu below).
    const desktopBtn = page.getByRole('button', { name: /Start a video call now/i });
    if (await desktopBtn.isVisible().catch(() => false)) {
      await expect(desktopBtn).toBeEnabled({ timeout: 35_000 });
      await desktopBtn.click();
    } else {
      await page.getByRole('button', { name: /More actions/i }).click();
      const item = page.getByRole('button', { name: /^Video call now$/ });
      await expect(item).toBeEnabled({ timeout: 35_000 });
      await item.click();
    }
    await expect(page.locator('#call-minutes')).toBeVisible({ timeout: 10_000 });
    await page.locator('#call-minutes').fill('15');
    await expectNoHorizontalOverflow(page, `request dialog ${vp.name}`);
    const send = page.getByRole('button', { name: /Send request/i });
    const sb = await send.boundingBox();
    expect(sb, 'Send request has a box').toBeTruthy();
    expect(sb!.y + sb!.height, `${vp.name}: Send request sits inside the viewport`).toBeLessThanOrEqual(vp.height + 1);
    await page.screenshot({ path: path.join(OUT, `request-${vp.name}.png`) });
    await page.close();
    await bPage.close();
  });
}

for (const vp of WIDTHS) {
  test(`call room fits at ${vp.name}`, async () => {
    test.setTimeout(90_000);
    const page = await pageAt(a, `/meet/${convId}?kind=video`, vp);
    await expect(page.getByText(/^Video call$/)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(3000);
    await expectNoHorizontalOverflow(page, `call room ${vp.name}`);
    // The control bar (leave button) is inside the viewport — no overlap with the stage.
    const leave = page.locator('.lk-disconnect-button, button[aria-label*="Disconnect" i], button:has-text("Leave")').first();
    if (await leave.isVisible().catch(() => false)) {
      const lb = await leave.boundingBox();
      expect(lb!.y + lb!.height).toBeLessThanOrEqual(vp.height + 1);
    }
    await page.screenshot({ path: path.join(OUT, `room-${vp.name}.png`) });
    await page.close();
  });
}
