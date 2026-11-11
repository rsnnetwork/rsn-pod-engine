import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { APP, SERVER, cleanup, gotoRetry, idsOf, teardown } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';
import { acceptConfirmDialogs } from '../helpers/confirm-dialog';

// SHIRLEY PILOT S2: COMMUNITY AUTHORITY AND PRIVATE-SPACE SAFETY (11 Nov 2026; brief RSN 02/03/04, acceptance 01/02)
//
// A throwaway platform admin makes a circle and hands it, through the new handover route, to a throwaway PLAIN member
// ("the owner", as Shirley will be). The owner, with no admin rights, then:
//   1. adds two private pods to the circle (as Curious 12 and Human Edge Collective);
//   2. on the circle page (1280px) makes a member a moderator, and the moderator's own page (360px, never reloaded)
//      gains the managers' controls; then hands the circle to that moderator (a confirm names what changes): the
//      owner's page loses "Who can join" and the new owner's page says "You own this circle", both without a reload;
//      the old owner is refused a role change afterwards (403);
//   3. invites a fresh address to the first private pod; the person with that address accepts and is sent to that pod,
//      reads it at 360px, and gets "Pod not found" (404) for the other private pod, whose members, events count, rules
//      and circles are refused too;
//   4. adds and then removes a member from the first pod: the removed member is refused its overview (404).
// Throwaway accounts (@rsn-e2e.invalid), the spec's own circle, pods and invites, deleted by id at the end.

const RUN = `s2${Date.now().toString(36)}`;
const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
let browser: Browser;
let admin: TestUser | undefined, owner: TestUser | undefined, mod: TestUser | undefined;
let invitee: TestUser | undefined, removed: TestUser | undefined;
let circleId = '';
let podA = '';
let podB = '';
const contexts: BrowserContext[] = [];

/** A throwaway on the reserved test domain whose token carries that address (accepting an invite checks it). */
async function throwaway(label: string, role: 'member' | 'admin' = 'member', email?: string): Promise<TestUser> {
  const u = await createTestUser(`s2${label}`, role);
  const name = `${RUN} ${label}`;
  const address = email ?? `${u.id}@rsn-e2e.invalid`;
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

/** A control is on screen and wholly inside the viewport (isVisible alone misses a control pushed off the side). */
async function fitsViewport(page: Page, locator: ReturnType<Page['getByTestId']>) {
  await expect(locator).toBeVisible({ timeout: 20_000 });
  const box = await locator.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box, 'the control has a box').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  browser = await launchBrowser();
  admin = await throwaway('Admin', 'admin');
  owner = await throwaway('Owner');
  mod = await throwaway('Moderator');
  removed = await throwaway('Removed');
  // Production's admin makes the circle (POST /circles is admin-only) and is its owner.
  const made = await api(admin, 'POST', '/circles', { name: `${RUN} Curious Humans`, description: 'A broad, open circle.' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  circleId = made.json.data.id;
  for (const who of [owner, mod, removed]) expect((await api(who, 'POST', `/circles/${circleId}/join`)).status).toBe(200);
  // The handover through the code (the S9 data step's route): the admin hands the circle to the plain member.
  const handed = await api(admin, 'POST', `/circles/${circleId}/transfer`, { toUserId: owner.id });
  expect(handed.status, JSON.stringify(handed.json)).toBe(200);
  expect(handed.json.data).toEqual({ ownerId: owner.id, previousOwnerId: admin.id });
});

test.afterAll(async () => {
  await teardown(
    ...contexts.map((c) => () => c.close()),
    () => browser?.close(),
    () => (circleId ? pool.query(`DELETE FROM invites WHERE circle_id = $1`, [circleId]) : Promise.resolve()),
    () => (podA ? pool.query(`DELETE FROM invites WHERE pod_id = $1`, [podA]) : Promise.resolve()),
    () => (podB ? pool.query(`DELETE FROM invites WHERE pod_id = $1`, [podB]) : Promise.resolve()),
    () => (circleId ? pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]) : Promise.resolve()),
    () => (podB ? cleanup(pool, { ids: [], podId: podB }) : Promise.resolve()),
    // The pods by their ids, then the people by theirs: never by a name.
    () => cleanup(pool, { ids: idsOf(admin, owner, mod, invitee, removed), podId: podA || undefined }),
  );
});

test(`an owner with no admin rights runs the circle, hands it over, and private pods stay private (${engineLabel()})`, async () => {
  test.setTimeout(360_000);
  const o = owner!; const m = mod!; const r = removed!;

  // ── 1. Two private pods in the circle, made by the owner (a plain member) ───────────────────────────────────
  for (const [name, set] of [[`${RUN} Curious 12`, (id: string) => { podA = id; }], [`${RUN} Human Edge`, (id: string) => { podB = id; }]] as const) {
    const made = await api(o, 'POST', '/pods', { name, podType: 'chat', visibility: 'private', circleId });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    set(made.json.data.id);
  }
  // "Invite only" is retired: asking for it is a 400.
  expect((await api(o, 'POST', '/pods', { name: `${RUN} nope`, visibility: 'invite_only' })).status).toBe(400);

  // ── 2. Roles on the circle page: the owner at 1280, the moderator-to-be at 360 (never reloaded) ───────────────
  const op = await signedIn(o, { width: 1280, height: 900 });
  const mp = await signedIn(m, { width: 360, height: 780 });
  await gotoRetry(op, `${APP}/circles/${circleId}`);
  await expect(op.getByTestId(`circle-owner-${circleId}`)).toHaveText('You own this circle', { timeout: 30_000 });
  await expect(op.getByTestId('circle-edit')).toBeVisible();
  await expect(op.getByTestId('circle-invitations')).toBeVisible();
  await expect(op.getByTestId('circle-settings')).toBeVisible();
  // Both private pods are named to their director, marked Private.
  await expect(op.getByTestId(`circle-pod-badge-${podA}`)).toHaveText('Private');
  await gotoRetry(mp, `${APP}/circles/${circleId}`);
  await expect(mp.getByTestId(`circle-join-${circleId}`)).toHaveText('Leave', { timeout: 30_000 });
  await expect(mp.getByTestId('circle-edit')).toHaveCount(0);
  // A plain member is not shown the private pods at all.
  await expect(mp.getByText(`${RUN} Human Edge`)).toHaveCount(0);

  await op.getByTestId(`circle-member-manage-${m.id}`).click();
  await op.getByTestId('circle-member-action-make-moderator').click();
  await expect(op.getByTestId(`circle-role-${m.id}`)).toHaveText('MOD', { timeout: 20_000 });
  // The moderator's page flips without a reload: the managers' controls appear, Who can join does not.
  await expect(mp.getByTestId('circle-edit')).toBeVisible({ timeout: 30_000 });
  await expect(mp.getByTestId('circle-settings')).toHaveCount(0);
  await fitsViewport(mp, mp.getByTestId('circle-invitations'));

  // The handover, with its confirm (answered by acceptConfirmDialogs).
  await op.getByTestId(`circle-member-manage-${m.id}`).click();
  await op.getByTestId('circle-member-action-make-owner').click();
  await expect(op.getByTestId(`circle-role-${m.id}`)).toHaveText('OWNER', { timeout: 20_000 });
  await expect(op.getByTestId(`circle-role-${o.id}`)).toHaveText('MOD', { timeout: 20_000 });
  await expect(op.getByTestId('circle-settings')).toHaveCount(0, { timeout: 20_000 });
  await expect(mp.getByTestId(`circle-owner-${circleId}`)).toHaveText('You own this circle', { timeout: 30_000 });
  // The old owner now has a moderator's rights only.
  expect((await api(o, 'PATCH', `/circles/${circleId}/members/${r.id}/role`, { role: 'moderator' })).status).toBe(403);
  expect((await api(o, 'POST', `/circles/${circleId}/transfer`, { toUserId: r.id })).status).toBe(403);
  expect((await api(o, 'POST', `/circles/${circleId}/leave`)).status).toBe(200);
  // ...and the new owner cannot leave without handing it on.
  const stay = await api(m, 'POST', `/circles/${circleId}/leave`);
  expect(stay.status).toBe(400);
  expect(stay.json.error.message).toBe('Hand the circle to someone else before you leave it.');
  // At 360 the new owner's Manage button on a member row fits the screen.
  await fitsViewport(mp, mp.getByTestId(`circle-member-manage-${r.id}`));

  // ── 3. A fresh address invited to the first private pod lands there, and never sees the other ──────────────
  const address = `s2-fresh-${RUN}@rsn-e2e.invalid`;
  const invite = await api(o, 'POST', '/invites', { type: 'pod', podId: podA, inviteeEmail: address });
  expect(invite.status, JSON.stringify(invite.json)).toBe(201);
  invitee = await throwaway('Invitee', 'member', address);
  const accepted = await api(invitee, 'POST', `/invites/${invite.json.data.code}/accept`);
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
  expect(accepted.json.data.redirectTo).toBe(`/pods/${podA}`);
  const ip = await signedIn(invitee, { width: 360, height: 780 });
  await gotoRetry(ip, `${APP}/pods/${podA}`);
  await expect(ip.getByRole('heading', { name: `${RUN} Curious 12` })).toBeVisible({ timeout: 30_000 });
  await gotoRetry(ip, `${APP}/pods/${podB}`);
  await expect(ip.getByRole('heading', { name: 'Pod not found' })).toBeVisible({ timeout: 30_000 });
  await expect(ip.getByText(`${RUN} Human Edge`)).toHaveCount(0);
  for (const [p, status] of [[`/pods/${podB}`, 404], [`/pods/${podB}/session-count`, 404], [`/pods/${podB}/join-config`, 404],
    [`/circles/of-pod/${podB}`, 404], [`/pods/${podB}/members`, 403], [`/invites/pod/${podB}`, 403]] as const) {
    expect((await api(invitee, 'GET', p)).status, p).toBe(status);
  }

  // ── 4. A removed member is refused the private pod's overview ───────────────────────────────────────────────
  expect((await api(o, 'POST', `/pods/${podA}/members`, { userId: r.id })).status).toBe(201);
  expect((await api(r, 'GET', `/pods/${podA}`)).status).toBe(200);
  expect((await api(o, 'DELETE', `/pods/${podA}/members/${r.id}`)).status).toBe(200);
  for (const p of [`/pods/${podA}`, `/pods/${podA}/session-count`, `/pods/${podA}/join-config`, `/circles/of-pod/${podA}`]) {
    expect((await api(r, 'GET', p)).status, p).toBe(404);
  }
  const rp = await signedIn(r, { width: 360, height: 780 });
  await gotoRetry(rp, `${APP}/pods/${podA}`);
  await expect(rp.getByRole('heading', { name: 'Pod not found' })).toBeVisible({ timeout: 30_000 });

  // The pod's director sees its circle chip with a Remove beside it (1280).
  await gotoRetry(op, `${APP}/pods/${podA}`);
  await expect(op.getByTestId(`pod-unlink-${circleId}`)).toBeVisible({ timeout: 30_000 });
});
