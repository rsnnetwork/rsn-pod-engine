// ─── Chat in the meeting room, and Add to calendar that works (T7, 30 Oct review 5a + 5b) ─────────────────────
//
// Stefan, 30 Oct: "Add chat inside the meeting room. Right now people can't type to each other during a meeting." and
// "Add to calendar doesn't work. Users can't add the meeting to their own calendar (e.g. Google Calendar)."
//
// Two throwaway members in their 1:1 room /meet/<conversation> (fake camera):
//   - A opens Chat and writes; B's Chat button counts it and B reads it in the panel, live, without a reload;
//   - after leaving, the message is in both members' Messages thread;
//   - a block made during the call: A's next line is refused in the server's words and nothing is sent;
//   - the room with the panel open fits at 360, 390 and 1280 (and on an iPhone 14 with the text box focused).
// On the meeting page the calendar menu's Google and Outlook.com links carry the title, the UTC dates and details
// with the join link, and the .ics download starts, at seven widths. A meeting moved since its card was written
// still downloads its own file (the per-meeting route).
//
// Headed by default. E2E_ENGINE=webkit for Safari's engine, E2E_DEVICE="iPhone 14" for a phone. Throwaway users only
// (addresses that can never receive mail), deleted by id at the end. Not verifiable here: opening the downloaded
// .ics on a real iPhone (Ali's phone list).

import { test, expect, chromium, webkit, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'fs';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

const HEADLESS = process.env.E2E_HEADED === '0';
const ENGINE = process.env.E2E_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const DEVICE = process.env.E2E_DEVICE || '';
// Chromium >= 147 on Windows loses the fake camera through Media Foundation capture; Chromium honours only the last
// --disable-features switch, so Playwright's own defaults are repeated before the extra one.
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';
const RUN = Date.now().toString(36);
const MENU_WIDTHS = [360, 390, 414, 768, 1024, 1280, 1440];
const ROOM_WIDTHS = [360, 390, 1280];
const heightFor = (w: number) => (w < 768 ? 780 : w < 1280 ? 900 : 860);

let browser: Browser;
let ana: TestUser;
let bo: TestUser;
let convId = '';
let meetingId = '';
let slot = '';
const ctxs: BrowserContext[] = [];

async function member(label: string, name: string): Promise<TestUser> {
  const u = await createTestUser(`t7-${label}`);
  const email = `e2etest-t7-${label}-${RUN}@rsn-e2e.invalid`;
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
  const text = await res.text();
  let json: { data?: Record<string, unknown> } | null = null;
  try { json = JSON.parse(text); } catch { /* a calendar file */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function open(u: TestUser, path: string, width: number | null): Promise<Page> {
  const options = DEVICE
    ? { ...devices[DEVICE] }
    : { viewport: { width: width!, height: heightFor(width!) }, hasTouch: width! < 1024 };
  const ctx = await browser.newContext({
    ...options,
    acceptDownloads: true,
    ...(ENGINE === 'chromium' ? { permissions: ['camera', 'microphone'] } : {}),
  });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

async function noSidewaysScroll(page: Page, label: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `${label}: the page scrolls sideways by ${over}px`).toBeLessThanOrEqual(0);
}

/** 44px tall and wholly inside the window. */
async function reachable(page: Page, target: ReturnType<Page['locator']>, label: string) {
  await expect(target, `${label} is shown`).toBeVisible();
  const box = (await target.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.height, `${label} is 44px tall`).toBeGreaterThanOrEqual(43.5);
  expect(box.x, `${label} starts inside the window`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${label} ends inside the window`).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height, `${label} sits above the window's foot`).toBeLessThanOrEqual(vp.height + 1);
}

async function inRoom(page: Page) {
  await expect(page.getByText(/^Video call$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('call-chat-toggle')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = ENGINE === 'webkit'
    ? await webkit.launch({ headless: HEADLESS })
    : await chromium.launch({
      headless: HEADLESS,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
        `--disable-features=${PW_DISABLED},MediaFoundationD3D11VideoCapture`],
    });
  ana = await member('ana', `Ana T7 ${RUN}`);
  bo = await member('bo', `Bo T7 ${RUN}`);
  const asked = await api(ana, 'POST', '/pokes', { recipientId: bo.id, message: 'Coffee about your seed round?' });
  expect(asked.status, asked.text).toBeLessThan(300);
  const accepted = await api(bo, 'POST', `/pokes/${(asked.json!.data as { id: string }).id}/accept`);
  expect(accepted.status, accepted.text).toBeLessThan(300);
  convId = (await pool.query<{ id: string }>(
    'SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)',
    [ana.id, bo.id],
  )).rows[0].id;
  // A 45-minute video meeting three days out, on two shared times so the explicit confirm books it.
  const halfHour = 1_800_000;
  slot = new Date(Math.ceil((Date.now() + 3 * 86_400_000) / halfHour) * halfHour).toISOString().replace('.000Z', 'Z');
  const later = new Date(Date.parse(slot) + 2 * halfHour).toISOString().replace('.000Z', 'Z');
  for (const u of [ana, bo]) {
    const saved = await api(u, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [slot, later] });
    expect(saved.status, saved.text).toBe(200);
  }
  const booked = await api(ana, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, { window: slot, durationMin: 45, type: 'video' });
  expect(booked.status, booked.text).toBe(200);
  meetingId = (await pool.query<{ id: string }>('SELECT id FROM meetings WHERE conversation_id = $1', [convId])).rows[0].id;
});

test.afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.close().catch(() => {});
});

test.afterAll(async () => {
  await browser?.close().catch(() => {});
  const ids = [ana, bo].filter(Boolean).map((u) => u.id);
  if (ids.length) await pool.query('DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)', [ids]).catch(() => {});
  await cleanup(pool, { ids });
  await pool.end().catch(() => {});
});

test('A writes in the call; B\'s Chat button counts it and B reads it live; both have it in Messages afterwards', async () => {
  test.setTimeout(150_000);
  const width = DEVICE ? null : 1280;
  const a = await open(ana, `/meet/${convId}?kind=video`, width);
  const b = await open(bo, `/meet/${convId}?kind=video`, width);
  await inRoom(a);
  await inRoom(b);

  // Closed when the room opens, with nothing unread.
  await expect(a.getByTestId('call-chat-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(a.getByTestId('call-chat-panel')).toBeHidden();
  await expect(b.getByTestId('call-chat-unread')).toHaveCount(0);

  await a.getByTestId('call-chat-toggle').click();
  await expect(a.getByTestId('call-chat-toggle')).toHaveAttribute('aria-pressed', 'true');
  const panelA = a.getByTestId('call-chat-panel');
  await expect(panelA.getByRole('heading', { name: 'Chat' })).toBeVisible();
  await expect(panelA.getByText('Messages stay in your conversation.')).toBeVisible();
  const line = `Can you hear me? ${RUN}`;
  await panelA.getByLabel('Message').fill(line);
  await panelA.getByLabel('Message').press('Enter');
  await expect(panelA.getByText(line)).toBeVisible();
  await expect(panelA.getByLabel('Message')).toHaveValue('');

  // B, without a reload: the count rises, then the panel has the line under Ana's name.
  await expect(b.getByTestId('call-chat-unread')).toHaveText('1', { timeout: 20_000 });
  await b.getByTestId('call-chat-toggle').click();
  const panelB = b.getByTestId('call-chat-panel');
  await expect(panelB.getByText(line)).toBeVisible();
  await expect(panelB.getByText(ana.displayName).first()).toBeVisible();
  await expect(b.getByTestId('call-chat-unread')).toHaveCount(0);

  // Shift+Enter is a new line, Enter sends both lines as one message; A sees B's answer live.
  const answer = `Loud and clear ${RUN}`;
  await panelB.getByLabel('Message').fill('Yes!');
  await panelB.getByLabel('Message').press('Shift+Enter');
  await panelB.getByLabel('Message').pressSequentially(answer);
  await panelB.getByLabel('Message').press('Enter');
  await expect(panelA.getByText(answer)).toBeVisible({ timeout: 20_000 });

  // Leaving goes back to the conversation, where both lines are.
  for (const [page, who] of [[a, 'A'], [b, 'B']] as const) {
    await page.getByRole('button', { name: 'Leave call and go back to chat' }).click();
    await expect(page, `${who} is back in the conversation`).toHaveURL(new RegExp(`/messages/${convId}`));
    await expect(page.getByText(line), `${who} has A's line in Messages`).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(answer), `${who} has B's line in Messages`).toBeVisible();
  }
});

for (const width of DEVICE ? [null] : ROOM_WIDTHS) {
  const label = width ? `${width}px` : DEVICE;
  test(`the room with the chat open fits at ${label}`, async () => {
    test.setTimeout(90_000);
    const page = await open(ana, `/meet/${convId}?kind=video`, width);
    await inRoom(page);
    await reachable(page, page.getByTestId('call-chat-toggle'), 'Chat');
    await page.getByTestId('call-chat-toggle').click();
    const panel = page.getByTestId('call-chat-panel');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Message').focus();
    await reachable(page, panel.getByLabel('Message'), 'the text box');
    await reachable(page, panel.getByRole('button', { name: 'Send' }), 'Send');
    await reachable(page, panel.getByRole('button', { name: 'Close the chat' }), 'Close');
    await noSidewaysScroll(page, label);
    // The stage stays on screen above or beside the panel: the call keeps running.
    const stage = await page.locator('.lk-participant-tile').first().boundingBox();
    expect(stage && stage.height > 60, 'the video stays in view').toBeTruthy();
    await panel.getByRole('button', { name: 'Close the chat' }).click();
    await expect(panel).toBeHidden();
  });
}

test('a block made during the call: the next line is refused in the server\'s words and nothing is sent', async () => {
  test.setTimeout(90_000);
  const page = await open(ana, `/meet/${convId}?kind=video`, DEVICE ? null : 390);
  await inRoom(page);
  await page.getByTestId('call-chat-toggle').click();
  const panel = page.getByTestId('call-chat-panel');
  await expect(panel.getByText('Coffee about your seed round?')).toBeVisible({ timeout: 20_000 });
  const before = Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM direct_messages WHERE conversation_id = $1', [convId])).rows[0].n);

  const blocked = await api(bo, 'POST', `/users/${ana.id}/block`, {});
  expect(blocked.status, blocked.text).toBeLessThan(300);
  const refused = `Still there? ${RUN}`;
  await panel.getByLabel('Message').fill(refused);
  await panel.getByRole('button', { name: 'Send' }).click();
  const alert = panel.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await expect(alert).toHaveText(/no longer|cannot|can't/i);
  await expect(alert).not.toHaveText(/\b(403|Forbidden|Error)\b/);
  // What was typed is kept, and no message was written.
  await expect(panel.getByLabel('Message')).toHaveValue(refused);
  const after = Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM direct_messages WHERE conversation_id = $1', [convId])).rows[0].n);
  expect(after).toBe(before);
  await api(bo, 'DELETE', `/users/${ana.id}/block`);
});

for (const width of DEVICE ? [null] : MENU_WIDTHS) {
  const label = width ? `${width}px` : DEVICE;
  test(`the meeting page's Add to calendar menu at ${label}: Google, Outlook.com and the file`, async () => {
    test.setTimeout(90_000);
    const page = await open(ana, `/meetings/${meetingId}`, width);
    const button = page.getByRole('button', { name: 'Add to calendar' });
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
    const menu = page.getByTestId('add-to-calendar-menu');
    for (const id of ['calendar-google', 'calendar-outlook', 'calendar-ics']) await reachable(page, menu.getByTestId(id), id);
    await expect(menu.getByText("Already added from the email? You don't need to add it again.")).toBeVisible();
    await noSidewaysScroll(page, label);

    const join = `${APP}/meet/${convId}?scheduled=1&kind=video`;
    const start = new Date(slot);
    const end = new Date(start.getTime() + 45 * 60_000);
    const compact = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const google = new URL((await menu.getByTestId('calendar-google').getAttribute('href'))!);
    expect(google.origin + google.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(google.searchParams.get('text')).toBe(`Meeting with ${bo.displayName} on REASON`);
    expect(google.searchParams.get('dates')).toBe(`${compact(start)}/${compact(end)}`);
    expect(google.searchParams.get('details')).toBe(`Video call on REASON. Join: ${join}`);
    expect(google.searchParams.get('location')).toBe(join);
    const outlook = new URL((await menu.getByTestId('calendar-outlook').getAttribute('href'))!);
    expect(outlook.origin + outlook.pathname).toBe('https://outlook.live.com/calendar/0/deeplink/compose');
    expect(outlook.searchParams.get('subject')).toBe(`Meeting with ${bo.displayName} on REASON`);
    expect(outlook.searchParams.get('startdt')).toBe(start.toISOString().replace('.000Z', 'Z'));
    expect(outlook.searchParams.get('enddt')).toBe(end.toISOString().replace('.000Z', 'Z'));
    expect(outlook.searchParams.get('body')).toBe(`Video call on REASON. Join: ${join}`);
    for (const id of ['calendar-google', 'calendar-outlook']) {
      expect(await menu.getByTestId(id).getAttribute('target')).toBe('_blank');
      expect(await menu.getByTestId(id).getAttribute('rel')).toBe('noopener');
    }

    const download = page.waitForEvent('download');
    await menu.getByTestId('calendar-ics').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('reason-meeting.ics');
    const ics = fs.readFileSync((await file.path())!, 'utf8');
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain(`UID:meeting-${meetingId}@rsn.network`);
    expect(ics).toContain(`DTSTART:${compact(start)}`);
  });
}

test('a meeting moved since its card was written still downloads its own file, at its new time', async () => {
  const moveTo = new Date(Date.parse(slot) + 3_600_000);
  const moved = await api(ana, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, {
    window: moveTo.toISOString().replace('.000Z', 'Z'), durationMin: 45, type: 'video',
  });
  expect(moved.status, moved.text).toBe(200);
  const own = await api(bo, 'GET', `/meetings/${meetingId}/calendar.ics`);
  expect(own.status).toBe(200);
  expect(own.headers.get('content-disposition')).toBe('attachment; filename="reason-meeting.ics"');
  expect(own.text).toContain(`UID:meeting-${meetingId}@rsn.network`);
  expect(own.text).toContain(`DTSTART:${moveTo.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  expect(own.text).toContain('SEQUENCE:1');
  // Someone who is not one of the two cannot read it.
  const stranger = await member('stranger', `Stranger T7 ${RUN}`);
  try {
    expect((await api(stranger, 'GET', `/meetings/${meetingId}/calendar.ics`)).status).toBe(404);
  } finally {
    await cleanup(pool, { ids: [stranger.id] });
  }
});
