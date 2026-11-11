import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { APP, SERVER, cleanup, gotoRetry, idsOf, teardown } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';
import { acceptConfirmDialogs } from '../helpers/confirm-dialog';

// SHIRLEY PILOT S3: THE OWNER'S MANAGE MENU AND DISCOVERABLE MEMBERSHIPS (11 Nov 2026; brief RSN 11, RSN 14)
//
// A throwaway platform admin makes a circle and hands it to a throwaway PLAIN member ("A", the owner, as Shirley). A
// makes a Public with approval pod and a private pod in it, a Public open pod, a moderator, a pod host, and a member who
// shares the private pod. Then:
//   1. the owner (1280px) sees every Manage entry of the circle; Members scrolls to the members; Edit details opens;
//   2. the moderator (360px) gets the entries as a bottom sheet, every one inside the screen, and no Visibility; Escape
//      closes it; a plain member has no Manage button;
//   3. on the approval pod: the director has every entry, the host (360px) Members, Invitations, Events and Moderation
//      only, a plain pod member none;
//   4. a stranger B (360px) opens A's profile: A's approval pod with "Request to join" and the open circle with "Join",
//      never A's private pod (on screen or in the answer); B asks, and the row says Requested without a reload; the
//      member who shares the private pod is sent it; someone removed from the open pod gets no Join;
//   5. A turns "Show my communities on my profile" off: B is sent nothing, and A's preview says why; back on;
//   6. a block either way: 404.
// Throwaway accounts (@rsn-e2e.invalid), the spec's own circle and pods, deleted by id at the end.

const RUN = `s3${Date.now().toString(36)}`;
const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
let browser: Browser;
let admin: TestUser | undefined, owner: TestUser | undefined, mod: TestUser | undefined, member: TestUser | undefined;
let host: TestUser | undefined, sharer: TestUser | undefined, stranger: TestUser | undefined, removed: TestUser | undefined;
let circleId = '';
let podAppr = '';
let podPriv = '';
let podOpen = '';
const CIRCLE = `${RUN} Curious Humans`;
const contexts: BrowserContext[] = [];

async function throwaway(label: string, role: 'member' | 'admin' = 'member'): Promise<TestUser> {
  const u = await createTestUser(`s3${label}`, role);
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
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function signedIn(user: TestUser, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext(contextOptions(viewport));
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
async function fitsViewport(page: Page, locator: ReturnType<Page['getByTestId']>) {
  await expect(locator).toBeVisible({ timeout: 20_000 });
  const box = await locator.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box, 'the control has a box').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

/** No sideways scroll on the page. */
async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'the page does not scroll sideways').toBeLessThanOrEqual(1);
}

const communitiesOf = async (viewer: TestUser, target: TestUser) => api(viewer, 'GET', `/people/${target.id}/communities?limit=50`);

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  browser = await launchBrowser();
  admin = await throwaway('Admin', 'admin');
  owner = await throwaway('Owner');
  mod = await throwaway('Moderator');
  member = await throwaway('Member');
  host = await throwaway('Host');
  sharer = await throwaway('Sharer');
  stranger = await throwaway('Stranger');
  removed = await throwaway('Removed');
  const made = await api(admin, 'POST', '/circles', { name: CIRCLE, description: 'A broad, open circle.' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  circleId = made.json.data.id;
  for (const who of [owner, mod, member]) expect((await api(who, 'POST', `/circles/${circleId}/join`)).status).toBe(200);
  expect((await api(admin, 'POST', `/circles/${circleId}/transfer`, { toUserId: owner.id })).status).toBe(200);
  expect((await api(owner, 'PATCH', `/circles/${circleId}/members/${mod.id}/role`, { role: 'moderator' })).status).toBe(200);
  // The admin who made it leaves, so the circle is run by plain members only.
  expect((await api(admin, 'POST', `/circles/${circleId}/leave`)).status).toBe(200);

  const pod = async (name: string, visibility: string, inCircle: boolean) => {
    const res = await api(owner!, 'POST', '/pods', { name, podType: 'chat', visibility, ...(inCircle ? { circleId } : {}) });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.data.id as string;
  };
  podAppr = await pod(`${RUN} Curious 12`, 'public_with_approval', true);
  podPriv = await pod(`${RUN} Human Edge`, 'private', true);
  podOpen = await pod(`${RUN} Open Breakfast`, 'public', false);
  expect((await api(owner, 'POST', `/pods/${podAppr}/members`, { userId: host.id, role: 'host' })).status).toBe(201);
  expect((await api(owner, 'POST', `/pods/${podAppr}/members`, { userId: member.id, role: 'member' })).status).toBe(201);
  expect((await api(owner, 'POST', `/pods/${podPriv}/members`, { userId: sharer.id, role: 'member' })).status).toBe(201);
  expect((await api(removed, 'POST', `/pods/${podOpen}/join`)).status).toBe(201);
  expect((await api(owner, 'DELETE', `/pods/${podOpen}/members/${removed.id}`)).status).toBe(200);
});

test.afterAll(async () => {
  await teardown(
    ...contexts.map((c) => () => c.close()),
    () => browser?.close(),
    () => (owner && stranger ? pool.query(`DELETE FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`, [owner.id, stranger.id]) : Promise.resolve()),
    () => (circleId ? pool.query(`DELETE FROM invites WHERE circle_id = $1`, [circleId]) : Promise.resolve()),
    () => (circleId ? pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]) : Promise.resolve()),
    () => (podPriv ? cleanup(pool, { ids: [], podId: podPriv }) : Promise.resolve()),
    () => (podOpen ? cleanup(pool, { ids: [], podId: podOpen }) : Promise.resolve()),
    // The pods by their ids, then the people by theirs: never by a name.
    () => cleanup(pool, { ids: idsOf(admin, owner, mod, member, host, sharer, stranger, removed), podId: podAppr || undefined }),
  );
});

test(`the Manage menu shows each role its own entries, and a profile names only the spaces the viewer may see (${engineLabel()})`, async () => {
  test.setTimeout(360_000);
  const a = owner!; const b = stranger!;

  // ── 1. The owner, 1280px: every entry of the circle ─────────────────────────────────────────────────────────
  const op = await signedIn(a, { width: 1280, height: 900 });
  await gotoRetry(op, `${APP}/circles/${circleId}`);
  await op.getByTestId('manage-open').click();
  const ownerMenu = op.getByTestId('manage-menu');
  for (const id of ['circle-edit', 'manage-members', 'circle-invitations', 'manage-pods', 'manage-events', 'circle-settings', 'manage-moderation', 'circle-export']) {
    await expect(ownerMenu.getByTestId(id), `owner sees ${id}`).toBeVisible();
  }
  await expect(ownerMenu.getByTestId('circle-settings')).toContainText('Now: Open.');
  await ownerMenu.getByTestId('manage-members').click();
  await expect(op.getByTestId('manage-menu')).toHaveCount(0);
  await expect(op.getByTestId('circle-members')).toBeInViewport({ timeout: 10_000 });
  await op.getByTestId('manage-open').click();
  await op.getByTestId('circle-edit').click();
  await expect(op.getByTestId('circle-edit-form')).toBeVisible({ timeout: 10_000 });
  await op.keyboard.press('Escape');
  await expect(op.getByTestId('circle-edit-form')).toHaveCount(0);

  // ── 2. The moderator at 360: a bottom sheet, no Visibility; a plain member: no Manage at all ─────────────────
  const mp = await signedIn(mod!, { width: 360, height: 780 });
  await gotoRetry(mp, `${APP}/circles/${circleId}`);
  await fitsViewport(mp, mp.getByTestId('manage-open'));
  await mp.getByTestId('manage-open').click();
  const sheet = mp.getByRole('dialog', { name: `Manage ${CIRCLE}` });
  await expect(sheet).toBeVisible();
  for (const id of ['circle-edit', 'manage-members', 'circle-invitations', 'manage-pods', 'manage-events', 'manage-moderation', 'circle-export']) {
    await fitsViewport(mp, sheet.getByTestId(id));
  }
  await expect(sheet.getByTestId('circle-settings'), 'Visibility is the owner\'s alone').toHaveCount(0);
  await mp.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await noSideScroll(mp);
  const memberPage = await signedIn(member!, { width: 360, height: 780 });
  await gotoRetry(memberPage, `${APP}/circles/${circleId}`);
  await expect(memberPage.getByTestId(`circle-join-${circleId}`)).toHaveText('Leave', { timeout: 30_000 });
  await expect(memberPage.getByTestId('manage-open'), 'a member has no Manage').toHaveCount(0);

  // ── 3. The approval pod: director, host, member ─────────────────────────────────────────────────────────────
  await gotoRetry(op, `${APP}/pods/${podAppr}`);
  await op.getByTestId('manage-open').click();
  for (const id of ['pod-edit', 'manage-members', 'manage-invitations', 'manage-circles', 'manage-events', 'manage-visibility', 'manage-moderation', 'pod-export', 'manage-duplicate', 'manage-archive']) {
    await expect(op.getByTestId('manage-menu').getByTestId(id), `director sees ${id}`).toBeVisible({ timeout: 20_000 });
  }
  await op.keyboard.press('Escape');
  const hp = await signedIn(host!, { width: 360, height: 780 });
  await gotoRetry(hp, `${APP}/pods/${podAppr}`);
  await fitsViewport(hp, hp.getByTestId('manage-open'));
  await hp.getByTestId('manage-open').click();
  const hostSheet = hp.getByTestId('manage-menu');
  for (const id of ['manage-members', 'manage-invitations', 'manage-events', 'manage-moderation', 'pod-export']) await fitsViewport(hp, hostSheet.getByTestId(id));
  for (const id of ['pod-edit', 'manage-visibility', 'manage-duplicate', 'manage-archive']) await expect(hostSheet.getByTestId(id)).toHaveCount(0);
  await hp.keyboard.press('Escape');
  await gotoRetry(memberPage, `${APP}/pods/${podAppr}`);
  await expect(memberPage.getByTestId('pod-leave')).toBeVisible({ timeout: 30_000 });
  await expect(memberPage.getByTestId('manage-open')).toHaveCount(0);

  // ── 4. A stranger opens A's profile at 360 ──────────────────────────────────────────────────────────────────
  const seen = await communitiesOf(b, a);
  expect(seen.status).toBe(200);
  const rows = seen.json.data.items as Array<{ id: string; action: string; access: string }>;
  expect(rows.find((r) => r.id === podAppr)?.action).toBe('request');
  expect(rows.find((r) => r.id === circleId)?.action).toBe('join');
  expect(rows.find((r) => r.id === podOpen)?.action).toBe('join');
  expect(JSON.stringify(seen.json), 'the private pod is never named to a stranger').not.toContain(podPriv);
  const bp = await signedIn(b, { width: 360, height: 780 });
  await gotoRetry(bp, `${APP}/people/${a.id}`);
  const section = bp.getByTestId('profile-communities');
  await expect(section).toBeVisible({ timeout: 30_000 });
  const apprRow = section.getByTestId(`community-pod-${podAppr}`);
  await expect(apprRow).toContainText(`${RUN} Curious 12`);
  await expect(apprRow.getByTestId('community-action')).toHaveText('Request to join');
  await fitsViewport(bp, apprRow.getByTestId('community-action'));
  await expect(section.getByTestId(`community-circle-${circleId}`).getByTestId('community-action')).toHaveText('Join');
  await expect(bp.getByText(`${RUN} Human Edge`)).toHaveCount(0);
  await noSideScroll(bp);
  await apprRow.getByTestId('community-action').click();
  await expect(apprRow.getByTestId('community-waiting'), 'Requested, without a reload').toHaveText('Requested', { timeout: 20_000 });

  // The member who shares the private pod is sent it; the removed member gets no Join on the open pod.
  const shared = (await communitiesOf(sharer!, a)).json.data.items as Array<{ id: string; action: string; access: string }>;
  expect(shared.find((r) => r.id === podPriv)).toMatchObject({ action: 'open', access: 'members' });
  const asRemoved = (await communitiesOf(removed!, a)).json.data.items as Array<{ id: string; action: string }>;
  expect(asRemoved.find((r) => r.id === podOpen)?.action).toBe('none');
  expect((await api(removed!, 'POST', `/pods/${podOpen}/join`)).status, 'and the join route agrees').toBe(403);

  // ── 5. A turns the setting off: nothing for B, and A's preview says why; then back on ───────────────────────
  const ap = await signedIn(a, { width: 360, height: 780 });
  await gotoRetry(ap, `${APP}/settings`);
  await expect(ap.getByText('Show my communities on my profile')).toBeVisible({ timeout: 30_000 });
  expect((await api(a, 'PUT', '/users/me', { showCommunities: false })).status).toBe(200);
  expect((await communitiesOf(b, a)).json.data).toEqual({ items: [], total: 0, nextOffset: null });
  expect((await communitiesOf(sharer!, a)).json.data.total, 'not even to someone who shares a space').toBe(0);
  await gotoRetry(ap, `${APP}/profile/preview`);
  await expect(ap.getByTestId('communities-preview-empty')).toContainText('You turned off', { timeout: 30_000 });
  expect((await api(a, 'PUT', '/users/me', { showCommunities: true })).status).toBe(200);
  await expect(ap.getByTestId('profile-communities'), 'the preview follows the setting without a reload').toBeVisible({ timeout: 30_000 });
  await expect(ap.getByText(`${RUN} Human Edge`), 'the preview is what a stranger sees').toHaveCount(0);

  // ── 6. Blocks either way: the unknown-member 404 ───────────────────────────────────────────────────────────
  expect((await api(b, 'POST', `/users/${a.id}/block`)).status).toBeLessThan(300);
  expect((await communitiesOf(b, a)).status).toBe(404);
  expect((await communitiesOf(a, b)).status).toBe(404);
  expect((await api(b, 'DELETE', `/users/${a.id}/block`)).status).toBeLessThan(300);
  expect((await communitiesOf(b, a)).status).toBe(200);
});
