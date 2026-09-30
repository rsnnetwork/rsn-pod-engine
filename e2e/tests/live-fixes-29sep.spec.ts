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

// Resolves, per page, once the server has accepted that page's live-update socket.
const socketAccepted = new WeakMap<Page, Promise<void>>();

// liveUpdates: false gives a view that never hears the server, like a laptop tab that
// slept through a change (the socket is refused, so no entity event can reach it).
async function openAs(u: TestUser, path: string, opts: { liveUpdates?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: PHONE });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  if (opts.liveUpdates === false) await ctx.routeWebSocket(/socket\.io/, (ws) => ws.close());
  ctxs.push(ctx);
  const page = await ctx.newPage();
  // Registered before the page loads, so the connection cannot be missed.
  socketAccepted.set(page, new Promise<void>((resolve) => {
    page.on('websocket', (ws) => {
      if (!/socket\.io/.test(ws.url())) return;
      // Socket.IO packet "40" from the server: it accepted the token and the member's room.
      ws.on('framereceived', (f) => { if (String(f.payload).startsWith('40')) resolve(); });
    });
  }));
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

// Wait until the page can hear the server, so a change made next is not missed.
// It also waits for the page's load event: WebKit answers a repeat GET made before
// that from its own cache, so a refetch triggered by an event that early would bring
// back the old value (seen locally: the event arrives, the refetch returns stale data).
async function liveUpdatesReady(page: Page): Promise<void> {
  const ready = socketAccepted.get(page);
  if (!ready) throw new Error('liveUpdatesReady needs a page opened with openAs');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the live-update socket was not accepted within 30s')), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await page.waitForLoadState('load');
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

test('a hidden member leaves search and suggestions, and comes back', async () => {
  test.setTimeout(240_000);
  const run = Date.now().toString(36);
  const viewer = await createTestUser('lf-vis-viewer'); made.push(viewer.id);
  const hidden = await createTestUser('lf-vis-hidden'); made.push(hidden.id);
  const name = `Zqv${run} Hidden`;
  // Three made-up words, in no job category: the viewer wants them and the hidden
  // member offers them, so the matcher suggests that member and nobody real.
  const words = `zq${run} wx${run} vk${run}`;
  await pool.query(`UPDATE users SET display_name = $1, expertise_text = $2 WHERE id = $3`, [name, words, hidden.id]);
  await pool.query(`UPDATE users SET who_i_want_to_meet = $1 WHERE id = $2`, [words, viewer.id]);
  const found = async () => ((await api(viewer, 'GET', `/users/find?q=Zqv${run}`)).body?.data ?? []).map((r: any) => r.userId);
  const suggested = async () => ((await api(viewer, 'GET', '/matches/platform')).body?.data?.matches ?? []).map((m: any) => m.userId);

  // Visible first, so "absent" below means something: both lists can show this member.
  expect(await found()).toContain(hidden.id);
  expect(await suggested()).toContain(hidden.id);

  // Settings is already open (say on a laptop) when the member hides on another screen.
  const openPage = await openAs(hidden, '/settings');
  const openSwitch = openPage.getByRole('switch', { name: 'Show me in search and suggestions' });
  await expect(openSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
  await liveUpdatesReady(openPage);

  // The Settings switch saves through PUT /users/me { profileVisible }.
  expect((await api(hidden, 'PUT', '/users/me', { profileVisible: false })).status).toBe(200);
  expect(await found()).not.toContain(hidden.id);
  expect(await suggested()).not.toContain(hidden.id);

  // The page that was already open follows the server without a reload (the user:<id>
  // entity event), so saving an unrelated switch there cannot write the old value back.
  await expect(openSwitch).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });
  await openPage.getByRole('switch', { name: 'Email notifications', exact: true }).click();
  await openPage.getByRole('button', { name: 'Save Settings' }).click();
  await expect(openPage.getByText('Settings saved')).toBeVisible();
  const stored = (await pool.query(`SELECT profile_visible, notify_email FROM users WHERE id = $1`, [hidden.id])).rows[0];
  expect(stored.profile_visible, 'still hidden after saving another switch').toBe(false);
  expect(stored.notify_email, 'the switch that was changed').toBe(false);
  // This member is deleted at the end, so the changed preference needs no restoring.

  // Still reachable by link for someone who has it.
  const profile = await openAs(viewer, `/profile/${hidden.id}`);
  await expect(profile.getByText(name)).toBeVisible({ timeout: 30_000 });

  // Settings says what the switch now does, and a FRESH load shows it OFF (the saved
  // choice reaches the page; the session used to omit it, so every load read ON and
  // a Save quietly un-hid the member). The switch itself, not its label, is fully on
  // a phone screen with a real tap target.
  const settings = await openAs(hidden, '/settings');
  const label = settings.getByText('Show me in search and suggestions');
  await expect(label).toBeVisible({ timeout: 30_000 });
  await expect(settings.getByText('People you already know can still see your profile and message you.')).toBeVisible();
  const toggle = settings.getByRole('switch', { name: 'Show me in search and suggestions' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // Sizes mean nothing until the stylesheet has applied (WebKit paints the bare page first).
  await settings.waitForLoadState('load');
  await toggle.scrollIntoViewIfNeeded();
  const box = await toggle.boundingBox();
  expect(box, 'the profile-visibility switch has a box on screen').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);
  // The visible switch is 44 x 24 and a ::after layer grows its touch area to 44 high.
  // boundingBox() cannot see that layer, so read its size too and take the larger.
  const tap = await toggle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const after = getComputedStyle(el, '::after');
    return { w: Math.max(r.width, parseFloat(after.width) || 0), h: Math.max(r.height, parseFloat(after.height) || 0) };
  });
  expect(tap.w, 'the switch keeps its full width on a phone').toBeGreaterThanOrEqual(44);
  expect(tap.h, 'the touch area is at least 44px high').toBeGreaterThanOrEqual(44);
  // Nothing (bottom bar, toast) covers it: a trial click checks that without pressing it.
  await toggle.click({ trial: true });

  expect((await api(hidden, 'PUT', '/users/me', { profileVisible: true })).status).toBe(200);
  expect(await found()).toContain(hidden.id);
  expect(await suggested()).toContain(hidden.id);

  // A fresh load of Settings now shows it ON again.
  const settingsAgain = await openAs(hidden, '/settings');
  await expect(settingsAgain.getByRole('switch', { name: 'Show me in search and suggestions' }))
    .toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
});

test('a Settings view that never heard about the change still cannot un-hide a member', async () => {
  test.setTimeout(240_000);
  const member = await createTestUser('lf-vis-stale'); made.push(member.id);
  // This view gets no live updates, like a laptop tab that slept through the change.
  const stale = await openAs(member, '/settings', { liveUpdates: false });
  const visibility = stale.getByRole('switch', { name: 'Show me in search and suggestions' });
  await expect(visibility).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });

  // The member hides on another screen. This view cannot know, and still shows ON.
  expect((await api(member, 'PUT', '/users/me', { profileVisible: false })).status).toBe(200);
  await stale.waitForTimeout(1500); // a negative check: give an update time to (wrongly) arrive
  await expect(visibility).toHaveAttribute('aria-checked', 'true');

  // Saving an unrelated switch here must send only that switch, so the hiding survives.
  await stale.getByRole('switch', { name: 'Email notifications', exact: true }).click();
  await stale.getByRole('button', { name: 'Save Settings' }).click();
  await expect(stale.getByText('Settings saved')).toBeVisible();
  const stored = (await pool.query(`SELECT profile_visible, notify_email FROM users WHERE id = $1`, [member.id])).rows[0];
  expect(stored.profile_visible, 'the stale view did not write the old visibility back').toBe(false);
  expect(stored.notify_email, 'the switch that was changed').toBe(false);

  // After saving, the page re-reads the server and shows the truth.
  await expect(visibility).toHaveAttribute('aria-checked', 'false', { timeout: 20_000 });
});
