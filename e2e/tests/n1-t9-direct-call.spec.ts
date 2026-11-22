import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { APP, SERVER, cleanup, gotoRetry, idsOf } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { contextOptions, engineLabel, pickEngine } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// A direct video call with a connection (1 Nov 2026, 30 Oct review item 4, L12), headed, two browsers.
//   1. A presses Video call on B's profile while B is on the People page. B's banner rings there ("{A} is calling
//      you", "15-min video call"); A's "Calling {B}…" card waits. B accepts; both land in the same /meet/<conv>.
//      With a real LiveKit (the preview, production) Leave then ends it for both.
//   2. The call is listed once under Events → Past, as a video call.
//   3. A third member who is no connection gets no Video call button, and the route refuses them in a sentence.
//   4. Ringing B once B has gone offline says "<B> isn't online right now. Send a message instead."
//   5. The banner and the Calling card fit, 44px, at 360/390/414/768/1024/1280/1440.
// E2E_WIDTH picks the flow's width (default 1280); E2E_ENGINE / E2E_DEVICE the engine and device. The camera is
// Chromium's fake one (global constraint 9). Real camera and microphone between two people: Ali's phone list.
// Throwaway members only, deleted by id.
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL = /^http:\/\/127\.0\.0\.1:/.test(APP);
const WIDTH = Number(process.env.E2E_WIDTH || 1280);
const SHOTS = process.env.E2E_SHOTS_DIR;
// Playwright's own --disable-features list, kept, plus the Windows capture path the fake camera needs.
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';
const OFFLINE = (name: string) => `${name} isn't online right now. Send a message instead.`;

let browser: Browser;
let a: TestUser | undefined, b: TestUser | undefined, c: TestUser | undefined;
let conv = '';
const contexts: BrowserContext[] = [];
// What each page's LiveKit room logged (fix round 2, 2 Nov 2026): when B is never told that A left, the failure says
// what each room heard, sent and was doing around the press. LiveKit logs at debug in this spec only.
const roomLog: string[] = [];
const ROOM_LINE = /dataReceived|participantDisconnected|participantConnected|disconnect|reconnect|resum|negotiat|abort|leave|connectionStateChanged|signal/i;

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const device = !!process.env.E2E_DEVICE;
  const ctx = await browser.newContext({
    ...contextOptions({ width: WIDTH, height: 900 }),
    ...(pickEngine() === chromium ? { permissions: ['camera', 'microphone'] } : {}),
    ...(device ? {} : { viewport: { width: WIDTH, height: 900 } }),
  });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  contexts.push(ctx);
  await ctx.addInitScript(() => {
    for (const name of ['livekit', 'livekit-room', 'livekit-engine', 'livekit-signal', 'livekit-participant']) localStorage.setItem(`loglevel:${name}`, 'DEBUG');
  });
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  const who = u.email.split('@')[0];
  page.on('console', (m) => {
    if (ROOM_LINE.test(m.text())) roomLog.push(`${new Date().toISOString().slice(11, 23)} ${who}: ${m.text().slice(0, 200)}`);
  });
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${engineLabel().replace(/\W+/g, '-')}-${WIDTH}-${name}.png` });
}

/** The box fits the window, is not under the edges, and each of its buttons is at least 44px tall. */
async function expectFits(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  const vw = page.viewportSize()!.width;
  const vh = page.viewportSize()!.height;
  expect(box, testId).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 0.5);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 0.5);
  for (const btn of await page.getByTestId(testId).getByRole('button').all()) {
    // 44px, read to the half pixel: the banner's entrance animation leaves a sub-pixel of scale behind.
    expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.beforeAll(async () => {
  const engine = pickEngine();
  browser = await engine.launch({
    headless: process.env.E2E_HEADED === '0',
    ...(engine === chromium ? {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
        `--disable-features=${PW_DISABLED},MediaFoundationD3D11VideoCapture`],
    } : {}),
  });
  a = await createTestUser('t9call-a');
  b = await createTestUser('t9call-b');
  c = await createTestUser('t9call-c');
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Callie Arendt', a.id]);
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Bo Brandt', b.id]);
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', ['Cy Stranger', c.id]);
  // A and B are connected: a meeting request, accepted. They have never held a meeting.
  const sent = await apiAs(a, 'POST', '/pokes', { recipientId: b.id, message: 'Coffee?' });
  expect(sent.status).toBe(201);
  expect((await apiAs(b, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
  const r = await pool.query<{ id: string; calls_unlocked_at: Date | null }>(
    'SELECT id, calls_unlocked_at FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)', [a.id, b.id]);
  conv = r.rows[0].id;
  expect(r.rows[0].calls_unlocked_at, 'no meeting held: calls are still "locked" in the 9 Sep sense').toBeNull();
  console.log(`[t9-direct-call] engine=${engineLabel()} width=${WIDTH} app=${APP} local=${LOCAL}`);
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser?.close().catch(() => {});
  await cleanup(pool, { ids: idsOf(a, b, c) });
  await pool.end().catch(() => {});
});

test.describe.serial('a direct video call with a connection', () => {
  let pageA: Page;
  let pageB: Page;

  test('A rings B from B\'s profile while B is on People; B accepts; both are in the same room', async () => {
    test.setTimeout(150_000);
    pageB = await openAs(b!, '/connections');
    await expect(pageB.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });
    pageA = await openAs(a!, `/people/${b!.id}`);
    const call = pageA.getByTestId('video-call-button');
    await expect(call).toBeVisible({ timeout: 30_000 });
    await expect(call).toHaveText('Video call');
    expect((await call.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await call.click();

    // The dialog: how long, 15 to start with, video only (no choice of Audio from a profile).
    // The dialog has no dialog role of its own (components/ui/Modal.tsx); it is found by its words.
    const dialog = pageA.locator('form').filter({ hasText: 'How long? (minutes)' });
    await expect(dialog.getByLabel('How long? (minutes)')).toHaveValue('15');
    await expect(dialog.getByRole('button', { name: 'Audio' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Send request' }).click();

    await expect(pageA.getByTestId('call-outgoing')).toContainText('Calling Bo Brandt…', { timeout: 15_000 });
    await expect(pageA.getByTestId('call-outgoing')).toContainText('15-min video call');
    const banner = pageB.getByTestId('call-incoming');
    await expect(banner).toContainText('Callie Arendt is calling you', { timeout: 15_000 });
    await expect(banner).toContainText('15-min video call');
    await expectFits(pageA, 'call-outgoing');
    await expectFits(pageB, 'call-incoming');
    await shot(pageA, 'a-calling');
    await shot(pageB, 'b-ringing-on-people');

    // Seven widths, both boxes, without letting the call lapse.
    if (!process.env.E2E_DEVICE) {
      for (const w of [360, 390, 414, 768, 1024, 1280, 1440]) {
        await pageA.setViewportSize({ width: w, height: 800 });
        await pageB.setViewportSize({ width: w, height: 800 });
        await expectFits(pageA, 'call-outgoing');
        await expectFits(pageB, 'call-incoming');
        if (SHOTS) {
          await pageA.screenshot({ path: `${SHOTS}/${engineLabel().replace(/\W+/g, '-')}-w${w}-a-calling.png` });
          await pageB.screenshot({ path: `${SHOTS}/${engineLabel().replace(/\W+/g, '-')}-w${w}-b-ringing.png` });
        }
      }
      await pageA.setViewportSize({ width: WIDTH, height: 900 });
      await pageB.setViewportSize({ width: WIDTH, height: 900 });
    }

    await banner.getByRole('button', { name: 'Accept' }).click();
    const room = new RegExp(`/meet/${conv}\\?kind=video`);
    await pageB.waitForURL(room, { timeout: 20_000 });
    await pageA.waitForURL(room, { timeout: 20_000 });
    await expect(pageA.getByTestId('call-outgoing')).toHaveCount(0);

    const rows = await pool.query<{ source: string; duration_min: number; confirmed_by: string; reminder_sent_at: Date | null }>(
      'SELECT source, duration_min, confirmed_by, reminder_sent_at FROM meetings WHERE conversation_id = $1', [conv]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ source: 'instant', duration_min: 15, confirmed_by: a!.id });
    expect(rows.rows[0].reminder_sent_at).not.toBeNull();
    const unlocked = await pool.query('SELECT calls_unlocked_at FROM dm_conversations WHERE id = $1', [conv]);
    expect(unlocked.rows[0].calls_unlocked_at, 'an answered call never unlocks the 9 Sep way').toBeNull();
  });

  test('Leave ends it for both (needs a real LiveKit room: the preview or production)', async () => {
    test.skip(LOCAL, 'The local API mocks LiveKit: the room never connects, so Leave is checked against the preview.');
    test.skip(pickEngine() !== chromium, "Playwright's WebKit on Windows has no WebRTC, so it cannot join a LiveKit room");
    // Leave fix (1 Nov 2026): both rooms must list each other first. The room's frame draws as soon as the token is
    // here, before LiveKit has connected, and a Leave pressed then is a leave the other room never saw arrive.
    const tiles = (p: Page) => p.locator('.lk-participant-tile');
    await expect(tiles(pageA)).toHaveCount(2, { timeout: 45_000 });
    await expect(tiles(pageB)).toHaveCount(2, { timeout: 45_000 });
    const pressedAt = new Date().toISOString().slice(11, 23);
    // 5 Nov 2026 (D56): leaving an answered call the other person was in asks how it went, as a booked meeting does.
    const call = await pool.query<{ id: string }>("SELECT id FROM meetings WHERE conversation_id = $1 AND source = 'instant'", [conv]);
    const asked = new RegExp(`/meetings/${call.rows[0].id}\\?feedback=1`);
    await pageA.getByRole('button', { name: 'Leave call and go back to chat' }).click();
    await pageA.waitForURL(asked, { timeout: 20_000 });
    await expect(pageA.getByRole('dialog', { name: 'How did your meeting with Bo Brandt go?' })).toBeVisible({ timeout: 15_000 });
    await shot(pageA, 'a-asked-how-it-went');
    await expect(pageB.getByTestId('partner-left')).toBeVisible({ timeout: 30_000 }).catch(async (e: Error) => {
      const fromPress = roomLog.filter((l) => l.slice(0, 12) >= pressedAt).slice(0, 120);
      throw new Error(`${e.message}\nB was never told. Pressed at ${pressedAt}; B is on ${pageB.url()} with ${await tiles(pageB).count()} tiles.\n`
        + `What the rooms logged from the press on:\n${fromPress.join('\n') || '(nothing)'}`);
    });
    await pageB.getByTestId('partner-left').getByRole('button', { name: 'Leave' }).click();
    await pageB.waitForURL(asked, { timeout: 20_000 });
    await expect(pageB.getByRole('dialog', { name: 'How did your meeting with Callie Arendt go?' })).toBeVisible({ timeout: 15_000 });
    await shot(pageB, 'b-asked-how-it-went');
  });

  test('the call is listed once under Events → Past, as a video call', async () => {
    // It ends 45 minutes after it was answered (15 minutes and the 30-minute grace); move it back so it is past now.
    await pool.query("UPDATE meetings SET start_at = NOW() - INTERVAL '2 hours' WHERE conversation_id = $1 AND source = 'instant'", [conv]);
    await gotoRetry(pageA, `${APP}/sessions`);
    await pageA.getByRole('button', { name: 'Past', exact: true }).click();
    const cards = pageA.locator('article[data-meeting-id]');
    await expect(cards.filter({ hasText: 'Video call with Bo Brandt' })).toHaveCount(1, { timeout: 20_000 });
    await expect(cards.filter({ hasText: 'Meeting with Bo Brandt' })).toHaveCount(0);
    await shot(pageA, 'a-events-past');
  });

  test('a member who is no connection gets no Video call button, and the route refuses them in a sentence', async () => {
    const pageC = await openAs(c!, `/people/${a!.id}`);
    await expect(pageC.getByText('Callie Arendt').first()).toBeVisible({ timeout: 30_000 });
    await expect(pageC.getByTestId('video-call-button')).toHaveCount(0);
    const refused = await apiAs(c!, 'POST', `/calls/user/${a!.id}`, {});
    expect(refused.status).toBe(403);
    expect(refused.json.error.message).toBe('You can call the people you are connected with. Send a meeting request first.');
    const made = await pool.query('SELECT 1 FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)', [a!.id, c!.id]);
    expect(made.rows, 'a refused stranger gets no conversation').toHaveLength(0);
    await shot(pageC, 'c-no-call-button');
  });

  test('ringing B once B has gone offline says the offline sentence', async () => {
    test.setTimeout(150_000);
    // B closes the app: the page unloads (which closes its socket in every engine) and the window goes. Fix round 2
    // (2 Nov 2026): Playwright's WebKit closed the context without B's socket going, so the server still read B as
    // online when A rang; the ring is now made once the server itself reads B as offline (at most about a minute, the
    // presence key's life), so the step tests the offline sentence and not how fast a browser hangs up.
    await pageB.goto('about:blank');
    await pageB.context().close();
    await expect.poll(async () => (await apiAs(a!, 'GET', `/dm/conversations/${conv}/partner-presence`)).json?.data?.online, {
      message: 'the server reads B as offline once B has closed the app', timeout: 90_000, intervals: [500, 1_000, 2_000],
    }).toBe(false);
    // The server's own refusal, in the plan's sentence.
    const refused = await apiAs(a!, 'POST', `/calls/user/${b!.id}`, { durationMin: 15 });
    expect(refused.status).toBe(409);
    expect(refused.json?.error?.message).toBe(OFFLINE('Bo Brandt'));
    // 11 Nov 2026 (Shirley Palmer's RSN 07): the profile's button follows B's presence; pressed while B is offline it
    // opens the sheet with Try again, Find a time and Send a message instead of ringing.
    await gotoRetry(pageA, `${APP}/people/${b!.id}`);
    await pageA.getByTestId('video-call-button').click();
    await expect(pageA.getByRole('dialog', { name: "Bo Brandt isn't on REASON right now." })).toBeVisible({ timeout: 15_000 });
    for (const name of ['Try again', 'Find a time', 'Send a message']) {
      await expect(pageA.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(pageA.getByTestId('call-outgoing')).toHaveCount(0);
    await shot(pageA, 'a-offline-sentence');
  });
});
