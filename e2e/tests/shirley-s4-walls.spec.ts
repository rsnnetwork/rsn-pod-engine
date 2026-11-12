import { test, expect, type Browser, type BrowserContext, type Page, type Locator } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { APP, SERVER, cleanup, gotoRetry, idsOf, teardown } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';
import { acceptConfirmDialogs } from '../helpers/confirm-dialog';

// SHIRLEY PILOT S4: WALLS THAT WORK FOR OWNERS (11 Nov 2026; brief RSN 13 "Wall: minimum operating behaviour")
//
// A throwaway platform admin makes a circle and hands it to a throwaway PLAIN member ("the owner", as Shirley will be);
// the owner makes a second member a moderator. Then, on production:
//   1. D2: someone outside the (open) circle is refused its feed (403), and a post id tells them nothing (404).
//   2. A member posts at 360px; the owner's page at 1280px shows it without a reload (entity tags, no polling).
//   3. A blocked author's post rings nobody who blocked them; the owner's bell opens that exact post with its comments.
//   4. Comment, reply, and the author's edit at 360px: the owner's page shows "Edited" without a reload.
//   5. The owner pins from the page; the member's page shows it pinned; a member cannot pin (403, no control); the
//      moderator unpins; a fourth pin is refused (at most three); every pin and unpin is recorded.
//   6. An 8000-character post at 360px: cut with "Show more", and the page never scrolls sideways.
//   7. Two moderators remove one post at once: one removes, the other is told alreadyRemoved; a link to it then says
//      "This post was removed."; editing it is refused in words.
//   8. D8: a member who left deletes their own post and cannot edit it.
//   9. Pod parity (API): a private pod's director pins and removes, an outsider gets the pod's 404, a removed member
//      gets no bell and may delete only their own post.
// Throwaway accounts (@rsn-e2e.invalid), the spec's own circle and pod, deleted by id at the end.

const RUN = `s4${Date.now().toString(36)}`;
const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
let browser: Browser;
let admin: TestUser | undefined, owner: TestUser | undefined, mod: TestUser | undefined, member: TestUser | undefined;
let blocker: TestUser | undefined, outsider: TestUser | undefined, leaver: TestUser | undefined;
let circleId = '';
let podId = '';
const contexts: BrowserContext[] = [];

async function throwaway(label: string, role: 'member' | 'admin' = 'member'): Promise<TestUser> {
  const u = await createTestUser(`s4${label}`, role);
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

/** On screen, wholly inside the viewport, and a 44px target. */
async function fitsViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible({ timeout: 20_000 });
  const box = await locator.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box, 'the control has a box').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function noSidewaysScroll(page: Page) {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(inner);
}

const post = async (who: TestUser, content: string) => {
  const made = await api(who, 'POST', `/circles/${circleId}/posts`, { clientId: uuid(), content });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  return made.json.data.id as string;
};

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  browser = await launchBrowser();
  admin = await throwaway('Admin', 'admin');
  owner = await throwaway('Owner');
  mod = await throwaway('Moderator');
  member = await throwaway('Member');
  blocker = await throwaway('Blocker');
  outsider = await throwaway('Outsider');
  leaver = await throwaway('Leaver');
  const made = await api(admin, 'POST', '/circles', { name: `${RUN} Curious Humans`, description: 'Walls that work.' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  circleId = made.json.data.id;
  for (const who of [owner, mod, member, blocker, leaver]) expect((await api(who, 'POST', `/circles/${circleId}/join`)).status).toBe(200);
  expect((await api(admin, 'POST', `/circles/${circleId}/transfer`, { toUserId: owner.id })).status).toBe(200);
  expect((await api(owner, 'PATCH', `/circles/${circleId}/members/${mod.id}/role`, { role: 'moderator' })).status).toBe(200);
  // The admin has done their part: out of the circle, so every check below is the owner's and the moderator's own.
  await api(admin, 'POST', `/circles/${circleId}/leave`);
  const blocked = await api(blocker, 'POST', `/users/${member.id}/block`, {});
  expect([200, 201], JSON.stringify(blocked.json)).toContain(blocked.status);
});

test.afterAll(async () => {
  await teardown(
    ...contexts.map((c) => () => c.close()),
    () => browser?.close(),
    () => (circleId ? pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]) : Promise.resolve()),
    () => (podId ? cleanup(pool, { ids: [], podId }) : Promise.resolve()),
    () => pool.query(`DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`, [idsOf(blocker, member)]),
    () => cleanup(pool, { ids: idsOf(admin, owner, mod, member, blocker, outsider, leaver) }),
  );
});

test(`owners and moderators run the wall; authors edit; bells open the post (${engineLabel()})`, async () => {
  test.setTimeout(420_000);
  const o = owner!; const m = mod!; const me = member!; const b = blocker!; const x = outsider!; const l = leaver!;

  // ── 1. D2: the wall is its members' ──────────────────────────────────────────────────────────────────────────
  const outsideFeed = await api(x, 'GET', `/circles/${circleId}/posts`);
  expect(outsideFeed.status).toBe(403);
  expect(outsideFeed.json.error.message).toBe('Members talk here. Join this circle to read and post on its wall.');
  const ownerFeed = await api(o, 'GET', `/circles/${circleId}/posts`);
  expect(ownerFeed.json.data.viewer).toEqual({ canPost: true, canModerate: true });
  expect((await api(me, 'GET', `/circles/${circleId}/posts`)).json.data.viewer).toEqual({ canPost: true, canModerate: false });

  // ── 2. The member posts at 360px; the owner's page (1280) shows it without a reload ─────────────────────────
  const op = await signedIn(o, { width: 1280, height: 900 });
  const mp = await signedIn(me, { width: 360, height: 780 });
  await gotoRetry(op, `${APP}/circles/${circleId}`);
  await gotoRetry(mp, `${APP}/circles/${circleId}`);
  await expect(op.getByTestId('circle-wall')).toBeVisible({ timeout: 30_000 });
  await expect(mp.getByTestId('circle-wall')).toBeVisible({ timeout: 30_000 });
  const firstWords = `${RUN} first post from the member`;
  await mp.getByRole('textbox', { name: 'Share something with the circle…' }).fill(firstWords);
  await mp.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(op.getByText(firstWords)).toBeVisible({ timeout: 20_000 });
  const firstId = (await pool.query(`SELECT id FROM circle_posts WHERE circle_id = $1 AND content = $2`, [circleId, firstWords])).rows[0].id as string;
  expect((await api(x, 'GET', `/circles/posts/${firstId}`)).status).toBe(404);
  expect((await api(x, 'GET', `/circles/posts/${firstId}/comments`)).status).toBe(404);

  // ── 3. Bells: the blocker is never rung by the member; the owner's bell opens the post with its comments ──────
  const blockerBells = await pool.query(`SELECT count(*)::int n FROM notifications WHERE user_id = $1 AND type = 'circle_post'`, [b.id]);
  expect(blockerBells.rows[0].n).toBe(0);
  const ownerBell = await pool.query(`SELECT link FROM notifications WHERE user_id = $1 AND type = 'circle_post' ORDER BY created_at DESC LIMIT 1`, [o.id]);
  expect(ownerBell.rows[0]?.link).toBe(`/circles/${circleId}?post=${firstId}`);
  await gotoRetry(op, `${APP}${ownerBell.rows[0].link}`);
  await expect(op.getByTestId(`wall-post-${firstId}`)).toBeInViewport({ timeout: 20_000 });
  await expect(op.getByTestId(`comments-${firstId}`)).toBeVisible();

  // ── 4. Comment, reply, and the author's edit at 360px; "Edited" reaches the owner without a reload ──────────
  const comment = await api(o, 'POST', `/circles/posts/${firstId}/comments`, { content: 'Welcome!' });
  expect(comment.status).toBe(201);
  const reply = await api(me, 'POST', `/circles/posts/${firstId}/comments`, { content: 'Thank you', parentCommentId: comment.json.data.id });
  expect(reply.status).toBe(201);
  const replyBell = await pool.query(`SELECT link FROM notifications WHERE user_id = $1 AND type = 'circle_reply'`, [o.id]);
  // A comment bell names its own comment so removing that comment can delete exactly its bells; the page reads only `post`.
  expect(replyBell.rows[0]?.link).toBe(`/circles/${circleId}?post=${firstId}&comment=${reply.json.data.id}`);
  expect((await api(b, 'POST', `/circles/posts/${firstId}/react`, { reaction: 'like' })).status).toBe(404);
  const editButton = mp.getByTestId(`edit-post-button-${firstId}`);
  await fitsViewport(mp, editButton);
  expect(await op.getByTestId(`edit-post-button-${firstId}`).count()).toBe(0);
  await editButton.click();
  const box = mp.getByRole('textbox', { name: 'Edit your post' });
  await box.fill(`${firstWords} (edited)`);
  await fitsViewport(mp, mp.getByTestId(`edit-post-${firstId}-save`));
  await mp.getByTestId(`edit-post-${firstId}-save`).click();
  await expect(mp.getByTestId(`post-edited-${firstId}`)).toBeVisible({ timeout: 20_000 });
  await expect(op.getByTestId(`post-edited-${firstId}`)).toBeVisible({ timeout: 20_000 });
  await expect(op.getByText(`${firstWords} (edited)`)).toBeVisible();
  expect((await api(o, 'PATCH', `/circles/posts/${firstId}`, { content: 'not mine' })).status).toBe(403);
  const stale = await api(me, 'PATCH', `/circles/posts/${firstId}`, { content: 'stale', expectedEditedAt: null });
  expect(stale.status).toBe(409);

  // ── 5. Pins: the owner from the page; the member sees it; a member cannot; the moderator unpins; at most three ──
  expect(await mp.getByTestId(`pin-post-${firstId}`).count()).toBe(0);
  expect((await api(me, 'POST', `/circles/posts/${firstId}/pin`)).status).toBe(403);
  await op.getByTestId(`pin-post-${firstId}`).first().click();
  await expect(mp.getByTestId(`pinned-badge-${firstId}`)).toBeVisible({ timeout: 20_000 });
  expect((await api(m, 'POST', `/circles/posts/${firstId}/unpin`)).status).toBe(200);
  await expect(mp.getByTestId(`pinned-badge-${firstId}`)).toHaveCount(0, { timeout: 20_000 });
  const extra = [await post(o, `${RUN} pin a`), await post(o, `${RUN} pin b`), await post(o, `${RUN} pin c`), await post(o, `${RUN} pin d`)];
  for (const id of extra.slice(0, 3)) expect((await api(o, 'POST', `/circles/posts/${id}/pin`)).status).toBe(200);
  const fourth = await api(m, 'POST', `/circles/posts/${extra[3]}/pin`);
  expect(fourth.status).toBe(409);
  expect(fourth.json.error.message).toBe('A wall can have at most 3 pinned posts. Unpin one first.');
  const strip = (await api(me, 'GET', `/circles/${circleId}/posts`)).json.data.pinned.map((p: { id: string }) => p.id);
  expect(strip).toEqual([extra[2], extra[1], extra[0]]);
  const pins = await pool.query(`SELECT count(*)::int n FROM audit_log WHERE entity_type = 'circle' AND entity_id = $1 AND action IN ('wall_post_pinned', 'wall_post_unpinned')`, [circleId]);
  expect(pins.rows[0].n).toBe(5);

  // ── 6. An 8000-character post at 360px: cut, "Show more", no sideways scroll ────────────────────────────────
  // One unbroken 300-character word (it must wrap anywhere), then plain words to the 8000-character limit.
  const long = `${RUN} ${'x'.repeat(300)} ${'word '.repeat(2000)}`.slice(0, 8000);
  const longId = await post(me, long);
  await expect(mp.getByTestId(`post-text-${longId}`)).toBeVisible({ timeout: 20_000 });
  await noSidewaysScroll(mp);
  const more = mp.getByTestId(`post-text-${longId}-more`);
  await fitsViewport(mp, more);
  const clipped = (await mp.getByTestId(`post-text-${longId}`).boundingBox())!.height;
  await more.click();
  await expect(more).toHaveText('Show less');
  expect((await mp.getByTestId(`post-text-${longId}`).boundingBox())!.height).toBeGreaterThan(clipped * 3);
  await noSidewaysScroll(mp);

  // ── 7. Two moderators remove one post at once; a link to it then says so; editing it is refused ──────────────
  const doomed = await post(me, `${RUN} to be removed`);
  const both = await Promise.all([api(o, 'DELETE', `/circles/posts/${doomed}`), api(m, 'DELETE', `/circles/posts/${doomed}`)]);
  expect(both.map((r) => r.status)).toEqual([200, 200]);
  expect(both.map((r) => r.json.data.alreadyRemoved).sort()).toEqual([false, true]);
  const removedBy = await pool.query(`SELECT deleted_by FROM circle_posts WHERE id = $1`, [doomed]);
  expect([o.id, m.id]).toContain(removedBy.rows[0].deleted_by);
  const record = await pool.query(`SELECT details FROM audit_log WHERE action = 'wall_post_removed' AND details->>'postId' = $1`, [doomed]);
  expect(record.rows).toHaveLength(1);
  expect(record.rows[0].details.content).toBe(`${RUN} to be removed`);
  const late = await api(me, 'PATCH', `/circles/posts/${doomed}`, { content: 'too late' });
  expect(late.status).toBe(404);
  expect(late.json.error.message).toBe('This post was removed.');
  await gotoRetry(mp, `${APP}/circles/${circleId}?post=${doomed}`);
  await expect(mp.getByTestId('circle-wall-linked-removed')).toHaveText('This post was removed.', { timeout: 20_000 });

  // The member deletes their own post from the page (a confirm first).
  await gotoRetry(mp, `${APP}/circles/${circleId}`);
  await mp.getByTestId(`delete-post-${longId}`).click();
  await expect(mp.getByTestId(`wall-post-${longId}`)).toHaveCount(0, { timeout: 20_000 });

  // ── 8. D8: someone who left deletes their own words, and cannot edit them ───────────────────────────────────
  const leaverPost = await post(l, `${RUN} leaver words`);
  expect((await api(l, 'POST', `/circles/${circleId}/leave`)).status).toBe(200);
  expect((await api(l, 'GET', `/circles/${circleId}/posts`)).status).toBe(403);
  expect((await api(l, 'PATCH', `/circles/posts/${leaverPost}`, { content: 'x' })).status).toBe(403);
  expect((await api(l, 'DELETE', `/circles/posts/${firstId}`)).status).toBe(404);
  const own = await api(l, 'DELETE', `/circles/posts/${leaverPost}`);
  expect(own.status).toBe(200);
  expect(own.json.data.alreadyRemoved).toBe(false);

  // ── 9. Pod parity (API) ──────────────────────────────────────────────────────────────────────────────────────
  const pod = await api(o, 'POST', '/pods', { name: `${RUN} Human Edge`, podType: 'chat', visibility: 'private' });
  expect(pod.status, JSON.stringify(pod.json)).toBe(201);
  podId = pod.json.data.id;
  expect((await api(o, 'POST', `/pods/${podId}/members`, { userId: me.id, role: 'member' })).status).toBe(201);
  expect((await api(o, 'POST', `/pods/${podId}/members`, { userId: l.id, role: 'member' })).status).toBe(201);
  const leaverPodPost = await api(l, 'POST', `/pods/${podId}/wall/posts`, { clientId: uuid(), content: 'before removal' });
  expect(leaverPodPost.status).toBe(201);
  expect((await api(o, 'DELETE', `/pods/${podId}/members/${l.id}`)).status).toBe(200);
  await pool.query(`DELETE FROM notifications WHERE user_id = $1 AND type = 'pod_post'`, [o.id]);
  const podPost = await api(me, 'POST', `/pods/${podId}/wall/posts`, { clientId: uuid(), content: 'pod words' });
  expect(podPost.status).toBe(201);
  const podBell = await pool.query(`SELECT link FROM notifications WHERE user_id = $1 AND type = 'pod_post'`, [o.id]);
  expect(podBell.rows.map((r) => r.link)).toEqual([`/pods/${podId}?post=${podPost.json.data.id}`]);
  expect((await pool.query(`SELECT count(*)::int n FROM notifications WHERE user_id = $1 AND type = 'pod_post'`, [l.id])).rows[0].n).toBe(0);
  expect((await api(x, 'GET', `/pods/${podId}/wall/posts`)).status).toBe(404);
  expect((await api(x, 'DELETE', `/pods/${podId}/wall/posts/${podPost.json.data.id}`)).status).toBe(404);
  expect((await api(l, 'DELETE', `/pods/${podId}/wall/posts/${podPost.json.data.id}`)).status).toBe(404);
  expect((await api(l, 'DELETE', `/pods/${podId}/wall/posts/${leaverPodPost.json.data.id}`)).status).toBe(200);
  const podEdit = await api(me, 'PATCH', `/pods/${podId}/wall/posts/${podPost.json.data.id}`, { content: 'pod words, edited' });
  expect(podEdit.json.data.changed).toBe(true);
  expect((await api(o, 'POST', `/pods/${podId}/wall/posts/${podPost.json.data.id}/pin`)).status).toBe(200);
  expect((await api(me, 'POST', `/pods/${podId}/wall/posts/${podPost.json.data.id}/pin`)).status).toBe(403);
  expect((await api(o, 'DELETE', `/pods/${podId}/wall/posts/${podPost.json.data.id}`)).json.data).toEqual({ ok: true, alreadyRemoved: false });
});
