import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, wait, APP, SERVER } from '../helpers/live-ui';

// PROD VERIFICATION — REASON v1 Phase 1: the standing match loop (17 Jul 2026).
//
// Stefan's flow end-to-end on prod:
//   founder (wants investors) opens Matches → sees the investor with a readable
//   reason → "I want to meet" → investor is notified, accepts → chat unlocked
//   (conversation exists) → the pair stops being suggested.
//   A user nobody fits (the baker) gets the NO-MATCH screen with the three
//   options: join the next RSN, invite people, browse people.
//
// REST drives the flow; a headed browser then verifies both screens for real.

let browser: Browser;
let founder: TestUser, investor: TestUser, baker: TestUser;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Give a test user the intent profile the chatbot onboarding would have
 *  written. NB: professional_role is text[] in the schema — pass arrays. */
async function setIntent(u: TestUser, cols: Record<string, string | string[]>) {
  const keys = Object.keys(cols);
  await pool.query(
    `UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [u.id, ...keys.map(k => cols[k])],
  );
}

async function openAs(u: TestUser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); // mobile-first check
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/matches`);
  return page;
}

test.beforeAll(async () => {
  founder = await createTestUser('pmfounder');
  investor = await createTestUser('pminvestor');
  baker = await createTestUser('pmbaker');
  await setIntent(founder, {
    professional_role: ['Founder'],
    who_i_want_to_meet: 'investors and angels for my seed round',
    my_intent: 'raise funding for my SaaS startup',
  });
  await setIntent(investor, {
    professional_role: ['Angel Investor'],
    expertise_text: 'early stage SaaS investing',
  });
  await setIntent(baker, {
    professional_role: ['Pastry Chef'],
    who_i_want_to_meet: 'nobody in particular',
    expertise_text: 'sourdough croissants',
  });
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [founder?.id, investor?.id, baker?.id].filter(Boolean);
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
});

test('standing match loop: suggest → I want to meet → accept → chat unlocked → no longer suggested', async () => {
  test.setTimeout(240_000);

  // (1) The founder's standing match check finds the investor, with a reason.
  const f1 = await apiAs(founder, 'GET', '/matches/platform');
  expect(f1.status).toBe(200);
  const suggested = f1.json.data.matches.map((m: any) => m.userId);
  expect(suggested, 'founder must be shown the investor').toContain(investor.id);
  expect(suggested, 'the baker fits nothing the founder wants').not.toContain(baker.id);
  const card = f1.json.data.matches.find((m: any) => m.userId === investor.id);
  expect(card.reason).toMatch(/investor/i);
  console.log(`  ✓ founder sees investor. reason: "${card.reason}"`);

  // (2) Nobody fits the baker → the no-match payload (options render client-side).
  const b1 = await apiAs(baker, 'GET', '/matches/platform');
  expect(b1.status).toBe(200);
  expect(b1.json.data.matches).toEqual([]);
  console.log('  ✓ baker gets the no-match payload.');

  // (3) HEADED: the founder's real screen shows the card + button; the baker's
  //     shows the three no-match options. Mobile viewport (390px).
  const fPage = await openAs(founder);
  // CRITICAL: the founder's list also contains REAL prod users who fit the
  // "investor" want. Scope every assertion + click to OUR investor's card
  // (the one whose profile link is our test user) — never .first(), which once
  // sent an introduction to a real member.
  const investorCard = fPage.locator(`div.card-hover:has(a[href="/profile/${investor.id}"])`);
  await expect(investorCard).toBeVisible({ timeout: 20_000 });
  await expect(investorCard.getByRole('button', { name: /I want to meet/i })).toBeVisible();
  await fPage.screenshot({ path: 'test-results/pm-founder-match.png' }).catch(() => {});
  const bPage = await openAs(baker);
  await expect(bPage.getByText(/Join the next RSN/i)).toBeVisible({ timeout: 20_000 });
  await expect(bPage.getByText(/Invite people/i)).toBeVisible();
  await expect(bPage.getByText(/Browse people/i)).toBeVisible();
  await expect(bPage.getByText(/we'll notify you/i)).toBeVisible();
  await bPage.screenshot({ path: 'test-results/pm-baker-nomatch.png' }).catch(() => {});
  console.log('  ✓ headed: match card (founder) + full no-match screen (baker) render on mobile width.');

  // (4) The founder clicks the real button ON OUR INVESTOR'S CARD — the
  // introduction goes out to our test user, nobody else.
  await investorCard.getByRole('button', { name: /I want to meet/i }).click();
  await expect(investorCard.getByText(/Introduction requested/i)).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ headed: "I want to meet" → Introduction requested.');

  // (5) The investor received it (poke rails) with the intro as the message,
  //     plus a bell notification.
  const inbox = await apiAs(investor, 'GET', '/pokes/received');
  expect(inbox.status).toBe(200);
  const poke = inbox.json.data.find((p: any) => p.senderId === founder.id);
  expect(poke, 'investor must have the pending introduction').toBeTruthy();
  expect(poke.message).toMatch(/should meet/i);
  const notif = await pool.query(
    `SELECT id FROM notifications WHERE user_id = $1 AND type = 'poke'`, [investor.id]);
  expect(notif.rows.length, 'investor must have a bell notification').toBeGreaterThanOrEqual(1);
  console.log(`  ✓ investor notified. intro: "${poke.message}"`);

  // (6) The investor accepts → both sides mutual → the chat is unlocked.
  const accept = await apiAs(investor, 'POST', `/pokes/${poke.id}/accept`);
  expect(accept.status).toBe(200);
  expect(accept.json.data.conversationId).toBeTruthy();
  const conv = await pool.query(
    `SELECT id FROM dm_conversations
     WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)`,
    [founder.id, investor.id]);
  expect(conv.rows.length, 'mutual yes must open a conversation').toBe(1);
  console.log('  ✓ investor accepted → conversation exists (chat unlocked).');

  // (7) The pair is no longer suggested to the founder (encounter now exists).
  const f2 = await apiAs(founder, 'GET', '/matches/platform');
  expect(f2.json.data.matches.map((m: any) => m.userId)).not.toContain(investor.id);
  console.log('  ✓ matched pair no longer suggested — the loop closes.');
});
