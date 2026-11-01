import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { cleanup, gotoRetry, idsOf, teardown, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';
import { untilSized } from '../helpers/window-size';

// ─────────────────────────────────────────────────────────────────────────────
// Feedback after meetings (30 Oct 2026, item 5c): "After a meeting ends, show a short prompt asking how it went and
// if there were any problems. Save the answers in the admin panel."
//   1. Both people are in the 1:1 room; each leaves and lands on the question (needs a real LiveKit server and
//      WebRTC: Chromium against the preview or production; locally the question is opened where the room sends them).
//   2. Before answering, the meeting's page shows "How did it go?". Ana answers Yes with no problems; Bo answers
//      Maybe with Connection and a line of text. The admin's /admin/feedback, open in a third browser, lists both
//      rows without a reload, each with the other person's answer beside it, and its CSV downloads.
//   3. A second press edits Ana's row instead of adding one, and the admin's row follows.
//   4. The card is gone for both once they have answered.
//   5. A member opening /admin/feedback is refused (the page and the API).
//   6. The sheet and the card at seven widths, and the admin page at 1280 and 360: no sideways scroll, Send in
//      reach, every chip 44px.
// Throwaway accounts only, deleted by id at the end.
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36).slice(-5);
const ANA = `Ana Fb${RUN}`;
const BO = `Bo Fb${RUN}`;
const MOBILE = !!process.env.E2E_DEVICE;
const LOCAL = /127\.0\.0\.1|localhost/.test(SERVER);
const SHOTS = process.env.E2E_SHOTS_DIR || path.resolve(__dirname, '../shots/n1-t8');
const WIDTHS = [360, 390, 414, 768, 1024, 1280, 1440];

let browser: Browser;
let ana: TestUser; let bo: TestUser; let adm: TestUser; let member: TestUser;
let convId = '';
let meetingId = '';
let spareMeetingId = '';
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, p: string, viewport = { width: 1280, height: 900 }, b: Browser = browser): Promise<Page> {
  const ctx = await b.newContext({ ...contextOptions(viewport), acceptDownloads: true });
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

const sheetOf = (page: Page, name: string) => page.getByRole('dialog', { name: `How did your meeting with ${name} go?` });
// No sideways scroll, measured once the window has a size: Windows WebKit now and then gives a window that reads 0 wide
// for a moment (helpers/window-size.ts), which would read as a page wider than its window.
async function noSideways(page: Page): Promise<boolean> {
  const read = await untilSized(page, () => page.evaluate(() => ({
    sized: document.readyState === 'complete' && window.innerWidth > 0 && window.innerHeight > 0,
    fits: document.documentElement.scrollWidth <= window.innerWidth,
  })));
  return !!read?.sized && read.fits;
}

async function answer(page: Page, partner: string, worth: 'Yes' | 'Maybe' | 'No', problems: string[] = [], text = '') {
  const sheet = sheetOf(page, partner);
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await sheet.getByRole('button', { name: worth, exact: true }).click();
  for (const p of problems) await sheet.getByRole('button', { name: p, exact: true }).click();
  if (text) await sheet.getByLabel('Anything you want to tell us (optional)').fill(text);
  await sheet.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(sheet).toHaveCount(0, { timeout: 15_000 });
}

async function insertMeeting(minutesAgo: number): Promise<string> {
  const [a, b] = [ana.id, bo.id].sort();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO meetings (conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, confirmed_by)
     VALUES ($1, $2, $3, NOW() - make_interval(mins => $4), 30, 'video', $2) RETURNING id`,
    [convId, a, b, minutesAgo],
  );
  return rows[0].id;
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  ana = await createTestUser(`t8ana${RUN}`);
  bo = await createTestUser(`t8bo${RUN}`);
  adm = await createTestUser(`t8adm${RUN}`, 'admin');
  member = await createTestUser(`t8mem${RUN}`);
  await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [ANA, ana.id]);
  await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [BO, bo.id]);
  const sent = await apiAs(ana, 'POST', '/pokes', { recipientId: bo.id, message: 'Coffee about feedback?' });
  expect(sent.status).toBe(201);
  expect((await apiAs(bo, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
  const conv = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [ana.id, bo.id]);
  convId = conv.rows[0].id;
  // Started 10 minutes ago: the question can be answered. A second, older one stays unanswered for the layout pass.
  meetingId = await insertMeeting(10);
  spareMeetingId = await insertMeeting(60 * 24);
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`[n1-t8] engine=${engineLabel()} app=${APP} local=${LOCAL}`);
});

test.afterAll(async () => {
  await teardown(
    async () => { for (const c of ctxs) await c.close().catch(() => {}); },
    () => browser?.close() ?? Promise.resolve(),
    () => cleanup(pool, { ids: idsOf(ana, bo, adm, member) }),
  );
});

test('1) leaving the 1:1 room after the other person was in it asks how it went', async () => {
  test.setTimeout(240_000);
  test.skip(process.env.E2E_ENGINE === 'webkit' || MOBILE, "Playwright's WebKit on Windows has no WebRTC, so it cannot join a LiveKit room");
  // A meeting the room knows as the conversation's own: booked through the scheduler two minutes ahead (the earliest
  // the server takes), then moved back to have started, so the question can be answered on the way out.
  const now = new Date((await pool.query<{ n: Date }>('SELECT NOW() AS n')).rows[0].n).getTime();
  const key = new Date(Math.ceil(now / 1_800_000) * 1_800_000).toISOString().replace('.000Z', 'Z');
  const spare = new Date(Math.ceil((now + 3_600_000) / 1_800_000) * 1_800_000).toISOString().replace('.000Z', 'Z');
  for (const u of [ana, bo]) expect((await apiAs(u, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [key, spare] })).status).toBe(200);
  const booked = await apiAs(ana, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, {
    window: key, startAt: new Date(now + 2 * 60_000).toISOString(), durationMin: 30, type: 'video',
  });
  expect(booked.status).toBe(200);
  const roomMeeting = (await apiAs(ana, 'GET', `/dm/conversations/${convId}/scheduling`)).json.data.confirmed.meetingId as string;
  // One statement, so the meeting and its conversation get the very same instant. The server names a conversation's
  // meeting only while the two starts are equal (services/meetings/current-meeting.ts); two UPDATEs run as two
  // transactions, each with its own NOW(), so the room read no meeting id and leaving went to the chat (fix round 1).
  await pool.query(
    `WITH moved AS (UPDATE meetings SET start_at = NOW() - INTERVAL '1 minute' WHERE id = $1 RETURNING start_at)
     UPDATE dm_conversations SET meeting_start_at = (SELECT start_at FROM moved) WHERE id = $2`,
    [roomMeeting, convId],
  );
  // The room learns the meeting from this read: it must still name the meeting after the move.
  const moved = await apiAs(ana, 'GET', `/dm/conversations/${convId}/scheduling`);
  expect(moved.json.data.confirmed?.meetingId, 'the room can still see the meeting it is in').toBe(roomMeeting);
  // Only the room itself needs a real LiveKit server: the local API only mocks one (tests 2 to 6 open the question
  // where the room sends people).
  test.skip(LOCAL, 'needs a real LiveKit server; the local API only mocks one');

  const media = await chromium.launch({
    headless: process.env.E2E_HEADED === '0',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=MediaFoundationD3D11VideoCapture'],
  });
  try {
    const enter = (u: TestUser) => openAs(u, `/meet/${convId}?scheduled=1&kind=video`, { width: 390, height: 844 }, media);
    const anaRoom = await enter(ana);
    const boRoom = await enter(bo);
    const tiles = (p: Page) => p.locator('.lk-participant-tile');
    await expect(tiles(anaRoom)).toHaveCount(2, { timeout: 45_000 });
    await expect(tiles(boRoom)).toHaveCount(2, { timeout: 45_000 });

    await anaRoom.getByRole('button', { name: 'Leave call and go back to chat' }).click();
    await expect(anaRoom).toHaveURL(new RegExp(`/meetings/${roomMeeting}\\?feedback=1`), { timeout: 15_000 });
    await expect(sheetOf(anaRoom, BO)).toBeVisible({ timeout: 20_000 });
    // Bo stays in the room after Ana has gone, past the notice's 5 s grace, and is never asked anything while he
    // does. (The "{name} left the call" notice itself is meeting-call.spec.ts test 9's; its Leave calls the same
    // leave as the button below, pinned in server/src/__tests__/client/meeting-feedback-ui.test.ts.)
    await boRoom.waitForTimeout(8_000);
    await expect(boRoom).toHaveURL(new RegExp(`/meet/${convId}`));
    await expect(sheetOf(boRoom, ANA)).toHaveCount(0);
    await boRoom.getByRole('button', { name: 'Leave call and go back to chat' }).click();
    await expect(boRoom).toHaveURL(new RegExp(`/meetings/${roomMeeting}\\?feedback=1`), { timeout: 15_000 });
    await expect(sheetOf(boRoom, ANA)).toBeVisible({ timeout: 20_000 });
    meetingId = roomMeeting;
  } finally {
    await media.close().catch(() => {});
  }
});

test('2) both answer, and the admin page lists both rows without a reload', async () => {
  test.setTimeout(180_000);
  const adminPage = await openAs(adm, '/admin/feedback');
  await expect(adminPage.getByRole('heading', { name: 'Meeting feedback' })).toBeVisible({ timeout: 30_000 });
  const ours = adminPage.getByTestId('feedback-row').filter({ hasText: ANA }).filter({ hasText: 'After a meeting' });
  await expect(ours).toHaveCount(0);

  // Before anyone answers, the meeting's page asks.
  const anaPage = await openAs(ana, `/meetings/${meetingId}`);
  await expect(anaPage.getByRole('heading', { name: 'How did it go?' })).toBeVisible({ timeout: 30_000 });
  await anaPage.getByRole('button', { name: 'Answer', exact: true }).click();
  await answer(anaPage, BO, 'Yes');
  await expect(anaPage.getByText('Thanks. Your feedback is saved.')).toBeVisible();

  const boPage = await openAs(bo, `/meetings/${meetingId}?feedback=1`);
  const boSheet = sheetOf(boPage, ANA);
  await expect(boSheet).toBeVisible({ timeout: 30_000 });
  await expect(boSheet.getByText('Only you and the REASON team see this.')).toBeVisible();
  // Behaviour offers the report; taking it off again hides it.
  await boSheet.getByRole('button', { name: 'Behaviour', exact: true }).click();
  await expect(boSheet.getByRole('button', { name: `You can also report ${ANA}.` })).toBeVisible();
  // The report opens for Ana; the sheet steps aside and comes back with Bo's picks when it closes.
  await boSheet.getByRole('button', { name: `You can also report ${ANA}.` }).click();
  await expect(boPage.getByRole('heading', { name: `Report ${ANA}` })).toBeVisible();
  await boPage.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(boSheet).toBeVisible();
  await expect(boSheet.getByRole('button', { name: 'Behaviour', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await boSheet.getByRole('button', { name: 'Behaviour', exact: true }).click();
  await expect(boSheet.getByRole('button', { name: `You can also report ${ANA}.` })).toHaveCount(0);
  await answer(boPage, ANA, 'Maybe', ['Connection'], 'The line dropped twice.');
  // The ?feedback=1 is taken off once answered, so a reload does not ask again.
  await expect(boPage).toHaveURL(new RegExp(`/meetings/${meetingId}$`));

  // The admin's open page, never reloaded: two rows, one from each of them (each row names both people).
  await expect(ours).toHaveCount(2, { timeout: 20_000 });
  const boRow = adminPage.getByTestId('feedback-row').filter({ hasText: 'The line dropped twice.' });
  await expect(boRow).toContainText('Maybe');
  await expect(boRow).toContainText('Connection');
  await expect(boRow).toContainText(`${ANA} said: Yes · None`);
  await expect(boRow.getByRole('link', { name: BO })).toHaveAttribute('href', `/admin/users/${bo.id}`);

  // Only with problems keeps Bo's answer and drops Ana's.
  await adminPage.getByRole('button', { name: 'Only with problems' }).click();
  await expect(adminPage.getByTestId('feedback-row').filter({ hasText: 'The line dropped twice.' })).toHaveCount(1, { timeout: 15_000 });
  await expect(adminPage.getByTestId('feedback-row').filter({ hasText: ANA }).filter({ hasText: `${BO} said: Maybe` })).toHaveCount(0);
  await adminPage.getByRole('button', { name: 'Only with problems' }).click();

  // The CSV downloads, and the download is in the audit log.
  const [download] = await Promise.all([adminPage.waitForEvent('download'), adminPage.getByRole('button', { name: 'Download CSV' }).click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  expect(csv.split('\r\n')[0]).toMatch(/^answered_at,source,meeting_id,/);
  expect(csv).toContain('The line dropped twice.');
  const audit = await pool.query(`SELECT 1 FROM audit_log WHERE actor_id = $1 AND action = 'admin.feedback_csv_download'`, [adm.id]);
  expect(audit.rows).toHaveLength(1);
  await adminPage.screenshot({ path: path.join(SHOTS, `admin-1280-${engineLabel().replace(/\W+/g, '-')}.png`), fullPage: true });
});

test('3) a second press edits the same row, and the admin row follows', async () => {
  test.setTimeout(120_000);
  const adminPage = await openAs(adm, '/admin/feedback');
  const anaRow = adminPage.getByTestId('feedback-row').filter({ hasText: `${BO} said: Maybe` });
  await expect(anaRow).toContainText('Yes', { timeout: 30_000 });

  const anaPage = await openAs(ana, `/meetings/${meetingId}?feedback=1`);
  const sheet = sheetOf(anaPage, BO);
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  // It opens on Ana's own answer.
  await expect(sheet.getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await answer(anaPage, BO, 'No', ['Audio']);

  const stored = await pool.query<{ worth_continuing: string; problems: string[] }>(
    `SELECT worth_continuing, problems FROM meeting_outcomes WHERE user_id = $1 AND meeting_id = $2`, [ana.id, meetingId]);
  expect(stored.rows).toEqual([{ worth_continuing: 'no', problems: ['audio'] }]);
  await expect(anaRow).toContainText('Audio', { timeout: 20_000 });
  await expect(adminPage.getByTestId('feedback-row').filter({ hasText: `${BO} said: Maybe` })).toHaveCount(1);
});

test('4) the card is gone for both people once they have answered', async () => {
  for (const u of [ana, bo]) {
    const page = await openAs(u, `/meetings/${meetingId}`);
    await expect(page.getByRole('heading', { name: /^Meeting with / })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'How did it go?' })).toHaveCount(0);
    await page.close();
  }
});

test('5) a member opening /admin/feedback is refused', async () => {
  const page = await openAs(member, '/admin/feedback');
  await expect(page.getByRole('heading', { name: 'Admins only' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('feedback-row')).toHaveCount(0);
  expect((await apiAs(member, 'GET', '/admin/feedback')).status).toBe(403);
  expect((await apiAs(member, 'GET', '/admin/feedback.csv')).status).toBe(403);
});

test('6) the sheet and the card fit at every width; the admin page at 1280 and 360', async () => {
  test.setTimeout(300_000);
  const label = engineLabel().replace(/\W+/g, '-');
  const widths = MOBILE ? [0] : WIDTHS;
  for (const w of widths) {
    const viewport = { width: w || 390, height: w >= 768 ? 900 : 760 };
    const page = await openAs(ana, `/meetings/${spareMeetingId}`, viewport);
    const tag = MOBILE ? 'device' : String(w);
    const card = page.getByRole('heading', { name: 'How did it go?' });
    await expect(card).toBeVisible({ timeout: 30_000 });
    expect(await noSideways(page), `card ${tag}: sideways scroll`).toBe(true);
    // The first check after a page opens waits for its layout to settle (Windows WebKit once drew the page at a
    // passing size before the window had its own; the check passed again on its own run).
    await expect(async () => {
      await expectReachable(page, page.getByRole('button', { name: 'Answer', exact: true }), `card ${tag}: Answer`);
    }).toPass({ timeout: 10_000 });
    await page.screenshot({ path: path.join(SHOTS, `card-${tag}-${label}.png`) });

    await page.getByRole('button', { name: 'Answer', exact: true }).click();
    const sheet = sheetOf(page, BO);
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Behaviour', exact: true }).click();
    expect(await noSideways(page), `sheet ${tag}: sideways scroll`).toBe(true);
    const send = sheet.getByRole('button', { name: 'Send', exact: true });
    await expectReachable(page, send, `sheet ${tag}: Send`);
    await expectReachable(page, sheet.getByRole('button', { name: 'Skip', exact: true }), `sheet ${tag}: Skip`);
    for (const name of ['Yes', 'Maybe', 'No', 'Audio', 'Video', 'Connection', 'Behaviour', 'Other']) {
      const box = await sheet.getByRole('button', { name, exact: true }).boundingBox();
      expect(box!.height, `sheet ${tag}: ${name} is 44px tall`).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: path.join(SHOTS, `sheet-${tag}-${label}.png`) });
    // The text box is the last field: scrolled to, Send is still pinned in reach.
    await sheet.getByLabel('Anything you want to tell us (optional)').scrollIntoViewIfNeeded();
    await expectReachable(page, send, `sheet ${tag}: Send after scrolling`);
    await sheet.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    // Skip answers nothing: the card stays.
    await expect(card).toBeVisible();
    await page.context().close();
  }

  for (const w of MOBILE ? [0] : [1280, 360]) {
    const page = await openAs(adm, '/admin/feedback', { width: w || 390, height: 900 });
    await expect(page.getByTestId('feedback-row').first()).toBeVisible({ timeout: 30_000 });
    expect(await noSideways(page), `admin ${w}: sideways scroll`).toBe(true);
    await expect(async () => {
      await expectReachable(page, page.getByRole('button', { name: 'Only with problems' }), `admin ${w}: filter`);
    }).toPass({ timeout: 10_000 });
    await page.screenshot({ path: path.join(SHOTS, `admin-${MOBILE ? 'device' : w}-${label}.png`), fullPage: true });
    await page.context().close();
  }
});
