// e2e/tests/script-b-meeting.spec.ts
//
// SCRIPT B, "One-to-one invitation becomes a real meeting" (25 Oct walkthrough), re-read against the 30 Oct changes
// (T19, 2 Nov 2026). Two members, real browsers, nothing reloaded where a step watches the other person:
//   01 Pia asks Ole to meet from his profile; Ole's bell rings without a reload and he accepts from it. Pia shares a
//      time in the scheduler; Ole's open thread is told; Ole picks the same time and the save books it: "Meeting
//      confirmed" on both screens without a reload.
//   02 Both are told (Pia's bell "Meeting time confirmed"), and both find the meeting under Events, with Add to
//      calendar on its page (30 Oct, 5b: Google, Outlook.com and the file).
//   03 At its time both Join from the meeting's page. With a real room (the preview, Chromium) each sees the other and
//      themselves, wholly in the window, without scrolling.
//   04 Pia leaves and is asked how it went (30 Oct, 5c) while Ole stays in, is told she left, and is not put out; she
//      comes back in and Ole sees her again.
//   05 The final state, for both: once its time has passed the meeting is under Events → Past on both, and its page
//      asks how it went. A meeting booked next and cancelled by Pia reads Cancelled on Ole's open page without a reload.
// Room steps need a real LiveKit room: skipped locally and in WebKit, with the reason. Throwaway members only
// (<id>@rsn-e2e.invalid), deleted by id.

import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import {
  APP, ROOMS, ROOM_SKIP, RUN, api, bellCount, skipStep, cleanupRun, conversationOf, expectNotReloaded, firstName, gotoRetry, launch,
  markNotReloaded, noSidewaysScroll, openAs, pool, shot, tall, throwaway, where, type TestUser,
} from '../helpers/sweep';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';

const SLOW = 60_000;
const LIVE = 25_000;

let browser: Browser;
let pia: TestUser, ole: TestUser;

function futureSlot(daysAhead: number, hour: number): string {
  const dt = new Date();
  dt.setHours(hour, 0, 0, 0);
  dt.setDate(dt.getDate() + daysAhead);
  return dt.toISOString().replace('.000Z', 'Z');
}

// The scheduler's own way in, and a time brought into reach as a person scrolls to it (after meeting-loop.spec.ts).
async function openScheduler(page: Page): Promise<void> {
  const findTime = page.getByRole('button', { name: /Find a time to meet/i });
  const more = page.getByRole('button', { name: 'More actions' });
  await findTime.or(more).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (await more.isVisible().catch(() => false)) await more.click();
  await findTime.filter({ visible: true }).first().click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
}

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

async function reachSlot(page: Page, slot: string, label: string): Promise<void> {
  await selectDayFor(page, slot);
  const target = page.locator(`[data-slot="${slot}"]`);
  for (let i = 0; i < 8; i++) {
    await stillAt(target);
    if (await expectReachable(page, target, 'probe').then(() => true, () => false)) break;
    // Scrolled into the middle of its panel, as a finger (or a wheel) would: mobile WebKit has no mouse wheel.
    await target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior }));
    await page.waitForTimeout(250);
  }
  await stillAt(target);
  await tapReachable(page, target, label);
}

const cards = (page: Page) => page.getByTestId('system-message-card');
const meetingCard = (page: Page, id: string) => page.locator(`article[data-meeting-id="${id}"]`);

test.beforeAll(async () => {
  browser = await launch();
  pia = await throwaway('Pia');
  ole = await throwaway('Ole');
  console.log(`[script-b] ${where()} app=${APP} rooms=${ROOMS}`);
});

test.afterAll(async () => {
  await cleanupRun();
  await browser?.close().catch(() => undefined);
});

test('Script B: a request becomes a booked meeting both find under Events; both join; one leaves and comes back; the end is the same on both', async () => {
  test.setTimeout(600_000);
  let conv = '';
  let meetingId = '';
  const slot = futureSlot(3, 14);

  const olePage = (await openAs(browser, ole, '/connections')).page;
  await expect(olePage.getByRole('button', { name: 'Notifications' })).toBeVisible({ timeout: SLOW });
  await markNotReloaded(olePage);
  const piaPage = (await openAs(browser, pia, `/people/${ole.id}`)).page;

  await test.step('01 Pia asks from Ole\'s profile; Ole\'s bell rings without a reload; he accepts from the bell', async () => {
    await expect(piaPage.getByRole('heading', { level: 1, name: ole.displayName })).toBeVisible({ timeout: SLOW });
    const bar = piaPage.getByRole('region', { name: 'Your move' });
    await bar.getByRole('button', { name: 'Meet', exact: true }).click();
    const sheet = piaPage.getByRole('dialog', { name: `Meet ${ole.displayName}` });
    await sheet.getByRole('textbox').fill(`Coffee next week? (${RUN})`);
    await sheet.getByRole('button', { name: 'Send request' }).click();
    await expect(sheet).toBeHidden({ timeout: LIVE });
    await expect(bellCount(olePage), 'Ole\'s bell, without a reload').toBeVisible({ timeout: LIVE });
    await olePage.getByRole('button', { name: 'Notifications' }).click();
    const row = olePage.getByTestId('notification-row').filter({ hasText: `${firstName(pia)} wants to meet you` }).first();
    await expect(row).toBeVisible({ timeout: LIVE });
    await expectNotReloaded(olePage, 'Ole\'s page');
    await row.getByRole('button', { name: 'Accept' }).click();
    await olePage.waitForURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30_000 });
    conv = await conversationOf(pia, ole);
    expect(conv).toBeTruthy();
  });

  await test.step('01 they agree a time: Pia shares it, Ole\'s open thread is told, Ole picks it too, and both read "Meeting confirmed" without a reload', async () => {
    await gotoRetry(piaPage, `${APP}/messages/${conv}`);
    await gotoRetry(olePage, `${APP}/messages/${conv}`);
    await expect(piaPage.locator('[data-message-id]').first()).toBeVisible({ timeout: SLOW });
    await markNotReloaded(piaPage);
    await markNotReloaded(olePage);
    await openScheduler(piaPage);
    await reachSlot(piaPage, slot, 'Pia: the time she can meet');
    await tapReachable(piaPage, piaPage.getByRole('button', { name: /Save and send availability/i }), 'Pia: Save');
    await expect(cards(olePage).filter({ hasText: /shared times they can meet/i }), 'Ole is told').toBeVisible({ timeout: LIVE });
    await openScheduler(olePage);
    await reachSlot(olePage, slot, 'Ole: the same time');
    await tapReachable(olePage, olePage.getByRole('button', { name: /Save and send availability/i }), 'Ole: Save');
    for (const [p, who] of [[olePage, 'Ole'], [piaPage, 'Pia']] as const) {
      await expect(cards(p).filter({ hasText: /Meeting confirmed/i }), `${who} reads it`).toBeVisible({ timeout: LIVE });
      await expectNotReloaded(p, `${who}'s thread`);
    }
    meetingId = (await pool.query<{ id: string }>('SELECT id FROM meetings WHERE conversation_id = $1', [conv])).rows[0].id;
    await shot(olePage, 'b-confirmed');
  });

  await test.step('02 both are told, and both find it under Events; its page has Add to calendar', async () => {
    const bell = await pool.query<{ title: string }>(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'meeting_confirmed'`, [pia.id]);
    expect(bell.rows.map((r) => r.title)).toContain('Meeting time confirmed');
    for (const [p, other] of [[piaPage, ole], [olePage, pia]] as const) {
      await gotoRetry(p, `${APP}/sessions`);
      await expect(meetingCard(p, meetingId), `${firstName(other)}'s meeting is listed`).toHaveCount(1, { timeout: SLOW });
      await expect(meetingCard(p, meetingId)).toContainText(`Meeting with ${other.displayName}`);
      await noSidewaysScroll(p, 'Events');
    }
    await gotoRetry(piaPage, `${APP}/meetings/${meetingId}`);
    await piaPage.getByRole('button', { name: 'Add manually', exact: true }).click();
    for (const id of ['calendar-google', 'calendar-outlook', 'calendar-ics']) await tall(piaPage.getByTestId('add-to-calendar-menu').getByTestId(id), id);
    await piaPage.keyboard.press('Escape');
  });

  await test.step('03 at its time, both Join from the meeting\'s page and are in the room', async () => {
    // Its time is now: the meeting and its conversation moved together, in one statement (n1-t8's way).
    await pool.query(
      `WITH moved AS (UPDATE meetings SET start_at = NOW() - INTERVAL '1 minute' WHERE id = $1 RETURNING start_at)
       UPDATE dm_conversations SET meeting_start_at = (SELECT start_at FROM moved) WHERE id = $2`, [meetingId, conv]);
    for (const p of [piaPage, olePage]) {
      await gotoRetry(p, `${APP}/meetings/${meetingId}`);
      const join = p.getByRole('link', { name: 'Join' }).filter({ visible: true }).first();
      await expect(join).toBeVisible({ timeout: SLOW });
      await tall(join, 'Join');
      await join.click();
      await p.waitForURL(new RegExp(`/meet/${conv}`), { timeout: 30_000 });
      await expect(p.getByTestId('call-chat-toggle')).toBeVisible({ timeout: SLOW });
    }
  });

  await test.step('03 each sees the other and themselves, wholly in the window (a real room)', async () => {
    if (skipStep(!ROOMS, ROOM_SKIP)) return;
    for (const [p, who] of [[piaPage, 'Pia'], [olePage, 'Ole']] as const) {
      const tiles = p.locator('.lk-participant-tile');
      await expect(tiles, `${who} sees two tiles`).toHaveCount(2, { timeout: 45_000 });
      const vp = p.viewportSize()!;
      for (let i = 0; i < 2; i++) {
        const box = (await tiles.nth(i).boundingBox())!;
        expect(box.y + box.height, `${who}: tile ${i} is above the window's foot`).toBeLessThanOrEqual(vp.height + 1);
        expect(box.x + box.width, `${who}: tile ${i} is inside the window`).toBeLessThanOrEqual(vp.width + 1);
      }
      await shot(p, `b-room-${who}`);
    }
  });

  await test.step('04 Pia leaves and is asked how it went; Ole stays in and is told; Pia comes back and Ole sees her again (a real room)', async () => {
    if (skipStep(!ROOMS, ROOM_SKIP)) return;
    await piaPage.getByRole('button', { name: 'Leave call and go back to chat' }).click();
    // 11 Nov 2026 (RSN 08): back in the conversation, the question asked over it.
    await expect(piaPage).toHaveURL(new RegExp(`/messages/${conv}\\?feedback=${meetingId}`), { timeout: 20_000 });
    await expect(piaPage.getByRole('dialog', { name: `How did your meeting with ${ole.displayName} go?` })).toBeVisible({ timeout: LIVE });
    await expect(olePage.getByTestId('partner-left'), 'Ole is told').toBeVisible({ timeout: 30_000 });
    await olePage.waitForTimeout(6_000);
    await expect(olePage, 'Ole is not put out').toHaveURL(new RegExp(`/meet/${conv}`));
    await piaPage.getByRole('dialog', { name: `How did your meeting with ${ole.displayName} go?` }).getByRole('button', { name: 'Not now', exact: true }).click();
    // She comes back from the meeting's page, where Join is a link.
    await gotoRetry(piaPage, `${APP}/meetings/${meetingId}`);
    await piaPage.getByRole('link', { name: 'Join' }).filter({ visible: true }).first().click();
    await piaPage.waitForURL(new RegExp(`/meet/${conv}`), { timeout: 30_000 });
    await expect(olePage.locator('.lk-participant-tile'), 'Ole sees her again').toHaveCount(2, { timeout: 45_000 });
    for (const p of [piaPage, olePage]) {
      await p.getByRole('button', { name: 'Leave call and go back to chat' }).click();
      await expect(p).toHaveURL(new RegExp(`/messages/${conv}`), { timeout: 20_000 });
    }
  });

  await test.step('05 the end, the same on both: under Events → Past, and its page asks how it went', async () => {
    await pool.query(
      `WITH moved AS (UPDATE meetings SET start_at = NOW() - INTERVAL '2 hours' WHERE id = $1 RETURNING start_at)
       UPDATE dm_conversations SET meeting_start_at = (SELECT start_at FROM moved) WHERE id = $2`, [meetingId, conv]);
    for (const p of [piaPage, olePage]) {
      await gotoRetry(p, `${APP}/sessions`);
      await p.getByRole('button', { name: 'Past', exact: true }).click();
      await expect(meetingCard(p, meetingId)).toHaveCount(1, { timeout: SLOW });
      await gotoRetry(p, `${APP}/meetings/${meetingId}`);
      await expect(p.getByRole('heading', { name: 'How did it go?' })).toBeVisible({ timeout: SLOW });
      await expect(p.getByRole('link', { name: 'Join' }).filter({ visible: true })).toHaveCount(0);
    }
  });

  await test.step('05 a meeting booked next and cancelled by Pia reads Cancelled on Ole\'s open page without a reload', async () => {
    const next = futureSlot(5, 15);
    for (const u of [pia, ole]) expect((await api(u, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [next] })).status).toBe(200);
    const booked = await api(pia, 'POST', `/dm/conversations/${conv}/scheduling/confirm`, { window: next, durationMin: 30, type: 'video' });
    expect(booked.status, booked.text).toBe(200);
    const nextId = (await pool.query<{ id: string }>(
      `SELECT id FROM meetings WHERE conversation_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 1`, [conv, meetingId])).rows[0].id;
    await gotoRetry(olePage, `${APP}/meetings/${nextId}`);
    await expect(olePage.getByRole('button', { name: 'Cancel meeting' })).toBeVisible({ timeout: SLOW });
    await markNotReloaded(olePage);
    await gotoRetry(piaPage, `${APP}/meetings/${nextId}`);
    await piaPage.getByRole('button', { name: 'Cancel meeting' }).click();
    await piaPage.getByRole('dialog', { name: `Cancel this meeting? ${ole.displayName} will be told.` }).getByRole('button', { name: 'Cancel meeting' }).click();
    await expect(piaPage.getByText('Meeting cancelled.')).toBeVisible({ timeout: LIVE });
    await expect(olePage.getByText('Cancelled', { exact: true }).first(), 'Ole\'s page, without a reload').toBeVisible({ timeout: LIVE });
    await expect(olePage.getByRole('button', { name: 'Cancel meeting' })).toHaveCount(0);
    await expectNotReloaded(olePage, 'Ole\'s meeting page');
    await shot(olePage, 'b-cancelled');
  });
});
