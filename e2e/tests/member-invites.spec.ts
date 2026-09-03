import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// ANY MEMBER CAN INVITE (13 Aug 2026 meeting, Task C2).
//
// Stefan: "Currently only admins can send platform invitations — I want any
// user to be able to invite." Ali's decision: direct and unlimited, the same
// effect an admin invite has; the audit trail is what stays. This proves it
// from a PLAIN MEMBER account, through the API and through the page, and
// asserts outcomes: the invites row, who it records as the sender, and that
// the code actually resolves for a stranger. It also pins what did NOT open:
// a member still cannot invite someone already registered, and still sees
// only their own invites.
//
// The UI path uses the shareable-link option, so no real email is sent.

let browser: Browser;
let member: TestUser;
let admin: TestUser;
let registered: TestUser; // someone already on the platform
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(u ? { Authorization: `Bearer ${u.accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
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

const invitesBy = (u: TestUser) =>
  pool.query(`SELECT id, code, type, inviter_id, invitee_email, max_uses, status FROM invites WHERE inviter_id = $1 ORDER BY created_at`, [u.id]);

test.beforeAll(async () => {
  member = await createTestUser('memberInv', 'member');
  admin = await createTestUser('memberInvAdmin', 'admin');
  registered = await createTestUser('memberInvReg', 'member');
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [member?.id, admin?.id, registered?.id].filter(Boolean);
  await pool.query(`DELETE FROM invites WHERE inviter_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  const swept = await cleanupByPrefix(pool, 'e2etest-memberInv');
  if (swept) console.log(`  swept ${swept} leftover memberInv* account(s)`);
});

test('a plain member can create a platform invite through the API, and the code resolves for a stranger', async () => {
  test.setTimeout(120_000);
  // No email on purpose: a code-only invite, so nothing is sent to anyone.
  const r = await apiAs(member, 'POST', '/invites', { type: 'platform', maxUses: 3 });
  expect(r.status, `member platform invite: ${JSON.stringify(r.json)}`).toBe(201);
  expect(r.json.data.type).toBe('platform');

  const rows = (await invitesBy(member)).rows;
  expect(rows.length).toBe(1);
  expect(rows[0].inviter_id, 'the row records who sent it').toBe(member.id);
  expect(rows[0].status).toBe('pending');

  // A stranger (no auth) can resolve the code — that is what an invite link does.
  const resolve = await apiAs(null, 'GET', `/invites/${rows[0].code}`);
  expect(resolve.status).toBe(200);
  expect(resolve.json.data.type).toBe('platform');
  console.log(`  ✓ member-created platform invite ${rows[0].code} resolves anonymously.`);
});

test('a member cannot platform-invite someone who is already on the platform', async () => {
  const r = await apiAs(member, 'POST', '/invites', { type: 'platform', inviteeEmail: registered.email });
  expect(r.status).toBe(409);
  expect(r.json.error.code).toBe('ALREADY_REGISTERED');
});

test('a member cannot invite themselves', async () => {
  const r = await apiAs(member, 'POST', '/invites', { type: 'platform', inviteeEmail: member.email });
  expect(r.status).toBe(400);
  expect(r.json.error.code).toBe('SELF_INVITE');
});

test('a member still sees only the invites they sent, not an admin\'s', async () => {
  const a = await apiAs(admin, 'POST', '/invites', { type: 'platform', maxUses: 2 });
  expect(a.status).toBe(201);

  const mine = await apiAs(member, 'GET', '/invites?type=platform');
  expect(mine.status).toBe(200);
  const inviters = new Set((mine.json.data as Array<{ inviterId: string }>).map(i => i.inviterId));
  expect([...inviters], 'only the member themselves').toEqual([member.id]);
});

test('the invites page lets a member create a platform link, and it fits a phone', async () => {
  test.setTimeout(180_000);
  const page = await openAs(member, '/invites', { width: 360, height: 780 });

  // The type selector offers Platform Invite to a member, not just admins.
  const typeSelect = page.locator('select').first();
  await expect(typeSelect).toBeVisible({ timeout: 30_000 });
  await typeSelect.selectOption('platform');

  const before = (await invitesBy(member)).rows.length;
  const createLink = page.getByRole('button', { name: /Create & Copy Link/i });
  await expect(createLink).toBeVisible();
  const box = await createLink.boundingBox();
  expect(box!.height, 'tap target').toBeGreaterThanOrEqual(44);
  expect(box!.x + box!.width, 'button inside the 360px viewport').toBeLessThanOrEqual(360);
  await createLink.click();

  // Outcome: a new platform row, sent by the member, and the link shown carries its code.
  let rows: any[] = [];
  for (let i = 0; i < 20; i++) {
    rows = (await invitesBy(member)).rows;
    if (rows.length > before) break;
    await new Promise(res => setTimeout(res, 1000));
  }
  expect(rows.length, 'a new invite row from the page').toBe(before + 1);
  const newest = rows[rows.length - 1];
  expect(newest.type).toBe('platform');
  expect(newest.inviter_id).toBe(member.id);
  await expect(page.locator(`input[value*="${newest.code}"]`)).toBeVisible({ timeout: 15_000 });

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 360px').toBeLessThanOrEqual(0);
  console.log(`  ✓ page-created platform link ${newest.code} by a member, 360px clean.`);
});
