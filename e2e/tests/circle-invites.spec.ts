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
let bellee: TestUser;     // already on REASON, invited by address from the sheet, accepts from the bell (T14)
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
  bellee = await createTestUser('circleinvbellee');

  const c = await apiAs(admin, 'POST', '/circles', { name: `E2E Circle ${Date.now()}`, description: 'throwaway' });
  expect(c.status, `create circle: ${JSON.stringify(c.json)}`).toBe(201);
  circleId = c.json.data.id;
  const j = await apiAs(member, 'POST', `/circles/${circleId}/join`);
  expect(j.status).toBe(200);

  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [admin?.id, member?.id, outsider?.id, joiner?.id, bellee?.id].filter(Boolean);
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

// T14 (1 Nov 2026): the circle page's Invite opens the shared invite sheet (connections, Invite by email, Share a link),
// not the old /invites form, whose search found only people met at an event. That form's deep link still works.
test('the circle page\'s Invite opens the invite sheet, whose Share a link makes a circle link at 360px', async () => {
  test.setTimeout(180_000);
  const circlePage = await openAs(member, `/circles/${circleId}`, { width: 360, height: 780 });
  // Scoped by test id: the phone bottom bar also carries an "Invite" nav link.
  const inviteBtn = circlePage.getByTestId('circle-invite');
  await expect(inviteBtn).toBeVisible({ timeout: 30_000 });
  const ib = await inviteBtn.boundingBox();
  expect(ib!.height, 'Invite tap target').toBeGreaterThanOrEqual(44);
  await inviteBtn.click();
  const sheet = circlePage.getByRole('dialog', { name: 'Invite people' });
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  expect(new URL(circlePage.url()).pathname, 'the sheet opens on the circle page').toBe(`/circles/${circleId}`);
  await expect(sheet.getByRole('group', { name: 'Who to list' }), 'a circle has no pod list').toHaveCount(0);

  const countLinks = async () => (await pool.query(
    `SELECT COUNT(*)::int n FROM invites WHERE inviter_id = $1 AND type = 'circle' AND circle_id = $2`, [member.id, circleId])).rows[0].n as number;
  const before = await countLinks();
  await sheet.getByRole('button', { name: 'Share a link' }).click();
  await expect(sheet.getByText(/Anyone with this link can join the circle, up to 500 people, for 7 days\./)).toBeVisible();
  const make = sheet.getByRole('button', { name: 'Make a link' });
  const box = await make.boundingBox();
  expect(box!.height, 'tap target').toBeGreaterThanOrEqual(44);
  await make.click();
  await expect(sheet.getByLabel('Invite link')).toHaveValue(/\/invite\/[A-Za-z0-9]+$/, { timeout: 20_000 });
  // The link the sheet shows is a circle invite of this member's for this circle, with no address, and it is new.
  const code = (await sheet.getByLabel('Invite link').inputValue()).split('/invite/')[1];
  const row = await pool.query(
    `SELECT type, circle_id, inviter_id, invitee_email, max_uses FROM invites WHERE code = $1`, [code]);
  expect(row.rows, 'the link\'s invite row exists').toHaveLength(1);
  expect(row.rows[0]).toMatchObject({ type: 'circle', circle_id: circleId, inviter_id: member.id, invitee_email: null, max_uses: 500 });
  expect(await countLinks(), 'exactly one new circle invite row from the sheet').toBe(before + 1);
  const overflow = await circlePage.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 360px').toBeLessThanOrEqual(0);
  console.log('  ✓ circle page → invite sheet → circle link made, 360px clean.');
});

test('the old /invites?type=circle deep link still preselects the circle (production\'s form)', async () => {
  const page = await openAs(member, `/invites?type=circle&circleId=${circleId}`, { width: 390, height: 844 });
  await expect(page.locator('select').first()).toHaveValue('circle', { timeout: 20_000 });
});

test('someone already on REASON, invited by address from the sheet, is rung and accepts from the bell onto the circle', async () => {
  test.setTimeout(180_000);
  const circlePage = await openAs(member, `/circles/${circleId}`, { width: 1280, height: 900 });
  const belleePage = await openAs(bellee, '/circles', { width: 1280, height: 900 });
  await circlePage.getByTestId('circle-invite').click();
  const sheet = circlePage.getByRole('dialog', { name: 'Invite people' });
  await sheet.getByRole('button', { name: 'Invite by email' }).click();
  await sheet.getByLabel('Their email address').fill(bellee.email);
  await sheet.getByRole('button', { name: 'Send invite', exact: true }).click();
  await expect(circlePage.getByText(`Invitation sent to ${bellee.email}.`)).toBeVisible({ timeout: 20_000 });

  // The bell rings without a reload (migration 118 allowed the circle_invite type; T1), and Accept is in the row (T14).
  const bell = belleePage.getByRole('button', { name: 'Notifications' });
  await expect(bell.locator('span').filter({ hasText: /^\d+$/ })).toBeVisible({ timeout: 30_000 });
  await bell.click();
  const row = belleePage.getByTestId('notification-row').filter({ hasText: 'invited you to' }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Accept' }).click();
  await belleePage.waitForURL(new RegExp(`/circles/${circleId}$`), { timeout: 30_000 });
  expect(await membersOf()).toContain(bellee.id);
  console.log('  ✓ existing member invited by address: bell rang, Accept in the bell, landed on the circle.');
});

test('an outsider sees no Invite on the circle page', async () => {
  const page = await openAs(outsider, `/circles/${circleId}`, { width: 390, height: 844 });
  // T14: the button reads Join (an open circle).
  await expect(page.getByTestId(`circle-join-${circleId}`)).toHaveText('Join', { timeout: 30_000 });
  await expect(page.getByTestId('circle-invite')).toHaveCount(0);
});
