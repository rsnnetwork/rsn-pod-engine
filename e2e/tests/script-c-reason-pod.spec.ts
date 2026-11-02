// e2e/tests/script-c-reason-pod.spec.ts
//
// SCRIPT C, "Reason Pod and normal Video Meeting" (25 Oct walkthrough), re-read against the 30 Oct changes (T19, 2 Nov
// 2026). A director and two of their connections, real browsers, nothing reloaded where a step watches someone else:
//   01 The director creates a Reason pod from the form: its orchestration is Freeform without being touched.
//   02 They invite two people from the searchable list of their connections (the invite sheet), each found by name; the
//      rows say Invited in place; the Invitations card holds both. The first invitee's bell rings without a reload and
//      they accept from it; the director's open page moves them out of Invited and into the members, live.
//   03 They schedule a Video meeting from the pod: no round settings, and (30 Oct, 6.2) the Matching section says a
//      video meeting pairs nobody; "Who can join" (6.1) is offered.
//   04 An empty title is said at the field; once scheduled, the event's invite sheet opens on the pod, where the member
//      who joined can be invited and reads Invited, then Going once they register.
//   05 Both enter the meeting: two people, each tile wholly in the window, the other person large on a phone and side by
//      side on a wide screen (a real room: the preview, Chromium).
// Throwaway members only (<id>@rsn-e2e.invalid), deleted by id with their pods and events.

import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import {
  APP, ROOMS, ROOM_SKIP, RUN, RUN_WIDTH, api, bellCount, cleanupRun, expectNotReloaded, firstName, gotoRetry, launch, made,
  markNotReloaded, noSidewaysScroll, openAs, pool, roomLogsAtDebug, shot, skipStep, tall, throwaway, watchRoom, where, type TestUser,
} from '../helpers/sweep';

const SLOW = 60_000;
const LIVE = 25_000;

let browser: Browser;
let dana: TestUser, xavi: TestUser, yara: TestUser;

const sheetOf = (page: Page, name: string) => page.getByRole('dialog', { name });
const rowOf = (sheet: Locator, id: string) => sheet.getByTestId(`invite-candidate-${id}`);

test.beforeAll(async () => {
  browser = await launch();
  dana = await throwaway('Dana');
  xavi = await throwaway('Xavi');
  yara = await throwaway('Yara');
  // Two connections (a conversation each), so the sheet lists them.
  for (const other of [xavi, yara]) {
    const [a, b] = dana.id < other.id ? [dana.id, other.id] : [other.id, dana.id];
    await pool.query(`INSERT INTO dm_conversations (user_a_id, user_b_id, last_message_at) VALUES ($1, $2, NOW())`, [a, b]);
  }
  console.log(`[script-c] ${where()} app=${APP} rooms=${ROOMS}`);
});

test.afterAll(async () => {
  await cleanupRun();
  await browser?.close().catch(() => undefined);
});

test('Script C: a Reason pod is Freeform, two connections are invited from the list, a Video meeting has no rounds, and two people meet in it', async () => {
  test.setTimeout(600_000);
  const podName = `${RUN} Reason pod`;
  let podId = '';
  let eventId = '';
  const page = (await openAs(browser, dana, '/pods?create=true')).page;
  // Xavi's page is open, its live connection up, before anything is sent to him.
  const xaviPage = (await openAs(browser, xavi, '/connections')).page;
  await expect(xaviPage.getByRole('button', { name: 'Notifications' })).toBeVisible({ timeout: SLOW });
  await markNotReloaded(xaviPage);

  await test.step('01 a Reason pod made from the form is Freeform without touching orchestration', async () => {
    const sheet = sheetOf(page, 'Create a Pod');
    await expect(sheet).toBeVisible({ timeout: SLOW });
    await sheet.getByLabel('Pod name').fill(podName);
    await sheet.getByLabel('Pod type').selectOption('reason');
    await expect(sheet.getByLabel('Orchestration')).toHaveValue('free_form');
    await tall(sheet.getByRole('button', { name: 'Create Pod' }), 'Create Pod');
    await sheet.getByRole('button', { name: 'Create Pod' }).click();
    await page.waitForURL(/\/pods\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    podId = page.url().split('/').pop()!;
    made.pods.push(podId);
    const pod = (await api(dana, 'GET', `/pods/${podId}`)).json.data;
    expect([pod.podType, pod.orchestrationMode]).toEqual(['reason', 'free_form']);
  });

  await test.step('02 two connections invited from the searchable list; Invited in place; the Invitations card holds both', async () => {
    await expect(page.getByTestId('invite-status')).toBeVisible({ timeout: SLOW });
    await markNotReloaded(page);
    await page.getByRole('button', { name: 'Invite members' }).click();
    const sheet = sheetOf(page, 'Invite members');
    await expect(sheet).toBeVisible();
    const search = sheet.getByPlaceholder('Search by name, role or company');
    for (const u of [xavi, yara]) {
      await search.fill(firstName(u));
      await expect(rowOf(sheet, u.id)).toBeVisible({ timeout: LIVE });
      await rowOf(sheet, u.id).click();
    }
    await search.fill('');
    const send = sheet.getByTestId('invite-send');
    await expect(send).toHaveText('Send 2 invites');
    await tall(send, 'Send 2 invites');
    await send.click();
    await expect(page.getByText('2 invitations sent.')).toBeVisible({ timeout: LIVE });
    for (const u of [xavi, yara]) await expect(rowOf(sheet, u.id)).toContainText('Invited');
    await shot(page, 'c-invited');
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('invite-status').getByText('Invited (2)')).toBeVisible({ timeout: LIVE });
  });

  await test.step('02 Xavi\'s bell rings without a reload; he accepts; the director\'s open page moves him into the members, live', async () => {
    await expect(bellCount(xaviPage), 'Xavi\'s bell').toBeVisible({ timeout: LIVE });
    await xaviPage.getByRole('button', { name: 'Notifications' }).click();
    const row = xaviPage.getByTestId('notification-row').filter({ hasText: podName }).first();
    await expect(row).toBeVisible({ timeout: LIVE });
    await expectNotReloaded(xaviPage, 'Xavi\'s page');
    await row.getByRole('button', { name: 'Accept' }).click();
    await expect.poll(async () => (await pool.query(
      `SELECT status FROM pod_members WHERE pod_id = $1 AND user_id = $2`, [podId, xavi.id])).rows[0]?.status, { timeout: LIVE }).toBe('active');
    await expect(page.locator('#pod-members').getByText(xavi.displayName), 'a member now, on the director\'s page').toBeVisible({ timeout: LIVE });
    await expect(page.getByTestId('invite-status').getByText('Invited (1)'), 'and out of Invited').toBeVisible({ timeout: LIVE });
    await expectNotReloaded(page, 'the director\'s pod page');
  });

  await test.step('03 a Video meeting from the pod: no round settings; Matching says it pairs nobody; Who can join is offered', async () => {
    await gotoRetry(page, `${APP}/sessions/new?podId=${podId}`);
    await expect(page.getByText(`In ${podName} · Reason Pod`)).toBeVisible({ timeout: SLOW });
    await expect(page.getByRole('radio', { name: /^Video meeting/ })).toBeChecked();
    await expect(page.getByLabel('Number of rounds')).toHaveCount(0);
    await expect(page.getByTestId('matching-section')).toContainText("Video meetings don't pair people.");
    await expect(page.getByTestId('event-access-field')).toBeVisible();
    await noSidewaysScroll(page, 'the event form');
  });

  await test.step('04 an empty title is said at the field; scheduled, the invite sheet opens on the pod: Invited, then Going', async () => {
    const title = page.getByLabel('Title', { exact: true });
    await title.fill('');
    await page.getByRole('button', { name: 'Schedule Event' }).click();
    await expect(page.getByText('Give your event a title')).toBeVisible();
    await title.fill(`${RUN} Pod meeting`);
    await page.getByRole('button', { name: 'Schedule Event' }).click();
    await page.waitForURL(/\/sessions\/[0-9a-f-]{36}\?invite=1$/, { timeout: 30_000 });
    eventId = new URL(page.url()).pathname.split('/').pop()!;
    made.sessions.push(eventId);
    expect((await api(dana, 'GET', `/sessions/${eventId}`)).json.data.format).toBe('video_meeting');
    const sheet = sheetOf(page, 'Invite people');
    await expect(sheet).toBeVisible({ timeout: SLOW });
    await expect(rowOf(sheet, xavi.id)).toBeVisible({ timeout: LIVE });
    await rowOf(sheet, xavi.id).click();
    await sheet.getByTestId('invite-send').click();
    await expect(rowOf(sheet, xavi.id)).toContainText('Invited', { timeout: LIVE });
    await sheet.getByRole('button', { name: 'Done' }).click();
    expect((await api(xavi, 'POST', `/sessions/${eventId}/register`)).status).toBeLessThan(300);
    await page.getByRole('button', { name: 'Invite people' }).click();
    await expect(rowOf(sheetOf(page, 'Invite people'), xavi.id), 'registered: Going').toContainText('Going', { timeout: LIVE });
    await sheetOf(page, 'Invite people').getByRole('button', { name: 'Done' }).click();
  });

  await test.step('05 both enter the meeting: two tiles, each wholly in the window, laid out for two (a real room)', async () => {
    if (skipStep(!ROOMS, ROOM_SKIP)) return;
    // Each side's room logs (LiveKit at debug), so a room that never lists the other person says why (preview, 2 Nov).
    const enter = async (u: TestUser, who: string) => {
      const o = await openAs(browser, u, '');
      await roomLogsAtDebug(o.ctx);
      const room = watchRoom(o.page, who);
      await gotoRetry(o.page, `${APP}/session/${eventId}/live`);
      return { page: o.page, room };
    };
    const { page: dir, room: dirRoom } = await enter(dana, 'Dana');
    const { page: guest, room: guestRoom } = await enter(xavi, 'Xavi');
    const reports = async () => `${await dirRoom.report()}\n${await guestRoom.report()}`;
    await dir.getByRole('button', { name: /Start meeting/ }).click({ timeout: SLOW });
    for (const [p, who] of [[dir, 'Dana'], [guest, 'Xavi']] as const) {
      const self = p.locator('[data-testid="meeting-tile"][data-self="true"]');
      const other = p.locator('[data-testid="meeting-tile"]:not([data-self="true"])');
      await expect(other, `${who}: one other person`).toHaveCount(1, { timeout: 90_000 }).catch(async (e: Error) => {
        await shot(p, `c-meeting-missing-${who}`);
        throw new Error(`${e.message}\n${await reports()}`);
      });
      const vp = p.viewportSize()!;
      for (const [tile, what] of [[self, 'own tile'], [other.first(), 'the other person']] as const) {
        const box = (await tile.boundingBox())!;
        expect(box.y + box.height, `${who}: ${what} above the window's foot`).toBeLessThanOrEqual(vp.height + 1);
        expect(box.x + box.width, `${who}: ${what} inside the window`).toBeLessThanOrEqual(vp.width + 1);
      }
      const layout = await p.locator('[data-layout]').first().getAttribute('data-layout');
      expect(layout, `${who}: a two-person layout`).toBe(RUN_WIDTH >= 1024 && vp.width > vp.height ? 'side' : 'pair');
      await shot(p, `c-meeting-${who}`);
    }
  });
});
