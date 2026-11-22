import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../helpers/auth';
import { APP, SERVER, cleanup, idsOf, teardown } from '../helpers/live-ui';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// THE ORGANISER'S SETTINGS ON THE EVENT PAGE (Part 2, Task 11, 10 Nov 2026 spec: 03, 04, 05, 07, 11). Preview smoke.
//
// A throwaway host schedules a draft with "Save as draft" and sees "Draft"; publishes ("Registration open"). Eight
// throwaway pod members register (one "member", five future founders, two future funders). The host reads the RSN
// Call link (Copy link; the address carries the server's code). Admission: "Invitation only", then three pasted
// addresses with one repeat ("2 added, 1 already listed"), then 3 codes, and the once-only sentence with the 3 codes.
// Groups: "Founders and funders", rounds 1 to 3 "Only different groups meet", saved; the organiser places the seven
// people (5 founders, 2 funders) and the card's notice reads "In each round at most 2 founder and funder meetings are
// possible, so 3 founders wait..." without a reload. Cancel with a reason: the member's notifications page shows
// "<title> was cancelled" without a reload. History lists the publish, admission and cancel rows with the host's name.
// At 360px every organiser card fits the viewport (boundingBox) and the page has no horizontal scroll.
//
// Throwaway accounts only (@rsn-e2e.invalid), the spec's own pod and event, deleted by id at the end.

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const SHOTS = process.env.E2E_SHOTS_DIR;
const RUN = Date.now().toString(36);
const TITLE = `P2T11 settings ${RUN}`;

interface Person { id: string; email: string; token: string; refresh: string; name: string }

async function makePerson(label: string): Promise<Person> {
  const id = uuid();
  const email = `p2t11-${label}-${RUN}@rsn-e2e.invalid`;
  const name = `P2T11 ${label}`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, $3, $4, 'Test', 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Lisbon, Portugal')`,
    [id, email, name, label],
  );
  const sessionId = uuid();
  const token = jwt.sign({ sub: id, email, role: 'member', displayName: name, sessionId }, SECRET, { expiresIn: '1h' });
  const refresh = jwt.sign({ sub: id, sessionId, type: 'refresh' }, SECRET, { expiresIn: '1d' });
  return { id, email, token, refresh, name };
}

async function api(who: Person, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function signedIn(browser: Browser, who: Person, viewport = { width: 1280, height: 900 }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(contextOptions(viewport));
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
  await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-p2t11-${name}.png`), fullPage: false });
}

/** No horizontal scroll, and each of these cards lies within the viewport's width. */
async function cardsFit(page: Page, testIds: string[], label: string): Promise<void> {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll, `${label}: horizontal scroll`).toBeLessThanOrEqual(inner);
  for (const id of testIds) {
    const card = page.getByTestId(id);
    if ((await card.count()) === 0) continue;
    await card.first().scrollIntoViewIfNeeded();
    const box = await card.first().boundingBox();
    expect(box, `${label}: ${id} has a box`).not.toBeNull();
    expect(box!.x, `${label}: ${id} starts inside`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${label}: ${id} ends inside`).toBeLessThanOrEqual(inner + 0.5);
    const small = await card.first().locator('button:visible').evaluateAll((els) =>
      els.map((el) => ({ text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30), h: el.getBoundingClientRect().height }))
        .filter((e) => e.h > 0 && e.h < 44));
    expect(small, `${label}: ${id} buttons under 44px`).toEqual([]);
  }
}

let host: Person | undefined;
let member: Person | undefined;
const founders: Person[] = [];
const funders: Person[] = [];
let podId = '';
let eventId = '';

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  host = await makePerson('host');
  member = await makePerson('member');
  for (let i = 0; i < 5; i++) founders.push(await makePerson(`founder${i}`));
  for (let i = 0; i < 2; i++) funders.push(await makePerson(`funder${i}`));
  // A private, ACTIVE speed-networking pod the host directs (production schedules only in an active pod, and only
  // its directors and hosts may), with the others as active members, who may register for its published events.
  podId = uuid();
  await pool.query(`INSERT INTO pods (id, name, created_by, visibility, status, pod_type) VALUES ($1, $2, $3, 'private', 'active', 'speed_networking')`,
    [podId, `P2T11 pod ${RUN}`, host.id]);
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [podId, host.id]);
  for (const p of [member, ...founders, ...funders]) {
    await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`, [podId, p.id]);
  }
});

test.afterAll(async () => {
  const ids = idsOf(host, member, ...founders, ...funders);
  await teardown(
    () => (eventId ? pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [ids]) : Promise.resolve()),
    () => cleanup(pool, { ids, podId }),
  );
});

test('a host drafts, publishes, shares the call link, sets admission and groups, cancels with notice, and reads the history', async () => {
  test.setTimeout(300_000);
  const browser = await launchBrowser();
  try {
    const h = await signedIn(browser, host!);
    if (!process.env.E2E_DEVICE && process.env.E2E_ENGINE !== 'webkit') {
      await h.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
    }

    // ── Draft, then publish ────────────────────────────────────────────────────────────────────────────────────────
    await h.page.goto(`${APP}/sessions/new?podId=${podId}`);
    await expect(h.page.getByTestId('event-access-field')).toBeVisible({ timeout: 30_000 });
    await h.page.getByLabel('Title').fill(TITLE);
    await h.page.getByTestId('save-as-draft').click();
    await h.page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    eventId = h.page.url().match(/sessions\/([0-9a-f-]{36})/)![1];
    const drafted = await pool.query(`SELECT publication, config FROM sessions WHERE id = $1`, [eventId]);
    expect(drafted.rows[0].publication).toBe('draft');
    const lifecycle = h.page.getByTestId('event-lifecycle');
    await expect(lifecycle.getByTestId('event-lifecycle-chip')).toHaveText('Draft', { timeout: 30_000 });
    // A draft takes no invites and has no Go Live.
    await expect(h.page.getByRole('button', { name: 'Invite people' })).toHaveCount(0);
    await expect(h.page.getByRole('button', { name: 'Go Live' })).toHaveCount(0);
    await shot(h.page, 'draft');
    await lifecycle.getByTestId('lifecycle-publish').click();
    await expect(lifecycle.getByTestId('event-lifecycle-chip')).toHaveText(/Registration open|Published/, { timeout: 15_000 });
    expect((await pool.query(`SELECT publication FROM sessions WHERE id = $1`, [eventId])).rows[0].publication).toBe('published');

    // Everyone registers while the event still admits its pod.
    for (const p of [member!, ...founders, ...funders]) {
      expect((await api(p, 'POST', `/sessions/${eventId}/register`)).status).toBe(201);
    }

    // ── The event link (was the RSN Call link) ───────────────────────────────────────────────────────────────────────
    const linkCard = h.page.getByTestId('call-link-card');
    await expect(linkCard).toContainText('Event link', { timeout: 30_000 });
    const link = await api(host!, 'GET', `/sessions/${eventId}/call-link`);
    expect(link.status).toBe(200);
    const shown: string = link.json.data.eventLink?.slug ?? link.json.data.code;
    await expect(linkCard.getByTestId('call-link-address')).toContainText(shown);
    await linkCard.getByTestId('call-link-copy').click();
    if (!process.env.E2E_DEVICE && process.env.E2E_ENGINE !== 'webkit') {
      await expect(linkCard.getByTestId('call-link-copy')).toContainText('Copied');
      expect(await h.page.evaluate(() => navigator.clipboard.readText())).toContain(shown);
    }

    // ── Admission: Invitation only, three addresses (one repeated), three codes ────────────────────────────────────
    const admission = h.page.getByTestId('event-admission-card');
    await admission.getByTestId('admission-mode-restricted').click();
    await admission.getByTestId('admission-save').click();
    await expect(admission.getByTestId('admission-emails')).toBeVisible({ timeout: 15_000 });
    expect((await pool.query(`SELECT admission_mode FROM sessions WHERE id = $1`, [eventId])).rows[0].admission_mode).toBe('restricted');
    await expect(admission.getByTestId('admission-emails-empty')).toHaveText('No allowed emails yet. Paste addresses or import a CSV.');
    const a = `p2t11-listed-a-${RUN}@rsn-e2e.invalid`;
    const b = `p2t11-listed-b-${RUN}@rsn-e2e.invalid`;
    await admission.getByTestId('admission-paste').fill(`${a},\n${b}\n${a.toUpperCase()}`);
    await admission.getByTestId('admission-paste-add').click();
    await expect(admission.getByTestId('admission-emails-outcome')).toHaveText('2 added, 1 already listed.', { timeout: 15_000 });
    await expect(admission.getByTestId('admission-email-row')).toHaveCount(2);
    await admission.getByTestId('admission-code-count').fill('3');
    await admission.getByTestId('admission-code-generate').click();
    await expect(admission.getByTestId('admission-codes-once')).toHaveText('These codes are shown only now. Download or copy them before you leave.', { timeout: 15_000 });
    await expect(admission.getByTestId('admission-code-plain')).toHaveCount(3);
    await expect(admission.getByText('Download CSV')).toBeVisible();
    await expect(admission.getByText('Copy all')).toBeVisible();
    await expect(admission.getByTestId('admission-code-row')).toHaveCount(3);
    await shot(h.page, 'admission');

    // ── Groups: Founders and funders, rounds 1 to 3 across groups ──────────────────────────────────────────────────
    const groupsCard = h.page.getByTestId('event-groups-card');
    await expect(groupsCard.getByTestId('groups-empty')).toBeVisible({ timeout: 15_000 });
    await groupsCard.getByTestId('groups-edit').click();
    const sheet = h.page.getByRole('dialog', { name: 'Matching groups' });
    await sheet.getByTestId('group-preset-founders_funders').click();
    const rule = sheet.getByTestId('round-rule').first();
    await rule.getByTestId('round-rule-from').selectOption('1');
    await rule.getByTestId('round-rule-to').selectOption('3');
    await rule.getByTestId('round-rule-mode').selectOption('cross_group');
    await sheet.getByTestId('groups-save').click();
    await expect(sheet).toHaveCount(0, { timeout: 15_000 });
    await expect(groupsCard.getByTestId('group-summary')).toHaveCount(2);
    // The organiser places the seven people (over Task 5's route); the card follows without a reload.
    for (const p of founders) expect((await api(host!, 'PUT', `/sessions/${eventId}/participants/${p.id}/groups`, { groupKeys: ['founder'] })).status).toBe(200);
    for (const p of funders) expect((await api(host!, 'PUT', `/sessions/${eventId}/participants/${p.id}/groups`, { groupKeys: ['funder'] })).status).toBe(200);
    await expect(groupsCard.getByTestId('capacity-notice')).toContainText(
      'In each round at most 2 founder and funder meetings are possible, so 3 founders wait', { timeout: 20_000 });
    await expect(groupsCard.getByTestId('capacity-notice')).toContainText('Rounds 1 to 3');
    // The participant list carries each person's group.
    await expect(h.page.getByTestId('participant-group-chip').filter({ hasText: 'Founders' })).toHaveCount(5, { timeout: 15_000 });
    await shot(h.page, 'groups');

    // ── 360px: every organiser card fits ───────────────────────────────────────────────────────────────────────────
    if (!process.env.E2E_DEVICE) {
      const narrow = await signedIn(browser, host!, { width: 360, height: 780 });
      await narrow.page.goto(`${APP}/sessions/${eventId}`);
      await expect(narrow.page.getByTestId('event-lifecycle')).toBeVisible({ timeout: 30_000 });
      await expect(narrow.page.getByTestId('event-groups-card').getByTestId('capacity-notice')).toBeVisible({ timeout: 20_000 });
      await cardsFit(narrow.page, ['event-lifecycle', 'call-link-card', 'event-admission-card', 'event-groups-card', 'event-history'], '360px');
      await shot(narrow.page, '360');
      await narrow.ctx.close();
    } else {
      await cardsFit(h.page, ['event-lifecycle', 'call-link-card', 'event-admission-card', 'event-groups-card', 'event-history'], engineLabel());
    }

    // ── Cancel with a reason; the member hears without a reload ────────────────────────────────────────────────────
    const m = await signedIn(browser, member!);
    await m.page.goto(`${APP}/notifications`);
    await m.page.waitForLoadState('domcontentloaded');
    await lifecycle.getByTestId('lifecycle-cancel').click();
    const cancelSheet = h.page.getByRole('dialog', { name: 'Cancel this event?' });
    await expect(cancelSheet).toContainText('Everyone registered gets an email and a notification.');
    await cancelSheet.getByLabel('Reason (they will see it)').fill('The venue closed.');
    await cancelSheet.getByTestId('lifecycle-cancel-confirm').click();
    await expect(cancelSheet).toHaveCount(0, { timeout: 15_000 });
    await expect(lifecycle.getByTestId('event-lifecycle-chip')).toHaveText('Cancelled', { timeout: 15_000 });
    await expect(lifecycle).toContainText('The venue closed.');
    await expect(m.page.getByText(`${TITLE} was cancelled`)).toBeVisible({ timeout: 30_000 });
    const db = await pool.query(`SELECT status, cancel_reason, cancelled_by FROM sessions WHERE id = $1`, [eventId]);
    expect(db.rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'The venue closed.', cancelled_by: host!.id });
    // A cancelled event offers Archive (and no admission or groups cards: they change only before the event).
    await expect(lifecycle.getByTestId('lifecycle-archive')).toBeVisible();
    await expect(h.page.getByTestId('event-admission-card')).toHaveCount(0);

    // ── History: publish, admission and cancel rows, with the host's name ──────────────────────────────────────────
    const history = h.page.getByTestId('event-history');
    await expect(history.getByText(`${host!.name} published the event`)).toBeVisible({ timeout: 20_000 });
    await expect(history.getByText(`${host!.name} changed who gets a place`)).toBeVisible();
    await expect(history.getByText(`${host!.name} added allowed emails`)).toBeVisible();
    await expect(history.getByText(`${host!.name} made admission codes`)).toBeVisible();
    await expect(history.getByText(`${host!.name} cancelled the event`)).toBeVisible();
    await shot(h.page, 'cancelled-history');

    await m.ctx.close();
    await h.ctx.close();
  } finally {
    await browser.close();
  }
});
