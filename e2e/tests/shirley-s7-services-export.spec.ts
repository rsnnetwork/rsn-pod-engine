import { test, expect, type Browser, type BrowserContext, type Page, type Locator, type Download } from '@playwright/test';
import * as fs from 'fs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { APP, SERVER, cleanup, gotoRetry, idsOf, teardown } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';
import { acceptConfirmDialogs } from '../helpers/confirm-dialog';

// SHIRLEY PILOT S7: ENTITY SERVICES, ORGANISER EXPORT, SEARCH HELP (11 Nov 2026; brief RSN 15, items 20 and 21; D6)
//
// 1. Services live on an Entity. A throwaway member makes an entity (its admin) and another is approved into it as a
//    plain member. The admin adds two services through the route; the plain member is refused (403) and a javascript:
//    website is refused (400). At 360px the member's open entity page shows both services and no editor; the admin,
//    at 360px, adds a third in the editor sheet (which fits the phone, no sideways scroll), and the member's page shows
//    it without a reload. No profile shows services.
// 2. An organiser exports. A throwaway admin makes a circle and hands it to a throwaway plain member (the owner, as
//    Shirley); the owner makes a private pod in it. The owner downloads members.csv (BOM, no email address, the
//    owner's name), and the download is in the access log; a plain member is refused (403), someone outside the
//    private pod gets its 404, a second platform admin with no role is refused (403). At 360px the owner's Export
//    button fits and its sheet saves a file named by date only; the plain member has no Export button. Fix round 1:
//    the admin archives the circle; the owner still downloads members.csv (Status Archived in space.csv), the plain
//    member and the role-less admin get 404, and at 360px the owner's Circles page lists it under "Circles you ran
//    (archived)" with an Export that saves members.csv; the member's page does not.
// 3. Find people says where "your searches" came from, with a 44px link to them, at 360px.
// Throwaway accounts (@rsn-e2e.invalid), the spec's own entity, circle and pod, deleted by id at the end.

const RUN = `s7${Date.now().toString(36)}`;
const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const PHONE = { width: 360, height: 780 };
let browser: Browser;
let entityAdmin: TestUser | undefined, entityMember: TestUser | undefined;
let admin: TestUser | undefined, otherAdmin: TestUser | undefined, owner: TestUser | undefined, member: TestUser | undefined;
let entityId = '';
let circleId = '';
let podId = '';
const contexts: BrowserContext[] = [];

/** A throwaway on the reserved test domain whose token carries that address. */
async function throwaway(label: string, role: 'member' | 'admin' = 'member'): Promise<TestUser> {
  const u = await createTestUser(`s7${label}`, role);
  const name = `${RUN} ${label}`;
  const address = `${u.id}@rsn-e2e.invalid`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3 WHERE id = $1`, [u.id, address, name]);
  const sessionId = uuid();
  return {
    ...u, email: address, displayName: name,
    accessToken: jwt.sign({ sub: u.id, email: address, role, displayName: name, sessionId }, SECRET, { expiresIn: '1h' }),
    refreshToken: jwt.sign({ sub: u.id, sessionId, type: 'refresh' }, SECRET, { expiresIn: '1d' }),
  };
}

async function api(who: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // The raw bytes, as they came: res.text() decodes UTF-8 the WHATWG way, which DROPS a leading byte-order mark, so a
  // CSV's BOM can only be seen in the bytes (the event report spec's lesson, p3-event-report-api.spec.ts).
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a CSV file, not JSON */ }
  return { status: res.status, json, text, bytes, headers: res.headers };
}

/**
 * A CSV as bytes: it starts with the UTF-8 BOM EF BB BF (so Excel reads non-ASCII names right), and its text after the
 * BOM is returned for the content checks.
 */
function csvAfterBom(bytes: Buffer, label: string): string {
  expect([...bytes.subarray(0, 3)], `${label} starts with the UTF-8 BOM`).toEqual([0xef, 0xbb, 0xbf]);
  return bytes.subarray(3).toString('utf8');
}

/** A file the browser saved: the same bytes the server sent (BOM included), never re-encoded. */
async function savedCsv(download: Download, label: string): Promise<string> {
  const saved = await download.path();
  expect(saved, `${label} was saved`).toBeTruthy();
  return csvAfterBom(fs.readFileSync(saved!), label);
}

async function signedIn(user: TestUser, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ ...contextOptions(viewport), acceptDownloads: true });
  contexts.push(ctx);
  await ctx.addInitScript((t) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await ctx.newPage();
  await acceptConfirmDialogs(page);
  return page;
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

/** The page never scrolls sideways. */
async function noSidewaysScroll(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll).toBeLessThanOrEqual(width + 1);
}

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  browser = await launchBrowser();
  entityAdmin = await throwaway('EntityAdmin');
  entityMember = await throwaway('EntityMember');
  admin = await throwaway('Admin', 'admin');
  otherAdmin = await throwaway('OtherAdmin', 'admin');
  owner = await throwaway('Owner');
  member = await throwaway('Member');

  // The entity, its admin, and an approved plain member.
  const made = await api(entityAdmin, 'POST', '/entities', { name: `${RUN} Curious Humans Ltd`, kind: 'company', role: 'founder' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  entityId = made.json.data.id;
  expect((await api(entityMember, 'POST', `/entities/${entityId}/members`, { role: 'employee' })).status).toBe(200);
  expect((await api(entityAdmin, 'POST', `/entities/${entityId}/members/${entityMember.id}/approve`)).status).toBe(200);

  // The circle, handed to a plain member (as Shirley), with a private pod in it.
  const circle = await api(admin, 'POST', '/circles', { name: `${RUN} Curious Humans`, description: 'A broad circle.' });
  expect(circle.status, JSON.stringify(circle.json)).toBe(201);
  circleId = circle.json.data.id;
  for (const who of [owner, member]) expect((await api(who, 'POST', `/circles/${circleId}/join`)).status).toBe(200);
  expect((await api(admin, 'POST', `/circles/${circleId}/transfer`, { toUserId: owner.id })).status).toBe(200);
  const pod = await api(owner, 'POST', '/pods', { name: `${RUN} Human Edge`, podType: 'chat', visibility: 'private', circleId });
  expect(pod.status, JSON.stringify(pod.json)).toBe(201);
  podId = pod.json.data.id;
});

test.afterAll(async () => {
  await teardown(
    ...contexts.map((c) => () => c.close()),
    () => browser?.close(),
    // The spec's own rows, by their ids: the entity (its links and services go with it), the circle, then the pod and
    // the people (cleanup removes their own access-log rows, as every spec's throwaways).
    () => (entityId ? pool.query(`DELETE FROM entities WHERE id = $1`, [entityId]) : Promise.resolve()),
    () => (circleId ? pool.query(`DELETE FROM invites WHERE circle_id = $1`, [circleId]) : Promise.resolve()),
    () => (circleId ? pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]) : Promise.resolve()),
    () => cleanup(pool, { ids: idsOf(entityAdmin, entityMember, admin, otherAdmin, owner, member), podId: podId || undefined }),
  );
});

test(`services live on the entity: its admin edits them, a member cannot, and they show live at 360px (${engineLabel()})`, async () => {
  test.setTimeout(240_000);
  const ea = entityAdmin!; const em = entityMember!;

  // ── The route ──────────────────────────────────────────────────────────────────────────────────────────────
  const two = { services: [
    { category: 'coaching', description: 'One to one coaching for founders.', website: 'curioushumans.example.com/coaching' },
    { category: 'events', description: null, website: null },
  ] };
  const saved = await api(ea, 'PUT', `/entities/${entityId}/services`, two);
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  expect(saved.json.data.services[0].website).toBe('https://curioushumans.example.com/coaching');
  const refused = await api(em, 'PUT', `/entities/${entityId}/services`, { services: [] });
  expect(refused.status).toBe(403);
  const js = await api(ea, 'PUT', `/entities/${entityId}/services`, { services: [{ category: 'legal', website: 'javascript:alert(1)' }] });
  expect(js.status).toBe(400);
  const page = await api(em, 'GET', `/entities/${entityId}`);
  expect(page.json.data.services.map((s: { category: string }) => s.category)).toEqual(['coaching', 'events']);
  // People stay about people: a member's profile carries no services.
  const card = await api(ea, 'GET', `/users/${em.id}`);
  expect(JSON.stringify(card.json)).not.toMatch(/"services"/);

  // ── The screens at 360px ─────────────────────────────────────────────────────────────────────────────────
  const mp = await signedIn(em, PHONE);
  await gotoRetry(mp, `${APP}/entities/${entityId}`);
  const section = mp.getByTestId('entity-services');
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText('Coaching', { exact: true })).toBeVisible();
  await expect(section.getByText('Events', { exact: true })).toBeVisible();
  await expect(mp.getByTestId('entity-services-edit')).toHaveCount(0);
  await noSidewaysScroll(mp);

  const ap = await signedIn(ea, PHONE);
  await gotoRetry(ap, `${APP}/entities/${entityId}`);
  const edit = ap.getByTestId('entity-services-edit');
  await fitsViewport(ap, edit);
  await edit.click();
  const form = ap.getByTestId('entity-services-form');
  await expect(form).toBeVisible();
  await ap.getByLabel('Legal', { exact: true }).check();
  await noSidewaysScroll(ap);
  const saveButton = ap.getByRole('button', { name: 'Save services' });
  await fitsViewport(ap, saveButton);
  await saveButton.click();
  await expect(form).toHaveCount(0, { timeout: 20_000 });
  // The member's page, never reloaded, gains it.
  await expect(section.getByText('Legal', { exact: true })).toBeVisible({ timeout: 30_000 });
});

test(`an organiser exports members (no emails, logged first); others are refused; Export fits 360px (${engineLabel()})`, async () => {
  test.setTimeout(240_000);
  const o = owner!; const m = member!;

  // ── The route ──────────────────────────────────────────────────────────────────────────────────────────────
  const file = await api(o, 'GET', `/circles/${circleId}/export?section=members`);
  expect(file.status).toBe(200);
  expect(file.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="reason-circle-members-\d{4}-\d{2}-\d{2}\.csv"$/);
  expect(file.headers.get('cache-control')).toBe('no-store');
  const members = csvAfterBom(file.bytes, 'members.csv');
  expect(members.startsWith('Name,Role,Joined\r\n')).toBe(true);
  expect(members).toContain(`${RUN} Owner,Owner,`);
  expect(members).toContain(`${RUN} Member,Member,`);
  expect(members).not.toMatch(/@rsn-e2e\.invalid|@/);
  const logged = await pool.query(
    `SELECT details FROM audit_log WHERE action = 'space.export_downloaded' AND entity_type = 'circle' AND entity_id = $1 AND actor_id = $2`,
    [circleId, o.id]);
  expect(logged.rows.length).toBeGreaterThanOrEqual(1);
  expect(logged.rows[0].details).toMatchObject({ section: 'members', role: 'owner' });

  expect((await api(m, 'GET', `/circles/${circleId}/export?section=members`)).status).toBe(403);
  expect((await api(otherAdmin!, 'GET', `/circles/${circleId}/export?section=members`)).status).toBe(403);
  expect((await api(o, 'GET', `/circles/${circleId}/export?section=emails`)).status).toBe(400);
  expect((await api(o, 'GET', `/pods/${podId}/export?section=space`)).status).toBe(200);
  expect((await api(m, 'GET', `/pods/${podId}/export?section=members`)).status).toBe(404);
  expect((await api(otherAdmin!, 'GET', `/pods/${podId}/export?section=members`)).status).toBe(403);

  // ── The screens at 360px ─────────────────────────────────────────────────────────────────────────────────
  const op = await signedIn(o, PHONE);
  await gotoRetry(op, `${APP}/circles/${circleId}`);
  // Shirley pilot S3: Export is an entry of the circle's Manage menu (a bottom sheet at this width).
  await fitsViewport(op, op.getByTestId('manage-open'));
  await op.getByTestId('manage-open').click();
  const exportButton = op.getByTestId('circle-export');
  await fitsViewport(op, exportButton);
  await exportButton.click();
  await expect(op.getByTestId('space-export-sheet')).toBeVisible();
  await expect(op.getByText(/Never included: email addresses/)).toBeVisible();
  await noSidewaysScroll(op);
  const membersButton = op.getByTestId('space-export-members');
  await fitsViewport(op, membersButton);
  const [download] = await Promise.all([op.waitForEvent('download', { timeout: 30_000 }), membersButton.click()]);
  expect(download.suggestedFilename()).toMatch(/^reason-circle-members-\d{4}-\d{2}-\d{2}\.csv$/);
  const saved = await savedCsv(download, 'the downloaded members.csv');
  expect(saved.startsWith('Name,Role,Joined\r\n')).toBe(true);
  expect(saved).toContain(`${RUN} Owner,Owner,`);
  expect(saved).not.toMatch(/@/);

  const mp = await signedIn(m, PHONE);
  await gotoRetry(mp, `${APP}/circles/${circleId}`);
  await expect(mp.getByTestId(`circle-join-${circleId}`)).toBeVisible({ timeout: 30_000 });
  // A plain member has no Manage menu, so no Export.
  await expect(mp.getByTestId('manage-open')).toHaveCount(0);
  await expect(mp.getByTestId('circle-export')).toHaveCount(0);

  // The pod's director (the owner made it) has Export there too, in the pod's Manage menu.
  await gotoRetry(op, `${APP}/pods/${podId}`);
  await op.getByTestId('manage-open').click();
  await fitsViewport(op, op.getByTestId('pod-export'));
  await op.keyboard.press('Escape');

  // ── Fix round 1: an ARCHIVED circle stays exportable by its owner (and moderators); anyone else gets 404 ──────
  expect((await api(admin!, 'POST', `/circles/${circleId}/archive`)).status).toBe(200);
  const archivedFile = await api(o, 'GET', `/circles/${circleId}/export?section=members`);
  expect(archivedFile.status).toBe(200);
  const archivedMembers = csvAfterBom(archivedFile.bytes, 'the archived circle\'s members.csv');
  expect(archivedMembers).toContain(`${RUN} Owner,Owner,`);
  expect(archivedMembers).not.toMatch(/@/);
  const archivedSpace = await api(o, 'GET', `/circles/${circleId}/export?section=space`);
  expect(archivedSpace.status).toBe(200);
  expect(csvAfterBom(archivedSpace.bytes, 'the archived circle\'s space.csv')).toContain('\r\nStatus,Archived\r\n');
  expect((await api(m, 'GET', `/circles/${circleId}/export?section=members`)).status).toBe(404);
  expect((await api(otherAdmin!, 'GET', `/circles/${circleId}/export?section=members`)).status).toBe(404);
  const ran = await api(o, 'GET', '/circles/archived/mine');
  expect(ran.status).toBe(200);
  expect(ran.json.data.map((c: { id: string }) => c.id)).toContain(circleId);
  expect((await api(m, 'GET', '/circles/archived/mine')).json.data.map((c: { id: string }) => c.id)).not.toContain(circleId);
  // At 360px the Circles page lists it under "Circles you ran (archived)", and its Export saves members.csv.
  await gotoRetry(op, `${APP}/circles`);
  const archivedExport = op.getByTestId(`circle-archived-export-${circleId}`);
  await fitsViewport(op, archivedExport);
  await noSidewaysScroll(op);
  await archivedExport.click();
  const archivedMembersButton = op.getByTestId('space-export-members');
  await fitsViewport(op, archivedMembersButton);
  const [archivedDownload] = await Promise.all([op.waitForEvent('download', { timeout: 30_000 }), archivedMembersButton.click()]);
  expect(archivedDownload.suggestedFilename()).toMatch(/^reason-circle-members-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(await savedCsv(archivedDownload, 'the archived circle\'s downloaded members.csv')).toContain(`${RUN} Owner,Owner,`);
  // The plain member's Circles page has no such section.
  await gotoRetry(mp, `${APP}/circles`);
  await expect(mp.getByTestId(`circle-archived-export-${circleId}`)).toHaveCount(0);
});

test(`Find people says where your searches came from, with a link to them, at 360px (${engineLabel()})`, async () => {
  test.setTimeout(120_000);
  const mp = await signedIn(member!, PHONE);
  await gotoRetry(mp, `${APP}/search`);
  const help = mp.getByTestId('search-help');
  await expect(help).toBeVisible({ timeout: 30_000 });
  await expect(help).toContainText(/search/i);
  await expect(help).not.toContainText(/agent/i);
  const link = help.getByRole('link');
  await fitsViewport(mp, link);
  await expect(link).toHaveAttribute('href', '/agents');
  await noSidewaysScroll(mp);
  await link.click();
  await expect(mp.getByRole('heading', { name: 'Your searches' })).toBeVisible({ timeout: 30_000 });
});
