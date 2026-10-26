import { test, expect, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createSession } from '../helpers/api';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// THE POD'S DISCUSSION (COM-01, 26 Oct 2026). Stefan, back in the pod after an event: "We can't write in the
// pod itself. There's no wall." Active members of a pod now talk between events: posts, comments with replies,
// reactions, a pinned strip, and moderation by the pod's director or host. Every change reaches open screens
// by entity tag, with no polling and no refresh, and every bell rings live.
//
// Real browsers, several accounts at once, one per role:
//   * a member posts from a phone, another member sees it appear on a desktop that never reloads, replies,
//     the author is rung and follows the bell to the post;
//   * the director pins and deletes; an ordinary member can do neither on someone else's words;
//   * a removed member is told so live (and the server answers 403); a visitor to a public pod reads
//     "Members talk here. Join the pod to read and post.";
//   * an archived pod takes nothing new, but its director still deletes and its authors still delete their own;
//   * a block leaves the other's posts out of an open page at once; a closed account reads "Former member";
//   * the first ten posts, "Load more", and a ?post= link to a post that is not on the first page;
//   * a thread cut at 400 comments says so;
//   * 360, 390, 414, 768, 1024, 1280 and 1440px: no sideways scroll, every control 44px, two columns from 1024px;
//   * the write limit answers in words and keeps what was typed.
//
// It WRITES throwaway data (members whose address ends @rsn-e2e.invalid, pods, events, posts, bells) to whatever
// database the target server is connected to and removes it by id in afterAll. Engine and device as the other
// headed specs: E2E_ENGINE=webkit, E2E_HEADED=0 for headless. Set E2E_SHOTS_DIR to keep a screenshot of every width.
// ─────────────────────────────────────────────────────────────────────────────

const RUN = Date.now().toString(36);
const SHOTS = process.env.E2E_SHOTS_DIR || '';
const WIDTHS = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 900 },
  { width: 1440, height: 900 },
];
const PLACEHOLDER = 'Write something to the pod…';
const NOT_A_MEMBER = 'Members talk here. Join the pod to read and post.';

let browser: Browser;
let director: TestUser, alice: TestUser, bob: TestUser, carol: TestUser, nina: TestUser, dora: TestUser, admin: TestUser, gone: TestUser;
let podId = '', podName = '', bigPodId = '';
const ctxs: BrowserContext[] = [];

/** A throwaway member whose address can never receive mail (the reserved .invalid domain). */
async function member(label: string, role: 'member' | 'super_admin' = 'member'): Promise<TestUser> {
  const u = await createTestUser(`podwall-${label}`, role);
  const email = `e2etest-podwall-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(`UPDATE users SET email = $1 WHERE id = $2`, [email, u.id]);
  return { ...u, email };
}

/** Every step runs even if one before it throws, so a failed step cannot leave the rest of the throwaway data behind. */
async function everyStep(...steps: Array<() => Promise<unknown>>): Promise<void> {
  let first: { error: unknown } | undefined;
  for (const step of steps) {
    try { await step(); } catch (error) { first ??= { error }; }
  }
  if (first) throw first.error;
}

async function apiAs(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function pageAt(u: TestUser, p: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 1024 });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${p}`);
  return page;
}

const wallOf = (page: Page) => page.getByTestId('pod-wall');
const cardOf = (page: Page, postId: string) => page.getByTestId(`wall-post-${postId}`);
const postButton = (page: Page) => wallOf(page).getByRole('button', { name: 'Post', exact: true });
const bellOf = (page: Page) => page.getByRole('button', { name: 'Notifications' }).first();

/** The next confirm() on this page is accepted. Register it BEFORE the click that opens it. */
function acceptNextDialog(page: Page) {
  page.once('dialog', (d) => { void d.accept(); });
}

async function postIdOf(content: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM pod_posts WHERE pod_id = $1 AND content = $2 AND deleted_at IS NULL`, [podId, content]);
  expect(r.rows, `a post saying "${content}"`).toHaveLength(1);
  return r.rows[0].id;
}
async function commentIdOf(content: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM pod_post_comments WHERE content = $1 AND deleted_at IS NULL`, [content]);
  expect(r.rows, `a comment saying "${content}"`).toHaveLength(1);
  return r.rows[0].id;
}
const bellsOf = (u: TestUser, type: string) =>
  pool.query<{ title: string; link: string }>(`SELECT title, link FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at`, [u.id, type]);

/** Posts made straight into the table, oldest first: the API allows six a minute to a member, a long feed needs more. */
async function seedPosts(pod: string, authorId: string, count: number, label: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO pod_posts (client_id, pod_id, author_id, content, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, date_trunc('milliseconds', NOW()) - make_interval(mins => $4))
       RETURNING id`,
      [pod, authorId, `${label} ${i + 1}`, count - i],
    );
    ids.push(r.rows[0].id);
  }
  return ids;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(900);   // the page's sections fade in over about 0.6 s; a picture should not catch them half drawn
  await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace('/', '-')}-${name}.png`) }).catch(() => {});
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  director = await member('director');
  alice = await member('alice');
  bob = await member('bob');
  carol = await member('carol');
  nina = await member('nina');
  dora = await member('dora');
  admin = await member('admin', 'super_admin');
  gone = await member('gone');
  podName = `E2E Pod Wall ${RUN}`;

  // A PUBLIC pod, so that a visitor who is not a member can see the page (a private one is a 404 to them).
  const body = { description: 'E2E pod wall', visibility: 'public', podType: 'speed_networking', orchestrationMode: 'timed_rounds', communicationMode: 'hybrid' };
  const created = await apiAs(director, 'POST', '/pods', { name: podName, ...body });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  podId = created.json.data.id;
  // The second pod is an old combination: a Reason pod saved on timed rounds, which Reason pods do not use.
  const big = await apiAs(director, 'POST', '/pods', { name: `${podName} long`, ...body, podType: 'reason' });
  expect(big.status).toBe(201);
  bigPodId = big.json.data.id;
  for (const u of [alice, bob, carol, dora]) {
    expect((await apiAs(director, 'POST', `/pods/${podId}/members`, { userId: u.id })).status).toBe(201);
  }
  expect((await apiAs(director, 'POST', `/pods/${bigPodId}/members`, { userId: alice.id })).status).toBe(201);
  browser = await launchBrowser();
});

test.afterEach(async () => {
  for (const c of ctxs.splice(0)) { try { await c.close(); } catch { /* noop */ } }
});

test.afterAll(async () => {
  const ids = [director, alice, bob, carol, nina, dora, admin, gone].filter(Boolean).map((u) => u.id);
  await everyStep(
    async () => { await browser?.close(); },
    async () => { if (bigPodId) await cleanup(pool, { ids: [], podId: bigPodId }); },
    () => cleanup(pool, { ids, podId: podId || undefined }),
    async () => {
      const swept = await cleanupByPrefix(pool, 'e2etest-podwall');
      if (swept) console.log(`  swept ${swept} leftover podwall account(s)`);
    },
  );
});

test('the server decides who reads, posts and moderates: members, a visitor, an admin who is not a member', async () => {
  const feed = (u: TestUser) => apiAs(u, 'GET', `/pods/${podId}/wall/posts`);

  const asAlice = await feed(alice);
  expect(asAlice.status).toBe(200);
  expect(asAlice.json.data.viewer).toEqual({ canPost: true, canModerate: false });
  expect((await feed(director)).json.data.viewer).toEqual({ canPost: true, canModerate: true });

  // An admin reads and moderates without being a member, and does not post.
  const asAdmin = await feed(admin);
  expect(asAdmin.status).toBe(200);
  expect(asAdmin.json.data.viewer).toEqual({ canPost: false, canModerate: true });
  expect((await apiAs(admin, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: 'hello' })).status).toBe(403);

  // A visitor to a public pod is told how to get in, in the server's own words, on read and on write.
  const asNina = await feed(nina);
  expect(asNina.status).toBe(403);
  expect(asNina.json.error.message).toBe('Join this pod to read and post in its discussion');
  expect((await apiAs(nina, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: 'hello' })).status).toBe(403);
});

test('A posts from a phone, B sees it live on a desktop that never reloads and replies, A is rung and follows the bell to the post', async () => {
  test.setTimeout(240_000);
  const text = `Hello pod ${Date.now().toString(36)}`;
  const reply = `Welcome, Alice ${Date.now().toString(36)}`;

  // B is on the pod page, wide, before anything is posted.
  const bobPage = await pageAt(bob, `/pods/${podId}`, { width: 1280, height: 900 });
  await expect(wallOf(bobPage)).toBeVisible({ timeout: 30_000 });
  await expect(wallOf(bobPage).getByTestId('pod-wall-empty')).toBeVisible();
  await bobPage.evaluate(() => { (window as unknown as { __samePage: string }).__samePage = 'never reloaded'; });

  // A is on a phone. The composer is one line until it is tapped.
  const alicePage = await pageAt(alice, `/pods/${podId}`, { width: 390, height: 844 });
  const composer = alicePage.getByPlaceholder(PLACEHOLDER);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(postButton(alicePage), 'a collapsed composer has no Post button yet').toHaveCount(0);
  await composer.click();
  await expect(postButton(alicePage)).toBeVisible();
  // Opened, it stays open when the box loses the focus: a tap on its own buttons takes the focus first, and folding
  // them away then would drop the tap on whatever moved up into their place.
  await alicePage.getByRole('heading', { name: 'Discussion' }).click();
  await expect(composer).not.toBeFocused();
  await expect(postButton(alicePage), 'the composer stays open once tapped').toBeVisible();
  await composer.fill(text);
  await postButton(alicePage).click();
  await expect(alicePage.getByText(text)).toBeVisible({ timeout: 15_000 });
  await expect(composer, 'the box is empty again once the post is saved').toHaveValue('');
  const postId = await postIdOf(text);

  // B: the post is there, with no navigation and no reload; the new-post bell is live too.
  await expect(cardOf(bobPage, postId)).toBeVisible({ timeout: 15_000 });
  await expect(cardOf(bobPage, postId)).toContainText(alice.displayName);
  expect(await bobPage.evaluate(() => (window as unknown as { __samePage?: string }).__samePage)).toBe('never reloaded');
  await expect(bellOf(bobPage)).toContainText('1', { timeout: 15_000 });
  const postBells = await bellsOf(bob, 'pod_post');
  expect(postBells.rows).toHaveLength(1);
  expect(postBells.rows[0]).toMatchObject({ title: `New post in ${podName}`, link: `/pods/${podId}` });

  // B replies on the post.
  await cardOf(bobPage, postId).getByTestId(`comment-button-${postId}`).click();
  const box = cardOf(bobPage, postId).getByLabel('Your comment');
  await box.fill(reply);
  await box.press('Enter');
  await expect(cardOf(bobPage, postId).getByText(reply)).toBeVisible({ timeout: 15_000 });

  // A: the count moves on her open page, and her bell rings, with no reload.
  await expect(cardOf(alicePage, postId)).toContainText('1 comment', { timeout: 15_000 });
  await expect(bellOf(alicePage)).toContainText('1', { timeout: 15_000 });
  const commentBells = await bellsOf(alice, 'pod_comment');
  expect(commentBells.rows).toHaveLength(1);
  expect(commentBells.rows[0]).toMatchObject({ title: `${bob.displayName} commented on your post`, link: `/pods/${podId}?post=${postId}` });

  // A follows the bell: the pod opens on that post, outlined, in view, with the comment open.
  await bellOf(alicePage).click();
  await alicePage.getByText(`${bob.displayName} commented on your post`).first().click();
  await expect(alicePage).toHaveURL(new RegExp(`/pods/${podId}\\?post=${postId}`), { timeout: 30_000 });
  await expect(cardOf(alicePage, postId)).toHaveClass(/ring-rsn-red/);
  await expect(cardOf(alicePage, postId).getByText(reply)).toBeVisible({ timeout: 15_000 });
  const at = await cardOf(alicePage, postId).boundingBox();
  expect(at!.y, 'the linked post is scrolled into view').toBeGreaterThanOrEqual(0);
  expect(at!.y, 'the linked post is scrolled into view').toBeLessThan(844);
  await shot(alicePage, 'bell-landing-390');

  // The posts of the others do not ring the author, and the page stayed the same page all along.
  expect((await bellsOf(alice, 'pod_post')).rows).toHaveLength(0);
});

test('the director pins and deletes; a member can do neither to someone else\'s words, and both are live for everyone', async () => {
  test.setTimeout(240_000);
  const text = `Pin me ${Date.now().toString(36)}`;
  const reply = `A thought ${Date.now().toString(36)}`;
  expect((await apiAs(alice, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: text })).status).toBe(201);
  const postId = await postIdOf(text);
  expect((await apiAs(bob, 'POST', `/pods/${podId}/wall/posts/${postId}/comments`, { content: reply })).status).toBe(201);
  const commentId = await commentIdOf(reply);

  const dirPage = await pageAt(director, `/pods/${podId}`, { width: 1024, height: 768 });
  const bobPage = await pageAt(bob, `/pods/${podId}`, { width: 390, height: 844 });
  const alicePage = await pageAt(alice, `/pods/${podId}`, { width: 1280, height: 900 });
  for (const p of [dirPage, bobPage, alicePage]) await expect(cardOf(p, postId)).toBeVisible({ timeout: 30_000 });

  // A member has no Pin, and no Delete on someone else's post. The author has Delete on her own.
  await expect(cardOf(bobPage, postId).getByTestId(`pin-post-${postId}`)).toHaveCount(0);
  await expect(cardOf(bobPage, postId).getByTestId(`delete-post-${postId}`)).toHaveCount(0);
  await expect(cardOf(alicePage, postId).getByTestId(`delete-post-${postId}`)).toBeVisible();
  await expect(cardOf(alicePage, postId).getByTestId(`pin-post-${postId}`)).toHaveCount(0);

  // The director pins: the badge appears on the others' open pages, live.
  await expect(cardOf(dirPage, postId).getByTestId(`delete-post-${postId}`)).toBeVisible();
  await cardOf(dirPage, postId).getByTestId(`pin-post-${postId}`).click();
  await expect(cardOf(bobPage, postId).getByTestId(`pinned-badge-${postId}`)).toBeVisible({ timeout: 15_000 });
  await expect(cardOf(alicePage, postId).getByTestId(`pinned-badge-${postId}`)).toBeVisible({ timeout: 15_000 });
  await expect(cardOf(dirPage, postId).getByTestId(`pin-post-${postId}`)).toHaveAttribute('aria-label', 'Unpin post');
  expect((await pool.query(`SELECT pinned_at FROM pod_posts WHERE id = $1`, [postId])).rows[0].pinned_at).not.toBeNull();
  await shot(dirPage, 'pinned-1024');

  // A reaction from another member moves the count on an open page, live, and rings the author.
  expect((await apiAs(bob, 'POST', `/pods/${podId}/wall/posts/${postId}/react`, { reaction: 'celebrate' })).status).toBe(200);
  await expect(cardOf(alicePage, postId).getByTestId(`reaction-summary-${postId}`)).toContainText('🎉', { timeout: 15_000 });
  await expect(cardOf(alicePage, postId).getByTestId(`reaction-summary-${postId}`)).toContainText('1');
  const reactionBells = await bellsOf(alice, 'pod_reaction');
  expect(reactionBells.rows.at(-1)).toMatchObject({ title: `${bob.displayName} reacted to your post`, link: `/pods/${podId}?post=${postId}` });

  // The director deletes B's comment: A's count goes back to nothing, live.
  await expect(cardOf(alicePage, postId)).toContainText('1 comment', { timeout: 15_000 });
  await cardOf(dirPage, postId).getByTestId(`comment-button-${postId}`).click();
  acceptNextDialog(dirPage);
  await dirPage.getByTestId(`comment-delete-${commentId}`).click();
  await expect(cardOf(alicePage, postId)).not.toContainText('1 comment', { timeout: 15_000 });
  const gone = await pool.query(`SELECT deleted_at FROM pod_post_comments WHERE id = $1`, [commentId]);
  expect(gone.rows[0].deleted_at).not.toBeNull();

  // ...and the post itself: it leaves every open page, and the row stays, with who removed it.
  acceptNextDialog(dirPage);
  await cardOf(dirPage, postId).getByTestId(`delete-post-${postId}`).click();
  await expect(cardOf(bobPage, postId)).toHaveCount(0, { timeout: 15_000 });
  await expect(cardOf(alicePage, postId)).toHaveCount(0, { timeout: 15_000 });
  await expect(cardOf(dirPage, postId)).toHaveCount(0, { timeout: 15_000 });
  const row = await pool.query(`SELECT deleted_at, deleted_by FROM pod_posts WHERE id = $1`, [postId]);
  expect(row.rows[0].deleted_at).not.toBeNull();
  expect(row.rows[0].deleted_by).toBe(director.id);
});

test('a storm of reactions is read in a few requests, not one per reaction, and the page ends on the last one', async () => {
  test.setTimeout(240_000);
  const text = `Storm ${Date.now().toString(36)}`;
  expect((await apiAs(alice, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: text })).status).toBe(201);
  const postId = await postIdOf(text);

  const page = await pageAt(alice, `/pods/${podId}`, { width: 1280, height: 900 });
  await expect(cardOf(page, postId)).toBeVisible({ timeout: 30_000 });
  let feedReads = 0;
  page.on('request', (r) => { if (r.method() === 'GET' && /\/wall\/posts$/.test(new URL(r.url()).pathname)) feedReads++; });

  // Fifteen changes at once: every one tells every open screen in the pod to read the feed again.
  const kinds = ['like', 'love', 'applause', 'insightful', 'celebrate'];
  const answers = await Promise.all(Array.from({ length: 15 }, (_, i) =>
    apiAs(bob, 'POST', `/pods/${podId}/wall/posts/${postId}/react`, { reaction: kinds[i % kinds.length] })));
  expect(answers.map((a) => a.status)).toEqual(Array(15).fill(200));

  // The page ends on whatever the server ended on (one reaction per member, so the last write stands)...
  const emoji = { like: '👍', love: '❤️', applause: '👏', insightful: '💡', celebrate: '🎉' } as Record<string, string>;
  const served = (await apiAs(alice, 'GET', `/pods/${podId}/wall/posts`)).json.data.posts.find((p: { id: string }) => p.id === postId);
  const [kind] = Object.keys(served.reactions);
  await expect(cardOf(page, postId).getByTestId(`reaction-summary-${postId}`)).toContainText(emoji[kind], { timeout: 15_000 });
  // ...having read the feed a few times, not fifteen.
  await page.waitForTimeout(800);
  expect(feedReads, 'the feed was read at least once').toBeGreaterThanOrEqual(1);
  expect(feedReads, `15 changes read the feed ${feedReads} times`).toBeLessThanOrEqual(4);
});

test('a removed member is told so live and the server answers 403; a visitor reads the same sentence and no posts', async () => {
  test.setTimeout(240_000);
  const text = `Members only ${Date.now().toString(36)}`;
  expect((await apiAs(director, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: text })).status).toBe(201);
  const postId = await postIdOf(text);

  const carolPage = await pageAt(carol, `/pods/${podId}`, { width: 390, height: 844 });
  await expect(cardOf(carolPage, postId)).toBeVisible({ timeout: 30_000 });
  await expect(carolPage.getByPlaceholder(PLACEHOLDER)).toBeVisible();

  expect((await apiAs(director, 'DELETE', `/pods/${podId}/members/${carol.id}`)).status).toBe(200);

  // Her open page flips by itself: no posts, no composer, the sentence.
  await expect(carolPage.getByText(NOT_A_MEMBER)).toBeVisible({ timeout: 20_000 });
  await expect(cardOf(carolPage, postId)).toHaveCount(0);
  await expect(carolPage.getByPlaceholder(PLACEHOLDER)).toHaveCount(0);
  const refused = await apiAs(carol, 'GET', `/pods/${podId}/wall/posts`);
  expect(refused.status).toBe(403);
  expect(refused.json.error.message).toBe('Join this pod to read and post in its discussion');
  expect((await apiAs(carol, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: 'let me in' })).status).toBe(403);
  await shot(carolPage, 'removed-390');

  // On a fresh load it is the same, and her words are not hers to delete any more.
  await carolPage.reload({ waitUntil: 'domcontentloaded' });
  await expect(carolPage.getByText(NOT_A_MEMBER)).toBeVisible({ timeout: 30_000 });
  await expect(carolPage.getByPlaceholder(PLACEHOLDER)).toHaveCount(0);

  // A visitor to the public pod: the page shows, the posts do not.
  const ninaPage = await pageAt(nina, `/pods/${podId}`, { width: 1280, height: 900 });
  await expect(ninaPage.getByText(NOT_A_MEMBER)).toBeVisible({ timeout: 30_000 });
  await expect(ninaPage.getByRole('button', { name: /Join Pod/ })).toBeVisible();
  await expect(cardOf(ninaPage, postId)).toHaveCount(0);
  await expect(ninaPage.getByPlaceholder(PLACEHOLDER)).toHaveCount(0);
  // The server lists a pod's events to its members only: the visitor is told so, not "No events yet."
  await expect(ninaPage.locator('#pod-events').getByText("Members see the pod's events here.")).toBeVisible();
  await expect(ninaPage.getByText('No events yet.')).toHaveCount(0);
  await shot(ninaPage, 'visitor-1280');

  // An admin who is not a member reads and moderates, and is told why there is no composer.
  const adminPage = await pageAt(admin, `/pods/${podId}`, { width: 1280, height: 900 });
  await expect(cardOf(adminPage, postId)).toBeVisible({ timeout: 30_000 });
  await expect(adminPage.getByPlaceholder(PLACEHOLDER)).toHaveCount(0);
  await expect(wallOf(adminPage).getByTestId('pod-wall-cannot-post')).toHaveText('You can read and moderate this discussion. Join the pod to post.');
  await expect(cardOf(adminPage, postId).getByTestId(`delete-post-${postId}`)).toBeVisible();
  await expect(cardOf(adminPage, postId).getByTestId(`pin-post-${postId}`)).toBeVisible();
  await expect(cardOf(adminPage, postId).getByTestId(`react-button-${postId}`)).toHaveCount(0);
});

test('an archived pod takes nothing new, but its director still deletes and its author still deletes her own', async () => {
  test.setTimeout(240_000);
  const mine = `Archive me ${Date.now().toString(36)}`;
  const bobs = `Bob was here ${Date.now().toString(36)}`;
  expect((await apiAs(alice, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: mine })).status).toBe(201);
  expect((await apiAs(bob, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: bobs })).status).toBe(201);
  const aliceId = await postIdOf(mine);
  const bobId = await postIdOf(bobs);

  const alicePage = await pageAt(alice, `/pods/${podId}`, { width: 390, height: 844 });
  const dirPage = await pageAt(director, `/pods/${podId}`, { width: 1280, height: 900 });
  for (const p of [alicePage, dirPage]) await expect(cardOf(p, aliceId)).toBeVisible({ timeout: 30_000 });
  await expect(alicePage.getByPlaceholder(PLACEHOLDER)).toBeVisible();
  await expect(cardOf(alicePage, aliceId).getByTestId(`react-button-${aliceId}`)).toBeVisible();

  // The director archives the pod; both open pages change by themselves. (Archived through PUT, which tells the pod's
  // screens once the new status is saved. The Archive Pod button's own route, DELETE /api/pods/:id, tells them a
  // moment BEFORE it saves, so a page that reads the pod at once can read the old status and then hears nothing
  // more: a server fault this wall cannot fix and reports, see the C11 report. The two tests below cover what the
  // wall does about it.)
  expect((await apiAs(director, 'PUT', `/pods/${podId}`, { status: 'archived' })).status).toBe(200);
  const note = 'This pod is archived, so its discussion is read-only.';
  await expect(wallOf(alicePage).getByTestId('pod-wall-cannot-post')).toHaveText(note, { timeout: 20_000 });
  await expect(wallOf(dirPage).getByTestId('pod-wall-cannot-post')).toHaveText(note, { timeout: 20_000 });
  for (const p of [alicePage, dirPage]) await expect(p.getByPlaceholder(PLACEHOLDER)).toHaveCount(0);
  // Nobody can like, react or comment; the posts stay readable.
  await expect(cardOf(alicePage, bobId)).toBeVisible();
  await expect(cardOf(alicePage, bobId).getByTestId(`react-button-${bobId}`)).toHaveCount(0);
  await expect(cardOf(alicePage, bobId).getByTestId(`reaction-picker-toggle-${bobId}`)).toHaveCount(0);
  await expect(cardOf(dirPage, bobId).getByTestId(`react-button-${bobId}`)).toHaveCount(0);
  await shot(alicePage, 'archived-390');

  // The server agrees, in words.
  const refused = await apiAs(alice, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: 'late' });
  expect(refused.status).toBe(409);
  expect(refused.json.error.message).toBe('This pod is archived, so its discussion is read-only');

  // Moderation and your own words are not switched off: Alice deletes hers, not Bob's; the director pins and deletes Bob's.
  await expect(cardOf(alicePage, aliceId).getByTestId(`delete-post-${aliceId}`)).toBeVisible();
  await expect(cardOf(alicePage, bobId).getByTestId(`delete-post-${bobId}`)).toHaveCount(0);
  await expect(cardOf(alicePage, aliceId).getByTestId(`pin-post-${aliceId}`)).toHaveCount(0);
  acceptNextDialog(alicePage);
  await cardOf(alicePage, aliceId).getByTestId(`delete-post-${aliceId}`).click();
  await expect(cardOf(alicePage, aliceId)).toHaveCount(0, { timeout: 15_000 });
  await expect(cardOf(dirPage, aliceId)).toHaveCount(0, { timeout: 15_000 });
  await cardOf(dirPage, bobId).getByTestId(`pin-post-${bobId}`).click();
  await expect(cardOf(dirPage, bobId).getByTestId(`pinned-badge-${bobId}`)).toBeVisible({ timeout: 15_000 });
  acceptNextDialog(dirPage);
  await cardOf(dirPage, bobId).getByTestId(`delete-post-${bobId}`).click();
  await expect(cardOf(dirPage, bobId)).toHaveCount(0, { timeout: 15_000 });

  // Reactivated, the composer comes back on her open page without a reload.
  expect((await apiAs(director, 'POST', `/pods/${podId}/reactivate`)).status).toBe(200);
  await expect(alicePage.getByPlaceholder(PLACEHOLDER)).toBeVisible({ timeout: 20_000 });

  // A suspended pod is closed to new words in the same way, and says so in its own words.
  expect((await apiAs(director, 'PUT', `/pods/${podId}`, { status: 'suspended' })).status).toBe(200);
  await expect(wallOf(alicePage).getByTestId('pod-wall-cannot-post')).toHaveText('This pod is not open for new activity right now.', { timeout: 20_000 });
  await expect(alicePage.getByPlaceholder(PLACEHOLDER)).toHaveCount(0);
  expect((await apiAs(director, 'PUT', `/pods/${podId}`, { status: 'active' })).status).toBe(200);
  await expect(alicePage.getByPlaceholder(PLACEHOLDER)).toBeVisible({ timeout: 20_000 });
});

test('a page that never heard the pod was archived finds out when its member tries to post, and says why', async () => {
  test.setTimeout(240_000);
  const page = await pageAt(alice, `/pods/${podId}`, { width: 390, height: 844 });
  const composer = page.getByPlaceholder(PLACEHOLDER);
  await expect(composer).toBeVisible({ timeout: 30_000 });

  // The pod is archived behind the page's back, straight in the table, so that not one event is sent: the moment the
  // post is on its way. (Not before: a browser that regains focus reads the wall again, and the page would hear.)
  await page.route(new RegExp(`/api/pods/${podId}/wall/posts$`), async (route) => {
    if (route.request().method() === 'POST') await pool.query(`UPDATE pods SET status = 'archived' WHERE id = $1`, [podId]);
    await route.continue();
  });
  await composer.click();
  await composer.fill('Too late');
  await postButton(page).click();

  // The server's refusal, in its own words; then the wall looks again and the box that was refused goes.
  await expect(page.getByText('This pod is archived, so its discussion is read-only', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(composer).toHaveCount(0, { timeout: 15_000 });
  await expect(wallOf(page).getByTestId('pod-wall-cannot-post')).toHaveText('This pod is archived, so its discussion is read-only.', { timeout: 15_000 });
  await shot(page, 'missed-archive-390');

  await pool.query(`UPDATE pods SET status = 'active' WHERE id = $1`, [podId]);
});

test('a page that read the pod a moment before the archive was saved still ends up saying archived', async () => {
  test.setTimeout(240_000);
  // The Archive Pod button's route (DELETE /api/pods/:id) tells the pod's screens before it saves the new status, so
  // a page that refetches the pod at once can read "active" while the wall (a slower read) already knows the pod is
  // closed. Make that happen without the race: archive through PUT, and answer the first read of the pod after it
  // with the old status.
  const page = await pageAt(alice, `/pods/${podId}`, { width: 390, height: 844 });
  await expect(page.getByPlaceholder(PLACEHOLDER)).toBeVisible({ timeout: 30_000 });
  let staleReads = 0;
  await page.route(new RegExp(`/api/pods/${podId}$`), async (route) => {
    if (route.request().method() !== 'GET' || staleReads > 0) { await route.continue(); return; }
    staleReads++;
    const real = await route.fetch();
    const body = await real.json();
    body.data.status = 'active';
    await route.fulfill({ response: real, json: body });
  });

  expect((await apiAs(director, 'PUT', `/pods/${podId}`, { status: 'archived' })).status).toBe(200);
  await expect(page.getByPlaceholder(PLACEHOLDER), 'the wall knows at once: no composer').toHaveCount(0, { timeout: 20_000 });
  // The page settles on the truth, by itself: the wall noticed the two reads disagreed and read the pod again.
  await expect(wallOf(page).getByTestId('pod-wall-cannot-post')).toHaveText('This pod is archived, so its discussion is read-only.', { timeout: 20_000 });
  await expect(page.getByText('Archived', { exact: true }), 'the header names the state in a word').toBeVisible();
  await expect(page.getByText('archived', { exact: true }), 'and never as the stored value').toHaveCount(0);
  expect(staleReads, 'the pod really was read stale once').toBe(1);

  expect((await apiAs(director, 'POST', `/pods/${podId}/reactivate`)).status).toBe(200);
  await expect(page.getByPlaceholder(PLACEHOLDER)).toBeVisible({ timeout: 20_000 });
});

test('a block leaves the other\'s posts out of the page at once, and a closed account reads "Former member" with no profile link', async () => {
  test.setTimeout(240_000);
  const hers = `Blockable ${Date.now().toString(36)}`;
  expect((await apiAs(dora, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: hers })).status).toBe(201);
  const postId = await postIdOf(hers);

  // B has the page open and blocks D (the post's author); the post goes from B's page without a reload, and comes back when B unblocks.
  const bobPage = await pageAt(bob, `/pods/${podId}`, { width: 1280, height: 900 });
  await expect(cardOf(bobPage, postId)).toBeVisible({ timeout: 30_000 });
  expect((await apiAs(bob, 'POST', `/users/${dora.id}/block`, {})).status).toBe(200);
  await expect(cardOf(bobPage, postId)).toHaveCount(0, { timeout: 15_000 });
  expect((await apiAs(bob, 'DELETE', `/users/${dora.id}/block`)).status).toBe(200);
  await expect(cardOf(bobPage, postId)).toBeVisible({ timeout: 15_000 });

  // A member whose account was closed: the words stay, as "Former member", and lead nowhere.
  const [farewellId] = await seedPosts(podId, gone.id, 1, 'A farewell');
  await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [gone.id]);
  await bobPage.reload({ waitUntil: 'domcontentloaded' });
  const farewell = cardOf(bobPage, farewellId);
  await expect(farewell).toBeVisible({ timeout: 30_000 });
  await expect(farewell).toContainText('Former member');
  await expect(farewell).not.toContainText(gone.displayName);
  await expect(farewell.locator('a[href^="/people/"]'), 'a closed account has no profile link').toHaveCount(0);
  await expect(cardOf(bobPage, postId).locator('a[href^="/people/"]'), 'an open account has').not.toHaveCount(0);
  await farewell.scrollIntoViewIfNeeded();
  await shot(bobPage, 'former-member-1280');
});

test('the first ten posts, Load more, and a ?post= link to a post that is not on the first page', async () => {
  test.setTimeout(240_000);
  const ids = await seedPosts(bigPodId, director.id, 25, 'Long thread');
  const cards = (page: Page) => page.locator('[data-testid^="wall-post-"]');
  const loadMore = (page: Page) => page.getByTestId('pod-wall-load-more');

  const page = await pageAt(alice, `/pods/${bigPodId}`, { width: 390, height: 844 });
  await expect(wallOf(page)).toBeVisible({ timeout: 30_000 });
  // The header says how the pod's events run in plain words, read through its type: not "timed rounds", and no communication badge.
  await expect(page.getByText('Freeform', { exact: true })).toBeVisible();
  await expect(page.getByText('timed rounds', { exact: true })).toHaveCount(0);
  await expect(page.getByText('hybrid', { exact: true })).toHaveCount(0);
  await expect(cards(page)).toHaveCount(10, { timeout: 15_000 });
  await expect(cards(page).first()).toContainText('Long thread 25');
  await loadMore(page).click();
  await expect(cards(page)).toHaveCount(20);
  await loadMore(page).click();
  await expect(cards(page)).toHaveCount(25, { timeout: 15_000 });
  await expect(loadMore(page), 'nothing more to load').toHaveCount(0);

  // The oldest post is on the second page the server serves; a link to it brings it up on top and into view.
  const oldest = ids[0];
  const linked = await pageAt(alice, `/pods/${bigPodId}?post=${oldest}`, { width: 390, height: 844 });
  await expect(linked.getByTestId('linked-post')).toBeVisible({ timeout: 30_000 });
  await expect(cardOf(linked, oldest)).toHaveClass(/ring-rsn-red/);
  const at = await cardOf(linked, oldest).boundingBox();
  expect(at!.y).toBeGreaterThanOrEqual(0);
  expect(at!.y).toBeLessThan(844);

  // A post that is on the second page of what is loaded is shown where it stands once the page has grown to it.
  const middle = await pageAt(alice, `/pods/${bigPodId}?post=${ids[8]}`, { width: 390, height: 844 });
  await expect(cardOf(middle, ids[8])).toBeVisible({ timeout: 30_000 });
  await expect(cardOf(middle, ids[8])).toHaveClass(/ring-rsn-red/);

  // A link to a post that is gone says so and breaks nothing.
  const missing = await pageAt(alice, `/pods/${bigPodId}?post=${crypto.randomUUID()}`, { width: 390, height: 844 });
  await expect(missing.getByText('That post is no longer available.')).toBeVisible({ timeout: 30_000 });
  await expect(cards(missing)).toHaveCount(10);
});

test('a thread of more than 400 comments shows the first 400 and says so', async () => {
  test.setTimeout(240_000);
  const [busy] = await seedPosts(bigPodId, director.id, 1, 'A very busy thread');
  await pool.query(
    `INSERT INTO pod_post_comments (post_id, author_id, content, created_at)
     SELECT $1, $2, 'Comment ' || n, NOW() - make_interval(secs => 1000 - n) FROM generate_series(1, 401) AS n`,
    [busy, director.id],
  );
  await pool.query(`UPDATE pod_posts SET comment_count = 401 WHERE id = $1`, [busy]);

  const page = await pageAt(alice, `/pods/${bigPodId}?post=${busy}`, { width: 390, height: 844 });
  const thread = page.getByTestId(`comments-${busy}`);
  await expect(thread).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`comments-truncated-${busy}`)).toHaveText('Showing the first 400 comments.', { timeout: 15_000 });
  await expect(thread.getByTestId(/^comment-[0-9a-f-]{36}$/)).toHaveCount(400);
  await expect(thread.getByText('Comment 1', { exact: true })).toBeVisible();
  await expect(thread.getByText('Comment 401', { exact: true }), 'the newest is not in the list').toHaveCount(0);
});

test('a populated pod at 360, 390, 414, 768, 1024, 1280 and 1440: no sideways scroll, 44px controls, two columns from 1024px', async () => {
  test.setTimeout(480_000);
  expect((await apiAs(director, 'GET', `/pods/${podId}`)).json.data.status, 'the pod is active again').toBe('active');
  const long = `Unbroken ${'W'.repeat(70)} and a link https://example.com/a/very/long/path/${'x'.repeat(60)}`;
  const first = `Plain post ${Date.now().toString(36)}`;
  expect((await apiAs(dora, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: long })).status).toBe(201);
  expect((await apiAs(bob, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: first })).status).toBe(201);
  const firstId = await postIdOf(first);
  const c1 = await apiAs(alice, 'POST', `/pods/${podId}/wall/posts/${firstId}/comments`, { content: 'First comment' });
  expect((await apiAs(bob, 'POST', `/pods/${podId}/wall/posts/${firstId}/comments`, { content: 'A reply', parentCommentId: c1.json.data.id })).status).toBe(201);
  expect((await apiAs(alice, 'POST', `/pods/${podId}/wall/posts/${firstId}/react`, { reaction: 'celebrate' })).status).toBe(200);
  await apiAs(director, 'POST', `/pods/${podId}/wall/posts/${firstId}/pin`);
  // Three events, made out of order: one that has ended, and two to come.
  const day = 86_400_000;
  await createSession(director, podId, `Later ${RUN}`, new Date(Date.now() + 9 * day));
  const over = await createSession(director, podId, `Over ${RUN}`, new Date(Date.now() + day));
  await createSession(director, podId, `Soon ${RUN}`, new Date(Date.now() + 2 * day));
  await pool.query(`UPDATE sessions SET status = 'completed', scheduled_at = NOW() - interval '3 days' WHERE id = $1`, [over.id]);

  for (const vp of WIDTHS) {
    const label = `${vp.width}px`;
    const page = await pageAt(director, `/pods/${podId}?post=${firstId}`, vp);
    const wall = wallOf(page);
    await expect(wall, label).toBeVisible({ timeout: 30_000 });
    await expect(cardOf(page, firstId), label).toBeVisible();
    await expect(page.getByText('A reply'), `${label}: the linked post opens its comments`).toBeVisible();
    await expect(page.getByText('Timed rounds', { exact: true }), `${label}: the header names how events run`).toBeVisible();
    await expect(page.getByText('timed rounds', { exact: true }), `${label}: the raw column value`).toHaveCount(0);
    await expect(page.getByText('hybrid', { exact: true }), `${label}: the communication mode`).toHaveCount(0);
    // (The header's badge comes first; a director also has an "Active" tab over the member list.)
    await expect(page.getByText('Active', { exact: true }).first(), `${label}: the pod's state in a word`).toBeVisible();

    // The events: what is coming, soonest first, then what has ended.
    const eventList = page.locator('#pod-events');
    const yOf = async (title: string) => (await eventList.getByText(title, { exact: true }).boundingBox())!.y;
    expect(await yOf(`Soon ${RUN}`), `${label}: the next event first`).toBeLessThan(await yOf(`Later ${RUN}`));
    expect(await yOf(`Later ${RUN}`), `${label}: what has ended after what is coming`).toBeLessThan(await yOf(`Over ${RUN}`));

    // No sideways scroll, on the document or in the shell's own scroll area.
    const over = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - window.innerWidth,
      main: (document.querySelector('main')?.scrollWidth ?? 0) - (document.querySelector('main')?.clientWidth ?? 0),
    }));
    expect(over.doc, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(0);
    expect(over.main, `${label}: the shell's scroll area scrolls sideways`).toBeLessThanOrEqual(0);

    // Every control of the wall is a 44px target (an author's name and the links inside a sentence are text links).
    const small = await wall.evaluate((root) => {
      const out: string[] = [];
      for (const node of Array.from(root.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, label'))) {
        const r = node.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (node.tagName === 'A' && (node.closest('p') || node.querySelector(':scope > p'))) continue;
        if (r.height < 43.5) out.push(`${node.tagName.toLowerCase()} "${(node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 30)}" is ${Math.round(r.height)}px tall`);
      }
      return out;
    });
    expect(small, `${label}: controls under 44px`).toEqual([]);

    // The sections: chips on a phone and a tablet, side by side from 1024px.
    const discussion = await page.locator('#pod-discussion').boundingBox();
    const events = await page.locator('#pod-events').boundingBox();
    const members = await page.locator('#pod-members').boundingBox();
    const chips = page.getByRole('navigation', { name: 'Jump to a section' }).getByRole('link');
    if (vp.width < 1024) {
      await expect(chips, label).toHaveCount(3);
      await expect(chips.nth(0)).toHaveText('Discussion');
      await expect(chips.nth(1)).toHaveText('Events');
      await expect(chips.nth(2)).toHaveText('Members');
      for (let i = 0; i < 3; i++) expect((await chips.nth(i).boundingBox())!.height, `${label}: chip ${i}`).toBeGreaterThanOrEqual(44);
      expect(events!.y, `${label}: events under the discussion`).toBeGreaterThan(discussion!.y + discussion!.height - 1);
      expect(Math.abs(events!.x - discussion!.x), `${label}: one column`).toBeLessThanOrEqual(1);
      expect(members!.y, `${label}: members under the events`).toBeGreaterThan(events!.y + events!.height - 1);
    } else {
      await expect(chips, `${label}: the chips are gone`).toBeHidden();
      expect(events!.x, `${label}: events beside the discussion`).toBeGreaterThan(discussion!.x + discussion!.width - 1);
      expect(Math.abs(events!.width - 320), `${label}: the side column is 320px`).toBeLessThanOrEqual(1);
      expect(Math.abs(members!.x - events!.x), `${label}: members under the events`).toBeLessThanOrEqual(1);
      expect(events!.y, `${label}: the columns start together`).toBeLessThanOrEqual(discussion!.y + 60);
    }

    // The composer and its Post button can be pressed where they are, not under the phone's bottom bar.
    const composer = page.getByPlaceholder(PLACEHOLDER);
    await composer.scrollIntoViewIfNeeded();
    await composer.click();
    await postButton(page).scrollIntoViewIfNeeded();
    await expectReachable(page, postButton(page), `${label}: Post`);
    await expectReachable(page, composer, `${label}: the composer`);
    await shot(page, `pod-${vp.width}`);
    if (SHOTS) await wall.screenshot({ path: path.join(SHOTS, `${engineLabel().replace('/', '-')}-wall-${vp.width}.png`) }).catch(() => {});
    await page.context().close();
  }
});

test('the write limit answers in words, and what was typed stays', async () => {
  test.setTimeout(240_000);
  const seed = `Limit probe ${Date.now().toString(36)}`;
  expect((await apiAs(dora, 'POST', `/pods/${podId}/wall/posts`, { clientId: crypto.randomUUID(), content: seed })).status).toBe(201);
  const postId = await postIdOf(seed);

  // 60 writes a minute are allowed. The same reaction sent again changes nothing, but it counts.
  let limited: { status: number; json: { error: { message: string } } } | null = null;
  for (let i = 0; i < 70 && !limited; i++) {
    const r = await apiAs(dora, 'POST', `/pods/${podId}/wall/posts/${postId}/react`, { reaction: 'like' });
    if (r.status === 429) limited = r;
  }
  expect(limited, 'a 429 inside 70 writes').not.toBeNull();
  expect(limited!.json.error.message).toBe('Slow down a moment, then try again.');

  const page = await pageAt(dora, `/pods/${podId}`, { width: 390, height: 844 });
  const composer = page.getByPlaceholder(PLACEHOLDER);
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.click();
  await composer.fill('Typed while limited');
  await postButton(page).click();
  await expect(page.getByText('Slow down a moment, then try again.')).toBeVisible({ timeout: 15_000 });
  await expect(composer, 'the typed text is kept').toHaveValue('Typed while limited');
  await expect(postButton(page), 'and can be sent again').toBeEnabled();
  await shot(page, 'limited-390');
});
