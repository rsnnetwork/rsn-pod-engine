import { test, expect, Page, Browser } from '@playwright/test';
import crypto from 'node:crypto';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';

// A DELETED MEMBER WHO IS APPROVED AGAIN CAN GET BACK IN (23 Sep 2026).
//
// Shradha: an admin deleted her test accounts, she asked to join again, was
// approved, and still could not get in. Deleting only closes an account, the
// approval never looked at it, and sign-in handed the closed account a session
// the next request refused. She saw a spinner, then the sign-in page, no reason.
//
// This walks her exact path on production, headed, at phone width, through
// the real screens: sign up, get deleted, try to sign in (told why), ask again,
// an admin approves from the admin page (told it will reopen the account),
// sign in, and stay in. Plus: a member deleted mid-session is told why, and a
// suspended account is never let in by an approval.
//
// The profile link is deliberately not a LinkedIn /in/ URL, so no approval
// here spends a paid ScrapingDog lookup.

const NOT_LINKEDIN = 'https://example.com/not-a-linkedin-profile';
const CLOSED_TEXT = /This account was closed\. Ask to join again, and you can sign in as soon as you are approved\./;
let admin: TestUser;
const emails: string[] = [];
const userIds: string[] = [];

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function apply(email: string): Promise<string> {
  const jr = await api('POST', '/join-requests', { fullName: 'Closed Account Test', email, linkedinUrl: NOT_LINKEDIN, reason: 'testing re-joining after a delete' });
  expect(jr.status, JSON.stringify(jr.json)).toBe(201);
  return jr.json.data.id;
}

/** A real one-click sign-in link, exactly as the approval email carries. */
async function signInLink(email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [email, crypto.createHash('sha256').update(token).digest('hex')]);
  return token;
}

const accountStatus = async (email: string) =>
  (await pool.query(`SELECT status::text s FROM users WHERE lower(email) = $1`, [email.toLowerCase()])).rows[0]?.s as string | undefined;

const liveSessions = async (userId: string) =>
  Number((await pool.query(`SELECT count(*) n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`, [userId])).rows[0].n);

async function phone(browser: Browser, tokens?: { access: string; refresh: string }): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (tokens) {
    await ctx.addInitScript((t) => {
      localStorage.setItem('rsn_tokens', JSON.stringify(t));
      localStorage.setItem('rsn_access', t.access); localStorage.setItem('rsn_refresh', t.refresh);
    }, tokens);
  }
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  return page;
}

/** Inside the window, not covered, and a real thumb target. */
async function reachable(page: Page, name: RegExp | string) {
  const el = page.getByRole('link', { name }).or(page.getByRole('button', { name })).first();
  await expect(el).toBeVisible();
  const r = await el.evaluate((e) => {
    const b = e.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { inside: b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth, onTop: e === top || e.contains(top), h: Math.round(b.height) };
  });
  expect(r.inside && r.onTop, `${name} is on screen and not covered`).toBe(true);
  expect(r.h, `${name} is a ${r.h}px target`).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'no sideways scroll').toBeLessThanOrEqual(1);
}

test.beforeAll(async () => {
  admin = await createTestUser('closedadmin', 'super_admin');
});

test.afterAll(async () => {
  for (const email of emails) {
    await pool.query(`DELETE FROM magic_links WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
    await pool.query(`DELETE FROM join_requests WHERE lower(email) = $1`, [email.toLowerCase()]).catch(() => {});
  }
  const ids = [admin?.id, ...userIds].filter(Boolean) as string[];
  await pool.query(`DELETE FROM audit_log WHERE entity_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM onboarding_stage_events WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM user_subscriptions WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM user_entitlements WHERE user_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  await cleanupByPrefix(pool, 'e2etest-closed');
  await pool.end().catch(() => {});
});

test("Shradha's path: deleted, told why, asks again, approved from the admin page, signs in and stays in", async ({ browser }) => {
  test.setTimeout(300_000);
  const email = `e2etest-closed-${Date.now()}@example.com`;
  emails.push(email);

  // 1. She joins the ordinary way and signs in.
  const first = await apply(email);
  expect((await api('PATCH', `/join-requests/${first}/review`, { decision: 'approved' }, admin.accessToken)).status).toBe(200);
  const v1 = await api('POST', '/auth/verify', { token: await signInLink(email) });
  expect(v1.status, JSON.stringify(v1.json)).toBe(200);
  const userId = (await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, [email])).rows[0].id as string;
  userIds.push(userId);

  // 2. An admin deletes her ("Delete Forever"), and that is now on record.
  expect((await api('DELETE', `/users/${userId}`, undefined, admin.accessToken)).status).toBe(200);
  expect(await accountStatus(email)).toBe('deactivated');
  const del = await pool.query(`SELECT actor_id FROM audit_log WHERE action = 'user.deleted' AND entity_id = $1`, [userId]);
  expect(del.rows[0]?.actor_id, 'who deleted her is recorded').toBe(admin.id);

  // 3. She tries to sign in. Before: a session, then a silent bounce. Now: why.
  const send = await api('POST', '/auth/magic-link', { email });
  expect(send.status).toBe(403);
  expect(send.json.error.code).toBe('ACCOUNT_CLOSED');
  const page = await phone(browser);
  await page.goto(`${APP}/auth/verify?token=${await signInLink(email)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(CLOSED_TEXT)).toBeVisible({ timeout: 30_000 });
  expect(await liveSessions(userId), 'no session was handed to the closed account').toBe(0);
  await reachable(page, 'Ask to join again');
  await page.screenshot({ path: 'test-results/closed-1-told-why.png' });

  // 4. The login page says it too, when she asks for a link there.
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByRole('button', { name: /Send magic link/ }).click();
  await expect(page.getByText(CLOSED_TEXT)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: 'test-results/closed-2-login-says-why.png' });

  // 5. "Ask to join again" goes where it says.
  await page.goto(`${APP}/auth/verify?token=${await signInLink(email)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'Ask to join again' }).click();
  await expect(page).toHaveURL(/\/request-to-join/);

  // 6. She asks again. The admin page warns that approving reopens the account.
  const second = await apply(email);
  const adm = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await adm.addInitScript((t) => {
    localStorage.setItem('rsn_tokens', JSON.stringify(t));
    localStorage.setItem('rsn_access', t.access); localStorage.setItem('rsn_refresh', t.refresh);
  }, { access: admin.accessToken, refresh: admin.refreshToken });
  const ap = await adm.newPage();
  ap.on('pageerror', () => {});
  await ap.goto(`${APP}/admin/join-requests`, { waitUntil: 'domcontentloaded' });
  const row = ap.locator('div').filter({ hasText: email }).filter({ has: ap.getByRole('button', { name: /Approve/ }) }).last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId('jr-account-note')).toHaveText(/Closed account\. Approving reopens it\./);
  await ap.screenshot({ path: 'test-results/closed-3-admin-warned.png' });

  // 7. The admin approves from the page, as Shradha's admin did.
  await row.getByRole('button', { name: /^\s*Approve\s*$/ }).click();
  await expect.poll(async () =>
    (await pool.query(`SELECT status::text s FROM join_requests WHERE id = $1`, [second])).rows[0].s, { timeout: 30_000 }).toBe('approved');
  await expect.poll(() => accountStatus(email), { timeout: 15_000 }).toBe('active');
  const reopened = await pool.query(`SELECT actor_id, details FROM audit_log WHERE action = 'user.reopened_by_approval' AND entity_id = $1`, [userId]);
  expect(reopened.rows[0]?.actor_id, 'the reopening is recorded against the approving admin').toBe(admin.id);
  expect(reopened.rows[0]?.details).toMatchObject({ joinRequestId: second, via: 'dashboard' });

  // 8. She signs in with her link and STAYS in: the exact step that failed.
  const mp = await phone(browser);
  await mp.goto(`${APP}/auth/verify?token=${await signInLink(email)}`, { waitUntil: 'domcontentloaded' });
  await expect(mp).toHaveURL(/\/(onboarding|$|\?)/, { timeout: 60_000 });
  await mp.waitForTimeout(20_000); // longer than the old ~17s bounce
  expect(mp.url(), 'still inside the app 20s later, not bounced to login').not.toMatch(/\/login|\/welcome/);
  const access = await mp.evaluate(() => JSON.parse(localStorage.getItem('rsn_tokens') || '{}').access as string);
  for (const path of ['/auth/session', '/onboarding/state', '/agents', '/circles']) {
    expect((await api('GET', path, undefined, access)).status, `${path} answers her`).toBe(200);
  }
  expect(await liveSessions(userId)).toBeGreaterThan(0);
  await mp.screenshot({ path: 'test-results/closed-4-back-in.png' });
});

test('deleted mid-session: the next load says why, promptly, instead of a long spinner and a silent bounce', async ({ browser }) => {
  test.setTimeout(180_000);
  const email = `e2etest-closed-mid-${Date.now()}@example.com`;
  emails.push(email);
  const jr = await apply(email);
  expect((await api('PATCH', `/join-requests/${jr}/review`, { decision: 'approved' }, admin.accessToken)).status).toBe(200);
  const v = await api('POST', '/auth/verify', { token: await signInLink(email) });
  expect(v.status).toBe(200);
  const userId = (await pool.query(`SELECT id FROM users WHERE lower(email) = $1`, [email])).rows[0].id as string;
  userIds.push(userId);

  const page = await phone(browser, { access: v.json.data.accessToken, refresh: v.json.data.refreshToken });
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });

  expect((await api('DELETE', `/users/${userId}`, undefined, admin.accessToken)).status).toBe(200);

  const started = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText(CLOSED_TEXT)).toBeVisible({ timeout: 15_000 });
  const took = Date.now() - started;
  console.log(`  told why after ${took}ms`);
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => localStorage.getItem('rsn_tokens')), 'the dead session is cleared, not retried on every load').toBeNull();
  await page.screenshot({ path: 'test-results/closed-5-mid-session.png' });
});

test('a SUSPENDED account is not let in by an approval, and is told so', async () => {
  const member = await createTestUser('closed-susp', 'member');
  userIds.push(member.id);
  emails.push(member.email);
  expect((await api('PUT', `/users/${member.id}/status`, { status: 'suspended' }, admin.accessToken)).status).toBe(200);
  const rec = await pool.query(`SELECT actor_id, details FROM audit_log WHERE action = 'user.status_changed' AND entity_id = $1`, [member.id]);
  expect(rec.rows[0]).toMatchObject({ actor_id: admin.id, details: { status: 'suspended' } });

  const jr = await apply(member.email);
  const list = await api('GET', '/join-requests?status=pending&pageSize=50', undefined, admin.accessToken);
  const listed = (list.json.data as Array<{ id: string; accountStatus?: string }>).find((r) => r.id === jr);
  expect(listed?.accountStatus, 'the admin list carries the account status').toBe('suspended');
  expect((await api('PATCH', `/join-requests/${jr}/review`, { decision: 'approved' }, admin.accessToken)).status).toBe(200);
  expect(await accountStatus(member.email), 'approval does not lift a suspension').toBe('suspended');

  const verify = await api('POST', '/auth/verify', { token: await signInLink(member.email) });
  expect(verify.status).toBe(403);
  expect(verify.json.error.code).toBe('USER_SUSPENDED');
  expect(await liveSessions(member.id)).toBe(0);
});
