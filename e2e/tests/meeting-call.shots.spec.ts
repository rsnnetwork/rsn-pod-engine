import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser } from '../helpers/engine';
import fs from 'fs';
import path from 'path';

// Visual evidence for the meeting/call feature on prod (chromium), at desktop +
// phone widths. Order matters: shots that need a FUTURE meeting come before the
// one that holds the meeting (which unlocks calls and moves the time to "now").

const OUT = path.resolve(__dirname, '../shots/meeting');
let browser: Browser;
let a: TestUser, b: TestUser;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function pageAt(u: TestUser, p: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
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
function futureWindowKey(daysAhead = 3, daypart = 'afternoon'): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.toISOString().slice(0, 10)}:${daypart}`;
}
/** Server clock, not this PC's (a skewed local clock puts "now + 1 min" in the server's past). */
async function serverNowMs(): Promise<number> {
  return new Date((await pool.query<{ n: Date }>('SELECT NOW() AS n')).rows[0].n).getTime();
}
function dayKeyAt(ms: number, daypart = 'afternoon'): string {
  return `${new Date(ms).toISOString().slice(0, 10)}:${daypart}`;
}
async function convBetween(x: string, y: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`, [x, y],
  );
  return r.rows[0]?.id;
}

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  a = await createTestUser('shota');
  b = await createTestUser('shotb');
  await pool.query(`UPDATE users SET display_name=$1, job_title=$2, company=$3 WHERE id=$4`, ['Ana Rivera', 'Product Lead', 'Northwind', a.id]);
  await pool.query(`UPDATE users SET display_name=$1, job_title=$2, company=$3 WHERE id=$4`, ['Bo Meyer', 'Founder', 'Lumen', b.id]);
  const sent = await apiAs(a, 'POST', '/pokes', { recipientId: b.id, message: 'Coffee?' });
  const accepted = await apiAs(b, 'POST', `/pokes/${sent.json.data.id}/accept`);
  expect(accepted.status).toBe(200);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanup(pool, { ids: [a.id, b.id] });
  await cleanupByPrefix(pool, 'e2etest-shot');
  await pool.end().catch(() => {});
});

test('capture meeting + call UI', async () => {
  test.setTimeout(300_000);
  const convId = await convBetween(a.id, b.id);

  // A confirmed audio meeting 3 days out.
  const KEY = futureWindowKey(3, 'afternoon');
  await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] });
  await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] });
  const day = KEY.split(':')[0];
  await apiAs(a, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, {
    window: KEY, startAt: new Date(`${day}T15:30:00`).toISOString(), durationMin: 45, type: 'audio',
  });

  // 1) Desktop thread BEFORE the first meeting: pinned Join card, scheduler icon,
  //    and NO call buttons (calls are locked until they've met).
  const desk = await pageAt(a, `/messages/${convId}`, { width: 1280, height: 900 });
  await expect(desk.getByTestId('thread-meeting-banner')).toBeVisible({ timeout: 25_000 });
  await expect(desk.getByRole('button', { name: /Start a video call now/i })).toHaveCount(0);
  await desk.screenshot({ path: path.join(OUT, '01-desktop-thread-join-card-locked.png') });

  // 2) Scheduler panel with the confirmed meeting + "Add to calendar".
  await desk.getByRole('button', { name: /Find a time to meet/i }).first().click();
  await expect(desk.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
  await expect(desk.getByRole('button', { name: /Add to calendar/i })).toBeVisible({ timeout: 10_000 });
  await desk.screenshot({ path: path.join(OUT, '02-desktop-scheduler-add-to-calendar.png') });

  // 3) The call room, with the per-tile maximize control.
  const meet = await pageAt(a, `/meet/${convId}?kind=video`, { width: 1280, height: 900 });
  await expect(meet.getByText(/^Video call$/)).toBeVisible({ timeout: 20_000 });
  await meet.waitForTimeout(3000);
  await expect(meet.getByRole('button', { name: /Maximize this view/i }).first()).toBeVisible({ timeout: 15_000 });
  await meet.screenshot({ path: path.join(OUT, '03-desktop-call-room.png') });

  // 4) Scheduled meeting opened early → countdown (needs the FUTURE meeting).
  const wait = await pageAt(a, `/meet/${convId}?kind=video&scheduled=1`, { width: 1280, height: 900 });
  await expect(wait.getByText(/Your meeting starts in/i)).toBeVisible({ timeout: 25_000 });
  await wait.screenshot({ path: path.join(OUT, '04-scheduled-countdown.png') });

  // 5) Mobile 390 — thread with the Join card (locked: no call icons).
  const mob = await pageAt(a, `/messages/${convId}`, { width: 390, height: 844 });
  await expect(mob.getByTestId('thread-meeting-banner')).toBeVisible({ timeout: 25_000 });
  await mob.screenshot({ path: path.join(OUT, '05-mobile-thread-join-card.png') });

  // 6) Mobile availability dot — B changes availability, A sees the dot.
  await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY, futureWindowKey(8, 'evening')] });
  const mob2 = await pageAt(a, `/messages/${convId}`, { width: 390, height: 844 });
  await expect(mob2.getByRole('button', { name: /More actions .*updated their availability/i })).toBeVisible({ timeout: 25_000 });
  await mob2.screenshot({ path: path.join(OUT, '06-mobile-availability-dot.png') });

  // ── Hold the first meeting: confirm one starting now, both enter → calls unlock.
  const now = await serverNowMs();
  const TODAY = dayKeyAt(now);
  await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [TODAY] });
  await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [TODAY] });
  const confirmed = await apiAs(a, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, {
    window: TODAY, startAt: new Date(now + 2 * 60_000).toISOString(), durationMin: 30, type: 'video',
  });
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  await apiAs(a, 'POST', `/dm/conversations/${convId}/call-token`, { kind: 'video' });
  await apiAs(b, 'POST', `/dm/conversations/${convId}/call-token`, { kind: 'video' });
  expect((await apiAs(a, 'GET', `/dm/conversations/${convId}/scheduling`)).json.data.callsUnlocked).toBe(true);

  // 7) After the meeting: B online; A's thread shows call buttons, no scheduler.
  const bDesk = await pageAt(b, `/messages/${convId}`, { width: 1280, height: 900 });
  await bDesk.waitForTimeout(2500);
  const aDesk = await pageAt(a, `/messages/${convId}`, { width: 1280, height: 900 });
  await expect(aDesk.getByTestId('partner-presence')).toContainText(/Online/i, { timeout: 35_000 });
  await expect(aDesk.getByRole('button', { name: /Find a time to meet/i })).toHaveCount(0);
  await aDesk.screenshot({ path: path.join(OUT, '07-desktop-unlocked-call-buttons.png') });

  // 8) Request-a-call dialog: video/audio + typed minutes.
  const vid = aDesk.getByRole('button', { name: /Start a video call now/i });
  await expect(vid).toBeEnabled({ timeout: 35_000 });
  await vid.click();
  await aDesk.locator('#call-minutes').fill('15');
  await aDesk.screenshot({ path: path.join(OUT, '08-call-request-dialog.png') });

  // 9) Caller waiting; 10) callee rung with the length.
  await aDesk.getByRole('button', { name: /Send request/i }).click();
  await expect(aDesk.getByTestId('call-waiting')).toBeVisible({ timeout: 15_000 });
  await aDesk.screenshot({ path: path.join(OUT, '09-call-waiting.png') });
  await expect(bDesk.getByText(/wants to call/i)).toBeVisible({ timeout: 20_000 });
  await bDesk.screenshot({ path: path.join(OUT, '10-incoming-call-request.png') });
  await bDesk.getByRole('button', { name: /^Accept$/ }).click();
  await expect(bDesk).toHaveURL(new RegExp(`/meet/${convId}`), { timeout: 20_000 });

  // 11) Ended meeting (unlocked) → "Meeting ended · Call now".
  await pool.query(`UPDATE dm_conversations SET meeting_start_at = NOW() - INTERVAL '3 hours', meeting_duration_min = 30 WHERE id = $1`, [convId]);
  const ended = await pageAt(a, `/messages/${convId}`, { width: 1280, height: 900 });
  await expect(ended.getByTestId('thread-meeting-banner').getByText(/Meeting ended/i)).toBeVisible({ timeout: 25_000 });
  await ended.screenshot({ path: path.join(OUT, '11-meeting-ended-call-now.png') });

  // 12) Online dot in the conversation list.
  const aList = await pageAt(a, '/messages', { width: 1280, height: 900 });
  await expect(aList.getByLabel('Online').first()).toBeVisible({ timeout: 30_000 });
  await aList.screenshot({ path: path.join(OUT, '12-inbox-online-dot.png') });

  console.log('shots written to', OUT);
});
