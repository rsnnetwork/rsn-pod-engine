import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions } from '../helpers/engine';

// MEETING REQUESTS FROM THE BELL + LINKS IN MESSAGES (4 Sep 2026, Ali).
//
// "The notification should show accept or reject inside the bell, and once
// accepted it should take me directly into the chat." And: "if a user sends
// www.something in messages it should be a link, like on the wall."
//
// Outcomes: the notification row carries the request id, the bell offers
// Accept / Decline, Accept lands on /messages/<conversation>, the poke row is
// accepted, the sender's bell entry links to that conversation, a declined
// request is declined in the database, and a pasted www. address renders as a
// real anchor for both sides of the chat.
//
// 25 Oct 2026 (Stefan and Claus on production): Claus accepted on the Messages
// card, opened the bell, and the entry still offered Accept. The bell only ever
// knew an answer given inside the panel it had open, so every fetch brought the
// buttons back. The server now says where each request stands, so after an
// answer, closing the bell and opening it again must read Accepted or Declined,
// with no Accept button left anywhere in it.
//
// 26 Oct 2026 (the preview's bell): the bell reads its list through React Query,
// refreshed by the member's notifications tag, so a bell left OPEN on another
// device turns to Accepted by itself; the other answer pressed on a bell that has
// not caught up says "You already accepted this request."; and the Messages list
// card and the focused card share one answer in flight.

let browser: Browser;
let sender: TestUser;
let recipient: TestUser;
let decliner: TestUser;
let carder: TestUser;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string, viewport = { width: 390, height: 844 }): Promise<Page> {
  const ctx = await browser.newContext(contextOptions(viewport));
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

const bellButton = (page: Page) => page.locator('button:has(.lucide-bell):visible').first();

/** The bell is a sheet over a backdrop; a tap on the backdrop (above the sheet on a phone) closes it. */
async function closeBell(page: Page) {
  await page.mouse.click(10, 10);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toHaveCount(0, { timeout: 10_000 });
}

/**
 * Opens the bell afresh, the way a member comes back to it. Opening it fetches the list again, and
 * the panel first draws whatever it remembered from before; so wait for that fetch and its render,
 * then what it shows is what the server says now (a panel that remembered "Declined" from its own
 * click would otherwise pass for one the server told).
 */
async function reopenBellOn(page: Page) {
  const fetched = page.waitForResponse((r) =>
    new URL(r.url()).pathname.endsWith('/api/notifications') && r.request().method() === 'GET' && r.ok());
  await bellButton(page).click();
  await fetched;
  await page.waitForTimeout(500);
  await expect(page.getByText('Bell Sender asked to meet you')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  sender = await createTestUser('mrbellsender');
  recipient = await createTestUser('mrbellrecipient');
  decliner = await createTestUser('mrbelldecliner');
  carder = await createTestUser('mrbellcarder');
  await pool.query(`UPDATE users SET display_name = 'Bell Sender' WHERE id = $1`, [sender.id]);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [sender?.id, recipient?.id, decliner?.id, carder?.id].filter(Boolean) });
  const swept = await cleanupByPrefix(pool, 'e2etest-mrbell');
  if (swept) console.log(`  swept ${swept} leftover mrbell* account(s)`);
});

test('a meeting request can be accepted from the bell and lands in the conversation, where a www link is a link', async () => {
  test.setTimeout(240_000);
  const p = await apiAs(sender, 'POST', '/pokes', { recipientId: recipient.id, message: 'Would love to compare notes on onboarding.' });
  expect(p.status, `send request: ${JSON.stringify(p.json)}`).toBe(201);
  const pokeId = p.json.data.id;

  // The row itself carries the id in its link, and the product's wording.
  const n = await pool.query(`SELECT title, link FROM notifications WHERE user_id = $1 AND type = 'poke' ORDER BY created_at DESC LIMIT 1`, [recipient.id]);
  expect(n.rows[0].title).toBe('Bell Sender asked to meet you');
  expect(n.rows[0].link).toBe(`/messages?poke=${pokeId}`);

  const page = await openAs(recipient, '/');
  await bellButton(page).click();
  await expect(page.getByText('Bell Sender asked to meet you')).toBeVisible({ timeout: 30_000 });
  const accept = page.getByRole('button', { name: /^Accept$/ }).first();
  const box = await accept.boundingBox();
  expect(box!.height, 'Accept tap target').toBeGreaterThanOrEqual(44);
  await accept.click();

  // Straight into the conversation with the sender.
  await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const conv = await pool.query(`SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [sender.id, recipient.id]);
  expect(conv.rows.length).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/messages/${conv.rows[0].id}`));
  const poke = await pool.query(`SELECT status FROM user_pokes WHERE id = $1`, [pokeId]);
  expect(poke.rows[0].status).toBe('accepted');

  // The sender's own bell entry points at that conversation, not the inbox.
  const sn = await pool.query(`SELECT link FROM notifications WHERE user_id = $1 AND type = 'poke_accepted' ORDER BY created_at DESC LIMIT 1`, [sender.id]);
  expect(sn.rows[0].link).toBe(`/messages/${conv.rows[0].id}`);
  console.log('  ✓ accepted from the bell, landed in the conversation, sender told where.');

  // Open the bell again: the entry reads Accepted, from the server, with nothing left to press.
  await reopenBellOn(page);
  await expect(page.getByText(/^Accepted$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^Accept$/ })).toHaveCount(0);
  await closeBell(page);
  console.log('  ✓ reopened, the bell says Accepted and offers no Accept.');

  // A pasted address is a link, on the recipient's own screen and on the sender's.
  const input = page.getByPlaceholder(/Type a message/i);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('Here is what I meant www.example.com and also https://rsn.network/about.');
  await input.press('Enter');
  const mine = page.locator(`a[href="https://www.example.com"]`).first();
  await expect(mine).toBeVisible({ timeout: 30_000 });
  // "Visible" is not "readable": on the sender's own red bubble the link must
  // be white, not the brand red (the walkthrough screenshot showed red on red).
  expect(await mine.evaluate(el => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
  await expect(page.locator(`a[href="https://rsn.network/about"]`).first()).toBeVisible();

  const senderPage = await openAs(sender, `/messages/${conv.rows[0].id}`, { width: 1280, height: 900 });
  await expect(senderPage.locator(`a[href="https://www.example.com"]`).first()).toBeVisible({ timeout: 30_000 });
  const target = await senderPage.locator(`a[href="https://www.example.com"]`).first().getAttribute('target');
  expect(target).toBe('_blank');
  console.log('  ✓ www. and https:// addresses render as anchors on both sides.');
});

test('a meeting request can be declined from the bell', async () => {
  test.setTimeout(120_000);
  const p = await apiAs(sender, 'POST', '/pokes', { recipientId: decliner.id, message: 'Coffee?' });
  expect(p.status).toBe(201);
  const pokeId = p.json.data.id;

  const page = await openAs(decliner, '/');
  await bellButton(page).click();
  await expect(page.getByText('Bell Sender asked to meet you')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Decline$/ }).first().click();
  await expect(page.getByText(/^Declined$/)).toBeVisible({ timeout: 15_000 });

  const poke = await pool.query(`SELECT status FROM user_pokes WHERE id = $1`, [pokeId]);
  expect(poke.rows[0].status).toBe('declined');
  await expect(page.getByRole('button', { name: /^Accept$/ })).toHaveCount(0);
  console.log('  ✓ declined from the bell; buttons gone; row declined.');

  // The answer above was the panel's own memory. Close it and open it again: what it says now
  // comes from the server, which is what any other tab or device sees too.
  await closeBell(page);
  await reopenBellOn(page);
  await expect(page.getByText(/^Declined$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^Accept$/ })).toHaveCount(0);
  const n = await pool.query(`SELECT is_read FROM notifications WHERE user_id = $1 AND type = 'poke' AND link = $2`, [decliner.id, `/messages?poke=${pokeId}`]);
  expect(n.rows[0].is_read, 'an answered request is no longer unread').toBe(true);
  console.log('  ✓ closed and reopened, the bell still says Declined and offers no Accept.');
});

test('a request accepted on the Messages card reads Accepted in the bell, with nothing left to press', async () => {
  test.setTimeout(180_000);
  const p = await apiAs(sender, 'POST', '/pokes', { recipientId: carder.id, message: 'Shall we meet?' });
  expect(p.status).toBe(201);
  const pokeId = p.json.data.id;

  // Claus's path at 2:43:53: accept on the request card in the Messages list...
  const page = await openAs(carder, '/messages');
  const card = page.locator(`[data-testid="meeting-request"][data-sender-id="${sender.id}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: /^Accept$/ }).click();
  await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30_000 });

  // ...then open the bell. Its entry for that request must not offer Accept again.
  await reopenBellOn(page);
  await expect(page.getByText(/^Accepted$/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /^Accept$/ })).toHaveCount(0);
  const n = await pool.query(`SELECT is_read FROM notifications WHERE user_id = $1 AND type = 'poke' AND link = $2`, [carder.id, `/messages?poke=${pokeId}`]);
  expect(n.rows[0].is_read, 'an answered request is no longer unread').toBe(true);
  console.log('  ✓ accepted on the card; the bell says Accepted and offers no Accept.');
});

test('a bell left open on another device turns to Accepted by itself, and the sender\'s open bell gets the news, when the request is accepted on the Messages card', async () => {
  test.setTimeout(180_000);
  const two = await createTestUser('mrbelltwodev');
  try {
    await pool.query(`UPDATE users SET display_name = 'Two Devices' WHERE id = $1`, [two.id]);
    const p = await apiAs(sender, 'POST', '/pokes', { recipientId: two.id, message: 'Shall we meet?' });
    expect(p.status).toBe(201);

    // The phone: the bell open on the request, and left alone from here on.
    const phone = await openAs(two, '/', { width: 390, height: 844 });
    await bellButton(phone).click();
    await expect(phone.getByText('Bell Sender asked to meet you')).toBeVisible({ timeout: 30_000 });
    await expect(phone.getByRole('button', { name: /^Accept$/ })).toBeVisible();
    // The sender's laptop, its bell open too.
    const senderDesk = await openAs(sender, '/', { width: 1280, height: 900 });
    await bellButton(senderDesk).click();
    await expect(senderDesk.getByRole('heading', { name: 'Notifications' })).toBeVisible({ timeout: 30_000 });

    // The laptop: accept on the Messages card.
    const desk = await openAs(two, '/messages', { width: 1280, height: 900 });
    const card = desk.locator(`[data-testid="meeting-request"][data-sender-id="${sender.id}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: /^Accept$/ }).click();
    await expect(desk).toHaveURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30_000 });

    // Nobody touched the phone: its open bell now reads Accepted, with nothing left to press. Live: well inside
    // the 30 s poll the bell also has (the old bell flipped only on that poll, 25 s or more after the answer).
    await expect(phone.getByText(/^Accepted$/)).toBeVisible({ timeout: 10_000 });
    await expect(phone.getByRole('button', { name: /^Accept$/ })).toHaveCount(0);
    // And the sender's open bell has the answer.
    await expect(senderDesk.getByText('Two Devices accepted your meeting request')).toBeVisible({ timeout: 30_000 });
    console.log('  ✓ accepted on one device; the bell open on the other turned to Accepted, and the sender was told, live.');
  } finally {
    await cleanup(pool, { ids: [two.id] });
  }
});

test('pressing the other answer on a bell that has not caught up says which answer the request already has', async () => {
  test.setTimeout(120_000);
  const late = await createTestUser('mrbelllate');
  try {
    const p = await apiAs(sender, 'POST', '/pokes', { recipientId: late.id, message: 'Coffee?' });
    expect(p.status).toBe(201);
    const page = await openAs(late, '/', { width: 390, height: 844 });
    await bellButton(page).click();
    await expect(page.getByText('Bell Sender asked to meet you')).toBeVisible({ timeout: 30_000 });

    // Hold the bell's list where it is (a phone that lost its connection for a moment), and accept elsewhere.
    await page.route('**/api/notifications', (route) => (route.request().method() === 'GET' ? route.abort() : route.continue()));
    expect((await apiAs(late, 'POST', `/pokes/${p.json.data.id}/accept`)).status).toBe(200);
    await page.getByRole('button', { name: /^Decline$/ }).click();
    await expect(page.getByRole('status').getByText('You already accepted this request.', { exact: true })).toBeVisible({ timeout: 15_000 });
    const row = await pool.query(`SELECT status FROM user_pokes WHERE id = $1`, [p.json.data.id]);
    expect(row.rows[0].status, 'the stale Decline changed nothing').toBe('accepted');

    // Back on the network, the entry reads what the server says.
    await page.unroute('**/api/notifications');
    await closeBell(page);
    await reopenBellOn(page);
    await expect(page.getByText(/^Accepted$/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /^Decline$/ })).toHaveCount(0);
    console.log('  ✓ the stale Decline was told "You already accepted this request." and the entry redrew as Accepted.');
  } finally {
    await cleanup(pool, { ids: [late.id] });
  }
});

test('the Messages list card and the focused card share one answer: while one is answering, the other offers no second answer', async () => {
  test.setTimeout(120_000);
  const dual = await createTestUser('mrbelldual');
  try {
    const p = await apiAs(sender, 'POST', '/pokes', { recipientId: dual.id, message: 'Coffee?' });
    expect(p.status).toBe(201);
    const pokeId = p.json.data.id;
    // A laptop width: the list card on the left and the focused card on the right, both on screen.
    const page = await openAs(dual, `/messages?poke=${pokeId}`, { width: 1280, height: 900 });
    const listCard = page.locator(`[data-testid="meeting-request"][data-poke-id="${pokeId}"]`);
    const focused = page.getByTestId('focused-meeting-request');
    await expect(listCard).toBeVisible({ timeout: 30_000 });
    await expect(focused).toBeVisible({ timeout: 30_000 });
    // Every way into the sender's profile on both cards (avatar, name, "View full profile") is at least 44px to press.
    for (const link of await page.locator('[data-testid="meeting-request"] a, [data-testid="focused-meeting-request"] a').all()) {
      const box = await link.boundingBox();
      expect(box?.height ?? 0, `profile link "${(await link.textContent())?.trim() || 'avatar'}"`).toBeGreaterThanOrEqual(44);
    }

    // Slow the answer down so the moment in between can be seen.
    await page.route('**/api/pokes/*/accept', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });
    await listCard.getByRole('button', { name: /^Accept$/ }).click();
    await expect(focused.getByRole('button', { name: /Accept/ })).toBeDisabled();
    await expect(focused.getByRole('button', { name: /Decline/ })).toBeDisabled();
    await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const row = await pool.query(`SELECT status FROM user_pokes WHERE id = $1`, [pokeId]);
    expect(row.rows[0].status).toBe('accepted');
    console.log('  ✓ one answer in flight: the focused card waited while the list card answered.');
  } finally {
    await cleanup(pool, { ids: [dual.id] });
  }
});

test('a double click on Accept answers once: one request to the server, one trip into the conversation, no second toast', async () => {
  test.setTimeout(120_000);
  const twice = await createTestUser('mrbelltwice');
  try {
    const p = await apiAs(sender, 'POST', '/pokes', { recipientId: twice.id, message: 'Coffee?' });
    expect(p.status).toBe(201);
    const pokeId = p.json.data.id;
    const page = await openAs(twice, '/');
    const answers: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/pokes\/[^/]+\/(accept|decline)$/.test(new URL(r.url()).pathname)) answers.push(r.url());
    });
    await bellButton(page).click();
    await expect(page.getByText('Bell Sender asked to meet you')).toBeVisible({ timeout: 30_000 });
    // Two presses in the same instant, before the page can redraw: the button's disabled state only comes a render later.
    await page.getByRole('button', { name: /^Accept$/ }).first().evaluate((el: HTMLElement) => { el.click(); el.click(); });
    await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    expect(answers, 'one answer sent').toHaveLength(1);
    await expect(page.getByText('You already accepted this request.')).toHaveCount(0);
    await expect(page.getByRole('alert').getByText(/\S/)).toHaveCount(0);
    expect((await pool.query(`SELECT status FROM user_pokes WHERE id = $1`, [pokeId])).rows[0].status).toBe('accepted');
    console.log('  ✓ a double click sent one answer and went into the conversation once.');
  } finally {
    await cleanup(pool, { ids: [twice.id] });
  }
});

test('asking someone who has already asked you is a match: one request, accepted, and one conversation', async () => {
  test.setTimeout(60_000);
  const x = await createTestUser('mrbellmutualx');
  const y = await createTestUser('mrbellmutualy');
  try {
    const first = await apiAs(x, 'POST', '/pokes', { recipientId: y.id, message: 'Hello' });
    expect(first.status).toBe(201);
    expect(first.json.data.status).toBe('pending');

    const back = await apiAs(y, 'POST', '/pokes', { recipientId: x.id, message: 'Hello back' });
    expect(back.status, JSON.stringify(back.json)).toBe(201);
    expect(back.json.data).toMatchObject({ id: first.json.data.id, status: 'accepted' });
    expect(back.json.data.conversationId).toBeTruthy();

    const rows = await pool.query(
      `SELECT status FROM user_pokes WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)`, [x.id, y.id]);
    expect(rows.rows.map(r => r.status)).toEqual(['accepted']);
    const conv = await pool.query(
      `SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [x.id, y.id]);
    expect(conv.rows.map(r => r.id)).toEqual([back.json.data.conversationId]);

    // y's bell entry for x's request now reads accepted; x was told the way an accept tells them.
    const bell = await apiAs(y, 'GET', '/notifications');
    const entry = bell.json.data.notifications.find((n: { type: string }) => n.type === 'poke');
    expect(entry).toMatchObject({ pokeStatus: 'accepted', requestState: { status: 'accepted', conversationId: back.json.data.conversationId }, isRead: true });
    const told = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'poke_accepted'`, [x.id]);
    expect(told.rows[0].n).toBe(1);
    console.log('  ✓ asking back made a match: one request, accepted, one conversation.');
  } finally {
    await cleanup(pool, { ids: [x.id, y.id] });
  }
});

test('an accept and a decline sent at the same moment end in one answer, never both', async () => {
  test.setTimeout(60_000);
  const x = await createTestUser('mrbellracex');
  const y = await createTestUser('mrbellracey');
  try {
    const sent = await apiAs(x, 'POST', '/pokes', { recipientId: y.id, message: 'Race' });
    expect(sent.status).toBe(201);
    const id = sent.json.data.id;

    const [accepted, declined] = await Promise.all([
      apiAs(y, 'POST', `/pokes/${id}/accept`),
      apiAs(y, 'POST', `/pokes/${id}/decline`),
    ]);
    console.log(`  accept → ${accepted.status}, decline → ${declined.status}`);
    const row = await pool.query(`SELECT status FROM user_pokes WHERE id = $1`, [id]);
    const winner = row.rows[0].status as 'accepted' | 'declined';
    expect(['accepted', 'declined']).toContain(winner);
    const loser = winner === 'accepted' ? declined : accepted;
    expect((winner === 'accepted' ? accepted : declined).status).toBe(200);
    expect(loser.status).toBe(409);
    expect(loser.json.error).toMatchObject({ code: 'MEETING_REQUEST_ALREADY_ANSWERED', details: { status: winner } });

    // The rest agrees with the one answer: a conversation exists exactly when it was accepted.
    const conv = await pool.query(
      `SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [x.id, y.id]);
    expect(conv.rows.length).toBe(winner === 'accepted' ? 1 : 0);

    // Answering again the same way is not an error.
    const again = await apiAs(y, 'POST', `/pokes/${id}/${winner === 'accepted' ? 'accept' : 'decline'}`);
    expect(again.status).toBe(200);
    console.log(`  ✓ one answer (${winner}); the other got a 409 naming it; repeating it is a 200.`);
  } finally {
    await cleanup(pool, { ids: [x.id, y.id] });
  }
});
