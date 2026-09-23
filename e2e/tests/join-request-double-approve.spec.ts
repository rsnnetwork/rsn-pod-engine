import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';

// ONE APPROVAL, HOWEVER MANY CLICKS (23 Sep 2026).
//
// Ali double-clicked Approve for alihammza143. Both clicks ran the whole
// approval 300ms apart: two welcome emails, and the second one's sign-in link
// quietly killed the first's, so the first email said "already used". The
// approval now claims only a pending request, and the button locks.
//
// The profile link is deliberately not a LinkedIn /in/ URL, so nothing here
// spends a paid ScrapingDog lookup.

let admin: TestUser;
const emails: string[] = [];

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function apply(tag: string): Promise<{ id: string; email: string }> {
  const email = `e2etest-dblapprove-${tag}-${Date.now()}@example.com`;
  emails.push(email);
  const jr = await api('POST', '/join-requests', { fullName: 'Double Approve Test', email, linkedinUrl: 'https://example.com/not-linkedin', reason: 'double click test' });
  expect(jr.status, JSON.stringify(jr.json)).toBe(201);
  return { id: jr.json.data.id, email };
}

/** Every approval sends a welcome email carrying a fresh sign-in link; count them. */
const approvalLinks = async (email: string) =>
  (await pool.query(`SELECT used_at FROM magic_links WHERE lower(email) = $1 AND purpose = 'login'`, [email])).rows as { used_at: Date | null }[];

test.beforeAll(async () => {
  admin = await createTestUser('dblapprove-admin', 'super_admin');
});

test.afterAll(async () => {
  for (const email of emails) {
    await pool.query(`DELETE FROM magic_links WHERE lower(email) = $1`, [email]).catch(() => {});
    await pool.query(`DELETE FROM join_requests WHERE lower(email) = $1`, [email]).catch(() => {});
  }
  await cleanup(pool, { ids: [admin.id] });
  await cleanupByPrefix(pool, 'e2etest-dblapprove');
  await pool.end().catch(() => {});
});

test('two approvals at the same instant: one welcome, and its link still works', async () => {
  const { id, email } = await apply('race');
  const [a, b] = await Promise.all([
    api('PATCH', `/join-requests/${id}/review`, { decision: 'approved' }, admin.accessToken),
    api('PATCH', `/join-requests/${id}/review`, { decision: 'approved' }, admin.accessToken),
  ]);
  expect([a.status, b.status]).toEqual([200, 200]);
  await new Promise((r) => setTimeout(r, 2500));
  const links = await approvalLinks(email);
  expect(links.length, 'exactly one welcome link was made').toBe(1);
  expect(links[0].used_at, 'and nothing cancelled it').toBeNull();
});

test('approving a request another admin already declined is refused, in words', async () => {
  const { id, email } = await apply('conflict');
  expect((await api('PATCH', `/join-requests/${id}/review`, { decision: 'declined' }, admin.accessToken)).status).toBe(200);
  const late = await api('PATCH', `/join-requests/${id}/review`, { decision: 'approved' }, admin.accessToken);
  expect(late.status).toBe(409);
  expect(late.json.error.message).toBe('This request was already declined.');
  expect((await pool.query(`SELECT status::text s FROM join_requests WHERE id = $1`, [id])).rows[0].s).toBe('declined');
  expect(await approvalLinks(email), 'no welcome link for a declined request').toHaveLength(0);
});

test('double-clicking Approve on the admin page is one approval', async ({ browser }) => {
  const { id, email } = await apply('ui');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t) => {
    localStorage.setItem('rsn_tokens', JSON.stringify(t));
    localStorage.setItem('rsn_access', t.access); localStorage.setItem('rsn_refresh', t.refresh);
  }, { access: admin.accessToken, refresh: admin.refreshToken });
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await page.goto(`${APP}/admin/join-requests`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('div').filter({ hasText: email }).filter({ has: page.getByRole('button', { name: /Approve/ }) }).last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: /^\s*Approve\s*$/ }).dblclick();
  await expect.poll(async () => (await pool.query(`SELECT status::text s FROM join_requests WHERE id = $1`, [id])).rows[0].s, { timeout: 30_000 }).toBe('approved');
  await page.waitForTimeout(2500);
  const links = await approvalLinks(email);
  expect(links.length, 'one welcome link, not two').toBe(1);
  expect(links[0].used_at).toBeNull();
  await page.screenshot({ path: 'test-results/dblapprove-ui.png' });
  await ctx.close();
});
