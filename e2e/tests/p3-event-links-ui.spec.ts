import { test, expect, type Browser, type Page, type Response } from '@playwright/test';
import {
  APP, DEVICE, RUN, RUN_WIDTH, api, cleanupRun, launch, made, noSidewaysScroll, openAs, pool, seedPod, shot, tall,
  throwaway, viewportOptions, where, type TestUser,
} from '../helpers/sweep';
import { primePreview } from '../helpers/preview-bypass';

// ─────────────────────────────────────────────────────────────────────────────
// THE EVENT LINK, ON SCREEN (Stefan, 11 Nov 2026): /events/<name>-<n>, on the preview.
//   1. An organiser schedules an event in a public pod and names its link in the form: a reserved name is refused at
//      the field as it is typed, and the link shows under the field as they type (".../events/<name>-1"). The event's
//      card shows the event link with Copy (copied to the clipboard on Chromium).
//   2. A signed-out guest opens /events/<name>-1 and reaches the event's entry ("Join with your email").
//   3. The event's old call link (/call/<code>) still opens it, and the address bar turns into the event link.
//   4. A private event: the preview ends "-······" with the note on the random code, and the card shows the tailed link
//      with its note and "Make a new link". "rsn" is refused at the field to this organiser (not a platform admin).
// At 360px (or the phone's own screen with E2E_DEVICE) the field, the preview and the entry fit: no sideways scroll,
// the field and the buttons at least 44px and inside the screen.
// Throwaway accounts only (@rsn-e2e.invalid); every row deleted by id at the end; the run's link-name counter deleted by
// its exact name.
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

const WIDTH = DEVICE ? RUN_WIDTH : 360;
const NAME = `p3elui-${RUN}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
const CLIPBOARD = !DEVICE && process.env.E2E_ENGINE !== 'webkit';

let browser: Browser;
let host: TestUser;
let podId = '';
let eventId = '';
let callCode = '';

/** The element fits inside the screen's width and is at least 44px tall. */
async function fits(page: Page, testId: string, label: string): Promise<void> {
  const el = page.getByTestId(testId).filter({ visible: true }).first();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  expect(box, `${label} is on the page`).toBeTruthy();
  expect(box!.x, `${label} starts inside the screen`).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width, `${label} ends inside the screen`).toBeLessThanOrEqual(WIDTH + 0.5);
}

test.beforeAll(async () => {
  browser = await launch();
  host = await throwaway('host', { first: 'Organiser' });
  podId = await seedPod(host, `P3EL pod ${RUN}`, [], 'speed_networking', 'public');
});

test.afterAll(async () => {
  await cleanupRun([() => pool.query('DELETE FROM event_link_counters WHERE name = ANY($1::text[])', [[NAME, `${NAME}-p`]])]);
  await browser?.close();
});

test(`the organiser names the link, sees it as they type, and copies it from the event (${where()})`, async () => {
  test.setTimeout(240_000);
  const h = await openAs(browser, host, `/sessions/new?podId=${podId}`, { width: WIDTH });
  if (CLIPBOARD) await h.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
  const page = h.page;

  const field = page.getByTestId('event-link-name-input');
  await expect(field).toBeVisible({ timeout: 30_000 });
  await field.scrollIntoViewIfNeeded();
  await tall(field, 'the link name field');
  await fits(page, 'event-link-name-field', 'the link name field');

  // A reserved word is refused at the field as it is typed, before anything is sent.
  await field.fill('admin');
  await expect(page.getByTestId('event-link-name-problem')).toHaveText('That name is kept for REASON itself. Choose another.');
  // Spaces are not a name: the rule says what is.
  await field.fill('my event');
  await expect(page.getByTestId('event-link-name-problem')).toContainText('Use 2 to 40 lower-case letters, digits and single hyphens');

  // The run's own name: the link appears under the field once the organiser pauses.
  const checked = page.waitForResponse((r: Response) => r.url().includes('/sessions/event-link-name') && r.url().includes(NAME));
  await field.fill(NAME.toUpperCase());
  expect((await checked).status()).toBe(200);
  const preview = page.getByTestId('event-link-preview');
  await expect(preview).toContainText(`/events/${NAME}-1`, { timeout: 15_000 });
  await expect(page.getByTestId('event-link-name-problem')).toHaveCount(0);
  await fits(page, 'event-link-preview', 'the link preview');
  await noSidewaysScroll(page, 'the form with the link preview');
  await shot(page, 'event-link-form');

  const created = page.waitForResponse((r: Response) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Schedule Event' }).click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  eventId = body.data.id;
  made.sessions.push(eventId);
  expect(body.data.linkName).toBe(NAME);
  await expect(page).toHaveURL(new RegExp(`/sessions/${eventId}`), { timeout: 30_000 });

  const link = await api(host, 'GET', `/sessions/${eventId}/call-link`);
  expect(link.status, link.text).toBe(200);
  expect(link.json.data.eventLink).toMatchObject({ slug: `${NAME}-1`, private: false });
  callCode = link.json.data.code;

  // The card on the event page: "Event link", the address, Copy.
  await page.goto(`${APP}/sessions/${eventId}`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('call-link-card');
  await expect(card).toContainText('Event link', { timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId('call-link-address')).toContainText(`/events/${NAME}-1`);
  await expect(card).not.toContainText('RSN Call link');
  // A public link has no random code to replace.
  await expect(card.getByTestId('call-link-rotate')).toHaveCount(0);
  const copy = card.getByTestId('call-link-copy');
  await tall(copy, 'Copy link');
  await fits(page, 'call-link-copy', 'Copy link');
  await copy.click();
  if (CLIPBOARD) {
    await expect(copy).toContainText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`/events/${NAME}-1$`));
  }
  await noSidewaysScroll(page, 'the event page with the event link card');
  await shot(page, 'event-link-card');
});

test(`a guest opens /events/<name>-1 and reaches the event's entry (${where()})`, async () => {
  test.setTimeout(120_000);
  expect(eventId, 'the event from the first test').toBeTruthy();
  const ctx = await browser.newContext(viewportOptions(WIDTH));
  await primePreview(ctx);
  const page = await ctx.newPage();
  try {
    await page.goto(`${APP}/events/${NAME}-1`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 }).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    const join = page.getByTestId('call-join');
    await expect(join).toBeVisible();
    await tall(join, 'Join with your email');
    await fits(page, 'call-join', 'Join with your email');
    await expect(page).toHaveURL(new RegExp(`/events/${NAME}-1$`));
    await noSidewaysScroll(page, 'the event link entry');
    await shot(page, 'event-link-entry');

    // A link that leads nowhere says so, the call link's way.
    await page.goto(`${APP}/events/${NAME}-999`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('call-not-found')).toBeVisible({ timeout: 30_000 });
  } finally {
    await ctx.close();
  }
});

test(`the old call link still opens the event, and the address bar shows the event link (${where()})`, async () => {
  test.setTimeout(120_000);
  expect(callCode, 'the call code from the first test').toBeTruthy();
  const ctx = await browser.newContext(viewportOptions(WIDTH));
  await primePreview(ctx);
  const page = await ctx.newPage();
  try {
    await page.goto(`${APP}/call/${callCode}`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(new RegExp(`/events/${NAME}-1$`), { timeout: 30_000 });
    await expect(page.getByTestId('call-join')).toBeVisible({ timeout: 30_000 });
    await noSidewaysScroll(page, 'the entry after the call link');
  } finally {
    await ctx.close();
  }
});

test(`a private event's link ends with a random code, said under the field and on the card (${where()})`, async () => {
  test.setTimeout(240_000);
  const h = await openAs(browser, host, `/sessions/new?podId=${podId}`, { width: WIDTH });
  const page = h.page;
  const field = page.getByTestId('event-link-name-input');
  await expect(field).toBeVisible({ timeout: 30_000 });
  // RSN's own name is refused at once to an organiser who is not a platform admin.
  await field.fill('rsn');
  await expect(page.getByTestId('event-link-name-problem')).toHaveText('This name is reserved.');
  await page.getByTestId('event-access-private').click();
  await field.fill(`${NAME}-p`);
  await expect(page.getByTestId('event-link-preview')).toContainText(`/events/${NAME}-p-1-······`, { timeout: 15_000 });
  await expect(page.getByTestId('event-link-private-note')).toBeVisible();
  await fits(page, 'event-link-preview', 'the private link preview');
  await noSidewaysScroll(page, 'the form with a private link');
  const created = page.waitForResponse((r: Response) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Schedule Event' }).click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  const id: string = (await res.json()).data.id;
  made.sessions.push(id);
  await page.goto(`${APP}/sessions/${id}`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('call-link-card');
  await expect(card).toContainText('Event link', { timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId('call-link-address')).toHaveText(new RegExp(`/events/${NAME}-p-1-[a-km-np-z][2-9a-km-np-z]{5}$`));
  await expect(card.getByTestId('event-link-private-note')).toContainText('Links shared while it was public no longer work.');
  await tall(card.getByTestId('call-link-rotate'), 'Make a new link');
  await noSidewaysScroll(page, 'the event page with a private link');
  await shot(page, 'event-link-card-private');
});
