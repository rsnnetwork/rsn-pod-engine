import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// The whole meeting loop, as two people actually live it (Shradha's deck, P0).
//
// 19 Sep: "SO HOW DO WE DO THAT, we both have saved our availability?" —
// "I have no clue!!!". Saving wrote rows and told nobody, so the thread stayed
// silent while both sides waited for the other to act.
//
// Ana is on a laptop, Bo on a phone, in different timezones. Nobody reloads
// anything: every step has to arrive on the other screen on its own.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let ana: TestUser, bo: TestUser;
let convId: string;
let SLOT: string;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string, viewport: { width: number; height: number }, timezoneId: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport, timezoneId });
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

function futureSlot(daysAhead: number, hour: number, minute = 0): string {
  const dt = new Date();
  dt.setHours(hour, minute, 0, 0);
  dt.setDate(dt.getDate() + daysAhead);
  return dt.toISOString().replace('.000Z', 'Z');
}

async function openScheduler(page: Page): Promise<void> {
  const findTime = page.getByRole('button', { name: /Find a time to meet/i });
  const more = page.getByRole('button', { name: 'More actions' });
  await findTime.or(more).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (await more.isVisible().catch(() => false)) await more.click();
  await findTime.filter({ visible: true }).first().click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
}

const cards = (page: Page) => page.getByTestId('system-message-card');

/**
 * The timeline shows ONE day at a time, and opens on the first day that has
 * something worth seeing. A time three days out is simply not in the page
 * until its day is picked — and which day that is depends on the reader's
 * timezone, so it is different for Ana in Oslo and Bo in Karachi. Walk the day
 * strip until the time appears, the way a person scanning the week would.
 */
async function selectDayFor(page: Page, slot: string): Promise<void> {
  const target = page.locator(`[data-slot="${slot}"]`);
  if (await target.count()) return;
  const days = page.locator('[role="tablist"][aria-label="Day"] [data-day]');
  const n = await days.count();
  for (let i = 0; i < n; i++) {
    await days.nth(i).click();
    await page.waitForTimeout(150);
    if (await target.count()) return;
  }
  throw new Error(`no day in the strip holds ${slot}`);
}

/** Bring a time into reach, scrolling the panel the way a person would. */
async function reachSlot(page: Page, slot: string, label: string): Promise<void> {
  await selectDayFor(page, slot);
  const target = page.locator(`[data-slot="${slot}"]`);
  for (let i = 0; i < 8; i++) {
    if (await expectReachable(page, target, 'probe').then(() => true, () => false)) break;
    const anchor = await page.locator('label[for="meeting-minutes"]').boundingBox();
    if (!anchor) break;
    await page.mouse.move(anchor.x + 4, Math.max(1, anchor.y + 4));
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(250);
  }
  await tapReachable(page, target, label);
}

test.beforeAll(async () => {
  ana = await createTestUser('mlana');
  bo = await createTestUser('mlbo');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Ana', ana.id]);
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Bo', bo.id]);
  console.log(`[meeting-loop] engine=${engineLabel()} app=${APP}`);

  const sent = await apiAs(ana, 'POST', '/pokes', { recipientId: bo.id, message: 'Coffee?' });
  expect(sent.status).toBe(201);
  expect((await apiAs(bo, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
  const conv = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
    [ana.id, bo.id],
  );
  convId = conv.rows[0]?.id;
  expect(convId).toBeTruthy();
  SLOT = futureSlot(3, 14);

  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  await cleanup(pool, { ids: [ana.id, bo.id] });
  await cleanupByPrefix(pool, 'e2etest-ml');
  await pool.end().catch(() => {});
});

test('two people go from silence to a confirmed meeting, each step arriving on both screens', async () => {
  test.setTimeout(300_000);

  // Both are looking at the thread the whole way through. Nothing below
  // reloads either page.
  const anaPage = await openAs(ana, `/messages/${convId}`, { width: 1366, height: 768 }, 'Europe/Oslo');
  const boPage = await openAs(bo, `/messages/${convId}`, { width: 390, height: 844 }, 'Asia/Karachi');
  await expect(cards(anaPage)).toHaveCount(0);
  await expect(cards(boPage)).toHaveCount(0);

  // ── 1. Ana shares her times. The thread says so, on BOTH screens.
  await openScheduler(anaPage);
  await reachSlot(anaPage, SLOT, 'Ana: the time she can meet');
  await tapReachable(anaPage, anaPage.getByRole('button', { name: /Save and send availability/i }), 'Ana: "Save and send availability"');
  await expect(anaPage.getByText(/Sent — they can see when you are free/i)).toBeVisible({ timeout: 20_000 });

  await expect(cards(boPage).filter({ hasText: /shared times they can meet/i }))
    .toBeVisible({ timeout: 30_000 });
  console.log('  ✓ Bo was told, without reloading');
  await expect(cards(anaPage).filter({ hasText: /shared times they can meet/i })).toBeVisible();

  // The inbox preview never says "You: Loop Ana shared times…" — nobody wrote it.
  await expect(boPage.locator('text=/You: Loop Ana shared/')).toHaveCount(0);

  // ── 2. Bo picks the same time. Now they can both meet, and both are told.
  await openScheduler(boPage);
  await reachSlot(boPage, SLOT, 'Bo: the same time, from a different timezone');
  await tapReachable(boPage, boPage.getByRole('button', { name: /Save and send availability/i }), 'Bo: "Save and send availability"');

  const proposal = /You are both free/i;
  await expect(cards(boPage).filter({ hasText: proposal })).toBeVisible({ timeout: 30_000 });
  await expect(cards(anaPage).filter({ hasText: proposal })).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ both sides told they can meet, neither reloaded');

  // Exactly one proposal card, however the saves landed.
  const rows = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM direct_messages
     WHERE conversation_id=$1 AND kind='system' AND system_meta->>'type'='meeting_proposal'`,
    [convId],
  );
  expect(rows.rows[0].n).toBe('1');

  // Sending ended the job: the panel is gone and the chat is back, with the
  // card it just wrote in it. Nothing traps them any more.
  await expect(boPage.getByTestId('meeting-scheduler')).toHaveCount(0);
  await expect(anaPage.getByTestId('meeting-scheduler')).toHaveCount(0);

  // ── 3. Bo confirms from the card in the chat, on a phone.
  await tapReachable(boPage, cards(boPage).filter({ hasText: proposal }).getByRole('button').first(), 'Bo: the proposed time');
  await expect(boPage.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
  await tapReachable(boPage, boPage.getByTestId('overlap-list').getByRole('button', { name: /^Confirm / }).first(), 'Bo: green time chip');
  await tapReachable(boPage, boPage.getByRole('button', { name: /^Confirm meeting$/ }), 'Bo: "Confirm meeting"');

  // ── 4. The meeting exists, for both, each in their OWN local time.
  const confirmed = /Meeting confirmed/i;
  await expect(cards(boPage).filter({ hasText: confirmed })).toBeVisible({ timeout: 30_000 });
  await expect(cards(anaPage).filter({ hasText: confirmed })).toBeVisible({ timeout: 30_000 });

  const boCard = cards(boPage).filter({ hasText: confirmed });
  await expect(boCard.getByRole('button', { name: /Join meeting/i })).toBeVisible();
  await expect(boCard.getByRole('button', { name: /Add to calendar/i })).toBeVisible();

  const localIn = (tz: string) => new Date(SLOT).toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  await expect(boCard).toContainText(localIn('Asia/Karachi').replace(/^0/, ''));
  await expect(cards(anaPage).filter({ hasText: confirmed })).toContainText(localIn('Europe/Oslo').replace(/^0/, ''));
  console.log(`  ✓ same meeting, Oslo ${localIn('Europe/Oslo')} and Karachi ${localIn('Asia/Karachi')}`);
  // Nobody sees a raw timestamp.
  await expect(boCard).not.toContainText(/\d{4}-\d{2}-\d{2}T/);

  // ── 5. The database holds ONE meeting and ONE confirmation card.
  const row = (await pool.query<{ meeting_start_at: Date | null; cards: string }>(
    `SELECT c.meeting_start_at,
            (SELECT count(*)::text FROM direct_messages m
             WHERE m.conversation_id=c.id AND m.kind='system'
               AND m.system_meta->>'type'='meeting_confirmed') AS cards
     FROM dm_conversations c WHERE c.id=$1`, [convId],
  )).rows[0];
  expect(row.meeting_start_at?.toISOString().replace('.000Z', 'Z')).toBe(SLOT);
  expect(row.cards).toBe('1');
});

test('confirming the same time twice books one meeting, not two', async () => {
  // Its own pair, so this stands alone whatever the UI test did.
  const x = await createTestUser('mlx');
  const y = await createTestUser('mly');
  try {
    const sent = await apiAs(x, 'POST', '/pokes', { recipientId: y.id, message: 'Hi' });
    expect((await apiAs(y, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
    const conv = (await pool.query<{ id: string }>(
      `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
      [x.id, y.id],
    )).rows[0].id;
    const slot = futureSlot(6, 10);
    expect((await apiAs(x, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot] })).status).toBe(200);
    expect((await apiAs(y, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot] })).status).toBe(200);

    // Both press Confirm at the same instant, on the same time.
    const [a, b] = await Promise.all([
      apiAs(x, 'POST', `/dm/conversations/${conv}/scheduling/confirm`, { window: slot, durationMin: 30, type: 'video' }),
      apiAs(y, 'POST', `/dm/conversations/${conv}/scheduling/confirm`, { window: slot, durationMin: 30, type: 'video' }),
    ]);
    console.log(`  simultaneous confirms: ${a.status} and ${b.status}`);
    expect([200, 409]).toContain(a.status);
    expect([200, 409]).toContain(b.status);

    // One meeting, and one card announcing it.
    const row = (await pool.query<{ n: string; start: Date | null }>(
      `SELECT (SELECT count(*)::text FROM direct_messages m
               WHERE m.conversation_id=c.id AND m.kind='system'
                 AND m.system_meta->>'type'='meeting_confirmed') AS n,
              c.meeting_start_at AS start
       FROM dm_conversations c WHERE c.id=$1`, [conv],
    )).rows[0];
    expect(row.start?.toISOString().replace('.000Z', 'Z')).toBe(slot);
    expect(row.n).toBe('1');

    // A DIFFERENT time while that one stands is refused, with the time that is set.
    const other = futureSlot(6, 11);
    await apiAs(x, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot, other] });
    await apiAs(y, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot, other] });
    const clash = await apiAs(x, 'POST', `/dm/conversations/${conv}/scheduling/confirm`, { window: other, durationMin: 30, type: 'video' });
    expect(clash.status).toBe(409);
    expect(String(clash.json?.error?.message)).toMatch(/already set/i);
  } finally {
    await cleanup(pool, { ids: [x.id, y.id] });
  }
});

test('a time that has since passed never blocks saving again', async () => {
  // Exactly how time does it: a row that was fine when it was saved, now past.
  const stale = new Date(Date.now() - 3 * 3_600_000);
  stale.setMinutes(stale.getMinutes() < 30 ? 0 : 30, 0, 0);
  const staleKey = stale.toISOString().replace('.000Z', 'Z');
  await pool.query(
    `INSERT INTO meeting_availability (conversation_id, user_id, window_key)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [convId, ana.id, staleKey],
  );

  // The client re-sends everything it has, the stale one included.
  const res = await apiAs(ana, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, {
    windows: [staleKey, futureSlot(4, 15)],
  });
  expect(res.status, 'saving still works the morning after').toBe(200);
  expect(res.json.data.mine).not.toContain(staleKey);
  expect(res.json.data.mine).toContain(futureSlot(4, 15));
});

test('someone who has been blocked cannot arrange a meeting', async () => {
  const third = await createTestUser('mlblk');
  try {
    const sent = await apiAs(ana, 'POST', '/pokes', { recipientId: third.id, message: 'Hi' });
    expect(sent.status).toBe(201);
    expect((await apiAs(third, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
    const conv = await pool.query<{ id: string }>(
      `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
      [ana.id, third.id],
    );
    const blockedConv = conv.rows[0].id;
    await pool.query(
      `INSERT INTO user_blocks (id, blocker_id, blocked_id) VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT DO NOTHING`,
      [third.id, ana.id],
    );
    const res = await apiAs(ana, 'PUT', `/dm/conversations/${blockedConv}/scheduling/availability`, { windows: [futureSlot(5, 11)] });
    expect(res.status).toBe(403);
  } finally {
    await pool.query(`DELETE FROM user_blocks WHERE blocker_id=$1 OR blocked_id=$1`, [third.id]);
    await cleanup(pool, { ids: [third.id] });
  }
});
