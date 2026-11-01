// IN-PERSON EVENTS, SPEED-NETWORKING PRESETS AND A MATCHING SECTION ON EVERY TYPE (30 Oct programme, T12), headed.
//
// "Physical (in-person) meeting", "Speed networking types, e.g. founders and investors, job-related" and "Matching
// rules should be available when creating an event". A throwaway director schedules, in a Reason pod:
//   A. an in-person event with a place: the place and an "Open in maps" link show on its page, the facts line reads
//      "In person · 180 min · up to 25 · <place>", there is no Go Live, its live address goes back to its page, and the
//      server refuses it a video token (409, in a sentence). A second member, on the pod page all along, sees the new
//      event appear without a reload.
//   B. a speed-networking event with "Founders and investors" and the cooldown rule (6 months): the facts line names
//      the preset and the server kept the choices.
//   C. on Video meeting the Matching section says it pairs nobody, and its button switches to Speed networking through
//      the type picker's question ("Switching to Speed networking removes the video meeting settings (90 min).").
//   D. the form at seven widths: no sideways scroll, the place field and the Matching section's controls 44px and
//      inside the window (Chromium, WebKit, and E2E_DEVICE="iPhone 14" for the phone itself).
//
// The event page's Add to calendar menu (T7's) carries the place in its Google and Outlook.com links (step A).
// The registration and invite emails' "In person, at <place>" and their links carry no browser surface (no email
// provider locally): server/src/__tests__/services/t12-in-person-emails.test.ts holds them.
//
// Runs on the local stack (run-local-spec.sh) or a preview. Every account ends @rsn-e2e.invalid, the pod is the spec's
// own, and teardown deletes exactly those rows by id.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { pool } from '../helpers/auth';
import { APP, SERVER, cleanup, idsOf } from '../helpers/live-ui';
import { launchBrowser, engineLabel, contextOptions } from '../helpers/engine';
import { primePreview } from '../helpers/preview-bypass';
import { expectReachable } from '../helpers/viewport-fit';

const SECRET = process.env.E2E_JWT_SECRET || process.env.JWT_SECRET;
const PLACE = `The Ivy, 1-5 West St, London ${Date.now() % 10_000}`;
const FOUNDERS = '5e7b1a5e-0000-4000-8000-000000000002';
const WIDTHS = [360, 390, 414, 768, 1024, 1280, 1440];

interface Person { id: string; email: string; token: string; refresh: string }

async function makePerson(label: string): Promise<Person> {
  const id = uuid();
  const email = `n1t12-${label}-${Date.now()}@rsn-e2e.invalid`;
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, reasons_to_connect, location)
     VALUES ($1, $2, $3, 'N1T12', $4, 'active', 'member', true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech', ARRAY['Testing']::text[], 'Copenhagen, Denmark')`,
    [id, email, `N1T12 ${label}`, label],
  );
  const sessionId = uuid();
  const token = jwt.sign({ sub: id, email, role: 'member', displayName: `N1T12 ${label}`, sessionId }, SECRET!, { expiresIn: '1h' });
  const refresh = jwt.sign({ sub: id, sessionId, type: 'refresh' }, SECRET!, { expiresIn: '1d' });
  return { id, email, token, refresh };
}

async function api(who: Person, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

let browser: Browser;
let director: Person;
let member: Person;
let podId = '';
const sessionIds: string[] = [];

async function signedIn(who: Person, viewport = { width: 1280, height: 900 }): Promise<BrowserContext> {
  const ctx = await browser.newContext(process.env.E2E_DEVICE ? contextOptions() : { viewport });
  await primePreview(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: who.token, r: who.refresh });
  return ctx;
}

async function open(ctx: BrowserContext, path: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function noSidewaysScroll(page: Page, label: string) {
  const [scroll, inner] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${label}: sideways scroll (${scroll} > ${inner})`).toBeLessThanOrEqual(inner);
}

/** A control is at least 44px tall. */
async function tall(page: Page, locator: ReturnType<Page['locator']>, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label}: not drawn`).not.toBeNull();
  expect(Math.round(box!.height), `${label}: ${box!.height}px tall`).toBeGreaterThanOrEqual(44);
}

/** The event the form just made: its id from the address it lands on. */
async function createdEventId(page: Page): Promise<string> {
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const id = page.url().match(/\/sessions\/([0-9a-f-]{36})/)![1];
  sessionIds.push(id);
  return id;
}

/** A new event opens with its invite sheet (?invite=1); the event page is opened again without it, so it is in view. */
async function closeInviteSheet(page: Page, id: string) {
  await page.goto(`${APP}/sessions/${id}`, { waitUntil: 'domcontentloaded' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  browser = await launchBrowser();
  director = await makePerson('director');
  member = await makePerson('member');
  const pod = await api(director, 'POST', '/pods', {
    name: `N1T12 Pod ${Date.now() % 100_000}`, description: 'throwaway', visibility: 'private', podType: 'reason',
    orchestrationMode: 'free_form', communicationMode: 'video',
  });
  expect(pod.status, `create pod: ${JSON.stringify(pod.json)}`).toBe(201);
  podId = pod.json.data.id;
  const added = await api(director, 'POST', `/pods/${podId}/members`, { userId: member.id, role: 'member' });
  expect([200, 201], `add member: ${JSON.stringify(added.json)}`).toContain(added.status);
});

test.afterAll(async () => {
  await browser?.close();
  for (const id of sessionIds) await pool.query(`DELETE FROM session_participants WHERE session_id = $1`, [id]).catch(() => {});
  await cleanup(pool, { ids: idsOf(director, member), podId: podId || undefined });
});

test(`A: an in-person event: its place and maps link, no video room, and a member sees it arrive (${engineLabel()})`, async () => {
  test.setTimeout(180_000);
  const memberCtx = await signedIn(member);
  const podPage = await open(memberCtx, `/pods/${podId}`);
  await expect(podPage.locator('#pod-events')).toBeVisible({ timeout: 30_000 });
  await expect(podPage.locator('#pod-events').getByText('Dinner in town')).toHaveCount(0);

  const ctx = await signedIn(director);
  const page = await open(ctx, `/sessions/new?podId=${podId}`);
  await page.getByRole('radio', { name: /^In person/ }).click();
  const where = page.getByLabel('Where', { exact: true });
  await expect(where).toBeVisible();
  await expect(where).toHaveAttribute('maxlength', '300');
  await tall(page, where, 'Where');
  await page.getByLabel('Title', { exact: true }).fill('Dinner in town');

  // Without a place the form says so at the field.
  await page.getByRole('button', { name: 'Schedule Event' }).click();
  await expect(page.getByText('Say where the event happens: an address or a venue.').first()).toBeVisible();

  await where.fill(`  ${PLACE}  `);
  await page.getByLabel('Length').selectOption('180');
  // The Matching section is there, and says an in-person event pairs nobody.
  await expect(page.getByTestId('matching-section')).toContainText("Video meetings don't pair people.");
  await page.getByRole('button', { name: 'Schedule Event' }).click();
  const id = await createdEventId(page);
  await closeInviteSheet(page, id);

  await expect(page.getByTestId('event-place')).toContainText(PLACE);
  const maps = page.getByRole('link', { name: /Open in maps/ });
  await expect(maps).toHaveAttribute('href', `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(PLACE)}`);
  await tall(page, maps, 'Open in maps');
  await expect(page.getByText(`In person · 180 min · up to 25 · ${PLACE}`)).toBeVisible();
  await expect(page.getByRole('button', { name: /Go Live|Enter Event|Enter Live Event/ })).toHaveCount(0);

  // The calendar menu's links (T7's AddToCalendar) carry the place as where the event is.
  await page.getByRole('button', { name: 'Add to calendar' }).click();
  const menu = page.getByTestId('add-to-calendar-menu');
  const google = new URL((await menu.getByTestId('calendar-google').getAttribute('href'))!);
  expect(google.searchParams.get('location')).toBe(PLACE);
  const outlook = new URL((await menu.getByTestId('calendar-outlook').getAttribute('href'))!);
  expect(outlook.searchParams.get('location')).toBe(PLACE);
  await page.keyboard.press('Escape');

  // The live address goes back to the event page; the server opens no room for it.
  await page.goto(`${APP}/session/${id}/live`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(new RegExp(`/sessions/${id}$`), { timeout: 30_000 });
  await expect(page.getByTestId('event-place')).toBeVisible();
  const token = await api(director, 'POST', `/sessions/${id}/token`, {});
  expect(token.status).toBe(409);
  expect(token.json.error).toMatchObject({ code: 'NOT_A_VIDEO_EVENT', message: 'This event happens in person, so there is no video room.' });
  const stored = await api(director, 'GET', `/sessions/${id}`);
  expect(stored.json.data).toMatchObject({ format: 'physical_event', config: { location: PLACE, durationMinutes: 180 } });

  // The member's pod page, open all along, lists it without a reload.
  await expect(podPage.locator('#pod-events').getByText('Dinner in town')).toBeVisible({ timeout: 20_000 });
  await memberCtx.close();
  await ctx.close();
});

test(`B: speed networking with Founders and investors and the cooldown rule; the facts line names the preset (${engineLabel()})`, async () => {
  test.setTimeout(120_000);
  const ctx = await signedIn(director);
  const page = await open(ctx, `/sessions/new?podId=${podId}`);
  await page.getByRole('radio', { name: /^Speed networking/ }).click();
  const presets = page.getByTestId('matching-presets');
  await expect(presets).toContainText('Founders meet investors first');
  await expect(presets).toContainText('People hiring meet people looking for a role first');
  await expect(presets.getByRole('radio', { name: /^General/ })).toBeChecked();
  await presets.getByRole('radio', { name: /^Founders and investors/ }).check();
  await page.getByRole('radio', { name: /^Not again for a while/ }).check();
  const months = page.getByLabel('Months apart');
  await expect(months).toHaveValue('12');
  await months.fill('6');
  await page.getByLabel('Title', { exact: true }).fill('Founders night');
  await page.getByRole('button', { name: 'Schedule Event' }).click();
  const id = await createdEventId(page);
  await closeInviteSheet(page, id);
  await expect(page.getByText(/Speed networking · Founders and investors · 5 rounds × 8 min · up to 500/)).toBeVisible({ timeout: 20_000 });
  const stored = await api(director, 'GET', `/sessions/${id}`);
  expect(stored.json.data.config).toMatchObject({ matchingTemplateId: FOUNDERS, matchingPolicy: 'cooldown', cooldownMonths: 6 });
  await ctx.close();
});

test(`C: on Video meeting the Matching section says so, and switches to Speed networking through the question (${engineLabel()})`, async () => {
  test.setTimeout(120_000);
  const ctx = await signedIn(director);
  const page = await open(ctx, `/sessions/new?podId=${podId}`);
  await expect(page.getByRole('radio', { name: /^Video meeting/ })).toBeChecked({ timeout: 30_000 });
  const section = page.getByTestId('matching-section');
  await expect(section).toContainText("Video meetings don't pair people. Choose Speed networking to match people one to one.");
  await page.getByLabel('Length').selectOption('90');
  await section.getByRole('button', { name: 'Choose Speed networking' }).click();
  const question = page.getByRole('alert').filter({ hasText: 'Switching to Speed networking' });
  await expect(question).toHaveText(/Switching to Speed networking removes the video meeting settings \(90 min\)\. Continue\?/);
  await question.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Number of rounds')).toHaveValue('5');
  await expect(page.getByTestId('matching-presets')).toBeVisible();
  await ctx.close();
});

test(`D: the form at seven widths: no sideways scroll, every Matching and place control 44px and inside the window (${engineLabel()})`, async () => {
  test.setTimeout(240_000);
  const widths = process.env.E2E_DEVICE ? [0] : WIDTHS;
  for (const width of widths) {
    const ctx = await signedIn(director, { width: width || 390, height: 900 });
    const page = await open(ctx, `/sessions/new?podId=${podId}`);
    const label = process.env.E2E_DEVICE ?? `${width}px`;
    await page.getByRole('radio', { name: /^In person/ }).click();
    const where = page.getByLabel('Where', { exact: true });
    // The pod and its event types arrive after the form is drawn and move the field down, so a scroll made too early
    // leaves it under the sticky Schedule bar (WebKit has no scroll anchoring). A person scrolls on; so does the test,
    // until the field sits where a finger can reach it, and a field that stays covered still fails after the wait.
    await expect(async () => {
      await where.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await expectReachable(page, where, `${label} Where`);
    }).toPass({ timeout: 15_000 });
    await tall(page, where, `${label} Where`);
    await noSidewaysScroll(page, `${label} in person`);

    await page.getByRole('radio', { name: /^Speed networking/ }).click();
    const founders = page.getByTestId('matching-presets').locator('label').filter({ hasText: 'Founders and investors' });
    await founders.scrollIntoViewIfNeeded();
    await tall(page, founders, `${label} Founders card`);
    await page.getByRole('radio', { name: /^Not again for a while/ }).check();
    const months = page.getByLabel('Months apart');
    await months.scrollIntoViewIfNeeded();
    await tall(page, months, `${label} Months apart`);
    await noSidewaysScroll(page, `${label} speed networking`);
    await ctx.close();
  }
});
