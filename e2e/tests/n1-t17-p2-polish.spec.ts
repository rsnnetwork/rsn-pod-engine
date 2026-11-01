import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession } from '../helpers/api';
import { APP, gotoRetry, cleanup, idsOf, teardown } from '../helpers/live-ui';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─── T17: P2 polish on production's own client (1 Nov 2026) ──────────────────────────────────────────
//
// One walk through the items production's screens still show:
//   2   the Pods page does not scroll sideways at 360 with a 60-character unbroken pod name
//   9   a person the event is closed to gets one final sentence, never "Reconnecting…" or the library's text
//   10  a removed member who reloads the live page never sees the top bar: a final screen, then nothing else
//   11  the bell says "No longer available" for a meeting request that is gone, and keeps Accept on a live one
//   12  the admin email page names the meeting request, accepted and reminder templates
//   13  Remind all with nothing to send says "No reminders were sent." and why
// Item 8 (the room no longer reconnects once a second) is a unit pin: it needs a LiveKit server to see.
//
// Headed, throwaway accounts only, deleted by id. E2E_ENGINE=webkit and E2E_DEVICE="iPhone 14" pick the engine.

const NAME_60 = 'ABCDEFGHIJ'.repeat(6);
const SHOTS = process.env.E2E_SHOTS_DIR;

let browser: Browser;
let director: TestUser;
let kicked: TestUser;
let outsider: TestUser;
let recipient: TestUser;
let sender: TestUser;
let goneSender: TestUser;
let closedPair: TestUser;
let podId: string;
let sessionId: string;
const contexts: BrowserContext[] = [];
const requestIds: string[] = [];

async function open(user: TestUser, viewport?: { width: number; height: number }): Promise<Page> {
  const options = contextOptions();
  const ctx = await browser.newContext(viewport && !process.env.E2E_DEVICE ? { ...options, viewport } : options);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: user.accessToken, r: user.refreshToken });
  contexts.push(ctx);
  return ctx.newPage();
}

/** Remembers, from the first paint on, whether any of these words was ever on the page. */
async function watchFor(page: Page, words: string[]): Promise<void> {
  await page.addInitScript((list: string[]) => {
    const seen: Record<string, boolean> = {};
    (window as unknown as { __seen: Record<string, boolean> }).__seen = seen;
    const look = () => {
      const text = document.body ? document.body.innerText : '';
      const labels = Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')).join(' ');
      for (const w of list) if (text.includes(w) || labels.includes(w)) seen[w] = true;
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, characterData: true });
    window.setInterval(look, 50);
  }, words);
}

const seen = (page: Page, word: string) => page.evaluate((w) => !!(window as unknown as { __seen: Record<string, boolean> }).__seen?.[w], word);
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${engineLabel().replace('/', '-')}-${name}.png` }); };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = await launchBrowser();
  director = await createTestUser('t17dir', 'admin');
  kicked = await createTestUser('t17kick');
  outsider = await createTestUser('t17out');
  recipient = await createTestUser('t17rcv');
  sender = await createTestUser('t17snd');
  goneSender = await createTestUser('t17gone');
  closedPair = await createTestUser('t17closed');

  const pod = await createPod(director, NAME_60);
  podId = pod.id;
  await addPodMember(director, podId, kicked.id);
  const session = await createSession(director, podId, 'T17 polish event', new Date(Date.now() + 3 * 3600_000));
  sessionId = session.id;
  await registerForSession(kicked, sessionId);
  await pool.query(`UPDATE session_participants SET status = 'removed' WHERE session_id = $1 AND user_id = $2`, [sessionId, kicked.id]);

  // Two pending invites addressed to accounts that are closed: Remind all lists them, and never emails a closed
  // account, so a press has nobody to send to (and nothing is emailed from this spec, here or in production).
  await pool.query(`UPDATE users SET status = 'suspended' WHERE id = ANY($1)`, [[goneSender.id, closedPair.id]]);
  for (const closed of [goneSender, closedPair]) {
    await pool.query(
      `INSERT INTO invites (code, type, inviter_id, session_id, invitee_email, status, max_uses, use_count)
       VALUES ($1, 'session', $2, $3, $4, 'pending', 1, 0)`,
      [uuid().replace(/-/g, '').slice(0, 12), director.id, sessionId, closed.email],
    );
  }

  // Three meeting-request bell entries for the recipient: still waiting, withdrawn (no request row), sender's account closed.
  const waiting = uuid();
  const gone = uuid();
  const withdrawn = uuid();
  requestIds.push(waiting, gone);
  await pool.query(`INSERT INTO user_pokes (id, sender_id, recipient_id, status) VALUES ($1, $2, $3, 'pending'), ($4, $5, $3, 'pending')`,
    [waiting, sender.id, recipient.id, gone, goneSender.id]);
  for (const [id, title] of [[waiting, 'T17 waiting request'], [gone, 'T17 closed account request'], [withdrawn, 'T17 withdrawn request']]) {
    await pool.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1, 'poke', $2, 'wants to meet', $3)`,
      [recipient.id, title, `/messages?poke=${id}`]);
  }
});

test.afterAll(async () => {
  await teardown(
    async () => { for (const c of contexts) await c.close().catch(() => {}); },
    () => browser?.close(),
    () => pool.query(`DELETE FROM user_pokes WHERE id = ANY($1)`, [requestIds]),
    () => cleanup(pool, { ids: idsOf(director, kicked, outsider, recipient, sender, goneSender, closedPair), podId }),
  );
});

test(`[${engineLabel()}] item 2: the Pods page does not scroll sideways at 360 with a 60-character pod name`, async () => {
  const page = await open(director, { width: 360, height: 740 });
  await gotoRetry(page, `${APP}/pods`);
  const card = page.getByText(NAME_60).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  // The card fades in: WebKit measures it a frame early, so give the layout a moment to settle before judging it.
  await expect.poll(() => noSideScroll(page), { message: 'the page is no wider than the screen', timeout: 5_000 }).toBe(true);
  await page.waitForTimeout(1_000);
  expect(await noSideScroll(page), 'and it stays no wider').toBe(true);
  const box = (await card.boundingBox())!;
  expect(box.x + box.width, 'the name stays inside the screen').toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  await shot(page, 'pods-360');
});

test(`[${engineLabel()}] item 10: a removed member who reloads never sees the top bar, only the final sentence`, async () => {
  const page = await open(kicked);
  await watchFor(page, ['Leave Event', 'Participants', 'Joining room', 'T17 polish event']);
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await expect(page.getByText('You have been removed from this event.').first()).toBeVisible({ timeout: 30_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('You have been removed from this event.').first()).toBeVisible({ timeout: 30_000 });
  expect(await seen(page, 'Leave Event'), 'the Leave Event control was never drawn').toBe(false);
  expect(await seen(page, 'Participants'), 'the participants button was never drawn').toBe(false);
  expect(await seen(page, 'T17 polish event'), 'the event title bar was never drawn').toBe(false);
  await expect(page.getByRole('button', { name: /Back to events/i })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'removed');
});

test(`[${engineLabel()}] item 9: a person the event is closed to gets one final sentence, no Reconnecting and no library text`, async () => {
  const page = await open(outsider);
  await watchFor(page, ['Reconnecting', 'status code', 'Request failed']);
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  await expect(page.getByText('This event is not open to you.')).toBeVisible({ timeout: 4_000 });
  await page.waitForTimeout(1_500);
  expect(await seen(page, 'Reconnecting'), 'never showed Reconnecting').toBe(false);
  expect(await seen(page, 'status code'), 'never showed the library text').toBe(false);
  expect(await seen(page, 'Request failed'), 'never showed the library text').toBe(false);
  await expect(page.getByRole('button', { name: /Back to events/i })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'refused');
});

test(`[${engineLabel()}] item 11: the bell says No longer available for a gone request and keeps Accept on a live one`, async () => {
  const page = await open(recipient);
  await gotoRetry(page, `${APP}/`);
  await page.getByRole('button', { name: 'Notifications' }).click({ timeout: 30_000 });
  await expect(page.getByText('T17 waiting request')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('T17 closed account request')).toBeVisible();
  await expect(page.getByText('T17 withdrawn request')).toBeVisible();
  await expect(page.getByText('No longer available'), 'the withdrawn and the closed-account request').toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Accept' }), 'only the live request can be accepted').toHaveCount(1);
  await expect(page.getByText('Declined')).toHaveCount(0);
  await shot(page, 'bell');
});

test(`[${engineLabel()}] item 13: Remind all with nothing to send says so in a sentence, not as a success`, async () => {
  const page = await open(director);
  await gotoRetry(page, `${APP}/sessions/${sessionId}`);
  await page.getByRole('button', { name: /Pending Invites/ }).click({ timeout: 30_000 });
  await page.getByRole('button', { name: /Remind All \(2\)/ }).click({ timeout: 30_000 });
  const toast = page.getByText('No reminders were sent. Nobody is waiting for a reminder.');
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Reminders sent to/)).toHaveCount(0);
  await shot(page, 'remind-all');
});

test(`[${engineLabel()}] item 12: the admin email page names the three templates`, async () => {
  const page = await open(director);
  await gotoRetry(page, `${APP}/admin/email`);
  await expect(page.getByText('Meeting Reminder', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Meeting Request', { exact: true })).toBeVisible();
  await expect(page.getByText('Meeting Request Accepted', { exact: true })).toBeVisible();
  for (const raw of ['meeting_reminder', 'poke_request', 'poke_accepted']) {
    await expect(page.getByText(raw, { exact: true }), `${raw} is not shown raw`).toHaveCount(0);
  }
  await shot(page, 'admin-email');
});
