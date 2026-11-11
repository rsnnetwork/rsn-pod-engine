import { test, expect, type Browser, type Page, type Request, type Response } from '@playwright/test';
import zlib from 'zlib';
import {
  APP, DEVICE, RUN, RUN_WIDTH, api, cleanupRun, expectNotReloaded, gotoRetry, launch, made, markNotReloaded,
  noSidewaysScroll, openAs, seedPod, shot, tall, throwaway, where, type TestUser,
} from '../helpers/sweep';
import { primePreview } from '../helpers/preview-bypass';

// ─────────────────────────────────────────────────────────────────────────────
// AN EVENT'S TIME ZONE AND IMAGE, ON SCREEN (10 Nov 2026 spec, Part 3 item 1; Part 3 Task 6, the preview client for
// Task 1's routes). Against the preview (E2E_APP_URL = preview.rsn.network, E2E_VERCEL_SHARE for its protection), which
// talks to the production API. Run three times: chromium at 360px (default), E2E_DEVICE="iPhone 14" (WebKit) and
// E2E_DEVICE="iPad Mini" (a tablet).
//
//   zone     a throwaway host whose browser runs in Asia/Karachi (timezoneId) opens Schedule an Event: the zone field
//            starts on their own zone (Asia/Karachi, from their profile); they pick Europe/Copenhagen from the list, set
//            1 Dec 14:00 and schedule. The request carries timezone 'Europe/Copenhagen' and 13:00Z (Copenhagen's 14:00,
//            not Karachi's), and the event page reads "Tuesday 1 December, 14:00 (CET)".
//   viewer   a second browser in America/New_York, a member of the pod, reads the same "14:00 (CET)", never New York's
//            08:00, and sees no image control (only the host and admins do).
//   image    the host adds an image (a 1200 by 400 PNG made here) with "Add image": the header shows it, its box fits
//            the screen at 360px, and the viewer's page shows it without a reload (session:<id>). "Change image" and
//            "Remove image" are 44px.
//   link     the event's call link, opened signed out in New York, shows the image and Copenhagen's 14:00 CET.
//   widths   the event page and the call link have no sideways scroll at 360, 768 and 1280.
//
// Throwaway accounts only (@rsn-e2e.invalid); every row deleted by id at the end (the event made by the form is found
// from its POST's answer, and its pod by its director).
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

/** The phone's or tablet's own width with E2E_DEVICE, else the smallest phone the screens are built for. */
const WIDTH = DEVICE ? RUN_WIDTH : 360;
const TITLE = `P3T6 Copenhagen evening ${RUN}`;
const KARACHI = 'Asia/Karachi';
const NEW_YORK = 'America/New_York';

let browser: Browser;
let host: TestUser;
let viewer: TestUser;
let podId = '';
let eventId = '';
let hostPage: Page;
let viewerPage: Page;

// ── A real PNG of one colour, built here (the e2e package has no image library) ──────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The box sits inside the window's width (its left edge at or after 0, its right edge at or before the width). */
async function fitsWidth(page: Page, selector: ReturnType<Page['getByTestId']>, label: string): Promise<void> {
  await expect.poll(async () => {
    const box = await selector.boundingBox();
    const view = page.viewportSize();
    if (!box || !view) return false;
    return box.x >= -0.5 && box.x + box.width <= view.width + 0.5;
  }, { message: `${label} fits the ${page.viewportSize()?.width}px screen`, timeout: 10_000 }).toBe(true);
}

/** The event page's time line. */
const when = (page: Page) => page.getByTestId('event-when');

test.beforeAll(async () => {
  browser = await launch();
  host = await throwaway('Host', { set: { timezone: KARACHI } });
  viewer = await throwaway('Viewer', { set: { timezone: NEW_YORK } });
  podId = await seedPod(host, `P3T6 pod ${RUN}`, [viewer], 'reason');
});

test.afterAll(async () => {
  await cleanupRun();
});

test(`zone: a Karachi host schedules a Copenhagen evening at 14:00 and the page reads 14:00 (CET) (${where()})`, async () => {
  ({ page: hostPage } = await openAs(browser, host, `/sessions/new?podId=${podId}`, { width: WIDTH, extra: { timezoneId: KARACHI } }));
  await expect(hostPage.getByRole('heading', { name: 'Schedule an Event' })).toBeVisible({ timeout: 30_000 });

  // The zone starts on the host's own (their profile's Karachi), and the note names it.
  const field = hostPage.getByTestId('event-zone-field');
  await expect(field.getByTestId('time-zone')).toHaveText('Asia/Karachi');
  await expect(hostPage.getByTestId('event-zone-note')).toContainText('Times are shown in Asia/Karachi');
  await expect(field.getByText('Only you see this')).toHaveCount(0);

  // Copenhagen from the list.
  const change = field.getByRole('button', { name: 'Change time zone' });
  await tall(change, 'Change time zone');
  await change.click();
  const list = hostPage.getByRole('dialog', { name: "Choose the event's time zone" });
  await expect(list).toBeVisible();
  await list.getByLabel('Search time zones').fill('Copenhagen');
  await list.getByRole('button', { name: 'Europe/Copenhagen' }).click();
  await expect(list).toBeHidden();
  await expect(field.getByTestId('time-zone')).toHaveText('Europe/Copenhagen');

  await hostPage.getByLabel('Title').fill(TITLE);
  await hostPage.getByLabel('Date and time').fill('2026-12-01T14:00');
  await expect(hostPage.getByTestId('event-zone-note')).toHaveText('Times are shown in Europe/Copenhagen (CET, GMT+1).');
  await noSidewaysScroll(hostPage, 'Schedule an Event with the zone field');
  await shot(hostPage, 'p3t6-create-zone');

  const posted = hostPage.waitForRequest((r: Request) => new URL(r.url()).pathname === '/api/sessions' && r.method() === 'POST');
  const answered = hostPage.waitForResponse((r: Response) => new URL(r.url()).pathname === '/api/sessions' && r.request().method() === 'POST');
  await hostPage.getByRole('button', { name: 'Schedule Event' }).click();
  const body = (await posted).postDataJSON() as { timezone?: string; scheduledAt?: string };
  expect(body.timezone, 'the form sends the event zone').toBe('Europe/Copenhagen');
  expect(body.scheduledAt, "Copenhagen's 14:00 (13:00Z), not Karachi's (09:00Z)").toBe('2026-12-01T13:00:00.000Z');
  const res = await answered;
  expect(res.status()).toBe(201);
  eventId = (await res.json()).data.id;
  made.sessions.push(eventId);

  await gotoRetry(hostPage, `${APP}/sessions/${eventId}`);
  await expect(when(hostPage)).toHaveText('Tuesday 1 December, 14:00 (CET)', { timeout: 30_000 });
  await expect(hostPage.getByText('(your local time)')).toHaveCount(0);

  // The edit form opens on Copenhagen's 14:00 (the host's browser is in Karachi, where it is 18:00).
  await hostPage.getByRole('button', { name: /^Edit/ }).first().click();
  const sheet = hostPage.getByRole('dialog', { name: 'Edit Event' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Date and time')).toHaveValue('2026-12-01T14:00');
  await expect(sheet.getByTestId('time-zone')).toHaveText('Europe/Copenhagen');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
});

test(`viewer: a member in New York reads the same 14:00 (CET) and sees no image control (${where()})`, async () => {
  expect(eventId, 'the event was made').toBeTruthy();
  ({ page: viewerPage } = await openAs(browser, viewer, `/sessions/${eventId}`, { width: WIDTH, extra: { timezoneId: NEW_YORK } }));
  await expect(when(viewerPage)).toHaveText('Tuesday 1 December, 14:00 (CET)', { timeout: 30_000 });
  await expect(when(viewerPage)).not.toContainText('08:00');
  await expect(viewerPage.getByTestId('event-image-add')).toHaveCount(0);
  await expect(viewerPage.getByRole('button', { name: 'Change image' })).toHaveCount(0);
  await markNotReloaded(viewerPage);
});

test(`image: the host adds an image, it heads the page and fits at 360px, and the member sees it without a reload (${where()})`, async () => {
  expect(eventId, 'the event was made').toBeTruthy();
  const add = hostPage.getByTestId('event-image-add');
  await tall(add, 'Add image');
  await add.click();
  const editor = hostPage.getByRole('dialog', { name: 'Add image' });
  await expect(editor).toBeVisible();
  await editor.getByLabel('Choose a picture for the event image').setInputFiles({
    name: 'event.png', mimeType: 'image/png', buffer: solidPng(1200, 400, [9, 105, 218]),
  });
  const save = editor.getByRole('button', { name: 'Save' });
  await expect(save).toBeEnabled({ timeout: 15_000 });
  const put = hostPage.waitForResponse((r: Response) => new URL(r.url()).pathname === `/api/sessions/${eventId}/image` && r.request().method() === 'PUT');
  await save.click();
  expect((await put).status()).toBe(200);
  await expect(editor).toBeHidden({ timeout: 15_000 });

  // The header: the image, named by the event's title, loaded, in its 3:1 box inside the screen.
  const header = hostPage.getByTestId('event-image-header');
  const img = header.getByRole('img', { name: TITLE });
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { message: 'the image loaded' }).toBeGreaterThan(0);
  await fitsWidth(hostPage, hostPage.getByTestId('event-image'), 'the event image');
  const box = await hostPage.getByTestId('event-image').boundingBox();
  expect(box && box.width / box.height, 'a 3:1 box (or its middle band on a wide screen)').toBeGreaterThanOrEqual(2.9);
  await tall(header.getByRole('button', { name: 'Change image' }), 'Change image');
  await tall(header.getByRole('button', { name: 'Remove image' }), 'Remove image');
  await noSidewaysScroll(hostPage, 'the event page with its image');
  await shot(hostPage, 'p3t6-event-image');

  // The member's page shows it by itself (session:<id>), not after a reload.
  await expect(viewerPage.getByTestId('event-image-header').getByRole('img', { name: TITLE })).toBeVisible({ timeout: 20_000 });
  await expectNotReloaded(viewerPage, 'the member\'s event page');
  await expect(viewerPage.getByRole('button', { name: 'Change image' })).toHaveCount(0);
});

test(`link: the call link, signed out in New York, shows the image and Copenhagen's 14:00 CET (${where()})`, async () => {
  expect(eventId, 'the event was made').toBeTruthy();
  const link = await api(host, 'GET', `/sessions/${eventId}/call-link`);
  expect(link.status, link.text).toBe(200);
  const ctx = await browser.newContext({
    ...(DEVICE ? { ...DEVICE } : { viewport: { width: WIDTH, height: 844 }, hasTouch: true }),
    timezoneId: NEW_YORK,
  });
  await primePreview(ctx);
  const page = await ctx.newPage();
  try {
    await gotoRetry(page, `${APP}/call/${link.json.data.code}`);
    const summary = page.getByTestId('call-event-summary').filter({ visible: true }).first();
    await expect(summary).toBeVisible({ timeout: 30_000 });
    await expect(summary.getByText('Tuesday 1 December, 14:00 (CET)')).toBeVisible();
    await expect(summary.getByText('Shown in your own time zone')).toHaveCount(0);
    const image = summary.getByTestId('event-image').locator('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth), { message: 'the hero loaded' }).toBeGreaterThan(0);
    await fitsWidth(page, summary.getByTestId('event-image'), 'the call link hero');
    await noSidewaysScroll(page, 'the call link with its image');
    await shot(page, 'p3t6-call-link');
  } finally {
    await ctx.close();
  }
});

test(`widths: the event page and the call link have no sideways scroll at 360, 768 and 1280 (${where()})`, async () => {
  test.skip(!!DEVICE, 'the device run checks its own screen above; the widths run once, without E2E_DEVICE');
  expect(eventId, 'the event was made').toBeTruthy();
  const link = await api(host, 'GET', `/sessions/${eventId}/call-link`);
  for (const width of [360, 768, 1280]) {
    const { page, ctx } = await openAs(browser, viewer, `/sessions/${eventId}`, { width, extra: { timezoneId: NEW_YORK } });
    await expect(when(page)).toHaveText('Tuesday 1 December, 14:00 (CET)', { timeout: 30_000 });
    await expect(page.getByTestId('event-image').locator('img')).toBeVisible();
    await fitsWidth(page, page.getByTestId('event-image'), `the event image at ${width}px`);
    await noSidewaysScroll(page, `the event page at ${width}px`);
    await gotoRetry(page, `${APP}/call/${link.json.data.code}`);
    await expect(page.getByTestId('call-event-summary').filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    await noSidewaysScroll(page, `the call link at ${width}px`);
    await ctx.close();
  }
});
