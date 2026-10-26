import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// 26 Oct 2026 (POD-01 and POD-03, Stefan and Claus on production, 25 Oct): "Orchestration is of course not timed
// rounds, it's freeform, but that should be automatic when I choose Reason pod", and "Video meeting ... there's no
// timing configuration" — the pod form left Timed Rounds on a Reason pod, and the event form showed 5 rounds of
// 8 minutes for a video meeting.
//
// Production's own create forms now follow the pod type and the event format. This walks them as a person does and
// then reads what was saved: a Reason pod is saved on Freeform without touching Orchestration; a video meeting is
// saved as a meeting with no round settings; speed networking keeps its rounds exactly as before.
//
// Runs on a phone or a desktop: E2E_DEVICE='iPhone 14' E2E_ENGINE=webkit for a phone.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let host: TestUser;
const ctxs: BrowserContext[] = [];
const podIds: string[] = [];
const run = Date.now().toString().slice(-7);

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await browser.newContext(contextOptions({ width: 1100, height: 900 }));
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

/** A pod made by the API, so the event form has somewhere to schedule. */
async function podOfType(podType: string, name: string): Promise<string> {
  const res = await apiAs(host, 'POST', '/pods', { name, podType, visibility: 'private' });
  expect(res.status, `pod created: ${JSON.stringify(res.json)}`).toBe(201);
  const id = res.json.data.id as string;
  podIds.push(id);
  return id;
}

const noSideScroll = async (page: Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
};

test.beforeAll(async () => {
  host = await createTestUser('formshost');
  console.log(`[create-forms-follow-type] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  for (const id of podIds) await cleanup(pool, { ids: [], podId: id });
  await cleanup(pool, { ids: [host.id] });
  await cleanupByPrefix(pool, 'e2etest-formshost');
  await pool.end().catch(() => {});
});

test('choosing a Reason pod sets Freeform, says so when a choice is replaced, and saves the pod that way', async () => {
  test.setTimeout(180_000);
  const page = await openAs(host, '/pods');
  await page.getByRole('button', { name: /Create Pod/i }).first().click();
  await expect(page.getByRole('heading', { name: 'Create a Pod' })).toBeVisible({ timeout: 40_000 });
  const name = `E2E Reason pod ${run}`;
  await page.locator('input[name="name"]').fill(name);

  // A new pod is a speed-networking pod: its one mode is said in a line, and there is no Communication select.
  await expect(page.getByTestId('pod-orchestration')).toContainText('Timed rounds');
  await expect(page.getByText('Communication', { exact: true })).toHaveCount(0);

  // Choosing Reason sets Freeform, offering the two modes the type allows, with nothing to say.
  await page.locator('select[name="podType"]').selectOption('reason');
  const mode = page.getByTestId('pod-orchestration-select');
  await expect(mode).toHaveValue('free_form');
  expect(await mode.locator('option').allTextContents()).toEqual(['Freeform', 'Moderated']);
  await expect(page.getByTestId('pod-orchestration-notice')).toHaveCount(0);

  // A mode chosen by hand is not overwritten in silence: a type that does not allow it replaces it and says so.
  await mode.selectOption('moderated');
  await page.locator('select[name="podType"]').selectOption('speed_networking');
  await expect(page.getByTestId('pod-orchestration-notice')).toHaveText("Changed to Timed rounds: Speed Networking pods don't use moderation.");

  // Back to Reason, and create it. Orchestration was never touched.
  await page.locator('select[name="podType"]').selectOption('reason');
  await expect(page.getByTestId('pod-orchestration-select')).toHaveValue('free_form');
  await noSideScroll(page);
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/pods\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const id = page.url().split('/').pop()!;
  podIds.push(id);

  const row = (await pool.query(`SELECT pod_type, orchestration_mode, communication_mode FROM pods WHERE id = $1`, [id])).rows[0];
  expect(row).toEqual({ pod_type: 'reason', orchestration_mode: 'free_form', communication_mode: 'video' });
  console.log('  ✓ a Reason pod is saved on Freeform, by video, with nothing set by hand');
});

test('a video meeting has no round settings, shows a length, and is saved as a meeting', async () => {
  test.setTimeout(180_000);
  const podName = `E2E Meeting pod ${run}`;
  const podId = await podOfType('reason', podName);
  const page = await openAs(host, `/sessions/new?podId=${podId}`);
  const format = page.getByTestId('event-format-select');
  await expect(format).toBeVisible({ timeout: 40_000 });

  // The pod's type decides: a Reason pod's events are video meetings, and speed networking is the other one it holds.
  await expect(format).toHaveValue('video_meeting', { timeout: 20_000 });
  expect(await format.locator('option').allTextContents()).toEqual(['Video meeting', 'Speed networking']);
  await expect(page.getByTestId('event-format-summary')).toHaveText('Everyone together in one video room until the host ends it');

  // No round settings, a length instead, the meeting's own capacity, and a title that starts as the format and the pod.
  await expect(page.getByText('Number of Rounds')).toHaveCount(0);
  await expect(page.getByText('Timing Configuration')).toHaveCount(0);
  await expect(page.getByTestId('meeting-length')).toHaveValue('60');
  await expect(page.locator('input[name="maxParticipants"]')).toHaveValue('25');
  await expect(page.locator('input[name="title"]')).toHaveValue(`Video meeting · ${podName}`);
  await noSideScroll(page);

  // The Scheduled At field still names the viewer's time zone.
  await expect(page.getByText(/Shown in your local time/)).toBeVisible();

  // A capacity the format does not allow is said at the field, in words, not silently stopped.
  await page.locator('input[name="maxParticipants"]').fill('500');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText('Capacity must be between 2 and 100 people.')).toBeVisible();
  await page.locator('input[name="maxParticipants"]').fill('20');
  await page.getByTestId('meeting-length').selectOption('90');

  const posted: { json?: { format?: string; config?: Record<string, unknown> } } = {};
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/sessions$/.test(r.url())) posted.json = r.postDataJSON(); });
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const sessionId = page.url().split('/').pop()!;

  // The format travels at the top of the body, with the meeting's settings and none of the rounds'.
  expect(posted.json?.format).toBe('video_meeting');
  expect(posted.json?.config).toEqual({ eventType: 'video_meeting', durationMinutes: 90, maxParticipants: 20 });
  const row = (await pool.query(`SELECT event_format, config FROM sessions WHERE id = $1`, [sessionId])).rows[0];
  expect(row.event_format).toBe('video_meeting');
  expect(row.config).toMatchObject({ eventType: 'video_meeting', durationMinutes: 90, maxParticipants: 20 });
  expect(row.config.numberOfRounds, 'a meeting has no rounds').toBeUndefined();
  console.log('  ✓ a video meeting is saved as a meeting, with its length and capacity and no round settings');
});

test('speed networking keeps its rounds exactly as before, with the format sent as well', async () => {
  test.setTimeout(180_000);
  const podName = `E2E Speed pod ${run}`;
  const podId = await podOfType('speed_networking', podName);
  const page = await openAs(host, `/sessions/new?podId=${podId}`);
  const format = page.getByTestId('event-format-select');
  await expect(format).toHaveValue('speed_networking', { timeout: 40_000 });
  expect(await format.locator('option').allTextContents()).toEqual(['Speed networking', 'Video meeting']);
  await expect(page.getByTestId('event-format-summary')).toHaveText('Timed one-to-one rounds with automatic matching');

  // The rounds card, with the values it has always started with.
  await expect(page.getByText('Timing Configuration')).toBeVisible();
  await expect(page.locator('input[name="numberOfRounds"]')).toHaveValue('5');
  await expect(page.locator('input[name="roundDurationSeconds"]')).toHaveValue('480');
  await expect(page.locator('input[name="maxParticipants"]')).toHaveValue('500');
  await expect(page.locator('input[name="title"]')).toHaveValue(`Speed networking · ${podName}`);
  await expect(page.getByTestId('meeting-length')).toHaveCount(0);

  // An out-of-range value is said at its field.
  await page.locator('input[name="numberOfRounds"]').fill('25');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText('Number of rounds must be between 1 and 20.')).toBeVisible();
  await page.locator('input[name="numberOfRounds"]').fill('3');

  const posted: { json?: { format?: string; config?: Record<string, unknown> } } = {};
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/sessions$/.test(r.url())) posted.json = r.postDataJSON(); });
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const sessionId = page.url().split('/').pop()!;

  expect(posted.json?.format).toBe('speed_networking');
  expect(posted.json?.config).toMatchObject({
    eventType: 'speed_networking', numberOfRounds: 3, roundDurationSeconds: 480, maxParticipants: 500,
    timerVisibility: 'always_visible', matchingPolicy: 'within_event',
  });
  const row = (await pool.query(`SELECT event_format, config FROM sessions WHERE id = $1`, [sessionId])).rows[0];
  expect(row.event_format).toBe('speed_networking');
  expect(row.config).toMatchObject({ numberOfRounds: 3, roundDurationSeconds: 480, maxParticipants: 500 });
  console.log('  ✓ speed networking is saved with its rounds, as it always was');
});

test('a Chat pod holds video meetings only, so the format is said and not offered', async () => {
  test.setTimeout(120_000);
  const podId = await podOfType('chat', `E2E Chat pod ${run}`);
  const page = await openAs(host, `/sessions/new?podId=${podId}`);
  await expect(page.getByTestId('event-format-fixed')).toHaveText('Video meeting', { timeout: 40_000 });
  await expect(page.getByTestId('event-format-select')).toHaveCount(0);
  await expect(page.getByText('Number of Rounds')).toHaveCount(0);
  await noSideScroll(page);
});
