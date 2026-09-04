import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// THE WALL AS A SOCIAL FEED (4 Sep 2026, Ali).
//
// "Inside the circles the wall still doesn't have a like option. I want a
// proper Facebook-style like/react, comment, share, reply to a comment, delete
// for the poster, and notifications." Outcomes, not visibility:
//   * one reaction per member per post (change replaces, null removes), members
//     only, the author told once per post per hour with a deep link;
//   * replies one level deep (a reply to a reply hangs under the top-level
//     comment, the bell goes to the person replied to); likes on comments;
//   * deleting a comment takes its replies and moves the count by all of them;
//   * share = copy link, or repost into another circle with attribution to the
//     ORIGINAL post (never into the circle it already lives in);
//   * ?post= deep links scroll the post into view, from a share or the bell;
//   * all of it on a 390px phone with 44px targets and no sideways scroll.

let browser: Browser;
let admin: TestUser, author: TestUser, reactor: TestUser, outsider: TestUser;
const ctxs: BrowserContext[] = [];
let circleA = '', circleB = '', postId = '', sharedId = '';

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string, viewport = { width: 390, height: 844 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

const uuid = () => crypto.randomUUID();
const bellsOf = (u: TestUser, type: string) =>
  pool.query(`SELECT title, body, link FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at DESC`, [u.id, type]);
const postAs = async (u: TestUser, id: string) => (await apiAs(u, 'GET', `/circles/posts/${id}`)).json?.data;

test.beforeAll(async () => {
  admin = await createTestUser('wsocialadmin', 'super_admin');
  author = await createTestUser('wsocialauthor');
  reactor = await createTestUser('wsocialreactor');
  outsider = await createTestUser('wsocialoutsider');
  await pool.query(`UPDATE users SET display_name = 'Wall Author' WHERE id = $1`, [author.id]);
  await pool.query(`UPDATE users SET display_name = 'Wall Reactor' WHERE id = $1`, [reactor.id]);
  browser = await chromium.launch({ headless: false });

  circleA = (await apiAs(admin, 'POST', '/circles', { name: 'E2E Social A' })).json.data.id;
  circleB = (await apiAs(admin, 'POST', '/circles', { name: 'E2E Social B' })).json.data.id;
  for (const u of [author, reactor]) {
    await apiAs(u, 'POST', `/circles/${circleA}/join`);
    await apiAs(u, 'POST', `/circles/${circleB}/join`);
  }
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  for (const id of [circleA, circleB]) if (id) await pool.query(`DELETE FROM circles WHERE id = $1`, [id]).catch(() => {});
  await cleanup(pool, { ids: [admin?.id, author?.id, reactor?.id, outsider?.id].filter(Boolean) });
  const swept = await cleanupByPrefix(pool, 'e2etest-wsocial');
  if (swept) console.log(`  swept ${swept} leftover wsocial* account(s)`);
});

test('reactions, replies, likes, deletes and shares, with the bells that go with them', async () => {
  test.setTimeout(180_000);

  const made = await apiAs(author, 'POST', `/circles/${circleA}/posts`, {
    clientId: uuid(), content: 'Launching our beta next week. Feedback welcome: https://www.example.com/beta',
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  postId = made.json.data.id;
  expect(made.json.data).toMatchObject({ reactionCount: 0, reactions: {}, myReaction: null, sharedFrom: null });

  // ── Reactions ──
  expect((await apiAs(outsider, 'POST', `/circles/posts/${postId}/react`, { reaction: 'love' })).status, 'a non-member cannot react').toBe(403);
  expect((await apiAs(reactor, 'POST', `/circles/posts/${postId}/react`, { reaction: 'angry' })).status, 'unknown reaction').toBe(400);

  let r = await apiAs(reactor, 'POST', `/circles/posts/${postId}/react`, { reaction: 'love' });
  expect(r.status).toBe(200);
  expect(r.json.data).toEqual({ reactionCount: 1, reactions: { love: 1 }, myReaction: 'love' });
  r = await apiAs(reactor, 'POST', `/circles/posts/${postId}/react`, { reaction: 'applause' });
  expect(r.json.data, 'changing replaces, never adds').toEqual({ reactionCount: 1, reactions: { applause: 1 }, myReaction: 'applause' });

  let bells = await bellsOf(author, 'circle_reaction');
  expect(bells.rows, 'the author is told once for two reactions inside the hour').toHaveLength(1);
  expect(bells.rows[0]).toMatchObject({ title: 'Wall Reactor reacted to your post', link: `/circles/${circleA}?post=${postId}` });
  expect(bells.rows[0].body).toContain('Launching our beta');

  expect(await postAs(reactor, postId)).toMatchObject({ reactionCount: 1, myReaction: 'applause' });
  expect(await postAs(author, postId)).toMatchObject({ reactionCount: 1, myReaction: null });

  r = await apiAs(author, 'POST', `/circles/posts/${postId}/react`, { reaction: 'like' });
  expect(r.json.data).toEqual({ reactionCount: 2, reactions: { applause: 1, like: 1 }, myReaction: 'like' });
  expect((await bellsOf(author, 'circle_reaction')).rows, 'your own reaction rings nothing').toHaveLength(1);

  r = await apiAs(reactor, 'POST', `/circles/posts/${postId}/react`, { reaction: null });
  expect(r.json.data, 'null removes mine and leaves the rest').toEqual({ reactionCount: 1, reactions: { like: 1 }, myReaction: null });
  console.log('  ✓ reactions: members only, one per member, replace/remove, author told once.');

  // ── Comments, replies, likes ──
  const c1 = await apiAs(reactor, 'POST', `/circles/posts/${postId}/comments`, { content: 'Congrats, big step!' });
  expect(c1.status).toBe(201);
  expect(c1.json.data.parentCommentId).toBeNull();
  bells = await bellsOf(author, 'circle_comment');
  expect(bells.rows).toHaveLength(1);
  expect(bells.rows[0]).toMatchObject({ title: 'Wall Reactor commented on your post', link: `/circles/${circleA}?post=${postId}` });

  const r1 = await apiAs(author, 'POST', `/circles/posts/${postId}/comments`, { content: 'Thank you!', parentCommentId: c1.json.data.id });
  expect(r1.status).toBe(201);
  expect(r1.json.data.parentCommentId).toBe(c1.json.data.id);
  bells = await bellsOf(reactor, 'circle_reply');
  expect(bells.rows).toHaveLength(1);
  expect(bells.rows[0]).toMatchObject({ title: 'Wall Author replied to your comment', link: `/circles/${circleA}?post=${postId}` });
  expect((await bellsOf(author, 'circle_comment')).rows, 'your own reply on your own post rings nothing').toHaveLength(1);

  // A reply to the reply hangs under the top-level comment; the bell goes to the author of the reply.
  const r2 = await apiAs(reactor, 'POST', `/circles/posts/${postId}/comments`, { content: 'Any beta seats left?', parentCommentId: r1.json.data.id });
  expect(r2.status).toBe(201);
  expect(r2.json.data.parentCommentId, 'one level deep').toBe(c1.json.data.id);
  expect((await bellsOf(author, 'circle_reply')).rows).toHaveLength(1);
  expect((await bellsOf(author, 'circle_comment')).rows, 'replied-to author is the post author: one bell, not two').toHaveLength(1);

  expect((await apiAs(outsider, 'POST', `/circles/comments/${r1.json.data.id}/like`, { liked: true })).status).toBe(403);
  const liked = await apiAs(reactor, 'POST', `/circles/comments/${r1.json.data.id}/like`, { liked: true });
  expect(liked.json.data).toEqual({ likeCount: 1, likedByMe: true });
  const again = await apiAs(reactor, 'POST', `/circles/comments/${r1.json.data.id}/like`, { liked: true });
  expect(again.json.data, 'liking twice is still one like').toEqual({ likeCount: 1, likedByMe: true });

  const listAsAuthor = (await apiAs(author, 'GET', `/circles/posts/${postId}/comments`)).json.data as any[];
  expect(listAsAuthor.map(c => [c.content, c.parentCommentId])).toEqual([
    ['Congrats, big step!', null],
    ['Thank you!', c1.json.data.id],
    ['Any beta seats left?', c1.json.data.id],
  ]);
  expect(listAsAuthor[1]).toMatchObject({ likeCount: 1, likedByMe: false });
  const listAsReactor = (await apiAs(reactor, 'GET', `/circles/posts/${postId}/comments`)).json.data as any[];
  expect(listAsReactor[1]).toMatchObject({ likeCount: 1, likedByMe: true });
  expect((await postAs(author, postId)).commentCount).toBe(3);
  console.log('  ✓ comments: reply nesting, bells to the right person, likes idempotent and members only.');

  // ── Delete a comment: its replies go with it, count moves by all of them ──
  expect((await apiAs(outsider, 'DELETE', `/circles/comments/${c1.json.data.id}`)).status).toBe(403);
  expect((await apiAs(reactor, 'DELETE', `/circles/comments/${c1.json.data.id}`)).status).toBe(200);
  expect((await apiAs(author, 'GET', `/circles/posts/${postId}/comments`)).json.data).toEqual([]);
  expect((await postAs(author, postId)).commentCount).toBe(0);
  console.log('  ✓ deleting a top-level comment takes its two replies; count back to 0.');

  // ── Share ──
  const share = await apiAs(reactor, 'POST', `/circles/posts/${postId}/share`, { circleId: circleB, clientId: uuid(), content: 'Worth a look' });
  expect(share.status, JSON.stringify(share.json)).toBe(201);
  sharedId = share.json.data.id;
  expect(share.json.data.content).toBe('Worth a look');
  expect(share.json.data.sharedFrom).toMatchObject({ id: postId, circleId: circleA, circleName: 'E2E Social A', authorName: 'Wall Author' });
  expect(share.json.data.sharedFrom.content).toContain('Launching our beta');

  expect((await apiAs(reactor, 'POST', `/circles/posts/${postId}/share`, { circleId: circleA, clientId: uuid() })).status, 'not into its own circle').toBe(400);
  expect((await apiAs(reactor, 'POST', `/circles/posts/${sharedId}/share`, { circleId: circleA, clientId: uuid() })).status, 'a share of a share still points home: not into the root circle').toBe(400);
  expect((await apiAs(outsider, 'POST', `/circles/posts/${postId}/share`, { circleId: circleB, clientId: uuid() })).status, 'must be a member of the target circle').toBe(403);

  const seen = await apiAs(outsider, 'GET', `/circles/posts/${sharedId}`);
  expect(seen.status, 'reading is open to any member').toBe(200);
  expect(seen.json.data.sharedFrom.id).toBe(postId);
  expect((await apiAs(outsider, 'GET', `/circles/posts/${uuid()}`)).status).toBe(404);

  const feedB = (await apiAs(author, 'GET', `/circles/${circleB}/posts`)).json.data;
  expect(feedB.posts.find((p: any) => p.id === sharedId)?.sharedFrom?.circleName).toBe('E2E Social A');
  console.log('  ✓ share: attribution to the original, never into its own circle, readable by anyone.');
});

test('on a phone: react from the picker, comment, reply, like, share, follow the deep link and the bell, delete', async () => {
  test.setTimeout(300_000);

  // The deep link lands on the post and it is in view.
  const page = await openAs(reactor, `/circles/${circleA}?post=${postId}`);
  const post = page.getByTestId(`wall-post-${postId}`);
  await expect(post).toBeVisible({ timeout: 30_000 });
  const box = await post.boundingBox();
  expect(box!.y, 'the linked post is scrolled into the viewport').toBeGreaterThan(-20);
  expect(box!.y, 'the linked post is scrolled into the viewport').toBeLessThan(844);

  // React from the picker.
  await page.getByTestId(`reaction-picker-toggle-${postId}`).click();
  const picker = page.getByTestId(`reaction-picker-${postId}`);
  await expect(picker).toBeVisible();
  for (const name of ['Like', 'Love', 'Applause', 'Insightful', 'Celebrate']) {
    const b = await picker.getByRole('button', { name: `React: ${name}` }).boundingBox();
    expect(b!.height, `${name} is a 44px target`).toBeGreaterThanOrEqual(44);
  }
  await picker.getByRole('button', { name: 'React: Celebrate' }).click();
  const reactBtn = page.getByTestId(`react-button-${postId}`);
  await expect(reactBtn).toHaveText(/Celebrate/);
  await expect(reactBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId(`reaction-summary-${postId}`)).toContainText('2'); // the author's like + mine
  await expect(page.getByTestId(`reaction-summary-${postId}`)).toContainText('🎉');
  await expect.poll(async () => (await postAs(reactor, postId)).myReaction).toBe('celebrate');

  // Tap again removes it; a plain tap likes.
  await reactBtn.click();
  await expect(reactBtn).toHaveText(/Like/);
  await expect(page.getByTestId(`reaction-summary-${postId}`)).toContainText('1');
  await reactBtn.click();
  await expect(reactBtn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await postAs(reactor, postId)).myReaction).toBe('like');
  console.log('  ✓ picker: five 44px reactions, celebrate → remove → like, server agrees.');

  // Comment, reply, like, delete the reply.
  await page.getByTestId(`comment-button-${postId}`).click();
  const commentBox = page.getByLabel('Your comment');
  await commentBox.fill('Great news, congrats!');
  await commentBox.press('Enter');
  await expect(page.getByText('Great news, congrats!')).toBeVisible({ timeout: 15_000 });
  const c = await pool.query(`SELECT id FROM circle_post_comments WHERE post_id = $1 AND content = 'Great news, congrats!' AND deleted_at IS NULL`, [postId]);
  const cId = c.rows[0].id;
  await page.getByTestId(`reply-button-${cId}`).click();
  const replyBox = page.getByLabel('Your reply');
  await replyBox.fill('Adding: happy to test it.');
  await replyBox.press('Enter');
  await expect(page.getByText('Adding: happy to test it.')).toBeVisible({ timeout: 15_000 });
  const rep = await pool.query(`SELECT id, parent_comment_id FROM circle_post_comments WHERE post_id = $1 AND content = 'Adding: happy to test it.' AND deleted_at IS NULL`, [postId]);
  expect(rep.rows[0].parent_comment_id).toBe(cId);
  // The reply sits inside its parent's block, indented.
  await expect(page.getByTestId(`comment-${cId}`).getByTestId(`comment-${rep.rows[0].id}`)).toBeVisible();

  await page.getByTestId(`comment-like-${cId}`).click();
  await expect(page.getByTestId(`comment-like-${cId}`)).toHaveText(/Liked · 1/);

  page.once('dialog', d => d.accept());
  await page.getByTestId(`comment-delete-${rep.rows[0].id}`).click();
  await expect(page.getByText('Adding: happy to test it.')).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await postAs(reactor, postId)).commentCount).toBe(1);
  console.log('  ✓ comment → reply nested under it → like → delete own reply.');

  // Share: copy link, then into circle B.
  await page.getByTestId(`share-button-${postId}`).click();
  await page.getByTestId(`copy-link-${postId}`).click();
  await expect(page.getByText('Link copied.')).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(`${APP}/circles/${circleA}?post=${postId}`);

  await page.getByTestId(`share-button-${postId}`).click();
  await page.getByTestId(`share-to-circle-${postId}`).click();
  await page.getByLabel('Circle to share to').selectOption(circleB);
  await page.getByLabel('Your note').fill('Sharing with B');
  await page.getByTestId(`share-submit-${postId}`).click();
  await expect(page.getByText('Shared to E2E Social B.')).toBeVisible({ timeout: 15_000 });
  const s2 = await pool.query(`SELECT id FROM circle_posts WHERE circle_id = $1 AND author_id = $2 AND content = 'Sharing with B' AND deleted_at IS NULL`, [circleB, reactor.id]);
  expect(s2.rows).toHaveLength(1);
  console.log('  ✓ share: link on the clipboard, repost into B with a note.');

  // The shared card in B carries the attribution and links back to the original.
  await gotoRetry(page, `${APP}/circles/${circleB}`);
  const attribution = page.getByTestId(`shared-from-${s2.rows[0].id}`);
  await expect(attribution).toBeVisible({ timeout: 30_000 });
  await expect(attribution).toContainText('Shared from E2E Social A');
  await expect(attribution).toContainText('Wall Author');
  await attribution.click();
  await expect(page).toHaveURL(new RegExp(`/circles/${circleA}\\?post=${postId}`), { timeout: 30_000 });
  await expect(page.getByTestId(`wall-post-${postId}`)).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ attribution card → back to the original post.');

  // 360px: the picker open, no sideways scroll.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.getByTestId(`reaction-picker-toggle-${postId}`).click();
  await expect(page.getByTestId(`reaction-picker-${postId}`)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 360px').toBeLessThanOrEqual(0);

  // The author follows the bell to the post, then deletes it.
  const aPage = await openAs(author, '/');
  await aPage.locator('button:has(.lucide-bell):visible').first().click();
  const entry = aPage.getByText('Wall Reactor reacted to your post').first();
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(aPage).toHaveURL(new RegExp(`/circles/${circleA}\\?post=${postId}`), { timeout: 30_000 });
  await expect(aPage.getByTestId(`wall-post-${postId}`)).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ bell entry → the post.');

  aPage.once('dialog', d => d.accept());
  await aPage.getByTestId(`delete-post-${postId}`).click();
  await expect(aPage.getByTestId(`wall-post-${postId}`)).toHaveCount(0, { timeout: 15_000 });
  const gone = await pool.query(`SELECT deleted_at FROM circle_posts WHERE id = $1`, [postId]);
  expect(gone.rows[0].deleted_at).not.toBeNull();
  // The share in B now shows nothing to attribute (the original is gone), but the share itself stays.
  const shareNow = await postAs(reactor, s2.rows[0].id);
  expect(shareNow.sharedFrom).toBeNull();
  console.log('  ✓ author deleted the post; the repost survives without its attribution.');
});
