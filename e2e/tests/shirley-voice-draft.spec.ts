import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, wait, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { confirmInPage } from '../helpers/confirm-dialog';

// ─────────────────────────────────────────────────────────────────────────────
// Shirley Palmer's walkthrough, 11 Nov 2026 (RSN 01, P0; RSN 05 and 06, P1): a voice note recorded to one person and
// stopped without sending was still in the box when she opened another person. Acceptance: "Record a note to Person A,
// stop without sending, then open Person B. Person B must never see or receive the draft."
//
// Throwaway members (@rsn-e2e.invalid, no email): Shirley (the sender), Ana (A) and Ben (B), Shirley connected to both
// by an accepted request. Chromium's fake microphone (the flags the call specs use) records a tone.
//   1. Record to Ana, Stop: "Not sent" and a labelled "Send voice note". Open Ben from the list: Ben's box has no note,
//      no "Not sent", an empty text box; the server holds no voice message to Ben, and Ben's own thread has none.
//      Back to Ana (browser Back): the note is still there, Not sent (documented choice: kept in its own thread only).
//      An in-app deep link (as a bell click does) to Ben: still nothing there.
//   2. Recording to Ana, open Ben mid-recording: Ben's box shows no recording and no note; Ana's thread has the take,
//      stopped and Not sent, and the page said so.
//   3. Send voice note pressed twice: exactly one voice message, in Ana's conversation, none in Ben's; the bubble says
//      Sent. Cloudinary is stood in (page.route) so no file is stored; the server's own Cloudinary-host check still runs.
//   4. Reload with a note unsent: the browser asks first (beforeunload); after the reload the note is gone (documented:
//      a recording lives in the tab's memory only) and Ben still has nothing.
//   5. A refused microphone: a plain sentence, no recording bar.
//   6. At 360px: Stop, Discard and Send voice note are 44px and inside the screen; nothing scrolls sideways.
//   7. (fix round 1, I2) A voice note, a text and a picture each sent to Ana with the upload (or, for the text, the
//      post) held ~3 s, and Ben opened at once: Ana gets exactly one message, Ben nothing, Ben's box is empty, and Ana's
//      box afterwards holds no draft and sends nothing twice.
// Not covered here (Ali's phone list): the 60 s cap end to end (unit-tested with a fake clock), iOS Safari's recorder.
// ─────────────────────────────────────────────────────────────────────────────

const HEADLESS = process.env.E2E_HEADED === '0' || process.env.E2E_HEADED === undefined;
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';
const RUN = Date.now().toString(36);
const SHIRLEY_NAME = `Shirley Voice ${RUN}`;
const ANA_NAME = `Ana Voice ${RUN}`;
const BEN_NAME = `Ben Voice ${RUN}`;
const FAKE_UPLOAD = {
  secure_url: `https://res.cloudinary.com/demo/video/upload/v1/e2e-voice-${RUN}.webm`,
  duration: 2.4,
  bytes: 4096,
  format: 'webm',
};

let browser: Browser;
let shirley: TestUser, ana: TestUser, ben: TestUser;
let anaConv = '';
let benConv = '';
const ctxs: BrowserContext[] = [];
const pageErrors: string[] = [];

async function member(label: string, name: string): Promise<TestUser> {
  const u = await createTestUser(`voice-${label}`);
  const email = `e2etest-voice-${label}-${RUN}@rsn-e2e.invalid`;
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
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

async function connect(from: TestUser, to: TestUser): Promise<string> {
  const asked = await api(from, 'POST', '/pokes', { recipientId: to.id, message: `Hello ${RUN}` });
  expect(asked.status, JSON.stringify(asked.json)).toBe(201);
  const accepted = await api(to, 'POST', `/pokes/${asked.json.data.id}/accept`);
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
  const conv = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [from.id, to.id],
  );
  return conv.rows[0].id;
}

/** A 1x1 PNG, for the picture case. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/**
 * Shirley, signed in, at this width; Cloudinary's upload answered by a stand-in so nothing is stored there. `holdMs`
 * holds that answer (a picture or a voice note) and Shirley's own POST /dm/messages (a text) that long, so the member
 * can open another conversation while the send is on its way. `name` makes the stand-in's file address this run's own.
 */
async function shirleyAt(width: number, height: number, opts: { denyMic?: boolean; holdMs?: number; name?: string } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((t: { a: string; r: string; deny: boolean }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
    if (t.deny && navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    }
  }, { a: shirley.accessToken, r: shirley.refreshToken, deny: !!opts.denyMic });
  const hold = opts.holdMs ?? 0;
  const name = opts.name ?? `e2e-voice-${RUN}`;
  await ctx.route('https://api.cloudinary.com/**', async (route) => {
    if (hold) await wait(hold);
    const image = route.request().url().includes('/image/upload');
    const body = image
      ? { secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${name}.png`, width: 1, height: 1, bytes: PNG.length, format: 'png' }
      : { ...FAKE_UPLOAD, secure_url: `https://res.cloudinary.com/demo/video/upload/v1/${name}.webm` };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  if (hold) {
    await ctx.route(`${SERVER}/api/dm/messages`, async (route) => {
      if (route.request().method() === 'POST') await wait(hold);
      await route.continue();
    });
  }
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { if (!/ResizeObserver loop/.test(e.message)) pageErrors.push(e.message); });
  return page;
}

const voiceTo = async (conversationId: string) => (await pool.query<{ n: string }>(
  `SELECT COUNT(*)::text AS n FROM direct_messages WHERE conversation_id = $1 AND attachment_type = 'audio'`, [conversationId],
)).rows[0].n;
const voiceFromShirley = async () => (await pool.query<{ n: string }>(
  `SELECT COUNT(*)::text AS n FROM direct_messages WHERE from_user_id = $1 AND attachment_type = 'audio'`, [shirley.id],
)).rows[0].n;

const box = (page: Page) => page.getByRole('main');
const draftCard = (page: Page) => page.getByTestId('dm-voice-draft');

async function openThread(page: Page, conversationId: string) {
  await gotoRetry(page, `${APP}/messages/${conversationId}`);
  await expect(page.getByTestId('thread-partner-name')).toBeVisible({ timeout: 30_000 });
}

/** Record, wait, Stop: the preview card, Not sent. */
async function recordAndStop(page: Page, ms = 2_500) {
  await box(page).getByRole('button', { name: 'Record a voice note' }).click();
  await expect(page.getByTestId('dm-recording-bar')).toBeVisible({ timeout: 15_000 });
  await wait(ms);
  await page.getByTestId('dm-recording-stop').click();
  await expect(draftCard(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('dm-voice-draft-status')).toHaveText('Not sent');
}

/** Ben's box: no note, no recording, an empty text box. */
async function expectCleanBox(page: Page, what: string) {
  await expect(page.getByTestId('thread-partner-name'), `${what}: Ben's thread is open`).toHaveText(BEN_NAME, { timeout: 30_000 });
  await expect(draftCard(page), `${what}: no voice note in Ben's box`).toHaveCount(0);
  await expect(page.getByTestId('dm-recording-bar'), `${what}: no recording in Ben's box`).toHaveCount(0);
  await expect(box(page).getByText('Not sent'), `${what}: nothing says Not sent`).toHaveCount(0);
  await expect(box(page).getByRole('button', { name: 'Send voice note' }), `${what}: no Send voice note`).toHaveCount(0);
  await expect(box(page).locator('textarea'), `${what}: the text box is empty`).toHaveValue('');
}

/** What Ben himself can read of his conversation with Shirley. */
async function benSeesNoVoice() {
  const res = await api(ben, 'GET', `/dm/conversations/${benConv}/messages`);
  expect(res.status).toBe(200);
  const audio = (res.json.data as Array<{ attachmentType?: string | null }>).filter((m) => m.attachmentType === 'audio');
  expect(audio, 'Ben has received no voice message').toHaveLength(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      `--disable-features=${PW_DISABLED},MediaFoundationD3D11VideoCapture`],
  });
  shirley = await member('shirley', SHIRLEY_NAME);
  ana = await member('ana', ANA_NAME);
  ben = await member('ben', BEN_NAME);
  anaConv = await connect(shirley, ana);
  benConv = await connect(shirley, ben);
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch { /* already closed */ }
  await cleanup(pool, { ids: [shirley?.id, ana?.id, ben?.id].filter(Boolean) as string[] });
  const swept = await cleanupByPrefix(pool, 'e2etest-voice-');
  if (swept) console.log(`  swept ${swept} leftover voice-* account(s)`);
});

test('a note stopped to Ana is never in Ben\'s box, never sent to Ben, and is still in Ana\'s thread', async () => {
  test.setTimeout(240_000);
  const page = await shirleyAt(1280, 860);
  await openThread(page, anaConv);
  await expect(page.getByTestId('thread-partner-name')).toHaveText(ANA_NAME);
  await recordAndStop(page);
  await expect(draftCard(page)).toContainText(`Voice note to ${ANA_NAME}`);
  await expect(page.getByTestId('dm-voice-send')).toHaveText('Send voice note');
  await expect(page.getByTestId('dm-audio-preview')).toContainText(/0:00 \/ 0:0[1-4]/);

  // Open Ben from the conversation list (the sidebar, as Shirley did).
  await page.getByRole('link', { name: new RegExp(BEN_NAME) }).first().click();
  await expectCleanBox(page, 'sidebar');
  expect(await voiceTo(benConv), 'no voice message stored to Ben').toBe('0');
  expect(await voiceFromShirley(), 'no voice message stored at all').toBe('0');
  await benSeesNoVoice();

  // Back: Ana's thread, the note still there and still unsent.
  await page.goBack();
  await expect(page.getByTestId('thread-partner-name')).toHaveText(ANA_NAME, { timeout: 30_000 });
  await expect(page.getByTestId('dm-voice-draft-status')).toHaveText('Not sent');

  // Forward: Ben again, clean.
  await page.goForward();
  await expectCleanBox(page, 'forward');

  // An in-app deep link to Ben (what a bell or a notification click does): clean.
  await page.goBack();
  await expect(page.getByTestId('dm-voice-draft-status')).toHaveText('Not sent', { timeout: 30_000 });
  await page.evaluate((id) => { window.history.pushState({}, '', `/messages/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); }, benConv);
  await expectCleanBox(page, 'deep link');
  expect(await voiceTo(benConv)).toBe('0');

  // Clear it for the next test: back in Ana's thread, Discard. It always asks first (a destructive action).
  await page.goBack();
  await page.getByTestId('dm-voice-discard').click();
  await expect(page.getByTestId('confirm-dialog-confirm')).toBeVisible({ timeout: 10_000 });
  await confirmInPage(page);
  await expect(draftCard(page)).toHaveCount(0);
});

test('opening Ben while still recording to Ana: Ben\'s box is clean; Ana\'s thread keeps the take, stopped, Not sent', async () => {
  test.setTimeout(180_000);
  const page = await shirleyAt(1280, 860);
  await openThread(page, anaConv);
  await box(page).getByRole('button', { name: 'Record a voice note' }).click();
  await expect(page.getByTestId('dm-recording-bar')).toBeVisible({ timeout: 15_000 });
  await wait(2_000);
  await page.getByRole('link', { name: new RegExp(BEN_NAME) }).first().click();
  await expectCleanBox(page, 'mid-recording');
  await expect(page.getByText(new RegExp(`Your voice note to ${ANA_NAME} was stopped and kept`))).toBeVisible({ timeout: 10_000 });
  expect(await voiceTo(benConv)).toBe('0');

  await page.getByRole('link', { name: new RegExp(ANA_NAME) }).first().click();
  await expect(page.getByTestId('thread-partner-name')).toHaveText(ANA_NAME, { timeout: 30_000 });
  await expect(page.getByTestId('dm-voice-draft-status')).toHaveText('Not sent', { timeout: 15_000 });
});

test('Send voice note pressed twice makes one message, to Ana, and the bubble says Sent', async () => {
  test.setTimeout(180_000);
  const page = await shirleyAt(1280, 860);
  await openThread(page, anaConv);
  await recordAndStop(page);
  const send = page.getByTestId('dm-voice-send');
  await send.dblclick();
  await expect(page.getByText(`Voice note sent to ${ANA_NAME}.`)).toBeVisible({ timeout: 30_000 });
  await expect(draftCard(page)).toHaveCount(0, { timeout: 30_000 });
  await wait(3_000);
  expect(await voiceTo(anaConv), 'exactly one voice message in Ana\'s conversation').toBe('1');
  expect(await voiceTo(benConv), 'none in Ben\'s').toBe('0');
  const sent = page.locator('[data-testid^="dm-audio-message-"]');
  await expect(sent).toHaveCount(1, { timeout: 30_000 });
  await expect(sent).toContainText('Sent');
  await expect(sent).toContainText(/0:00 \/ 0:0[1-4]/);
  // Ana receives it; Ben does not.
  const anaSide = await api(ana, 'GET', `/dm/conversations/${anaConv}/messages`);
  expect((anaSide.json.data as Array<{ attachmentType?: string | null }>).filter((m) => m.attachmentType === 'audio')).toHaveLength(1);
  await benSeesNoVoice();
});

test('reloading with a note unsent asks first; after the reload the note is gone, and Ben still has nothing', async () => {
  test.setTimeout(180_000);
  const page = await shirleyAt(1280, 860);
  await openThread(page, anaConv);
  await recordAndStop(page);
  const asked: string[] = [];
  page.on('dialog', (d) => { asked.push(d.type()); d.accept().catch(() => {}); });
  await page.reload();
  expect(asked, 'the browser asked before leaving').toContain('beforeunload');
  await expect(page.getByTestId('thread-partner-name')).toHaveText(ANA_NAME, { timeout: 30_000 });
  await expect(draftCard(page)).toHaveCount(0);
  await page.getByRole('link', { name: new RegExp(BEN_NAME) }).first().click();
  await expectCleanBox(page, 'after reload');
  expect(await voiceTo(benConv)).toBe('0');
});

test('a refused microphone is said in plain words and no recording starts', async () => {
  test.setTimeout(120_000);
  const page = await shirleyAt(1280, 860, { denyMic: true });
  await openThread(page, anaConv);
  await box(page).getByRole('button', { name: 'Record a voice note' }).click();
  await expect(page.getByText(/can't use your microphone/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('dm-recording-bar')).toHaveCount(0);
  await expect(draftCard(page)).toHaveCount(0);
});

test('at 360px: Stop, Discard and Send voice note are 44px and on screen, nothing scrolls sideways; Ben stays clean', async () => {
  test.setTimeout(180_000);
  const page = await shirleyAt(360, 780);
  await openThread(page, anaConv);
  const fits = async (testId: string) => {
    const b = await page.getByTestId(testId).boundingBox();
    expect(b, `${testId} is on screen`).not.toBeNull();
    expect(b!.height, `${testId}: 44px`).toBeGreaterThanOrEqual(44);
    expect(b!.x, `${testId}: left edge`).toBeGreaterThanOrEqual(0);
    expect(b!.x + b!.width, `${testId}: right edge`).toBeLessThanOrEqual(360);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
  };
  await box(page).getByRole('button', { name: 'Record a voice note' }).click();
  await expect(page.getByTestId('dm-recording-bar')).toBeVisible({ timeout: 15_000 });
  await fits('dm-recording-stop');
  await wait(1_500);
  await page.getByTestId('dm-recording-stop').click();
  await expect(draftCard(page)).toBeVisible({ timeout: 15_000 });
  await fits('dm-voice-send');
  await fits('dm-voice-discard');
  // On a phone the list steps aside: Back to the inbox, then Ben.
  await page.getByRole('button', { name: 'Back to inbox' }).first().click();
  await page.getByRole('link', { name: new RegExp(BEN_NAME) }).first().click();
  await expectCleanBox(page, 'phone');
  expect(await voiceTo(benConv)).toBe('0');
  expect(pageErrors, 'no page errors').toEqual([]);
});

/** Everything Shirley has stored in a conversation. */
const storedIn = async (conversationId: string) => (await pool.query<{ content: string | null; attachment_type: string | null; attachment_url: string | null }>(
  `SELECT content, attachment_type, attachment_url FROM direct_messages WHERE conversation_id = $1 AND from_user_id = $2`, [conversationId, shirley.id],
)).rows;

for (const kind of ['voice note', 'text', 'picture'] as const) {
  test(`a ${kind} sent to Ana while its send is held 3 s, with Ben opened at once: Ana gets one, Ben nothing (I2)`, async () => {
    test.setTimeout(240_000);
    const name = `e2e-held-${kind.replace(' ', '-')}-${RUN}`;
    const page = await shirleyAt(1280, 860, { holdMs: 3_000, name });
    await openThread(page, anaConv);
    const anaBefore = await storedIn(anaConv);
    const benBefore = await storedIn(benConv);
    const words = `Held ${kind} ${RUN}`;

    if (kind === 'voice note') {
      await recordAndStop(page);
      await page.getByTestId('dm-voice-send').click();
      await expect(page.getByTestId('dm-voice-draft-status')).toHaveText(/Sending/, { timeout: 5_000 });
    } else if (kind === 'text') {
      await box(page).locator('textarea').fill(words);
      await box(page).getByRole('button', { name: 'Send message' }).click();
    } else {
      await page.getByTestId('dm-image-input').setInputFiles({ name: 'held.png', mimeType: 'image/png', buffer: PNG });
      await expect(box(page).locator('img[alt="Pending"]')).toBeVisible({ timeout: 10_000 });
      await box(page).getByRole('button', { name: 'Send message' }).click();
    }

    // Ben, at once, while the send is still held.
    await page.getByRole('link', { name: new RegExp(BEN_NAME) }).first().click();
    await expectCleanBox(page, `${kind} held`);
    await expect(box(page).locator('img[alt="Pending"]'), 'no picture waiting in Ben\'s box').toHaveCount(0);

    // Let it land, then read what was stored.
    await wait(8_000);
    const anaAfter = await storedIn(anaConv);
    const benAfter = await storedIn(benConv);
    expect(anaAfter.length - anaBefore.length, `exactly one new message to Ana (${kind})`).toBe(1);
    expect(benAfter.length - benBefore.length, `nothing new to Ben (${kind})`).toBe(0);
    const added = anaAfter.filter((m) => !anaBefore.some((b) => b.content === m.content && b.attachment_url === m.attachment_url));
    expect(added, `the new message to Ana (${kind})`).toHaveLength(1);
    if (kind === 'voice note') expect(added[0].attachment_type).toBe('audio');
    if (kind === 'text') expect(added[0].content).toBe(words);
    if (kind === 'picture') expect(added[0].attachment_type).toBe('image');
    expect(benAfter.some((m) => m.content === words || (m.attachment_url ?? '').includes(name)), 'Ben has none of it').toBe(false);
    await benSeesNoVoice();
    await expectCleanBox(page, `${kind} landed`);

    // Back in Ana's thread: nothing waiting, and nothing goes a second time.
    await page.getByRole('link', { name: new RegExp(ANA_NAME) }).first().click();
    await expect(page.getByTestId('thread-partner-name')).toHaveText(ANA_NAME, { timeout: 30_000 });
    await expect(draftCard(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(box(page).locator('textarea')).toHaveValue('', { timeout: 15_000 });
    await expect(box(page).getByRole('button', { name: 'Send message' }), 'an empty box cannot send').toBeDisabled();
    await wait(2_000);
    expect((await storedIn(anaConv)).length - anaBefore.length, `still exactly one (${kind})`).toBe(1);
  });
}
