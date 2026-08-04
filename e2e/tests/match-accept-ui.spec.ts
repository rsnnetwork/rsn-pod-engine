import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, wait, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// P1 — MATCH ACCEPT, DRIVEN ENTIRELY THROUGH THE UI (30 Jul 2026 evaluation).
//
// The 30-Jul live test found: "Clicking the notification opens the chat, but
// the recipient cannot accept the match or start the conversation." Root cause:
// the accept/decline API has existed since May but NOTHING in the client ever
// called it — the poke notification links to /messages, and /messages is driven
// purely by dm_conversations, which acceptPoke itself creates. The recipient
// was routed to the one page guaranteed to be empty until the very action they
// could not perform.
//
// The existing platform-match-loop spec missed it because it accepted via
// `apiAs(investor, 'POST', '/pokes/:id/accept')` — raw REST, never a click.
// EVERY assertion here goes through the rendered UI on purpose.
//
// Covered: the golden path, decline, empty state, multiple pending, live
// socket arrival, double-accept from a stale tab, mobile tap targets, and the
// sender's acceptance notification.

let browser: Browser;
let sender: TestUser, recipient: TestUser, second: TestUser, lonely: TestUser;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path = '/messages', viewport = { width: 390, height: 844 }): Promise<Page> {
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

/** The pending-request card for a given sender, scoped by their user id so a
 *  real prod member's request can never be clicked by accident. */
const requestCard = (page: Page, fromUserId: string) =>
  page.locator(`[data-testid="meeting-request"][data-sender-id="${fromUserId}"]`);

test.beforeAll(async () => {
  sender = await createTestUser('maSender');
  recipient = await createTestUser('maRecipient');
  second = await createTestUser('maSecond');
  lonely = await createTestUser('maLonely');
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [sender?.id, recipient?.id, second?.id, lonely?.id].filter(Boolean);
  await pool.query(`DELETE FROM direct_messages WHERE from_user_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM encounter_history WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  // Belt for users created inside a test (maLive, maStale, maMultiA/B): their
  // per-test cleanup is skipped when an assertion above it fails.
  const swept = await cleanupByPrefix(pool, 'e2etest-ma');
  if (swept) console.log(`  swept ${swept} leftover ma* test account(s)`);
});

test('a member with no requests sees no pending section (empty state)', async () => {
  test.setTimeout(120_000);
  const page = await openAs(lonely);
  // Scope to the panel heading — the sidebar nav's "Messages" link is
  // display:none at phone width, so a bare getByText().first() picks a hidden node.
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="meeting-request"]')).toHaveCount(0);
  await expect(page.getByText(/Meeting requests/i)).toHaveCount(0);
  console.log('  ✓ no phantom section when there is nothing pending.');
});

test('golden path: request is visible, accept opens the conversation with the intro', async () => {
  test.setTimeout(240_000);
  const INTRO = 'I saw you build B2B sales teams — we should meet about my seed round.';
  const sent = await apiAs(sender, 'POST', '/pokes', { recipientId: recipient.id, message: INTRO });
  expect(sent.status).toBe(201);

  const page = await openAs(recipient);
  const card = requestCard(page, sender.id);

  // The request is visible on the page the notification actually links to.
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText(recipient.displayName ? /E2E Test maSender/i : /maSender/i);
  await expect(card, 'the intro text must be readable BEFORE deciding').toContainText(/seed round/i);
  await page.screenshot({ path: 'test-results/ma-pending-request.png' }).catch(() => {});

  // Mobile tap targets — standing rule: >= 44px.
  const acceptBtn = card.getByRole('button', { name: /^Accept$/i });
  const declineBtn = card.getByRole('button', { name: /^Decline$/i });
  await expect(acceptBtn).toBeVisible();
  await expect(declineBtn).toBeVisible();
  for (const [label, btn] of [['accept', acceptBtn], ['decline', declineBtn]] as const) {
    const box = await btn.boundingBox();
    expect(box, `${label} button must render`).toBeTruthy();
    expect(box!.height, `${label} tap target >= 44px`).toBeGreaterThanOrEqual(44);
  }

  // Accept through the UI — the whole point of this spec.
  await acceptBtn.click();

  // The conversation opens and the intro is the first message.
  await expect(page.getByText(/seed round/i).first()).toBeVisible({ timeout: 30_000 });
  await expect(card, 'the handled request must leave the pending list').toHaveCount(0, { timeout: 15_000 });
  await page.screenshot({ path: 'test-results/ma-after-accept.png' }).catch(() => {});

  // DB truth: poke accepted, conversation + seeded intro exist, DMs unlocked.
  const poke = await pool.query(
    `SELECT status FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [sender.id, recipient.id]);
  expect(poke.rows[0]?.status, 'accept must persist').toBe('accepted');
  const conv = await pool.query(
    `SELECT id FROM dm_conversations
     WHERE user_a_id = LEAST($1::uuid,$2::uuid) AND user_b_id = GREATEST($1::uuid,$2::uuid)`,
    [sender.id, recipient.id]);
  expect(conv.rows.length, 'accepting must create the conversation').toBe(1);
  const enc = await pool.query(
    `SELECT id FROM encounter_history
     WHERE user_a_id = LEAST($1::uuid,$2::uuid) AND user_b_id = GREATEST($1::uuid,$2::uuid)`,
    [sender.id, recipient.id]);
  expect(enc.rows.length, 'accepting must unlock DMs both ways').toBe(1);

  // The SENDER is told, in-app, that it was accepted.
  const senderNotif = await pool.query(
    `SELECT title FROM notifications WHERE user_id = $1 AND type = 'poke_accepted'`, [sender.id]);
  expect(senderNotif.rows.length, 'sender must get an acceptance notification').toBeGreaterThanOrEqual(1);
  console.log(`  ✓ accepted via UI; sender notified: "${senderNotif.rows[0].title}"`);

  // And the sender can now actually reach the thread from their own inbox.
  const sPage = await openAs(sender);
  await expect(sPage.getByText(/seed round/i).first()).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ sender sees the opened conversation in their inbox.');
});

test('decline removes the request and opens no conversation', async () => {
  test.setTimeout(240_000);
  const sent = await apiAs(second, 'POST', '/pokes', { recipientId: recipient.id, message: 'Coffee sometime?' });
  expect(sent.status).toBe(201);

  const page = await openAs(recipient);
  const card = requestCard(page, second.id);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: /^Decline$/i }).click();
  await expect(card).toHaveCount(0, { timeout: 15_000 });

  const poke = await pool.query(
    `SELECT status FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [second.id, recipient.id]);
  expect(poke.rows[0]?.status).toBe('declined');
  const conv = await pool.query(
    `SELECT id FROM dm_conversations
     WHERE user_a_id = LEAST($1::uuid,$2::uuid) AND user_b_id = GREATEST($1::uuid,$2::uuid)`,
    [second.id, recipient.id]);
  expect(conv.rows.length, 'declining must NOT open a conversation').toBe(0);
  console.log('  ✓ decline is terminal and opens nothing.');
});

test('a request arriving while the page is open appears without a refresh', async () => {
  test.setTimeout(240_000);
  const live = await createTestUser('maLive');
  const page = await openAs(recipient);
  // Scope to the panel heading — the sidebar nav's "Messages" link is
  // display:none at phone width, so a bare getByText().first() picks a hidden node.
  await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible({ timeout: 30_000 });

  await apiAs(live, 'POST', '/pokes', { recipientId: recipient.id, message: 'Just joined, would love to talk.' });
  // Socket fanout is the fast path; the 20s poll is the guarantee. Allow for
  // the slower of the two so this asserts the guarantee, not a lucky race.
  await expect(requestCard(page, live.id), 'an arriving request must surface with no refresh').toBeVisible({ timeout: 60_000 });
  console.log('  ✓ arrives with no refresh (socket fast path + poll belt).');

  await pool.query(`DELETE FROM user_pokes WHERE sender_id = $1`, [live.id]).catch(() => {});
  await cleanup(pool, { ids: [live.id] });
});

test('a stale second accept fails gracefully instead of breaking the page', async () => {
  test.setTimeout(240_000);
  const stale = await createTestUser('maStale');
  const sent = await apiAs(stale, 'POST', '/pokes', { recipientId: recipient.id, message: 'Double click test.' });
  expect(sent.status).toBe(201);
  const pokeId = sent.json.data.id;

  const page = await openAs(recipient);
  const card = requestCard(page, stale.id);
  await expect(card).toBeVisible({ timeout: 30_000 });

  // Another tab (or the sender's own retry) resolves it first.
  const first = await apiAs(recipient, 'POST', `/pokes/${pokeId}/accept`);
  expect(first.status).toBe(200);

  // This stale card's Accept must not leave the user stranded on a broken page.
  await card.getByRole('button', { name: /^Accept$/i }).click();
  await expect(card).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('body')).toBeVisible();
  const accepted = await pool.query(
    `SELECT status FROM user_pokes WHERE id = $1`, [pokeId]);
  expect(accepted.rows[0].status, 'still exactly one accept').toBe('accepted');
  console.log('  ✓ stale accept degrades cleanly.');

  await pool.query(`DELETE FROM direct_messages WHERE from_user_id = $1`, [stale.id]).catch(() => {});
  await pool.query(`DELETE FROM dm_conversations WHERE user_a_id = $1 OR user_b_id = $1`, [stale.id]).catch(() => {});
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = $1`, [stale.id]).catch(() => {});
  await pool.query(`DELETE FROM encounter_history WHERE user_a_id = $1 OR user_b_id = $1`, [stale.id]).catch(() => {});
  await cleanup(pool, { ids: [stale.id] });
});

test('several pending requests all render, on phone and desktop widths', async () => {
  test.setTimeout(240_000);
  const a = await createTestUser('maMultiA');
  const b = await createTestUser('maMultiB');
  await apiAs(a, 'POST', '/pokes', { recipientId: lonely.id, message: 'First request.' });
  await apiAs(b, 'POST', '/pokes', { recipientId: lonely.id, message: 'Second request.' });

  for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const page = await openAs(lonely, '/messages', vp);
    await expect(requestCard(page, a.id)).toBeVisible({ timeout: 30_000 });
    await expect(requestCard(page, b.id)).toBeVisible();
    // No horizontal overflow at either width (standing responsive rule).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `no horizontal scroll at ${vp.width}px`).toBeLessThanOrEqual(1);
    console.log(`  ✓ both requests render at ${vp.width}px, no overflow.`);
  }

  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1)`, [[a.id, b.id]]).catch(() => {});
  await cleanup(pool, { ids: [a.id, b.id] });
});
