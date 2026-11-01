import { test, expect, chromium, webkit, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { expectReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// Messaging after the 30 Oct 2026 review (items 4.3 to 4.6, L7 to L9), in real browsers, with two throwaway members,
// Shradha (A) and Ben (B), connected by an accepted request:
//   1. A writes to B. B's two tabs, For You and A's profile, both read "(1) REASON" without a reload, and a chime is
//      played once across the two (lib/chime announces each chime it plays). Reading the conversation in one tab puts
//      both back to "REASON".
//   2. B replies to A's message: the "Replying to Shradha: …" strip, then the quote in B's bubble, and in A's open thread
//      live, without a reload. Tapping the quote brings the original into view.
//   3. The name and the picture in B's thread header, and the picture beside A's messages, open A's profile.
//   4. Three emojis picked in one opening of the picker (it stays open), put where the caret is, and sent (from 640px;
//      the smile is hidden on a phone, whose keyboard has its own emoji panel).
//   5. /notifications pages past 30 (B has 45 seeded rows plus the message bells): Load more, every row once, under
//      Today and Earlier; a request from a closed account reads "No longer available" with no Accept or Decline.
//   6. Own bubbles are gray, theirs white with a border.
//   7. At 360, 390, 414, 768, 1024, 1280 and 1440: nothing scrolls sideways, the reply strip's cancel is 44px, the
//      message box stays clear of the phone's bottom bar with the strip open, and the notifications page fits.
// E2E_ENGINE=webkit for Safari's engine; E2E_DEVICE="iPhone 14" for the phone (the widths then are the phone's own).
// E2E_SHOTS_DIR=<folder> keeps a screenshot of each width. Throwaway members (@rsn-e2e.invalid, no email) and every row
// they own are deleted by id. Real sound, and a phone's background tab, cannot be checked here: Ali's phone list.
// ─────────────────────────────────────────────────────────────────────────────

const HEADLESS = process.env.E2E_HEADED === '0' || process.env.E2E_HEADED === undefined;
const ENGINE = process.env.E2E_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const DEVICE = process.env.E2E_DEVICE ? (devices as Record<string, BrowserContextOptions>)[process.env.E2E_DEVICE] : null;
const SHOTS = process.env.E2E_SHOTS_DIR || '';
const LABEL = `${ENGINE}${DEVICE ? `-${process.env.E2E_DEVICE!.replace(/\s+/g, '')}` : ''}`;

const RUN = Date.now().toString(36);
const A_NAME = `Shradha T6${RUN}`;
const B_NAME = `Ben T6${RUN}`;
const FIRST = `Shall we meet on Tuesday ${RUN}?`;
const ANSWER = `Tuesday works for me ${RUN}`;
const WIDTHS = [360, 390, 414, 768, 1024, 1280, 1440];
const SEEDED = 45;

let browser: Browser;
let a: TestUser, b: TestUser, gone: TestUser;
let conversationId = '';
let firstMessageId = '';
const ctxs: BrowserContext[] = [];
const pageErrors: string[] = [];

async function member(label: string, name: string): Promise<TestUser> {
  const u = await createTestUser(`t6-${label}`);
  const email = `e2etest-t6-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `UPDATE users SET email = $1, display_name = $2,
            notification_prefs = jsonb_set(COALESCE(notification_prefs, '{}'::jsonb), '{dm_email}', 'false')
      WHERE id = $3`,
    [email, name, u.id],
  );
  return { ...u, email, displayName: name };
}

async function api(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

/** A signed-in browser context for a member: the phone when E2E_DEVICE is set, else the width given. */
async function contextFor(u: TestUser, width = 1280, height = 860): Promise<BrowserContext> {
  const ctx = await browser.newContext(DEVICE ? { ...DEVICE } : { viewport: { width, height } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
    // Count the chimes this tab plays (lib/chime announces each one).
    (window as unknown as { __chimes: string[] }).__chimes = [];
    window.addEventListener('reason:message-chime', (e) => {
      (window as unknown as { __chimes: string[] }).__chimes.push(String((e as CustomEvent).detail?.id));
    });
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  return ctx;
}

async function openIn(ctx: BrowserContext, who: string, p: string): Promise<Page> {
  const page = await ctx.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  page.on('pageerror', (e) => { if (!/ResizeObserver loop/.test(e.message)) pageErrors.push(`${who}: ${e.message}`); });
  await gotoRetry(page, `${APP}${p}`);
  return page;
}

const chimes = (page: Page) => page.evaluate(() => (window as unknown as { __chimes: string[] }).__chimes);
const markNotReloaded = (page: Page) => page.evaluate(() => { (window as unknown as { __kept?: boolean }).__kept = true; });
const notReloaded = (page: Page) => page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true);

async function noSidewaysScroll(page: Page, label: string) {
  const wide = await page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth) out.push('the page');
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('main, main *'))) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) out.push(el.tagName.toLowerCase());
    }
    return out;
  });
  expect(wide, `${label}: scrolls sideways`).toEqual([]);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${LABEL}-${name}.png`), fullPage: false });
}

/** The first message on the page with these words (a reply quoting it comes later). */
const bubble = (page: Page, text: string) => page.locator('[data-message-id]').filter({ hasText: text }).first();

/** Shows a message's Reply (on hover where there is a mouse) and presses it. */
async function pressReply(page: Page, text: string) {
  await bubble(page, text).hover().catch(() => {});
  await bubble(page, text).getByTestId('reply-button').click({ force: true });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = ENGINE === 'webkit' ? await webkit.launch({ headless: HEADLESS }) : await chromium.launch({ headless: HEADLESS });
  a = await member('a', A_NAME);
  b = await member('b', B_NAME);
  gone = await member('gone', `Gone T6${RUN}`);
  // Connected: A asks, B accepts, and B has read the opening line.
  const asked = await api(a, 'POST', '/pokes', { recipientId: b.id, message: `Hello Ben ${RUN}` });
  expect(asked.status, JSON.stringify(asked.json)).toBe(201);
  const accepted = await api(b, 'POST', `/pokes/${asked.json.data.id}/accept`);
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
  const conv = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [a.id, b.id],
  );
  conversationId = conv.rows[0].id;
  await api(b, 'POST', `/dm/conversations/${conversationId}/read`);
  await api(a, 'POST', `/dm/conversations/${conversationId}/read`);
  // 45 older notifications for B, and a request from an account since closed (it can no longer be answered).
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at)
     SELECT $1, 'platform_match', 'Seeded ' || g, 'Someone you may want to meet', '/', g > 3, NOW() - interval '3 days' - (g || ' minutes')::interval
       FROM generate_series(1, ${SEEDED}) g`,
    [b.id],
  );
  const poke = await pool.query<{ id: string }>(
    `INSERT INTO user_pokes (sender_id, recipient_id, status, message) VALUES ($1, $2, 'pending', 'Hello') RETURNING id`, [gone.id, b.id],
  );
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link, created_at) VALUES ($1, 'poke', $2, 'Hello', $3, NOW() - interval '2 hours')`,
    [b.id, `Gone T6${RUN} asked to meet you`, `/messages?poke=${poke.rows[0].id}`],
  );
  await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [gone.id]);
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  await cleanup(pool, { ids: [a?.id, b?.id, gone?.id].filter(Boolean) as string[] });
  await pool.end().catch(() => {});
  expect(pageErrors, 'page errors').toEqual([]);
});

test('1. a new message: "(1) REASON" in both of B\'s tabs, one chime across them, and "REASON" again once read', async () => {
  test.setTimeout(120_000);
  const ctx = await contextFor(b);
  const forYou = await openIn(ctx, 'B/for-you', '/');
  const profile = await openIn(ctx, 'B/profile', `/people/${a.id}`);
  await expect(forYou).toHaveTitle('REASON', { timeout: 20_000 });
  await expect(profile).toHaveTitle('REASON', { timeout: 20_000 });
  await markNotReloaded(forYou);
  await markNotReloaded(profile);
  // Both tabs' sockets have to be up to hear the message: a tab whose socket joins after the message misses its tag
  // until it is read again (on focus, or by the reconnect resync of P1 item 17). Headed WebKit opens the second slowly.
  await profile.waitForTimeout(3_000);

  const sent = await api(a, 'POST', '/dm/messages', { toUserId: b.id, content: FIRST });
  expect(sent.status).toBe(201);
  firstMessageId = sent.json.data.message.id;

  await expect(forYou).toHaveTitle('(1) REASON', { timeout: 20_000 });
  await expect(profile).toHaveTitle('(1) REASON', { timeout: 20_000 });
  await forYou.waitForTimeout(2_500);
  const played = [...await chimes(forYou), ...await chimes(profile)];
  expect(played, 'one chime across the two tabs').toEqual([`dm:${firstMessageId}`]);
  expect(await notReloaded(forYou) && await notReloaded(profile)).toBe(true);

  // Reading it in one tab clears both.
  await forYou.goto(`${APP}/messages/${conversationId}`);
  await expect(bubble(forYou, FIRST)).toBeVisible({ timeout: 20_000 });
  await expect(forYou).toHaveTitle('REASON', { timeout: 20_000 });
  await expect(profile).toHaveTitle('REASON', { timeout: 20_000 });
  // A message in the conversation B has open and in front: no chime anywhere. (The reloaded tab's socket first has to
  // be up to hear it, as above.)
  await forYou.waitForTimeout(3_000);
  const before = (await chimes(profile)).length + (await chimes(forYou)).length;
  await api(a, 'POST', '/dm/messages', { toUserId: b.id, content: `Seen at once ${RUN}` });
  await expect(bubble(forYou, `Seen at once ${RUN}`)).toBeVisible({ timeout: 20_000 });
  await forYou.waitForTimeout(1_500);
  expect((await chimes(profile)).length + (await chimes(forYou)).length).toBe(before);
  await ctx.close();
});

test('2. B replies to A\'s message: the strip, then the quote on both sides, live', async () => {
  test.setTimeout(120_000);
  const aPage = await openIn(await contextFor(a), 'A/thread', `/messages/${conversationId}`);
  const bPage = await openIn(await contextFor(b), 'B/thread', `/messages/${conversationId}`);
  await expect(bubble(aPage, FIRST)).toBeVisible({ timeout: 20_000 });
  await expect(bubble(bPage, FIRST)).toBeVisible({ timeout: 20_000 });
  await markNotReloaded(aPage);

  await pressReply(bPage, FIRST);
  const strip = bPage.getByTestId('reply-strip');
  await expect(strip).toContainText(`Replying to ${A_NAME}: ${FIRST}`);
  await expectReachable(bPage, strip.getByRole('button', { name: 'Cancel reply' }), 'cancel reply');
  const box = bPage.locator('textarea');
  await box.fill(ANSWER);
  await box.press('Enter');
  await expect(strip).toHaveCount(0, { timeout: 15_000 });

  for (const [who, page] of [['B', bPage], ['A', aPage]] as const) {
    const reply = bubble(page, ANSWER);
    await expect(reply, `${who} sees the reply`).toBeVisible({ timeout: 20_000 });
    await expect(reply.getByTestId('reply-quote'), `${who} sees the quote`).toContainText(FIRST);
    await expect(reply.getByTestId('reply-quote')).toContainText(A_NAME);
  }
  expect(await notReloaded(aPage), 'A\'s thread was not reloaded').toBe(true);
  // The quote brings the original into view.
  await bubble(aPage, ANSWER).getByTestId('reply-quote').click();
  await expect(bubble(aPage, FIRST)).toBeInViewport();
  const stored = await pool.query(`SELECT reply_to_id FROM direct_messages WHERE content = $1`, [ANSWER]);
  expect(stored.rows[0].reply_to_id).toBe(firstMessageId);
});

test('3. the name and the picture open the profile', async () => {
  test.setTimeout(90_000);
  const page = await openIn(await contextFor(b), 'B/names', `/messages/${conversationId}`);
  await expect(bubble(page, FIRST)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('View profile ›')).toBeVisible();
  await page.getByTestId('thread-partner-name').click();
  await expect(page).toHaveURL(new RegExp(`/people/${a.id}\\?from=Messages$`), { timeout: 15_000 });
  await page.goBack();
  await expect(bubble(page, FIRST)).toBeVisible({ timeout: 20_000 });
  // The picture beside A's messages.
  await page.locator(`a[href="/people/${a.id}?from=Messages"]`).last().click();
  await expect(page).toHaveURL(new RegExp(`/people/${a.id}\\?from=Messages$`), { timeout: 15_000 });
});

test('4. three emojis in one opening of the picker, put where the caret is, and sent', async () => {
  test.setTimeout(90_000);
  const width = DEVICE ? (DEVICE.viewport?.width ?? 390) : 1024;
  test.skip(width < 640, 'The smile is hidden on a phone, whose keyboard has its own emoji panel.');
  const page = await openIn(await contextFor(b, 1024), 'B/emoji', `/messages/${conversationId}`);
  await expect(bubble(page, FIRST)).toBeVisible({ timeout: 20_000 });
  const box = page.locator('textarea');
  await box.fill(`Great ${RUN}`);
  await page.getByRole('button', { name: 'Add emoji' }).click();
  const picker = page.getByTestId('emoji-picker');
  for (const e of ['😀', '🎉', '👍']) {
    await picker.getByRole('button', { name: `Add ${e}` }).click();
    await expect(picker, 'the picker stays open after a pick').toBeVisible();
  }
  await expect(box).toHaveValue(`Great ${RUN}😀🎉👍`);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(picker).toHaveCount(0);
  await expect(bubble(page, `Great ${RUN}😀🎉👍`)).toBeVisible({ timeout: 20_000 });
});

test('5. /notifications pages past 30, every row once; a gone request offers nothing', async () => {
  test.setTimeout(120_000);
  const page = await openIn(await contextFor(b), 'B/notifications', '/notifications');
  const rows = page.getByTestId('notification-row');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  const firstPage = await rows.count();
  expect(firstPage, 'a page of 30 rows, message bells run together').toBeLessThanOrEqual(30);
  const more = page.getByRole('button', { name: 'Load more' });
  for (let i = 0; i < 3 && await more.count() > 0; i++) {
    await more.click();
    await page.waitForTimeout(800);
  }
  await expect(more).toHaveCount(0);
  for (const n of [1, 30, 31, SEEDED]) await expect(page.getByText(`Seeded ${n}`, { exact: true })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Earlier' })).toBeVisible();
  const goneRow = rows.filter({ hasText: `Gone T6${RUN} asked to meet you` });
  await expect(goneRow).toContainText('No longer available');
  await expect(goneRow.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(goneRow.getByRole('button', { name: 'Decline' })).toHaveCount(0);
  // Mark all as read: every dot goes, without a reload.
  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.locator('[data-testid="notification-row"][data-read="no"]')).toHaveCount(0, { timeout: 15_000 });
  // The bell's foot leads here.
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expectReachable(page, page.getByTestId('bell-see-all'), 'See all notifications');
});

test('6. own bubbles are gray, theirs white with a border', async () => {
  const page = await openIn(await contextFor(b), 'B/bubbles', `/messages/${conversationId}`);
  const own = page.getByTestId('bubble-own').filter({ hasText: ANSWER });
  const theirs = page.getByTestId('bubble-theirs').filter({ hasText: FIRST });
  await expect(own).toBeVisible({ timeout: 20_000 });
  const look = (el: typeof own) => el.evaluate((n) => {
    const s = getComputedStyle(n);
    return { bg: s.backgroundColor, border: s.borderTopWidth, color: s.color };
  });
  expect(await look(own)).toMatchObject({ bg: 'rgb(243, 244, 246)', color: 'rgb(17, 24, 39)' });
  expect(await look(theirs)).toMatchObject({ bg: 'rgb(255, 255, 255)', border: '1px' });
});

test('7. at every width: no sideways scroll, the reply strip and the box clear of the bottom bar, the page fits', async () => {
  test.setTimeout(240_000);
  const widths = DEVICE ? [DEVICE.viewport?.width ?? 390] : WIDTHS;
  for (const width of widths) {
    const ctx = await contextFor(b, width, width < 768 ? 780 : 900);
    const page = await openIn(ctx, `B/${width}`, `/messages/${conversationId}`);
    await expect(bubble(page, FIRST)).toBeVisible({ timeout: 20_000 });
    await pressReply(page, FIRST);
    await expect(page.getByTestId('reply-strip')).toBeVisible();
    await noSidewaysScroll(page, `thread ${width}`);
    await expectReachable(page, page.getByRole('button', { name: 'Cancel reply' }), `cancel reply ${width}`);
    const cancel = await page.getByRole('button', { name: 'Cancel reply' }).boundingBox();
    expect(Math.round(cancel!.height)).toBeGreaterThanOrEqual(44);
    await expectReachable(page, page.locator('textarea'), `message box ${width}`);
    await expectReachable(page, page.getByRole('button', { name: 'Send message' }), `send ${width}`);
    await shot(page, `thread-reply-${width}`);

    await page.goto(`${APP}/notifications`);
    await expect(page.getByTestId('notification-row').first()).toBeVisible({ timeout: 20_000 });
    await noSidewaysScroll(page, `notifications ${width}`);
    await shot(page, `notifications-${width}`);
    await ctx.close();
  }
});
