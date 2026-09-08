import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// W-meet (8 Sep 2026): a meeting on RSN is a real audio/video call the two
// people join on our own platform. This smoke covers, end to end against prod:
//   1. "Meet now" is disabled while the partner is offline.
//   2. Changing availability lights a dot on the partner's calendar icon,
//      which clears when they open the scheduler.
//   3. Confirming an AUDIO meeting pins a Join card (local time + duration) in
//      the chat for both people.
//   4. With both online, "Meet now" opens the call room for the caller AND
//      rings the partner (live banner + bell notification + system line).
//
// No LLM — safe across chromium / webkit / iOS. NOTE: actual two-way LiveKit
// audio/video MEDIA (camera/mic frames) cannot be asserted headlessly; this
// smoke proves the token mint, room mount, gating and ring rails. Ali verifies
// real A/V on a device.
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

/** Open the thread's meeting controls, coping with the mobile "More actions"
 *  collapse. Returns once the scheduler panel is on screen. */
async function openScheduler(page: Page) {
  const findTime = page.getByRole('button', { name: /Find a time to meet/i });
  const more = page.getByRole('button', { name: /More actions/i });
  await findTime.or(more).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (await more.isVisible().catch(() => false)) await more.click();
  await findTime.filter({ visible: true }).first().click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async () => {
  a = await createTestUser('mcalla');
  b = await createTestUser('mcallb');
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Meet Ana', a.id]);
  await pool.query(`UPDATE users SET display_name=$1 WHERE id=$2`, ['Meet Bo', b.id]);
  // Connect A + B once (poke → accept) so all tests share the conversation.
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
  test('1) Meet now is disabled while the partner is offline', async () => {
    test.setTimeout(90_000);
    const convId = await convBetween(a.id, b.id);
    expect(convId).toBeTruthy();

    // B has no browser open yet → offline. A opens the thread.
    const page = await openAs(a, `/messages/${convId}`);

    // The header presence indicator reads Offline (B has no live session).
    await expect(page.getByTestId('partner-presence')).toContainText(/Offline/i, { timeout: 25_000 });

    if (MOBILE) {
      await page.getByRole('button', { name: /More actions/i }).click();
      // The menu labels the call as offline and the item is disabled.
      const item = page.getByRole('button', { name: /Video call \(they are offline\)/i });
      await expect(item).toBeVisible({ timeout: 20_000 });
      await expect(item).toBeDisabled();
    } else {
      const vid = page.getByRole('button', { name: /Start a video call now/i });
      await expect(vid).toBeVisible({ timeout: 20_000 });
      await expect(vid).toBeDisabled();
    }
    await page.close();
  });

  test('2) Changing availability lights a dot on the partner\'s calendar, and it clears when opened', async () => {
    test.setTimeout(90_000);
    const convId = await convBetween(a.id, b.id);

    // A changes availability → stamps a fresh update time.
    const KEY = futureWindowKey(4, 'morning');
    expect((await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);

    // B opens the thread, having never opened the scheduler → dot should show.
    const page = await openAs(b, `/messages/${convId}`);
    // The dot is encoded in the control's accessible name.
    const dotted = MOBILE
      ? page.getByRole('button', { name: /More actions .*updated their availability/i })
      : page.getByRole('button', { name: /updated their availability/i });
    await expect(dotted).toBeVisible({ timeout: 25_000 });

    // Opening the scheduler marks it seen → the dot clears.
    await openScheduler(page);
    await expect(dotted).toHaveCount(0, { timeout: 15_000 });
    await page.close();
  });

  test('3) Confirming an audio meeting pins a Join card in the chat', async () => {
    test.setTimeout(120_000);
    const convId = await convBetween(a.id, b.id);

    // Both save the same window so it is a confirmable overlap.
    const KEY = futureWindowKey(5, 'afternoon');
    expect((await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);
    expect((await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);

    const page = await openAs(a, `/messages/${convId}`);
    await openScheduler(page);

    // Confirm the overlap → exact-time step → pick AUDIO → confirm.
    await page.getByRole('button', { name: /^Confirm .*(morning|afternoon|evening)/i }).first().click();
    await page.locator('input[type="time"]').fill('15:30');
    await page.getByRole('button', { name: /^Audio$/ }).click();
    await page.getByRole('button', { name: /Confirm meeting/i }).click();

    // The pinned thread card (visible to both) shows local time + Audio call + Join.
    const banner = page.getByTestId('thread-meeting-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner.getByText(/Audio call/i)).toBeVisible();
    await expect(banner.getByRole('button', { name: /^Join$/ })).toBeVisible();

    // A SCHEDULED meeting line in the thread offers "Join meeting" (enter the room).
    await expect(page.getByRole('button', { name: /Join meeting/i }).first()).toBeVisible({ timeout: 10_000 });

    // DB stored an absolute instant + the audio type.
    const row = (await pool.query<{ meeting_start_at: Date | null; meeting_type: string | null }>(
      `SELECT meeting_start_at, meeting_type FROM dm_conversations WHERE id=$1`, [convId],
    )).rows[0];
    expect(row.meeting_start_at, 'an exact instant is stored').toBeTruthy();
    expect(row.meeting_type).toBe('audio');
    await page.close();
  });

  test('4) With both online, Meet now opens the call and rings the partner', async () => {
    test.setTimeout(120_000);
    const convId = await convBetween(a.id, b.id);

    // B goes online (any authed page connects the socket into the user room).
    const bPage = await openAs(b, `/messages/${convId}`);
    await bPage.waitForTimeout(2500); // let the socket join user:<b>

    // A opens the thread; wait for presence to flip Meet-now to enabled.
    const aPage = await openAs(a, `/messages/${convId}`);

    // The header presence indicator reads Online once B is on the platform.
    await expect(aPage.getByTestId('partner-presence')).toContainText(/Online/i, { timeout: 35_000 });

    if (MOBILE) {
      // Poll the menu until the online label appears, then click it.
      await expect(async () => {
        await aPage.getByRole('button', { name: /More actions/i }).click();
        const online = aPage.getByRole('button', { name: /^Video call now$/ });
        await expect(online).toBeVisible({ timeout: 2000 });
        await expect(online).toBeEnabled();
      }).toPass({ timeout: 35_000 });
      await aPage.getByRole('button', { name: /^Video call now$/ }).click();
    } else {
      const vid = aPage.getByRole('button', { name: /Start a video call now/i });
      await expect(vid).toBeEnabled({ timeout: 35_000 });
      await vid.click();
    }

    // A lands in the call room (token minted, page mounted).
    await expect(aPage).toHaveURL(new RegExp(`/meet/${convId}`), { timeout: 20_000 });
    await expect(aPage.getByText(/^Video call$/)).toBeVisible({ timeout: 15_000 });

    // B is rung: the live incoming-call banner appears anywhere in the app.
    await expect(bPage.getByText(/is calling/i)).toBeVisible({ timeout: 20_000 });

    // An INSTANT call line in B's thread offers "Call back", NOT "Join meeting"
    // (there's no standing room to join — Ali, 8 Sep 2026). Scope to that exact
    // message row: the confirmed-meeting line elsewhere in the thread correctly
    // still shows "Join meeting".
    // Scope to the thread message row (data-message-id); the same text also
    // appears in the inbox preview on single-pane widths.
    const callRow = bPage.locator('[data-message-id]').filter({ hasText: /Started a video call/i });
    await expect(callRow.first()).toBeVisible({ timeout: 20_000 });
    await expect(callRow.getByRole('button', { name: /Call back/i }).first()).toBeVisible({ timeout: 10_000 });
    await expect(callRow.getByRole('button', { name: /Join meeting/i })).toHaveCount(0);

    // Durable rails: a bell notification for B and a system line in the thread.
    await expect.poll(async () => {
      const n = await pool.query(
        `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND type='incoming_call'`, [b.id],
      );
      return n.rows[0].c as number;
    }, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

    const msg = await pool.query(
      `SELECT COUNT(*)::int AS c FROM direct_messages WHERE conversation_id=$1 AND content ILIKE '%call%'`, [convId],
    );
    expect(msg.rows[0].c as number).toBeGreaterThanOrEqual(1);

    await aPage.close();
    await bPage.close();
  });

  test('5) a scheduled meeting opened early shows a countdown, with a join-now escape', async () => {
    test.setTimeout(90_000);
    const convId = await convBetween(a.id, b.id);
    // Test 3 confirmed a meeting several days out on this conversation, so
    // opening it now (scheduled=1) is well before the 5-minute early window.
    const page = await openAs(a, `/meet/${convId}?kind=video&scheduled=1`);
    await expect(page.getByText(/Your meeting starts in/i)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole('button', { name: /Join now anyway/i })).toBeVisible();

    // The escape hatch still lets them in.
    await page.getByRole('button', { name: /Join now anyway/i }).click();
    await expect(page.getByText(/^Video call$/)).toBeVisible({ timeout: 15_000 });
    await page.close();
  });

  test('6) once a meeting has ended, the card offers "Call now", not "Join"', async () => {
    test.setTimeout(90_000);
    const convId = await convBetween(a.id, b.id);
    // The API refuses to confirm a past time, so age the confirmed meeting
    // directly: 3h ago, 30 min long → well past the 30-min grace window.
    await pool.query(
      `UPDATE dm_conversations SET meeting_start_at = NOW() - INTERVAL '3 hours', meeting_duration_min = 30 WHERE id = $1`,
      [convId],
    );

    const page = await openAs(a, `/messages/${convId}`);
    // Pinned card shows the ended state + Call now.
    const pinned = page.getByTestId('thread-meeting-banner');
    await expect(pinned.getByText(/Meeting ended/i)).toBeVisible({ timeout: 25_000 });
    await expect(pinned.getByRole('button', { name: /Call now/i })).toBeVisible();

    // The confirmed-meeting message line now offers Call now, not Join.
    const confRow = page.locator('[data-message-id]').filter({ hasText: /Meeting confirmed/i });
    await expect(confRow.getByRole('button', { name: /Call now/i }).first()).toBeVisible({ timeout: 10_000 });
    await expect(confRow.getByRole('button', { name: /Join meeting/i })).toHaveCount(0);

    // A stale scheduled link lands on "ended", not an empty room.
    const meet = await openAs(a, `/meet/${convId}?kind=video&scheduled=1`);
    await expect(meet.getByText(/This meeting has ended/i)).toBeVisible({ timeout: 20_000 });

    await page.close();
    await meet.close();
  });
});
