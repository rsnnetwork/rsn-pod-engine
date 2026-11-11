import { test, expect, type Browser, type BrowserContext, type Page, type Locator } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { APP, SERVER, cleanup, gotoRetry, idsOf, teardown } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';

// SHIRLEY PILOT S8: CALENDAR FREE/BUSY (12 Nov 2026; brief RSN 10; plan decision D7)
//
// Calendar free/busy ships dark (CALENDAR_SYNC=off). Which half of this spec runs is decided by the server itself,
// through GET /api/public/config, never by a guess:
//   OFF (today) — the config says off; every connect, busy and OAuth route answers 404 (signed in or not); the list of
//                 connections answers only a member who has one (404 here), and disconnecting still works signed in
//                 (S8 review M5); at 360px, once the page has read the config, Settings has no Calendars card and the
//                 meeting picker (a real conversation between two throwaways, opened with ?schedule=1) has no calendar
//                 line, no striped cell, nothing that says "calendar" but the zone line.
//   ON (after the owner's Google and Microsoft registrations and the switch) — the config names the providers; the
//                 member's connections and busy times answer empty; a start address leads to the provider's consent
//                 screen with PKCE (S256) and our nonce cookie; at 360px the Calendars card and its consent sheet fit
//                 with 44px buttons and say what is read and what never is; the picker offers the optional line, and
//                 hiding it holds across a reload. Completing a real Google or Microsoft consent needs a person (the
//                 owner's five-step test in workspace/assets/Calendar_setup_for_Ali.md).
// Throwaway accounts (@rsn-e2e.invalid), deleted by id at the end (their conversation, request and any calendar row go
// with them).

const RUN = `s8${Date.now().toString(36)}`;
const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const PHONE = { width: 360, height: 780 };
let browser: Browser;
let shirley: TestUser | undefined;
let ben: TestUser | undefined;
let conversationId = '';
let calendarOn = false;
let providers: string[] = [];
const contexts: BrowserContext[] = [];

/** A throwaway on the reserved test domain whose token carries that address. */
async function throwaway(label: string): Promise<TestUser> {
  const u = await createTestUser(`s8${label}`);
  const name = `${RUN} ${label}`;
  const address = `${u.id}@rsn-e2e.invalid`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3 WHERE id = $1`, [u.id, address, name]);
  const sessionId = uuid();
  return {
    ...u, email: address, displayName: name,
    accessToken: jwt.sign({ sub: u.id, email: address, role: 'member', displayName: name, sessionId }, SECRET, { expiresIn: '1h' }),
    refreshToken: jwt.sign({ sub: u.id, sessionId, type: 'refresh' }, SECRET, { expiresIn: '1d' }),
  };
}

async function api(who: TestUser | null, method: string, p: string, body?: unknown, init: RequestInit = {}) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a redirect has no JSON */ }
  return { status: res.status, json, headers: res.headers };
}

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

/** A control is on screen, wholly inside the viewport, and at least 44px tall. */
async function fitsViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible({ timeout: 20_000 });
  const box = await locator.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box, 'the control has a box').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function noSidewaysScroll(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(width + 1);
}

/** Navigate, and wait until the app has read the server's public config: only then does "no calendar UI" mean anything. */
async function gotoAfterConfig(page: Page, url: string) {
  const config = page.waitForResponse((r) => r.url().includes('/api/public/config') && r.ok(), { timeout: 60_000 });
  await gotoRetry(page, url);
  const answer = await (await config).json();
  expect(answer.data.calendar.enabled, 'the page read the config the server sends').toBe(calendarOn);
}

/** The meeting picker of Shirley's conversation with Ben, open. */
async function openPicker(page: Page) {
  await gotoAfterConfig(page, `${APP}/messages/${conversationId}?schedule=1`);
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('slot-grid')).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  const cfg = await api(null, 'GET', '/public/config');
  expect(cfg.status, 'the server answers its public config').toBe(200);
  calendarOn = cfg.json?.data?.calendar?.enabled === true;
  providers = cfg.json?.data?.calendar?.providers ?? [];
  browser = await launchBrowser();
  shirley = await throwaway('Shirley');
  ben = await throwaway('Ben');
  // An accepted request opens their conversation, as on production.
  const asked = await api(ben, 'POST', '/pokes', { recipientId: shirley.id, message: `Hello ${RUN}` });
  expect(asked.status, JSON.stringify(asked.json)).toBe(201);
  expect((await api(shirley, 'POST', `/pokes/${asked.json.data.id}/accept`)).status).toBe(200);
  const conv = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [shirley.id, ben.id]);
  conversationId = conv.rows[0].id;
});

test.afterAll(async () => {
  await teardown(
    ...contexts.map((c) => () => c.close()),
    () => browser?.close(),
    () => cleanup(pool, { ids: idsOf(shirley, ben) }),
  );
});

test(`switched off: the config says so, every calendar route is a 404, and no calendar UI appears at 360px (${engineLabel()})`, async () => {
  test.skip(calendarOn, 'CALENDAR_SYNC is on: the switched-on test below covers it');
  test.setTimeout(180_000);
  const me = shirley!;
  expect((await api(null, 'GET', '/public/config')).json.data).toEqual({ calendar: { enabled: false, providers: [] } });

  const range = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`;
  const routes: Array<[string, string, unknown?]> = [
    ['POST', '/calendar/connect/google', {}],
    ['POST', '/calendar/connect/microsoft', {}],
    ['POST', '/calendar/connections/google/finish', { ticket: 'x' }],
    ['GET', `/calendar/busy?${range}`],
    ['GET', '/calendar/google/start?t=x'],
    ['GET', '/calendar/microsoft/callback?code=x&state=y'],
  ];
  for (const [method, p, body] of routes) {
    for (const who of [me, null]) {
      const res = await api(who, method, p, body);
      expect([method, p, who ? 'signed in' : 'signed out', res.status]).toEqual([method, p, who ? 'signed in' : 'signed out', 404]);
      expect(res.json?.error?.code).toBe('NOT_FOUND');
    }
  }
  // A member can always see and remove what they connected (S8 review M5): the list answers only someone who has a
  // calendar connected (a 404 for this throwaway, who has none), and disconnecting always works when signed in.
  expect((await api(me, 'GET', '/calendar/connections')).status).toBe(404);
  expect((await api(null, 'GET', '/calendar/connections')).status).toBe(401);
  const removed = await api(me, 'DELETE', '/calendar/connections/google');
  expect(removed.status).toBe(200);
  expect(removed.json.data).toEqual({ disconnected: true, revokedAtProvider: false });
  expect((await api(null, 'DELETE', '/calendar/connections/google')).status).toBe(401);

  const page = await signedIn(me, PHONE);
  await gotoAfterConfig(page, `${APP}/settings`);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('calendars-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Calendars' })).toHaveCount(0);
  await expect(page.getByText(/Connect Google Calendar|Outlook \/ Microsoft 365/)).toHaveCount(0);
  await noSidewaysScroll(page);

  await openPicker(page);
  await expect(page.locator('[data-testid^="scheduler-calendar-"]')).toHaveCount(0);
  await expect(page.locator('[data-busy="true"]')).toHaveCount(0);
  await expect(page.getByTestId('meeting-scheduler').getByText(/your calendar|busy/i)).toHaveCount(0);
  await expect(page.getByTestId('calendar-consent-text')).toHaveCount(0);
  await noSidewaysScroll(page);
});

test(`switched on: providers named, empty reads, a PKCE start, and the card, consent and picker line fit at 360px (${engineLabel()})`, async () => {
  test.skip(!calendarOn, 'CALENDAR_SYNC is off on this server (calendar free/busy ships dark)');
  test.setTimeout(240_000);
  const me = shirley!;
  expect(providers.length).toBeGreaterThan(0);
  for (const p of providers) expect(['google', 'microsoft']).toContain(p);

  expect((await api(me, 'GET', '/calendar/connections')).json.data).toEqual([]);
  const from = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const to = new Date(from.getTime() + 8 * 86_400_000);
  const busy = await api(me, 'GET', `/calendar/busy?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&tz=Europe%2FLondon`);
  expect(busy.status).toBe(200);
  expect(busy.json.data).toMatchObject({ connected: [], busy: [], errors: [] });
  expect((await api(null, 'GET', '/calendar/connections')).status).toBe(401);

  // A start address, and the start: our nonce cookie and the provider's consent screen with PKCE.
  for (const p of providers) {
    const begin = await api(me, 'POST', `/calendar/connect/${p}`, { returnTo: '/settings' });
    expect(begin.status, JSON.stringify(begin.json)).toBe(200);
    const startUrl: string = begin.json.data.url;
    expect(startUrl).toMatch(new RegExp(`/api/calendar/${p}/start\\?t=`));
    const start = await fetch(startUrl, { redirect: 'manual' });
    expect(start.status).toBe(302);
    expect(start.headers.get('set-cookie') ?? '').toMatch(/__Host-rsn_cal_nonce=[0-9a-f]{64};.*HttpOnly/i);
    const consent = new URL(start.headers.get('location')!);
    expect(consent.hostname).toBe(p === 'google' ? 'accounts.google.com' : 'login.microsoftonline.com');
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consent.searchParams.get('redirect_uri')).toMatch(new RegExp(`/api/calendar/${p}/callback$`));
    expect(consent.searchParams.get('scope')).toMatch(p === 'google' ? /calendar\.freebusy/ : /Calendars\.ReadBasic/);
  }
  // A forged state lands on Settings saying it failed, with no ticket.
  const forged = await fetch(`${new URL((await api(me, 'POST', `/calendar/connect/${providers[0]}`, {})).json.data.url).origin}/api/calendar/${providers[0]}/callback?code=x&state=forged`, { redirect: 'manual' });
  expect(forged.headers.get('location') ?? '').toMatch(/\/settings\?calendar=failed/);

  const page = await signedIn(me, PHONE);
  await gotoAfterConfig(page, `${APP}/settings`);
  const card = page.getByTestId('calendars-card');
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(card.getByText(/never what your events are/)).toBeVisible();
  const connect = card.getByRole('button', { name: providers[0] === 'google' ? 'Connect Google Calendar' : 'Connect Outlook / Microsoft 365' });
  await card.scrollIntoViewIfNeeded();
  await fitsViewport(page, connect);
  await noSidewaysScroll(page);
  await connect.click();
  const consentText = page.getByTestId('calendar-consent-text');
  await expect(consentText).toBeVisible();
  await expect(consentText).toContainText('never sees what your events are');
  await expect(consentText).toContainText('not the calendar invitation REASON emails you');
  await expect(consentText).toContainText('nor the calendar file you can download from a meeting');
  await expect(consentText).toContainText('REASON keeps your busy times for at most 30 minutes');
  await fitsViewport(page, page.getByTestId('calendar-consent-continue'));
  await fitsViewport(page, page.getByRole('button', { name: 'Not now' }));
  await noSidewaysScroll(page);
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(consentText).toHaveCount(0);

  // The picker: an optional line, never a step; hidden it stays hidden.
  await openPicker(page);
  const hint = page.getByTestId('scheduler-calendar-hint');
  await expect(hint).toBeVisible({ timeout: 20_000 });
  await expect(hint).toContainText('(optional)');
  await fitsViewport(page, hint.getByRole('button', { name: 'Hide this suggestion' }));
  await noSidewaysScroll(page);
  await hint.getByRole('button', { name: 'Hide this suggestion' }).click();
  await expect(hint).toHaveCount(0);
  await openPicker(page);
  await expect(page.getByTestId('scheduler-calendar-hint')).toHaveCount(0);
  // Every time can still be picked without a calendar.
  await expect(page.locator('[data-slot]').first()).toBeEnabled();
});
