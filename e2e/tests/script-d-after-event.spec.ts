// e2e/tests/script-d-after-event.spec.ts
//
// SCRIPT D, "Conversation survives the event" (25 Oct walkthrough), re-read against the 30 Oct changes (T19, 2 Nov
// 2026). Three accounts in a pod (the organiser, an ordinary member who runs it as Claus did, and two who take part),
// plus a pod member who did not, in real browsers that are never reloaded where a step watches someone else:
//   01 The two chat during a live speed-networking event; each sees the other's words live. One leaves (to the event's
//      own page); the organiser ends the event.
//   02 The leaver's open page turns to Ended without a reload and shows the chat kept with the event; the other reads
//      the same chat from the event page; a pod member who did not take part is told why they cannot read it.
//   03 Back on the pod, one posts on its wall; the other's open pod page shows the post without a reload, and their
//      comment reaches the author's open page.
//   04 The organiser writes to everyone who took part ("Sent to 2 people"); the leaver's open page rings, and the words
//      are in Messages.
//   05 The organiser starts a group chat of the three from the event page; it appears in both others' open Messages
//      without a reload; a message goes round, and an answer comes back live. (30 Oct, 4.7a: own bubbles gray.)
// Throwaway members only (<id>@rsn-e2e.invalid, no email sent), deleted by id with the pod, its event and the group.

import { test, expect, type Browser, type Page } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import {
  APP, RUN, SERVER, cleanupRun, expectNotReloaded, gotoRetry, launch, made, markNotReloaded, noSidewaysScroll, openAs, pool,
  seedPod, shot, tall, throwaway, where, type TestUser,
} from '../helpers/sweep';
import { registerForSession, createSession } from '../helpers/api';
import { skipEventCheckIn } from '../helpers/event-check-in';
import { acceptConfirmDialogs } from '../helpers/confirm-dialog';

const SLOW = 60_000;
const LIVE = 25_000;
const TITLE = `${RUN} Founders evening`;
const HELLO = `Hello from Sara ${RUN}`;
const REPLY = `Hi Sara, Tom here ${RUN}`;
const WORDS = `Thank you both for coming. Notes follow tomorrow. ${RUN}`;
const POST = `Notes from the evening ${RUN}`;
const COMMENT = `Thanks for these ${RUN}`;
const GROUP_HELLO = `Shall we meet again next month? ${RUN}`;
const GROUP_REPLY = `Yes, count me in ${RUN}`;

let browser: Browser;
let claus: TestUser, sara: TestUser, tom: TestUser, ida: TestUser;
let podId = '';
let sessionId = '';
let hostSocket: Socket | null = null;

function connectSocket(u: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket timeout')), 15_000);
  });
}

async function say(page: Page, words: string): Promise<void> {
  const openChat = page.getByRole('button', { name: 'Open chat' });
  if (await openChat.isVisible().catch(() => false)) await openChat.click();
  const box = page.getByPlaceholder('Message everyone...');
  await expect(box, 'the chat box is open').toBeEditable({ timeout: 30_000 });
  await box.fill(words);
  await box.press('Enter');
  await expect(box, 'the server took the message').toHaveValue('', { timeout: 15_000 });
}

const statusOf = async () => (await pool.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [sessionId])).rows[0]?.status;
const chatCard = (page: Page) => page.getByTestId('event-chat');

test.beforeAll(async () => {
  browser = await launch();
  claus = await throwaway('Claus');
  sara = await throwaway('Sara');
  tom = await throwaway('Tom');
  ida = await throwaway('Ida');
  podId = await seedPod(claus, `${RUN} Founders pod`, [sara, tom, ida]);
  sessionId = (await createSession(claus, podId, TITLE, new Date(Date.now() + 60_000), { numberOfRounds: 1 })).id;
  made.sessions.push(sessionId);
  await registerForSession(sara, sessionId);
  await registerForSession(tom, sessionId);
  console.log(`[script-d] ${where()} app=${APP}`);
});

test.afterAll(async () => {
  hostSocket?.disconnect();
  await cleanupRun();
  await browser?.close().catch(() => undefined);
});

test('Script D: the chat of an event, its pod\'s wall, a message to everyone and a group of three, each change on the others\' screens live', async () => {
  test.setTimeout(600_000);
  let saraPage: Page;
  let tomPage: Page;

  await test.step('01 two chat during the live event; Tom leaves to its page; the organiser ends it', async () => {
    hostSocket = await connectSocket(claus);
    hostSocket.emit('host:start_session', { sessionId });
    await expect.poll(statusOf, { timeout: 30_000, message: 'the event is live' }).toBe('lobby_open');
    hostSocket.emit('session:join', { sessionId });
    saraPage = (await openAs(browser, sara, `/session/${sessionId}/live`)).page;
    tomPage = (await openAs(browser, tom, `/session/${sessionId}/live`)).page;
    for (const p of [saraPage, tomPage]) await acceptConfirmDialogs(p);
    await Promise.all([skipEventCheckIn(saraPage), skipEventCheckIn(tomPage)]);
    await say(saraPage, HELLO);
    await say(tomPage, REPLY);
    await expect(saraPage.getByText(REPLY), 'Tom\'s words reach Sara live').toBeVisible({ timeout: LIVE });
    await expect(tomPage.getByText(HELLO), 'Sara\'s words reach Tom live').toBeVisible({ timeout: LIVE });
    await tomPage.getByRole('button', { name: 'Leave Event' }).click();
    await expect(tomPage).toHaveURL(new RegExp(`/sessions/${sessionId}$`), { timeout: 30_000 });
    await expect(tomPage.getByRole('link', { name: 'Back to pod' })).toBeVisible({ timeout: SLOW });
    await markNotReloaded(tomPage);
    hostSocket.emit('host:end_session', { sessionId, endEvent: true });
    await expect.poll(statusOf, { timeout: 60_000, message: 'the event is completed' }).toBe('completed');
  });

  await test.step('02 the chat is kept with the event: Tom\'s open page turns to Ended and shows it; Sara reads it too; a pod member who did not take part is told why not', async () => {
    await expect(tomPage.getByText(/^Ended$/).first(), 'Ended, without a reload').toBeVisible({ timeout: LIVE });
    await expect(chatCard(tomPage).getByText(HELLO)).toBeVisible({ timeout: LIVE });
    await expect(chatCard(tomPage).getByText(REPLY)).toBeVisible();
    await expectNotReloaded(tomPage, 'Tom\'s event page');
    await gotoRetry(saraPage, `${APP}/sessions/${sessionId}`);
    await expect(chatCard(saraPage).getByText(HELLO)).toBeVisible({ timeout: SLOW });
    await noSidewaysScroll(saraPage, 'the ended event');
    const idaPage = (await openAs(browser, ida, `/sessions/${sessionId}`)).page;
    await expect(chatCard(idaPage).getByTestId('event-chat-forbidden')).toHaveText('Only people who took part in this event can read its chat.', { timeout: SLOW });
    await expect(idaPage.getByRole('heading', { name: 'Message everyone who took part' })).toHaveCount(0);
    await idaPage.context().close();
  });

  await test.step('03 back on the pod: Sara posts on its wall; Tom\'s open pod page shows it live; his comment reaches her open page', async () => {
    await tomPage.getByRole('link', { name: 'Back to pod' }).click();
    await expect(tomPage).toHaveURL(new RegExp(`/pods/${podId}`), { timeout: 30_000 });
    await expect(tomPage.getByTestId('pod-wall')).toBeVisible({ timeout: SLOW });
    await markNotReloaded(tomPage);
    await gotoRetry(saraPage, `${APP}/pods/${podId}`);
    const composer = saraPage.getByPlaceholder('Write something to the pod…');
    await expect(composer).toBeVisible({ timeout: SLOW });
    await composer.click();
    await composer.fill(POST);
    await saraPage.getByTestId('pod-wall').getByRole('button', { name: 'Post', exact: true }).click();
    await expect(saraPage.getByText(POST)).toBeVisible({ timeout: LIVE });
    await expect.poll(async () => (await pool.query('SELECT 1 FROM pod_posts WHERE pod_id = $1 AND content = $2', [podId, POST])).rows.length, { timeout: LIVE }).toBe(1);
    const postId = (await pool.query<{ id: string }>('SELECT id FROM pod_posts WHERE pod_id = $1 AND content = $2', [podId, POST])).rows[0].id;
    const onTom = tomPage.getByTestId(`wall-post-${postId}`);
    await expect(onTom, 'Tom\'s pod page, without a reload').toContainText(POST, { timeout: LIVE });
    await onTom.getByTestId(`comment-button-${postId}`).click();
    const box = onTom.getByLabel('Your comment');
    await box.fill(COMMENT);
    await box.press('Enter');
    await expect(onTom.getByText(COMMENT)).toBeVisible({ timeout: LIVE });
    await expect(saraPage.getByTestId(`wall-post-${postId}`), 'Sara\'s open page counts the comment').toContainText('1 comment', { timeout: LIVE });
    await expectNotReloaded(tomPage, 'Tom\'s pod page');
    await shot(saraPage, 'd-wall');
  });

  await test.step('04 the organiser writes to everyone who took part; Tom\'s open page rings; the words are in Messages', async () => {
    const before = Number((await tomPage.getByRole('button', { name: 'Notifications' }).innerText().catch(() => '')).trim()) || 0;
    const hostPage = (await openAs(browser, claus, `/sessions/${sessionId}`)).page;
    const panel = hostPage.getByTestId('message-everyone');
    await expect(panel.getByRole('heading', { name: 'Message everyone who took part' })).toBeVisible({ timeout: SLOW });
    await panel.getByRole('button', { name: 'Write a message' }).click();
    const dialog = hostPage.getByRole('dialog', { name: 'Message everyone who took part' });
    await dialog.getByLabel('Your message').fill(WORDS);
    await expect(dialog).toContainText('Everyone who took part (2)');
    const send = dialog.getByRole('button', { name: 'Send to 2 people' });
    await tall(send, 'Send to 2 people');
    await send.click();
    await expect(panel.getByTestId('message-everyone-sent')).toContainText(/^Sent to 2 people on /, { timeout: 90_000 });
    await expect.poll(async () => Number((await tomPage.getByRole('button', { name: 'Notifications' }).innerText().catch(() => '')).trim()) || 0, {
      timeout: 60_000, message: 'Tom\'s open page counts it',
    }).toBeGreaterThan(before);
    await expectNotReloaded(tomPage, 'Tom\'s pod page');
    await tomPage.getByRole('button', { name: 'Notifications' }).click();
    await tomPage.getByText(`${claus.displayName} messaged everyone from ‘${TITLE}’`).first().click();
    await expect(tomPage).toHaveURL(/\/messages\//, { timeout: 30_000 });
    await expect(tomPage.getByText(WORDS).filter({ visible: true }).first()).toBeVisible({ timeout: SLOW });
    await hostPage.context().close();
  });

  await test.step('05 a group of three from the event page: it appears in both others\' open Messages live; a message goes round and an answer comes back', async () => {
    await gotoRetry(saraPage, `${APP}/messages`);
    await gotoRetry(tomPage, `${APP}/messages`);
    for (const p of [saraPage, tomPage]) {
      await expect(p.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible({ timeout: SLOW });
      await markNotReloaded(p);
    }
    const hostPage = (await openAs(browser, claus, `/sessions/${sessionId}`)).page;
    const card = hostPage.getByTestId('start-group-chat');
    await expect(card).toBeVisible({ timeout: SLOW });
    await card.getByRole('button', { name: 'Start a group chat' }).click();
    const sheet = hostPage.getByRole('dialog', { name: 'Start a group chat' });
    await expect(sheet.getByTestId('start-group-count')).toHaveText('3 of 50');
    await sheet.getByRole('button', { name: 'Start group chat', exact: true }).click();
    await expect(hostPage).toHaveURL(/\/messages\/g\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    made.groups.push(new URL(hostPage.url()).pathname.split('/').pop()!);
    const groupRow = (p: Page) => p.getByTestId('group-row').filter({ hasText: TITLE });
    for (const p of [saraPage, tomPage]) await expect(groupRow(p), 'the group is listed live').toContainText('3 people', { timeout: LIVE });
    const box = hostPage.getByRole('textbox', { name: 'Message' });
    await box.fill(GROUP_HELLO);
    await box.press('Enter');
    await expect(box).toHaveValue('', { timeout: 15_000 });
    for (const p of [saraPage, tomPage]) {
      await expect(groupRow(p).getByTestId('group-unread'), 'the unread count arrives live').toHaveText('1', { timeout: LIVE });
      await expectNotReloaded(p, 'Messages');
    }
    await groupRow(saraPage).click();
    await expect(saraPage.getByTestId('group-messages')).toContainText(GROUP_HELLO, { timeout: LIVE });
    const saraBox = saraPage.getByRole('textbox', { name: 'Message' });
    await saraBox.fill(GROUP_REPLY);
    await saraPage.getByRole('button', { name: 'Send message' }).click();
    await expect(hostPage.getByTestId('group-messages'), 'the answer reaches the organiser live').toContainText(GROUP_REPLY, { timeout: LIVE });
    await expect(groupRow(tomPage).getByTestId('group-unread')).toHaveText('2', { timeout: LIVE });
    await noSidewaysScroll(saraPage, 'the group thread');
    await shot(saraPage, 'd-group');
  });
});
