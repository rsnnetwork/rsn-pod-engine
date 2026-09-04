import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// ALI'S 8-STEP TEST SCRIPT, RUN BY THE MACHINE FIRST (4 Sep 2026).
//
// "Do it yourself and then I'll test." This drives his real test account
// (alihammza143@gmail.com) through the exact steps handed to him, on
// production, headed, with a screenshot at every step under
// e2e/shots/walkthrough/. A second throwaway account plays the other member.
// The account is reset at the end so the email is free for his own run.
//
// Needs JWT_SECRET (prod) in the environment: run through .claude/*.sh or
// export it from e2e/.jwt_secret first.

const ALI_EMAIL = 'alihammza143@gmail.com';
const ALI_SLUG = 'ali-hamza-b0650a281';
const REASON = 'because i want to meet recruiters';
const SHOTS = 'shots/walkthrough';

let browser: Browser;
let admin: TestUser, mate: TestUser;
const ctxs: BrowserContext[] = [];
let aliId = '', circleA = '', circleB = '';
let shotNo = 0;

const shot = async (page: Page, name: string) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = `${SHOTS}/${String(++shotNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  📸 ${file}`);
};

async function apiAs(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function phone(u?: TestUser, path = '/'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
  if (u) {
    await ctx.addInitScript((t: { a: string; r: string }) => {
      localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
    }, { a: u.accessToken, r: u.refreshToken });
  }
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

const bubbles = (page: Page) => page.locator('.whitespace-pre-wrap');
async function say(page: Page, text: string) {
  const before = await bubbles(page).count();
  const box = page.locator('textarea[aria-label="Your answer"]');
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(bubbles(page)).toHaveCount(before + 2, { timeout: 60_000 });
  const reply = ((await bubbles(page).last().textContent()) || '').trim();
  if (/503|unavailable right now/i.test(reply)) throw new Error('the host answered with the LLM-disabled fallback');
  console.log(`  ALI:  ${text}\n  HOST: ${reply}`);
  return reply;
}

const aliToken = () => jwt.sign(
  { sub: aliId, email: ALI_EMAIL, role: 'member', displayName: 'Ali Hamza', sessionId: crypto.randomUUID() },
  process.env.JWT_SECRET!, { expiresIn: '1h' });

test.beforeAll(async () => {
  admin = await createTestUser('walkadmin', 'super_admin');
  mate = await createTestUser('walkmate');
  await pool.query(`UPDATE users SET display_name = 'Walkthrough Mate' WHERE id = $1`, [mate.id]);
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  for (const id of [circleA, circleB]) if (id) await pool.query(`DELETE FROM circles WHERE id = $1`, [id]).catch(() => {});
  // Leave the email free for Ali's own run. This goes FIRST: the join request
  // it removes was reviewed by the temp admin, and that reference blocked the
  // admin's cleanup on the first run.
  console.log(execSync(`node reset-test-account.mjs ${ALI_EMAIL} --apply`, { encoding: 'utf8' }).split('\n').filter(l => /FREE|STILL|deleted/.test(l)).join('\n'));
  const ids = [admin?.id, mate?.id].filter(Boolean);
  await pool.query(`DELETE FROM direct_messages WHERE conversation_id IN (SELECT id FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids });
  await cleanupByPrefix(pool, 'e2etest-walk');
});

test("Ali's script, steps 1 to 8, on production", async () => {
  test.setTimeout(1_200_000);

  // ── Step 1: reset, request to join from the public form, approve as admin ──
  const reset = execSync(`node reset-test-account.mjs ${ALI_EMAIL} --apply`, { encoding: 'utf8' });
  expect(reset).toMatch(/FREE to request to join/);
  console.log('  step 1: account reset, email free.');

  const joinPage = await phone(undefined, '/request-to-join');
  await joinPage.getByPlaceholder('Your full name').fill('Ali Hamza');
  await joinPage.getByPlaceholder('you@example.com').fill(ALI_EMAIL);
  await joinPage.getByPlaceholder('your-username').fill(ALI_SLUG);
  await joinPage.getByPlaceholder(/Tell us about yourself/i).fill(REASON);
  await shot(joinPage, 'request-to-join-form');
  await joinPage.getByRole('button', { name: 'Submit Request' }).click();
  await expect(joinPage.getByText('Request Submitted')).toBeVisible({ timeout: 30_000 });
  await shot(joinPage, 'request-submitted');

  const jr = await pool.query(`SELECT id, status::text s FROM join_requests WHERE lower(email) = $1`, [ALI_EMAIL]);
  expect(jr.rows).toHaveLength(1);
  expect(jr.rows[0].s).toBe('pending');
  const approve = await apiAs(admin.accessToken, 'PATCH', `/join-requests/${jr.rows[0].id}/review`, { decision: 'approved' });
  expect(approve.status, `approve: ${JSON.stringify(approve.json)}`).toBe(200);
  console.log('  step 1: approved as admin (approval email sent to the real inbox).');

  // The approval preloads the LinkedIn enrichment; wait for it so the card is ready at login.
  await expect.poll(async () =>
    (await pool.query(`SELECT enriched IS NOT NULL AS done FROM join_requests WHERE id = $1`, [jr.rows[0].id])).rows[0].done,
    { timeout: 240_000, intervals: [5_000] }).toBe(true);
  const enr = await pool.query(`SELECT enriched->'profile'->>'currentRole' AS role, enriched->'profile'->>'currentCompany' AS company FROM join_requests WHERE id = $1`, [jr.rows[0].id]);
  console.log(`  step 1: card preloaded at approval: role=${enr.rows[0].role} company=${enr.rows[0].company}`);

  // ── Step 2: log in through the one-click link, see the card, get the host's opening ──
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
    [ALI_EMAIL, crypto.createHash('sha256').update(token).digest('hex')]);
  const ali = await phone(undefined, `/auth/verify?token=${token}`);
  await expect(ali).toHaveURL(/\/onboarding/, { timeout: 90_000 });
  const u = await pool.query(`SELECT id, display_name FROM users WHERE lower(email) = $1`, [ALI_EMAIL]);
  aliId = u.rows[0].id;
  console.log(`  step 2: logged in via magic link as ${u.rows[0].display_name} (${aliId}), gate sent him to onboarding.`);

  const cont = ali.getByRole('button', { name: /Yes, continue/i });
  await expect(cont).toBeVisible({ timeout: 180_000 });
  await expect(ali.getByText('MLOps & Geospatial Engineer', { exact: true })).toBeVisible();
  await expect(ali.getByText(REASON)).toBeVisible();
  await shot(ali, 'card-with-role-and-reason');
  await cont.click();
  await expect(bubbles(ali).first()).toBeVisible({ timeout: 60_000 });
  const opening = ((await bubbles(ali).first().textContent()) || '').trim();
  console.log(`  step 2: HOST OPENING: ${opening}`);
  expect(opening).not.toBe('Who would be most valuable for you to meet?');
  expect(opening).not.toBe('What brings you to Reason?');
  expect(opening).not.toMatch(/what brings you/i);
  expect(opening).toMatch(/recruit|Axorvian|MLOps|geospatial/i);
  await shot(ali, 'host-opening');

  // ── Step 3: finish the chat, confirm, toast, one active agent + drafts, resume one ──
  await say(ali, 'I am an MLOps and geospatial engineer at Axorvian, I build Geo AI pipelines and deploy models.');
  await say(ali, 'I want to meet recruiters and hiring managers at geospatial or AI companies, and maybe a data engineer to swap notes with.');
  await say(ali, 'I can help others with MLOps pipelines, model deployment and monitoring.');
  const confirmBtn = ali.getByRole('button', { name: /Yes, use this/i });
  for (let i = 0; i < 3 && !(await confirmBtn.isVisible().catch(() => false)); i++) {
    const done = ali.getByRole('button', { name: /I'm done/i });
    if (await done.isVisible().catch(() => false)) {
      const before = await bubbles(ali).count();
      await done.click();
      await expect(bubbles(ali)).toHaveCount(before + 2, { timeout: 60_000 });
      console.log(`  (I'm done)\n  HOST: ${((await bubbles(ali).last().textContent()) || '').trim()}`);
    }
  }
  await expect(confirmBtn).toBeVisible({ timeout: 30_000 });
  await shot(ali, 'summary-before-confirm');
  await confirmBtn.click();
  await expect(ali).toHaveURL(/\/agents/, { timeout: 60_000 });
  const toast = ali.getByText(/searching now/i).first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  const toastText = ((await toast.textContent()) || '').trim();
  console.log(`  step 3: TOAST: ${toastText}`);
  await shot(ali, 'welcome-toast-on-suggestions');

  const agents = await pool.query(`SELECT id, label, status, last_matched_at FROM matching_agents WHERE user_id = $1 ORDER BY created_at`, [aliId]);
  console.log(`  step 3: AGENTS: ${agents.rows.map(a => `${a.label} [${a.status}]`).join(' | ')}`);
  const active = agents.rows.filter(a => a.status === 'active');
  const drafts = agents.rows.filter(a => a.status === 'paused');
  expect(active.length, 'exactly one main agent').toBe(1);
  expect(active[0].last_matched_at, 'the main agent searched').not.toBeNull();
  for (const a of agents.rows) await expect(ali.getByTestId(`agent-${a.id}`)).toBeVisible({ timeout: 30_000 });
  if (drafts.length) {
    expect(toastText).toMatch(/drafted/i);
    await expect(ali.getByTestId(`agent-${drafts[0].id}`).getByText('Paused')).toBeVisible();
    await ali.getByTestId(`agent-${drafts[0].id}`).getByRole('button', { name: 'Resume agent' }).click();
    await expect(ali.getByTestId(`agent-${drafts[0].id}`).getByText('Paused')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(async () => (await pool.query(`SELECT status FROM matching_agents WHERE id = $1`, [drafts[0].id])).rows[0].status, { timeout: 30_000 }).toBe('active');
    console.log(`  step 3: resumed the draft "${drafts[0].label}"; it is active now.`);
  } else {
    console.log('  step 3: the chat named one kind of person only, so there was no draft to resume.');
  }
  await shot(ali, 'suggestions-after-resume');
  const gate = await pool.query(`SELECT onboarding_status::text s FROM users WHERE id = $1`, [aliId]);
  expect(gate.rows[0].s).toBe('completed');

  // ── Step 4: a meeting request answered from the bell; a www. link in the chat ──
  const poke = await apiAs(mate.accessToken, 'POST', '/pokes', { recipientId: aliId, message: 'Would love to hear about your Geo AI work.' });
  expect(poke.status, JSON.stringify(poke.json)).toBe(201);
  await gotoRetry(ali, `${APP}/`);
  await ali.locator('button:has(.lucide-bell):visible').first().click();
  await expect(ali.getByText('Walkthrough Mate asked to meet you')).toBeVisible({ timeout: 30_000 });
  await shot(ali, 'bell-meeting-request-accept-decline');
  await ali.getByRole('button', { name: /^Accept$/ }).first().click();
  await expect(ali).toHaveURL(/\/messages\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const msg = ali.getByPlaceholder(/Type a message/i);
  await expect(msg).toBeVisible({ timeout: 30_000 });
  await msg.fill('Happy to. My work is at www.example.com');
  await msg.press('Enter');
  await expect(ali.locator('a[href="https://www.example.com"]').first()).toBeVisible({ timeout: 30_000 });
  await shot(ali, 'chat-after-accept-with-link');
  console.log('  step 4: accepted from the bell, landed in the chat, www. address is a link.');

  // ── Steps 5 to 7: the wall ──
  circleA = (await apiAs(admin.accessToken, 'POST', '/circles', { name: 'Walkthrough Circle A' })).json.data.id;
  circleB = (await apiAs(admin.accessToken, 'POST', '/circles', { name: 'Walkthrough Circle B' })).json.data.id;
  const at = aliToken();
  for (const c of [circleA, circleB]) {
    expect((await apiAs(at, 'POST', `/circles/${c}/join`)).status).toBe(200);
    expect((await apiAs(mate.accessToken, 'POST', `/circles/${c}/join`)).status).toBe(200);
  }

  await gotoRetry(ali, `${APP}/circles/${circleA}`);
  const composer = ali.getByPlaceholder('Share something with the circle…');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill('Testing the new wall from my phone. More at https://www.example.com');
  await ali.getByRole('button', { name: /^Post$/ }).click();
  const post = await pool.query(`SELECT id FROM circle_posts WHERE circle_id = $1 AND author_id = $2 AND deleted_at IS NULL`, [circleA, aliId]);
  await expect.poll(async () => (await pool.query(`SELECT COUNT(*)::int n FROM circle_posts WHERE circle_id = $1 AND author_id = $2 AND deleted_at IS NULL`, [circleA, aliId])).rows[0].n, { timeout: 30_000 }).toBe(1);
  const postId = post.rows[0]?.id ?? (await pool.query(`SELECT id FROM circle_posts WHERE circle_id = $1 AND author_id = $2 AND deleted_at IS NULL`, [circleA, aliId])).rows[0].id;
  await expect(ali.getByTestId(`wall-post-${postId}`)).toBeVisible({ timeout: 30_000 });
  await ali.getByTestId(`comment-button-${postId}`).click();
  await ali.getByLabel('Your comment').fill('Thanks for reading, feedback welcome.');
  await ali.getByLabel('Your comment').press('Enter');
  await expect(ali.getByText('Thanks for reading, feedback welcome.')).toBeVisible({ timeout: 15_000 });
  const aliComment = (await pool.query(`SELECT id FROM circle_post_comments WHERE post_id = $1 AND author_id = $2 AND deleted_at IS NULL`, [postId, aliId])).rows[0].id;
  await shot(ali, 'wall-my-post-and-comment');
  console.log('  step 5: posted on the wall and commented on it.');

  // Step 5 from the second account: Like, the picker, Comment, Reply, Like on the comment.
  const m = await phone(mate, `/circles/${circleA}?post=${postId}`);
  const mp = m.getByTestId(`wall-post-${postId}`);
  await expect(mp).toBeVisible({ timeout: 30_000 });
  await m.getByTestId(`react-button-${postId}`).click();
  await expect(m.getByTestId(`react-button-${postId}`)).toHaveAttribute('aria-pressed', 'true');
  await m.getByTestId(`reaction-picker-toggle-${postId}`).click();
  await expect(m.getByTestId(`reaction-picker-${postId}`)).toBeVisible();
  await shot(m, 'second-account-reaction-picker');
  await m.getByTestId(`reaction-picker-${postId}`).getByRole('button', { name: 'React: Celebrate' }).click();
  await expect(m.getByTestId(`react-button-${postId}`)).toHaveText(/Celebrate/);
  await expect(m.getByTestId(`reaction-summary-${postId}`)).toContainText('🎉');
  await m.getByTestId(`comment-button-${postId}`).click();
  await m.getByLabel('Your comment').fill('Congrats on the new wall!');
  await m.getByLabel('Your comment').press('Enter');
  await expect(m.getByText('Congrats on the new wall!')).toBeVisible({ timeout: 15_000 });
  await m.getByTestId(`reply-button-${aliComment}`).click();
  await m.getByLabel('Your reply').fill('Replying to Ali: looks great on a phone.');
  await m.getByLabel('Your reply').press('Enter');
  await expect(m.getByText('Replying to Ali: looks great on a phone.')).toBeVisible({ timeout: 15_000 });
  await expect(m.getByTestId(`comment-${aliComment}`).getByText('Replying to Ali: looks great on a phone.')).toBeVisible();
  await m.getByTestId(`comment-like-${aliComment}`).click();
  await expect(m.getByTestId(`comment-like-${aliComment}`)).toHaveText(/Liked · 1/);
  await shot(m, 'second-account-comment-reply-like');
  console.log('  step 5: second account liked, celebrated, commented, replied under my comment, liked my comment.');

  // Step 6: share as a link (paste it in the address bar) and into circle B.
  await m.getByTestId(`share-button-${postId}`).click();
  await m.getByTestId(`copy-link-${postId}`).click();
  await expect(m.getByText('Link copied.')).toBeVisible();
  const link = await m.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`${APP}/circles/${circleA}?post=${postId}`);
  await gotoRetry(m, link);
  await expect(m.getByTestId(`wall-post-${postId}`)).toBeVisible({ timeout: 30_000 });
  const box = await m.getByTestId(`wall-post-${postId}`).boundingBox();
  expect(box!.y).toBeGreaterThan(-20); expect(box!.y).toBeLessThan(844);
  await shot(m, 'pasted-link-lands-on-the-post');
  await m.getByTestId(`share-button-${postId}`).click();
  await m.getByTestId(`share-to-circle-${postId}`).click();
  await m.getByLabel('Circle to share to').selectOption(circleB);
  await m.getByLabel('Your note').fill('Ali is testing the wall, have a look.');
  await m.getByTestId(`share-submit-${postId}`).click();
  await expect(m.getByText('Shared to Walkthrough Circle B.')).toBeVisible({ timeout: 15_000 });
  const share = (await pool.query(`SELECT id FROM circle_posts WHERE circle_id = $1 AND shared_from_post_id = $2 AND deleted_at IS NULL`, [circleB, postId])).rows[0].id;
  await gotoRetry(m, `${APP}/circles/${circleB}`);
  await expect(m.getByTestId(`shared-from-${share}`)).toBeVisible({ timeout: 30_000 });
  await expect(m.getByTestId(`shared-from-${share}`)).toContainText('Shared from Walkthrough Circle A');
  await shot(m, 'attribution-card-in-circle-b');
  await m.getByTestId(`shared-from-${share}`).click();
  await expect(m).toHaveURL(new RegExp(`/circles/${circleA}\\?post=${postId}`), { timeout: 30_000 });
  console.log('  step 6: copied link opens the post; repost in B carries the attribution and links back.');

  // Step 7: Ali's bell has reacted / commented / replied; tapping lands on the post; delete comment and post.
  await gotoRetry(ali, `${APP}/`);
  await ali.locator('button:has(.lucide-bell):visible').first().click();
  for (const t of ['Walkthrough Mate reacted to your post', 'Walkthrough Mate commented on your post', 'Walkthrough Mate replied to your comment']) {
    await expect(ali.getByText(t).first()).toBeVisible({ timeout: 30_000 });
  }
  await shot(ali, 'bell-reacted-commented-replied');
  await ali.getByText('Walkthrough Mate replied to your comment').first().click();
  await expect(ali).toHaveURL(new RegExp(`/circles/${circleA}\\?post=${postId}`), { timeout: 30_000 });
  await expect(ali.getByTestId(`wall-post-${postId}`)).toBeVisible({ timeout: 30_000 });
  await ali.getByTestId(`comment-button-${postId}`).click();
  await expect(ali.getByText('Replying to Ali: looks great on a phone.')).toBeVisible({ timeout: 15_000 });
  await shot(ali, 'bell-entry-landed-on-the-post');

  // Step 8: 360px with the picker open, no sideways scroll.
  await ali.setViewportSize({ width: 360, height: 780 });
  await ali.getByTestId(`reaction-picker-toggle-${postId}`).click();
  await expect(ali.getByTestId(`reaction-picker-${postId}`)).toBeVisible();
  const overflow = await ali.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll at 360px').toBeLessThanOrEqual(0);
  await shot(ali, '360px-picker-open');
  console.log('  step 8: 360px, picker open, no sideways scroll.');

  ali.once('dialog', d => d.accept());
  await ali.getByTestId(`comment-delete-${aliComment}`).click();
  await expect(ali.getByText('Thanks for reading, feedback welcome.')).toHaveCount(0, { timeout: 15_000 });
  ali.once('dialog', d => d.accept());
  await ali.getByTestId(`delete-post-${postId}`).click();
  await expect(ali.getByTestId(`wall-post-${postId}`)).toHaveCount(0, { timeout: 15_000 });
  const gone = await pool.query(`SELECT deleted_at FROM circle_posts WHERE id = $1`, [postId]);
  expect(gone.rows[0].deleted_at).not.toBeNull();
  await shot(ali, 'post-deleted');
  console.log('  step 7: deleted my comment (its reply went with it) and my post from the trash icons.');
});
