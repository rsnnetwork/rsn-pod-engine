import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import {
  DEVICE, RUN, RUN_WIDTH, api, cleanupRun, launch, made, noSidewaysScroll, openAs, pool, seedPod, shot, tall,
  throwaway, where, type TestUser,
} from '../helpers/sweep';

// ─────────────────────────────────────────────────────────────────────────────
// THE ORGANISERS' EVENT REPORT, ON SCREEN (10 Nov 2026 spec 03 "Reporting"; Part 3 Task 9, the preview client for
// Task 4's GET /sessions/:id/report). Against the preview (E2E_APP_URL = preview.rsn.network, E2E_VERCEL_SHARE for its
// protection), which talks to the production API. Run three times: chromium at 360px (default),
// E2E_DEVICE="iPhone 14" (WebKit) and E2E_DEVICE="iPad Mini" (a tablet).
//
//   card     a throwaway host creates an event in their pod; members A and B register through the API; the host takes
//            it live and ends it at once (nobody joined). On the event page the report card shows "Registered 2" and
//            "Didn't come 2"; "Download attendance" saves a file whose text starts with the UTF-8 BOM and the
//            attendance header row; the event's history then names the download without a reload. The card, its
//            buttons and the page fit the screen (no sideways scroll; 44px controls).
//   page     "Open the full report" shows the attendance filter (All / Came / … 44px chips) and "No meetings took
//            place." on the event's own clock, with no sideways scroll.
//   member   A opening /sessions/:id/report sees "This report is only for the people running this event." and no figure;
//            A's event page has no report card.
//
// Throwaway accounts only (@rsn-e2e.invalid); every row deleted by id at the end (the event goes with its pod).
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

/** The phone's or tablet's own width with E2E_DEVICE, else the smallest phone the screens are built for. */
const WIDTH = DEVICE ? RUN_WIDTH : 360;
const TITLE = `P3T9 report evening ${RUN}`;
const BOM = '﻿';

let browser: Browser;
let host: TestUser;
let memberA: TestUser;
let memberB: TestUser;
let eventId = '';
let hostPage: Page;

/** The box sits inside the window's width (its left edge at or after 0, its right edge at or before the width). */
async function fitsWidth(page: Page, target: Locator, label: string): Promise<void> {
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const view = page.viewportSize();
    if (!box || !view) return false;
    return box.x >= -0.5 && box.x + box.width <= view.width + 0.5;
  }, { message: `${label} fits the ${page.viewportSize()?.width}px screen`, timeout: 10_000 }).toBe(true);
}

test.beforeAll(async () => {
  browser = await launch();
  host = await throwaway('Host');
  memberA = await throwaway('Ana');
  memberB = await throwaway('Ben');
  const podId = await seedPod(host, `P3T9 pod ${RUN}`, [memberA, memberB]);

  const scheduledAt = new Date(Date.now() + 60_000).toISOString();
  const created = await api(host, 'POST', '/sessions', { podId, title: TITLE, scheduledAt });
  expect(created.status, created.text).toBe(201);
  eventId = created.json.data.id;
  made.sessions.push(eventId);
  for (const m of [memberA, memberB]) {
    const reg = await api(m, 'POST', `/sessions/${eventId}/register`);
    expect(reg.status, reg.text).toBeLessThan(300);
  }
  // Live, then ended at once through F7's end route, nobody having joined.
  const started = await api(host, 'POST', `/sessions/${eventId}/host/start`);
  expect(started.status, started.text).toBe(200);
  const ended = await api(host, 'POST', `/sessions/${eventId}/host/end`);
  expect(ended.status, ended.text).toBe(200);
  await expect.poll(async () => (await pool.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [eventId])).rows[0]?.status,
    { timeout: 30_000, message: 'the event is completed' }).toBe('completed');
});

test.afterAll(async () => {
  await cleanupRun();
});

test(`card: the host sees the figures, downloads attendance with a BOM, and the history names it (${where()})`, async () => {
  test.setTimeout(150_000);
  ({ page: hostPage } = await openAs(browser, host, `/sessions/${eventId}`, { width: WIDTH }));
  const card = hostPage.getByTestId('event-report');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('report-tile-registered')).toContainText('2');
  await expect(card.getByTestId('report-tile-registered')).toContainText('Registered');
  await expect(card.getByTestId('report-tile-didnt-come')).toContainText('2');
  await expect(card.getByTestId('report-tile-didnt-come')).toContainText("Didn't come");
  await expect(card.getByTestId('report-tile-came')).toContainText('0');

  await card.scrollIntoViewIfNeeded();
  await fitsWidth(hostPage, card, 'the report card');
  const download = card.getByRole('button', { name: 'Download attendance' });
  for (const [name, target] of [
    ['Download attendance', download],
    ['Download meetings', card.getByRole('button', { name: 'Download meetings' })],
    ['Download mutual matches', card.getByRole('button', { name: 'Download mutual matches' })],
    ['Open the full report', card.getByRole('link', { name: 'Open the full report' })],
  ] as const) {
    await tall(target, name);
    await fitsWidth(hostPage, target, name);
  }
  await noSidewaysScroll(hostPage, 'the event page with the report card');
  await shot(hostPage, 'p3t9-report-card');

  // The file: through the signed-in API as a blob, saved by the browser.
  const [file] = await Promise.all([hostPage.waitForEvent('download', { timeout: 30_000 }), download.click()]);
  expect(file.suggestedFilename()).toMatch(/^rsn-event-\d{4}-\d{2}-\d{2}-attendance\.csv$/);
  const saved = await file.path();
  expect(saved, 'the download was saved').toBeTruthy();
  const text = fs.readFileSync(saved!, 'utf8');
  expect(text.startsWith(BOM), 'the file starts with the UTF-8 BOM').toBe(true);
  const header = text.slice(1).split('\r\n')[0];
  expect(header.startsWith('Name,Email,Account,Role,Groups,Registered at (')).toBe(true);
  expect(header.endsWith('Rounds completed,People met,Ratings given,Ratings expected,Mutual matches')).toBe(true);
  expect(text).toContain(memberA.email);

  // The history (session:<id>:audit) names the download without a reload.
  await expect(hostPage.getByTestId('event-history-row').filter({ hasText: /downloaded the (attendance|event) report/ }).first())
    .toBeVisible({ timeout: 20_000 });
});

test(`page: "Open the full report" shows the attendance filter and "No meetings took place." (${where()})`, async () => {
  test.setTimeout(90_000);
  await hostPage.getByTestId('event-report').getByRole('link', { name: 'Open the full report' }).click();
  await expect(hostPage).toHaveURL(new RegExp(`/sessions/${eventId}/report$`));
  await expect(hostPage.getByRole('heading', { name: 'Event report', level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(hostPage.getByText(TITLE).first()).toBeVisible();

  const filter = hostPage.getByTestId('report-attendance-filter');
  await expect(filter).toBeVisible();
  for (const label of ['All', 'Came', 'Left early', "Couldn't join", "Didn't come", 'Removed']) {
    const chip = filter.getByRole('button', { name: new RegExp(`^${label} \\d+$`) });
    await expect(chip).toBeVisible();
    await tall(chip, `the ${label} chip`);
    await fitsWidth(hostPage, chip, `the ${label} chip`);
  }
  // Didn't come: both members, each a stacked card.
  await filter.getByRole('button', { name: /^Didn't come \d+$/ }).click();
  await expect(hostPage.getByTestId('report-person')).toHaveCount(2);
  await expect(hostPage.getByTestId('report-person').filter({ hasText: memberA.displayName })).toBeVisible();

  await expect(hostPage.getByTestId('report-rounds-empty')).toHaveText('No meetings took place.');
  await expect(hostPage.getByTestId('report-mutual-empty')).toHaveText('No mutual matches yet.');
  await expect(hostPage.getByText(/^Times are shown in /)).toBeVisible();
  await noSidewaysScroll(hostPage, 'the report page');
  await shot(hostPage, 'p3t9-report-page');
});

test(`member: A sees no report, on the report page or the event page (${where()})`, async () => {
  test.setTimeout(90_000);
  const { page } = await openAs(browser, memberA, `/sessions/${eventId}/report`, { width: WIDTH });
  await expect(page.getByTestId('event-report-unavailable')).toHaveText('This report is only for the people running this event.', { timeout: 30_000 });
  await expect(page.getByTestId('report-summary')).toHaveCount(0);
  await expect(page.getByTestId('report-tile-registered')).toHaveCount(0);
  await expect(page.getByTestId('report-attendance-filter')).toHaveCount(0);
  await noSidewaysScroll(page, 'the refused report page');

  await page.goto(page.url().replace(/\/report$/, ''));
  await expect(page.getByText(TITLE).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('event-report')).toHaveCount(0);
  await shot(page, 'p3t9-member-refused');
});
