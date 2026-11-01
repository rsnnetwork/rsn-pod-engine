import { test, expect, Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// MEETING REQUESTS, 30 Oct review (items 3.1–3.4, 4.1, 4.2). Stefan: "Text overlaps on the connection request card";
// "It looks like the sender wrote it ... keep the system text separate from the person's own message"; "The 'X'
// button is unclear"; "Once two people are connected, the bar should disappear"; "there should be a 'Message' button";
// "Rename 'Continue' to 'Message'".
//
// Real browsers, two throwaway members, A (who asks, with a note) and B (who is asked), and a stranger S:
//   * B's request card says "<A> wants to meet you", then A's note as a quote, then REASON's line in its own box; at
//     360, 390, 414, 768, 1024, 1280 and 1440px no two of its text boxes overlap, nothing scrolls sideways, and every
//     button is at least 44px; from 1024px the focused card the bell opens is checked the same way;
//   * on S's profile B presses Remove, reads "<S> is removed from your For You. You can undo this here.", and undoes it;
//     S, never met, has no Message button;
//   * B accepts on Messages while B's own tab shows A's profile and A's browser shows B's: both bars disappear without
//     a reload and a Message button appears on both;
//   * the thread opens with REASON's introduction card, worded for its reader, then A's note as A's own message; the
//     profile's Message opens that thread.
//
// It WRITES throwaway data (members whose address ends @rsn-e2e.invalid, a request, a conversation, bells) to whatever
// database the target server uses and removes it by id in afterAll. E2E_ENGINE=webkit for Safari's engine,
// E2E_DEVICE="iPhone 14" for the phone, E2E_HEADED=0 for headless, E2E_SHOTS_DIR to keep a screenshot of each width.
// ─────────────────────────────────────────────────────────────────────────────

const RUN = Date.now().toString(36);
const SHOTS = process.env.E2E_SHOTS_DIR || '';
const WIDTHS = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 900 },
  { width: 1440, height: 900 },
];
// A long name, role and company, and a note of several lines: the content the overlap needs.
const A_NAME = 'Ayla Montgomery-Featherstonehaugh de la Vega';
const NOTE = `I think we have a useful reason to speak. I am building tooling for founders and would like to compare notes on your first hires and what you would do differently. (${RUN})`;
const LINE_START = 'Ayla is looking to meet founders, and Bram is a Founder';

let browser: Browser;
let a: TestUser, b: TestUser, s: TestUser;
let pokeId = '';
const ctxs: BrowserContext[] = [];

async function member(label: string, name: string, extra: string, params: unknown[] = []): Promise<TestUser> {
  const u = await createTestUser(`t5-${label}`);
  const email = `e2etest-t5-${label}-${RUN}@rsn-e2e.invalid`;
  const [first, ...rest] = name.split(' ');
  await pool.query(
    `UPDATE users SET email = $1, display_name = $2, first_name = $3, last_name = $4${extra} WHERE id = $5`,
    [email, name, first, rest.join(' ') || first, u.id, ...params],
  );
  return { ...u, email, displayName: name };
}

async function apiAs(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function pageAt(u: TestUser, p: string, options: BrowserContextOptions): Promise<Page> {
  const ctx = await browser.newContext(options);
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
const atWidth = (w: { width: number; height: number }): BrowserContextOptions => ({ viewport: w, hasTouch: w.width < 1024 });

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}-${engineLabel().replace(/[^\w]+/g, '-')}.png`), fullPage: true });
}

async function noSidewaysScroll(page: Page, where: string) {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll, `${where}: nothing scrolls sideways`).toBeLessThanOrEqual(inner);
}

/** Every pair of the card's text boxes is apart, and every button is at least 44px tall. */
async function expectCardApart(page: Page, testId: string, where: string) {
  const card = page.getByTestId(testId).filter({ has: page.getByText(`${RUN})`) }).first();
  await expect(card, `${where}: the card`).toBeVisible();
  await expect(card.locator('[data-part="heading"]')).toHaveText('Ayla wants to meet you');
  await expect(card.locator('[data-part="note"]')).toContainText(`Ayla’s note`);
  await expect(card.locator('[data-part="note"] blockquote')).toContainText('I think we have a useful reason to speak.');
  await expect(card.getByTestId('reason-line')).toContainText('Why REASON suggested this');
  await expect(card.getByTestId('reason-line')).toContainText(LINE_START);
  await expect(card.locator('[data-part="note"]'), 'REASON\'s line is not in the note').not.toContainText('Why REASON');

  const boxes = await card.evaluate((el) => {
    const parts = [...el.querySelectorAll('[data-part], [data-testid="reason-line"], button, a')] as HTMLElement[];
    return parts.map((p) => {
      const r = p.getBoundingClientRect();
      return { name: p.dataset.part || p.dataset.testid || p.textContent?.trim().slice(0, 20) || p.tagName, x: r.x, y: r.y, w: r.width, h: r.height, tag: p.tagName, inside: p.parentElement?.closest('[data-part], [data-testid="reason-line"], a, button') !== null && p.parentElement?.closest('[data-part], [data-testid="reason-line"], a, button') !== el };
    });
  });
  // Boxes nested in another (the name inside its link, the quote inside the note) are measured as their outer box.
  const outer = boxes.filter((x) => !x.inside && x.w > 0 && x.h > 0);
  for (let i = 0; i < outer.length; i += 1) {
    for (let j = i + 1; j < outer.length; j += 1) {
      const p = outer[i], q = outer[j];
      const overlap = p.x < q.x + q.w - 0.5 && q.x < p.x + p.w - 0.5 && p.y < q.y + q.h - 0.5 && q.y < p.y + p.h - 0.5;
      expect(overlap, `${where}: "${p.name}" and "${q.name}" overlap`).toBe(false);
    }
  }
  for (const btn of boxes.filter((x) => x.tag === 'BUTTON' || x.tag === 'A')) {
    expect(btn.h, `${where}: "${btn.name}" is at least 44px tall`).toBeGreaterThanOrEqual(44);
  }
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  // A wants to meet founders; B is a Founder (so REASON has a line); S is a stranger to both.
  a = await member('a', A_NAME, `, who_i_want_to_meet = 'founders building software', job_title = 'Head of Partnerships and Founder Programmes', company = 'Featherstonehaugh Collective International'`);
  b = await member('b', 'Bram Okafor', `, job_title = 'Founder', professional_role = ARRAY['Founder']::text[], company = 'Harbor Labs'`);
  s = await member('s', 'Sana Lindqvist', `, job_title = 'Designer', company = 'Northwind'`);
  const sent = await apiAs(a, 'POST', `/matches/platform/${b.id}/interest`, { note: NOTE, format: 'video_20' });
  expect(sent.status, JSON.stringify(sent.json)).toBe(201);
  pokeId = sent.json.data.id;
  expect(sent.json.data.note).toBe(NOTE);
  expect(sent.json.data.reasonLine).toMatch(new RegExp(`^${LINE_START}`));
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
  const ids = [a, b, s].filter(Boolean).map((u) => u.id);
  if (ids.length) {
    await pool.query(`DELETE FROM person_responses WHERE user_id = ANY($1) OR target_user_id = ANY($1)`, [ids]).catch(() => {});
    await cleanup(pool, { ids });
  }
});

test('the request card keeps the note and REASON\'s line apart, and no two of its boxes overlap at any width', async () => {
  test.setTimeout(300_000);
  for (const w of WIDTHS) {
    const page = await pageAt(b, '/messages', atWidth(w));
    await expectCardApart(page, 'meeting-request', `list at ${w.width}px`);
    await noSidewaysScroll(page, `Messages at ${w.width}px`);
    await shot(page, `request-list-${w.width}`);
    if (w.width >= 1024) {
      await gotoRetry(page, `${APP}/messages?poke=${pokeId}`);
      await expectCardApart(page, 'focused-meeting-request', `focused at ${w.width}px`);
      await shot(page, `request-focused-${w.width}`);
    }
    await page.context().close();
  }
});

test('Remove on a profile says so in words, and can be undone; a stranger has no Message button', async () => {
  const page = await pageAt(b, `/people/${s.id}?from=For%20You`, contextOptions({ width: 390, height: 844 }));
  const bar = page.getByRole('region', { name: 'Your move' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Save' })).toHaveText(/Save/);
  await expect(bar.getByText('×')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Message' })).toHaveCount(0);
  await bar.getByRole('button', { name: 'Remove from For You' }).click();
  await expect(page.getByText('Sana is removed from your For You. You can undo this here.')).toBeVisible();
  const undo = bar.getByRole('button', { name: 'Put back in For You' });
  await expect(undo).toHaveText('Undo remove');
  await shot(page, 'remove-toast-390');
  await undo.click();
  await expect(bar.getByRole('button', { name: 'Remove from For You' })).toHaveText('Remove');
  expect((await pool.query(`SELECT 1 FROM person_responses WHERE user_id = $1 AND target_user_id = $2`, [b.id, s.id])).rowCount).toBe(0);
  await page.context().close();
});

test('B accepts: both profiles lose the bar without a reload, the thread opens with REASON\'s card then A\'s note, and Message opens it', async () => {
  test.setTimeout(180_000);
  const opts = contextOptions({ width: 1280, height: 900 });
  // A's browser on B's profile, and B's own tab on A's profile, both open before the accept.
  const aOnB = await pageAt(a, `/people/${b.id}?from=For%20You`, opts);
  const bOnA = await pageAt(b, `/people/${a.id}?from=For%20You`, opts);
  await expect(aOnB.getByRole('region', { name: 'Your move' }).getByRole('button', { name: 'Request sent' })).toBeVisible();
  // While A's request waits, B's bar answers it in place, with the request's own Accept and Decline (not Remove).
  const bBar = bOnA.getByRole('region', { name: 'Your move' });
  await expect(bBar.getByRole('button', { name: 'Accept' })).toBeVisible();
  await expect(bBar.getByRole('button', { name: 'Decline' })).toBeVisible();
  await expect(bBar.getByRole('button', { name: 'Remove from For You' })).toHaveCount(0);

  const messages = await pageAt(b, '/messages', opts);
  const card = messages.getByTestId('meeting-request').filter({ has: messages.getByText(`${RUN})`) });
  await card.getByRole('button', { name: 'Accept' }).click();
  await messages.waitForURL(/\/messages\/[0-9a-f-]{36}$/);
  const conversationId = messages.url().split('/').pop()!;

  // No reload on either profile: the bar leaves and the hero offers Message.
  for (const [page, who] of [[aOnB, 'A'], [bOnA, 'B']] as const) {
    await expect(page.getByRole('region', { name: 'Your move' }), `${who}'s profile drops the bar`).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'Message' }), `${who}'s profile offers Message`).toBeVisible();
    await expect(page.getByText(/You are connected\. Message (Bram|Ayla), meet, and record what came of it\./)).toBeVisible();
  }
  await shot(aOnB, 'connected-profile-1280');

  // The thread, as B reads it: REASON's card worded for B, with the line, then A's note as A's own message.
  const intro = messages.locator('[data-card="introduction"]');
  await expect(intro).toContainText('Ayla wanted to meet you. You accepted.');
  await expect(intro.getByTestId('reason-line')).toContainText(LINE_START);
  const note = messages.locator('[data-message-id]').filter({ hasText: 'I think we have a useful reason to speak.' });
  await expect(note).toHaveCount(1);
  const order = await messages.evaluate(() => {
    const all = [...document.querySelectorAll('[data-card="introduction"], [data-message-id]')];
    return all.map((el) => (el.matches('[data-card="introduction"]') ? 'card' : (el.textContent || '').includes('useful reason') ? 'note' : 'other'));
  });
  expect(order.indexOf('card')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('card')).toBeLessThan(order.indexOf('note'));
  await shot(messages, 'thread-recipient-1280');
  const rows = (await pool.query<{ kind: string; from_user_id: string; content: string }>(
    `SELECT kind, from_user_id, content FROM direct_messages WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId])).rows;
  expect(rows.map((r) => [r.kind, r.from_user_id])).toEqual([['system', a.id], ['user', a.id]]);
  expect(rows[1].content).toBe(NOTE);

  // A's Message opens that thread, and A reads the card in their own words.
  await aOnB.getByRole('link', { name: 'Message' }).click();
  await aOnB.waitForURL(new RegExp(`/messages/${conversationId}$`));
  await expect(aOnB.locator('[data-card="introduction"]')).toContainText('You asked to meet Bram. Bram accepted.');
  await shot(aOnB, 'thread-requester-1280');
});
