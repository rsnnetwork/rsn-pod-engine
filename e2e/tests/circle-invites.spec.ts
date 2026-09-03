import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// CIRCLE-LEVEL INVITES (13 Aug 2026 meeting, Task C3).
//
// Stefan: "Circle-level invites also needed, not just pod-level." A circle
// invite mirrors the pod path: a circle member creates one (code or email),
// a stranger resolves it and sees the circle's name, and accepting it joins
// the circle. A non-member cannot invite to a circle they are not in.
//
// Outcomes only: invites rows, circle_members rows, member_count, and what
// the page shows at phone width. Uses a throwaway circle created by an admin
// fixture and deleted afterwards.

let browser: Browser;
let admin: TestUser;
let member: TestUser;     // in the circle; may invite
let outsider: TestUser;   // not in the circle; may not invite
let joiner: TestUser;     // accepts the invite
let circleId: string;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(u ? { Authorization: `Bearer ${u.accessToken}` } : {}) },
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

const membersOf = () =>
  pool.query(`SELECT user_id FROM circle_members WHERE circle_id = $1`, [circleId]).then(r => r.rows.map(x => x.user_id));

test.beforeAll(async () => {
  admin = await createTestUser('circleinvadmin', 'admin');
  member = await createTestUser('circleinvmember');
  outsider = await createTestUser('circleinvoutsider');
  joiner = await createTestUser('circleinvjoiner');

  const c = await apiAs(admin, 'POST', '/circles', { name: `E2E Circle ${Date.now()}`, description: 'throwaway' });
  expect(c.status, `create circle: ${JSON.stringify(c.json)}`).toBe(201);
  circleId = c.json.data.id;
  const j = await apiAs(member, 'POST', `/circles/${circleId}/join`);
  expect(j.status).toBe(200);

  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [admin?.id, member?.id, outsider?.id, joiner?.id].filter(Boolean);
  await pool.query(`DELETE FROM invites WHERE circle_id = $1 OR inviter_id = ANY($2)`, [circleId, ids]).catch(() => {});
  if (circleId) {
    await pool.query(`DELETE FROM circle_members WHERE circle_id = $1`, [circleId]).catch(() => {});
    await pool.query(`DELETE FROM circle_posts WHERE circle_id = $1`, [circleId]).catch(() => {});
    await pool.query(`DELETE FROM circle_pods WHERE circle_id = $1`, [circleId]).catch(() => {});
    await pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]).catch(() => {});
  }
  await cleanup(pool, { ids });
  const swept = await cleanupByPrefix(pool, 'e2etest-circleinv');
  if (swept) console.log(`  swept ${swept} leftover circleinv* account(s)`);
});

test('a circle member creates a circle invite; a stranger resolves it and sees the circle', async () => {
  test.setTimeout(120_000);
  const r = await apiAs(member, 'POST', '/invites', { type: 'circle', circleId, maxUses: 5 });
  expect(r.status, `member circle invite: ${JSON.stringify(r.json)}`).toBe(201);
  expect(r.json.data.type).toBe('circle');
  expect(r.json.data.circleId).toBe(circleId);

  const row = await pool.query(`SELECT code, inviter_id, circle_id FROM invites WHERE id = $1`, [r.json.data.id]);
  expect(row.rows[0].inviter_id).toBe(member.id);
  expect(row.rows[0].circle_id).toBe(circleId);

  const resolve = await apiAs(null, 'GET', `/invites/${row.rows[0].code}`);
  expect(resolve.status).toBe(200);
  expect(resolve.json.data.type).toBe('circle');
  expect(resolve.json.data.circleName, 'the stranger sees which circle').toMatch(/^E2E Circle/);
  console.log(`  ✓ circle invite ${row.rows[0].code} by a member; resolves with the circle name.`);
});

test('someone who is not in the circle cannot invite to it, and a circle invite needs a circle', async () => {
  const out = await apiAs(outsider, 'POST', '/invites', { type: 'circle', circleId, maxUses: 5 });
  expect(out.status).toBe(403);
  const none = await apiAs(member, 'POST', '/invites', { type: 'circle', maxUses: 5 });
  expect(none.status).toBe(400);
});

test('accepting a circle invite joins the circle, lands on it, and is idempotent', async () => {
  test.setTimeout(120_000);
  const created = await apiAs(member, 'POST', '/invites', { type: 'circle', circleId, maxUses: 5 });
  expect(created.status).toBe(201);
  const code = created.json.data.code;

  expect(await membersOf(), 'joiner not in yet').not.toContain(joiner.id);
  const before = await pool.query(`SELECT member_count FROM circles WHERE id = $1`, [circleId]);

  const acc = await apiAs(joiner, 'POST', `/invites/${code}/accept`);
  expect(acc.status, `accept: ${JSON.stringify(acc.json)}`).toBe(200);
  expect(acc.json.data.redirectTo, 'lands on the circle').toBe(`/circles/${circleId}`);

  expect(await membersOf(), 'joiner is in').toContain(joiner.id);
  const after = await pool.query(`SELECT member_count FROM circles WHERE id = $1`, [circleId]);
  expect(after.rows[0].member_count).toBe(before.rows[0].member_count + 1);

  // Accepting again is harmless: still one membership row, count unchanged.
  const again = await apiAs(joiner, 'POST', `/invites/${code}/accept`);
  expect([200, 400]).toContain(again.status);
  const rows = await pool.query(`SELECT COUNT(*)::int n FROM circle_members WHERE circle_id = $1 AND user_id = $2`, [circleId, joiner.id]);
  expect(rows.rows[0].n).toBe(1);
  console.log('  ✓ accept joined the circle once, count +1, redirect to the circle.');
});

test('a circle member cannot email-invite someone already in the circle', async () => {
  const r = await apiAs(member, 'POST', '/invites', { type: 'circle', circleId, inviteeEmail: joiner.email });
  expect(r.status).toBe(409);
  expect(r.json.error.code).toBe('CIRCLE_MEMBER_EXISTS');
});

test('the circle page offers Invite to a member, and the invites page creates a circle link at 360px', async () => {
  test.setTimeout(180_000);
  const circlePage = await openAs(member, `/circles/${circleId}`, { width: 360, height: 780 });
  // Scoped by test id: the phone bottom bar also carries an "Invite" nav link.
  const inviteBtn = circlePage.getByTestId('circle-invite');
  await expect(inviteBtn).toBeVisible({ timeout: 30_000 });
  const ib = await inviteBtn.boundingBox();
  expect(ib!.height, 'Invite tap target').toBeGreaterThanOrEqual(44);
  await inviteBtn.click();
  await expect(circlePage).toHaveURL(/\/invites\?type=circle&circleId=/);

  // Preselected from the URL: the type is Circle and the circle is chosen.
  await expect(circlePage.locator('select').first()).toHaveValue('circle', { timeout: 20_000 });
  const before = (await pool.query(`SELECT COUNT(*)::int n FROM invites WHERE inviter_id = $1 AND type = 'circle'`, [member.id])).rows[0].n;
  const createLink = circlePage.getByRole('button', { name: /Create & Copy Link/i });
  await expect(createLink).toBeEnabled();
  const box = await createLink.boundingBox();
  expect(box!.height, 'tap target').toBeGreaterThanOrEqual(44);
  await createLink.click();

  let n = before;
  for (let i = 0; i < 20 && n === before; i++) {
    await new Promise(res => setTimeout(res, 1000));
    n = (await pool.query(`SELECT COUNT(*)::int n FROM invites WHERE inviter_id = $1 AND type = 'circle'`, [member.id])).rows[0].n;
  }
  expect(n, 'a new circle invite row from the page').toBe(before + 1);
  const overflow = await circlePage.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 360px').toBeLessThanOrEqual(0);
  console.log('  ✓ circle page → invites page preselected → circle link created, 360px clean.');
});

test('an outsider sees no Invite on the circle page', async () => {
  const page = await openAs(outsider, `/circles/${circleId}`, { width: 390, height: 844 });
  await expect(page.getByRole('button', { name: /Join circle/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('circle-invite')).toHaveCount(0);
});
