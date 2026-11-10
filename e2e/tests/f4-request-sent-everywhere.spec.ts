import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// F4 (10 Nov 2026, Stefan: "if I have ALREADY asked them, why is that not shown?").
//
// Find people kept "sent" only in the page's memory, so a reload offered "I want to meet" again for someone already
// asked. Every place that offers the ask now shows "Request sent" from the server, with "Withdraw request" beside it.
// Withdrawing marks the request cancelled: the person is back to "I want to meet" everywhere, the recipient's list
// and bell stop offering it at once (no refresh), and the sender may ask again.
//
// Outcomes only: the user_pokes row, the bell row, the cards on the page, and both sides of the pair.

let browser: Browser;
let seeker: TestUser;   // asks, withdraws, asks again
let target: TestUser;   // is asked; watches their request list live
let other: TestUser;    // asks the seeker: an incoming request keeps "I want to meet" on Find people
let decliner: TestUser; // declines the seeker: Find people then reads "Request declined" (fix round 1)
const ctxs: BrowserContext[] = [];
const RUN = Date.now().toString(36);
const TARGET_NAME = `Wilhelmina Fourquest ${RUN}`;
const OTHER_NAME = `Wilhelmina Otherway ${RUN}`;
const DECLINER_NAME = `Wilhelmina Saysno ${RUN}`;

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string, viewport = { width: 360, height: 780 }): Promise<Page> {
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

async function fitsViewport(page: Page, el: ReturnType<Page['getByTestId']>, what: string) {
  const vw = page.viewportSize()!.width;
  const box = await el.boundingBox();
  expect(box, `${what} is on screen`).not.toBeNull();
  expect(box!.height, `${what}: tap target`).toBeGreaterThanOrEqual(44);
  expect(box!.x, `${what}: left edge inside`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what}: right edge inside ${vw}px`).toBeLessThanOrEqual(vw);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
}

const requestsBetween = async (from: TestUser, to: TestUser) => (await pool.query(
  `SELECT id, status, cancelled_at FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2 ORDER BY created_at`,
  [from.id, to.id])).rows as Array<{ id: string; status: string; cancelled_at: Date | null }>;
const unreadRequestBells = async (u: TestUser, requestId: string) => (await pool.query(
  `SELECT id FROM notifications WHERE user_id = $1 AND type = 'poke' AND link = $2 AND is_read = FALSE`,
  [u.id, `/messages?poke=${requestId}`])).rows.length;
const searchCard = async (u: TestUser, q: string, id: string) =>
  ((await apiAs(u, 'GET', `/users/find?q=${encodeURIComponent(q)}`)).json?.data ?? []).find((r: any) => r.userId === id);

async function searchFor(page: Page, q: string, id: string) {
  const box = page.getByRole('main').getByPlaceholder(/Search people/i);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.fill(q);
  const card = page.getByTestId(`search-result-${id}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

test.beforeAll(async () => {
  seeker = await createTestUser('f4seeker');
  target = await createTestUser('f4target');
  other = await createTestUser('f4other');
  decliner = await createTestUser('f4decliner');
  await pool.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [decliner.id, DECLINER_NAME]);
  await pool.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [target.id, TARGET_NAME]);
  await pool.query(`UPDATE users SET display_name = $2 WHERE id = $1`, [other.id, OTHER_NAME]);
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [seeker?.id, target?.id, other?.id, decliner?.id].filter(Boolean) });
  const swept = await cleanupByPrefix(pool, 'e2etest-f4');
  if (swept) console.log(`  swept ${swept} leftover f4* account(s)`);
});

test('Find people: send, reload keeps "Request sent", withdraw, reload shows "I want to meet"; the recipient\'s list follows live', async () => {
  test.setTimeout(300_000);

  // The recipient's Messages page is open the whole time: their request list must change with no reload.
  const inbox = await openAs(target, '/messages', { width: 390, height: 844 });

  const page = await openAs(seeker, '/search');
  let card = await searchFor(page, 'Fourquest', target.id);
  await card.getByRole('button', { name: /I want to meet/i }).click();

  const sent = page.getByTestId(`search-request-sent-${target.id}`);
  await expect(sent).toHaveText(/Request sent/i, { timeout: 30_000 });
  const withdraw = card.getByRole('button', { name: /Withdraw request/i });
  await expect(withdraw).toBeVisible();
  await fitsViewport(page, page.getByTestId(`withdraw-request-${target.id}`), 'Withdraw request at 360px');
  await fitsViewport(page, sent, 'Request sent at 360px');
  const [asked] = await requestsBetween(seeker, target);
  expect(asked.status, 'the request row is pending').toBe('pending');
  expect(await unreadRequestBells(target, asked.id), 'the recipient has an unread bell row for it').toBe(1);

  // The recipient sees it arrive, live.
  const theirCard = inbox.getByTestId('meeting-request');
  await expect(theirCard, 'the recipient\'s list shows the request with no reload').toBeVisible({ timeout: 30_000 });

  // Reload: the state is the server's, not the page's memory. The card cannot ask again.
  await page.reload();
  card = await searchFor(page, 'Fourquest', target.id);
  await expect(page.getByTestId(`search-request-sent-${target.id}`)).toHaveText(/Request sent/i, { timeout: 30_000 });
  await expect(card.getByRole('button', { name: /I want to meet/i }), 'no way to ask twice').toHaveCount(0);
  expect(await searchCard(seeker, 'Fourquest', target.id)).toMatchObject({ pokeStatus: 'pending', pokeSentByOwner: true });
  expect(await searchCard(target, 'f4seeker', seeker.id), 'the other side reads it as sent TO them')
    .toMatchObject({ pokeStatus: 'pending', pokeSentByOwner: false });

  // Withdraw.
  await card.getByRole('button', { name: /Withdraw request/i }).click();
  await expect(card.getByRole('button', { name: /I want to meet/i })).toBeVisible({ timeout: 30_000 });
  const [withdrawn] = await requestsBetween(seeker, target);
  expect(withdrawn.status, 'the row is cancelled').toBe('cancelled');
  expect(withdrawn.cancelled_at, 'with the time it was').not.toBeNull();
  expect(await unreadRequestBells(target, asked.id), 'the recipient\'s unread bell row for it is gone').toBe(0);
  await expect(theirCard, 'the recipient\'s list drops it with no reload').toHaveCount(0, { timeout: 30_000 });

  await page.reload();
  card = await searchFor(page, 'Fourquest', target.id);
  await expect(card.getByRole('button', { name: /I want to meet/i }), 'after a reload: fresh again').toBeVisible({ timeout: 30_000 });
  expect(await searchCard(seeker, 'Fourquest', target.id)).toMatchObject({ pokeStatus: null, pokeSentByOwner: null });

  // Asking again is allowed: a withdrawal is not a "no".
  await card.getByRole('button', { name: /I want to meet/i }).click();
  await expect(page.getByTestId(`search-request-sent-${target.id}`)).toHaveText(/Request sent/i, { timeout: 30_000 });
  const rows = await requestsBetween(seeker, target);
  expect(rows.map(r => r.status), 'the old row stays cancelled, a new one waits').toEqual(['cancelled', 'pending']);
  await expect(theirCard, 'and it is back on the recipient\'s list, live').toBeVisible({ timeout: 30_000 });
  console.log('  ✓ Find people: sent -> reload keeps it -> withdrawn -> reload fresh -> asked again; recipient list followed live.');
});

test('only the sender withdraws, once; an incoming request keeps "I want to meet" on Find people', async () => {
  test.setTimeout(120_000);
  const [live] = (await requestsBetween(seeker, target)).filter(r => r.status === 'pending');
  expect(live, 'the request from the first test is waiting').toBeTruthy();

  const byRecipient = await apiAs(target, 'POST', `/pokes/${live.id}/withdraw`);
  expect(byRecipient.status, 'the recipient cannot withdraw it').toBe(403);
  const byOther = await apiAs(other, 'POST', `/pokes/${live.id}/withdraw`);
  expect(byOther.status, 'nor can anyone else').toBe(403);

  const first = await apiAs(seeker, 'POST', `/pokes/${live.id}/withdraw`);
  expect(first.status).toBe(200);
  const second = await apiAs(seeker, 'POST', `/pokes/${live.id}/withdraw`);
  expect(second.status, 'twice is a conflict').toBe(409);
  expect(second.json?.error?.details?.status).toBe('cancelled');

  // Someone who asked the seeker: on Find people the seeker still sees "I want to meet" (pressing it is the match).
  const asks = await apiAs(other, 'POST', '/pokes', { recipientId: seeker.id });
  expect(asks.status).toBe(201);
  expect(await searchCard(seeker, 'Otherway', other.id)).toMatchObject({ pokeStatus: 'pending', pokeSentByOwner: false });
  const page = await openAs(seeker, '/search');
  const card = await searchFor(page, 'Otherway', other.id);
  await expect(card.getByRole('button', { name: /I want to meet/i })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('button', { name: /Withdraw request/i })).toHaveCount(0);
  console.log('  ✓ recipient 403, stranger 403, twice 409; incoming request keeps "I want to meet".');
});

test('the profile bar offers Withdraw beside "Request sent", inside a 360px phone', async () => {
  test.setTimeout(180_000);
  const ask = await apiAs(seeker, 'POST', `/matches/platform/${target.id}/interest`);
  expect(ask.status).toBe(201);

  const page = await openAs(seeker, `/people/${target.id}?from=People`);
  const bar = page.getByRole('region', { name: 'Your move' });
  await expect(bar.getByRole('button', { name: /Request sent/i })).toBeVisible({ timeout: 30_000 });
  const withdraw = page.getByTestId(`withdraw-request-${target.id}`);
  await expect(withdraw).toBeVisible();
  await fitsViewport(page, withdraw, 'the bar\'s Withdraw at 360px');
  await withdraw.click();
  await expect(bar.getByRole('button', { name: /^Meet$/ })).toBeVisible({ timeout: 30_000 });
  const statuses = (await requestsBetween(seeker, target)).map(r => r.status);
  expect(statuses.filter(s => s === 'pending'), 'nothing left waiting').toHaveLength(0);
  console.log('  ✓ profile bar: Request sent + Withdraw fit 360px; withdrawing brings Meet back.');
});

test('Find people: a request they declined reads "Request declined", inert; the one who declined can still ask', async () => {
  test.setTimeout(150_000);
  const sent = await apiAs(seeker, 'POST', '/pokes', { recipientId: decliner.id });
  expect(sent.status).toBe(201);
  const declined = await apiAs(decliner, 'POST', `/pokes/${sent.json.data.id}/decline`);
  expect(declined.status).toBe(200);

  expect(await searchCard(seeker, 'Saysno', decliner.id), 'the sender reads the decline')
    .toMatchObject({ pokeStatus: null, declinedByThem: true });
  expect(await searchCard(decliner, 'f4seeker', seeker.id), 'the one who declined reads nothing')
    .toMatchObject({ pokeStatus: null, declinedByThem: false });

  const page = await openAs(seeker, '/search');
  const card = await searchFor(page, 'Saysno', decliner.id);
  const state = page.getByTestId(`search-request-declined-${decliner.id}`);
  await expect(state).toHaveText(/Request declined/i, { timeout: 30_000 });
  await fitsViewport(page, state, 'Request declined at 360px');
  await expect(card.getByRole('button', { name: /I want to meet/i }), 'no button that can only be refused').toHaveCount(0);

  const theirs = await openAs(decliner, '/search');
  const back = await searchFor(theirs, 'f4seeker', seeker.id);
  await expect(back.getByRole('button', { name: /I want to meet/i }), 'the decliner can still ask').toBeVisible({ timeout: 30_000 });
  console.log('  ✓ declined: sender sees an inert "Request declined" at 360px; the decliner still sees "I want to meet".');
});
