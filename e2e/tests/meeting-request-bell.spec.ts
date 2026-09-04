import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

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

let browser: Browser;
let sender: TestUser;
let recipient: TestUser;
let decliner: TestUser;
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
  const ctx = await browser.newContext({ viewport });
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

test.beforeAll(async () => {
  sender = await createTestUser('mrbellsender');
  recipient = await createTestUser('mrbellrecipient');
  decliner = await createTestUser('mrbelldecliner');
  await pool.query(`UPDATE users SET display_name = 'Bell Sender' WHERE id = $1`, [sender.id]);
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [sender?.id, recipient?.id, decliner?.id].filter(Boolean) });
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

  // A pasted address is a link, on the recipient's own screen and on the sender's.
  const input = page.getByPlaceholder(/Type a message/i);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('Here is what I meant www.example.com and also https://rsn.network/about.');
  await input.press('Enter');
  const mine = page.locator(`a[href="https://www.example.com"]`).first();
  await expect(mine).toBeVisible({ timeout: 30_000 });
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
});
