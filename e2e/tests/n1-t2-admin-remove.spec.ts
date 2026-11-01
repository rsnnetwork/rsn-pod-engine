import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { APP, cleanup, gotoRetry, idsOf, teardown } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';

// T2 (1 Nov 2026), 30 Oct review: "Admin dashboard buttons don't respond … Removing users doesn't work. Users that were
// removed still show up." Stefan removed two accounts twice each: the Active tab listed every status and a removed row
// stayed where it was.
//
// Headed, two browsers. An admin removes a throwaway member from the Users page: it asks first in the page, says it is
// working, says what happened, and the row leaves Active and is under Removed without a reload. Meanwhile a second
// member, connected to that person and in a pod with them, watches them leave People and the pod's member list, and
// sees their old conversation as "Former member", all without a reload. Reactivate brings everything back the same way.
// Throwaway accounts only, deleted by id at the end.

const RUN = `zq${Date.now().toString(36)}`;
let browser: Browser;
let admin: TestUser | undefined, target: TestUser | undefined, friend: TestUser | undefined;
let podId: string | undefined;
const contexts: BrowserContext[] = [];

async function signedIn(user: TestUser): Promise<Page> {
  const ctx = await browser.newContext(contextOptions({ width: 1280, height: 900 }));
  contexts.push(ctx);
  await ctx.addInitScript((t) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: user.accessToken, r: user.refreshToken });
  return ctx.newPage();
}

/** A throwaway account on the reserved test domain, with a name only this run uses. */
async function throwaway(label: string, role: 'member' | 'admin' = 'member'): Promise<TestUser> {
  const u = await createTestUser(`t2${label}`, role);
  const name = `${RUN} ${label}`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3 WHERE id = $1`, [u.id, `${u.id}@rsn-e2e.invalid`, name]);
  return { ...u, email: `${u.id}@rsn-e2e.invalid`, displayName: name };
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  admin = await throwaway('Admin', 'admin');
  target = await throwaway('Target');
  friend = await throwaway('Friend');
  // The friend and the target are connected (a conversation), and are both in a pod the friend runs.
  const pod = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, created_by, visibility) VALUES ($1, $2, 'private') RETURNING id`, [`${RUN} pod`, friend.id]);
  podId = pod.rows[0].id;
  await pool.query(
    `INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active'), ($1, $3, 'member', 'active')`,
    [podId, friend.id, target.id]);
  const [a, b] = friend.id < target.id ? [friend.id, target.id] : [target.id, friend.id];
  const conv = await pool.query<{ id: string }>(
    `INSERT INTO dm_conversations (user_a_id, user_b_id, last_message_at) VALUES ($1, $2, NOW()) RETURNING id`, [a, b]);
  await pool.query(`INSERT INTO direct_messages (conversation_id, from_user_id, content) VALUES ($1, $2, 'An old hello')`, [conv.rows[0].id, target.id]);
});

test.afterAll(async () => {
  await teardown(
    ...contexts.map((c) => () => c.close()),
    () => browser?.close(),
    () => cleanup(pool, { ids: idsOf(admin, target, friend), podId }),
  );
});

test(`an admin removes a member, who leaves every list live, and Reactivate brings them back (${engineLabel()})`, async () => {
  test.setTimeout(240_000);
  const t = target!;
  const adminPage = await signedIn(admin!);
  const people = await signedIn(friend!);
  const podPage = await people.context().newPage();
  const inbox = await people.context().newPage();

  // The second member's three screens, each opened once and never reloaded.
  await gotoRetry(people, `${APP}/connections`);
  await expect(people.getByText(t.displayName).first()).toBeVisible({ timeout: 30_000 });
  await gotoRetry(podPage, `${APP}/pods/${podId}`);
  const podMembers = podPage.locator('#pod-members');
  await expect(podMembers.getByText(t.displayName)).toBeVisible({ timeout: 30_000 });
  await gotoRetry(inbox, `${APP}/messages`);
  await expect(inbox.getByText(t.displayName).first()).toBeVisible({ timeout: 30_000 });

  // The admin finds them on the Active tab.
  await gotoRetry(adminPage, `${APP}/admin/users`);
  await adminPage.getByPlaceholder('Search by name or email...').fill(RUN);
  const row = adminPage.getByTestId(`admin-user-${t.id}`);
  await expect(adminPage.getByTestId('admin-users-list-active').getByTestId(`admin-user-${t.id}`)).toBeVisible({ timeout: 30_000 });
  await expect(adminPage.getByTestId('admin-users-count-active')).toHaveText('3');
  await expect(adminPage.getByTestId('admin-users-count-deactivated')).toHaveText('0');

  // Remove asks first, in the page; Cancel leaves everything as it was.
  await row.getByTestId(`admin-user-remove-${t.id}`).click();
  const dialog = adminPage.getByRole('dialog', { name: `Remove ${t.displayName}?` });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('confirm-dialog-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();

  // Remove for real: a sentence, and the row leaves Active without a reload.
  await row.getByTestId(`admin-user-remove-${t.id}`).click();
  await adminPage.getByRole('dialog', { name: `Remove ${t.displayName}?` }).getByTestId('confirm-dialog-confirm').click();
  await expect(adminPage.getByText(`${t.displayName} was removed. They are under Removed now.`)).toBeVisible({ timeout: 15_000 });
  await expect(adminPage.getByTestId('admin-users-list-active').getByTestId(`admin-user-${t.id}`)).toHaveCount(0, { timeout: 15_000 });
  await expect(adminPage.getByTestId('admin-users-count-active')).toHaveText('2');
  await expect(adminPage.getByTestId('admin-users-count-deactivated')).toHaveText('1');
  const stored = await pool.query(`SELECT status FROM users WHERE id = $1`, [t.id]);
  expect(stored.rows[0].status).toBe('deactivated');

  // It is under Removed.
  await adminPage.getByTestId('admin-users-tab-deactivated').click();
  const removedRow = adminPage.getByTestId('admin-users-list-deactivated').getByTestId(`admin-user-${t.id}`);
  await expect(removedRow).toBeVisible({ timeout: 15_000 });
  await expect(removedRow.getByText('Removed', { exact: true })).toBeVisible();

  // The second member saw them go, without a reload: People, the pod's members, and the old conversation.
  await expect(people.getByText(t.displayName)).toHaveCount(0, { timeout: 20_000 });
  await expect(podMembers.getByText(t.displayName)).toHaveCount(0, { timeout: 20_000 });
  await expect(inbox.getByText(t.displayName)).toHaveCount(0, { timeout: 20_000 });
  await expect(inbox.getByText('Former member').first()).toBeVisible({ timeout: 20_000 });
  await inbox.getByText('Former member').first().click();
  await expect(inbox.getByText('An old hello')).toBeVisible({ timeout: 15_000 });
  await expect(inbox.getByTestId('former-member-composer')).toHaveText('This person is no longer a member of REASON, so they cannot get messages.');
  await expect(inbox.getByTestId('former-member-header')).toBeVisible();

  // Reactivate brings them back: out of Removed, into Active, and back on the second member's screens.
  await removedRow.getByTestId(`admin-user-activate-${t.id}`).click();
  await adminPage.getByRole('dialog', { name: `Reactivate ${t.displayName}?` }).getByTestId('confirm-dialog-confirm').click();
  await expect(adminPage.getByText(`${t.displayName} is active again. They are under Active now.`)).toBeVisible({ timeout: 15_000 });
  await expect(removedRow).toHaveCount(0, { timeout: 15_000 });
  await expect(adminPage.getByTestId('admin-users-count-deactivated')).toHaveText('0');
  await adminPage.getByTestId('admin-users-tab-active').click();
  await expect(adminPage.getByTestId('admin-users-list-active').getByTestId(`admin-user-${t.id}`)).toBeVisible({ timeout: 15_000 });

  await expect(people.getByText(t.displayName).first()).toBeVisible({ timeout: 20_000 });
  await expect(podMembers.getByText(t.displayName)).toBeVisible({ timeout: 20_000 });
  // The open thread has its name back (on a phone the thread takes the screen and the inbox list steps aside).
  await expect(inbox.getByText(t.displayName).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(inbox.getByTestId('former-member-composer')).toHaveCount(0, { timeout: 20_000 });
});
