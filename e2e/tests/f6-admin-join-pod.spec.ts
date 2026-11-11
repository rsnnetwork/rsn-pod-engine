import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER, teardown, idsOf } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// AN ADMIN WHO IS NOT A MEMBER CAN JOIN A POD (F6, 10 Nov 2026). Stefan: "Why can I not join this? because I am
// admin?" The pod page used to treat a platform admin as a member of every pod, so Join never showed, and the
// server refused private pods to everyone. Now the admin sees Join AND the manage controls together, joins any
// open pod as an ordinary member, can then post to its wall, and gets Leave.
//
// It WRITES throwaway data (accounts ending @rsn-e2e.invalid, one private pod) to whatever database the target
// server uses and removes it by id in afterAll. E2E_ENGINE / E2E_HEADED as the other headed specs.
// ─────────────────────────────────────────────────────────────────────────────

const RUN = Date.now().toString(36);
const PHONE = { width: 360, height: 780 };

let browser: Browser;
let director: TestUser, admin: TestUser, plain: TestUser;
let podId = '';
const ctxs: BrowserContext[] = [];

async function member(label: string, role: 'member' | 'super_admin' = 'member'): Promise<TestUser> {
  const u = await createTestUser(`f6-${label}`, role);
  const email = `e2etest-f6-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, u.id]);
  return { ...u, email };
}

async function apiAs(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function pageAt(u: TestUser, p: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 1024 });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${p}`);
  return page;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  director = await member('director');
  admin = await member('admin', 'super_admin');
  plain = await member('plain');
  const created = await apiAs(director, 'POST', '/pods', {
    name: `E2E F6 private ${RUN}`,
    description: 'E2E admin join',
    visibility: 'private',
    podType: 'speed_networking',
    orchestrationMode: 'timed_rounds',
    communicationMode: 'hybrid',
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  podId = created.json.data.id;
  browser = await launchBrowser();
});

test.afterEach(async () => {
  for (const c of ctxs.splice(0)) { try { await c.close(); } catch { /* noop */ } }
});

test.afterAll(async () => {
  const ids = idsOf(director, admin, plain);
  await teardown(
    async () => { await browser?.close(); },
    () => cleanup(pool, { ids, podId: podId || undefined }),
    async () => { await cleanupByPrefix(pool, 'e2etest-f6'); },
  );
});

test('the server: a plain member is refused on a private pod, an admin joins it as an active member', async () => {
  expect((await apiAs(plain, 'POST', `/pods/${podId}/join`)).status).toBe(403);
  const joined = await apiAs(admin, 'POST', `/pods/${podId}/join`);
  expect(joined.status, JSON.stringify(joined.json)).toBe(201);
  expect(joined.json.data).toMatchObject({ role: 'member', status: 'active' });
  // Leave so the screen test starts from "an admin who is not a member".
  expect((await apiAs(admin, 'POST', `/pods/${podId}/leave`)).status).toBe(200);
  const row = await pool.query<{ status: string }>(`SELECT status FROM pod_members WHERE pod_id = $1 AND user_id = $2`, [podId, admin.id]);
  expect(row.rows[0]?.status).toBe('left');
});

test('the screen: an admin who is not a member sees Join and the manage controls together, joins, posts, and gets Leave', async () => {
  test.setTimeout(180_000);
  const page = await pageAt(admin, `/pods/${podId}`, PHONE);

  const join = page.getByRole('button', { name: /Join Pod/ });
  await expect(join).toBeVisible({ timeout: 30_000 });
  await expectReachable(page, join, 'Join Pod at phone width');
  // Shirley pilot S3: the manage controls are entries of the Manage menu (a bottom sheet at phone width).
  await expect(page.getByTestId('manage-open'), 'manage controls stay for an admin who is not a member').toBeVisible();
  await page.getByTestId('manage-open').click();
  await expect(page.getByTestId('pod-edit')).toBeVisible();
  await expect(page.getByTestId('manage-archive')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Leave Pod/ }), 'Leave is for members only').toHaveCount(0);

  // The wall opens to read and moderate, and says posting waits for joining.
  await expect(page.getByTestId('pod-wall')).toContainText('Join the pod to post');

  await join.click();
  await expect(page.getByRole('button', { name: /Leave Pod/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Join Pod/ })).toHaveCount(0);
  await expect(page.getByTestId('manage-open')).toBeVisible();

  const text = `Admin member post ${RUN}`;
  await page.getByPlaceholder('Write something to the pod…').click();
  await page.getByPlaceholder('Write something to the pod…').fill(text);
  await page.getByTestId('pod-wall').getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByTestId('pod-wall')).toContainText(text, { timeout: 30_000 });

  const row = await pool.query<{ role: string; status: string }>(`SELECT role, status FROM pod_members WHERE pod_id = $1 AND user_id = $2`, [podId, admin.id]);
  expect(row.rows[0]).toEqual({ role: 'member', status: 'active' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'no sideways scroll at 360px').toBeLessThanOrEqual(1);
});
