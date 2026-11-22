import { test, expect, type Browser, type BrowserContext, type Page, type Response } from '@playwright/test';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import type { Socket } from 'socket.io-client';
import {
  APP, DEVICE, RUN, RUN_WIDTH, api, cleanupRun, launch, made, noSidewaysScroll, openAs, pool, seedPod, shot, tall,
  throwaway, viewportOptions, where, type TestUser,
} from '../helpers/sweep';
import { connectSocket } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// ─────────────────────────────────────────────────────────────────────────────
// THE RSN CALL LINK, ON SCREEN (Part 2 foundation, Task 12, 11 Nov 2026; spec 02, 04, 12/01, 12/02, 12/04, 12/05).
// Design-review prototype 1: "open speed networking entry without onboarding". One test per scenario, at 360px (or the
// iPhone's own screen with E2E_DEVICE="iPhone 14"):
//   12/01  a fresh address opens a live open event's link signed out, sees it, gives email, code and name, and lands in
//          /session/:id/live with no onboarding screen on the way;
//   12/02  a founders/funders event asks the group as tiles; the chosen group is the organiser's to see;
//   12/04  the same link followed from a plain HTML page (Luma, an email) lands on that exact event;
//   12/05  an invitation-only event tells an unlisted address so only after its code, admits it with an admission code,
//          and a second address with the same code is not admitted;
//   guest  an event guest sent to a member page (/people/everyone) lands on their guest home, which asks no member route;
//   member an existing member following a link is recognised: no email, no code, no name.
// At 360px the steps fit (no sideways scroll), the code boxes and the group tiles are at least 44px.
//
// Reading the code: production never emails a reserved test address; the spec writes the keyed hash of a code it chose
// onto the entry link it just asked for (as n1-t4-signin-code and p2-call-link-api do). A local API (development) hands
// the code back as devCode instead. Throwaway accounts only (@rsn-e2e.invalid); every row deleted by id at the end; a
// guest found by its exact address, never a pattern.
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
/** The phone's own width with E2E_DEVICE, else the smallest phone the flow is built for. */
const WIDTH = DEVICE ? RUN_WIDTH : 360;
const INVITATION_ONLY = /^This event is invitation only\./;

let browser: Browser;
let host: TestUser;
let podId = '';
const guestEmails: string[] = [];
const sockets: Socket[] = [];
const liveEvents: string[] = [];
/** A guest's signed-in page, kept for the guest-home test. */
let guestPage: Page | null = null;
const contexts: BrowserContext[] = [];

/** A signed-out browser of its own at 360px (or the phone's screen). */
async function signedOut(): Promise<Page> {
  const ctx = await browser.newContext(viewportOptions(WIDTH));
  contexts.push(ctx);
  await primePreview(ctx);
  return ctx.newPage();
}

/** What is on screen (the summary is also drawn beside the step from 1024px, hidden below). */
const shown = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();

interface MadeEvent { id: string; code: string; title: string }

async function makeEvent(label: string, mode: 'open' | 'restricted', extra: (id: string) => Promise<void> = async () => undefined): Promise<MadeEvent> {
  const title = `P2T12 ${label} ${RUN}`;
  const scheduledAt = new Date(Date.now() + 2 * 24 * 3600_000).toISOString();
  const created = await api(host, 'POST', '/sessions', { podId, title, scheduledAt });
  expect(created.status, created.text).toBe(201);
  const id: string = created.json.data.id;
  made.sessions.push(id);
  const set = await api(host, 'PUT', `/sessions/${id}/admission`, { mode });
  expect(set.status, set.text).toBe(200);
  await extra(id);
  const link = await api(host, 'GET', `/sessions/${id}/call-link`);
  expect(link.status, link.text).toBe(200);
  expect(link.json.data.path).toBe(`/call/${link.json.data.code}`);
  return { id, code: link.json.data.code, title };
}

/** The host opens the room (the event goes live) and stays in it. */
async function startLive(eventId: string): Promise<void> {
  const socket = await connectSocket(host);
  sockets.push(socket);
  socket.emit('host:start_session', { sessionId: eventId });
  await expect.poll(async () => (await pool.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [eventId])).rows[0]?.status,
    { timeout: 30_000, message: 'the event is live' }).toBe('lobby_open');
  socket.emit('session:join', { sessionId: eventId });
  liveEvents.push(eventId);
}

/** Put the keyed hash of a code the spec chose on the newest entry link of `email` for `eventId`, and answer the code. */
async function knownEntryCode(email: string, eventId: string): Promise<string> {
  const row = await pool.query<{ id: string; token_hash: string }>(
    `SELECT id, token_hash FROM magic_links WHERE email = $1 AND purpose = 'event_entry' AND target_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [email, eventId],
  );
  expect(row.rows[0], 'the entry link was written').toBeTruthy();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const hash = crypto.createHmac('sha256', SECRET).update(`sign-in-code:${row.rows[0].token_hash}:${code}`).digest('hex');
  await pool.query(`UPDATE magic_links SET code_hash = $2 WHERE id = $1`, [row.rows[0].id, hash]);
  return code;
}

/** Every address the page went to, to prove no onboarding screen was on the way. */
function watchAddresses(page: Page): string[] {
  const seen: string[] = [];
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) seen.push(frame.url()); });
  return seen;
}

/** The event's summary, then "Join with your email", the email, "Check your inbox", and the 6-digit code typed. */
async function identify(page: Page, event: MadeEvent, email: string, opts: { admissionCode?: string } = {}): Promise<void> {
  guestEmails.push(email);
  await expect(page.getByRole('heading', { name: event.title, level: 1 }).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  await noSidewaysScroll(page, 'the event summary');
  const join = page.getByTestId('call-join');
  await tall(join, 'Join with your email');
  await join.click();

  await page.getByLabel('Email address').fill(email);
  if (opts.admissionCode) await page.getByLabel('Admission code (if you have one)').fill(opts.admissionCode);
  const answered = page.waitForResponse((r: Response) => /\/call-links\/[^/?]+\/email(\?|$)/.test(r.url()) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send me a code' }).click();
  const res = await answered;
  expect(res.status(), 'every address gets the same answer').toBe(200);
  const body = await res.json();
  await expect(page.getByRole('heading', { name: 'Check your inbox for a 6-digit code' })).toBeVisible();
  await noSidewaysScroll(page, 'the code step');

  const field = page.getByLabel('6-digit code from the email');
  await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(field).toHaveAttribute('inputmode', 'numeric');
  const boxes = page.getByTestId('code-boxes').locator('div[aria-hidden="true"] > div');
  await expect(boxes).toHaveCount(6);
  for (let i = 0; i < 6; i += 1) {
    const box = await boxes.nth(i).boundingBox();
    expect(box!.width, `code box ${i + 1} is 44px wide`).toBeGreaterThanOrEqual(43.5);
    expect(box!.height, `code box ${i + 1} is 44px tall`).toBeGreaterThanOrEqual(43.5);
    expect(box!.x + box!.width, `code box ${i + 1} fits the screen`).toBeLessThanOrEqual(WIDTH + 1);
  }
  await expect(page.getByRole('button', { name: /Resend in \d+s/ })).toBeDisabled();
  await shot(page, 'call-code-step');

  const code = body?.data?.devCode ?? await knownEntryCode(email, event.id);
  // The whole code at once, as a paste or the phone's own fill lands: it is sent by itself.
  await field.fill(code);
}

/** The guest just made for `email` (exact address), kept for the teardown. */
async function guestOf(email: string): Promise<string> {
  const r = await pool.query<{ id: string; account_kind: string; onboarding_completed: boolean }>(
    'SELECT id, account_kind, onboarding_completed FROM users WHERE email = $1', [email]);
  expect(r.rows[0], `an account for ${email}`).toBeTruthy();
  made.users.push(r.rows[0].id);
  return r.rows[0].id;
}

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) signs the host and sets a known entry code').toBeTruthy();
  browser = await launch();
  host = await throwaway('host', { first: 'Organiser' });
  podId = await seedPod(host, `P2T12 pod ${RUN}`);
});

test.afterAll(async () => {
  for (const id of liveEvents) sockets[0]?.emit('host:end_session', { sessionId: id, endEvent: true });
  await new Promise((r) => setTimeout(r, 1500));
  for (const s of sockets) s.disconnect();
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
  await cleanupRun([
    () => (guestEmails.length ? pool.query('DELETE FROM magic_links WHERE email = ANY($1::text[])', [guestEmails]) : Promise.resolve()),
  ]);
  await browser?.close();
});

test(`12/01: a fresh address enters a live open event by its link, with no onboarding on the way (${where()})`, async () => {
  test.setTimeout(240_000);
  const event = await makeEvent('open live', 'open');
  await startLive(event.id);

  const page = await signedOut();
  const seen = watchAddresses(page);
  await page.goto(`${APP}/call/${event.code}`, { waitUntil: 'domcontentloaded' });
  await expect(shown(page, 'Live now')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('call-asks').filter({ visible: true })).toHaveText('This event will ask for: your email, your name');
  await expect(shown(page, 'Hosted by')).toBeVisible();
  await expect(shown(page, host.displayName)).toBeVisible();
  await shot(page, 'call-summary');

  const email = `${uuid()}@rsn-e2e.invalid`;
  await identify(page, event, email);

  // Only what this event needs: a name. No group, no admission code, no profile.
  await expect(page.getByTestId('call-details-step')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Your name')).toBeVisible();
  await expect(page.getByTestId('call-group-question')).toHaveCount(0);
  await expect(page.getByLabel('Admission code')).toHaveCount(0);
  await noSidewaysScroll(page, 'the details step');
  await shot(page, 'call-details-name');
  await page.getByLabel('Your name').fill(`Gus ${RUN}`);
  const joinButton = page.getByRole('button', { name: 'Join the event' });
  await tall(joinButton, 'Join the event');
  await joinButton.click();

  await expect(page).toHaveURL(new RegExp(`/session/${event.id}/live`), { timeout: 30_000 });
  expect(seen.filter((u) => u.includes('/onboarding')), 'no onboarding screen on the way in').toEqual([]);
  const guestId = await guestOf(email);
  const who = await pool.query('SELECT account_kind, onboarding_completed, display_name FROM users WHERE id = $1', [guestId]);
  expect(who.rows[0]).toEqual({ account_kind: 'event_guest', onboarding_completed: false, display_name: `Gus ${RUN}` });
  const place = await pool.query('SELECT admitted_via FROM session_participants WHERE session_id = $1 AND user_id = $2', [event.id, guestId]);
  expect(place.rows[0]?.admitted_via).toBe('open');
  await shot(page, 'call-landed-live');
  guestPage = page;
});

test(`guest: an event guest sent to a member page lands on the guest home, which asks no member route (${where()})`, async () => {
  test.setTimeout(120_000);
  expect(guestPage, 'the guest from 12/01').toBeTruthy();
  const page = guestPage!;
  const refused: string[] = [];
  page.on('response', async (r) => {
    if (r.status() !== 403 || !r.url().includes('/api/')) return;
    const body = await r.json().catch(() => null);
    if (body?.error?.code === 'GUEST_MEMBERSHIP_REQUIRED') refused.push(r.url());
  });
  await page.goto(`${APP}/people/everyone`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/my-events$/, { timeout: 30_000 });
  await expect(page.getByTestId('guest-home')).toBeVisible();
  await expect(page.getByTestId('guest-event')).toHaveCount(1);
  await expect(page.getByTestId('guest-become-member')).toContainText('Become a REASON member: meet people beyond this event.');
  // No member navigation in the guest frame.
  for (const name of ['For You', 'People', 'Messages', 'Pods', 'Circles']) {
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  await noSidewaysScroll(page, 'the guest home');
  await shot(page, 'guest-home');
  await page.waitForTimeout(3000);
  expect(refused, 'the guest home and its frame ask no member-only route').toEqual([]);
  // "Become a member" carries the address they verified.
  await page.getByRole('button', { name: 'Ask to become a member' }).click();
  await expect(page).toHaveURL(/\/request-to-join\?email=/);
});

test(`12/02: a founders/funders event asks the group as tiles; the chosen group is the organiser's to see (${where()})`, async () => {
  test.setTimeout(240_000);
  const event = await makeEvent('founders funders', 'open', async (id) => {
    const groups = await api(host, 'PUT', `/sessions/${id}/groups`, {
      groups: [{ key: 'founder', label: 'Founder' }, { key: 'funder', label: 'Funder' }],
      question: 'Are you a founder or a funder?',
      allowMultiple: false,
      rounds: [{ fromRound: 1, toRound: 5, mode: 'cross_group', allowedPairs: [] }],
    });
    expect(groups.status, groups.text).toBe(200);
  });
  const page = await signedOut();
  await page.goto(`${APP}/call/${event.code}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('call-asks').filter({ visible: true })).toHaveText('This event will ask for: your email, your name, your group', { timeout: 30_000 });
  const email = `${uuid()}@rsn-e2e.invalid`;
  await identify(page, event, email);

  const question = page.getByTestId('call-group-question');
  await expect(question).toBeVisible({ timeout: 30_000 });
  await expect(question).toContainText('Are you a founder or a funder?');
  for (const label of ['Founder', 'Funder']) {
    const tile = question.locator('label', { hasText: label });
    await tall(tile, `the ${label} tile`);
    const box = await tile.boundingBox();
    expect(box!.x + box!.width, `the ${label} tile fits the screen`).toBeLessThanOrEqual(WIDTH + 1);
  }
  await noSidewaysScroll(page, 'the group question');
  await shot(page, 'call-details-group');
  await page.getByLabel('Your name').fill(`Fay ${RUN}`);
  await question.locator('label', { hasText: 'Funder' }).click();
  await page.getByRole('button', { name: 'Join the event' }).click();

  await expect(page.getByTestId('call-waiting')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('call-waiting')).toContainText(`You're in. ${event.title} starts on`);
  await expect(page.getByRole('button', { name: 'Add to calendar' })).toBeVisible();
  await shot(page, 'call-waiting');

  const guestId = await guestOf(email);
  // A person's group is a row naming the event's group by id (migration 138); its key is the group's own.
  const chosen = await pool.query<{ key: string }>(
    `SELECT g.key FROM event_participant_groups pg JOIN event_groups g ON g.id = pg.group_id
      WHERE pg.session_id = $1 AND pg.user_id = $2`,
    [event.id, guestId],
  );
  expect(chosen.rows.map((r) => r.key)).toEqual(['funder']);
  // The organiser's view of the event's groups counts them.
  const organiser = await api(host, 'GET', `/sessions/${event.id}/groups`);
  expect(organiser.status, organiser.text).toBe(200);
  expect(organiser.json.data.counts?.funder).toBe(1);
});

test(`12/04: the link followed from a plain HTML page (Luma, an email) lands on that exact event (${where()})`, async () => {
  test.setTimeout(240_000);
  const other = await makeEvent('decoy', 'open');
  const event = await makeEvent('from luma', 'open');
  expect(other.code).not.toBe(event.code);
  const page = await signedOut();
  await page.setContent(`<!doctype html><html><body><h1>An event on another site</h1>
    <p><a id="rsn-call" href="${APP}/call/${event.code}">Join the call on REASON</a></p></body></html>`);
  await page.click('#rsn-call');
  await expect(page).toHaveURL(new RegExp(`/(call/${event.code}|events/[a-z0-9-]+)$`), { timeout: 30_000 });
  const email = `${uuid()}@rsn-e2e.invalid`;
  await identify(page, event, email);
  await page.getByLabel('Your name').fill(`Lu ${RUN}`);
  await page.getByRole('button', { name: 'Join the event' }).click();
  await expect(page.getByTestId('call-waiting')).toContainText(event.title, { timeout: 30_000 });
  const guestId = await guestOf(email);
  const places = await pool.query<{ session_id: string }>('SELECT session_id FROM session_participants WHERE user_id = $1', [guestId]);
  expect(places.rows.map((r) => r.session_id)).toEqual([event.id]);
});

test(`12/05: an invitation-only event refuses an unlisted address after its code, then admits it with an admission code; the code works once (${where()})`, async () => {
  test.setTimeout(300_000);
  let admission = '';
  const event = await makeEvent('invitation only', 'restricted', async (id) => {
    const codes = await api(host, 'POST', `/sessions/${id}/admission/codes`, { count: 1, label: 'P2T12' });
    expect(codes.status, codes.text).toBe(201);
    admission = codes.json.data.codes[0].code;
  });

  // The first address: refused in the event's own words only once its code is proved, then let in by the admission code.
  const first = await signedOut();
  await first.goto(`${APP}/call/${event.code}`, { waitUntil: 'domcontentloaded' });
  await expect(first.getByTestId('call-asks').filter({ visible: true })).toContainText('an admission code', { timeout: 30_000 });
  const firstEmail = `${uuid()}@rsn-e2e.invalid`;
  await identify(first, event, firstEmail);
  await expect(first.getByTestId('call-refusal')).toHaveText(INVITATION_ONLY, { timeout: 30_000 });
  const none = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE email = $1', [firstEmail]);
  expect(none.rows[0].n, 'a refused address gets no account').toBe(0);
  await noSidewaysScroll(first, 'the refusal');
  await shot(first, 'call-invitation-only');
  await first.getByLabel('Admission code').fill(admission.toLowerCase());
  await first.getByRole('button', { name: 'Continue' }).click();
  await expect(first.getByLabel('Your name')).toBeVisible({ timeout: 30_000 });
  await first.getByLabel('Your name').fill(`Ina ${RUN}`);
  await first.getByRole('button', { name: 'Join the event' }).click();
  await expect(first.getByTestId('call-waiting')).toBeVisible({ timeout: 30_000 });
  const firstId = await guestOf(firstEmail);
  const place = await pool.query('SELECT admitted_via FROM session_participants WHERE session_id = $1 AND user_id = $2', [event.id, firstId]);
  expect(place.rows[0]?.admitted_via).toBe('code');

  // A second address with the same code: refused, then told the code is spent (/verify answers 409 ADMISSION_CODE_USED).
  const second = await signedOut();
  await second.goto(`${APP}/call/${event.code}`, { waitUntil: 'domcontentloaded' });
  const secondEmail = `${uuid()}@rsn-e2e.invalid`;
  await identify(second, event, secondEmail);
  await expect(second.getByTestId('call-refusal')).toHaveText(INVITATION_ONLY, { timeout: 30_000 });
  await second.getByLabel('Admission code').fill(admission);
  // The answer the press gets, named in the failure if the sentence does not show (which request, what it said).
  const usedAnswer = second.waitForResponse((r: Response) => /\/call-links\/[^/?]+\//.test(r.url()) && r.request().method() === 'POST');
  await second.getByRole('button', { name: 'Continue' }).click();
  const answer = await usedAnswer;
  const said = `${answer.request().method()} ${new URL(answer.url()).pathname} ${answer.status()} ${await answer.text().catch(() => '')}`;
  expect(said, 'the used code goes with the 6-digit code to /verify, which answers 409 ADMISSION_CODE_USED')
    .toMatch(/\/verify 409 .*"code":"ADMISSION_CODE_USED"/);
  await expect(second.getByText('This admission code has already been used.', { exact: true }), said).toBeVisible({ timeout: 30_000 });
  await expect(second.getByTestId('call-waiting')).toHaveCount(0);
  const secondAccount = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [secondEmail]);
  for (const r of secondAccount.rows) made.users.push(r.id);
  const secondPlace = await pool.query(
    'SELECT 1 FROM session_participants sp JOIN users u ON u.id = sp.user_id WHERE sp.session_id = $1 AND u.email = $2', [event.id, secondEmail]);
  expect(secondPlace.rows, 'the second address holds no place').toHaveLength(0);
});

test(`member: an existing member following a link is recognised, with no email, code or name step (${where()})`, async () => {
  test.setTimeout(180_000);
  const event = await makeEvent('member', 'open');
  const member = await throwaway('member', { first: 'Mira' });
  const { page } = await openAs(browser, member, `/call/${event.code}`, { width: WIDTH });
  const seen = watchAddresses(page);
  await expect(shown(page, 'Signed in as')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('call-asks')).toHaveCount(0);
  await page.getByTestId('call-join').click();
  await expect(page.getByTestId('call-waiting')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('call-email-step')).toHaveCount(0);
  await expect(page.getByTestId('call-details-step')).toHaveCount(0);
  expect(seen.filter((u) => u.includes('/onboarding') || u.includes('/login'))).toEqual([]);
  const place = await pool.query('SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2', [event.id, member.id]);
  expect(place.rows[0]?.status).toBe('registered');
});
