import { test, expect, type Browser, type Locator, type Page, type Response } from '@playwright/test';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import {
  DEVICE, RUN, RUN_WIDTH, api, cleanupRun, expectNotReloaded, launch, markNotReloaded, noSidewaysScroll, openAs, pool,
  shot, tall, throwaway, where, type TestUser,
} from '../helpers/sweep';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM IT'S YOU, ON SCREEN (10 Nov 2026 spec, section 11; Part 3 Task 7, the preview client for Task 2's routes).
// Settings > Account, at 360px (or the iPhone's own 390px with E2E_DEVICE="iPhone 14"), against the preview:
//   change   a throwaway member presses "Change email", "Send code", types the code, gives a fresh address, types the
//            second code: the toast says "Your sign-in email is now …" and the Account card shows the new address,
//            with no reload;
//   close    the same member presses "Close account": the question comes first ("Close your account?"), no code is
//            asked for until "Close my account"; then "Confirm it's you", the code, and they land signed out at / (the
//            sign-in page);
//   second   another throwaway sees "Close account" too, but it leads only to the question and then to the code: no
//            way round it, on the page or over the API (403 REAUTH_REQUIRED without a proof).
// Every dialog fits the screen (its boundingBox inside the viewport) and every button in it is at least 44px.
//
// Reading the codes: production never emails a reserved test address (@rsn-e2e.invalid); the spec writes the keyed
// hash of a code it chose onto the row it just asked for (as p3-reauth-api and n1-t4-signin-code do). Throwaway
// accounts only; every row deleted by id at the end, and the magic links of the exact new address.
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
/** The phone's own width with E2E_DEVICE, else the smallest phone the screens are built for. */
const WIDTH = DEVICE ? RUN_WIDTH : 360;

let browser: Browser;
let member: TestUser;
let second: TestUser;
let page: Page;
const newEmail = `p3t7-${RUN}-${uuid()}@rsn-e2e.invalid`;

/** Put the keyed hash of a code the spec chose on the newest magic_links row `where` picks, and answer the code. */
async function knownCode(where: string, params: unknown[]): Promise<string> {
  const row = await pool.query<{ id: string; token_hash: string }>(
    `SELECT id, token_hash FROM magic_links WHERE ${where} ORDER BY created_at DESC LIMIT 1`,
    params,
  );
  expect(row.rows[0], `a magic_links row where ${where}`).toBeTruthy();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const hash = crypto.createHmac('sha256', SECRET).update(`sign-in-code:${row.rows[0].token_hash}:${code}`).digest('hex');
  await pool.query(`UPDATE magic_links SET code_hash = $2 WHERE id = $1`, [row.rows[0].id, hash]);
  return code;
}

/** The reauth rows asked for this member and scope. */
async function reauthRows(userId: string, scope: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM magic_links WHERE target_user_id = $1 AND purpose = 'reauth' AND action = $2`, [userId, scope]);
  return Number(r.rows[0].n);
}

/** The dialog sits inside the screen, and every button in it is at least 44px tall. */
async function fits(p: Page, dialog: Locator, label: string): Promise<void> {
  await expect(dialog, `${label} is open`).toBeVisible();
  // The sheet rises in; its box is read once it has settled.
  await expect.poll(async () => {
    const box = await dialog.boundingBox();
    const view = p.viewportSize();
    if (!box || !view) return false;
    return box.x >= -0.5 && box.y >= -0.5 && box.x + box.width <= view.width + 0.5 && box.y + box.height <= view.height + 0.5;
  }, { message: `${label} fits the ${WIDTH}px screen`, timeout: 10_000 }).toBe(true);
  const buttons = dialog.getByRole('button');
  const count = await buttons.count();
  expect(count, `${label} has buttons`).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if (!(await button.isVisible())) continue;
    await tall(button, `${label}: button ${(await button.innerText()).trim() || (await button.getAttribute('aria-label')) || i + 1}`);
  }
  await noSidewaysScroll(p, label);
}

const answerOf = (p: Page, path: string) =>
  p.waitForResponse((r: Response) => new URL(r.url()).pathname === `/api${path}` && r.request().method() === 'POST');

/** "Confirm it's you" for `user`: where the code goes, "Send code", then the known code typed. */
async function confirmItsYou(p: Page, user: TestUser, email: string, scope: string): Promise<void> {
  const dialog = p.getByRole('dialog', { name: "Confirm it's you" });
  await fits(p, dialog, `"Confirm it's you" (${scope})`);
  await expect(dialog.getByText(`To keep your account safe we'll send a code to ${email}.`)).toBeVisible();
  await expect(dialog.getByLabel('6-digit code from the email'), 'no code field before the code is sent').toHaveCount(0);
  const sent = answerOf(p, '/auth/reauth/code');
  await dialog.getByRole('button', { name: 'Send code' }).click();
  expect((await sent).status(), 'the code is sent').toBe(200);
  await expect(dialog.getByText(`We sent a code to ${email}.`, { exact: false })).toBeVisible();
  await fits(p, dialog, `"Confirm it's you" code step (${scope})`);
  const code = await knownCode(`target_user_id = $1 AND purpose = 'reauth' AND action = $2`, [user.id, scope]);
  const verified = answerOf(p, '/auth/reauth/verify');
  await dialog.getByLabel('6-digit code from the email').fill(code);
  expect((await verified).status(), 'the code is right').toBe(200);
}

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) sets known codes').toBeTruthy();
  browser = await launch();
  member = await throwaway('reauth', { first: 'Ana' });
  second = await throwaway('second', { first: 'Bo' });
});

test.afterAll(async () => {
  await cleanupRun([
    () => pool.query('DELETE FROM magic_links WHERE email = $1', [newEmail]),
  ]);
  await browser?.close();
});

test(`change email: confirm it's you, a code to the new address, and the card shows it without a reload (${where()})`, async () => {
  test.setTimeout(180_000);
  ({ page } = await openAs(browser, member, '/settings', { width: WIDTH }));
  await expect(page.getByTestId('settings-account-email')).toHaveText(member.email, { timeout: 30_000 });
  await noSidewaysScroll(page, 'Settings');
  await markNotReloaded(page);

  const change = page.getByTestId('settings-change-email');
  await change.scrollIntoViewIfNeeded();
  await tall(change, 'Change email');
  await change.click();
  await confirmItsYou(page, member, member.email, 'change_email');

  const dialog = page.getByRole('dialog', { name: 'Change email' });
  await fits(page, dialog, 'Change email');
  await dialog.getByLabel('New email address').fill(newEmail);
  const asked = answerOf(page, '/users/me/email/code');
  await dialog.getByRole('button', { name: 'Send code to this address' }).click();
  const askedRes = await asked;
  expect(askedRes.status(), await askedRes.text()).toBe(200);
  expect(askedRes.request().postDataJSON(), 'the proof travels in the body').toMatchObject({ newEmail, reauthToken: expect.any(String) });
  await expect(dialog.getByText(`We sent a code to ${newEmail}. Type it to finish.`)).toBeVisible();
  await fits(page, dialog, 'Change email code step');
  await shot(page, 'p3t7-change-email-code');

  const code = await knownCode(`target_user_id = $1 AND purpose = 'email_change'`, [member.id]);
  const changed = answerOf(page, '/users/me/email/verify');
  await dialog.getByLabel('6-digit code from the email').fill(code);
  expect((await changed).status(), 'the change is made').toBe(200);

  await expect(page.getByText(`Your sign-in email is now ${newEmail}.`)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('settings-account-email')).toHaveText(newEmail, { timeout: 10_000 });
  await expectNotReloaded(page, 'after the email change');
  const row = await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [member.id]);
  expect(row.rows[0].email).toBe(newEmail);
  // This tab goes on with the new pair the server answered.
  const stored = await page.evaluate(() => localStorage.getItem('rsn_tokens'));
  expect(stored).toBeTruthy();
  expect(JSON.parse(stored!).refresh).not.toBe(member.refreshToken);
});

test(`close account: the question first, then the code, then signed out at / (${where()})`, async () => {
  test.setTimeout(180_000);
  const close = page.getByTestId('settings-close-account');
  await close.scrollIntoViewIfNeeded();
  await tall(close, 'Close account');
  await close.click();

  const question = page.getByRole('dialog', { name: 'Close your account?' });
  await fits(page, question, '"Close your account?"');
  await expect(question.getByText("You'll be signed out everywhere and removed from your pods and events. To come back you'll need to apply again.")).toBeVisible();
  expect(await reauthRows(member.id, 'close_account'), 'no code is asked for before the member says yes').toBe(0);
  await shot(page, 'p3t7-close-question');
  await question.getByRole('button', { name: 'Close my account' }).click();

  const closed = answerOf(page, '/users/me/close');
  await confirmItsYou(page, member, newEmail, 'close_account');
  const closedRes = await closed;
  expect(closedRes.status(), await closedRes.text()).toBe(200);
  expect(closedRes.request().postDataJSON(), 'the proof travels in the body').toEqual({ reauthToken: expect.any(String) });

  await expect.poll(() => new URL(page.url()).pathname, { message: 'lands signed out at / (the sign-in page)', timeout: 20_000 })
    .toMatch(/^\/(login)?$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rsn_tokens')), { message: 'signed out on this device' }).toBeNull();
  const row = await pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [member.id]);
  expect(row.rows[0].status).toBe('deactivated');
});

test(`another member finds no way round the code, on the page or over the API (${where()})`, async () => {
  test.setTimeout(120_000);
  const { page: theirs } = await openAs(browser, second, '/settings', { width: WIDTH });
  const close = theirs.getByTestId('settings-close-account');
  await expect(close).toBeVisible({ timeout: 30_000 });
  await close.scrollIntoViewIfNeeded();
  await close.click();
  const question = theirs.getByRole('dialog', { name: 'Close your account?' });
  await fits(theirs, question, '"Close your account?" (second member)');
  await question.getByRole('button', { name: 'Close my account' }).click();

  const dialog = theirs.getByRole('dialog', { name: "Confirm it's you" });
  await fits(theirs, dialog, `"Confirm it's you" (second member)`);
  await expect(dialog.getByRole('button', { name: 'Send code' })).toBeVisible();
  await expect(dialog.getByLabel('6-digit code from the email')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(theirs.getByRole('dialog')).toHaveCount(0);
  expect(await reauthRows(second.id, 'close_account'), 'cancelled before "Send code": nothing sent').toBe(0);

  const bypass = await api(second, 'POST', '/users/me/close', {});
  expect(bypass.status, bypass.text).toBe(403);
  expect(bypass.json.error).toMatchObject({ code: 'REAUTH_REQUIRED', details: { scope: 'close_account' } });
  const forged = await api(second, 'POST', '/users/me/close', { reauthToken: second.accessToken });
  expect(forged.status, 'an access token is no proof').toBe(403);
  const row = await pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [second.id]);
  expect(row.rows[0].status).toBe('active');
  await expect(theirs.getByTestId('settings-account-email')).toHaveText(second.email);
});
