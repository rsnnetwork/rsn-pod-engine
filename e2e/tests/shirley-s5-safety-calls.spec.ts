import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, wait, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { confirmInPage } from '../helpers/confirm-dialog';
import { expectReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// Shirley Palmer's walkthrough, 11 Nov 2026, task S5 (item 16 safety; RSN 07 presence; RSN 08 after a call; RSN 09
// booking). Throwaway members (@rsn-e2e.invalid): Shirley, Ana and Ben; Shirley connected to Ana and to Ben by an
// accepted request. Ana writes to Shirley through the API. Test 1b adds Cara (connected to Shirley the same way) so the
// group chat has the three people it needs, with Ben kept outside it.
//   1. Reports by API: a message is reported as its author, with a copy of its words kept after the message is
//      deleted; the same report again is "You already reported this."; yourself, your own message and someone else's
//      chat are refused.
//   2. In the thread at 1280: Report member, Block member and Delete conversation are labelled items in "More"; Report
//      member says what happens, chooses no reason, and "Report sent" leaves Shirley in the conversation. Report message
//      from a message's "⋯" quotes it; reporting it again says "You already reported this."
//   3. Block member says every consequence first; afterwards Shirley is still in the thread, now read-only (no box, no
//      call), with Unblock right there; Unblock brings the box back.
//   4. Presence: while it loads nothing says "Offline" and the call button works; Ana offline reads "Offline" and the
//      call button opens Try again / Find a time / Send a message; Ana opening REASON turns it "Online", her tab going
//      to the background "Away" (a call then opens the call dialog), and closing it "Offline", each without a reload;
//      the inbox dot agrees with the header.
//   5. Booking: Shirley and Ben both offer one time, which books it; each one's invitation is logged as sent once, a
//      repeated confirm sends nothing more, and the thread says "Calendar invitation sent by email." with a quiet "Add
//      manually" whose menu offers the calendar file first.
//   6. After a 1:1 call (a real LiveKit room, Chromium's fake camera): Leave lands on the conversation with "How did
//      your meeting with Ana go?" as a sheet; "Not now" closes it and drops the question from the address; Back never
//      re-enters the call.
//   7. At 360px: the More menu, the report sheet and the offline sheet fit, every action 44px, nothing scrolls sideways.
//   Fix round 1 (review s5-review.md):
//   1b. A circle comment and a group chat message are reported as their authors, with the same copy, the same 24-hour
//       guard and the same refusals (pod comments and event chat messages: jest and PGlite only; a pod or a live event
//       is too much to stand up here).
//   3.  In a blocked thread neither side can react (API, both ways), and no reaction trigger or Reply is drawn.
//   6b. A block during a call ends it for BOTH: each room goes back to the thread with "The call has ended.", and
//       neither can get back into the call.
// Reports filed here sit in the admin moderation queue for the length of the run; deleting the throwaway members at the
// end removes them (user_reports cascades with the reporter and the reported).
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

const HEADLESS = process.env.E2E_HEADED === '0' || process.env.E2E_HEADED === undefined;
const LOCAL = /127\.0\.0\.1|localhost/.test(SERVER);
const RUN = Date.now().toString(36);
const SHIRLEY_NAME = `Shirley Safe ${RUN}`;
const ANA_NAME = `Ana Safe ${RUN}`;
const BEN_NAME = `Ben Safe ${RUN}`;
const CARA_NAME = `Cara Safe ${RUN}`;

let browser: Browser;
let shirley: TestUser, ana: TestUser, ben: TestUser;
let admin: TestUser | undefined;
// The group chat's third person: a group needs at least three (GROUP_CHAT_MIN_MEMBERS), and Ben must stay outside it.
let cara: TestUser | undefined;
let circleId = '';
let groupId = '';
let anaConv = '';
let benConv = '';
let firstMsg = '';
let secondMsg = '';
const ctxs: BrowserContext[] = [];

async function member(label: string, name: string): Promise<TestUser> {
  const u = await createTestUser(`s5-${label}`);
  const email = `e2etest-s5-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `UPDATE users SET email = $1, display_name = $2,
            notification_prefs = jsonb_set(COALESCE(notification_prefs, '{}'::jsonb), '{dm_email}', 'false')
      WHERE id = $3`,
    [email, name, u.id],
  );
  return { ...u, email, displayName: name };
}

async function api(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

async function connect(from: TestUser, to: TestUser): Promise<string> {
  const asked = await api(from, 'POST', '/pokes', { recipientId: to.id, message: `Hello ${RUN}` });
  expect(asked.status, JSON.stringify(asked.json)).toBe(201);
  const accepted = await api(to, 'POST', `/pokes/${asked.json.data.id}/accept`);
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
  const conv = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [from.id, to.id],
  );
  return conv.rows[0].id;
}

async function say(from: TestUser, to: TestUser, content: string): Promise<string> {
  const sent = await api(from, 'POST', '/dm/messages', { toUserId: to.id, content });
  expect(sent.status, JSON.stringify(sent.json)).toBe(201);
  const row = await pool.query<{ id: string }>(
    `SELECT id FROM direct_messages WHERE from_user_id = $1 AND content = $2 ORDER BY created_at DESC LIMIT 1`, [from.id, content],
  );
  return row.rows[0].id;
}

/** Someone signed in, at this width, in a browser of their own. */
async function signedIn(u: TestUser, width: number, height: number, b: Browser = browser): Promise<Page> {
  const ctx = await b.newContext({ viewport: { width, height } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  return page;
}

async function openThread(page: Page, conversationId: string, name: string) {
  await gotoRetry(page, `${APP}/messages/${conversationId}`);
  const header = page.getByTestId('thread-partner-name');
  try {
    await expect(header).toHaveText(name, { timeout: 30_000 });
  } catch {
    await page.reload();
    await expect(header, 'the thread header after one reload').toHaveText(name, { timeout: 45_000 });
  }
}

/** A flag on the window that a reload would wipe, so "without a reload" is checked, not assumed. */
const markNotReloaded = (page: Page) => page.evaluate(() => { (window as unknown as { __s5: boolean }).__s5 = true; });
const notReloaded = (page: Page) => page.evaluate(() => (window as unknown as { __s5?: boolean }).__s5 === true);

const presenceWord = (page: Page) => page.getByTestId('partner-presence');

async function noSideways(page: Page, what: string) {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits, `${what}: nothing scrolls sideways`).toBe(true);
}

test.beforeAll(async () => {
  browser = await chromium.launch({ headless: HEADLESS });
  shirley = await member('shirley', SHIRLEY_NAME);
  ana = await member('ana', ANA_NAME);
  ben = await member('ben', BEN_NAME);
  anaConv = await connect(shirley, ana);
  benConv = await connect(shirley, ben);
  firstMsg = await say(ana, shirley, `S5 first message ${RUN}`);
  secondMsg = await say(ana, shirley, `S5 second message ${RUN}`);
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch { /* already closed */ }
  // This run's own circle and group chat, by id, before their makers go.
  if (circleId) await pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]).catch(() => {});
  if (groupId) await pool.query(`DELETE FROM dm_groups WHERE id = $1`, [groupId]).catch(() => {});
  await cleanup(pool, { ids: [shirley?.id, ana?.id, ben?.id, cara?.id, admin?.id].filter(Boolean) as string[] });
  const swept = await cleanupByPrefix(pool, 'e2etest-s5-');
  if (swept) console.log(`  swept ${swept} leftover s5-* account(s)`);
});

test('1) a message is reported as its author, its words kept after it is deleted; repeats and impossible reports are refused', async () => {
  const made = await api(shirley, 'POST', '/reports', { reason: 'harassment', subject: { kind: 'dm_message', id: firstMsg } });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const row = await pool.query<{ reported_id: string; subject_kind: string; subject_id: string; subject_excerpt: string; conversation_id: string; id: string }>(
    `SELECT id, reported_id, subject_kind, subject_id, subject_excerpt, conversation_id FROM user_reports WHERE reporter_id = $1 AND subject_id = $2`,
    [shirley.id, firstMsg],
  );
  expect(row.rows).toHaveLength(1);
  expect(row.rows[0]).toMatchObject({ reported_id: ana.id, subject_kind: 'dm_message', subject_excerpt: `S5 first message ${RUN}`, conversation_id: anaConv });

  const again = await api(shirley, 'POST', '/reports', { reason: 'spam', subject: { kind: 'dm_message', id: firstMsg } });
  expect(again.status).toBe(409);
  expect(again.json.error.message).toBe('You already reported this.');

  expect((await api(shirley, 'POST', '/reports', { reportedId: shirley.id, reason: 'spam' })).status).toBe(400);
  const own = await api(ana, 'POST', '/reports', { reason: 'spam', subject: { kind: 'dm_message', id: firstMsg } });
  expect(own.status).toBe(400);
  expect(own.json.error.message).toBe('You cannot report your own message.');
  const elsewhere = await api(ben, 'POST', '/reports', { reason: 'spam', subject: { kind: 'dm_message', id: firstMsg } });
  expect(elsewhere.status, 'a message in a chat Ben is not part of').toBe(404);

  // The message goes (this throwaway pair's own row, by id); the report keeps what it said.
  await pool.query(`DELETE FROM direct_messages WHERE id = $1 AND from_user_id = $2`, [firstMsg, ana.id]);
  const kept = await pool.query<{ subject_excerpt: string }>(`SELECT subject_excerpt FROM user_reports WHERE id = $1`, [row.rows[0].id]);
  expect(kept.rows[0].subject_excerpt).toBe(`S5 first message ${RUN}`);
});

test('1b) a circle comment and a group chat message are reported as their authors, once a day, never your own', async () => {
  test.setTimeout(120_000);
  admin = await createTestUser(`s5-admin-${RUN}`, 'admin');
  const made = await api(admin, 'POST', '/circles', { name: `S5 Circle ${RUN}` });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  circleId = made.json.data.id;
  for (const u of [shirley, ana]) expect((await api(u, 'POST', `/circles/${circleId}/join`)).status).toBeLessThan(300);
  expect((await api(ana, 'POST', `/circles/${circleId}/posts`, { clientId: crypto.randomUUID(), content: `S5 post ${RUN}` })).status).toBeLessThan(300);
  const post = (await pool.query<{ id: string }>(`SELECT id FROM circle_posts WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 1`, [circleId])).rows[0].id;
  expect((await api(ana, 'POST', `/circles/posts/${post}/comments`, { content: `S5 comment ${RUN}` })).status).toBeLessThan(300);
  const comment = (await pool.query<{ id: string }>(`SELECT id FROM circle_post_comments WHERE post_id = $1 ORDER BY created_at DESC LIMIT 1`, [post])).rows[0].id;

  const byComment = await api(shirley, 'POST', '/reports', { reason: 'harassment', subject: { kind: 'circle_comment', id: comment } });
  expect(byComment.status, JSON.stringify(byComment.json)).toBe(201);
  const row = (await pool.query<{ reported_id: string; subject_excerpt: string }>(
    `SELECT reported_id, subject_excerpt FROM user_reports WHERE reporter_id = $1 AND subject_id = $2`, [shirley.id, comment],
  )).rows[0];
  expect(row).toEqual({ reported_id: ana.id, subject_excerpt: `S5 comment ${RUN}` });
  expect((await api(shirley, 'POST', '/reports', { reason: 'spam', subject: { kind: 'circle_comment', id: comment } })).json?.error?.message).toBe('You already reported this.');
  expect((await api(ana, 'POST', '/reports', { reason: 'spam', subject: { kind: 'circle_comment', id: comment } })).json?.error?.message).toBe('You cannot report your own comment.');

  // A group chat is three people at least, each one Shirley has met (an accepted request counts): Ana and Cara.
  cara = await member('cara', CARA_NAME);
  await connect(shirley, cara);
  const group = await api(shirley, 'POST', '/groups', { name: `S5 Group ${RUN}`, memberIds: [ana.id, cara.id] });
  expect(group.status, JSON.stringify(group.json)).toBe(201);
  groupId = group.json.data.id;
  expect((await api(ana, 'POST', `/groups/${groupId}/messages`, { content: `S5 group words ${RUN}` })).status).toBe(201);
  const gm = (await pool.query<{ id: string }>(`SELECT id FROM direct_messages WHERE group_id = $1 AND from_user_id = $2 ORDER BY created_at DESC LIMIT 1`, [groupId, ana.id])).rows[0].id;
  const byGroup = await api(shirley, 'POST', '/reports', { reason: 'spam', subject: { kind: 'group_message', id: gm } });
  expect(byGroup.status, JSON.stringify(byGroup.json)).toBe(201);
  expect((await pool.query(`SELECT 1 FROM user_reports WHERE reporter_id = $1 AND subject_id = $2 AND reported_id = $3 AND subject_excerpt = $4`,
    [shirley.id, gm, ana.id, `S5 group words ${RUN}`])).rowCount).toBe(1);
  expect((await api(ben, 'POST', '/reports', { reason: 'spam', subject: { kind: 'group_message', id: gm } })).status, 'Ben is not in the group').toBe(404);
});

test('2) Report member and Report message are labelled, say what happens, choose no reason, and keep Shirley in the thread', async () => {
  test.setTimeout(180_000);
  const page = await signedIn(shirley, 1280, 860);
  await openThread(page, anaConv, ANA_NAME);
  await markNotReloaded(page);
  await expect(page.locator('[title="Report this member"]')).toHaveCount(0);

  await page.getByTestId('thread-more').click();
  const menu = page.getByTestId('thread-more-menu');
  for (const name of ['Report member', 'Block member', 'Delete conversation']) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  }
  await menu.getByRole('menuitem', { name: 'Report member' }).click();
  await expect(page.getByRole('heading', { name: `Report ${ANA_NAME}` })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('report-consequence')).toHaveText(
    `The REASON team will review your report and can read this conversation. ${ANA_NAME} won't be told about your report, and nothing changes for them until we have looked at it.`,
  );
  const send = page.getByRole('button', { name: 'Send report' });
  await expect(send, 'no reason is chosen for her').toBeDisabled();
  await page.getByLabel('Reason').selectOption('harassment');
  await send.click();
  await expect(page.getByRole('heading', { name: 'Report sent' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Thanks. The REASON team will review it.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/messages/${anaConv}$`));
  await page.getByRole('button', { name: 'Done' }).click();
  expect((await pool.query('SELECT 1 FROM user_reports WHERE reporter_id = $1 AND reported_id = $2 AND subject_id IS NULL', [shirley.id, ana.id])).rowCount).toBe(1);

  // Report message, from the message's own "⋯".
  const bubble = page.locator(`[data-message-id="${secondMsg}"]`);
  await bubble.hover();
  await bubble.getByRole('button', { name: 'More actions for this message' }).click();
  await page.getByRole('menuitem', { name: 'Report message' }).click();
  await expect(page.getByRole('heading', { name: 'Report this message' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('report-quote')).toHaveText(`S5 second message ${RUN}`);
  await page.getByLabel('Reason').selectOption('spam');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('heading', { name: 'Report sent' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  const msgReport = await pool.query<{ reported_id: string; subject_excerpt: string }>(
    'SELECT reported_id, subject_excerpt FROM user_reports WHERE reporter_id = $1 AND subject_id = $2', [shirley.id, secondMsg],
  );
  expect(msgReport.rows).toEqual([{ reported_id: ana.id, subject_excerpt: `S5 second message ${RUN}` }]);

  // The same message again: said calmly, nothing filed twice.
  await bubble.hover();
  await bubble.getByRole('button', { name: 'More actions for this message' }).click();
  await page.getByRole('menuitem', { name: 'Report message' }).click();
  await page.getByLabel('Reason').selectOption('spam');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('heading', { name: 'You already reported this.' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  expect((await pool.query('SELECT 1 FROM user_reports WHERE reporter_id = $1 AND subject_id = $2', [shirley.id, secondMsg])).rowCount).toBe(1);
  // My own messages offer no report.
  await expect(page.getByTestId('bubble-own').locator('..').getByRole('button', { name: 'More actions for this message' })).toHaveCount(0);
  expect(await notReloaded(page), 'all of it without a reload').toBe(true);
});

test('3) Block member says every consequence first, keeps Shirley in a read-only thread, and Unblock brings the box back', async () => {
  test.setTimeout(150_000);
  const page = await signedIn(shirley, 1280, 860);
  await openThread(page, anaConv, ANA_NAME);
  await page.getByTestId('thread-more').click();
  await page.getByRole('menuitem', { name: 'Block member' }).click();
  await expect(page.getByRole('dialog', { name: `Block ${ANA_NAME}?` })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('confirm-dialog-body')).toHaveText(
    `${ANA_NAME} won't be able to message or call you, you won't be matched together, and you won't see each other's posts or comments. They aren't told. Your conversation stays, read-only. You can unblock them from the conversation or their profile.`,
  );
  await confirmInPage(page);
  await expect(page.getByTestId('blocked-thread')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('blocked-thread')).toContainText(`You blocked ${ANA_NAME}. They can't message or call you. The conversation stays here, read-only.`);
  await expect(page).toHaveURL(new RegExp(`/messages/${anaConv}$`));
  await expect(page.getByTestId('thread-partner-name')).toHaveText(ANA_NAME);
  await expect(page.locator(`[data-message-id="${secondMsg}"]`), 'the messages are still there').toBeVisible();
  await expect(page.getByRole('main').locator('textarea'), 'no message box').toHaveCount(0);
  await expect(page.getByTestId('video-call-button'), 'no call').toHaveCount(0);
  // Read-only means read-only (fix round 1): no reaction trigger and no Reply; Report message is still offered.
  await expect(page.getByRole('button', { name: 'Add reaction' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reply' })).toHaveCount(0);
  await expect(page.locator(`[data-message-id="${secondMsg}"]`).getByRole('button', { name: 'More actions for this message' })).toHaveCount(1);
  expect((await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [shirley.id, ana.id])).rowCount).toBe(1);
  // A reaction cannot cross the block, from either side (REST; the socket goes through the same check).
  for (const who of [ana, shirley]) {
    const reacted = await api(who, 'POST', `/dm/messages/${secondMsg}/reactions`, { emoji: 'heart' });
    expect(reacted.status, `${who === ana ? 'Ana' : 'Shirley'} reacting across the block`).toBe(403);
  }
  expect((await pool.query(`SELECT 1 FROM dm_message_reactions WHERE message_id = $1`, [secondMsg])).rowCount).toBe(0);
  // Ana is not told, and cannot call.
  const ring = await api(ana, 'POST', `/dm/conversations/${anaConv}/call/request`, { kind: 'video', durationMin: 15 });
  expect(ring.status).toBe(403);

  await page.getByTestId('blocked-thread').getByRole('button', { name: 'Unblock' }).click();
  await expect(page.getByTestId('blocked-thread')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole('main').locator('textarea')).toBeVisible();
  expect((await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [shirley.id, ana.id])).rowCount).toBe(0);
});

test('4) presence: loading is not "Offline"; offline opens Try again / Find a time / Send a message; online, away and offline arrive without a reload', async () => {
  test.setTimeout(240_000);
  const page = await signedIn(shirley, 1280, 860);
  // Hold the presence read: while it loads nothing says "Offline" and the call button works.
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => { release = r; });
  await page.route(`${SERVER}/api/dm/presence`, async (route) => { await held; await route.continue(); });
  await openThread(page, anaConv, ANA_NAME);
  await expect(presenceWord(page)).toHaveCount(0);
  await expect(page.getByText('Offline', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('video-call-button')).toBeEnabled();
  release();
  await page.unroute(`${SERVER}/api/dm/presence`);
  await markNotReloaded(page);

  // Ana has REASON nowhere open: Offline, and the button opens the sheet instead of ringing.
  await expect(presenceWord(page)).toHaveText('Offline', { timeout: 30_000 });
  await page.getByTestId('video-call-button').click();
  const sheet = page.getByRole('dialog', { name: `${ANA_NAME} isn't on REASON right now.` });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  for (const name of ['Try again', 'Find a time', 'Send a message']) await expect(sheet.getByRole('button', { name, exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText(`${ANA_NAME} still isn't on REASON.`, { exact: false })).toBeVisible({ timeout: 15_000 });
  await sheet.getByRole('button', { name: 'Send a message', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('main').locator('textarea')).toBeFocused();
  expect((await pool.query(`SELECT 1 FROM call_requests WHERE conversation_id = $1`, [anaConv])).rowCount, 'nobody was rung').toBe(0);

  // Ana opens REASON: Online, pushed, and the inbox dot says the same.
  const anaPage = await signedIn(ana, 1280, 860);
  await gotoRetry(anaPage, `${APP}/`);
  await expect(presenceWord(page)).toHaveText('Online', { timeout: 30_000 });
  const row = page.getByRole('link', { name: new RegExp(ANA_NAME) }).first();
  await expect(row.getByTestId('inbox-presence-dot')).toHaveAttribute('aria-label', 'Online');

  // Her tab goes to the background: Away. A call still reaches her, so the call dialog opens (not the sheet).
  await anaPage.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(presenceWord(page)).toHaveText('Away', { timeout: 30_000 });
  await expect(row.getByTestId('inbox-presence-dot')).toHaveAttribute('aria-label', 'Away');
  await page.getByTestId('video-call-button').click();
  await expect(page.getByRole('button', { name: 'Send request' })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');

  // She closes it: Offline.
  await anaPage.context().close();
  await expect(presenceWord(page)).toHaveText('Offline', { timeout: 60_000 });
  await expect(row.getByTestId('inbox-presence-dot')).toHaveCount(0);
  expect(await notReloaded(page), 'every change arrived without a reload').toBe(true);
});

test('5) booking: one invitation each, logged as sent once; the thread says so with a quiet Add manually, the file first', async () => {
  test.setTimeout(180_000);
  const now = new Date((await pool.query<{ n: Date }>('SELECT NOW() AS n')).rows[0].n).getTime();
  const key = new Date(Math.ceil((now + 3 * 3_600_000) / 1_800_000) * 1_800_000).toISOString().replace('.000Z', 'Z');
  expect((await api(shirley, 'PUT', `/dm/conversations/${benConv}/scheduling/availability`, { windows: [key] })).status).toBe(200);
  const booked = await api(ben, 'PUT', `/dm/conversations/${benConv}/scheduling/availability`, { windows: [key] });
  expect(booked.status).toBe(200);
  expect(booked.json.data.confirmed?.window, 'the one shared time is booked').toBe(key);
  expect(booked.json.data.confirmed?.inviteEmail, "Ben's own invitation, in the booking's answer").toBe('sent');
  const meetingId = booked.json.data.confirmed.meetingId as string;
  const rows = async () => (await pool.query<{ user_id: string; status: string }>(
    `SELECT user_id, status FROM meeting_invite_emails WHERE meeting_id = $1 ORDER BY user_id`, [meetingId],
  )).rows;
  await expect.poll(async () => (await rows()).map((r) => r.status), { timeout: 20_000 }).toEqual(['sent', 'sent']);
  // The same time confirmed again (a retry, a double press): nothing more is sent.
  const again = await api(shirley, 'POST', `/dm/conversations/${benConv}/scheduling/confirm`, { window: key, durationMin: 30, type: 'video', expectedWindow: key });
  expect(again.status).toBe(200);
  await wait(3_000);
  expect(await rows(), 'still one invitation each').toHaveLength(2);
  expect((await api(shirley, 'GET', `/dm/conversations/${benConv}/scheduling`)).json.data.confirmed.inviteEmail).toBe('sent');

  const page = await signedIn(shirley, 1280, 860);
  await openThread(page, benConv, BEN_NAME);
  const card = page.getByTestId('system-message-card').filter({ hasText: /Meeting confirmed/i }).last();
  await expect(card.getByTestId('invite-line')).toHaveText('Calendar invitation sent by email.', { timeout: 30_000 });
  const add = card.getByRole('button', { name: 'Add manually' });
  await expect(add).toBeVisible();
  await expect(card.getByRole('button', { name: /Add to calendar/ })).toHaveCount(0);
  await add.click();
  const items = page.getByTestId('add-to-calendar-menu').getByRole('menuitem');
  await expect(items.first()).toContainText('Download calendar file (.ics)');
  await expect(items.nth(1)).toContainText('Google Calendar');
  await expect(items.nth(2)).toContainText('Outlook.com');
  await expect(page.getByTestId('calendar-note')).toHaveText('You already have this in your email. Adding it here may create a second entry.');
  await page.keyboard.press('Escape');
});

test('6) after a 1:1 call, Leave lands on the conversation with an optional "Not now" question, and Back never re-enters the call', async () => {
  test.setTimeout(240_000);
  test.skip(LOCAL, 'needs a real LiveKit server; the local API only mocks one');
  const media = await chromium.launch({
    headless: HEADLESS,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=MediaFoundationD3D11VideoCapture'],
  });
  try {
    const anaPage = await signedIn(ana, 390, 844, media);
    await gotoRetry(anaPage, `${APP}/messages/${anaConv}`);
    await expect.poll(async () => (await api(shirley, 'GET', `/dm/conversations/${anaConv}/partner-presence`)).json?.data?.state, { timeout: 30_000 }).toBe('online');
    const rung = await api(shirley, 'POST', `/dm/conversations/${anaConv}/call/request`, { kind: 'video', durationMin: 15 });
    expect(rung.status, JSON.stringify(rung.json)).toBe(201);
    expect((await api(ana, 'POST', `/dm/call/requests/${rung.json.data.id}/accept`)).status).toBe(200);

    const page = await signedIn(shirley, 390, 844, media);
    await openThread(page, anaConv, ANA_NAME);
    await gotoRetry(page, `${APP}/meet/${anaConv}?kind=video`);
    await gotoRetry(anaPage, `${APP}/meet/${anaConv}?kind=video`);
    await expect(page.locator('.lk-participant-tile')).toHaveCount(2, { timeout: 45_000 });

    await page.getByRole('button', { name: 'Leave call and go back to chat' }).click();
    await expect(page).toHaveURL(new RegExp(`/messages/${anaConv}\\?feedback=`), { timeout: 20_000 });
    const sheet = page.getByRole('dialog', { name: `How did your meeting with ${ANA_NAME} go?` });
    await expect(sheet).toBeVisible({ timeout: 20_000 });
    await expect(sheet.getByText('You can answer later from the meeting in Events.', { exact: false })).toBeVisible();
    await sheet.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/messages/${anaConv}$`));
    await expect(page.getByTestId('thread-partner-name')).toHaveText(ANA_NAME);
    await page.goBack();
    await page.waitForTimeout(2_000);
    expect(page.url(), 'Back does not re-enter the call').not.toMatch(/\/meet\//);
    await anaPage.getByRole('button', { name: 'Leave call and go back to chat' }).click().catch(() => {});
  } finally {
    await media.close().catch(() => {});
  }
});

test('6b) a block during a call ends it for both: each lands on the thread with "The call has ended.", and neither gets back in', async () => {
  test.setTimeout(240_000);
  test.skip(LOCAL, 'needs a real LiveKit server; the local API only mocks one');
  const media = await chromium.launch({
    headless: HEADLESS,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=MediaFoundationD3D11VideoCapture'],
  });
  try {
    const anaPage = await signedIn(ana, 390, 844, media);
    await gotoRetry(anaPage, `${APP}/messages/${anaConv}`);
    await expect.poll(async () => (await api(shirley, 'GET', `/dm/conversations/${anaConv}/partner-presence`)).json?.data?.state, { timeout: 30_000 }).toBe('online');
    const rung = await api(shirley, 'POST', `/dm/conversations/${anaConv}/call/request`, { kind: 'video', durationMin: 15 });
    expect(rung.status, JSON.stringify(rung.json)).toBe(201);
    expect((await api(ana, 'POST', `/dm/call/requests/${rung.json.data.id}/accept`)).status).toBe(200);
    const page = await signedIn(shirley, 390, 844, media);
    await openThread(page, anaConv, ANA_NAME);
    await gotoRetry(page, `${APP}/meet/${anaConv}?kind=video`);
    await gotoRetry(anaPage, `${APP}/meet/${anaConv}?kind=video`);
    await expect(page.locator('.lk-participant-tile')).toHaveCount(2, { timeout: 45_000 });

    expect((await api(shirley, 'POST', `/users/${ana.id}/block`, {})).status).toBe(200);
    for (const [who, p] of [['Shirley', page], ['Ana', anaPage]] as const) {
      // Straight to the thread, with no "How did your meeting go?" about the person just blocked (fix round 2).
      await expect(p, `${who} is back on the thread`).toHaveURL(new RegExp(`/messages/${anaConv}$`), { timeout: 30_000 });
      await expect(p.getByRole('dialog', { name: /How did your meeting with/ }), `${who} is asked nothing`).toHaveCount(0);
      await expect(p.getByText('The call has ended.'), `${who} is told calmly`).toBeVisible({ timeout: 15_000 });
    }
    // Neither gets back in: the call page refuses a new entry while the block stands.
    await gotoRetry(anaPage, `${APP}/meet/${anaConv}?kind=video`);
    await expect(anaPage.getByText(/cannot call this member|Could not start the call/i)).toBeVisible({ timeout: 30_000 });
    await expect(anaPage.locator('.lk-participant-tile')).toHaveCount(0);
    expect((await pool.query<{ e: number }>(`SELECT call_room_epoch AS e FROM dm_conversations WHERE id = $1`, [anaConv])).rows[0].e, 'the pair moved to a new call room').toBeGreaterThanOrEqual(1);
  } finally {
    await api(shirley, 'DELETE', `/users/${ana.id}/block`).catch(() => undefined);
    await media.close().catch(() => {});
  }
});

test('7) at 360px: the More menu, the report sheet and the offline sheet fit, every action 44px, nothing scrolls sideways', async () => {
  test.setTimeout(150_000);
  const page = await signedIn(shirley, 360, 780);
  await openThread(page, anaConv, ANA_NAME);
  await noSideways(page, 'the thread');
  const more = page.getByTestId('thread-more');
  await expectReachable(page, more, 'More');
  await more.click();
  for (const name of ['Report member', 'Block member', 'Delete conversation']) {
    const item = page.getByRole('menuitem', { name });
    const box = await expectReachable(page, item, name);
    expect(box.height, `${name}: 44px`).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('menuitem', { name: 'Report member' }).click();
  const send = page.getByRole('button', { name: 'Send report' });
  await page.waitForTimeout(700); // the sheet fades in
  await expectReachable(page, send, 'Send report');
  await noSideways(page, 'the report sheet');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Ana is offline (her browser closed in test 4): the phone's More menu has the call, which opens the offline sheet.
  await expect(presenceWord(page)).toHaveText('Offline', { timeout: 30_000 });
  await more.click();
  await page.getByRole('button', { name: 'Video call' }).click();
  const sheet = page.getByRole('dialog', { name: `${ANA_NAME} isn't on REASON right now.` });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  for (const name of ['Try again', 'Find a time', 'Send a message']) {
    const box = await expectReachable(page, sheet.getByRole('button', { name, exact: true }), name);
    expect(box.height, `${name}: 44px`).toBeGreaterThanOrEqual(44);
  }
  await noSideways(page, 'the offline sheet');
  await sheet.getByRole('button', { name: 'Find a time', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[data-scheduler-panel]')).toBeVisible({ timeout: 15_000 });
});
