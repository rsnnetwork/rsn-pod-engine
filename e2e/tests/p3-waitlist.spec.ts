import { test, expect, type Browser, type BrowserContext, type Locator, type Page, type Request, type Response } from '@playwright/test';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import {
  APP, DEVICE, RUN, RUN_WIDTH, api, bellCount, cleanupRun, expectNotReloaded, launch, made, markNotReloaded,
  noSidewaysScroll, openAs, pool, seedPod, shot, tall, throwaway, viewportOptions, where, type TestUser,
} from '../helpers/sweep';
import { primePreview } from '../helpers/preview-bypass';

// ─────────────────────────────────────────────────────────────────────────────
// A FULL EVENT'S WAITING LIST, ON SCREEN (10 Nov 2026 spec, Part 3 item 2; Part 3 Task 8, the preview client for
// Task 3's routes). Against the preview (E2E_APP_URL = preview.rsn.network, E2E_VERCEL_SHARE for its protection), which
// talks to the production API. Run three times: chromium at 360px (default), E2E_DEVICE="iPhone 14" (WebKit) and
// E2E_DEVICE="iPad Mini" (a tablet).
//
//   full     a throwaway host makes an event with one place (API), open to anyone with its link; member A takes the
//            place (API). Member B opens the event page: "This event is full.", a "Full" chip, "Join the waiting list"
//            (44px, inside the screen) and no Register. The host's page is open on the same event: its "Waiting list"
//            card says "Nobody is waiting.".
//   join     B double-clicks "Join the waiting list": one request leaves the page, the toast says "number 1", the page
//            reads "On the waiting list · number 1" with "Leave the waiting list", and B has exactly one waiting row at
//            position 1. The host's card shows B, "1 person waiting", "Let in now" and "Remove", without a reload.
//            While waiting B's page reads no attendee list: "You'll see who's coming once a place is yours.".
//   promote  A unregisters (API). Within 10 s B's open page reads "Registered" without a reload, and B's bell shows
//            "A place opened in {title}: it's yours". The host's card is back to "Nobody is waiting.".
//   guest    a fresh address opens the event's call link signed out (B now holds the only place): email, the 6-digit
//            code (its keyed hash written here, as p2-call-link-entry does), a name, Join: the screen reads "{title} is
//            full. You're number 1 on the waiting list." with the promise and "Leave the waiting list" (asked first);
//            leaving brings the event's summary back and the guest's row is `left`.
//   widths   the event page and the call link have no sideways scroll.
//
// Throwaway accounts only (@rsn-e2e.invalid); every row deleted by id at the end (the guest by its exact address).
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
/** The phone's or tablet's own width with E2E_DEVICE, else the smallest phone the screens are built for. */
const WIDTH = DEVICE ? RUN_WIDTH : 360;
const TITLE = `P3T8 waiting list ${RUN}`;
const LIVE = 10_000;

let browser: Browser;
let host: TestUser;
let a: TestUser;
let b: TestUser;
let podId = '';
let eventId = '';
let code = '';
let hostPage: Page;
let bPage: Page;
const guestEmail = `${uuid()}@rsn-e2e.invalid`;
const contexts: BrowserContext[] = [];

/** What is on screen (the call link also draws its summary beside the step from 1024px, hidden below). */
const shown = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();

/** The box sits inside the window's width. */
async function fitsWidth(page: Page, target: Locator, label: string): Promise<void> {
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const view = page.viewportSize();
    if (!box || !view) return false;
    return box.x >= -0.5 && box.x + box.width <= view.width + 0.5;
  }, { message: `${label} fits the ${page.viewportSize()?.width}px screen`, timeout: 10_000 }).toBe(true);
}

/** Put the keyed hash of a code the spec chose on the newest entry link of `email` for `id`, and answer the code. */
async function knownEntryCode(email: string, id: string): Promise<string> {
  const row = await pool.query<{ id: string; token_hash: string }>(
    `SELECT id, token_hash FROM magic_links WHERE email = $1 AND purpose = 'event_entry' AND target_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [email, id],
  );
  expect(row.rows[0], 'the entry link was written').toBeTruthy();
  const typed = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const hash = crypto.createHmac('sha256', SECRET).update(`sign-in-code:${row.rows[0].token_hash}:${typed}`).digest('hex');
  await pool.query(`UPDATE magic_links SET code_hash = $2 WHERE id = $1`, [row.rows[0].id, hash]);
  return typed;
}

/** The person's rows on the event's line, by status. */
async function lineRows(userId: string): Promise<string[]> {
  const r = await pool.query<{ status: string }>(
    'SELECT status FROM event_waitlist WHERE session_id = $1 AND user_id = $2', [eventId, userId]);
  return r.rows.map((row) => row.status);
}

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) signs the members and sets a known entry code').toBeTruthy();
  browser = await launch();
  host = await throwaway('Host', { first: 'Organiser' });
  a = await throwaway('A', { first: 'Ada' });
  b = await throwaway('B', { first: 'Ben' });
  // A and B are the pod's members, so both may see the event and register for it.
  podId = await seedPod(host, `P3T8 pod ${RUN}`, [a, b]);

  const scheduledAt = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
  const created = await api(host, 'POST', '/sessions', { podId, title: TITLE, scheduledAt, config: { maxParticipants: 1 } });
  expect(created.status, created.text).toBe(201);
  eventId = created.json.data.id;
  made.sessions.push(eventId);
  const open = await api(host, 'PUT', `/sessions/${eventId}/admission`, { mode: 'open' });
  expect(open.status, open.text).toBe(200);
  const link = await api(host, 'GET', `/sessions/${eventId}/call-link`);
  expect(link.status, link.text).toBe(200);
  code = link.json.data.code;

  // A takes the one place (the host holds none).
  const taken = await api(a, 'POST', `/sessions/${eventId}/register`);
  expect(taken.status, taken.text).toBe(201);
});

test.afterAll(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
  await cleanupRun([() => pool.query('DELETE FROM magic_links WHERE email = $1', [guestEmail])]);
  await browser?.close();
});

test(`full: a member sees "This event is full." and "Join the waiting list"; the host's card is empty (${where()})`, async () => {
  test.setTimeout(120_000);
  ({ page: hostPage } = await openAs(browser, host, `/sessions/${eventId}`, { width: WIDTH }));
  const card = hostPage.getByTestId('waitlist-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('heading', { name: 'Waiting list' })).toBeVisible();
  await expect(card.getByTestId('waitlist-empty')).toHaveText('Nobody is waiting.');
  await markNotReloaded(hostPage);

  ({ page: bPage } = await openAs(browser, b, `/sessions/${eventId}`, { width: WIDTH }));
  const full = bPage.getByTestId('event-full');
  await expect(full).toBeVisible({ timeout: 30_000 });
  await expect(full).toContainText('This event is full.');
  await expect(bPage.getByTestId('event-full-chip')).toHaveText('Full');
  await expect(bPage.getByTestId('event-register')).toHaveCount(0);
  // Attendees are told "full", never a count.
  await expect(bPage.getByText(/places? left|\d+ people waiting/)).toHaveCount(0);
  const join = bPage.getByTestId('event-join-waitlist');
  await expect(join).toHaveText('Join the waiting list');
  await tall(join, 'Join the waiting list');
  await fitsWidth(bPage, join, 'Join the waiting list');
  await noSidewaysScroll(bPage, 'the full event page');
  await shot(bPage, 'waitlist-full');
  expect(await lineRows(b.id), 'B was not queued by opening the page').toEqual([]);
});

test(`join: a double click joins the line once, at number 1, and the host's card shows it live (${where()})`, async () => {
  test.setTimeout(120_000);
  const registers: Request[] = [];
  bPage.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/api/sessions/${eventId}/register`)) registers.push(r);
  });
  const answered = bPage.waitForResponse((r: Response) => r.url().includes(`/api/sessions/${eventId}/register`) && r.request().method() === 'POST');
  await markNotReloaded(bPage);
  await bPage.getByTestId('event-join-waitlist').dblclick();
  const res = await answered;
  expect(res.status(), 'the full event queued B').toBe(202);
  expect(await res.json()).toEqual({ success: true, data: { waitlisted: true, position: 1 } });
  expect(registers[0]?.postDataJSON(), 'the press asked for the line').toEqual({ waitlist: true });

  await expect(shown(bPage, "This event is full. You're number 1 on the waiting list.")).toBeVisible({ timeout: LIVE });
  const onLine = bPage.getByTestId('event-on-waitlist');
  await expect(onLine).toContainText('On the waiting list · number 1', { timeout: LIVE });
  const leave = bPage.getByTestId('event-leave-waitlist');
  await expect(leave).toHaveText('Leave the waiting list');
  // While waiting the page reads no attendee list (the server refuses it to someone only waiting): a plain line instead.
  await expect(bPage.getByTestId('waitlist-people-later')).toHaveText("You'll see who's coming once a place is yours.");
  await expect(bPage.locator('#participants')).toHaveCount(0);
  const listReads: string[] = [];
  bPage.on('request', (r) => { if (r.url().includes(`/api/sessions/${eventId}/participants`)) listReads.push(r.url()); });
  await bPage.waitForTimeout(2000);
  expect(listReads, 'no attendee-list read while waiting').toEqual([]);
  await tall(leave, 'Leave the waiting list');
  await fitsWidth(bPage, leave, 'Leave the waiting list');
  await noSidewaysScroll(bPage, 'the event page on the line');
  await shot(bPage, 'waitlist-on-line');
  await bPage.waitForTimeout(1500);
  expect(registers, 'one request for the double click').toHaveLength(1);
  expect(await lineRows(b.id), 'one waiting row for B').toEqual(['waiting']);
  await expectNotReloaded(bPage, "B's page");

  // The host's open page: B, first in line, with both actions, without a reload.
  const card = hostPage.getByTestId('waitlist-card');
  const row = card.getByTestId('waitlist-row').filter({ hasText: b.displayName });
  await expect(row).toBeVisible({ timeout: LIVE });
  await expect(card.getByTestId('waitlist-count')).toHaveText('1 person waiting');
  await expect(row).toContainText('Number 1 · Joined on the event page');
  await tall(row.getByTestId('waitlist-let-in'), 'Let in now');
  await tall(row.getByTestId('waitlist-remove'), 'Remove');
  await fitsWidth(hostPage, row.getByTestId('waitlist-remove'), 'Remove');
  await noSidewaysScroll(hostPage, "the host's event page");
  await expectNotReloaded(hostPage, "the host's page");
  await shot(hostPage, 'waitlist-host-card');

  // Let in now asks first; Cancel changes nothing.
  await row.getByTestId('waitlist-let-in').click();
  const dialog = hostPage.getByRole('dialog', { name: `Let ${b.displayName} in?` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This goes over the capacity you set.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await lineRows(b.id)).toEqual(['waiting']);
});

test(`promote: A unregisters and B's open page reads Registered within 10 s, with the bell (${where()})`, async () => {
  test.setTimeout(120_000);
  await markNotReloaded(bPage);
  const gone = await api(a, 'DELETE', `/sessions/${eventId}/register`);
  expect(gone.status, gone.text).toBe(200);

  await expect(bPage.getByText('Registered', { exact: true }).filter({ visible: true }).first(), "B's page flips to Registered without a reload")
    .toBeVisible({ timeout: LIVE });
  await expect(bPage.getByTestId('event-on-waitlist')).toHaveCount(0);
  await expect(bPage.getByTestId('waitlist-people-later')).toHaveCount(0);
  await expect(bPage.locator('#participants')).toBeVisible();
  await expect(bellCount(bPage), "B's bell, without a reload").toBeVisible({ timeout: LIVE });
  await bPage.getByRole('button', { name: 'Notifications' }).click();
  await expect(bPage.getByTestId('notification-row').filter({ hasText: `A place opened in ${TITLE}: it's yours` }).first())
    .toBeVisible({ timeout: LIVE });
  await expectNotReloaded(bPage, "B's page");
  await shot(bPage, 'waitlist-promoted');
  expect(await lineRows(b.id)).toEqual(['promoted']);

  await expect(hostPage.getByTestId('waitlist-card').getByTestId('waitlist-empty')).toHaveText('Nobody is waiting.', { timeout: LIVE });
  await expectNotReloaded(hostPage, "the host's page");
});

test(`guest: the call link of the full event says "number 1", and leaving asks first (${where()})`, async () => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext(viewportOptions(WIDTH));
  contexts.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  await page.goto(`${APP}/call/${code}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: TITLE, level: 1 }).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('call-join').click();
  await page.getByLabel('Email address').fill(guestEmail);
  const sent = page.waitForResponse((r: Response) => r.url().includes(`/call-links/${code}/email`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  const body = await (await sent).json();
  await expect(page.getByRole('heading', { name: 'Check your inbox for a 6-digit code' })).toBeVisible();
  const typed = body?.data?.devCode ?? await knownEntryCode(guestEmail, eventId);
  await page.getByLabel('6-digit code from the email').fill(typed);

  await expect(page.getByTestId('call-details-step')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Your name').fill(`Gus ${RUN}`);
  await page.getByRole('button', { name: 'Join the event' }).click();

  const step = page.getByTestId('call-waitlisted');
  await expect(step).toBeVisible({ timeout: 30_000 });
  await expect(step).toContainText(`${TITLE} is full. You're number 1 on the waiting list.`);
  await expect(step).toContainText("We'll email you and ring your bell the moment a place opens, and it's yours.");
  const guest = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [guestEmail]);
  expect(guest.rows[0], 'the guest account').toBeTruthy();
  const guestId = guest.rows[0].id;
  made.users.push(guestId);
  expect(await lineRows(guestId)).toEqual(['waiting']);
  const leave = page.getByTestId('call-leave-waitlist');
  await tall(leave, 'Leave the waiting list');
  await fitsWidth(page, leave, 'Leave the waiting list');
  await noSidewaysScroll(page, 'the waitlisted screen');
  await shot(page, 'waitlist-call-link');

  // Leave asks first, in the page.
  await leave.click();
  const dialog = page.getByRole('dialog', { name: 'Leave the waiting list?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("You'll lose your place in the line.");
  await dialog.getByRole('button', { name: 'Leave the waiting list' }).click();
  await expect(step).toBeHidden({ timeout: LIVE });
  await expect(page.getByTestId('call-join')).toBeVisible({ timeout: LIVE });
  expect(await lineRows(guestId)).toEqual(['left']);
});
