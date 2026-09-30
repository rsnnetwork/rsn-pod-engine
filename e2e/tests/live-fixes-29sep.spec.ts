// e2e/tests/live-fixes-29sep.spec.ts
import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { launchBrowser } from '../helpers/engine';

const PHONE = { width: 390, height: 844 };
let browser: Browser;
const ctxs: BrowserContext[] = [];
const made: string[] = [];

async function api(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: PHONE });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

test.beforeAll(async () => { browser = await launchBrowser(); });
test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
  await browser?.close();
  if (made.length) await cleanup(pool, { ids: made });
});

test('a declined request is final for the sender; the decliner can still ask', async () => {
  test.setTimeout(240_000);
  const a = await createTestUser('lf-decline-a'); made.push(a.id);
  const b = await createTestUser('lf-decline-b'); made.push(b.id);

  const first = await api(a, 'POST', `/matches/platform/${b.id}/interest`);
  expect(first.status).toBe(201);
  const declined = await api(b, 'POST', `/pokes/${first.body.data.id}/decline`);
  expect(declined.status).toBe(200);

  const bells = async () => (await pool.query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'poke'`, [b.id])).rows[0].n as number;
  const before = await bells();
  expect((await api(a, 'POST', `/matches/platform/${b.id}/interest`)).status).toBe(403);
  expect((await api(a, 'POST', `/pokes`, { recipientId: b.id })).status).toBe(403);
  expect(await bells()).toBe(before);

  const page = await openAs(a, `/profile/${b.id}`);
  const declinedControl = page.getByTestId('meet-state');
  await expect(declinedControl).toHaveText(/Request declined/, { timeout: 30_000 });
  await expect(declinedControl).toBeDisabled();
  // On the phone the disabled control must sit fully on screen, at a proper tap size.
  await declinedControl.scrollIntoViewIfNeeded();
  const box = await declinedControl.boundingBox();
  expect(box, 'the declined control has a box on screen').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // The person who said no sees the ordinary, enabled button, not the disabled one.
  const theirPage = await openAs(b, `/profile/${a.id}`);
  const askBack = theirPage.getByTestId('meet-state');
  await expect(askBack).toHaveText(/I want to meet/, { timeout: 30_000 });
  await expect(askBack).toBeEnabled();

  expect((await api(b, 'POST', `/matches/platform/${a.id}/interest`)).status).toBe(201);
});

test('a hidden member leaves search and suggestions, and comes back', async () => {
  test.setTimeout(240_000);
  const run = Date.now().toString(36);
  const viewer = await createTestUser('lf-vis-viewer'); made.push(viewer.id);
  const hidden = await createTestUser('lf-vis-hidden'); made.push(hidden.id);
  const name = `Zqv${run} Hidden`;
  // Three made-up words, in no job category: the viewer wants them and the hidden
  // member offers them, so the matcher suggests that member and nobody real.
  const words = `zq${run} wx${run} vk${run}`;
  await pool.query(`UPDATE users SET display_name = $1, expertise_text = $2 WHERE id = $3`, [name, words, hidden.id]);
  await pool.query(`UPDATE users SET who_i_want_to_meet = $1 WHERE id = $2`, [words, viewer.id]);
  const found = async () => ((await api(viewer, 'GET', `/users/find?q=Zqv${run}`)).body?.data ?? []).map((r: any) => r.userId);
  const suggested = async () => ((await api(viewer, 'GET', '/matches/platform')).body?.data?.matches ?? []).map((m: any) => m.userId);

  // Visible first, so "absent" below means something: both lists can show this member.
  expect(await found()).toContain(hidden.id);
  expect(await suggested()).toContain(hidden.id);

  // The Settings switch saves through PUT /users/me { profileVisible }.
  expect((await api(hidden, 'PUT', '/users/me', { profileVisible: false })).status).toBe(200);
  expect(await found()).not.toContain(hidden.id);
  expect(await suggested()).not.toContain(hidden.id);

  // Still reachable by link for someone who has it.
  const profile = await openAs(viewer, `/profile/${hidden.id}`);
  await expect(profile.getByText(name)).toBeVisible({ timeout: 30_000 });

  // Settings says what the switch now does, and the switch itself (not its label)
  // is fully on a phone screen with a real tap target.
  const settings = await openAs(hidden, '/settings');
  const label = settings.getByText('Show me in search and suggestions');
  await expect(label).toBeVisible({ timeout: 30_000 });
  await expect(settings.getByText('People you already know can still see your profile and message you.')).toBeVisible();
  const toggle = label.locator('xpath=ancestor::div[contains(@class, "justify-between")][1]').getByRole('button');
  await toggle.scrollIntoViewIfNeeded();
  const box = await toggle.boundingBox();
  expect(box, 'the profile-visibility switch has a box on screen').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);
  // The visible switch is 44 x 24 and a ::after layer grows its touch area to 44 high.
  // boundingBox() cannot see that layer, so read its size too and take the larger.
  const tap = await toggle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const after = getComputedStyle(el, '::after');
    return { w: Math.max(r.width, parseFloat(after.width) || 0), h: Math.max(r.height, parseFloat(after.height) || 0) };
  });
  expect(tap.w, 'the switch keeps its full width on a phone').toBeGreaterThanOrEqual(44);
  expect(tap.h, 'the touch area is at least 44px high').toBeGreaterThanOrEqual(44);
  // Nothing (bottom bar, toast) covers it: a trial click checks that without pressing it.
  await toggle.click({ trial: true });

  expect((await api(hidden, 'PUT', '/users/me', { profileVisible: true })).status).toBe(200);
  expect(await found()).toContain(hidden.id);
  expect(await suggested()).toContain(hidden.id);
});
