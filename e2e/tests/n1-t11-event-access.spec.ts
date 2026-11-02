import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../helpers/auth';
import { APP, SERVER, cleanup, idsOf } from '../helpers/live-ui';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// WHO CAN JOIN AN EVENT (30 Oct programme, T11; L17).
//
// The host schedules a "Public with approval" event on the form. A stranger opens it and presses Request to join;
// the host's Requests card shows the request without a reload. The host approves; the stranger's page changes to
// registered without a reload, and the approval bell is there. A "Private" event is absent from the stranger's
// Events list and answers the private notice by its address. A "Public" event registers on Register (opening it
// does not register a stranger). Then the form field, the request sheet and the Requests card at seven widths:
// no horizontal scroll and every control at least 44px tall.
//
// Throwaway accounts only (@rsn-e2e.invalid), the spec's own pod, deleted by id at the end.

const SECRET = process.env.E2E_JWT_SECRET || process.env.JWT_SECRET;
const SHOTS = process.env.E2E_SHOTS_DIR;
const WIDTHS = [360, 390, 414, 768, 1024, 1280, 1440];

interface Person { id: string; email: string; token: string; refresh: string; name: string }

async function makePerson(label: string): Promise<Person> {
  const id = uuid();
  const email = `n1t11-${label}-${Date.now()}@rsn-e2e.invalid`;
  const name = `T11 ${label}`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, $3, $4, 'Test', 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Lisbon, Portugal')`,
    [id, email, name, label],
  );
  const sessionId = uuid();
  const token = jwt.sign({ sub: id, email, role: 'member', displayName: name, sessionId }, SECRET!, { expiresIn: '1h' });
  const refresh = jwt.sign({ sub: id, sessionId, type: 'refresh' }, SECRET!, { expiresIn: '1d' });
  return { id, email, token, refresh, name };
}

async function api(who: Person, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function signedIn(browser: Browser, who: Person): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(contextOptions({ width: 1280, height: 900 }));
  await ctx.addInitScript((t) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: who.token, r: who.refresh });
  return { ctx, page: await ctx.newPage() };
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-${name}.png`), fullPage: false });
}

/** No horizontal scroll, and every visible button, radio card and link in `scope` at least 44px tall. */
async function fits(page: Page, scope: string, label: string): Promise<void> {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll, `${label}: horizontal scroll`).toBeLessThanOrEqual(inner);
  const small = await page.locator(scope).locator('button:visible, label[data-testid^="event-access-"]:visible').evaluateAll((els) =>
    els.map((el) => ({ text: (el.textContent || '').trim().slice(0, 30), h: el.getBoundingClientRect().height })).filter((e) => e.h > 0 && e.h < 44));
  expect(small, `${label}: controls under 44px`).toEqual([]);
}

let host: Person;
let stranger: Person;
let podId = '';
const extraPods: string[] = [];

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  host = await makePerson('host');
  stranger = await makePerson('stranger');
  podId = uuid();
  await pool.query(`INSERT INTO pods (id, name, created_by, visibility, status, pod_type) VALUES ($1, $2, $3, 'private', 'active', 'speed_networking')`,
    [podId, `T11 pod ${Date.now()}`, host.id]);
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, host.id]);
});

test.afterAll(async () => {
  const ids = idsOf(host, stranger);
  // The spec's own event requests go with its events (CASCADE) when the pod goes.
  for (const extra of extraPods) await cleanup(pool, { ids: [], podId: extra });
  await cleanup(pool, { ids, podId });
  if (ids.length) await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [ids]).catch(() => {});
});

test('a stranger requests, the host approves live, private is hidden, public registers on Register', async () => {
  test.setTimeout(240_000);
  const browser = await launchBrowser();
  try {
    const h = await signedIn(browser, host);
    const s = await signedIn(browser, stranger);

    // The host schedules a "Public with approval" event on the form, which starts from the pod (Private).
    await h.page.goto(`${APP}/sessions/new?podId=${podId}`);
    const field = h.page.getByTestId('event-access-field');
    await expect(field).toBeVisible({ timeout: 30_000 });
    await expect(field.getByRole('radio', { name: /Private/ })).toBeChecked();
    await expect(field).toContainText('This choice is for this event only.');
    await field.getByTestId('event-access-public_with_approval').click();
    await h.page.getByLabel('Title').fill(`Approval event ${Date.now()}`);
    await h.page.getByRole('button', { name: 'Schedule Event' }).click();
    await h.page.waitForURL(/\/sessions\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const approvalId = h.page.url().match(/sessions\/([0-9a-f-]{36})/)![1];
    const created = await pool.query(`SELECT visibility FROM sessions WHERE id = $1`, [approvalId]);
    expect(created.rows[0].visibility).toBe('public_with_approval');
    await h.page.goto(`${APP}/sessions/${approvalId}`);
    const card = h.page.getByTestId('event-requests-card');
    await expect(card).toContainText('No one is waiting for a place.', { timeout: 30_000 });

    // The stranger opens it: not registered by opening, and Request to join is offered.
    await s.page.goto(`${APP}/sessions/${approvalId}`);
    await expect(s.page.getByTestId('event-request-open')).toBeVisible({ timeout: 30_000 });
    const mine = await pool.query(`SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2`, [approvalId, stranger.id]);
    expect(mine.rows.length).toBe(0);
    await s.page.getByTestId('event-request-open').click();
    await s.page.getByTestId('event-request-message').fill('Hello, I would like to come.');
    await shot(s.page, 'request-sheet');
    await s.page.getByTestId('event-request-send').click();
    await expect(s.page.getByTestId('event-request-sent')).toBeVisible({ timeout: 15_000 });

    // The host's card shows the request without a reload.
    await expect(card.getByTestId('event-request-row')).toHaveCount(1, { timeout: 15_000 });
    await expect(card).toContainText('Hello, I would like to come.');
    await expect(card).toContainText('Requests (1)');
    await shot(h.page, 'requests-card');
    const bell = await pool.query(`SELECT link FROM notifications WHERE user_id = $1 AND type = 'join_request'`, [host.id]);
    expect(bell.rows.map((r) => r.link)).toContain(`/sessions/${approvalId}?requests=1`);

    // The host approves; the stranger's page changes to registered without a reload, and the approval bell is there.
    await card.getByTestId('event-request-approve').click();
    await expect(card).toContainText('No one is waiting for a place.', { timeout: 15_000 });
    await expect(s.page.getByText('Registered', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(s.page.getByTestId('event-request-sent')).toHaveCount(0);
    const approval = await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'approval'`, [stranger.id]);
    expect(approval.rows.length).toBe(1);
    const member = await pool.query(`SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2`, [podId, stranger.id]);
    expect(member.rows.length).toBe(0);

    // A private event is not in the stranger's Events list, and its address answers the private notice.
    const priv = await api(host, 'POST', '/sessions', {
      podId, title: `Private event ${Date.now()}`, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      format: 'speed_networking', visibility: 'private',
    });
    expect(priv.status).toBe(201);
    await s.page.goto(`${APP}/sessions`);
    await expect(s.page.getByText('Approval event', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(s.page.getByText(priv.json.data.title)).toHaveCount(0);
    await s.page.goto(`${APP}/sessions/${priv.json.data.id}`);
    await expect(s.page.getByTestId('event-private-title')).toHaveText('This event is private', { timeout: 30_000 });
    await expect(s.page.getByTestId('event-private-notice')).toContainText("It is for its pod's members and the people the host invites.");
    await shot(s.page, 'private-notice');

    // A public event: opening it registers nobody; Register does.
    const pub = await api(host, 'POST', '/sessions', {
      podId, title: `Public event ${Date.now()}`, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      format: 'speed_networking', visibility: 'public',
    });
    expect(pub.status).toBe(201);
    await s.page.goto(`${APP}/sessions/${pub.json.data.id}`);
    const register = s.page.getByTestId('event-register');
    await expect(register).toBeVisible({ timeout: 30_000 });
    const before = await pool.query(`SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2`, [pub.json.data.id, stranger.id]);
    expect(before.rows.length).toBe(0);
    await register.click();
    await expect(s.page.getByText('Registered', { exact: true })).toBeVisible({ timeout: 20_000 });

    // A NULL event (production's form) in a public pod: opening it registers nobody outside the pod; Register does.
    const publicPod = uuid();
    await pool.query(`INSERT INTO pods (id, name, created_by, visibility, status, pod_type) VALUES ($1, $2, $3, 'public', 'active', 'speed_networking')`,
      [publicPod, `T11 public pod ${Date.now()}`, host.id]);
    await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [publicPod, host.id]);
    extraPods.push(publicPod);
    const legacy = await api(host, 'POST', '/sessions', {
      podId: publicPod, title: `Old form event ${Date.now()}`, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      format: 'speed_networking', config: { numberOfRounds: 3, roundDurationSeconds: 300, maxParticipants: 20 },
    });
    expect(legacy.status).toBe(201);
    expect(legacy.json.data.visibility).toBeNull();
    await s.page.goto(`${APP}/sessions/${legacy.json.data.id}`);
    await expect(s.page.getByTestId('event-register')).toBeVisible({ timeout: 30_000 });
    await s.page.waitForTimeout(1500);
    const notYet = await pool.query(`SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2`, [legacy.json.data.id, stranger.id]);
    expect(notYet.rows.length).toBe(0);
    await s.page.getByTestId('event-register').click();
    await expect(s.page.getByText('Registered', { exact: true })).toBeVisible({ timeout: 20_000 });

    // Seven widths: the form field, the request sheet and the Requests card.
    const third = await makePerson('widths');
    try {
      const w = await signedIn(browser, third);
      await w.page.goto(`${APP}/sessions/${approvalId}`);
      await expect(w.page.getByTestId('event-request-open')).toBeVisible({ timeout: 30_000 });
      await w.page.getByTestId('event-request-open').click();
      await w.page.getByTestId('event-request-send').click();
      await expect(w.page.getByTestId('event-request-sent')).toBeVisible({ timeout: 15_000 });
      await w.ctx.close();
      // Each page is opened once and looked at through every width (fix wave 2, 2 Nov 2026): reloading it per width was
      // about 14 full page loads by one member in under a minute, past production's 240 requests a minute (preview rr11).
      const widths = process.env.E2E_DEVICE ? [0] : WIDTHS;
      await h.page.goto(`${APP}/sessions/new?podId=${podId}`);
      await expect(h.page.getByTestId('event-access-field')).toBeVisible({ timeout: 30_000 });
      for (const width of widths) {
        if (width) await h.page.setViewportSize({ width, height: 900 });
        await expect(h.page.getByTestId('event-access-field')).toBeVisible({ timeout: 30_000 });
        await h.page.getByTestId('event-access-field').evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await fits(h.page, '[data-testid="event-access-field"]', `form ${width}`);
        await shot(h.page, `form-${width}`);
      }
      await h.page.goto(`${APP}/sessions/${approvalId}`);
      for (const width of widths) {
        if (width) await h.page.setViewportSize({ width, height: 900 });
        await expect(h.page.getByTestId('event-request-row')).toHaveCount(1, { timeout: 30_000 });
        await h.page.getByTestId('event-requests-card').evaluate((el) => el.scrollIntoView({ block: 'center' }));
        await h.page.waitForTimeout(700);
        await fits(h.page, '[data-testid="event-requests-card"]', `requests ${width}`);
        await shot(h.page, `requests-${width}`);
      }
      // The sheet at each width, on a fresh approval event for the stranger: opened, measured and closed at each width.
      const another = await api(host, 'POST', '/sessions', {
        podId, title: `Sheet event ${Date.now()}`, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        format: 'speed_networking', visibility: 'public_with_approval',
      });
      await s.page.goto(`${APP}/sessions/${another.json.data.id}`);
      for (const width of widths) {
        if (width) await s.page.setViewportSize({ width, height: 900 });
        await s.page.getByTestId('event-request-open').click();
        await expect(s.page.getByTestId('event-request-send')).toBeVisible();
        await fits(s.page, '[role="dialog"]', `sheet ${width}`);
        await shot(s.page, `sheet-${width}`);
        await s.page.keyboard.press('Escape');
        await expect(s.page.getByTestId('event-request-send')).toHaveCount(0);
      }
    } finally {
      await pool.query(`DELETE FROM audit_log WHERE actor_id = $1`, [third.id]).catch(() => {});
      await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [third.id]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = $1`, [third.id]).catch(() => {});
    }
    await h.ctx.close();
    await s.ctx.close();
  } finally {
    await browser.close();
  }
});
