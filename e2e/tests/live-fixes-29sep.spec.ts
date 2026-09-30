// e2e/tests/live-fixes-29sep.spec.ts
import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { launchBrowser } from '../helpers/engine';

const PHONE = { width: 390, height: 844 };
let browser: Browser;
const ctxs: BrowserContext[] = [];
const made: string[] = [];

async function api(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: PHONE });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

test.beforeAll(async () => { browser = await launchBrowser(); });
test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
  await browser?.close();
  if (made.length) await cleanup(pool, { ids: made });
});

test('a declined request is final for the sender; the decliner can still ask', async () => {
  test.setTimeout(240_000);
  const a = await createTestUser('lf-decline-a'); made.push(a.id);
  const b = await createTestUser('lf-decline-b'); made.push(b.id);

  const first = await api(a, 'POST', `/matches/platform/${b.id}/interest`);
  expect(first.status).toBe(201);
  const declined = await api(b, 'POST', `/pokes/${first.body.data.id}/decline`);
  expect(declined.status).toBe(200);

  const bells = async () => (await pool.query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'poke'`, [b.id])).rows[0].n as number;
  const before = await bells();
  expect((await api(a, 'POST', `/matches/platform/${b.id}/interest`)).status).toBe(403);
  expect((await api(a, 'POST', `/pokes`, { recipientId: b.id })).status).toBe(403);
  expect(await bells()).toBe(before);

  const page = await openAs(a, `/profile/${b.id}`);
  const declinedControl = page.getByTestId('meet-state');
  await expect(declinedControl).toHaveText(/Request declined/, { timeout: 30_000 });
  await expect(declinedControl).toBeDisabled();
  // On the phone the disabled control must sit fully on screen, at a proper tap size.
  await declinedControl.scrollIntoViewIfNeeded();
  const box = await declinedControl.boundingBox();
  expect(box, 'the declined control has a box on screen').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // The person who said no sees the ordinary, enabled button, not the disabled one.
  const theirPage = await openAs(b, `/profile/${a.id}`);
  const askBack = theirPage.getByTestId('meet-state');
  await expect(askBack).toHaveText(/I want to meet/, { timeout: 30_000 });
  await expect(askBack).toBeEnabled();

  expect((await api(b, 'POST', `/matches/platform/${a.id}/interest`)).status).toBe(201);
});
