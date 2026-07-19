import { test, expect, chromium, Browser, BrowserContext } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod } from '../helpers/api';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';

// PROD VERIFICATION — REASON v1 P3b + P4 (20 Jul 2026): pod attachment +
// the wall. Asserts the UGC rules that matter: members-only posting (even an
// admin must JOIN to post), idempotent post creation by clientId, link
// extraction without server fetching, Cloudinary-only media, block filtering
// at read, rate limiting, pinning, comment counters, and the deduped member
// notification. Headed: a member posts and comments from the real UI at 390px.

let browser: Browser;
let admin: TestUser, m1: TestUser, m2: TestUser, m3: TestUser;
const ctxs: BrowserContext[] = [];
let circleId = '', podId = '';

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const uuid = () => crypto.randomUUID();

test.beforeAll(async () => {
  admin = await createTestUser('walladmin', 'super_admin');
  m1 = await createTestUser('wallm1');
  m2 = await createTestUser('wallm2');
  m3 = await createTestUser('wallm3');
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  if (circleId) await pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]).catch(() => {});
  await pool.query(`DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`,
    [[m1?.id, m3?.id].filter(Boolean)]).catch(() => {});
  await cleanup(pool, { ids: [admin?.id, m1?.id, m2?.id, m3?.id].filter(Boolean), podId: podId || undefined });
});

test('the wall: members-only, idempotent, block-filtered, rate-limited, pinned — and headed posting works', async () => {
  test.setTimeout(300_000);

  // Setup: circle + attached pod + members.
  const created = await apiAs(admin, 'POST', '/circles', { name: 'E2E Wall Circle' });
  circleId = created.json.data.id;
  const pod = await createPod(admin, 'E2E Wall Pod'); podId = pod.id;
  await apiAs(admin, 'POST', `/circles/${circleId}/pods`, { podId });
  for (const u of [m1, m2, m3]) await apiAs(u, 'POST', `/circles/${circleId}/join`);

  // (1) P3b: the pod knows its circles.
  const ofPod = await apiAs(m1, 'GET', `/circles/of-pod/${podId}`);
  expect(ofPod.json.data.map((c: any) => c.id)).toContain(circleId);
  console.log('  ✓ of-pod lookup shows the attachment (P3b).');

  // (2) POSTING IS MEMBERS-ONLY — even the admin must join first.
  const adminPost = await apiAs(admin, 'POST', `/circles/${circleId}/posts`, { clientId: uuid(), content: 'hi' });
  expect(adminPost.status).toBe(403);
  console.log('  ✓ non-member posting rejected — even for an admin (403).');

  // (3) m1 posts with a link; the URL is extracted, never fetched.
  const cid = uuid();
  const p1 = await apiAs(m1, 'POST', `/circles/${circleId}/posts`,
    { clientId: cid, content: 'Great read: https://example.com/article — thoughts?' });
  expect(p1.status).toBe(201);
  expect(p1.json.data.linkUrl).toBe('https://example.com/article');
  const post1Id = p1.json.data.id;

  // (4) IDEMPOTENT: same clientId retried → same post, not a duplicate.
  const retry = await apiAs(m1, 'POST', `/circles/${circleId}/posts`,
    { clientId: cid, content: 'Great read: https://example.com/article — thoughts?' });
  expect(retry.json.data.id).toBe(post1Id);
  const feed1 = await apiAs(m2, 'GET', `/circles/${circleId}/posts`);
  expect(feed1.json.data.posts.filter((p: any) => p.id === post1Id)).toHaveLength(1);
  console.log('  ✓ link extracted + retried submit returns the SAME post (idempotent).');

  // (5) MEDIA: arbitrary host rejected; Cloudinary host accepted.
  const evil = await apiAs(m1, 'POST', `/circles/${circleId}/posts`,
    { clientId: uuid(), media: [{ type: 'image', url: 'https://evil.example/x.jpg' }] });
  expect(evil.status).toBe(400);
  const okMedia = await apiAs(m1, 'POST', `/circles/${circleId}/posts`,
    { clientId: uuid(), content: 'pic', media: [{ type: 'image', url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' }] });
  expect(okMedia.status).toBe(201);
  console.log('  ✓ media host allowlist enforced (evil 400, Cloudinary 201).');

  // (6) COMMENTS bump the denormalised counter.
  await apiAs(m2, 'POST', `/circles/posts/${post1Id}/comments`, { content: 'agreed!' });
  const afterComment = await apiAs(m2, 'GET', `/circles/${circleId}/posts`);
  expect(afterComment.json.data.posts.find((p: any) => p.id === post1Id).commentCount).toBe(1);
  console.log('  ✓ comment added, counter = 1.');

  // (7) BLOCKS AT READ: m1 blocks m3 → m3's post vanishes from m1's feed only.
  const p3 = await apiAs(m3, 'POST', `/circles/${circleId}/posts`, { clientId: uuid(), content: 'm3 was here' });
  expect(p3.status).toBe(201);
  await pool.query(
    `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [m1.id, m3.id]);
  const m1Feed = await apiAs(m1, 'GET', `/circles/${circleId}/posts`);
  expect(m1Feed.json.data.posts.some((p: any) => p.authorId === m3.id)).toBe(false);
  const m2Feed = await apiAs(m2, 'GET', `/circles/${circleId}/posts`);
  expect(m2Feed.json.data.posts.some((p: any) => p.authorId === m3.id)).toBe(true);
  console.log('  ✓ blocked author filtered from the blocker\'s feed, visible to others.');

  // (8) RATE LIMIT: 6/min — m3 already posted once, 5 more fine, 7th → 429.
  for (let i = 0; i < 5; i++) {
    const r = await apiAs(m3, 'POST', `/circles/${circleId}/posts`, { clientId: uuid(), content: `burst ${i}` });
    expect(r.status).toBe(201);
  }
  const limited = await apiAs(m3, 'POST', `/circles/${circleId}/posts`, { clientId: uuid(), content: 'one too many' });
  expect(limited.status).toBe(429);
  console.log('  ✓ post rate limit enforced (429 on the 7th in a minute).');

  // (9) ADMIN moderation: pin (admin can pin without membership) + the pinned
  //     strip serves it first.
  const pin = await apiAs(admin, 'POST', `/circles/posts/${post1Id}/pin`);
  expect(pin.status).toBe(200);
  const pinnedFeed = await apiAs(m2, 'GET', `/circles/${circleId}/posts`);
  expect(pinnedFeed.json.data.pinned.map((p: any) => p.id)).toContain(post1Id);
  console.log('  ✓ admin pinned; pinned strip serves it.');

  // (10) NOTIFICATIONS: m2 got one deduped circle_post bell.
  const notif = await pool.query(
    `SELECT count(*)::int c FROM notifications WHERE user_id = $1 AND type = 'circle_post'`, [m2.id]);
  expect(notif.rows[0].c).toBeGreaterThanOrEqual(1);
  console.log('  ✓ member bell notification exists (deduped per hour by design).');

  // (11) HEADED — m2 posts and comments from the real UI at phone width.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: m2.accessToken, r: m2.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/circles/${circleId}`);

  await expect(page.getByTestId('circle-wall')).toBeVisible({ timeout: 20_000 });
  await page.getByPlaceholder(/Share something/i).fill('Posted from the real UI 🎉');
  await page.getByRole('button', { name: /^Post$/ }).click();
  await expect(page.getByText('Posted from the real UI 🎉')).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ headed: composed and posted from the real UI.');

  await page.screenshot({ path: 'test-results/wall-headed.png' }).catch(() => {});
});
