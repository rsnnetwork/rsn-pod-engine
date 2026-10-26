import { test, expect, chromium, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { createPod, addPodMember, apiRequest, createSession, registerForSession } from '../helpers/api';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { skipEventCheckIn } from '../helpers/event-check-in';
import { expectReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// After the event (COM-02/03/05, 25 Oct 2026, Stefan and Claus on production): Stefan left and landed on the events
// list with the app's live connection cut; Claus ended the event and had no way to it; the completed event showed no
// chat; "Message all participants" was greyed out. One path now, for every role:
//   1. Two people chat during a speed-networking event, the host in the room.
//   2. One leaves with Leave Event: the event's own page, not the events list; the chat card says the chat is inside
//      the live event.
//   3. The host ends it. The leaver's page turns to "Ended" without a reload (the live connection survived the leave),
//      and shows the chat kept with the event. The one who stayed goes from the end screen ("Event details" first,
//      the three exits stacked on a phone) to the event's page and reads the same chat.
//   4. A pod member who did not take part opens the event: the chat card says why it cannot be read, and there is no
//      message-everyone panel.
//   5. The host (an ordinary member who directs the pod, as Claus) writes to everyone who took part from the panel:
//      "Sent to 2 people on …". The leaver, whose page was never reloaded, gets the bell
//      "{name} messaged everyone from ‘{event}’" and the message itself in Messages.
//   6. Both reopen the event and still read the chat.
//   7. A video meeting: the guest leaves with the bar's Leave, lands on the event page, is listed as a member (not the
//      room's stale "In Main Room" or "Reconnecting…"), and sees the meeting end without a reload.
// Throwaway members (@rsn-e2e.invalid, no email sent) and their pod are deleted by id. Runs on the local stack, the
// preview (E2E_VERCEL_SHARE) or production; E2E_ENGINE=webkit for Safari's engine.
// ─────────────────────────────────────────────────────────────────────────────

const HEADLESS = process.env.E2E_HEADED === '0' || process.env.E2E_HEADED === undefined;
const ENGINE = process.env.E2E_ENGINE === 'webkit' ? 'webkit' : 'chromium';
// Chromium >= 147 on Windows loses the fake camera through Media Foundation capture; Chromium honours only the last
// --disable-features switch, so Playwright's own defaults are repeated before the extra one.
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';

const RUN = Date.now().toString(36);
const TITLE = `E2E after the event ${RUN}`;
const HELLO = `Hello from Stefan ${RUN}`;
const REPLY = `Hi Stefan, Ines here ${RUN}`;
const WORDS = `Thank you both for coming. The notes follow tomorrow. ${RUN}`;
const FORBIDDEN = 'Only people who took part in this event can read its chat.';

let browser: Browser;
let host: TestUser, stays: TestUser, leaves: TestUser, outsider: TestUser;
let hostName = '';
let podId = '';
let sessionId = '';
let meetingId = '';
let hostSocket: Socket | null = null;
const ctxs: BrowserContext[] = [];
const pageErrors: string[] = [];
let staysPage: Page;
let leavesPage: Page;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = async () => (await pool.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [sessionId])).rows[0]?.status;
const BENIGN = /ResizeObserver loop|livekit|LiveKit|getUserMedia|NotAllowedError|NotFoundError|Permission|could not start video source|Requested device not found/i;

/** A throwaway member whose address can never receive mail, and who gets no message email. */
async function member(label: string, name: string): Promise<TestUser> {
  const u = await createTestUser(`aep-${label}`);
  const email = `e2etest-aep-${label}-${RUN}@rsn-e2e.invalid`;
  await pool.query(
    `UPDATE users SET email = $1, display_name = $2,
            notification_prefs = jsonb_set(COALESCE(notification_prefs, '{}'::jsonb), '{dm_email}', 'false')
      WHERE id = $3`,
    [email, name, u.id],
  );
  return { ...u, email, displayName: name };
}

async function launch(): Promise<Browser> {
  if (ENGINE === 'webkit') return webkit.launch({ headless: HEADLESS });
  return chromium.launch({
    headless: HEADLESS,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      `--disable-features=${PW_DISABLED},MediaFoundationD3D11VideoCapture`],
  });
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
  page.on('pageerror', (e) => { if (!BENIGN.test(e.message)) pageErrors.push(`${who}: ${e.message}`); });
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

function connect(u: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket timeout')), 15_000);
  });
}

/** Opens the live chat and says something in it; the words come back from the server. */
async function say(page: Page, words: string): Promise<void> {
  const openChat = page.getByRole('button', { name: 'Open chat' });
  if (await openChat.isVisible().catch(() => false)) await openChat.click();
  const box = page.getByPlaceholder('Message everyone...');
  await expect(box, 'the chat box is open').toBeEditable({ timeout: 30_000 });
  await box.fill(words);
  await box.press('Enter');
  await expect(box, 'the words left the box: the server took the message').toHaveValue('', { timeout: 15_000 });
}

const chatCard = (page: Page) => page.getByTestId('event-chat');
const badgeOf = (page: Page) => page.getByText(/^(Ended|Live now|Upcoming)$/).first();

async function noSidewaysScroll(page: Page, label: string): Promise<void> {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(wide, `${label}: the page scrolls sideways`).toBe(false);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = await launch();
  host = await member('host', 'Claus After');
  stays = await member('stays', 'Stefan After');
  leaves = await member('leaves', 'Ines After');
  outsider = await member('outsider', 'Pia After');
  hostName = host.displayName;
  // The host creates the pod, so they direct it: an ordinary member who runs the event, as Claus did.
  const pod = await createPod(host, `E2E after the event pod ${RUN}`);
  podId = pod.id;
  for (const u of [stays, leaves, outsider]) await addPodMember(host, podId, u.id);
  const ev = await createSession(host, podId, TITLE, new Date(Date.now() + 60_000), { numberOfRounds: 1 });
  sessionId = ev.id;
  await registerForSession(stays, sessionId);
  await registerForSession(leaves, sessionId);
});

test.afterAll(async () => {
  hostSocket?.disconnect();
  for (const c of ctxs) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
  const ids = [host, stays, leaves, outsider].filter(Boolean).map((u) => u.id);
  // The message-everyone rows of both events first (the event cascade would take them, but in a fixed order).
  for (const id of [sessionId, meetingId].filter(Boolean)) {
    await pool.query(
      `DELETE FROM post_event_message_recipients WHERE job_id IN (SELECT id FROM post_event_message_jobs WHERE session_id = $1)`,
      [id],
    ).catch(() => {});
    await pool.query('DELETE FROM post_event_message_jobs WHERE session_id = $1', [id]).catch(() => {});
  }
  await cleanup(pool, { ids, podId: podId || undefined });
});

test('two people chat; one leaves to the event page, which turns to Ended without a reload; both read the chat kept with the event', async () => {
  test.setTimeout(420_000);

  // 1. The host opens the room and stays in it; two members come in and chat.
  hostSocket = await connect(host);
  hostSocket.emit('host:start_session', { sessionId });
  await expect.poll(statusOf, { timeout: 30_000, message: 'the event is live' }).toBe('lobby_open');
  hostSocket.emit('session:join', { sessionId });

  staysPage = await open(stays, 'stays', `/session/${sessionId}/live`, { width: 360, height: 740 });
  leavesPage = await open(leaves, 'leaves', `/session/${sessionId}/live`, { width: 390, height: 844 });
  await Promise.all([skipEventCheckIn(staysPage), skipEventCheckIn(leavesPage)]);
  await say(staysPage, HELLO);
  await say(leavesPage, REPLY);
  await expect(staysPage.getByText(REPLY), 'the reply reaches the other person live').toBeVisible({ timeout: 20_000 });
  await expect(leavesPage.getByText(HELLO)).toBeVisible({ timeout: 20_000 });

  // 2. Leave Event: the event's own page, in place of the live page.
  await leavesPage.getByRole('button', { name: 'Leave Event' }).click();
  await expect(leavesPage, 'the leaver lands on the event page').toHaveURL(new RegExp(`/sessions/${sessionId}$`), { timeout: 30_000 });
  await expect(leavesPage.getByRole('heading', { name: TITLE })).toBeVisible({ timeout: 30_000 });
  await expect(leavesPage.getByTestId('event-chat-live'), 'while it runs, the chat is inside the live event').toContainText('The chat is inside the live event.');
  await expect(leavesPage.getByTestId('event-chat-live').getByRole('button', { name: 'Enter live event', exact: true })).toBeVisible();
  await expect(leavesPage.getByRole('link', { name: 'Back to pod' }), 'the event page goes back to the pod').toBeVisible();
  await noSidewaysScroll(leavesPage, 'leaver, event page while live @390');
  await leavesPage.evaluate(() => { (window as unknown as { __notReloaded?: boolean }).__notReloaded = true; });
  await leavesPage.screenshot({ path: 'test-results/aep-1-leaver-event-page-live.png', fullPage: true });

  // 3. The host ends the event. The leaver's page turns to Ended on its own, and shows the chat.
  hostSocket.emit('host:end_session', { sessionId, endEvent: true });
  await expect.poll(statusOf, { timeout: 60_000, message: 'the event is completed' }).toBe('completed');
  await expect(badgeOf(leavesPage), 'the leaver sees Ended without reloading').toHaveText('Ended', { timeout: 20_000 });
  expect(await leavesPage.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded), 'no reload happened').toBe(true);
  await expect(chatCard(leavesPage).getByText(HELLO), 'the chat kept with the event').toBeVisible({ timeout: 20_000 });
  await expect(chatCard(leavesPage).getByText(REPLY)).toBeVisible();
  await leavesPage.screenshot({ path: 'test-results/aep-2-leaver-event-page-ended.png', fullPage: true });

  // The one who stayed: the end screen offers the event first, the three exits stacked on a 360px phone.
  const details = staysPage.getByRole('button', { name: 'Event details' });
  const toPod = staysPage.getByRole('button', { name: 'Back to pod' });
  const recap = staysPage.getByRole('button', { name: 'Full recap' });
  await expect(details, 'the end screen offers the event').toBeVisible({ timeout: 45_000 });
  await details.scrollIntoViewIfNeeded();
  const boxes = [await details.boundingBox(), await toPod.boundingBox(), await recap.boundingBox()];
  for (const b of boxes) {
    expect(b, 'each exit is drawn').not.toBeNull();
    expect(b!.height, 'each exit is at least 44px tall').toBeGreaterThanOrEqual(44);
  }
  expect(boxes[0]!.y, '"Event details" first').toBeLessThan(boxes[1]!.y);
  expect(boxes[1]!.y, 'then "Back to pod"').toBeLessThan(boxes[2]!.y);
  expect(Math.abs(boxes[0]!.width - boxes[2]!.width), 'stacked at full width').toBeLessThanOrEqual(1);
  await expectReachable(staysPage, details, 'Event details @360');
  await noSidewaysScroll(staysPage, 'end screen @360');
  await staysPage.screenshot({ path: 'test-results/aep-3-end-screen-360.png', fullPage: true });
  await details.click();
  await expect(staysPage, 'Event details opens the event page').toHaveURL(new RegExp(`/sessions/${sessionId}$`), { timeout: 30_000 });
  await expect(chatCard(staysPage).getByText(HELLO)).toBeVisible({ timeout: 30_000 });
  await expect(chatCard(staysPage).getByText(REPLY)).toBeVisible();
  await expect(badgeOf(staysPage)).toHaveText('Ended');
  await noSidewaysScroll(staysPage, 'event page, ended @360');

  // 4. A pod member who did not take part: told why the chat cannot be read, and no panel.
  const outsiderPage = await open(outsider, 'outsider', `/sessions/${sessionId}`, { width: 768, height: 1024 });
  await expect(chatCard(outsiderPage).getByTestId('event-chat-forbidden')).toHaveText(FORBIDDEN, { timeout: 30_000 });
  expect(await outsiderPage.getByRole('heading', { name: 'Message everyone who took part' }).count(), 'no panel for someone who did not run it').toBe(0);
  expect(await outsiderPage.getByText(/no longer accepting participants/i).count(), 'no refusal from a register nobody asked for').toBe(0);
  await outsiderPage.screenshot({ path: 'test-results/aep-4-outsider-768.png', fullPage: true });
});

test('the host messages everyone who took part; the leaver, never reloaded, gets the bell and the message', async () => {
  test.setTimeout(300_000);

  const bell = leavesPage.getByRole('button', { name: 'Notifications' });
  const unreadBefore = Number((await bell.innerText().catch(() => '')).trim()) || 0;

  // 5. The host writes from the panel on the event page.
  const hostPage = await open(host, 'host', `/sessions/${sessionId}`, { width: 1280, height: 800 });
  const panel = hostPage.getByTestId('message-everyone');
  await expect(panel.getByRole('heading', { name: 'Message everyone who took part' })).toBeVisible({ timeout: 30_000 });
  const write = panel.getByRole('button', { name: 'Write a message' });
  await expectReachable(hostPage, write, 'Write a message @1280');
  await write.click();
  const dialog = hostPage.getByRole('dialog', { name: 'Message everyone who took part' });
  await dialog.getByLabel('Your message').fill(WORDS);
  await expect(dialog).toContainText('Everyone who took part (2)');
  const send = dialog.getByRole('button', { name: 'Send to 2 people' });
  await expectReachable(hostPage, send, 'Send @1280');
  await send.click();
  await expect(dialog, 'the composer closes once the send is accepted').toHaveCount(0, { timeout: 15_000 });
  await expect(panel.getByTestId('message-everyone-sent'), 'the panel says it went out, from the event tag (no poll)')
    .toContainText(/^Sent to 2 people on \d{1,2} [A-Z][a-z]{2} \d{4}$/, { timeout: 90_000 });
  await expect(panel.getByRole('button', { name: 'Send another message' })).toBeVisible();
  await hostPage.screenshot({ path: 'test-results/aep-5-host-panel-sent.png', fullPage: true });

  // The leaver's page, still not reloaded: the bell counts it, and says who wrote and from where.
  expect(await leavesPage.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded), 'still the same page').toBe(true);
  await expect.poll(async () => Number((await bell.innerText().catch(() => '')).trim()) || 0, {
    timeout: 60_000, message: 'the bell counts the message on the leaver\'s open page',
  }).toBeGreaterThan(unreadBefore);
  await bell.click();
  const bellLine = leavesPage.getByText(`${hostName} messaged everyone from ‘${TITLE}’`).first();
  await expect(bellLine, 'the bell says who wrote and from which event').toBeVisible({ timeout: 15_000 });
  await leavesPage.screenshot({ path: 'test-results/aep-6-leaver-bell.png' });
  await bellLine.click();
  await expect(leavesPage, 'the bell opens the conversation').toHaveURL(/\/messages\//, { timeout: 30_000 });
  // On a phone the inbox's preview of the same words is hidden behind the open thread.
  await expect(leavesPage.getByText(WORDS).filter({ visible: true }).first(), 'the host\'s own words, in Messages').toBeVisible({ timeout: 30_000 });

  // 6. Both open the event again: the chat is still there.
  for (const [page, who] of [[leavesPage, 'leaver'], [staysPage, 'stayer']] as const) {
    await gotoRetry(page, `${APP}/sessions/${sessionId}`);
    await expect(chatCard(page).getByText(HELLO), `${who} reads the chat again`).toBeVisible({ timeout: 30_000 });
    await expect(chatCard(page).getByText(REPLY)).toBeVisible();
  }
  expect(pageErrors, 'no page has thrown').toEqual([]);
});

test('a guest who leaves a video meeting is listed as a member who left, not "Reconnecting…", and still sees it end', async () => {
  test.setTimeout(240_000);

  // A meeting in the same pod: the host runs it, Stefan is the guest.
  const meeting = (await apiRequest(host, 'POST', '/sessions', {
    podId, title: `${TITLE} (meeting)`, description: 'COM-05', scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    format: 'video_meeting', config: { durationMinutes: 30, maxParticipants: 10 },
  })).data;
  meetingId = meeting.id;
  await registerForSession(stays, meetingId);
  if (!hostSocket) hostSocket = await connect(host);
  hostSocket!.emit('host:start_session', { sessionId: meetingId });
  await expect.poll(async () => (await pool.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [meetingId])).rows[0]?.status,
    { timeout: 30_000, message: 'the meeting is live' }).toBe('lobby_open');
  hostSocket!.emit('session:join', { sessionId: meetingId });

  const guest = await open(stays, 'meeting guest', `/session/${meetingId}/live`, { width: 390, height: 844 });
  await expect.poll(async () => (await pool.query<{ status: string }>(
    'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2', [meetingId, stays.id])).rows[0]?.status,
  { timeout: 30_000, message: 'the guest is in the meeting' }).toMatch(/in_lobby|checked_in/);
  await guest.getByTestId('meeting-leave').click();
  await guest.getByRole('alertdialog', { name: 'Leave the meeting?' }).getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(guest, 'the guest lands on the event page').toHaveURL(new RegExp(`/sessions/${meetingId}$`), { timeout: 30_000 });
  await guest.evaluate(() => { (window as unknown as { __notReloaded?: boolean }).__notReloaded = true; });
  // The guest's own row follows the server's "left" at once (the leave's tags reach a connection that stayed up),
  // instead of the room's stale list ("In Main Room", or "Reconnecting…" from a cut connection).
  const ownRow = guest.locator('#participants').getByRole('link', { name: new RegExp(stays.displayName) });
  await expect(ownRow, 'the guest is listed as a member, no longer in the room').toContainText('Member', { timeout: 15_000 });
  await expect(ownRow).not.toContainText(/Reconnecting|In Main Room/);

  hostSocket!.emit('host:end_session', { sessionId: meetingId, endEvent: true });
  await expect(badgeOf(guest), 'the guest sees the meeting end without reloading').toHaveText('Ended', { timeout: 30_000 });
  expect(await guest.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded), 'no reload happened').toBe(true);
  await noSidewaysScroll(guest, 'meeting guest, event page @390');
  await guest.screenshot({ path: 'test-results/aep-7-meeting-guest-ended.png', fullPage: true });
});
