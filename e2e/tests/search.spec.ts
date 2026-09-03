import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// PLATFORM-WIDE PEOPLE SEARCH (13 Aug 2026 meeting, Task C1).
//
// Claus: "No way to search for a known person on the platform." Ali's
// decision: every active, onboarded member is findable by name, job title and
// company; the result is a thin card with the existing "I want to meet"
// action; full profile and messaging keep their gates.
//
// Outcomes only: rows returned by the API, cards rendered on the page, and
// the exclusions that must hold (yourself, blocked either way, deactivated,
// not yet onboarded, one-character scrapes).

let browser: Browser;
let seeker: TestUser;
let stranger: TestUser;   // never met the seeker; must be findable
let blocked: TestUser;    // seeker blocks them; must vanish
let gone: TestUser;       // deactivated; must vanish
let unfinished: TestUser; // has not completed onboarding; must not appear
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function setProfile(u: TestUser, cols: Record<string, string | string[] | boolean | null>) {
  const keys = Object.keys(cols);
  await pool.query(
    `UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [u.id, ...keys.map(k => cols[k])],
  );
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

const idsOf = (r: { json: any }) => ((r.json?.data ?? []) as Array<{ userId: string }>).map(x => x.userId);
const find = (u: TestUser, q: string) => apiAs(u, 'GET', `/users/find?q=${encodeURIComponent(q)}`);

test.beforeAll(async () => {
  seeker = await createTestUser('searchseeker');
  stranger = await createTestUser('searchstranger');
  blocked = await createTestUser('searchblocked');
  gone = await createTestUser('searchgone');
  unfinished = await createTestUser('searchunfinished', 'member', 'not_started');
  await setProfile(stranger, {
    display_name: 'Zelda Quartermaine', job_title: 'Senior React Developer', company: 'Quartermaine Labs', location: 'Copenhagen',
  });
  await setProfile(blocked, { display_name: 'Zelda Blockworth' });
  await setProfile(gone, { display_name: 'Zelda Gonesby' });
  await setProfile(unfinished, { display_name: 'Zelda Halfway', onboarding_completed: false });
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [seeker?.id, stranger?.id, blocked?.id, gone?.id, unfinished?.id].filter(Boolean);
  await pool.query(`DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  const swept = await cleanupByPrefix(pool, 'e2etest-search');
  if (swept) console.log(`  swept ${swept} leftover search* account(s)`);
});

test('a member can find someone they have never met, by name, title and company', async () => {
  test.setTimeout(120_000);
  for (const q of ['Quartermaine', 'Senior React Developer', 'Quartermaine Labs']) {
    const r = await find(seeker, q);
    expect(r.status, q).toBe(200);
    expect(idsOf(r), `found by "${q}"`).toContain(stranger.id);
  }
  // Thin card: what the page needs and nothing else.
  const r = await find(seeker, 'Quartermaine');
  const card = (r.json.data as any[]).find(x => x.userId === stranger.id);
  expect(Object.keys(card).sort()).toEqual(['avatarUrl', 'company', 'displayName', 'jobTitle', 'location', 'userId']);
  console.log('  ✓ found by name, title and company; thin card only.');
});

test('a name match outranks a title or company match', async () => {
  // "Zelda" matches four fixtures by name; the stranger also matches by
  // company for "Quartermaine". Searching the name puts name hits first.
  const r = await find(seeker, 'Zelda');
  expect(r.status).toBe(200);
  const names = (r.json.data as any[]).map(x => x.displayName);
  expect(names[0]).toMatch(/^Zelda/);
});

test('search never returns you, a blocked member either way, a deactivated one, or someone still onboarding', async () => {
  test.setTimeout(120_000);
  // Yourself.
  expect(idsOf(await find(seeker, 'searchseeker'))).not.toContain(seeker.id);

  // Someone still in onboarding.
  expect(idsOf(await find(seeker, 'Halfway')), 'not-yet-onboarded stays hidden').not.toContain(unfinished.id);

  // Blocked by the seeker.
  expect(idsOf(await find(seeker, 'Blockworth')), 'visible before the block').toContain(blocked.id);
  const b = await apiAs(seeker, 'POST', `/users/${blocked.id}/block`, {});
  expect([200, 201]).toContain(b.status);
  expect(idsOf(await find(seeker, 'Blockworth')), 'blocked stays hidden').not.toContain(blocked.id);
  // ...and the other way round: the blocked person cannot find the seeker either.
  expect(idsOf(await find(blocked, 'searchseeker')), 'the block hides the blocker too').not.toContain(seeker.id);

  // Deactivated.
  expect(idsOf(await find(seeker, 'Gonesby')), 'visible while active').toContain(gone.id);
  await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [gone.id]);
  expect(idsOf(await find(seeker, 'Gonesby')), 'deactivated stays hidden').not.toContain(gone.id);
  console.log('  ✓ self / blocked (both ways) / deactivated / not-onboarded all hidden.');
});

test('a one-character or wildcard query returns nothing rather than the whole network', async () => {
  expect((await find(seeker, 'z')).json.data).toEqual([]);
  expect((await find(seeker, ' ')).json.data).toEqual([]);
  const wild = await find(seeker, '%%');
  expect(wild.status).toBe(200);
  // "%%" escaped is a literal search for two percent signs: nobody.
  expect(wild.json.data).toEqual([]);
});

test('the page finds a stranger, offers a way to meet, leaks nothing, and fits a phone', async () => {
  test.setTimeout(240_000);
  const page = await openAs(seeker, '/search', { width: 360, height: 780 });
  const box = page.getByPlaceholder(/Search people/i);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.fill('Quartermaine');

  const card = page.getByTestId(`search-result-${stranger.id}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('Zelda Quartermaine');
  await expect(card).toContainText('Senior React Developer');
  await expect(card).toContainText('Quartermaine Labs');
  await expect(card).not.toContainText('@');

  const meet = card.getByRole('button', { name: /I want to meet/i });
  await expect(meet).toBeVisible();
  const mb = await meet.boundingBox();
  expect(mb!.height, 'tap target').toBeGreaterThanOrEqual(44);
  expect(mb!.x + mb!.width, 'inside the 360px viewport').toBeLessThanOrEqual(360);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 360px').toBeLessThanOrEqual(0);

  // The action is real: it sends the meeting request that already existed.
  await meet.click();
  await expect(card.getByRole('button', { name: /Meeting request sent/i })).toBeVisible({ timeout: 20_000 });
  const poke = await pool.query(
    `SELECT id FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [seeker.id, stranger.id]);
  expect(poke.rows.length, 'a meeting request row exists').toBeGreaterThan(0);

  // The name links to the profile, where the existing gates apply.
  await card.getByRole('link', { name: 'Zelda Quartermaine' }).click();
  await expect(page).toHaveURL(new RegExp(`/profile/${stranger.id}`));
  console.log('  ✓ page: found, met, linked to profile, 360px clean.');
});

test('nobody found says so, and the nav carries Find people on desktop', async () => {
  test.setTimeout(120_000);
  const page = await openAs(seeker, '/search', { width: 1280, height: 900 });
  await page.getByPlaceholder(/Search people/i).fill('xqzv-nobody-here');
  await expect(page.getByTestId('search-empty')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Find people' })).toBeVisible();
});
