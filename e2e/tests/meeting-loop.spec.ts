import { test, expect, Browser, BrowserContext, Page, Locator } from '@playwright/test';
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
//
// 25 Oct 2026 (Stefan and Claus on production): both saved the same time, the
// server said "pick a time to confirm", nobody found the control that books,
// and no meeting existed. The same time picked by both is now the agreement:
// the save that leaves exactly one shared time books it, and says so ("Meeting
// confirmed: Sun 25 Oct, 13:00"). Two or more shared times still get the
// proposal card, whose time opens the confirm card for that very time (the
// second test); "the green" in the timeline does the same, and nothing picked
// or typed is dropped without a word (the third).
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
/** Toasts that are not errors (a success or a note) live in the page's status region. */
const toast = (page: Page, text: string) => page.getByRole('status').getByText(text, { exact: true });
/** Error toasts live in the alert region. */
const alertToast = (page: Page, text: string) => page.getByRole('alert').getByText(text, { exact: true });
/** An instant as the server writes a slot key: "2026-10-29T09:00:00Z". */
const slotOf = (at: string) => new Date(at).toISOString().replace('.000Z', 'Z');

/** A time on a reader's own clock, 24-hour, as the scheduler and the cards write it: "13:00". */
function timeIn(slot: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(slot));
}
/** Its day and time, "Sun 25 Oct, 13:00" (the toasts and the confirm card). */
function labelIn(slot: string, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(slot)).map(x => [x.type, x.value]));
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p.weekday} ${Number(p.day)} ${months[Number(p.month) - 1]}, ${timeIn(slot, tz)}`;
}

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

/**
 * Wait until a target has stopped moving. A wheel scroll is animated, and a tap
 * measured while the panel is still gliding lands on the time next to it.
 */
async function stillAt(target: Locator): Promise<void> {
  let last = '';
  for (let i = 0; i < 20; i++) {
    const box = await target.boundingBox();
    const at = box ? `${Math.round(box.x)},${Math.round(box.y)}` : 'none';
    if (at === last) return;
    last = at;
    await target.page().waitForTimeout(100);
  }
}

/** Bring a time into reach, scrolling the panel the way a person would. */
async function reachSlot(page: Page, slot: string, label: string): Promise<void> {
  await selectDayFor(page, slot);
  const target = page.locator(`[data-slot="${slot}"]`);
  for (let i = 0; i < 8; i++) {
    await stillAt(target);
    if (await expectReachable(page, target, 'probe').then(() => true, () => false)) break;
    const anchor = await page.getByTestId('scheduler-zone').boundingBox();
    if (!anchor) break;
    await page.mouse.move(anchor.x + 4, Math.max(1, anchor.y + 4));
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(250);
  }
  await stillAt(target);
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

test('two people go from silence to a booked meeting, each step arriving on both screens', async () => {
  test.setTimeout(300_000);

  // Both are looking at the thread the whole way through. Nothing below
  // reloads either page.
  const anaPage = await openAs(ana, `/messages/${convId}`, { width: 1366, height: 768 }, 'Europe/Oslo');
  const boPage = await openAs(bo, `/messages/${convId}`, { width: 390, height: 844 }, 'Asia/Karachi');
  await expect(cards(anaPage)).toHaveCount(0);
  await expect(cards(boPage)).toHaveCount(0);

  // ── 1. Ana shares her times. The thread says so, on BOTH screens.
  await openScheduler(anaPage);
  // The zone is named over the times, and nothing that has started is offered.
  await expect(anaPage.getByTestId('scheduler-zone')).toHaveText(/^Times in your time zone: Central European (Standard |Summer )?Time \(CES?T\)$/);
  const offered = await anaPage.locator('[data-slot]').evaluateAll(els => els.map(e => e.getAttribute('data-slot') ?? ''));
  expect(offered.every(k => Date.parse(k) > Date.now()), 'only times still ahead are offered').toBe(true);
  await reachSlot(anaPage, SLOT, 'Ana: the time she can meet');
  await tapReachable(anaPage, anaPage.getByRole('button', { name: /Save and send availability/i }), 'Ana: "Save and send availability"');
  await expect(toast(anaPage, 'Sent. They can see when you are free.')).toBeVisible({ timeout: 20_000 });

  await expect(cards(boPage).filter({ hasText: /shared times they can meet/i }))
    .toBeVisible({ timeout: 30_000 });
  console.log('  ✓ Bo was told, without reloading');
  await expect(cards(anaPage).filter({ hasText: /shared times they can meet/i })).toBeVisible();

  // The inbox preview never says "You: Loop Ana shared times…" — nobody wrote it.
  await expect(boPage.locator('text=/You: Loop Ana shared/')).toHaveCount(0);

  // ── 2. Bo picks the same time and saves. That is the agreement: the meeting
  //       is booked by the save itself, and both are told, with nothing more to press.
  await openScheduler(boPage);
  const boCell = boPage.locator(`[data-slot="${SLOT}"]`);
  await selectDayFor(boPage, SLOT);
  await expect(boCell).toHaveAttribute('aria-label', `${timeIn(SLOT, 'Asia/Karachi')}, they can`);
  await reachSlot(boPage, SLOT, 'Bo: the same time, from a different timezone');
  // Picked but not sent: it is still his own pick, not yet the agreement.
  await expect(boCell).toHaveAttribute('aria-label', `${timeIn(SLOT, 'Asia/Karachi')}, you both can, not sent yet`);
  await tapReachable(boPage, boPage.getByRole('button', { name: /Save and send availability/i }), 'Bo: "Save and send availability"');
  // The save says what it did, in Bo's own time.
  await expect(toast(boPage, `Meeting confirmed: ${labelIn(SLOT, 'Asia/Karachi')}`)).toBeVisible({ timeout: 20_000 });

  // Sending ended the job: the panel is gone and the chat is back, with the
  // card the save wrote in it. Nothing traps them any more.
  await expect(boPage.getByTestId('meeting-scheduler')).toHaveCount(0);
  await expect(anaPage.getByTestId('meeting-scheduler')).toHaveCount(0);

  // ── 3. The meeting exists, for both, each in their OWN local time.
  const confirmed = /Meeting confirmed/i;
  await expect(cards(boPage).filter({ hasText: confirmed })).toBeVisible({ timeout: 30_000 });
  await expect(cards(anaPage).filter({ hasText: confirmed })).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ the save booked it; both sides see the meeting, neither reloaded');
  // No "pick one to confirm" step was left in front of either of them.
  await expect(cards(boPage).filter({ hasText: /You are both free/i })).toHaveCount(0);
  await expect(cards(anaPage).filter({ hasText: /You are both free/i })).toHaveCount(0);

  const boCard = cards(boPage).filter({ hasText: confirmed });
  await expect(boCard.getByRole('button', { name: /Join meeting/i })).toBeVisible();
  await expect(boCard.getByRole('button', { name: /Add to calendar/i })).toBeVisible();

  await expect(boCard).toContainText(labelIn(SLOT, 'Asia/Karachi'));
  await expect(cards(anaPage).filter({ hasText: confirmed })).toContainText(labelIn(SLOT, 'Europe/Oslo'));
  console.log(`  ✓ same meeting, Oslo ${labelIn(SLOT, 'Europe/Oslo')} and Karachi ${labelIn(SLOT, 'Asia/Karachi')}`);
  // Nobody sees a raw timestamp.
  await expect(boCard).not.toContainText(/\d{4}-\d{2}-\d{2}T/);
  // The pinned banner shows the meeting with Join as soon as the scheduling says it is confirmed,
  // and opens the meeting's own page.
  const anaBanner = anaPage.getByTestId('thread-meeting-banner');
  await expect(anaBanner.getByRole('button', { name: /^Join$/ })).toBeVisible({ timeout: 30_000 });
  await expect(anaBanner.locator('a[href^="/meetings/"]')).toBeVisible();

  // ── 4. The database holds ONE meeting, booked by Bo's save, 30 minutes of
  //       video (production's scheduler sends no length), ONE confirmation card,
  //       no proposal card, and Ana's bell says the time is confirmed.
  const row = (await pool.query<{
    meeting_start_at: Date | null; meeting_duration_min: number | null; meeting_type: string | null;
    meeting_confirmed_by: string | null; cards: string; proposals: string;
  }>(
    `SELECT c.meeting_start_at, c.meeting_duration_min, c.meeting_type, c.meeting_confirmed_by,
            (SELECT count(*)::text FROM direct_messages m
             WHERE m.conversation_id=c.id AND m.kind='system'
               AND m.system_meta->>'type'='meeting_confirmed') AS cards,
            (SELECT count(*)::text FROM direct_messages m
             WHERE m.conversation_id=c.id AND m.kind='system'
               AND m.system_meta->>'type'='meeting_proposal') AS proposals
     FROM dm_conversations c WHERE c.id=$1`, [convId],
  )).rows[0];
  expect(row.meeting_start_at?.toISOString().replace('.000Z', 'Z')).toBe(SLOT);
  expect([row.meeting_duration_min, row.meeting_type, row.meeting_confirmed_by]).toEqual([30, 'video', bo.id]);
  expect(row.cards).toBe('1');
  expect(row.proposals).toBe('0');
  const anaBell = await pool.query<{ title: string }>(
    `SELECT title FROM notifications WHERE user_id=$1 AND type='meeting_confirmed'`, [ana.id]);
  expect(anaBell.rows.map(r => r.title)).toEqual(['Meeting time confirmed']);
});

test('when two times are shared, the card\'s time opens the confirm card on that time, and Confirm books it', async () => {
  test.setTimeout(240_000);
  // Its own pair: two shared times are not an agreement on one, so nothing is booked by the saves.
  const cy = await createTestUser('mlcy');
  const di = await createTestUser('mldi');
  try {
    await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Cy', cy.id]);
    await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Di', di.id]);
    const sent = await apiAs(cy, 'POST', '/pokes', { recipientId: di.id, message: 'Coffee?' });
    expect((await apiAs(di, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
    const conv = (await pool.query<{ id: string }>(
      `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
      [cy.id, di.id],
    )).rows[0].id;
    const early = futureSlot(4, 10);
    const late = futureSlot(4, 16);
    expect((await apiAs(cy, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [early, late] })).status).toBe(200);
    const second = await apiAs(di, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [early, late] });
    expect(second.status).toBe(200);
    expect(second.json.data.confirmed, 'two shared times book nothing').toBeNull();
    expect(second.json.data.overlap).toEqual([early, late]);

    const cyPage = await openAs(cy, `/messages/${conv}`, { width: 1366, height: 768 }, 'Europe/Oslo');
    const diPage = await openAs(di, `/messages/${conv}`, { width: 390, height: 844 }, 'Asia/Karachi');
    const proposal = /You are both free/i;
    await expect(cards(diPage).filter({ hasText: proposal })).toBeVisible({ timeout: 30_000 });

    // Di confirms from the card in the chat, on a phone: the card's time opens the
    // confirm card for THAT time (on 25 Oct it threw the time away and only opened
    // the panel), then Confirm meeting.
    const cardTime = cards(diPage).filter({ hasText: proposal }).getByRole('button', { name: labelIn(early, 'Asia/Karachi') });
    await tapReachable(diPage, cardTime, 'Di: the proposed time');
    await expect(diPage.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
    const confirmCard = diPage.getByTestId('confirm-card');
    await expect(confirmCard).toContainText(labelIn(early, 'Asia/Karachi'));
    await tapReachable(diPage, confirmCard.getByRole('button', { name: /^Confirm meeting$/ }), 'Di: "Confirm meeting"');
    await expect(toast(diPage, `Meeting confirmed: ${labelIn(early, 'Asia/Karachi')}`)).toBeVisible({ timeout: 20_000 });

    const confirmed = /Meeting confirmed/i;
    await expect(cards(diPage).filter({ hasText: confirmed })).toBeVisible({ timeout: 30_000 });
    await expect(cards(cyPage).filter({ hasText: confirmed })).toBeVisible({ timeout: 30_000 });

    const row = (await pool.query<{ meeting_start_at: Date | null; cards: string; proposals: string }>(
      `SELECT c.meeting_start_at,
              (SELECT count(*)::text FROM direct_messages m WHERE m.conversation_id=c.id AND m.kind='system'
                 AND m.system_meta->>'type'='meeting_confirmed') AS cards,
              (SELECT count(*)::text FROM direct_messages m WHERE m.conversation_id=c.id AND m.kind='system'
                 AND m.system_meta->>'type'='meeting_proposal') AS proposals
         FROM dm_conversations c WHERE c.id=$1`, [conv],
    )).rows[0];
    expect(row.meeting_start_at?.toISOString().replace('.000Z', 'Z')).toBe(early);
    expect(row.cards).toBe('1');
    expect(row.proposals).toBe('1');
    console.log('  ✓ two shared times: one proposal card, then Confirm booked the time picked');
  } finally {
    await cleanup(pool, { ids: [cy.id, di.id] });
  }
});

test('"the green" in the timeline opens the confirm card, and nothing picked or typed is dropped without a word', async () => {
  test.setTimeout(240_000);
  // 25 Oct: in the reopened panel "the green" 13:00 cell was a toggle, and tapping
  // it took back the pick that had made it green. A time typed into "Another time"
  // and left vanished, and a tap outside the panel threw unsent picks away silently.
  const ev = await createTestUser('mlev');
  const fi = await createTestUser('mlfi');
  try {
    await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Ev', ev.id]);
    await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Fi', fi.id]);
    const sent = await apiAs(ev, 'POST', '/pokes', { recipientId: fi.id, message: 'Coffee?' });
    expect((await apiAs(fi, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
    const conv = (await pool.query<{ id: string }>(
      `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
      [ev.id, fi.id],
    )).rows[0].id;
    const green = futureSlot(2, 11);
    const other = futureSlot(2, 15);
    const free = futureSlot(2, 17, 30);
    await apiAs(ev, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [green, other] });
    await apiAs(fi, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [green, other] });

    const TZ = 'Asia/Karachi';
    const page = await openAs(fi, `/messages/${conv}`, { width: 390, height: 844 }, TZ);
    await openScheduler(page);

    // The green cell is the confirm control: it opens the card for its own time and removes nothing.
    await selectDayFor(page, green);
    const cell = page.locator(`[data-slot="${green}"]`);
    await expect(cell).toHaveAttribute('aria-label', `Confirm ${timeIn(green, TZ)}, you both can`);
    await reachSlot(page, green, 'Fi: the green time');
    const confirmCard = page.getByTestId('confirm-card');
    await expect(confirmCard).toContainText(labelIn(green, TZ));
    await expect(cell).toHaveAttribute('aria-label', `Confirm ${timeIn(green, TZ)}, you both can`);
    // Its length and kind live on the card.
    await expect(confirmCard.locator('#meeting-minutes')).toHaveValue('30');
    await expect(confirmCard.getByRole('button', { name: 'Video' })).toHaveAttribute('aria-pressed', 'true');
    await tapReachable(page, confirmCard.getByRole('button', { name: 'Cancel' }), 'Fi: Cancel');

    // An unsent pick, then a tap outside the panel: it asks, and Discard means discard.
    await reachSlot(page, free, 'Fi: a free time');
    await page.getByPlaceholder(/^(Type a message\.\.\.|Message…)$/).click();
    await expect(page.getByText('Send your times?', { exact: true })).toBeVisible();
    await expect(page.getByTestId('meeting-scheduler')).toBeVisible();
    await tapReachable(page, page.getByRole('button', { name: 'Discard', exact: true }), 'Fi: Discard');
    await expect(page.getByTestId('meeting-scheduler')).toHaveCount(0);
    await openScheduler(page);
    await selectDayFor(page, free);
    await expect(page.locator(`[data-slot="${free}"]`)).toHaveAttribute('aria-pressed', 'false');

    // A typed time, then Escape from the box: it asks, and the press on Discard is the answer, the first time.
    // (The box used to lose the focus on that press, add the time, and take the question away under the pointer.)
    const typedBox = page.locator('#custom-time');
    await typedBox.fill(timeIn(free, TZ));
    await typedBox.press('Escape');
    await expect(page.getByText('Send your times?', { exact: true })).toBeVisible();
    await tapReachable(page, page.getByRole('button', { name: 'Discard', exact: true }), 'Fi: Discard after Escape');
    await expect(page.getByTestId('meeting-scheduler')).toHaveCount(0);
    await openScheduler(page);
    await selectDayFor(page, free);
    await expect(page.locator(`[data-slot="${free}"]`)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#custom-time')).toHaveValue('');

    // A typed time with neither Add time nor Enter: it counts as unsent, and Save sends it.
    await page.locator('#custom-time').fill(timeIn(free, TZ));
    await tapReachable(page, page.getByRole('button', { name: /Save and send availability/i }), 'Fi: Save');
    // Two times are shared and nothing is booked, so the panel stays on the confirm step.
    await expect(toast(page, 'You can both meet. Confirm a time.')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('overlap-list')).toBeVisible();
    const saved = await apiAs(fi, 'GET', `/dm/conversations/${conv}/scheduling`);
    expect(saved.json.data.mine).toEqual(expect.arrayContaining([green, other, free]));
    const row = (await pool.query<{ meeting_start_at: Date | null }>(`SELECT meeting_start_at FROM dm_conversations WHERE id=$1`, [conv])).rows[0];
    expect(row.meeting_start_at, 'nothing was booked by any of this').toBeNull();
    console.log('  ✓ the green cell opened the confirm card; an unsent pick was asked about; a typed time was sent');
  } finally {
    await cleanup(pool, { ids: [ev.id, fi.id] });
  }
});

test('Reschedule (?schedule=1) opens the scheduler ready for a pick, even for a pair that has met; one new time picked by both opens the Move card, and Move moves the meeting with its length and kind', async () => {
  test.setTimeout(240_000);
  // A meeting's page (Events) has Reschedule, which opens the chat with ?schedule=1.
  // Once a pair has met, the chat offers calls and no scheduler, so Reschedule
  // would have landed on nothing. It opens the scheduler for every pair, once
  // (the flag is replaced, so Back does not open it again). A save never moves
  // a meeting (the server's rule): the save that leaves one new time both can
  // opens the Move card on it, with the meeting's own length and kind, and the
  // meeting moves when that person presses Move.
  const gu = await createTestUser('mlgu');
  const ha = await createTestUser('mlha');
  try {
    await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Gu', gu.id]);
    await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Ha', ha.id]);
    const sent = await apiAs(gu, 'POST', '/pokes', { recipientId: ha.id, message: 'Coffee?' });
    expect((await apiAs(ha, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
    const conv = (await pool.query<{ id: string }>(
      `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
      [gu.id, ha.id],
    )).rows[0].id;
    const first = futureSlot(3, 9);
    const moved = futureSlot(3, 17);
    await apiAs(gu, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [first] });
    const booked = await apiAs(ha, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, {
      windows: [first], durationMin: 45, type: 'audio',
    });
    expect(booked.json.data.confirmed?.window, 'one shared time books the meeting').toBe(first);
    expect([booked.json.data.confirmed.durationMin, booked.json.data.confirmed.type]).toEqual([45, 'audio']);
    const meetingId = booked.json.data.confirmed.meetingId as string;
    expect(meetingId).toBeTruthy();
    // They have met before: calls are open, so the chat shows calls, not the scheduler.
    await pool.query(`UPDATE dm_conversations SET calls_unlocked_at = NOW() WHERE id = $1`, [conv]);

    const TZ = 'Asia/Karachi';
    // Gu, on a phone, presses Reschedule.
    const guPage = await openAs(gu, '/messages', { width: 390, height: 844 }, TZ);
    await gotoRetry(guPage, `${APP}/messages/${conv}?schedule=1`);
    await expect(guPage.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
    await expect(guPage).not.toHaveURL(/schedule=1/);
    // Ready for the first pick: a time that can be picked has the focus (not the booked one).
    await expect.poll(() => guPage.evaluate(() => document.activeElement?.getAttribute('data-slot') ?? null), { timeout: 10_000 })
      .not.toBeNull();
    expect(await guPage.evaluate(() => document.activeElement?.getAttribute('data-slot'))).not.toBe(first);
    await expect(guPage.locator(`[data-slot="${first}"]`)).toHaveAttribute('aria-label', `${timeIn(first, TZ)}, your meeting`);
    await reachSlot(guPage, moved, 'Gu: the new time');
    await tapReachable(guPage, guPage.getByRole('button', { name: /Save and send availability/i }), 'Gu: Save');
    await expect(toast(guPage, 'Sent. They can see when you are free.')).toBeVisible({ timeout: 20_000 });
    // Back does not open it again: the flag was replaced, not added.
    await guPage.goBack();
    await expect(guPage).toHaveURL(/\/messages$/);
    await guPage.goForward();
    await expect(guPage).toHaveURL(new RegExp(`/messages/${conv}$`));
    await expect(guPage.getByTestId('thread-meeting-banner')).toBeVisible({ timeout: 20_000 });
    await expect(guPage.getByTestId('meeting-scheduler')).toHaveCount(0);

    // Ha, on a laptop, presses Reschedule too, picks the same new time, and saves. The save moves nothing: it says
    // the move is there to make, and opens the Move card on that time with the meeting's 45 minutes of audio.
    const haPage = await openAs(ha, `/messages/${conv}?schedule=1`, { width: 1280, height: 800 }, TZ);
    await expect(haPage.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
    await reachSlot(haPage, moved, 'Ha: the same new time');
    await tapReachable(haPage, haPage.getByRole('button', { name: /Save and send availability/i }), 'Ha: Save');
    await expect(toast(haPage, `You can both meet at ${labelIn(moved, TZ)}. Move the meeting there?`)).toBeVisible({ timeout: 20_000 });
    await expect(haPage.getByText(/^Meeting (confirmed|moved): /)).toHaveCount(0);
    const moveCard = haPage.getByTestId('confirm-card');
    await expect(moveCard).toContainText(labelIn(moved, TZ));
    await expect(moveCard.locator('#meeting-minutes')).toHaveValue('45');
    await expect(moveCard.getByRole('button', { name: 'Audio' })).toHaveAttribute('aria-pressed', 'true');
    expect(slotOf((await apiAs(gu, 'GET', `/meetings/${meetingId}`)).json.data.startAt), 'the save itself moved nothing').toBe(first);
    await tapReachable(haPage, moveCard.getByRole('button', { name: 'Move meeting' }), 'Ha: Move meeting');
    await expect(toast(haPage, `Meeting moved: ${labelIn(moved, TZ)}`)).toBeVisible({ timeout: 20_000 });
    await expect(haPage.getByTestId('confirm-card')).toHaveCount(0);

    // The same meeting record, at the new time, still 45 minutes of audio.
    const record = await apiAs(gu, 'GET', `/meetings/${meetingId}`);
    expect(record.status).toBe(200);
    expect(slotOf(record.json.data.startAt)).toBe(moved);
    expect([record.json.data.durationMin, record.json.data.kind]).toEqual([45, 'audio']);
    // Gu's open chat shows the new time without a reload; the card for the old time says it moved and offers no Join.
    await expect(guPage.getByTestId('thread-meeting-banner')).toContainText(labelIn(moved, TZ), { timeout: 30_000 });
    await expect(guPage.getByTestId('thread-meeting-banner')).toContainText('Audio call · 45 min');
    const oldCard = cards(guPage).filter({ has: guPage.getByText('Meeting confirmed', { exact: true }) });
    await expect(oldCard.getByTestId('meeting-card-replaced')).toHaveText('This meeting moved to another time.', { timeout: 30_000 });
    await expect(oldCard.getByRole('button', { name: /Join meeting/i })).toHaveCount(0);
    await expect(cards(guPage).filter({ has: guPage.getByText('Meeting moved', { exact: true }) }).getByRole('button', { name: /Join meeting/i })).toBeVisible();
    console.log('  ✓ Reschedule opened the scheduler for a pair that has met; the save opened the Move card; Move moved it, 45 min audio');
  } finally {
    await cleanup(pool, { ids: [gu.id, ha.id] });
  }
});

test('a Move that fails leaves the meeting where it was, says so, and keeps the card open to try again', async () => {
  test.setTimeout(240_000);
  // Two failures: the connection drops as Move is pressed, and the partner takes
  // the time back before the panel has heard (the server's 409). Neither moves
  // anything; each says where the meeting still is, and the card stays for a retry.
  const iv = await createTestUser('mliv');
  const jo = await createTestUser('mljo');
  try {
    await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Iv', iv.id]);
    await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Loop Jo', jo.id]);
    const sent = await apiAs(iv, 'POST', '/pokes', { recipientId: jo.id, message: 'Coffee?' });
    expect((await apiAs(jo, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
    const conv = (await pool.query<{ id: string }>(
      `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
      [iv.id, jo.id],
    )).rows[0].id;
    const first = futureSlot(4, 10);
    const later = futureSlot(4, 16);
    const put = (u: TestUser, windows: string[], extra: Record<string, unknown> = {}) =>
      apiAs(u, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows, ...extra });
    await put(iv, [first]);
    const booked = await put(jo, [first], { durationMin: 45, type: 'audio' });
    const meetingId = booked.json.data.confirmed.meetingId as string;
    // Both add a later time; a save never moves the meeting, so it stays on the first.
    await put(iv, [first, later]);
    await put(jo, [first, later]);
    const where = async () => {
      const m = (await apiAs(iv, 'GET', `/meetings/${meetingId}`)).json.data;
      return [slotOf(m.startAt), m.durationMin, m.kind];
    };
    expect(await where()).toEqual([first, 45, 'audio']);

    const TZ = 'Europe/Copenhagen';
    const page = await openAs(jo, `/messages/${conv}?schedule=1`, { width: 390, height: 844 }, TZ);
    await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Move it to another time you both can:', { exact: true })).toBeVisible({ timeout: 20_000 });
    await tapReachable(page, page.getByRole('button', { name: `Confirm ${labelIn(later, TZ)}` }), 'Jo: the later time');
    const card = page.getByTestId('confirm-card');
    const move = card.getByRole('button', { name: 'Move meeting' });
    await expect(card.locator('#meeting-minutes')).toHaveValue('45');
    await expect(card.getByRole('button', { name: 'Audio' })).toHaveAttribute('aria-pressed', 'true');

    // 1. The connection drops as Move is pressed.
    await page.route('**/scheduling/confirm', r => r.abort('internetdisconnected'));
    await tapReachable(page, move, 'Jo: Move (offline)');
    await expect(alertToast(page, `Could not move the meeting. It stays on ${labelIn(first, TZ)}. Try again.`)).toBeVisible({ timeout: 20_000 });
    await expect(card).toBeVisible();
    await expect(move).toBeEnabled();
    expect(await where()).toEqual([first, 45, 'audio']);
    await page.unroute('**/scheduling/confirm');

    // 2. Iv takes the later time back, and Jo presses Move before the panel has heard (it is shown the times as they
    // were until the press reaches the server). The server refuses with its 409.
    const stale = (await apiAs(jo, 'GET', `/dm/conversations/${conv}/scheduling`)).json;
    let pressed = false;
    await page.route(`**/api/dm/conversations/${conv}/scheduling`, r => (
      !pressed && r.request().method() === 'GET'
        ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stale) })
        : r.continue()
    ));
    await page.route('**/scheduling/confirm', r => { pressed = true; return r.continue(); });
    await put(iv, [first]);
    await page.waitForTimeout(1_500);
    await tapReachable(page, move, 'Jo: Move (the time was taken back)');
    await expect(alertToast(page, `That time is no longer free for both of you. Your meeting stays on ${labelIn(first, TZ)}.`))
      .toBeVisible({ timeout: 20_000 });
    // The card stays, says why, and waits: Move comes back only if the time is shared again.
    await expect(card).toBeVisible();
    await expect(card.getByTestId('confirm-card-not-shared')).toHaveText('That time is no longer free for both of you.', { timeout: 20_000 });
    await expect(move).toBeDisabled();
    expect(await where()).toEqual([first, 45, 'audio']);
    await page.unroute(`**/api/dm/conversations/${conv}/scheduling`);
    await page.unroute('**/scheduling/confirm');

    // 3. Iv adds it back: the card, still open, offers Move again, and this time it moves.
    await put(iv, [first, later]);
    await expect(card.getByTestId('confirm-card-not-shared')).toHaveCount(0, { timeout: 30_000 });
    await expect(move).toBeEnabled();
    await tapReachable(page, move, 'Jo: Move (retry)');
    await expect(toast(page, `Meeting moved: ${labelIn(later, TZ)}`)).toBeVisible({ timeout: 20_000 });
    expect(await where()).toEqual([later, 45, 'audio']);
    console.log('  ✓ a dropped Move and a refused Move each left the meeting in place with the card open; the retry moved it');
  } finally {
    await cleanup(pool, { ids: [iv.id, jo.id] });
  }
});

test('a save that books the agreed time books it with the length and kind it carried', async () => {
  const x = await createTestUser('mlbookx');
  const y = await createTestUser('mlbooky');
  try {
    const sent = await apiAs(x, 'POST', '/pokes', { recipientId: y.id, message: 'Hi' });
    expect((await apiAs(y, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
    const conv = (await pool.query<{ id: string }>(
      `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
      [x.id, y.id],
    )).rows[0].id;
    const slot = futureSlot(5, 11);
    expect((await apiAs(x, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot] })).status).toBe(200);
    const booked = await apiAs(y, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot], durationMin: 20, type: 'audio' });
    expect(booked.status).toBe(200);
    expect(booked.json.data.confirmed).toMatchObject({ window: slot, byUserId: y.id, durationMin: 20, type: 'audio' });
    expect(new Date(booked.json.data.confirmed.startAt).toISOString().replace('.000Z', 'Z')).toBe(slot);

    const row = (await pool.query<{ meeting_duration_min: number; meeting_type: string; proposals: string }>(
      `SELECT c.meeting_duration_min, c.meeting_type,
              (SELECT count(*)::text FROM direct_messages m WHERE m.conversation_id=c.id AND m.kind='system'
                 AND m.system_meta->>'type'='meeting_proposal') AS proposals
         FROM dm_conversations c WHERE c.id=$1`, [conv],
    )).rows[0];
    expect([row.meeting_duration_min, row.meeting_type, row.proposals]).toEqual([20, 'audio', '0']);

    // Saving again changes nothing: the meeting stands, and only an explicit Confirm moves it.
    const again = await apiAs(x, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot, futureSlot(5, 15)] });
    expect(again.json.data.confirmed).toMatchObject({ window: slot, durationMin: 20, type: 'audio' });
    const cardsAfter = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM direct_messages WHERE conversation_id=$1 AND kind='system' AND system_meta->>'type'='meeting_confirmed'`,
      [conv],
    );
    expect(cardsAfter.rows[0].n).toBe('1');
  } finally {
    await cleanup(pool, { ids: [x.id, y.id] });
  }
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
    // Two shared times, so the saves book nothing and Confirm is what books (one shared time
    // would be booked by the second save itself).
    const spare = futureSlot(6, 14);
    expect((await apiAs(x, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot, spare] })).status).toBe(200);
    const saved = await apiAs(y, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot, spare] });
    expect(saved.status).toBe(200);
    expect(saved.json.data.confirmed).toBeNull();

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

    // A DIFFERENT time moves the meeting — refusing it left a pair with no way
    // out, since nothing cancels one. Still ONE meeting, and the new card
    // carries the time it replaced so the other person can see it changed.
    const other = futureSlot(6, 11);
    await apiAs(x, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot, other] });
    await apiAs(y, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot, other] });
    const moved = await apiAs(x, 'POST', `/dm/conversations/${conv}/scheduling/confirm`, { window: other, durationMin: 30, type: 'video' });
    expect(moved.status).toBe(200);
    const after = (await pool.query<{ n: string; start: Date | null; moved_from: string | null }>(
      `SELECT (SELECT count(*)::text FROM direct_messages m
               WHERE m.conversation_id=c.id AND m.kind='system'
                 AND m.system_meta->>'type'='meeting_confirmed') AS n,
              c.meeting_start_at AS start,
              (SELECT m.system_meta->>'movedFrom' FROM direct_messages m
                WHERE m.conversation_id=c.id AND m.kind='system'
                  AND m.system_meta->>'type'='meeting_confirmed'
                ORDER BY m.created_at DESC LIMIT 1) AS moved_from
         FROM dm_conversations c WHERE c.id=$1`, [conv],
    )).rows[0];
    expect(after.start?.toISOString().replace('.000Z', 'Z')).toBe(other);
    expect(after.n).toBe('2');
    expect(after.moved_from?.replace('.000Z', 'Z')).toBe(slot);
    console.log(`  ✓ the meeting moved ${slot} → ${other}, and the card says where from`);
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
