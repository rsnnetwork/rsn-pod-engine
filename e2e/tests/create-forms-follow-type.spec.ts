import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, idsOf, teardown, APP, SERVER } from '../helpers/live-ui';
import { addPodMember } from '../helpers/api';
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
let admin: TestUser;
const ctxs: BrowserContext[] = [];
/** Accounts a test makes for itself (the two above are made once, for all of them). */
const madeInTests: TestUser[] = [];
const run = Date.now().toString().slice(-7);

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string, opts: { countCommits?: boolean; delayPodsMs?: number; watchRoundsCard?: boolean; dropFromPodList?: string } = {}): Promise<Page> {
  const ctx = await browser.newContext(contextOptions({ width: 1100, height: 900 }));
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  if (opts.countCommits) {
    // React reports every commit to the DevTools hook if one is on the page. A stand-in that only counts them tells
    // whether a page ever settles, which no look at the markup can (a render loop keeps the page "working").
    await ctx.addInitScript(() => {
      let commits = 0;
      const w = window as unknown as { __commits: () => number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
      w.__commits = () => commits;
      w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true, isDisabled: false, renderers: new Map(),
        inject: () => 1, checkDCE: () => undefined, setStrictMode: () => undefined,
        onCommitFiberRoot: () => { commits += 1; }, onCommitFiberUnmount: () => undefined, onPostCommitFiberRoot: () => undefined,
      };
    });
  }
  if (opts.watchRoundsCard) {
    // Notes if speed networking's settings were EVER drawn, even for one frame: a look at the page afterwards cannot tell.
    await ctx.addInitScript(() => {
      const w = window as unknown as { __roundsDrawn: boolean };
      w.__roundsDrawn = false;
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of Array.from(r.addedNodes)) {
            if (n instanceof Element && (n.matches('[data-testid="timing-card"]') || n.querySelector('[data-testid="timing-card"]'))) w.__roundsDrawn = true;
          }
        }
      }).observe(document, { childList: true, subtree: true });
    });
  }
  if (opts.delayPodsMs) {
    // The list of pods arrives late, as it can on a slow phone: the pod named in the address is not known yet.
    await ctx.route(/\/api\/pods\?status=active/, async (route) => {
      await new Promise((r) => setTimeout(r, opts.delayPodsMs));
      await route.continue();
    });
  }
  if (opts.dropFromPodList) {
    // What a pod older than the newest twenty looks like to the form: the list it asks for (the server's first page, newest
    // first) does not hold it, while the pod itself can still be read by id. The real answer, less that one pod.
    await ctx.route(/\/api\/pods\?status=active/, async (route) => {
      const real = await route.fetch();
      const body = await real.json();
      const data = (body.data ?? []).filter((p: { id: string }) => p.id !== opts.dropFromPodList);
      await route.fulfill({ status: real.status(), contentType: 'application/json', body: JSON.stringify({ ...body, data }) });
    });
  }
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

/** How many times React has committed on this page so far (needs openAs with countCommits). */
const commitsSoFar = (page: Page) => page.evaluate(() => (window as unknown as { __commits: () => number }).__commits());

/** A pod made by the API, so the event form has somewhere to schedule. */
async function podOfType(podType: string, name: string, as: TestUser = host): Promise<string> {
  const res = await apiAs(as, 'POST', '/pods', { name, podType, visibility: 'private' });
  expect(res.status, `pod created: ${JSON.stringify(res.json)}`).toBe(201);
  return res.json.data.id as string;
}

const noSideScroll = async (page: Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
};

test.beforeAll(async () => {
  host = await createTestUser('formshost');
  admin = await createTestUser('formsadmin', 'admin');
  console.log(`[create-forms-follow-type] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  // An account whose creation failed is undefined here and has nothing to delete; each step runs even if another fails.
  const ids = idsOf(host, admin, ...madeInTests);
  await teardown(
    // Every pod these accounts own, however it was made. A pod a failed test never got to note would stay, and
    // pods.created_by stops its owner being deleted: a live test account left in production.
    async () => {
      const owned = await pool.query<{ id: string }>(`SELECT id FROM pods WHERE created_by = ANY($1)`, [ids]);
      for (const { id } of owned.rows) await cleanup(pool, { ids: [], podId: id });
    },
    () => cleanup(pool, { ids }),
    () => cleanupByPrefix(pool, 'e2etest-forms'),
    () => pool.end().catch(() => {}),
  );
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

test('the event form settles for a pod director who arrives from the pod page, and for an admin: it does not re-render forever', async () => {
  test.setTimeout(180_000);
  // A plain member who directs the pod, arriving the way the pod page's "Schedule Event" sends them (?podId=), and an
  // admin. The member's list of pods is filtered on every render; a form that reacted to that never stopped.
  const memberPod = await podOfType('reason', `E2E Idle pod ${run}`);
  const adminPod = await podOfType('reason', `E2E Idle admin pod ${run}`, admin);
  for (const [who, podId, label] of [[host, memberPod, 'a member'], [admin, adminPod, 'an admin']] as const) {
    const page = await openAs(who, `/sessions/new?podId=${podId}`, { countCommits: true });
    await expect(page.getByTestId('event-format-select')).toHaveValue('video_meeting', { timeout: 40_000 });
    await page.waitForTimeout(1500); // the page has finished loading
    const before = await commitsSoFar(page);
    await page.waitForTimeout(2000);
    const during = (await commitsSoFar(page)) - before;
    expect(during, `${label}: React committed ${during} times in 2 seconds of nothing happening`).toBeLessThan(25);
    // And it is still a form someone can use: the pod named in the address is the one chosen.
    await expect(page.locator('select[name="podId"]')).toHaveValue(podId);
  }
});

test('a refusal from the server is said at the field it is about, in its words, and not in a toast', async () => {
  test.setTimeout(180_000);
  const podId = await podOfType('reason', `E2E Refusal pod ${run}`);
  const page = await openAs(host, `/sessions/new?podId=${podId}`);
  await expect(page.getByTestId('event-format-select')).toHaveValue('video_meeting', { timeout: 40_000 });

  // What the server's own checks answer (400, the setting by name). The page's checks stop a bad value first, so the
  // answer is stood in for here, exactly as the server words it.
  let refusal: Record<string, string[]> = { maxParticipants: ['Capacity must be between 2 and 100 people.'] };
  await page.route(/\/api\/sessions$/, (route) => route.request().method() !== 'POST' ? route.continue() : route.fulfill({
    status: 400, contentType: 'application/json',
    body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: refusal } }),
  }));

  await page.locator('form button[type="submit"]').click();
  const capacity = page.getByTestId('capacity-card');
  await expect(capacity).toContainText('Capacity must be between 2 and 100 people.');
  // Said at the field, so no toast saying "Validation failed" as well; and the form stayed, to be fixed.
  await expect(page.getByText('Validation failed')).toHaveCount(0);
  await expect(page).toHaveURL(/\/sessions\/new/);

  // A format the pod does not hold belongs at the picker.
  refusal = { format: ["Speed networking isn't available in Chat pods."] };
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByTestId('event-format-select').locator('xpath=ancestor::div[1]')).toContainText("Speed networking isn't available in Chat pods.");
  await expect(page.getByText('Validation failed')).toHaveCount(0);

  // A refusal with no field to say it at is the one thing that is a toast.
  refusal = {};
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText('Validation failed')).toBeVisible();
});

test('a note about a capacity that was changed is at Capacity, and goes once the capacity is edited', async () => {
  test.setTimeout(180_000);
  const podId = await podOfType('reason', `E2E Capacity pod ${run}`);
  const page = await openAs(host, `/sessions/new?podId=${podId}`);
  const format = page.getByTestId('event-format-select');
  await expect(format).toHaveValue('video_meeting', { timeout: 40_000 });
  const capacity = page.locator('input[name="maxParticipants"]');

  // 300 is fine for speed networking and not for a meeting: switching back replaces it, and says so at Capacity.
  await format.selectOption('speed_networking');
  await capacity.fill('300');
  await format.selectOption('video_meeting');
  await expect(capacity).toHaveValue('25');
  await expect(page.getByTestId('capacity-card').getByTestId('capacity-notice')).toContainText('Capacity changed to 25 people');
  // It is not at Event Type, where the format's own notes go.
  await expect(page.getByTestId('event-format-notice')).toHaveCount(0);

  // The member edits the capacity: the note has done its job.
  await capacity.fill('30');
  await expect(page.getByTestId('capacity-notice')).toHaveCount(0);
  await expect(capacity).toHaveValue('30');
});

test('while the pod named in the address is being found, a placeholder is held, and speed networking\'s settings are never drawn', async () => {
  test.setTimeout(180_000);
  const podId = await podOfType('reason', `E2E Pending pod ${run}`);
  const page = await openAs(host, `/sessions/new?podId=${podId}`, { delayPodsMs: 2500, watchRoundsCard: true });

  // The list of pods is on its way: the form holds a place for the format's settings, and says what it waits for.
  await expect(page.getByTestId('format-pending')).toBeVisible();
  await expect(page.getByTestId('settings-pending')).toBeVisible();
  await expect(page.getByText('Number of Rounds')).toHaveCount(0);
  await expect(page.getByTestId('capacity-card')).toHaveCount(0);

  // Then the meeting's own settings, in place of the placeholder.
  await expect(page.getByTestId('meeting-card')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('event-format-select')).toHaveValue('video_meeting');
  await expect(page.locator('input[name="maxParticipants"]')).toHaveValue('25');
  await expect(page.locator('input[name="title"]')).toHaveValue(/^Video meeting · E2E Pending pod /);
  await expect(page.getByTestId('format-pending')).toHaveCount(0);
  // And speed networking's settings were not drawn at any moment on the way, which no look afterwards can show.
  expect(await page.evaluate(() => (window as unknown as { __roundsDrawn: boolean }).__roundsDrawn), 'the rounds card was drawn, then swapped away').toBe(false);
});

test('a duplicate of a Chat pod made a Reason pod is by video, not text carried over from a control that is gone', async () => {
  test.setTimeout(180_000);
  const source = await podOfType('chat', `E2E Duplicate source ${run}`);
  const page = await openAs(host, `/pods/${source}`);
  await page.getByRole('button', { name: /Duplicate/i }).first().click();
  await expect(page.getByRole('heading', { name: 'Duplicate Pod' })).toBeVisible({ timeout: 40_000 });

  // The copy starts as the source was: a Chat pod, on Freeform.
  await expect(page.locator('select[name="podType"]')).toHaveValue('chat');
  await page.locator('select[name="podType"]').selectOption('reason');
  await expect(page.getByTestId('pod-orchestration-select')).toHaveValue('free_form');

  const posted: { json?: Record<string, unknown> } = {};
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/pods$/.test(r.url())) posted.json = r.postDataJSON(); });
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByText('Pod duplicated!')).toBeVisible({ timeout: 30_000 });
  expect(posted.json).toMatchObject({ podType: 'reason', orchestrationMode: 'free_form', communicationMode: 'video' });
  const copy = (await pool.query(`SELECT pod_type, communication_mode FROM pods WHERE created_by = $1 AND name LIKE '%(copy)'`, [host.id])).rows[0];
  expect(copy).toEqual({ pod_type: 'reason', communication_mode: 'video' });
});

for (const who of ['a director', 'an admin'] as const) {
  test(`a pod older than the newest twenty can still be scheduled when the address names it: ${who} is offered it, preselected, and can submit`, async () => {
    test.setTimeout(180_000);
    // The pod is the host's own, so the host is its director; the admin is not a member of it at all.
    const podName = `E2E Older pod ${who === 'a director' ? 'dir' : 'adm'} ${run}`;
    const podId = await podOfType('reason', podName, host);
    const page = await openAs(who === 'a director' ? host : admin, `/sessions/new?podId=${podId}`, { dropFromPodList: podId });

    // The list the form asked for does not hold the pod (what the newest twenty do to an older one), and it is the
    // chosen one all the same: before this, the select stayed on "Select a pod" and the required check stopped the submit.
    const select = page.locator('select[name="podId"]');
    await expect(select).toHaveValue(podId, { timeout: 40_000 });
    await expect(select.locator('option:checked')).toHaveText(podName);
    // The form follows that pod as it does a listed one: a Reason pod's event is a video meeting, titled with its name.
    await expect(page.getByTestId('event-format-select')).toHaveValue('video_meeting');
    await expect(page.locator('input[name="title"]')).toHaveValue(`Video meeting · ${podName}`);

    const posted: { json?: Record<string, unknown> } = {};
    page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/sessions$/.test(r.url())) posted.json = r.postDataJSON(); });
    await page.locator('form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    expect(posted.json).toMatchObject({ podId, format: 'video_meeting' });
    const saved = (await pool.query(`SELECT pod_id, event_format FROM sessions WHERE pod_id = $1`, [podId])).rows;
    expect(saved).toEqual([{ pod_id: podId, event_format: 'video_meeting' }]);
  });
}

test('a pod the member cannot schedule in is not offered, and neither is an archived one, even to an admin', async () => {
  test.setTimeout(180_000);
  const member = await createTestUser('formsmember');
  madeInTests.push(member);
  const podName = `E2E Not offered ${run}`;
  const podId = await podOfType('reason', podName, host);
  await addPodMember(host, podId, member.id);

  // A plain member of the pod: the server would refuse ("Only pod directors and hosts can create sessions"), so the
  // form does not offer it. It is not in the director/host list either, so the select stays on "Select a pod".
  let posts = 0;
  const page = await openAs(member, `/sessions/new?podId=${podId}`);
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/sessions$/.test(r.url())) posts += 1; });
  const select = page.locator('select[name="podId"]');
  await expect(select).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('format-pending')).toHaveCount(0, { timeout: 40_000 });
  await expect(select.locator('option')).toHaveCount(1);
  await expect(select).toHaveValue('');
  await page.locator('form button[type="submit"]').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Select a pod' })).toBeVisible();
  expect(posts, 'nothing was posted').toBe(0);

  // An archived pod is not one the list offers, so an address naming it does not bring it back, even for an admin.
  await pool.query(`UPDATE pods SET status = 'archived' WHERE id = $1`, [podId]);
  const adminPage = await openAs(admin, `/sessions/new?podId=${podId}`);
  const adminSelect = adminPage.locator('select[name="podId"]');
  await expect(adminSelect).toBeVisible({ timeout: 40_000 });
  await expect(adminPage.getByTestId('format-pending')).toHaveCount(0, { timeout: 40_000 });
  await expect(adminSelect.locator('option', { hasText: podName })).toHaveCount(0);
  await expect(adminSelect).toHaveValue('');
});
