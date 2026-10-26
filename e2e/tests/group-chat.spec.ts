import { test, expect, chromium, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, apiRequest } from '../helpers/api';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { expectReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// Group chats in Messages (COM-04, 25 Oct 2026, Stefan: "Can there be 3, 5, 10, 20, 50 people in a chat? There should
// be."). Three accounts on phones, a completed event they all took part in:
//   1. The organiser (an ordinary member who runs the pod, as Claus) starts a group chat from the event's page: the
//      sheet lists the two who took part, ticked, "3 of 50". A plain participant's event page offers no such thing.
//   2. The group appears in both others' Messages without a reload. The organiser writes; both see the message arrive
//      with an unread count on the group's row and on the Messages tab.
//   3. One opens the group: the message is there, and their counts clear. They answer; the organiser reads it live.
//   4. The third opens the group from the bell, then leaves it from the members sheet (asked first): back in Messages,
//      the group gone from their list, and the organiser's header says "2 of 50" without a reload. The group's address
//      now says "You are not in this group."; a group that does not exist says it could not be found.
//   5. The cap: an event with 50 more people who took part. The start sheet asks the organiser to choose (more than 49
//      took part), stops at 50 ("This group is full (50 people)."), and starts a group of 49. In the members sheet the
//      organiser adds one more (the 51st cannot be chosen, and says why); the group is full at 50, and the server
//      refuses a 51st add with the same sentence.
//   6. A long group (two pages) whose details arrive after its messages still opens at its newest message, and
//      "Show earlier messages" keeps the place being read. The group is marked read once on opening with something
//      unread, once for a burst of three messages, and not at all on opening it again with nothing unread.
// Throwaway members (@rsn-e2e.invalid, no email sent), their pod, events and groups are deleted by id. Runs on the local
// stack, the preview (E2E_VERCEL_SHARE) or production; E2E_ENGINE=webkit for Safari's engine.
// ─────────────────────────────────────────────────────────────────────────────

const HEADLESS = process.env.E2E_HEADED === '0' || process.env.E2E_HEADED === undefined;
const ENGINE = process.env.E2E_ENGINE === 'webkit' ? 'webkit' : 'chromium';

const RUN = Date.now().toString(36);
const TITLE = `E2E group chat ${RUN}`;
const FULL_TITLE = `E2E full group ${RUN}`;
const LONG_GROUP = `Long thread ${RUN}`;
const HELLO = `Thank you both for coming, next steps soon ${RUN}`;
const REPLY = `Thanks Claus, count me in ${RUN}`;
const FULL = 'This group is full (50 people).';
const LIMIT = 'Group chats hold up to 50 people.';
const FILLERS = 50;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let browser: Browser;
let organiser: TestUser, stefan: TestUser, ines: TestUser;
let fillers: TestUser[] = [];
let podId = '';
let eventId = '';
let bigEventId = '';
const groupIds: string[] = [];
const ctxs: BrowserContext[] = [];
const pageErrors: string[] = [];

const guest = (i: number) => `Guest ${String(i).padStart(2, '0')} ${RUN}`;

/** A throwaway member whose address can never receive mail, and who gets no message email. */
async function member(label: string, name: string): Promise<TestUser> {
  const u = await createTestUser(`gc-${label}`);
  const email = `e2etest-gc-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `UPDATE users SET email = $1, display_name = $2,
            notification_prefs = jsonb_set(COALESCE(notification_prefs, '{}'::jsonb), '{dm_email}', 'false')
      WHERE id = $3`,
    [email, name, u.id],
  );
  return { ...u, email, displayName: name };
}

async function open(u: TestUser, who: string, path: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  page.on('pageerror', (e) => { if (!/ResizeObserver loop/.test(e.message)) pageErrors.push(`${who}: ${e.message}`); });
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

/**
 * Nothing scrolls sideways: not the page, and not a scroll area inside it. The REASON shell scrolls inside <main>, so a
 * card wider than a phone moves <main> sideways while the page itself stays put.
 */
async function noSidewaysScroll(page: Page, label: string): Promise<void> {
  const wide = await page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth) out.push('the page');
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const overflowX = getComputedStyle(el).overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
        out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')}`);
      }
    }
    return out;
  });
  expect(wide, `${label}: scrolls sideways`).toEqual([]);
}

/** Marks the page, so a later check can prove it was never reloaded. */
const markNotReloaded = (page: Page) => page.evaluate(() => { (window as unknown as { __kept?: boolean }).__kept = true; });
const notReloaded = (page: Page) => page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true);

const groupRow = (page: Page, name: string) => page.getByTestId('group-row').filter({ hasText: name });
const messagesTab = (page: Page, unread: number) => page.getByRole('link', { name: `Messages, ${unread} unread` });
const anyUnreadTab = (page: Page) => page.getByRole('link', { name: /^Messages, \d+ unread$/ });

/** The group's address, read once the organiser lands on it. */
async function groupIdOf(page: Page): Promise<string> {
  await expect(page).toHaveURL(new RegExp(`/messages/g/${UUID}$`), { timeout: 30_000 });
  const id = new URL(page.url()).pathname.split('/').pop()!;
  groupIds.push(id);
  return id;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = ENGINE === 'webkit' ? await webkit.launch({ headless: HEADLESS }) : await chromium.launch({ headless: HEADLESS });
  organiser = await member('organiser', 'Claus Group');
  stefan = await member('stefan', 'Stefan Group');
  ines = await member('ines', 'Ines Group');
  // The organiser creates the pod, so they direct it: an ordinary member who runs the event, as Claus did.
  const pod = await createPod(organiser, `E2E group chat pod ${RUN}`);
  podId = pod.id;
  for (const u of [stefan, ines]) await addPodMember(organiser, podId, u.id);
  eventId = (await createSession(organiser, podId, TITLE, new Date(Date.now() + 60_000), { numberOfRounds: 1 })).id;
  await registerForSession(stefan, eventId);
  await registerForSession(ines, eventId);
  // The event is over and both came: took part = joined, not removed.
  await pool.query(
    `UPDATE session_participants SET joined_at = NOW() - interval '50 minutes', status = 'left'
      WHERE session_id = $1 AND user_id = ANY($2::uuid[])`,
    [eventId, [stefan.id, ines.id]],
  );

  // The cap's event: fifty more people who took part, besides the organiser.
  for (let i = 0; i < FILLERS; i += 10) {
    fillers.push(...await Promise.all(Array.from({ length: Math.min(10, FILLERS - i) }, (_, k) => createTestUser(`gc-f${i + k + 1}`))));
  }
  await pool.query(
    `UPDATE users u SET email = v.email, display_name = v.name
       FROM unnest($1::uuid[], $2::text[], $3::text[]) AS v(id, email, name)
      WHERE u.id = v.id`,
    [fillers.map((f) => f.id), fillers.map((_, i) => `e2etest-gc-f${i + 1}-${RUN}@rsn-e2e.invalid`), fillers.map((_, i) => guest(i + 1))],
  );
  fillers = fillers.map((f, i) => ({ ...f, displayName: guest(i + 1) }));
  bigEventId = (await createSession(organiser, podId, FULL_TITLE, new Date(Date.now() + 60_000), { numberOfRounds: 1 })).id;
  await pool.query(
    `INSERT INTO session_participants (session_id, user_id, status, joined_at)
     SELECT $1, f.id, 'left', NOW() - interval '40 minutes' FROM unnest($2::uuid[]) AS f(id)`,
    [bigEventId, fillers.map((f) => f.id)],
  );
  await pool.query(
    `UPDATE sessions SET status = 'completed', started_at = NOW() - interval '1 hour', ended_at = NOW() WHERE id = ANY($1::uuid[])`,
    [[eventId, bigEventId]],
  );
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
  // The groups first, by id and by the two events they came from (a group started before its id was read): the
  // members and messages go with them.
  await pool.query('DELETE FROM dm_groups WHERE id = ANY($1::uuid[])', [groupIds]).catch(() => {});
  const events = [eventId, bigEventId].filter(Boolean);
  if (events.length) await pool.query('DELETE FROM dm_groups WHERE session_id = ANY($1::uuid[])', [events]).catch(() => {});
  const ids = [organiser, stefan, ines, ...fillers].filter(Boolean).map((u) => u.id);
  await cleanup(pool, { ids, podId: podId || undefined });
});

test('an organiser starts a group chat; the others see it and its messages live, with unread counts; one reads, one leaves', async () => {
  test.setTimeout(300_000);

  // A plain participant's page for the same event offers no group chat (only the people who ran it start one).
  const stefanPage = await open(stefan, 'stefan', `/sessions/${eventId}`, { width: 360, height: 740 });
  await expect(stefanPage.getByRole('heading', { name: TITLE })).toBeVisible({ timeout: 40_000 });
  await expect(stefanPage.getByRole('button', { name: 'Start a group chat' })).toHaveCount(0);
  await gotoRetry(stefanPage, `${APP}/messages`);
  await expect(stefanPage.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible({ timeout: 30_000 });
  await markNotReloaded(stefanPage);

  const inesPage = await open(ines, 'ines', '/messages', { width: 414, height: 896 });
  await expect(inesPage.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible({ timeout: 40_000 });
  await markNotReloaded(inesPage);

  // 1. The organiser starts it from the completed event's page.
  const clausPage = await open(organiser, 'claus', `/sessions/${eventId}`, { width: 390, height: 844 });
  const card = clausPage.getByTestId('start-group-chat');
  await expect(card, 'the card is there for the people who ran the event').toBeVisible({ timeout: 40_000 });
  await expect(card).toContainText(LIMIT);
  await noSidewaysScroll(clausPage, 'organiser, event page @390');
  await clausPage.screenshot({ path: 'test-results/gc-1-event-card.png', fullPage: true });
  await card.getByRole('button', { name: 'Start a group chat' }).click();
  const sheet = clausPage.getByRole('dialog', { name: 'Start a group chat' });
  await expect(sheet.getByTestId('start-group-count')).toHaveText('3 of 50');
  await expect(sheet).toContainText(LIMIT);
  await expect(sheet.getByRole('checkbox', { name: 'Stefan Group' })).toBeChecked();
  await expect(sheet.getByRole('checkbox', { name: 'Ines Group' })).toBeChecked();
  const start = sheet.getByRole('button', { name: 'Start group chat', exact: true });
  await expectReachable(clausPage, start, 'Start group chat @390');
  await clausPage.screenshot({ path: 'test-results/gc-2-start-sheet.png' });
  await start.click();
  const groupId = await groupIdOf(clausPage);
  await expect(clausPage.getByTestId('group-header')).toContainText(TITLE);
  await expect(clausPage.getByTestId('group-member-count')).toHaveText('3 of 50');
  await expect(clausPage.getByTestId('group-thread-empty')).toBeVisible();

  // 2. It appears in the others' Messages without a reload.
  for (const page of [stefanPage, inesPage]) {
    await expect(groupRow(page, TITLE), 'the new group is listed live').toBeVisible({ timeout: 20_000 });
    await expect(groupRow(page, TITLE)).toContainText('3 people');
    await expect(groupRow(page, TITLE)).toContainText('No messages yet');
  }

  // The organiser writes; both see it arrive, with an unread count on the row and on the Messages tab.
  const box = clausPage.getByRole('textbox', { name: 'Message' });
  // The box is a tap target too: at least 44px tall (one row measured 42px here before 26 Oct 2026).
  expect((await box.boundingBox())?.height ?? 0, 'the message box is at least 44px tall @390').toBeGreaterThanOrEqual(44);
  await box.fill(HELLO);
  await expectReachable(clausPage, clausPage.getByRole('button', { name: 'Send message' }), 'Send @390');
  await box.press('Enter');
  await expect(box, 'the words left the box: the server took the message').toHaveValue('', { timeout: 15_000 });
  await expect(clausPage.getByTestId('group-messages')).toContainText(HELLO);
  await noSidewaysScroll(clausPage, 'organiser, group thread @390');
  await clausPage.screenshot({ path: 'test-results/gc-3-organiser-thread.png' });
  for (const page of [stefanPage, inesPage]) {
    await expect(groupRow(page, TITLE).getByTestId('group-unread'), 'the unread count arrives live').toHaveText('1', { timeout: 20_000 });
    await expect(groupRow(page, TITLE)).toContainText(`Claus Group: ${HELLO}`);
    await expect(messagesTab(page, 1), 'the Messages tab counts the group').toBeVisible();
    expect(await notReloaded(page), 'no reload happened').toBe(true);
  }
  await noSidewaysScroll(stefanPage, 'member, inbox @360');
  await stefanPage.screenshot({ path: 'test-results/gc-4-inbox-unread-360.png' });

  // 3. Stefan opens it: the message is there, and his counts clear. He answers; the organiser reads it live.
  await groupRow(stefanPage, TITLE).click();
  await expect(stefanPage).toHaveURL(new RegExp(`/messages/g/${groupId}$`));
  await expect(stefanPage.getByTestId('group-messages')).toContainText(HELLO, { timeout: 20_000 });
  await expect(stefanPage.getByTestId('group-messages')).toContainText('Claus Group');
  await expect(anyUnreadTab(stefanPage), 'reading the group clears the Messages tab').toHaveCount(0, { timeout: 20_000 });
  const stefanBox = stefanPage.getByRole('textbox', { name: 'Message' });
  await stefanBox.fill(REPLY);
  await stefanPage.getByRole('button', { name: 'Send message' }).click();
  await expect(stefanBox).toHaveValue('', { timeout: 15_000 });
  await expect(clausPage.getByTestId('group-messages'), 'the answer reaches the open thread live').toContainText(REPLY, { timeout: 20_000 });
  await expect(groupRow(inesPage, TITLE).getByTestId('group-unread')).toHaveText('2', { timeout: 20_000 });
  await expect(messagesTab(inesPage, 2)).toBeVisible();
  await noSidewaysScroll(stefanPage, 'member, group thread @360');
  await stefanPage.screenshot({ path: 'test-results/gc-5-member-thread-360.png' });

  // 4. Ines opens it from the bell (one bell for the group in 10 minutes), then leaves it.
  await inesPage.getByRole('button', { name: 'Notifications' }).click();
  const bell = inesPage.getByText(`Claus Group wrote in ‘${TITLE}’`);
  await expect(bell, 'the group message rang her bell').toBeVisible({ timeout: 20_000 });
  await bell.click();
  await expect(inesPage).toHaveURL(new RegExp(`/messages/g/${groupId}$`), { timeout: 20_000 });
  await expect(inesPage.getByTestId('group-messages')).toContainText(HELLO, { timeout: 20_000 });
  await expect(inesPage.getByTestId('group-messages')).toContainText(REPLY);
  await expect(anyUnreadTab(inesPage)).toHaveCount(0, { timeout: 20_000 });

  await inesPage.getByTestId('group-header').click();
  const members = inesPage.getByRole('dialog', { name: 'Members' });
  await expect(members.getByTestId('group-members-count')).toHaveText('3 of 50');
  await expect(members).toContainText(LIMIT);
  await expect(members.getByTestId('group-member')).toHaveCount(3);
  await expect(members.getByTestId('group-member').filter({ hasText: 'Claus Group' })).toContainText('Admin');
  await expect(members.getByTestId('group-member').filter({ hasText: 'Ines Group' })).toContainText('You');
  await expect(members.getByRole('button', { name: 'Remove' }), 'only the admin removes people').toHaveCount(0);
  const leave = members.getByRole('button', { name: 'Leave group' });
  await expectReachable(inesPage, leave, 'Leave group @414');
  await inesPage.screenshot({ path: 'test-results/gc-6-members-sheet-414.png' });
  await leave.click();
  await expect(members.getByTestId('leave-confirm'), 'Leave asks first').toContainText("You will stop getting its messages. Only the group's admin can add you back.");
  await members.getByTestId('leave-confirm').getByRole('button', { name: 'Leave group' }).click();
  await expect(inesPage, 'back in Messages').toHaveURL(`${APP}/messages`, { timeout: 20_000 });
  await expect(inesPage.getByText(`You left ${TITLE}.`)).toBeVisible();
  await expect(groupRow(inesPage, TITLE), 'the group is gone from her list').toHaveCount(0, { timeout: 20_000 });
  await expect(clausPage.getByTestId('group-member-count'), 'the organiser sees it without a reload').toHaveText('2 of 50', { timeout: 20_000 });

  // The organiser, the group's admin, can remove the one who is left (not done: it is the remove control that is checked).
  await clausPage.getByTestId('group-header').click();
  const clausMembers = clausPage.getByRole('dialog', { name: 'Members' });
  await expect(clausMembers.getByTestId('group-member')).toHaveCount(2);
  await expect(clausMembers.getByTestId('group-member').filter({ hasText: 'Stefan Group' }).getByRole('button', { name: 'Remove' })).toBeVisible();
  await clausMembers.getByRole('button', { name: 'Close' }).click();

  // The group's address, now that she is not in it, and a group that does not exist: said in words, a way back.
  await gotoRetry(inesPage, `${APP}/messages/g/${groupId}`);
  await expect(inesPage.getByTestId('group-thread-problem')).toContainText('You are not in this group.', { timeout: 30_000 });
  await expect(inesPage.getByRole('link', { name: 'Back to Messages' })).toBeVisible();
  await expect(inesPage.getByText(/Page not found/i)).toHaveCount(0);
  await noSidewaysScroll(inesPage, 'left member, group address @414');
  await gotoRetry(inesPage, `${APP}/messages/g/0b5f3f5e-3c1a-4e3a-9a3e-6d2f1c0a9b7e`);
  await expect(inesPage.getByTestId('group-thread-problem')).toContainText('This group chat could not be found.', { timeout: 30_000 });
  await gotoRetry(inesPage, `${APP}/messages/g/not-a-group`);
  await expect(inesPage.getByTestId('group-thread-problem')).toContainText('This group chat could not be found.', { timeout: 30_000 });

  expect(pageErrors, 'no page errors').toEqual([]);
});

test('a group chat holds 50 people: the start sheet asks to choose, stops at 50, and the 51st is refused', async () => {
  test.setTimeout(300_000);
  const page = await open(organiser, 'claus-cap', `/sessions/${bigEventId}`, { width: 390, height: 844 });
  const card = page.getByTestId('start-group-chat');
  await expect(card).toBeVisible({ timeout: 40_000 });
  await card.getByRole('button', { name: 'Start a group chat' }).click();
  const sheet = page.getByRole('dialog', { name: 'Start a group chat' });

  // Fifty took part besides the organiser: nobody is ticked yet, and the sheet says to choose up to 49.
  await expect(sheet).toContainText('More than 49 people took part. Choose up to 49, or use Message everyone who took part to reach them all.');
  await expect(sheet.getByTestId('start-group-count')).toHaveText('1 of 50');
  await expect(sheet.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await expect(sheet).toContainText('A group chat needs at least 3 people.');
  const start = sheet.getByRole('button', { name: 'Start group chat', exact: true });
  await expect(start).toBeDisabled();

  // Choosing stops at 50: the last box is off, and the sheet says why.
  for (let i = 1; i <= 49; i++) await sheet.getByRole('checkbox', { name: guest(i) }).check();
  await expect(sheet.getByTestId('start-group-count')).toHaveText('50 of 50');
  await expect(sheet.getByRole('checkbox', { name: guest(50) })).toBeDisabled();
  await expect(sheet).toContainText(FULL);
  await page.screenshot({ path: 'test-results/gc-7-start-sheet-full.png' });
  await sheet.getByRole('checkbox', { name: guest(49) }).uncheck();
  await expect(sheet.getByTestId('start-group-count')).toHaveText('49 of 50');
  await expect(sheet.getByRole('checkbox', { name: guest(50) })).toBeEnabled();
  await expect(start).toBeEnabled();
  await start.click();
  const groupId = await groupIdOf(page);
  await expect(page.getByTestId('group-member-count')).toHaveText('49 of 50');

  // The admin adds one more who took part; the 51st cannot be chosen, and says why.
  await page.getByTestId('group-header').click();
  const members = page.getByRole('dialog', { name: 'Members' });
  await expect(members.getByTestId('group-member')).toHaveCount(49);
  await members.getByRole('button', { name: 'Add people' }).click();
  const add = members.getByTestId('add-people-form');
  await expect(add.getByRole('checkbox')).toHaveCount(2);
  await add.getByRole('checkbox', { name: guest(49) }).check();
  await expect(add.getByTestId('add-people-full')).toHaveText(FULL);
  await expect(add.getByRole('checkbox', { name: guest(50) }), 'the 51st cannot be chosen').toBeDisabled();
  await noSidewaysScroll(page, 'organiser, add people @390');
  await page.screenshot({ path: 'test-results/gc-8-add-people-full.png' });
  await add.getByRole('button', { name: 'Add 1 person' }).click();
  await expect(page.getByText('Added 1 person.')).toBeVisible({ timeout: 20_000 });
  await expect(members.getByTestId('group-members-count')).toHaveText('50 of 50', { timeout: 20_000 });
  await expect(members.getByTestId('group-full'), 'a full group says so instead of offering more').toHaveText(FULL);
  await expect(page.getByTestId('group-member-count')).toHaveText('50 of 50');

  // The server holds the line too: a 51st add is refused in the same words.
  const res = await fetch(`${SERVER}/api/groups/${groupId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${organiser.accessToken}` },
    body: JSON.stringify({ userIds: [fillers[49].id] }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.message).toBe(FULL);
  const count = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM dm_group_members WHERE group_id = $1', [groupId]);
  expect(count.rows[0].n).toBe(50);

  // The admin removes someone (asked first): 49 of 50, and there is room to add again.
  const first = members.getByTestId('group-member').filter({ hasText: guest(1) });
  await first.getByRole('button', { name: 'Remove' }).click();
  await expect(first).toContainText(`Remove ${guest(1)} from the group?`);
  await first.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(`${guest(1)} is no longer in the group.`)).toBeVisible({ timeout: 20_000 });
  await expect(members.getByTestId('group-members-count')).toHaveText('49 of 50', { timeout: 20_000 });
  await expect(members.getByTestId('group-member').filter({ hasText: guest(1) })).toHaveCount(0);
  await expect(members.getByRole('button', { name: 'Add people' })).toBeVisible();
  await expect(page.getByTestId('group-member-count')).toHaveText('49 of 50');

  expect(pageErrors, 'no page errors').toEqual([]);
});

test('a long group opens at its newest message even when its details come after its messages; earlier messages keep the place; one read mark per burst, none when all is read', async () => {
  test.setTimeout(240_000);
  // Three people, and sixty messages from the two others: Stefan has sixty unread, on two pages.
  const created = await apiRequest(organiser, 'POST', `/groups/from-event/${eventId}`, { name: LONG_GROUP, memberIds: [stefan.id, ines.id] });
  const groupId: string = created.data.id;
  groupIds.push(groupId);
  await pool.query(
    `INSERT INTO direct_messages (group_id, from_user_id, content, created_at)
     SELECT $1, CASE WHEN i % 2 = 0 THEN $2::uuid ELSE $3::uuid END, 'Note ' || i || ' ' || $4, NOW() + (i || ' milliseconds')::interval
       FROM generate_series(1, 60) AS i`,
    [groupId, organiser.id, ines.id, RUN],
  );
  const note = (page: Page, i: number) => page.getByText(`Note ${i} ${RUN}`, { exact: true });

  const page = await open(stefan, 'stefan-long', '/messages', { width: 360, height: 740 });
  await expect(groupRow(page, LONG_GROUP)).toBeVisible({ timeout: 40_000 });
  // The read marks the server has STORED (their 2xx answers, not the requests): the next step of the test may post a
  // message, and a mark still on its way to the server would be stored after that message, which the server then counts
  // as read, so no mark would be due for it. Counted as responses, the message that follows is always newer than the
  // mark before it. (Seen on the preview, 26 Oct 2026: one of two marks missing when the request order flipped.)
  const reads: string[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && r.url().endsWith(`/api/groups/${groupId}/read`) && r.ok()) reads.push(r.url());
  });
  // The group's details come a second and a half after its messages, as on a slow connection.
  await page.route(`**/api/groups/${groupId}`, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => {});
  });
  await groupRow(page, LONG_GROUP).click();
  await expect(note(page, 60), 'the newest message is in view').toBeInViewport({ timeout: 20_000 });
  await expect(note(page, 11), 'not the oldest of the page').not.toBeInViewport();
  await page.unrouteAll({ behavior: 'wait' });
  await expect.poll(() => reads.length, { message: 'one read mark on opening with sixty unread', timeout: 10_000 }).toBe(1);

  // "Show earlier messages" from the top: the earlier page goes above, and the place being read stays in view. A change
  // to the group landing while that page is on its way (here the organiser's message, while the page takes 1.5 s)
  // used to drop the page without a word: the refetch the change starts cancels the page fetch in flight (React
  // Query), so nothing appeared and the button sat there. The page is asked for again until it has come.
  const scroll = page.getByTestId('group-thread-scroll');
  await scroll.evaluate((el) => { el.scrollTop = 0; });
  await expect(note(page, 11)).toBeInViewport();
  let slowedOnce = false;
  await page.route(new RegExp(`/api/groups/${groupId}/messages\\?.*\\bbefore=`), async (route) => {
    if (!slowedOnce) {
      slowedOnce = true;
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: 'Show earlier messages' }).click();
  await apiRequest(organiser, 'POST', `/groups/${groupId}/messages`, { content: `Meanwhile ${RUN}` });
  await expect(note(page, 1), 'the earlier page arrives although a message landed meanwhile').toBeAttached({ timeout: 20_000 });
  await expect(page.getByText(`Meanwhile ${RUN}`, { exact: true })).toBeAttached();
  await page.unrouteAll({ behavior: 'wait' });
  // That message is unread: one read mark for it (the earlier page itself marks nothing).
  await expect.poll(() => reads.length, { message: 'one read mark for the message that landed meanwhile', timeout: 10_000 }).toBe(2);
  await expect(note(page, 11), 'the place being read stays in view').toBeInViewport();
  await expect(note(page, 1), 'the earlier page is above it').not.toBeInViewport();
  await noSidewaysScroll(page, 'long group @360');

  // A burst of three while Stefan reads at the end: they arrive live, and the group is marked read once for all three.
  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await Promise.all([1, 2, 3].map((i) => apiRequest(organiser, 'POST', `/groups/${groupId}/messages`, { content: `Burst ${i} ${RUN}` })));
  for (const i of [1, 2, 3]) await expect(page.getByText(`Burst ${i} ${RUN}`, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => reads.length, { message: 'one read mark for the burst', timeout: 10_000 }).toBe(3);
  await page.waitForTimeout(2500);
  expect(reads.length, 'still one read mark for the burst').toBe(3);
  await expect(anyUnreadTab(page), 'read: no count on the Messages tab').toHaveCount(0, { timeout: 20_000 });

  // Opened again with nothing unread: no read mark.
  await page.getByRole('link', { name: 'Back to inbox' }).click();
  await groupRow(page, LONG_GROUP).click();
  await expect(page.getByTestId('group-messages')).toContainText(`Burst 3 ${RUN}`, { timeout: 20_000 });
  await page.waitForTimeout(2500);
  expect(reads.length, 'nothing unread: no read mark on opening').toBe(3);
  const narrowBox = page.getByRole('textbox', { name: 'Message' });
  expect((await narrowBox.boundingBox())?.height ?? 0, 'the message box is at least 44px tall @360').toBeGreaterThanOrEqual(44);

  expect(pageErrors, 'no page errors').toEqual([]);
});
