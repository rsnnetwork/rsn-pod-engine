import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// W2 (7 Sep 2026) — DM delivery reaches the other party WITHOUT a refresh.
//
// Stefan's test: "Ali sent Stefan a message, but Stefan did not receive it."
// The immediate cause was Stefan's dead session (fixed in W1). But the audit
// also found two real fan-out holes that would drop delivery independently:
//   • acceptPoke created the conversation but emitted nothing to the SENDER, so
//     the sender's inbox never gained it until a manual refresh.
//   • confirmWindow persisted the "Meeting confirmed" message with no fan-out,
//     so the partner's open thread never showed it.
// Both now route through broadcastDmMessage(notify:false). These two live,
// two-browser assertions prove the message actually lands on the other screen.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let sender: TestUser, recip1: TestUser, recip2: TestUser;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await browser.newContext(contextOptions());
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

function futureWindowKey(daysAhead = 2, daypart = 'afternoon'): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.toISOString().slice(0, 10)}:${daypart}`;
}

async function convBetween(a: string, b: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations
      WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
    [a, b],
  );
  return r.rows[0]?.id;
}

test.beforeAll(async () => {
  sender = await createTestUser('dmlivSender');
  recip1 = await createTestUser('dmlivRecip1');
  recip2 = await createTestUser('dmlivRecip2');
  // Give the sender a real-looking name so the recipient's UI has something to
  // render; not load-bearing for the assertions.
  await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, ['DM Live Sender', sender.id]);
  console.log(`[dm-live-delivery] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanup(pool, { ids: [sender.id, recip1.id, recip2.id] });
  await cleanupByPrefix(pool, 'e2etest-dmliv');
  await pool.end().catch(() => {});
});

test('acceptPoke: the SENDER\'s open inbox gains the conversation live, no refresh', async () => {
  test.setTimeout(120_000);
  const INTRO = `Live inbox delivery ${Date.now()}`;

  // Sender is sitting on their (empty-for-this-pair) inbox.
  const senderPage = await openAs(sender, '/messages');
  await senderPage.waitForTimeout(3000);
  await expect(senderPage.getByText(INTRO)).toHaveCount(0);

  // Sender pokes recipient; recipient accepts via API (a real second actor).
  const sent = await apiAs(sender, 'POST', '/pokes', { recipientId: recip1.id, message: INTRO });
  expect(sent.status, 'poke created').toBe(201);
  const pokeId = sent.json?.data?.id;
  expect(pokeId).toBeTruthy();

  const accepted = await apiAs(recip1, 'POST', `/pokes/${pokeId}/accept`);
  expect(accepted.status, 'poke accepted').toBe(200);

  // The conversation must appear on the sender's ALREADY-OPEN inbox with no
  // reload — this is exactly the fan-out that was missing.
  await expect(senderPage.getByText(INTRO, { exact: false })).toBeVisible({ timeout: 20_000 });
});

test('confirmWindow: the partner\'s open thread shows the confirmation live, no refresh', async () => {
  test.setTimeout(120_000);
  const INTRO = `Sched pair ${Date.now()}`;

  // Connect sender + recip2 (poke → accept via API — not what we're testing here).
  const sent = await apiAs(sender, 'POST', '/pokes', { recipientId: recip2.id, message: INTRO });
  expect(sent.status).toBe(201);
  const pokeId = sent.json?.data?.id;
  const accepted = await apiAs(recip2, 'POST', `/pokes/${pokeId}/accept`);
  expect(accepted.status).toBe(200);

  const convId = await convBetween(sender.id, recip2.id);
  expect(convId, 'conversation exists after accept').toBeTruthy();

  // Both pick the same window.
  const KEY = futureWindowKey(3, 'evening');
  expect((await apiAs(sender, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);
  expect((await apiAs(recip2, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);

  // Recipient is watching the thread. Sender confirms via API.
  const recipPage = await openAs(recip2, `/messages/${convId}`);
  await recipPage.waitForTimeout(3000);
  await expect(recipPage.getByText(/Meeting confirmed/i)).toHaveCount(0);

  const confirmed = await apiAs(sender, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, { window: KEY });
  expect(confirmed.status, 'confirm succeeded').toBe(200);

  // The confirmation must appear in the partner's open view with no reload — the
  // fan-out confirmWindow was missing. It lands in BOTH the thread bubble and the
  // inbox preview; on mobile the inbox pane is display:hidden, so assert the
  // VISIBLE occurrence (thread bubble on mobile, either on desktop).
  await expect(recipPage.getByText(/Meeting confirmed/i).filter({ visible: true }).first())
    .toBeVisible({ timeout: 20_000 });
});
