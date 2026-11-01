// e2e/tests/n1-t15-entity-members-pictures.spec.ts
//
// 30 Oct review, T15 (7.1 to 7.3; L1, L22, L23): "Entity members need approval. When someone says they are part of an
// entity, the owner should approve it and be able to remove members", "Please add options to upload a company logo and
// banner", "An entity should be linkable to one or more Circles".
//
//   The claim     a member asks to join with a role: their panel says it waits, their own profile lists it as
//                 "Waiting for approval", and the owner's Requests panel, open the whole time, shows them without a
//                 reload. Nobody else sees them listed.
//   The answer    the owner approves: the member appears in People on the owner's screen, their own panel shows their
//                 role, and their profile drops "Waiting for approval", each without a reload.
//   The logo      the owner's pencil on the tile ("Add logo") opens the picture editor at 1:1: a picture is chosen,
//                 zoomed (+ and a two-finger pinch) and dragged, and saved. It shows on the hero, on the member's open
//                 page (no reload), and on the owner's card in the list. The banner the same at 3:1.
//   Removal       the owner removes a second member after the confirm; they leave People at once.
//   Circles       a circle's manager links the entity to their circle; the entity's Circles section shows it without
//                 a reload.
//   Every size    at the width given (7 widths, or the device's own): no sideways scroll; the pencils, Approve, Decline
//                 and Remove are at least 44px and inside the window; at 360 a request is two lines with its buttons
//                 on their own row.
//
// Throwaway members (emails at rsn-e2e.invalid), entity and circle only, deleted by id at the end. One engine per
// process:
//   locally          bash /c/dev/_m1-local/oct21/run-local-spec.sh <worktree> <ui-port> <api-port> tests/n1-t15-entity-members-pictures.spec.ts
//   on the preview   E2E_APP_URL=https://<preview> E2E_API_URL=<its API> E2E_VERCEL_SHARE=<token> E2E_JWT_SECRET=<key> \
//                      npx playwright test tests/n1-t15-entity-members-pictures.spec.ts
//   E2E_ENGINE=webkit for Safari's engine; E2E_DEVICE="iPhone 14" for a phone; E2E_HEADED=1 to watch.

import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

const ENGINE = engineLabel();
const SLOW = 75_000;
const LIVE = 20_000;
const run = Date.now().toString(36);
const WIDTHS = process.env.E2E_DEVICE ? [0] : [360, 390, 414, 768, 1024, 1280, 1440];

let browser: Browser;
const ids: string[] = [];
const entityIds: string[] = [];
const circleIds: string[] = [];
const contexts: BrowserContext[] = [];

test.beforeAll(async () => { browser = await launchBrowser(); });
test.afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => undefined);
  await browser?.close();
  if (circleIds.length) await pool.query(`DELETE FROM circles WHERE id = ANY($1::uuid[])`, [circleIds]);
  if (entityIds.length) await pool.query(`DELETE FROM entities WHERE id = ANY($1::uuid[])`, [entityIds]);
  await cleanup(pool, { ids });
});

async function member(label: string, first: string): Promise<TestUser> {
  const u = await createTestUser(`t15-${label}-${run}`);
  ids.push(u.id);
  await pool.query(
    `UPDATE users SET email = $2, display_name = $3, first_name = $4, last_name = 'E2E', company = NULL, onboarding_version = 2 WHERE id = $1`,
    [u.id, `t15-${label}-${run}@rsn-e2e.invalid`, `${first} E2E ${label}`, first],
  );
  return { ...u, displayName: `${first} E2E ${label}` };
}

/** The API the page itself calls, as that member. */
async function api(u: TestUser, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const r = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${u.accessToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({})) as { data?: Record<string, unknown> };
  return { status: r.status, data: json.data ?? {} };
}

async function signedIn(u: TestUser, width: number): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser.newContext(width ? { viewport: { width, height: width < 768 ? 780 : 900 } } : contextOptions());
  contexts.push(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  await primePreview(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return { page, errors };
}

const unexpected = (errors: string[]) => errors.filter((e) => !/404|Not Found|Failed to load resource|DevTools|WebSocket|socket|access control checks/i.test(e));

async function noSidewaysScroll(page: Page, label: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    { message: `${label}: the page is wider than the window`, timeout: 5_000 }).toBeLessThanOrEqual(0);
}

async function tall(target: Locator, label: string) {
  expect((await target.boundingBox())!.height, `${label}: at least 44px`).toBeGreaterThanOrEqual(44);
}

/** A JPEG made in the page: red left half, blue right half. */
async function halves(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ w, h }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d')!;
    x.fillStyle = '#d1242f'; x.fillRect(0, 0, w / 2, h);
    x.fillStyle = '#0969da'; x.fillRect(w / 2, 0, w / 2, h);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }, { w: width, h: height });
  return Buffer.from(base64, 'base64');
}

async function drag(page: Page, frame: Locator, dx: number, dy: number) {
  const box = (await frame.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

/** A two-finger pinch on the frame, as touch pointers (T3a's): the fingers spread from 40px apart to 120px. */
function pinch(frame: Locator) {
  return frame.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    const cx = r.left + r.width / 2;
    const fire = (type: string, id: number, x: number) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: cy, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', 11, cx - 20);
    fire('pointerdown', 12, cx + 20);
    for (let s = 1; s <= 4; s += 1) { fire('pointermove', 11, cx - 20 - 10 * s); fire('pointermove', 12, cx + 20 + 10 * s); }
    fire('pointerup', 11, cx - 60);
    fire('pointerup', 12, cx + 60);
  });
}

const zoomOf = (sheet: Locator) => sheet.getByRole('slider', { name: 'Zoom' }).inputValue().then(Number);
const personCard = (page: Page, u: TestUser) => page.locator(`a[data-person-id="${u.id}"]`);

for (const width of WIDTHS) {
  const at = width ? `${width}px` : process.env.E2E_DEVICE ?? 'device';

  test(`a claim waits, the owner approves it live, places a logo and a banner, removes a member, and a circle links it (${ENGINE}, ${at})`, async () => {
    test.setTimeout(300_000);
    const owner = await member(`own${width}`, 'Olu');
    const claimant = await member(`cla${width}`, 'Cai');
    const second = await member(`sec${width}`, 'Sev');
    const manager = await member(`man${width}`, 'Mae');
    const name = `T15 Lighthouse ${run} ${width}`;
    const made = await api(owner, 'POST', '/entities', { name, kind: 'company', role: 'founder' });
    expect(made.status).toBe(201);
    const entityId = made.data.id as string;
    entityIds.push(entityId);
    // The second member is listed already: asked, and approved by the owner.
    expect((await api(second, 'POST', `/entities/${entityId}/members`, { role: 'advisor' })).data.status).toBe('pending');
    expect((await api(owner, 'POST', `/entities/${entityId}/members/${second.id}/approve`)).status).toBe(200);

    const own = await signedIn(owner, width);
    const cla = await signedIn(claimant, width);
    const claProfile = await signedIn(claimant, width);
    await gotoRetry(own.page, `${APP}/entities/${entityId}`);
    await expect(own.page.getByRole('heading', { name, level: 1 })).toBeVisible({ timeout: SLOW });
    const requests = own.page.getByTestId('entity-requests');
    await expect(requests.getByText('No one is waiting for an answer.')).toBeVisible();

    // ── The claim ──────────────────────────────────────────────────────────────────────────────────────────
    await gotoRetry(cla.page, `${APP}/entities/${entityId}`);
    await expect(cla.page.getByRole('heading', { name: `Are you part of ${name}?` })).toBeVisible({ timeout: SLOW });
    await expect(cla.page.getByTestId('entity-requests'), 'no Requests for someone who is not an admin').toHaveCount(0);
    await cla.page.getByLabel('Your role', { exact: true }).selectOption('employee');
    const ask = cla.page.getByRole('button', { name: 'Ask to join', exact: true });
    await tall(ask, `${at}: Ask to join`);
    await ask.click();
    await expect(cla.page.getByText(`Your request is sent to ${name}'s admins.`, { exact: false })).toBeVisible({ timeout: LIVE });
    await expect(cla.page.getByRole('heading', { name: `Waiting for ${name}'s admins to approve you.` })).toBeVisible();
    await expect(cla.page.getByRole('button', { name: 'Cancel request' })).toBeVisible();
    await expect(personCard(cla.page, claimant), 'not listed while it waits').toHaveCount(0);
    expect((await pool.query(`SELECT status FROM entity_members WHERE entity_id = $1 AND user_id = $2`, [entityId, claimant.id])).rows[0].status).toBe('pending');

    // Their own profile says it waits.
    await gotoRetry(claProfile.page, `${APP}/profile`);
    const ownRow = claProfile.page.getByRole('link', { name: new RegExp(`${name}.*Employee`) });
    await expect(ownRow).toContainText('Waiting for approval', { timeout: SLOW });

    // The owner's Requests panel, open the whole time, shows them without a reload.
    const row = requests.locator(`[data-request-id="${claimant.id}"]`);
    await expect(row, 'the request arrives without a reload').toBeVisible({ timeout: LIVE });
    await expect(row).toContainText('Says they are Employee');
    await expect(requests).toContainText('1 waiting');
    const approve = row.getByRole('button', { name: 'Approve' });
    const decline = row.getByRole('button', { name: 'Decline' });
    await tall(approve, `${at}: Approve`);
    await tall(decline, `${at}: Decline`);
    await decline.scrollIntoViewIfNeeded();
    await expectReachable(own.page, decline, `${at}: Decline`);
    if (width && width < 768) {
      // Two lines (name, role) and the buttons on a row of their own.
      const who = (await row.getByRole('link').boundingBox())!;
      expect((await approve.boundingBox())!.y, `${at}: the buttons sit under the name`).toBeGreaterThanOrEqual(who.y + who.height - 1);
    }
    await noSidewaysScroll(own.page, `${at}: the page with a request`);

    // ── The answer ─────────────────────────────────────────────────────────────────────────────────────────
    await approve.click();
    await expect(own.page.getByText(`${claimant.displayName} is now listed at ${name}.`)).toBeVisible({ timeout: LIVE });
    await expect(personCard(own.page, claimant), 'listed in People on the owner\'s screen').toContainText('Employee', { timeout: LIVE });
    await expect(requests.getByText('No one is waiting for an answer.')).toBeVisible({ timeout: LIVE });
    await expect(cla.page.getByRole('heading', { name: 'Employee', level: 2 }), 'their own panel flips without a reload').toBeVisible({ timeout: LIVE });
    await expect(ownRow, 'their profile drops "Waiting for approval" without a reload').not.toContainText('Waiting for approval', { timeout: LIVE });

    // ── The logo ───────────────────────────────────────────────────────────────────────────────────────────
    const pencil = own.page.getByRole('button', { name: 'Add logo' });
    await pencil.scrollIntoViewIfNeeded();
    await expectReachable(own.page, pencil, `${at}: the logo's pencil`);
    await tall(pencil, `${at}: the logo's pencil`);
    await expect(cla.page.getByRole('button', { name: /logo$/ }), 'no pencil for a member').toHaveCount(0);
    await pencil.click();
    const sheet = own.page.getByRole('dialog', { name: 'Add logo' });
    await expect(sheet.getByText('No logo yet. Choose a picture to place it.')).toBeVisible({ timeout: 30_000 });
    await sheet.locator('input[type="file"]').setInputFiles({ name: 'logo.jpg', mimeType: 'image/jpeg', buffer: await halves(own.page, 1200, 900) });
    const frame = sheet.getByTestId('picture-frame');
    await expect(sheet.getByRole('slider', { name: 'Zoom' })).toBeVisible({ timeout: 20_000 });
    await expectReachable(own.page, sheet.getByRole('button', { name: 'Save', exact: true }), `${at}: Save`);
    await noSidewaysScroll(own.page, `${at}: the logo editor`);
    await sheet.getByRole('button', { name: 'Zoom in' }).click();
    const afterPlus = await zoomOf(sheet);
    await pinch(frame);
    await expect.poll(() => zoomOf(sheet)).toBeGreaterThan(afterPlus + 0.5);
    await drag(own.page, frame, 300, 0);
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(own.page.getByText(`${name}'s logo is updated.`)).toBeVisible({ timeout: 30_000 });
    await expect(sheet).toHaveCount(0);
    const stored = (await pool.query(`SELECT logo_crop, md5(logo_source_blob) AS src FROM entities WHERE id = $1`, [entityId])).rows[0];
    expect(stored.src).not.toBeNull();
    expect(stored.logo_crop.zoom).toBeGreaterThan(1);
    expect(stored.logo_crop.x, 'dragged right: more of the red left half kept').toBeLessThan(0.5);
    const logoImg = `img[src*="/api/entities/${entityId}/logo?v="]`;
    await expect(own.page.locator(logoImg).first(), 'on the hero').toBeVisible({ timeout: LIVE });
    await expect(own.page.getByRole('button', { name: 'Change logo' })).toBeVisible();
    await expect(cla.page.locator(logoImg).first(), 'on the member\'s open page, without a reload').toBeVisible({ timeout: LIVE });

    // The banner, at 3:1.
    await own.page.getByTestId('entity-banner').getByRole('button', { name: 'Add banner' }).click();
    const bannerSheet = own.page.getByRole('dialog', { name: 'Add banner' });
    await bannerSheet.locator('input[type="file"]').setInputFiles({ name: 'wide.jpg', mimeType: 'image/jpeg', buffer: await halves(own.page, 2400, 1200) });
    await expect(bannerSheet.getByRole('slider', { name: 'Zoom' })).toBeVisible({ timeout: 20_000 });
    await drag(own.page, bannerSheet.getByTestId('picture-frame'), 0, -100);
    await bannerSheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(own.page.getByText(`${name}'s banner is updated.`)).toBeVisible({ timeout: 30_000 });
    await expect(own.page.getByTestId('entity-banner').locator(`img[src*="/api/entities/${entityId}/banner?v="]`)).toBeVisible({ timeout: LIVE });
    await expect(cla.page.getByTestId('entity-banner'), 'the member sees the banner too').toBeVisible({ timeout: LIVE });
    await noSidewaysScroll(own.page, `${at}: the page with a logo and a banner`);

    // ── Removal ────────────────────────────────────────────────────────────────────────────────────────────
    await expect(personCard(own.page, second)).toBeVisible();
    await expect(own.page.getByRole('button', { name: `Remove ${owner.displayName}` }), 'never on yourself').toHaveCount(0);
    const remove = own.page.getByRole('button', { name: `Remove ${second.displayName}` });
    await remove.scrollIntoViewIfNeeded();
    await expectReachable(own.page, remove, `${at}: Remove`);
    await tall(remove, `${at}: Remove`);
    await remove.click();
    const confirm = own.page.getByRole('dialog', { name: `Remove ${second.displayName}?` });
    await expect(confirm.getByTestId('confirm-dialog-body')).toContainText('They can ask to join again.');
    await confirm.getByTestId('confirm-dialog-confirm').click();
    await expect(personCard(own.page, second), 'gone from People at once').toHaveCount(0, { timeout: LIVE });
    expect((await pool.query(`SELECT status FROM entity_members WHERE entity_id = $1 AND user_id = $2`, [entityId, second.id])).rows[0].status).toBe('removed');

    // ── Circles ────────────────────────────────────────────────────────────────────────────────────────────
    const circles = own.page.getByTestId('entity-circles');
    await expect(circles.getByText('Not linked to a circle yet.', { exact: false })).toBeVisible();
    const circle = await pool.query(
      `INSERT INTO circles (name, created_by, member_count) VALUES ($1, $2, 1) RETURNING id`, [`T15 Circle ${run} ${width}`, manager.id]);
    const circleId = circle.rows[0].id as string;
    circleIds.push(circleId);
    await pool.query(`INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, 'owner')`, [circleId, manager.id]);
    expect((await api(manager, 'POST', `/circles/${circleId}/entities`, { entityId })).status).toBe(201);
    const linked = circles.locator(`[data-circle-id="${circleId}"]`);
    await expect(linked, 'the circle shows on the entity\'s page without a reload').toContainText(`T15 Circle ${run} ${width}`, { timeout: LIVE });
    await expect(linked).toContainText('1 member');

    // ── The card in the list ───────────────────────────────────────────────────────────────────────────────
    await gotoRetry(own.page, `${APP}/entities`);
    const card = own.page.locator(`section[aria-labelledby="your-entities-title"] a[data-entity-id="${entityId}"]`);
    await expect(card.locator(logoImg), 'the logo on the card').toBeVisible({ timeout: SLOW });
    await noSidewaysScroll(own.page, `${at}: the list with a logo`);
    expect(unexpected([...own.errors, ...cla.errors, ...claProfile.errors])).toEqual([]);
  });
}
