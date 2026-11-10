import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { apiRequest, createSession } from '../helpers/api';
import { APP, cleanup, gotoRetry, idsOf, teardown } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';

// F7 (10 Nov 2026), Stefan's feedback, spec 10/07: a super admin could not end a member's event that was left
// running. The event page's REST end refused everyone but the host.
//
// Headed, two browsers. A member hosts an event and goes live. A throwaway super admin, on a phone-sized window, sees
// "End event" on the event's page and on the Admin Events row (each fits the window), is asked "End this event for
// everyone?", Cancel changes nothing, and End event ends it. The host's event page, opened before and never reloaded,
// moves to Ended; so do the super admin's page and the Admin Events row, whose End event goes away. The database says
// completed. Throwaway accounts only (%rsn-e2e.invalid), deleted by id at the end with their pod and event.

const RUN = `zf7${Date.now().toString(36)}`;
let browser: Browser;
let superAdmin: TestUser | undefined, host: TestUser | undefined;
let podId: string | undefined;
let eventId: string | undefined;
const contexts: BrowserContext[] = [];

async function signedIn(user: TestUser, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext(contextOptions(viewport));
  contexts.push(ctx);
  await ctx.addInitScript((t) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: user.accessToken, r: user.refreshToken });
  return ctx.newPage();
}

/** A throwaway account on the reserved test domain, with a name only this run uses. */
async function throwaway(label: string, role: 'member' | 'super_admin' = 'member'): Promise<TestUser> {
  const u = await createTestUser(`f7${label}`, role);
  const name = `${RUN} ${label}`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3 WHERE id = $1`, [u.id, `${u.id}@rsn-e2e.invalid`, name]);
  return { ...u, email: `${u.id}@rsn-e2e.invalid`, displayName: name };
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  superAdmin = await throwaway('Super', 'super_admin');
  host = await throwaway('Host');
  // The member's pod, which they direct, and an event in it that they take live.
  const pod = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, created_by, visibility) VALUES ($1, $2, 'private') RETURNING id`, [`${RUN} pod`, host.id]);
  podId = pod.rows[0].id;
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, host.id]);
  const event = await createSession(host, podId, `${RUN} event`, new Date(Date.now() + 60_000));
  eventId = event.id;
  await apiRequest(host, 'POST', `/sessions/${eventId}/host/start`);
  const live = await pool.query<{ status: string }>(`SELECT status FROM sessions WHERE id = $1`, [eventId]);
  expect(live.rows[0].status).toBe('lobby_open');
});

test.afterAll(async () => {
  await teardown(
    ...contexts.map((c) => () => c.close()),
    () => browser?.close(),
    () => cleanup(pool, { ids: idsOf(superAdmin, host), podId }),
  );
});

test(`a super admin ends a member's live event from its page, and the host's page moves to Ended live (${engineLabel()})`, async () => {
  test.setTimeout(180_000);
  const hostPage = await signedIn(host!, { width: 1280, height: 900 });
  const adminPage = await signedIn(superAdmin!, { width: 390, height: 844 });
  const adminList = await adminPage.context().newPage();

  // The host's event page, opened once and never reloaded. The host has no End event here (that is in the live room).
  await gotoRetry(hostPage, `${APP}/sessions/${eventId}`);
  await expect(hostPage.getByText('Live now').first()).toBeVisible({ timeout: 30_000 });
  await expect(hostPage.getByTestId('end-event')).toHaveCount(0);

  // Admin Events lists the live event with End event, inside the window.
  await gotoRetry(adminList, `${APP}/admin/sessions`);
  const row = adminList.getByTestId(`admin-event-${eventId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.scrollIntoViewIfNeeded();
  await expectReachable(adminList, row.getByTestId('end-event'), 'Admin Events: End event');

  // The super admin's event page shows End event, inside a phone-width window.
  await gotoRetry(adminPage, `${APP}/sessions/${eventId}`);
  const endButton = adminPage.getByTestId('end-event');
  await expect(endButton).toBeVisible({ timeout: 30_000 });
  await endButton.scrollIntoViewIfNeeded();
  const box = await expectReachable(adminPage, endButton, 'Event page: End event');
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await adminPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // It asks first; Cancel leaves the event running.
  await tapReachable(adminPage, endButton, 'Event page: End event');
  const dialog = adminPage.getByRole('dialog', { name: 'End this event for everyone?' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('confirm-dialog-cancel').click();
  await expect(dialog).toBeHidden();
  const stillLive = await pool.query<{ status: string }>(`SELECT status FROM sessions WHERE id = $1`, [eventId]);
  expect(stillLive.rows[0].status).toBe('lobby_open');

  // End it for real.
  await tapReachable(adminPage, endButton, 'Event page: End event');
  await adminPage.getByRole('dialog', { name: 'End this event for everyone?' }).getByTestId('confirm-dialog-confirm').click();
  await expect(adminPage.getByText('Event ended')).toBeVisible({ timeout: 15_000 });

  // The database says it is over.
  await expect.poll(async () => (await pool.query<{ status: string }>(`SELECT status FROM sessions WHERE id = $1`, [eventId])).rows[0].status,
    { timeout: 15_000 }).toBe('completed');

  // Every page moves to Ended without a reload: the host's, the super admin's, and the Admin Events row.
  await expect(hostPage.getByText('Ended', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(hostPage.getByText('Live now')).toHaveCount(0);
  await expect(adminPage.getByText('Ended', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(adminPage.getByTestId('end-event')).toHaveCount(0);
  await expect(row.getByText('Ended', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(row.getByTestId('end-event')).toHaveCount(0);
});
