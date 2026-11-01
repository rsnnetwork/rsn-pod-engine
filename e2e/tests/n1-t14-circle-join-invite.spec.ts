import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { APP, SERVER, cleanup, gotoRetry, idsOf, teardown } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';
import { acceptConfirmDialogs } from '../helpers/confirm-dialog';

// CIRCLES: INVITES THAT WORK, OPEN OR CLOSED, AND A NEW POD FROM THE CIRCLE (30 Oct review 7.4 to 7.6; T14, 1 Nov 2026)
//
// "Circle invites don't work. Users can't invite others to a Circle." "Who can join a Circle: the owner should choose if
// a Circle is open or closed (same as Parts)." "Create a new Part from the Circle screen." Headed, three browsers that
// are never reloaded:
//   1. The owner (a throwaway admin who made the circle, and so its owner) invites a connection from the shared invite
//      sheet; the invitee's bell rings, they accept from the bell and land on the circle; the owner's member list shows
//      them without a reload.
//   2. The owner sets the circle Closed. The requester sees the locked state and presses Ask to join; the owner's
//      Requests panel shows the ask live. The owner approves, and the requester's page unlocks without a reload.
//   3. The owner makes a new pod from the circle: it appears under the circle's pods and the owner stays on the circle.
// Throwaway accounts, circle and pod only, deleted by id at the end.

const RUN = `zq${Date.now().toString(36)}`;
let browser: Browser;
let owner: TestUser | undefined, invitee: TestUser | undefined, requester: TestUser | undefined;
let circleId = '';
const contexts: BrowserContext[] = [];

const SECRET = process.env.E2E_JWT_SECRET || process.env.JWT_SECRET;

/**
 * A throwaway account on the reserved test domain, with a name only this run uses. Its tokens are signed again for the
 * new address: accepting an invite checks the signed-in address against the invite's.
 */
async function throwaway(label: string, role: 'member' | 'admin' = 'member'): Promise<TestUser> {
  const u = await createTestUser(`t14${label}`, role);
  const name = `${RUN} ${label}`;
  const email = `${u.id}@rsn-e2e.invalid`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3 WHERE id = $1`, [u.id, email, name]);
  const sessionId = uuid();
  return {
    ...u, email, displayName: name,
    accessToken: jwt.sign({ sub: u.id, email, role, displayName: name, sessionId }, SECRET!, { expiresIn: '1h' }),
    refreshToken: jwt.sign({ sub: u.id, sessionId, type: 'refresh' }, SECRET!, { expiresIn: '1d' }),
  };
}

async function signedIn(user: TestUser): Promise<Page> {
  const ctx = await browser.newContext(contextOptions({ width: 1280, height: 900 }));
  contexts.push(ctx);
  await ctx.addInitScript((t) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await ctx.newPage();
  await acceptConfirmDialogs(page);
  return page;
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  owner = await throwaway('Owner', 'admin');
  invitee = await throwaway('Invitee');
  requester = await throwaway('Requester');
  // The owner makes the circle as production's admin does (POST /circles), so the server makes them its owner.
  const res = await fetch(`${SERVER}/api/circles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.accessToken}` },
    body: JSON.stringify({ name: `${RUN} Founders circle`, description: 'People building companies.' }),
  });
  expect(res.status).toBe(201);
  circleId = (await res.json()).data.id;
  // The invitee is one of the owner's connections (a conversation), so the sheet lists them.
  const [a, b] = owner.id < invitee.id ? [owner.id, invitee.id] : [invitee.id, owner.id];
  await pool.query(`INSERT INTO dm_conversations (user_a_id, user_b_id, last_message_at) VALUES ($1, $2, NOW())`, [a, b]);
});

test.afterAll(async () => {
  await teardown(
    ...contexts.map((c) => () => c.close()),
    () => browser?.close(),
    () => pool.query(`DELETE FROM pods WHERE created_by = $1 AND name LIKE $2`, [owner?.id ?? null, `${RUN}%`]),
    () => (circleId ? pool.query(`DELETE FROM invites WHERE circle_id = $1`, [circleId]) : Promise.resolve()),
    () => (circleId ? pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]) : Promise.resolve()),
    () => cleanup(pool, { ids: idsOf(owner, invitee, requester) }),
  );
});

test(`an owner invites from the sheet, closes the circle, approves an ask and makes a pod, all live (${engineLabel()})`, async () => {
  test.setTimeout(300_000);
  const o = await signedIn(owner!);
  const inv = await signedIn(invitee!);
  const req = await signedIn(requester!);
  const members = o.getByTestId('circle-members');

  // ── 1. Invite from the sheet; the invitee accepts from the bell ─────────────────────────────────────────────
  await gotoRetry(o, `${APP}/circles/${circleId}`);
  await expect(members.getByText(owner!.displayName)).toBeVisible({ timeout: 30_000 });
  await gotoRetry(inv, `${APP}/circles`);
  await o.getByTestId('circle-invite').click();
  const sheet = o.getByRole('dialog', { name: 'Invite people' });
  await expect(sheet).toBeVisible();
  await sheet.getByTestId(`invite-candidate-${invitee!.id}`).click();
  await sheet.getByTestId('invite-send').click();
  await expect(sheet.getByTestId(`invite-candidate-${invitee!.id}`)).toContainText('Invited', { timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Done' }).click();

  const bell = inv.getByRole('button', { name: 'Notifications' });
  await expect(bell.locator('span').filter({ hasText: /^\d+$/ })).toBeVisible({ timeout: 30_000 });
  await bell.click();
  const row = inv.getByTestId('notification-row').filter({ hasText: `${RUN} Founders circle` }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Accept' }).click();
  await inv.waitForURL(new RegExp(`/circles/${circleId}`), { timeout: 30_000 });
  // The owner's page, never reloaded, lists the new member.
  await expect(members.getByText(invitee!.displayName)).toBeVisible({ timeout: 30_000 });

  // ── 2. Closed: the requester asks, the owner sees it live and approves; the requester's page unlocks ─────────
  await o.getByTestId('circle-settings').click();
  await o.getByTestId('circle-policy-closed').check();
  await o.getByTestId('circle-policy-save').click();
  await expect(o.getByTestId('circle-closed-badge')).toBeVisible({ timeout: 20_000 });
  await o.getByTestId('circle-requests-open').click();
  const requests = o.getByTestId('circle-requests');
  await expect(requests.getByText('Nobody is waiting to join.')).toBeVisible({ timeout: 20_000 });

  await gotoRetry(req, `${APP}/circles/${circleId}`);
  await expect(req.getByTestId('circle-locked')).toContainText('This circle is closed. Ask to join to see its wall, members and events.', { timeout: 30_000 });
  await expect(req.getByTestId('circle-members')).toHaveCount(0);
  const ask = req.getByTestId(`circle-join-${circleId}`);
  await expect(ask).toHaveText('Ask to join');
  await ask.click();
  await expect(ask).toHaveText('Requested · Cancel', { timeout: 20_000 });

  const askRow = requests.getByTestId(`circle-request-${requester!.id}`);
  await expect(askRow).toBeVisible({ timeout: 30_000 });
  await askRow.getByRole('button', { name: 'Approve' }).click();
  await expect(requests.getByText('Nobody is waiting to join.')).toBeVisible({ timeout: 20_000 });
  await o.keyboard.press('Escape');
  await expect(req.getByTestId('circle-locked')).toHaveCount(0, { timeout: 30_000 });
  await expect(req.getByTestId('circle-members').getByText(requester!.displayName)).toBeVisible({ timeout: 30_000 });
  await expect(ask).toHaveText('Leave');
  await expect(members.getByText(requester!.displayName)).toBeVisible({ timeout: 30_000 });

  // ── 3. A new pod from the circle: it is listed and the owner stays on the circle ─────────────────────────────
  await o.getByTestId('circle-new-pod').click();
  const form = o.getByRole('dialog', { name: `New pod in ${RUN} Founders circle` });
  await expect(form).toBeVisible();
  await form.getByLabel('Pod name').fill(`${RUN} Breakfast pod`);
  await o.getByRole('button', { name: 'Create Pod' }).click();
  await expect(o.getByText(`${RUN} Breakfast pod is created and added to ${RUN} Founders circle.`)).toBeVisible({ timeout: 20_000 });
  await expect(o.getByTestId('circle-pods').getByText(`${RUN} Breakfast pod`)).toBeVisible({ timeout: 20_000 });
  expect(new URL(o.url()).pathname).toBe(`/circles/${circleId}`);
  // The form's default visibility is Private, so the new pod is named on the circle only to its members: the requester,
  // now a member of the circle but not of the pod, is not shown it (the circle page's privacy rule), while the owner is.
  await expect(o.getByTestId('circle-pods').getByText(`${RUN} Breakfast pod`)).toBeVisible();
  await expect(req.getByTestId('circle-members').getByText(requester!.displayName)).toBeVisible({ timeout: 30_000 });
  await expect(req.getByText(`${RUN} Breakfast pod`)).toHaveCount(0);
});
