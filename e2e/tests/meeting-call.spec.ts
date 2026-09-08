import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Meetings + calls on RSN (8–9 Sep 2026), end to end against prod.
// Ali's model (9 Sep): accepted intro → chat + scheduler, calls LOCKED. Once a
// scheduled meeting has happened (both joined the room) → calls UNLOCK and the
// scheduler steps aside. Calls then go request → accept with a typed duration.
//   1. Locked state: scheduler offered, no call buttons, request API refused.
//   2. Availability dot lights for the partner, clears when opened.
//   3. Confirming an AUDIO meeting pins a Join card + universal "Add to calendar".
//   4. A scheduled meeting opened early shows a countdown (join-now escape).
//   5. Both attend → calls unlock → request (typed minutes) → accept → room.
//   6. A declined request is recorded and the caller is told.
//   7. Ended meeting → "Call now" (unlocked), stale link → "ended".
//   8. Presence: partner online → offline when they close the app.
// No LLM — safe across engines. Two-way LiveKit MEDIA is not asserted (no
// camera/mic headlessly); token mint, room mount, gating and rails are.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let a: TestUser, b: TestUser;
const MOBILE = !!process.env.E2E_DEVICE;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await browser.newContext(contextOptions({ width: 1200, height: 950 }));
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

function futureWindowKey(daysAhead = 3, daypart = 'afternoon'): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.toISOString().slice(0, 10)}:${daypart}`;
}

async function convBetween(x: string, y: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`,
    [x, y],
  );
  return r.rows[0]?.id;
}

/** Open the scheduler, coping with the mobile "More actions" collapse. */
async function openScheduler(page: Page) {
  const findTime = page.getByRole('button', { name: /Find a time to meet/i });
  const more = page.getByRole('button', { name: /More actions/i });
  await findTime.or(more).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (await more.isVisible().catch(() => false)) await more.click();
  await findTime.filter({ visible: true }).first().click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
}

/**
 * Hold a meeting: confirm one starting in a minute (inside its join window),
 * then both sides enter the room → the server unlocks calls for the pair.
 */
async function holdFirstMeeting(x: TestUser, y: TestUser, convId: string) {
  const KEY = futureWindowKey(0, 'afternoon');
  expect((await apiAs(x, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);
  expect((await apiAs(y, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);
  const startAt = new Date(Date.now() + 60_000).toISOString();
  const c = await apiAs(x, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, { window: KEY, startAt, durationMin: 30, type: 'video' });
  expect(c.status).toBe(200);
  // Both "attend" (a room token inside the window is attendance).
  expect((await apiAs(x, 'POST', `/dm/conversations/${convId}/call-token`, { kind: 'video' })).status).toBe(200);
  expect((await apiAs(y, 'POST', `/dm/conversations/${convId}/call-token`, { kind: 'video' })).status).toBe(200);
  const s = await apiAs(x, 'GET', `/dm/conversations/${convId}/scheduling`);
  expect(s.json.data.callsUnlocked, 'calls unlock once both have attended').toBe(true);
}

test.beforeAll(async () => {
  a = await createTestUser('mcalla');
  b = await createTestUser('mcallb');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Meet Ana', a.id]);
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Meet Bo', b.id]);
  const sent = await apiAs(a, 'POST', '/pokes', { recipientId: b.id, message: 'Coffee?' });
  expect(sent.status).toBe(201);
  const accepted = await apiAs(b, 'POST', `/pokes/${sent.json.data.id}/accept`);
  expect(accepted.status).toBe(200);
  console.log(`[meeting-call] engine=${engineLabel()} app=${APP} mobile=${MOBILE}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanup(pool, { ids: [a.id, b.id] });
  await cleanupByPrefix(pool, 'e2etest-mcall');
  await pool.end().catch(() => {});
});

test.describe.serial('meeting + call', () => {
  test('1) before the first meeting: the scheduler is offered, calls are not', async () => {
    test.setTimeout(90_000);
    const convId = await convBetween(a.id, b.id);
    expect(convId).toBeTruthy();

    const page = await openAs(a, `/messages/${convId}`);
    // B has no live session → Offline.
    await expect(page.getByTestId('partner-presence')).toContainText(/Offline/i, { timeout: 25_000 });

    if (MOBILE) {
      await page.getByRole('button', { name: /More actions/i }).click();
      await expect(page.getByRole('button', { name: /Find a time to meet/i })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: /Video call|Audio call/i })).toHaveCount(0);
    } else {
      await expect(page.getByRole('button', { name: /Find a time to meet/i })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: /Start a video call now|Start an audio call now/i })).toHaveCount(0);
    }
    // The server refuses a call request while locked, whatever the client shows.
    const r = await apiAs(a, 'POST', `/dm/conversations/${convId}/call/request`, { kind: 'video', durationMin: 15 });
    expect(r.status).toBe(403);
    await page.close();
  });

  test('2) changing availability lights a dot on the partner\'s calendar, and it clears when opened', async () => {
    test.setTimeout(90_000);
    const convId = await convBetween(a.id, b.id);
    const KEY = futureWindowKey(4, 'morning');
    expect((await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);

    const page = await openAs(b, `/messages/${convId}`);
    const dotted = MOBILE
      ? page.getByRole('button', { name: /More actions .*updated their availability/i })
      : page.getByRole('button', { name: /updated their availability/i });
    await expect(dotted).toBeVisible({ timeout: 25_000 });
    await openScheduler(page);
    await expect(dotted).toHaveCount(0, { timeout: 15_000 });
    await page.close();
  });

  test('3) confirming an audio meeting pins a Join card and a universal calendar invite', async () => {
    test.setTimeout(120_000);
    const convId = await convBetween(a.id, b.id);
    const KEY = futureWindowKey(5, 'afternoon');
    expect((await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);
    expect((await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);

    const page = await openAs(a, `/messages/${convId}`);
    await openScheduler(page);
    await page.getByRole('button', { name: /^Confirm .*(morning|afternoon|evening)/i }).first().click();
    await page.locator('input[type="time"]').fill('15:30');
    await page.getByRole('button', { name: /^Audio$/ }).click();
    await page.getByRole('button', { name: /Confirm meeting/i }).click();

    const banner = page.getByTestId('thread-meeting-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner.getByText(/Audio call/i)).toBeVisible();
    await expect(banner.getByRole('button', { name: /^Join$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Join meeting/i }).first()).toBeVisible({ timeout: 10_000 });

    // Universal calendar (Stefan, 9 Sep): "Add to calendar", never Google-only,
    // and the .ics endpoint serves a real invite.
    await expect(page.getByRole('button', { name: /Add to calendar/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Google Calendar/i)).toHaveCount(0);
    const icsRes = await fetch(`${SERVER}/api/dm/conversations/${convId}/meeting.ics`, {
      headers: { Authorization: `Bearer ${a.accessToken}` },
    });
    expect(icsRes.status).toBe(200);
    expect(icsRes.headers.get('content-type') || '').toMatch(/text\/calendar/);
    const ics = await icsRes.text();
    expect(ics).toMatch(/BEGIN:VCALENDAR/);
    expect(ics).toMatch(/METHOD:REQUEST/);
    expect(ics.replace(/\r\n /g, '')).toMatch(/ATTENDEE;.*RSVP=TRUE/);

    const row = (await pool.query<{ meeting_start_at: Date | null; meeting_type: string | null }>(
      `SELECT meeting_start_at, meeting_type FROM dm_conversations WHERE id=$1`, [convId],
    )).rows[0];
    expect(row.meeting_start_at).toBeTruthy();
    expect(row.meeting_type).toBe('audio');
    await page.close();
  });

  test('4) a scheduled meeting opened early shows a countdown, with a join-now escape', async () => {
    test.setTimeout(90_000);
    const convId = await convBetween(a.id, b.id);
    const page = await openAs(a, `/meet/${convId}?kind=video&scheduled=1`);
    await expect(page.getByText(/Your meeting starts in/i)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole('button', { name: /Join now anyway/i })).toBeVisible();
    await page.getByRole('button', { name: /Join now anyway/i }).click();
    await expect(page.getByText(/^Video call$/)).toBeVisible({ timeout: 15_000 });
    await page.close();
  });

  test('5) once both have attended a meeting, calls unlock: request (typed minutes) → accept → room', async () => {
    test.setTimeout(150_000);
    const convId = await convBetween(a.id, b.id);
    await holdFirstMeeting(a, b, convId);

    // B is on the platform.
    const bPage = await openAs(b, `/messages/${convId}`);
    await bPage.waitForTimeout(2500);

    // A's chat: the scheduler is gone, the call buttons are there.
    const aPage = await openAs(a, `/messages/${convId}`);
    await expect(aPage.getByTestId('partner-presence')).toContainText(/Online/i, { timeout: 35_000 });
    if (MOBILE) {
      await expect(async () => {
        await aPage.getByRole('button', { name: /More actions/i }).click();
        await expect(aPage.getByRole('button', { name: /Find a time to meet/i })).toHaveCount(0);
        const vid = aPage.getByRole('button', { name: /^Video call now$/ });
        await expect(vid).toBeVisible({ timeout: 2000 });
        await expect(vid).toBeEnabled();
      }).toPass({ timeout: 35_000 });
      await aPage.getByRole('button', { name: /^Video call now$/ }).click();
    } else {
      await expect(aPage.getByRole('button', { name: /Find a time to meet/i })).toHaveCount(0);
      const vid = aPage.getByRole('button', { name: /Start a video call now/i });
      await expect(vid).toBeEnabled({ timeout: 35_000 });
      await vid.click();
    }

    // Request dialog: type the length, send.
    await aPage.locator('#call-minutes').fill('15');
    await aPage.getByRole('button', { name: /Send request/i }).click();
    await expect(aPage.getByTestId('call-waiting')).toBeVisible({ timeout: 15_000 });
    await expect(aPage.getByTestId('call-waiting')).toContainText(/15-min video/i);

    // B is rung with the length, accepts → both enter the room.
    await expect(bPage.getByText(/wants to call/i)).toBeVisible({ timeout: 20_000 });
    await expect(bPage.getByText(/15-min video call/i)).toBeVisible();
    await bPage.getByRole('button', { name: /^Accept$/ }).click();
    await expect(bPage).toHaveURL(new RegExp(`/meet/${convId}`), { timeout: 20_000 });
    await expect(aPage).toHaveURL(new RegExp(`/meet/${convId}`), { timeout: 20_000 });

    const rq = (await pool.query<{ status: string; duration_min: number }>(
      `SELECT status, duration_min FROM call_requests WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1`, [convId],
    )).rows[0];
    expect(rq).toMatchObject({ status: 'accepted', duration_min: 15 });

    await aPage.close();
    await bPage.close();
  });

  test('6) a declined request is recorded and the caller is told', async () => {
    test.setTimeout(60_000);
    const convId = await convBetween(a.id, b.id);
    // B must be online for A to request; open a page for B.
    const bPage = await openAs(b, '/');
    await bPage.waitForTimeout(2500);
    const r = await apiAs(a, 'POST', `/dm/conversations/${convId}/call/request`, { kind: 'audio', durationMin: 10 });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ kind: 'audio', durationMin: 10, status: 'pending' });
    const d = await apiAs(b, 'POST', `/dm/call/requests/${r.json.data.id}/decline`);
    expect(d.status).toBe(200);
    const row = (await pool.query<{ status: string }>(`SELECT status FROM call_requests WHERE id=$1`, [r.json.data.id])).rows[0];
    expect(row.status).toBe('declined');
    // Accepting a declined request is refused.
    expect((await apiAs(b, 'POST', `/dm/call/requests/${r.json.data.id}/accept`)).status).toBe(409);
    await bPage.close();
  });

  test('7) once a meeting has ended, the card offers "Call now", and a stale link says ended', async () => {
    test.setTimeout(90_000);
    const convId = await convBetween(a.id, b.id);
    await pool.query(
      `UPDATE dm_conversations SET meeting_start_at = NOW() - INTERVAL '3 hours', meeting_duration_min = 30 WHERE id = $1`,
      [convId],
    );
    const page = await openAs(a, `/messages/${convId}`);
    const pinned = page.getByTestId('thread-meeting-banner');
    await expect(pinned.getByText(/Meeting ended/i)).toBeVisible({ timeout: 25_000 });
    await expect(pinned.getByRole('button', { name: /Call now/i })).toBeVisible();
    const confRow = page.locator('[data-message-id]').filter({ hasText: /Meeting confirmed/i });
    await expect(confRow.getByRole('button', { name: /Call now/i }).first()).toBeVisible({ timeout: 10_000 });
    await expect(confRow.getByRole('button', { name: /Join meeting/i })).toHaveCount(0);

    const meet = await openAs(a, `/meet/${convId}?kind=video&scheduled=1`);
    await expect(meet.getByText(/This meeting has ended/i)).toBeVisible({ timeout: 20_000 });
    await page.close();
    await meet.close();
  });

  test('8) inbox presence: a partner reads online, then offline when they close the app', async () => {
    test.setTimeout(120_000);
    const x = await createTestUser('mcallx');
    const y = await createTestUser('mcally');
    const sent = await apiAs(x, 'POST', '/pokes', { recipientId: y.id, message: 'hi' });
    await apiAs(y, 'POST', `/pokes/${sent.json.data.id}/accept`);
    const yPage = await openAs(y, '/');
    await yPage.waitForTimeout(2500);
    await expect.poll(async () => (await apiAs(x, 'GET', '/dm/presence')).json.data.online[y.id], { timeout: 35_000 }).toBe(true);
    await yPage.close();
    await expect.poll(async () => (await apiAs(x, 'GET', '/dm/presence')).json.data.online[y.id], { timeout: 30_000 }).toBe(false);
    await cleanup(pool, { ids: [x.id, y.id] });
  });
});
