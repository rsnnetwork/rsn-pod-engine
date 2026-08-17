import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// 30 Jul 2026 evaluation, critical bug 4: "Links inside circle posts are not
// clickable. URLs such as the Luma link must automatically become active links."
//
// Before this, a URL in a post body rendered as dead text; only the FIRST url
// in a post surfaced, as a separate card below it. Comment URLs were dead
// entirely. Covers posts, comments, several links in one body, punctuation at
// the end of a sentence, and the security case: nothing but http/https may ever
// become a link, and no post content is ever injected as HTML.

let browser: Browser;
let admin: TestUser, member: TestUser;
const ctxs: BrowserContext[] = [];
let circleId = '';

const LUMA = 'https://lu.ma/rsn-london';
const SECOND = 'https://rsn.network/events';

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const uuid = () => crypto.randomUUID();

async function openWall(u: TestUser, viewport = { width: 390, height: 844 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/circles/${circleId}`);
  await expect(page.getByTestId('circle-wall')).toBeVisible({ timeout: 30_000 });
  return page;
}

test.beforeAll(async () => {
  admin = await createTestUser('lnkadmin', 'super_admin');
  member = await createTestUser('lnkmember');
  browser = await chromium.launch({ headless: false });
  const created = await apiAs(admin, 'POST', '/circles', { name: `E2E Links ${Date.now()}` });
  circleId = created.json.data.id;
  await apiAs(member, 'POST', `/circles/${circleId}/join`);
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  if (circleId) await pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]).catch(() => {});
  await cleanup(pool, { ids: [admin?.id, member?.id].filter(Boolean) });
});

test('a URL inside a post body is a real, working link', async () => {
  test.setTimeout(180_000);
  const posted = await apiAs(member, 'POST', `/circles/${circleId}/posts`, {
    clientId: uuid(), content: `Next meetup is here ${LUMA} come along`,
  });
  expect(posted.status).toBe(201);

  const page = await openWall(member);
  const link = page.locator(`a[href="${LUMA}"]`).first();
  await expect(link, 'the URL in the body must be an anchor').toBeVisible({ timeout: 30_000 });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  // Tap target on a phone: the link must be big enough to hit.
  const box = await link.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(14);
  await page.screenshot({ path: 'test-results/links-post.png' }).catch(() => {});
  console.log('  ✓ post body URL is a live link.');
});

test('several URLs in one post all become links, and trailing punctuation stays out of the href', async () => {
  test.setTimeout(180_000);
  await apiAs(member, 'POST', `/circles/${circleId}/posts`, {
    clientId: uuid(), content: `Two of them: ${LUMA} and also ${SECOND}. Both should work.`,
  });

  const page = await openWall(member);
  await expect(page.locator(`a[href="${LUMA}"]`).first()).toBeVisible({ timeout: 30_000 });
  // The second URL ends the sentence — the full stop must not be in the href.
  await expect(page.locator(`a[href="${SECOND}"]`).first(), 'trailing period must not be part of the link').toBeVisible();
  await expect(page.locator(`a[href="${SECOND}."]`)).toHaveCount(0);
  console.log('  ✓ multiple links per post; sentence punctuation excluded from the href.');
});

const BARE = 'www.fathom.video/share/abc123';

test('a bare www link is clickable and gets an https scheme', async () => {
  test.setTimeout(180_000);
  await apiAs(member, 'POST', `/circles/${circleId}/posts`, {
    clientId: uuid(), content: `Recording is at ${BARE} — have a look.`,
  });

  const page = await openWall(member);
  // The href must be absolute, or the browser resolves it against app.rsn.network.
  const link = page.locator(`a[href="https://${BARE}"]`).first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  // The visible text stays as the member typed it.
  await expect(link).toHaveText(BARE);
  console.log('  ✓ bare www link resolved to an absolute https href.');
});

test('a bare domain is NOT invented out of ordinary prose', async () => {
  test.setTimeout(180_000);
  await apiAs(member, 'POST', `/circles/${circleId}/posts`, {
    clientId: uuid(), content: 'Ask me about node.js vs deno. Costs approx.4 hours. See e.g. below.',
  });

  const page = await openWall(member);
  // node.js, approx.4 and e.g. must never become links.
  await expect(page.locator('a[href*="node.js"]')).toHaveCount(0);
  await expect(page.locator('a[href*="approx"]')).toHaveCount(0);
  await expect(page.locator('a[href*="e.g"]')).toHaveCount(0);
  console.log('  ✓ prose containing dots stayed prose.');
});

test('a URL inside a comment is a real link too', async () => {
  test.setTimeout(180_000);
  const post = await apiAs(member, 'POST', `/circles/${circleId}/posts`, {
    clientId: uuid(), content: 'Thread for links',
  });
  const postId = post.json.data.id;
  await apiAs(member, 'POST', `/circles/posts/${postId}/comments`, { content: `details at ${SECOND}` });

  const page = await openWall(member);
  // Expand that post's comment thread (the toggle shows the comment count).
  const card = page.getByTestId(`wall-post-${postId}`).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.locator('button').first().click();
  await expect(page.locator(`a[href="${SECOND}"]`).first()).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ comment URL is a live link.');
});

test('SECURITY: a javascript: URL is never turned into a link, and content is never injected as HTML', async () => {
  test.setTimeout(180_000);
  const NASTY = 'javascript:alert(1)';
  const HTML = '<img src=x onerror="alert(2)">';
  await apiAs(member, 'POST', `/circles/${circleId}/posts`, {
    clientId: uuid(), content: `${NASTY} and ${HTML} should be inert text`,
  });

  const page = await openWall(member);
  await expect(page.getByText(/should be inert text/)).toBeVisible({ timeout: 30_000 });
  // No anchor may carry a javascript: href.
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  // The markup must not have been parsed into a real element.
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  // ...and it must still be readable as the plain text the member typed.
  await expect(page.getByText(NASTY, { exact: false })).toBeVisible();
  console.log('  ✓ javascript: stays inert; raw HTML renders as escaped text.');
});
