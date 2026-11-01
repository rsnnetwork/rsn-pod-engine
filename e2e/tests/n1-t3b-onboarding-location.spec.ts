import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { cleanup, gotoRetry, APP, SERVER } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

// 30 Oct review, T3b (1.2, 2.1–2.3; L2, L3, L4), headed, on throwaway members cleaned up by id:
//   - a member who finished only the earlier onboarding signs in and is taken through the new one (not edit mode),
//     with the welcome word for word;
//   - screen 7 refuses a missing location and a bare country, then takes "Copenhagen, Denmark", and they land on the
//     page they were going to, with no loop;
//   - a new-onboarding member with no location is sent straight to the location field, with no Cancel;
//   - a 1:1 meeting page is never diverted;
//   - an admin sees the member's answers on the inspector and downloads the CSV, which has them.
// Screen 7 and the card are looked at at seven widths; the whole flow at 360 and 1280. Chromium, WebKit, iPhone 14.

const SHOTS = process.env.E2E_SHOTS_DIR || path.resolve(__dirname, '../shots/n1-t3b');
const WIDTHS = [360, 390, 414, 768, 1024, 1280, 1440];
const FLOW_WIDTHS = process.env.E2E_DEVICE ? [0] : [360, 1280];
const WELCOME = "Answer a few quick questions and we'll suggest potential mutuals for you.";
const ANSWERS = {
  lookingToMeet: ['meet_investors'], hopingToFind: ['find_funding'],
  canOffer: ['offer_advice_mentoring'], selfKinds: ['self_founder_owner'],
};

let browser: Browser;
const contexts: BrowserContext[] = [];
const made: string[] = [];
const tag = () => engineLabel().replace(/[^a-z0-9]+/gi, '-');

async function api(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function signedIn(u: TestUser, width: number): Promise<Page> {
  const ctx = await browser.newContext({ ...contextOptions({ width: width || 390, height: 844 }), acceptDownloads: true });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  contexts.push(ctx);
  return ctx.newPage();
}

/** Earlier onboarding finished (status completed, no version), no location: Claus's shape on production. */
async function earlierMember(suffix: string): Promise<TestUser> {
  const u = await createTestUser(suffix, 'member', 'completed');
  made.push(u.id);
  await pool.query(
    `UPDATE users SET onboarding_version = NULL, location = NULL, looking_to_meet = ARRAY['investors']::text[] WHERE id = $1`, [u.id]);
  return u;
}

const pathAndQuery = (page: Page) => { const url = new URL(page.url()); return `${url.pathname}${url.search}`; };

async function noSideScroll(page: Page, label: string) {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits, `${label}: no horizontal scroll`).toBe(true);
}

async function atEveryWidth(page: Page, name: string) {
  if (process.env.E2E_DEVICE) {
    await noSideScroll(page, name);
    await page.screenshot({ path: `${SHOTS}/${tag()}-${name}.png`, fullPage: true });
    return;
  }
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await page.waitForTimeout(250);
    await noSideScroll(page, `${name} at ${width}`);
    await page.screenshot({ path: `${SHOTS}/${tag()}-${name}-${width}.png`, fullPage: true });
  }
}

test.beforeAll(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await cleanup(pool, { ids: made });
});

for (const width of FLOW_WIDTHS) {
  test(`an earlier-onboarding member is taken through the new one, screen 7 asks where they are based, and they land where they were going (${width || 'device'})`, async () => {
    test.setTimeout(240_000);
    const me = await earlierMember(`t3bflow${width}`);
    const page = await signedIn(me, width);

    await gotoRetry(page, `${APP}/profile`);
    await expect.poll(() => pathAndQuery(page), { timeout: 30_000 }).toMatch(/^\/onboarding\?(.*&)?redirect=%2Fprofile/);
    await expect(page.getByRole('heading', { name: "Welcome to REASON. We're glad you're here." })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(WELCOME, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/${tag()}-${width || 'device'}-welcome.png`, fullPage: true });

    // The four answers as a draft, as the questions leave them, then screen 7 itself.
    expect((await api(me, 'PUT', '/onboarding/v2/answers', { ...ANSWERS, step: 'profile' })).status).toBe(200);
    await gotoRetry(page, `${APP}/onboarding?step=profile&redirect=%2Fprofile`);
    await expect(page.getByRole('heading', { name: "Here's how others will see you" })).toBeVisible({ timeout: 30_000 });
    const where = page.getByLabel('Where are you based?', { exact: true });
    await expect(where).toHaveValue('');
    await expect(where).toHaveAttribute('placeholder', 'City, country');

    // Nothing: refused under the field, with the cursor there.
    await page.getByRole('button', { name: 'Show me my matches' }).click();
    await expect(page.getByText('Please add your city and country.', { exact: true })).toBeVisible();
    await expect(where).toBeFocused();
    // Only a country: the hint as they type, then refused.
    await where.fill('Nepal');
    await expect(page.getByText('Add your city too', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Show me my matches' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Add your city too' })).toBeVisible();
    if (width === 360 || width === 0) await atEveryWidth(page, 'screen7-refused');
    expect((await pool.query(`SELECT onboarding_version FROM users WHERE id = $1`, [me.id])).rows[0].onboarding_version).toBeNull();

    await where.fill('Copenhagen, Denmark');
    await page.getByRole('button', { name: 'Show me my matches' }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe('/profile');
    await page.waitForTimeout(2500);
    expect(new URL(page.url()).pathname, 'no loop back into onboarding').toBe('/profile');
    const row = (await pool.query(`SELECT onboarding_version, location, onboarding_status FROM users WHERE id = $1`, [me.id])).rows[0];
    expect(row).toEqual({ onboarding_version: 2, location: 'Copenhagen, Denmark', onboarding_status: 'completed' });
    await page.screenshot({ path: `${SHOTS}/${tag()}-${width || 'device'}-landed.png`, fullPage: true });
  });
}

for (const stored of [null, 'United Kingdom']) {
test(`a new-onboarding member with ${stored ? 'only a country' : 'no location'} goes straight to the location field, with no Cancel, then on`, async () => {
  test.setTimeout(180_000);
  const me = await createTestUser(stored ? 't3bcountry' : 't3bloc', 'member', 'completed');
  made.push(me.id);
  expect((await api(me, 'POST', '/onboarding/v2/confirm', ANSWERS)).status).toBe(200);
  await pool.query(`UPDATE users SET location = $2, tour_seen_at = NOW() WHERE id = $1`, [me.id, stored]);
  const page = await signedIn(me, 390);

  await gotoRetry(page, `${APP}/connections`);
  await expect.poll(() => pathAndQuery(page), { timeout: 30_000 }).toBe('/onboarding?edit=profile&redirect=%2Fconnections');
  const where = page.getByLabel('Where are you based?', { exact: true });
  await expect(where).toBeFocused({ timeout: 30_000 });
  await expect(where).toHaveValue(stored ?? '');
  await expect(page.getByText('Add your city too', { exact: true })).toHaveCount(stored ? 1 : 0);
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/${tag()}-location-only-${stored ? 'country' : 'none'}.png`, fullPage: true });

  await where.fill('Manchester, UK');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe('/connections');
  await page.waitForTimeout(2000);
  expect(new URL(page.url()).pathname).toBe('/connections');
  expect((await pool.query(`SELECT location FROM users WHERE id = $1`, [me.id])).rows[0].location).toBe('Manchester, UK');
});
}

// Review fix 1: a member the gate holds can always sign out, from any onboarding screen, at 360px too.
test('every onboarding screen has a Sign out that signs the member out and opens the sign-in page', async () => {
  test.setTimeout(120_000);
  const me = await earlierMember('t3bsignout');
  const page = await signedIn(me, 360);
  await gotoRetry(page, `${APP}/`);
  await expect(page.getByRole('heading', { name: "Welcome to REASON. We're glad you're here." })).toBeVisible({ timeout: 30_000 });
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await expectReachable(page, signOut, 'Sign out at 360');
  expect((await signOut.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `${SHOTS}/${tag()}-sign-out-360.png` });
  await signOut.click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe('/login');
  expect(await page.evaluate(() => localStorage.getItem('rsn_access'))).toBeNull();
});

test('the profile form requires where they are based, and the old public profile never prints a missing-field label', async () => {
  test.setTimeout(120_000);
  const me = await createTestUser('t3bform', 'member', 'completed');
  const other = await createTestUser('t3bplain', 'member', 'completed');
  made.push(me.id, other.id);
  await pool.query(`UPDATE users SET location = NULL, industry = NULL, languages = '{}' WHERE id = $1`, [other.id]);
  const page = await signedIn(me, 390);

  await gotoRetry(page, `${APP}/profile/edit`);
  const where = page.locator('#location');
  await expect(where).toHaveValue('Copenhagen, Denmark', { timeout: 30_000 });
  const puts: string[] = [];
  page.on('request', r => { if (r.method() === 'PUT' && r.url().endsWith('/api/users/me')) puts.push(r.url()); });
  for (const [typed, said] of [['', 'Please add your city and country.'], ['USA', 'Add your city too']]) {
    await where.fill(typed);
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.locator('#location-error')).toHaveText(said);
    await expect(where).toBeFocused();
  }
  expect(puts).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/${tag()}-profile-form-refused.png`, fullPage: true });

  await gotoRetry(page, `${APP}/profile/${other.id}`);
  await expect(page.getByRole('heading', { name: other.displayName })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/No location|No industry|Not set/)).toHaveCount(0);
});

test('a 1:1 meeting page is never diverted, even for a member who is due', async () => {
  test.setTimeout(120_000);
  const me = await earlierMember('t3bmeet');
  const page = await signedIn(me, 390);
  await gotoRetry(page, `${APP}/meet/x`);
  await page.waitForTimeout(4000);
  expect(new URL(page.url()).pathname).toBe('/meet/x');
});

test('an admin sees the member\'s onboarding answers and downloads the CSV, which has them', async () => {
  test.setTimeout(180_000);
  const member = await createTestUser('t3bcard', 'member', 'completed');
  made.push(member.id);
  expect((await api(member, 'POST', '/onboarding/v2/confirm', {
    ...ANSWERS, lookingToMeet: ['meet_investors', 'meet_other'], meetOther: 'bakers in Vienna', findSpecific: 'a seed lead',
  })).status).toBe(200);
  const admin = await createTestUser('t3badmin', 'admin', 'completed');
  made.push(admin.id);
  const page = await signedIn(admin, 1280);

  await gotoRetry(page, `${APP}/admin/users/${member.id}`);
  const card = page.getByTestId('onboarding-answers-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('New onboarding', { exact: true })).toBeVisible();
  await expect(card.getByText('Investors', { exact: true })).toBeVisible();
  await expect(card.getByText('“bakers in Vienna”', { exact: true })).toBeVisible();
  await expect(card.getByText('“a seed lead”', { exact: true })).toBeVisible();
  await expect(card.getByText('Copenhagen, Denmark', { exact: true })).toBeVisible();
  await atEveryWidth(page, 'answers-card');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.getByRole('button', { name: 'Download onboarding answers (CSV)' }).click(),
  ]);
  const csv = fs.readFileSync((await download.path())!, 'utf8');
  expect(csv.split('\n')[0]).toMatch(/^Name,Email,Onboarding,Status/);
  expect(csv).toContain(member.email);
  expect(csv).toContain('bakers in Vienna');
  const logged = (await pool.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1 AND action = 'admin.onboarding_csv_download'`, [admin.id])).rows[0].n;
  expect(logged).toBe(1);
  await pool.query(`DELETE FROM audit_log WHERE actor_id = $1 AND action = 'admin.onboarding_csv_download'`, [admin.id]);
});
