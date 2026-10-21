// e2e/tests/entities.spec.ts
//
// Entities on screen (21 Oct 2026, the client's 19 Oct feedback: "Users should be able to create an Entity (their
// company) themselves"), driven by clicks the way a member would, on the routes of the entities server (Task 10).
//
//   1 create          /entities?create=1 opens the sheet; a one-character name is refused next to the field; a full
//                     create lands on the new entity's page, says so (and that the profile now shows it as the member's
//                     company), stores exactly what was typed, and Back returns to /entities with the sheet closed and
//                     the entity under "Your entities" with the member's role
//   2 the name taken  the same name in other case and spacing: "There is already an entity called X." Open it opens it;
//                     Join it waits until the lookup says you are not linked, then joins with the role and title chosen
//                     in the form, and no second entity is made; once linked, only Open it is offered
//   3 join, change, leave
//                     a member who is not linked joins with a role, changes role and title, and leaves; the admin's page,
//                     open in another window the whole time, follows each step without a reload
//   4 Human Profile   a person's entities with role and title, each opening the entity; with none, the company, or
//                     "No organisation shared yet"
//   4b Your profile   your own entities with role and title, each opening the entity, and "Add your company" (to the
//                     create sheet); with none, "Show where you work."
//   5 edit, archive   only an admin sees Edit and Archive; an edit sends only what changed; Archive asks first, its
//                     sheet waits for the answer (Escape, Close and the backdrop do nothing while "Archiving…"),
//                     returns to the list without "not available" ever showing on the way, and the entity's page then
//                     says it is not available; a member's Human Profile open elsewhere drops it without a reload
//   6 last one out    leaving an entity you are alone in warns first, archives it and returns you to the list, the
//                     same way
//   7 widths          /entities and an entity page at 360, 390, 768, 1024 and 1440: no sideways scroll, and two cards a
//                     row only from 1024px
//   8 a failed search is said under the search box, which keeps what was typed (and the focus); your entities stay;
//                     Try again asks again
//
// Every page is watched: a script error fails the test (the browser's own console line for the 409 a test asks for
// is not a script error).
//
// Throwaway members and entities only, removed by exact id in afterAll: entities first, because deleting a member
// leaves the entities they created behind with no creator. Entity names carry "E2E" and the run id.
//
// Run it one engine at a time (one spec per process: the database pool is shared):
//   locally, only through the wrapper (the scratch database, a local API with the entities routes):
//     bash /c/dev/_m1-local/oct21/run-local-spec.sh <worktree> <ui-port> <api-port> tests/entities.spec.ts
//     E2E_ENGINE=webkit bash /c/dev/_m1-local/oct21/run-local-spec.sh ...
//   on the preview, once the entities server is live on the API it calls:
//     E2E_APP_URL=https://<preview> E2E_API_URL=<that API> E2E_VERCEL_SHARE=<_vercel_share token> E2E_JWT_SECRET=<its key> \
//       npx playwright test tests/entities.spec.ts
//   E2E_ENGINE=webkit E2E_DEVICE='iPhone 14' ... runs every window as that phone (its own size is then the only size).
//   E2E_SHOTS_DIR=<folder> also saves a screenshot at each width. E2E_HEADED=0 runs it headless.

import { test, expect, devices, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel, contextOptions } from '../helpers/engine';

// E2E_DEVICE='iPhone 14' (with E2E_ENGINE=webkit) runs every window as that phone, touch and all; its own size is then
// the only size. helpers/engine.ts would fall back to a desktop window for a name it does not know, so a typo is refused.
const DEVICE = process.env.E2E_DEVICE;
if (DEVICE && !(DEVICE in devices)) throw new Error(`E2E_DEVICE "${DEVICE}" is not one of Playwright's devices`);
// First answers can be slow on a preview (a sleeping API wakes in up to a minute).
const SLOW = 75_000;
const SHOTS = process.env.E2E_SHOTS_DIR ? path.resolve(process.env.E2E_SHOTS_DIR) : '';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const BENIGN_PAGE_ERROR = /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/i;

const run = Date.now().toString(36);
// 40 characters, the longest name the brief asks to look at.
const NAME = `Northwind Lighthouse E2E ${run} Studio`.slice(0, 40);
const SOLO = `Solo E2E ${run}`;
const WIDE = [`Wide One E2E ${run}`, `Wide Two E2E ${run}`];

let browser: Browser | undefined;
const ctxs: BrowserContext[] = [];
// Every throwaway account and entity, pushed the moment it exists, removed by exact id in afterAll.
const made: string[] = [];
const entities: string[] = [];
let ana: TestUser; // creates the entity and looks after it
let ben: TestUser; // tries to create it again, and joins it from the create sheet
let cleo: TestUser; // not linked: joins, changes role, leaves
let entityId = '';

// Resend refuses @example.com, so a throwaway member gets delivered+label@resend.dev (accepted, never delivered).
async function makeUser(label: string, first: string, company: string | null): Promise<TestUser> {
  const u = await createTestUser(`entities-${label}`);
  made.push(u.id);
  const displayName = `${first} E2E ${run}`;
  await pool.query(
    `UPDATE users SET email = $1, display_name = $2, first_name = $3, last_name = $4, company = $5 WHERE id = $6`,
    [`delivered+entities-${run}-${label}@resend.dev`, displayName, first, `E2E ${run}`, company, u.id],
  );
  return { ...u, displayName };
}

/** Seeds through the API the page itself calls, as the member. */
async function apiCreate(u: TestUser, body: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${SERVER}/api/entities`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${u.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json() as { data?: { id: string } };
  expect(r.status, JSON.stringify(json)).toBe(201);
  entities.push(json.data!.id);
  return json.data!.id;
}

interface Opened { page: Page; errors: string[] }

async function openAs(u: TestUser, size: { width: number; height: number }): Promise<Opened> {
  if (!browser) throw new Error('the browser is not open');
  const ctx = await browser.newContext(DEVICE ? contextOptions() : { viewport: size });
  ctxs.push(ctx);
  await primePreview(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!BENIGN_PAGE_ERROR.test(e.message)) errors.push(`${page.url()}: ${e.message}`); });
  return { page, errors };
}

/**
 * Records every moment "This entity is not available." is in the page, from the first paint of every document. The
 * way from an archived page to the list must never show it (the route change is a transition, and the old page's own
 * 404 once drew it there for a moment).
 */
async function watchForGone(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __goneSeen: string[] }).__goneSeen = seen;
    new MutationObserver(() => {
      if (document.body?.innerText.includes('This entity is not available.')) seen.push(location.pathname);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { __goneSeen: string[] }).__goneSeen);
}

const createSheet = (page: Page) => page.getByRole('dialog', { name: 'Create your company' });
const field = (scope: Locator, label: string) => scope.getByLabel(label, { exact: label === 'Name' || label === 'Type' || label === 'Your role' });
const personCard = (page: Page, u: TestUser) => page.locator(`a[data-person-id="${u.id}"]`);

async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const m = await page.evaluate(() => {
    const main = document.querySelector('main');
    return { docW: document.documentElement.scrollWidth, innerW: window.innerWidth, mainOver: main ? main.scrollWidth - main.clientWidth : 0 };
  });
  expect(m.docW, `${where}: the window scrolls sideways`).toBeLessThanOrEqual(m.innerW);
  expect(m.mainOver, `${where}: the page area scrolls sideways`).toBeLessThanOrEqual(1);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace(/[^a-z0-9]+/gi, '-')}-entities-${name}.png`), fullPage: true });
}

test.beforeAll(async () => {
  console.log(`[entities] engine=${engineLabel()} app=${APP} api=${SERVER}`);
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  ana = await makeUser('ana', 'Ana', null);
  ben = await makeUser('ben', 'Ben', 'Elsewhere Ltd');
  cleo = await makeUser('cleo', 'Cleo', null);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (entities.length || made.length) {
    await pool.query(`DELETE FROM entities WHERE id = ANY($1::uuid[]) OR created_by = ANY($2::uuid[])`, [entities, made]);
  }
  if (made.length) await cleanup(pool, { ids: made });
});

test.describe.configure({ mode: 'serial' });

test('1 create: the sheet from the address, a refused name, then your company on its own page', async () => {
  test.setTimeout(240_000);
  expect(NAME.length).toBeLessThanOrEqual(40);
  const { page, errors } = await openAs(ana, PHONE);
  await gotoRetry(page, `${APP}/entities?create=1`);
  const sheet = createSheet(page);
  await expect(sheet, '?create=1 opens the create sheet').toBeVisible({ timeout: SLOW });
  await expect(field(sheet, 'Type'), 'a company by default').toHaveValue('company');
  await expect(field(sheet, 'Your role'), 'you as its founder by default').toHaveValue('founder');

  // One character: refused next to the field, and nothing is sent.
  await field(sheet, 'Name').fill('A');
  await sheet.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(sheet.getByText('Give the entity a name of at least 2 characters.')).toBeVisible();
  await expect(field(sheet, 'Name')).toHaveAttribute('aria-invalid', 'true');

  await field(sheet, 'Name').fill(NAME);
  await field(sheet, 'Type').selectOption('startup');
  await field(sheet, 'Your title').fill('CEO');
  await field(sheet, 'Location').fill('Copenhagen');
  await field(sheet, 'Size').selectOption('11-50');
  await field(sheet, 'About').fill('We light the way for small boats.');
  await field(sheet, 'Website').fill('northwind.example');
  await sheet.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(page, 'the new entity\'s page opens').toHaveURL(/\/entities\/[0-9a-f-]{36}$/, { timeout: SLOW });
  entityId = page.url().split('/').pop()!;
  entities.push(entityId);
  await expect(page.getByText(`${NAME} is on REASON. Your profile now shows it as your company.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible();
  await expect(page.getByText('Startup · Copenhagen')).toBeVisible();
  await expect(page.getByText('11-50 people')).toBeVisible();
  await expect(page.getByText('We light the way for small boats.')).toBeVisible();
  await expect(page.getByRole('link', { name: /northwind\.example/ })).toHaveAttribute('href', 'https://northwind.example/');
  await expect(page.getByRole('heading', { name: 'Founder', level: 2 }), 'Your relationship: your role').toBeVisible();
  await expect(page.getByText('Your title here: CEO. You look after this page.')).toBeVisible();
  await expect(personCard(page, ana), 'you are among its people').toContainText('Founder · CEO');

  const stored = await pool.query(`SELECT name, kind, location, size, about, website FROM entities WHERE id = $1`, [entityId]);
  expect(stored.rows[0]).toEqual({ name: NAME, kind: 'startup', location: 'Copenhagen', size: '11-50', about: 'We light the way for small boats.', website: 'https://northwind.example' });
  const link = await pool.query(`SELECT role, title, is_admin FROM entity_members WHERE entity_id = $1 AND user_id = $2`, [entityId, ana.id]);
  expect(link.rows[0]).toEqual({ role: 'founder', title: 'CEO', is_admin: true });
  expect((await pool.query(`SELECT company FROM users WHERE id = $1`, [ana.id])).rows[0].company, 'the empty profile company is filled in').toBe(NAME);

  // Back: the list, the sheet closed, the entity under "Your entities" with your role.
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page).toHaveURL(/\/entities$/);
  await expect(createSheet(page)).toBeHidden();
  const card = page.locator(`section[aria-labelledby="your-entities-title"] a[data-entity-id="${entityId}"]`);
  await expect(card).toBeVisible({ timeout: SLOW });
  await expect(card).toContainText('Founder');
  await expect(card).toContainText('1 person');
  expect(errors).toEqual([]);
});

test('2 the name taken: Open it opens it, Join it joins it with the role from the form, and only once it is known you are not linked', async () => {
  test.setTimeout(240_000);
  const { page, errors } = await openAs(ben, DESKTOP);
  const taken = `  ${NAME.toUpperCase().replace(/ /g, '   ')} `;
  const tryToCreate = async (title: string) => {
    await page.getByRole('button', { name: 'Create your company' }).click();
    const sheet = createSheet(page);
    await expect(sheet).toBeVisible();
    await field(sheet, 'Name').fill(taken);
    await field(sheet, 'Your role').selectOption('employee');
    await field(sheet, 'Your title').fill(title);
    await sheet.getByRole('button', { name: 'Create', exact: true }).click();
    // In the entity's own spelling once it is looked up, and as typed until then (getByText ignores case).
    await expect(sheet.getByText(`There is already an entity called ${NAME}.`)).toBeVisible({ timeout: SLOW });
    return sheet;
  };

  await gotoRetry(page, `${APP}/entities`);
  await expect(page.getByRole('heading', { name: 'Entities', exact: true, level: 1 })).toBeVisible({ timeout: SLOW });
  // The lookup of the entity that has the name is held back: until it answers nobody knows whether Ben is linked, and
  // a Join it pressed for someone who is would change their role instead (review, fix round 1).
  let releaseLookup = () => undefined as void;
  const lookupHeld = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const lookup = (url: URL) => url.pathname.endsWith(`/api/entities/${entityId}`);
  await page.route(lookup, async (route) => {
    if (route.request().method() === 'GET') await lookupHeld;
    await route.continue();
  });
  let sheet = await tryToCreate('Engineer');
  await expect(sheet.getByText('Checking it…')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Join it' }), 'no Join it before the lookup answers').toHaveCount(0);
  releaseLookup();
  await expect(sheet.getByText('You can join it instead, as Employee.')).toBeVisible({ timeout: SLOW });
  await expect(sheet.getByRole('button', { name: 'Join it' })).toBeVisible();
  await page.unroute(lookup);
  await sheet.getByRole('link', { name: 'Open it' }).click();
  await expect(page).toHaveURL(new RegExp(`/entities/${entityId}$`));
  await expect(page.getByRole('heading', { name: `Are you part of ${NAME}?` })).toBeVisible({ timeout: SLOW });
  // Back is the list, not the sheet again.
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page).toHaveURL(/\/entities$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  sheet = await tryToCreate('Engineer');
  await expect(sheet.getByText('You can join it instead, as Employee.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Join it' }).click();
  await expect(page).toHaveURL(new RegExp(`/entities/${entityId}$`), { timeout: SLOW });
  await expect(page.getByText(`You joined ${NAME}.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Employee', level: 2 })).toBeVisible();
  await expect(page.getByText('Your title here: Engineer.')).toBeVisible();

  // Linked now: the same name again offers only Open it, and nothing about Ben's link changes.
  await page.getByRole('button', { name: '← Back' }).click();
  await expect(page).toHaveURL(/\/entities$/);
  sheet = await tryToCreate('');
  await expect(sheet.getByText('You are already linked to it, as Employee.')).toBeVisible({ timeout: SLOW });
  await expect(sheet.getByRole('button', { name: 'Join it' })).toHaveCount(0);
  await expect(sheet.getByRole('link', { name: 'Open it' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();

  const same = await pool.query(`SELECT count(*)::int AS n FROM entities WHERE lower(name) = lower($1) AND archived_at IS NULL`, [NAME]);
  expect(same.rows[0].n, 'no second entity with the same name').toBe(1);
  const link = await pool.query(`SELECT role, title, is_admin FROM entity_members WHERE entity_id = $1 AND user_id = $2`, [entityId, ben.id]);
  expect(link.rows[0]).toEqual({ role: 'employee', title: 'Engineer', is_admin: false });
  expect((await pool.query(`SELECT company FROM users WHERE id = $1`, [ben.id])).rows[0].company, 'a company already set is left alone').toBe('Elsewhere Ltd');
  expect(errors).toEqual([]);
});

test('3 join, change, leave: the admin\'s open page follows each step without a reload', async () => {
  test.setTimeout(300_000);
  const admin = await openAs(ana, DESKTOP);
  const member = await openAs(cleo, PHONE);
  await gotoRetry(admin.page, `${APP}/entities/${entityId}`);
  await expect(admin.page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible({ timeout: SLOW });
  await expect(personCard(admin.page, cleo)).toHaveCount(0);

  const page = member.page;
  await gotoRetry(page, `${APP}/entities/${entityId}`);
  await expect(page.getByRole('heading', { name: `Are you part of ${NAME}?` })).toBeVisible({ timeout: SLOW });
  await expect(page.getByRole('button', { name: 'Edit', exact: true }), 'no Edit for someone who is not an admin').toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Join', exact: true }), 'Join waits for a role').toBeDisabled();
  await expect(page.getByText('Choose your role first.')).toBeVisible();
  await page.getByLabel('Your role', { exact: true }).selectOption('advisor');
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByText(`You joined ${NAME}.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Advisor', level: 2 })).toBeVisible();
  await expect(personCard(admin.page, cleo), 'the admin sees the new person without a reload').toContainText('Advisor', { timeout: 20_000 });

  await page.getByRole('button', { name: 'Change', exact: true }).click();
  const roleSheet = page.getByRole('dialog', { name: 'Your role' });
  await expect(roleSheet).toBeVisible();
  await expect(roleSheet.getByLabel('Your role', { exact: true })).toHaveValue('advisor');
  await roleSheet.getByLabel('Your role', { exact: true }).selectOption('board_member');
  await roleSheet.getByLabel('Your title').fill('Chair');
  await roleSheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(roleSheet).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Board member', level: 2 })).toBeVisible();
  await expect(page.getByText('Your title here: Chair.')).toBeVisible();
  await expect(personCard(admin.page, cleo), 'and the new role and title').toContainText('Board member · Chair', { timeout: 20_000 });

  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: `Leave ${NAME}?` });
  await expect(confirm.getByText('You are no longer listed among its people. You can join again at any time.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page.getByText(`You left ${NAME}.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: `Are you part of ${NAME}?` })).toBeVisible();
  await expect(personCard(admin.page, cleo), 'and that they left').toHaveCount(0, { timeout: 20_000 });

  const link = await pool.query(`SELECT 1 FROM entity_members WHERE entity_id = $1 AND user_id = $2`, [entityId, cleo.id]);
  expect(link.rowCount).toBe(0);
  expect([...admin.errors, ...member.errors]).toEqual([]);
});

test('4 the Human Profile lists a person\'s entities, each opening its page; with none, the company or nothing', async () => {
  test.setTimeout(240_000);
  const { page, errors } = await openAs(cleo, PHONE);
  await gotoRetry(page, `${APP}/people/${ana.id}`);
  await expect(page.getByRole('heading', { name: 'The entities around Ana.' })).toBeVisible({ timeout: SLOW });
  const row = page.getByRole('link', { name: new RegExp(`${NAME}.*Founder · CEO`) });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/entities/${entityId}$`));
  await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible({ timeout: SLOW });

  const viewer = await openAs(ana, PHONE);
  await gotoRetry(viewer.page, `${APP}/people/${ben.id}`);
  await expect(viewer.page.getByRole('heading', { name: 'The entities around Ben.' })).toBeVisible({ timeout: SLOW });
  await expect(viewer.page.getByRole('link', { name: new RegExp(`${NAME}.*Employee · Engineer`) })).toBeVisible();
  // No entities and no company.
  await gotoRetry(viewer.page, `${APP}/people/${cleo.id}`);
  await expect(viewer.page.getByRole('heading', { name: 'No organisation shared yet' })).toBeVisible({ timeout: SLOW });
  await expect(viewer.page.getByText('When Cleo links a company or organisation, it shows here.')).toBeVisible();
  // No entities, a company on the profile: the company, as before.
  await pool.query(`UPDATE users SET company = $1 WHERE id = $2`, [`Cleo Studio ${run}`, cleo.id]);
  await viewer.page.reload();
  await expect(viewer.page.getByRole('heading', { name: `Cleo Studio ${run}` })).toBeVisible({ timeout: SLOW });
  await expect(viewer.page.getByText('Cleo is connected to this entity', { exact: false })).toBeVisible();
  expect([...errors, ...viewer.errors]).toEqual([]);
});

test('4b Your profile lists your own entities with role and title, and always offers Add your company', async () => {
  test.setTimeout(240_000);
  const { page, errors } = await openAs(ana, PHONE);
  await gotoRetry(page, `${APP}/profile`);
  await expect(page.getByRole('heading', { name: 'The entities around you.' })).toBeVisible({ timeout: SLOW });
  const row = page.getByRole('link', { name: new RegExp(`${NAME}.*Founder · CEO`) });
  await expect(row).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add your company' })).toHaveAttribute('href', '/entities?create=1');
  await page.getByRole('heading', { name: 'The entities around you.' }).scrollIntoViewIfNeeded();
  await shot(page, 'profile-with-entities');
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/entities/${entityId}$`));
  await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible({ timeout: SLOW });

  // None (Cleo left the one she joined): the old words, and the way to add one.
  const none = await openAs(cleo, PHONE);
  await gotoRetry(none.page, `${APP}/profile`);
  await expect(none.page.getByRole('heading', { name: 'Show where you work.' })).toBeVisible({ timeout: SLOW });
  await expect(none.page.getByText('Add your company and your role in it. Members see it on your profile.')).toBeVisible();
  await none.page.getByRole('heading', { name: 'Show where you work.' }).scrollIntoViewIfNeeded();
  await shot(none.page, 'profile-without-entities');
  await none.page.getByRole('link', { name: 'Add your company' }).click();
  await expect(createSheet(none.page), 'Add your company opens the create sheet').toBeVisible({ timeout: SLOW });
  expect([...errors, ...none.errors]).toEqual([]);
});

test('5 edit and archive: admins only, the edit sends what changed, the archive asks first and its sheet waits for the answer', async () => {
  test.setTimeout(240_000);
  // Ben is linked to the entity and has Ana's Human Profile open the whole time: its "Entities & roles" must drop the
  // entity the moment it is archived, without a reload (review, fix round 1: it stayed as a link to a closed page).
  const watcher = await openAs(ben, PHONE);
  await gotoRetry(watcher.page, `${APP}/people/${ana.id}`);
  const onAnasProfile = watcher.page.getByRole('link', { name: new RegExp(NAME) });
  await expect(onAnasProfile).toBeVisible({ timeout: SLOW });

  const { page, errors } = await openAs(ana, DESKTOP);
  const goneSeen = await watchForGone(page);
  await gotoRetry(page, `${APP}/entities/${entityId}`);
  await expect(page.getByRole('heading', { name: NAME, level: 1 })).toBeVisible({ timeout: SLOW });

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: `Edit ${NAME}` });
  await expect(edit).toBeVisible();
  await expect(field(edit, 'Name')).toHaveValue(NAME);
  await field(edit, 'About').fill('We light the way for every boat.');
  await field(edit, 'Website').fill('');
  const sent = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/entities/${entityId}`));
  await edit.getByRole('button', { name: 'Save changes' }).click();
  expect((await sent).postDataJSON(), 'only what changed is sent; a cleared field is null').toEqual({ about: 'We light the way for every boat.', website: null });
  await expect(edit).toBeHidden();
  await expect(page.getByText(`${NAME} is saved.`)).toBeVisible();
  await expect(page.getByText('We light the way for every boat.')).toBeVisible();
  await expect(page.getByRole('link', { name: /northwind\.example/ }), 'the website is gone').toHaveCount(0);

  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: `Archive ${NAME}?` });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm, 'Cancel leaves it as it was').toBeHidden();
  expect((await pool.query(`SELECT archived_at FROM entities WHERE id = $1`, [entityId])).rows[0].archived_at).toBeNull();

  // The archive is held a moment: while it says "Archiving…", Escape, Close and the backdrop leave the sheet open, and
  // Cancel is off, so the answer (a failure too) is said where the member is looking (review, fix round 1).
  let releaseArchive = () => undefined as void;
  const archiveHeld = new Promise<void>((resolve) => { releaseArchive = resolve; });
  const theEntity = (url: URL) => url.pathname.endsWith(`/api/entities/${entityId}`);
  await page.route(theEntity, async (route) => {
    if (route.request().method() === 'DELETE') await archiveHeld;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await confirm.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(confirm.getByRole('button', { name: 'Archiving…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await confirm.getByRole('button', { name: 'Close' }).click();
  await page.mouse.click(8, 8);
  await expect(confirm, 'the sheet waits for the answer').toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  releaseArchive();
  await expect(page).toHaveURL(/\/entities$/, { timeout: SLOW });
  await page.unroute(theEntity);
  await expect(page.getByText(`${NAME} is archived.`)).toBeVisible();
  await expect(page.locator(`a[data-entity-id="${entityId}"]`)).toHaveCount(0);
  expect(await goneSeen(), 'never "not available" on the way to the list').toEqual([]);
  expect((await pool.query(`SELECT archived_at FROM entities WHERE id = $1`, [entityId])).rows[0].archived_at).not.toBeNull();
  await expect(onAnasProfile, 'the Human Profile drops the archived entity without a reload').toHaveCount(0, { timeout: 20_000 });
  expect(watcher.errors).toEqual([]);

  await gotoRetry(page, `${APP}/entities/${entityId}`);
  await expect(page.getByRole('heading', { name: 'This entity is not available.' })).toBeVisible({ timeout: SLOW });
  expect(errors).toEqual([]);
});

test('6 the last one out is warned, and the entity is archived with them', async () => {
  test.setTimeout(240_000);
  const solo = await apiCreate(ana, { name: SOLO, kind: 'other', role: 'member' });
  const { page, errors } = await openAs(ana, PHONE);
  const goneSeen = await watchForGone(page);
  await gotoRetry(page, `${APP}/entities/${solo}`);
  await expect(page.getByRole('heading', { name: SOLO, level: 1 })).toBeVisible({ timeout: SLOW });
  await expect(page.getByText('No description yet.'), 'nothing optional: says so, draws no empty facts').toBeVisible();
  await page.getByRole('button', { name: 'Leave', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: `Leave ${SOLO}?` });
  await expect(confirm.getByText(`You are the only person here. If you leave, ${SOLO} is archived`, { exact: false })).toBeVisible();
  await confirm.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page).toHaveURL(/\/entities$/, { timeout: SLOW });
  await expect(page.getByText(`You left ${SOLO}. No one else was linked to it, so it is archived.`)).toBeVisible();
  expect(await goneSeen(), 'never "not available" on the way to the list').toEqual([]);
  expect((await pool.query(`SELECT archived_at FROM entities WHERE id = $1`, [solo])).rows[0].archived_at).not.toBeNull();
  expect(errors).toEqual([]);
});

test('7 widths: no sideways scroll, and two cards a row only from 1024px', async () => {
  test.setTimeout(300_000);
  const ids = [];
  for (const name of WIDE) ids.push(await apiCreate(ana, { name, kind: 'company', role: 'founder', location: 'Aarhus' }));
  const sizes = DEVICE
    ? [contextOptions().viewport ?? PHONE]
    : [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }];
  for (const size of sizes) {
    const where = `${size.width}px`;
    const { page, errors } = await openAs(ana, size);
    await gotoRetry(page, `${APP}/entities`);
    const cards = page.locator('section[aria-labelledby="your-entities-title"] a[data-entity-id]');
    await expect(cards, `${where}: your two entities`).toHaveCount(2, { timeout: SLOW });
    const tops = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(tops[0] === tops[1] ? 2 : 1, `${where}: cards a row`).toBe(size.width >= 1024 ? 2 : 1);
    await expectNoSidewaysScroll(page, `${where} /entities`);
    await shot(page, `${size.width}-list`);
    await gotoRetry(page, `${APP}/entities/${ids[0]}`);
    await expect(page.getByRole('heading', { name: WIDE[0], level: 1 })).toBeVisible({ timeout: SLOW });
    await expectNoSidewaysScroll(page, `${where} entity page`);
    await shot(page, `${size.width}-entity`);
    expect(errors, `${where}: script errors`).toEqual([]);
  }
});

test('8 a search that fails is said under the box, which keeps what was typed, and Try again asks again', async () => {
  test.setTimeout(240_000);
  const { page, errors } = await openAs(ana, DESKTOP);
  await gotoRetry(page, `${APP}/entities`);
  const mine = page.locator('section[aria-labelledby="your-entities-title"] a[data-entity-id]');
  await expect(mine).toHaveCount(2, { timeout: SLOW });
  // Every search (a list request with q=) fails until it is let through; the page's own list is not touched.
  let failing = true;
  const searches = (url: URL) => url.pathname.endsWith('/api/entities') && url.searchParams.has('q');
  await page.route(searches, (route) => (failing
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false,"error":{"code":"INTERNAL_ERROR","message":"x"}}' })
    : route.continue()));
  const box = page.getByRole('searchbox', { name: 'Search entities' });
  await box.fill('wide');
  const failed = page.getByRole('heading', { name: 'We could not search just now.' });
  await expect(failed).toBeVisible({ timeout: SLOW });
  await expect(box, 'the box stays, with what was typed').toHaveValue('wide');
  await expect(box, 'and keeps the focus').toBeFocused();
  await expect(mine, 'your entities stay').toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'We could not load entities just now.' }), 'the page itself did not fail').toHaveCount(0);
  await shot(page, 'search-failed');
  failing = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(failed).toHaveCount(0, { timeout: SLOW });
  // Both "Wide" entities are Ana's own, so the others hold none, and the page says so.
  await expect(page.getByText('Only your own entities have “wide” in their name.')).toBeVisible();
  await page.unroute(searches);
  expect(errors).toEqual([]);
});
