import { test, expect, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';

// ─────────────────────────────────────────────────────────────────────────────
// INVITE PEOPLE FROM YOUR CONNECTIONS (POD-02 and the invites half of POD-04, 26 Oct 2026). Stefan, inviting to a
// pod on 25 Oct: "I may have 400 friends. I can't remember that he's called Claus." He typed an email. Claus closed
// the event's invite modal to see whether it had worked, because the result only showed on the page behind it.
//
// Real browsers, a director with 64 connections (seeded by SQL; the API makes one a minute at most):
//   * the pod page's "Invite members" opens the REASON sheet: 30 connections, "Show more" to 60 and then all 64;
//     "Cla" finds Claus and Clara; Member, Invited and Declined rows cannot be chosen;
//   * chosen people stay as chips while the search changes and fold into "+N"; the sticky "Send {n} invites" lies
//     inside the window; after sending, the rows say Invited in place and the sheet stays open until "Done";
//   * the always-visible Invitations card: the new invites appear without a reload, a decline made elsewhere moves
//     a person to Declined live, a reminder the local API cannot email says so in the server's words, Withdraw asks;
//   * the event page opens the sheet on ?invite=1, on "This pod (8)", where "Invite everyone in {pod} (7)" invites
//     the rest of the pod in one press, a Going guest cannot be chosen, "Invite by email" checks the address at the
//     field, and "Share a link" says the event's real cap (50) and makes a link that allows exactly that;
//   * at 360, 390, 414, 768, 1024, 1280 and 1440px: no sideways scroll, the footer button inside the window, every
//     control at least 44px, each row at least 56px, the chips folded into "+N".
//
// It WRITES throwaway data (members whose address ends @rsn-e2e.invalid, a pod, an event, invites, bells) to whatever
// database the target server is connected to and removes it by id in afterAll. E2E_ENGINE=webkit for Safari's
// engine, E2E_HEADED=0 for headless. Set E2E_SHOTS_DIR to keep a screenshot of every width.
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
const PHONE = { width: 390, height: 844 };
const PLACEHOLDER = 'Search by name, role or company';

// 61 people seeded by SQL. Nobody else's name, role or company holds "cla", so "Cla" finds exactly Claus and Clara.
const FIRST = ['Amara', 'Ben', 'Chiara', 'Dev', 'Elif', 'Femi', 'Greta', 'Hiro', 'Ines', 'Jonas', 'Kofi', 'Lucia', 'Mateo', 'Noor', 'Olu', 'Priya', 'Quinn', 'Rafa', 'Sana', 'Tomas'];
const LAST = ['Okafor', 'Lindqvist', 'Haddad'];
const TITLES = ['Founder', 'Product lead', 'Investor', 'Engineer', 'Designer'];
const FIRMS = ['Harbor Labs', 'Northwind', 'Atlas Works', 'Bright Ferry', 'Ostrava'];
const CLAUS = 'Claus Nygaard';
const CLARA = 'Clara Bennett';

let browser: Browser;
let director: TestUser, decliner: TestUser, goer: TestUser, lena: TestUser;
let seeded: Array<{ id: string; name: string }> = [];
let strangers: string[] = [];
let podId = '', podName = '', sessionId = '';
let podMemberIds: string[] = [];
let seededInvitedId = '';
const ctxs: BrowserContext[] = [];

/** A throwaway member whose address can never receive mail (the reserved .invalid domain). */
async function member(label: string, name?: string): Promise<TestUser> {
  const u = await createTestUser(`invpick-${label}`);
  const email = `e2etest-invpick-${label}-${RUN}@rsn-e2e.invalid`;
  const displayName = name ?? u.displayName;
  const [first, ...rest] = displayName.split(' ');
  await pool.query(`UPDATE users SET email = $1, display_name = $2, first_name = $3, last_name = $4, job_title = 'Founder', company = 'Harbor Labs' WHERE id = $5`,
    [email, displayName, first, rest.join(' ') || first, u.id]);
  return { ...u, email, displayName };
}

/** Every step runs even if one before it throws, so a failed step cannot leave the rest of the throwaway data behind. */
async function everyStep(...steps: Array<() => Promise<unknown>>): Promise<void> {
  let first: { error: unknown } | undefined;
  for (const step of steps) {
    try { await step(); } catch (error) { first ??= { error }; }
  }
  if (first) throw first.error;
}

async function apiAs(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function pageAt(u: TestUser, p: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 1024 });
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

const sheetOf = (page: Page, name: string) => page.getByRole('dialog', { name });
const rowsOf = (sheet: Locator) => sheet.locator('[data-testid^="invite-candidate-"]');
const rowOf = (sheet: Locator, userId: string) => sheet.getByTestId(`invite-candidate-${userId}`);
const statusCard = (page: Page) => page.getByTestId('invite-status');
const sendButton = (sheet: Locator) => sheet.getByTestId('invite-send');

/** The next confirm() on this page is accepted. Register it BEFORE the click that opens it. */
function acceptNextDialog(page: Page) {
  page.once('dialog', (d) => { void d.accept(); });
}

/** A button on the page itself: scrolled to the middle of its scroll area, as a person scrolls to it, then pressed where a
 *  finger lands. Below the fold on a phone, it would otherwise sit under the fixed bottom bar. */
async function tapOnPage(page: Page, target: Locator, label: string) {
  await expect(target, `${label}: not on the page`).toBeVisible({ timeout: 20_000 });
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await tapReachable(page, target, label);
}

/** The box lies inside the window: what a thumb can reach without scrolling anything. */
async function insideWindow(page: Page, target: Locator, label: string) {
  const box = await target.boundingBox();
  const vp = page.viewportSize()!;
  expect(box, `${label}: not drawn`).not.toBeNull();
  expect(box!.x, `${label}: left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${label}: top edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label}: right edge`).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box!.y + box!.height, `${label}: bottom edge`).toBeLessThanOrEqual(vp.height + 0.5);
}

async function noSidewaysScroll(page: Page, label: string) {
  const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  expect(widths.doc, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(widths.win);
}

/** Nothing inside `scope` that scrolls (the sheet's body, a list) is wider than its box. A field's own text may scroll. */
async function nothingInsideScrollsSideways(scope: Locator, label: string) {
  const wide = await scope.evaluate((root) => [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
    .filter((el) => !['INPUT', 'TEXTAREA'].includes(el.tagName))
    .filter((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
    .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')} ${el.scrollWidth}>${el.clientWidth}`));
  expect(wide, `${label}: scrolls sideways inside`).toEqual([]);
}

/** Every visible button and link inside `scope` is a 44px target; a row the whole of which is a label is 56px. */
async function targetsBigEnough(scope: Locator, label: string) {
  const small = await scope.evaluate((root) => {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, a[href], input:not([type="checkbox"])'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-testid^="invite-candidate-"]'))) {
      const r = el.getBoundingClientRect();
      if (r.height < 55.5) out.push(`row ${Math.round(r.height)}px`);
    }
    return out;
  });
  expect(small, `${label}: controls under 44px (rows under 56px)`).toEqual([]);
}

/** The sheet's body back at its top (segments, search, chips), for a picture of what a person sees on opening. */
async function sheetToTop(sheet: Locator) {
  await sheet.evaluate((el) => el.querySelectorAll<HTMLElement>('.overflow-y-auto').forEach((body) => { body.scrollTop = 0; }));
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(900);   // sections fade in over about 0.6 s; a picture should not catch them half drawn
  await page.screenshot({ path: path.join(SHOTS, `${engineLabel().replace('/', '-')}-${name}.png`) }).catch(() => {});
}

const pendingPodInvites = async () =>
  (await pool.query<{ email: string }>(`SELECT LOWER(invitee_email) AS email FROM invites WHERE pod_id = $1 AND type = 'pod' AND status = 'pending'`, [podId])).rows.map((r) => r.email);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  director = await member('director', 'Dina Director');
  decliner = await member('decliner', 'Dana Whitfield');
  goer = await member('goer', 'Gil Moreno');
  lena = await member('lena', 'Lena Park');

  // 61 connections and 2 pod members who are not connections, in one statement each.
  const people = [
    ...Array.from({ length: 59 }, (_v, i) => `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`),
    CLAUS, CLARA, 'Sven Outside', 'Tara Outside',
  ];
  const made = await pool.query<{ id: string; name: string }>(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, email_verified, company, job_title, industry)
     SELECT gen_random_uuid(), 'e2etest-invpick-p' || n || '-' || $2 || '@rsn-e2e.invalid', name, split_part(name, ' ', 1), split_part(name, ' ', 2),
            'active', 'member', true, true, 'completed', true, ($3::text[])[1 + (n % 5)::int], ($4::text[])[1 + (n % 5)::int], 'Tech'
       FROM unnest($1::text[]) WITH ORDINALITY AS t(name, n)
     RETURNING id, display_name AS name`,
    [people, RUN, FIRMS, TITLES],
  );
  const byName = new Map(made.rows.map((r) => [r.name, r.id]));
  seeded = people.slice(0, 61).map((name) => ({ id: byName.get(name)!, name }));
  strangers = [byName.get('Sven Outside')!, byName.get('Tara Outside')!];

  // Connections: an accepted meeting request each, a minute apart, so the list's order (newest first) is fixed.
  // The four accounts that sign in come first; Claus and Clara sit on the second page.
  const order = [goer.id, decliner.id, lena.id, ...seeded.map((s) => s.id)];
  await pool.query(
    `INSERT INTO user_pokes (sender_id, recipient_id, status, responded_at, created_at)
     SELECT $1, person, 'accepted', NOW() - make_interval(mins => n::int), NOW() - make_interval(mins => n::int)
       FROM unnest($2::uuid[]) WITH ORDINALITY AS t(person, n)`,
    [director.id, order],
  );

  podName = `Invite Pod ${RUN}`;
  const pod = await apiAs(director, 'POST', '/pods', {
    name: podName, description: 'E2E invite picker', visibility: 'private',
    podType: 'speed_networking', orchestrationMode: 'timed_rounds', communicationMode: 'video', maxMembers: 40,
  });
  expect(pod.status, JSON.stringify(pod.json)).toBe(201);
  podId = pod.json.data.id;
  // The pod: Gil, five connections and two people who are no connections of the director.
  podMemberIds = [goer.id, ...seeded.slice(0, 5).map((s) => s.id), ...strangers];
  for (const id of podMemberIds) {
    const added = await apiAs(director, 'POST', `/pods/${podId}/members`, { userId: id });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
  }
  // One connection invited already, and Dana invited and declined.
  seededInvitedId = seeded[6].id;
  expect((await apiAs(director, 'POST', '/invites', { type: 'pod', podId, inviteeUserId: seededInvitedId, maxUses: 1, expiresInHours: 168 })).status).toBe(201);
  const toDana = await apiAs(director, 'POST', '/invites', { type: 'pod', podId, inviteeUserId: decliner.id, maxUses: 1, expiresInHours: 168 });
  expect(toDana.status).toBe(201);
  expect((await apiAs(decliner, 'POST', `/invites/${toDana.json.data.code}/decline`)).status).toBe(200);

  // An event in the pod, for 50 people, that Gil is going to.
  const event = await apiAs(director, 'POST', '/sessions', {
    podId, title: `Invite Event ${RUN}`, description: 'E2E invite picker', scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    config: { eventType: 'speed_networking', numberOfRounds: 3, maxParticipants: 50, roundDurationSeconds: 300 },
  });
  expect(event.status, JSON.stringify(event.json)).toBe(201);
  sessionId = event.json.data.id;
  expect((await apiAs(goer, 'POST', `/sessions/${sessionId}/register`)).status).toBeLessThan(300);

  browser = await launchBrowser();
});

test.afterEach(async () => {
  for (const c of ctxs.splice(0)) { try { await c.close(); } catch { /* noop */ } }
});

test.afterAll(async () => {
  const ids = [director, decliner, goer, lena].filter(Boolean).map((u) => u.id).concat(seeded.map((s) => s.id), strangers);
  await everyStep(
    async () => { await browser?.close(); },
    // Invites hold the pod, the event and their sender without a cascade, so they go first, by what they name.
    async () => {
      await pool.query(`DELETE FROM invites WHERE inviter_id = ANY($1::uuid[]) OR ($2::uuid IS NOT NULL AND pod_id = $2) OR ($3::uuid IS NOT NULL AND session_id = $3)`,
        [ids, podId || null, sessionId || null]);
    },
    () => cleanup(pool, { ids, podId: podId || undefined }),
    async () => {
      const swept = await cleanupByPrefix(pool, 'e2etest-invpick');
      if (swept) console.log(`  swept ${swept} leftover invite-picker account(s)`);
    },
  );
});

test('the server lists the director\'s 64 connections 30 at a time, newest first, each with where they stand, and never an address', async () => {
  const first = await apiAs(director, 'GET', `/invites/candidates?podId=${podId}&limit=30`);
  expect(first.status).toBe(200);
  expect(first.json.data.items).toHaveLength(30);
  expect(first.json.data.nextBefore).toBeTruthy();
  expect(JSON.stringify(first.json)).not.toMatch(/@rsn-e2e\.invalid|"email"/);
  const states = new Map<string, string>(first.json.data.items.map((c: { userId: string; state: string }) => [c.userId, c.state]));
  expect(states.get(goer.id)).toBe('member');
  expect(states.get(decliner.id)).toBe('declined');
  expect(states.get(seededInvitedId)).toBe('invited');
  expect(states.get(lena.id)).toBe('available');
});

test('the pod page: browse 30 at a time, find Claus by "Cla", choose people as chips across searches, send them all, see them Invited in place', async () => {
  test.setTimeout(180_000);
  const page = await pageAt(director, `/pods/${podId}`, PHONE);
  // The organisers' card is on the page before anything is opened: the invite already sent, and Dana's decline.
  const card = statusCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('Invited (1)')).toBeVisible();
  await expect(card.getByText('Declined (1)')).toBeVisible();
  await expect(card.getByText('Dana Whitfield')).toBeVisible();

  await tapOnPage(page, page.getByRole('button', { name: 'Invite members' }), 'Invite members');
  const sheet = sheetOf(page, 'Invite members');
  await expect(sheet).toBeVisible();
  await expect(rowsOf(sheet)).toHaveCount(30, { timeout: 20_000 });
  // Nobody chosen: the footer button is there, in reach, and off.
  await expect(sendButton(sheet)).toHaveText('Send invites');
  await expect(sendButton(sheet)).toBeDisabled();
  await expectReachable(page, sendButton(sheet), 'Send invites');

  // Where people stand: a pod member, the one invited, the one who declined. None of them can be chosen.
  for (const [id, word] of [[goer.id, 'Member'], [seededInvitedId, 'Invited'], [decliner.id, 'Declined']] as const) {
    const row = rowOf(sheet, id);
    await expect(row).toContainText(word);
    await expect(row.getByRole('checkbox')).toBeDisabled();
  }

  // Browse: 30, then 60, then all 64 with no "Show more" left.
  await sheet.getByRole('button', { name: 'Show more' }).click();
  await expect(rowsOf(sheet)).toHaveCount(60, { timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Show more' }).click();
  await expect(rowsOf(sheet)).toHaveCount(64, { timeout: 20_000 });
  await expect(sheet.getByRole('button', { name: 'Show more' })).toHaveCount(0);

  // "Share a link" says the pod's real cap (its 40 places) before any link is made.
  await sheet.getByRole('button', { name: 'Share a link' }).click();
  await expect(sheet.getByText('Anyone with this link can join the pod, up to 40 people, for 7 days.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Share a link' }).click();

  // Search: "Cla" is Claus and Clara, and nobody else.
  const search = sheet.getByPlaceholder(PLACEHOLDER);
  await search.fill('Cla');
  await expect(rowsOf(sheet)).toHaveCount(2, { timeout: 20_000 });
  await expect(sheet.getByText(CLAUS)).toBeVisible();
  await expect(sheet.getByText(CLARA)).toBeVisible();
  const claus = seeded.find((s) => s.name === CLAUS)!;
  await rowOf(sheet, claus.id).click();
  await expect(sheet.getByRole('button', { name: `Remove ${CLAUS}` })).toBeVisible();

  // A second search keeps Claus chosen.
  await search.fill('Lena');
  await expect(rowsOf(sheet)).toHaveCount(1, { timeout: 20_000 });
  await rowOf(sheet, lena.id).click();
  await expect(sheet.getByRole('button', { name: `Remove ${CLAUS}` })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Remove Lena Park' })).toBeVisible();

  // Back to everyone: three more, and the chips fold after three into "+2".
  await search.fill('');
  await expect(rowsOf(sheet)).toHaveCount(64, { timeout: 20_000 });
  const more = [seeded[10], seeded[11], seeded[12]];
  for (const s of more) await rowOf(sheet, s.id).click();
  await expect(sheet.getByRole('button', { name: 'Show all 5 chosen' })).toHaveText('+2');
  await expect(sheet.getByRole('button', { name: /^Remove / })).toHaveCount(3);
  await expect(sendButton(sheet)).toHaveText('Send 5 invites');
  await expectReachable(page, sendButton(sheet), 'Send 5 invites');
  await insideWindow(page, sendButton(sheet), 'Send 5 invites');
  await sheetToTop(sheet);
  await shot(page, 'flow-pod-sheet-chosen-390');

  // Send: one call, the rows say Invited where they are, and the sheet stays open.
  await tapReachable(page, sendButton(sheet), 'Send 5 invites');
  await expect(page.getByText('5 invitations sent.')).toBeVisible({ timeout: 20_000 });
  await expect(sheet).toBeVisible();
  for (const s of [claus, ...more]) {
    await expect(rowOf(sheet, s.id)).toContainText('Invited');
    await expect(rowOf(sheet, s.id).getByRole('checkbox')).toBeDisabled();
  }
  await expect(sheet.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(sendButton(sheet)).toHaveText('Send invites');
  const pending = await pendingPodInvites();
  expect(pending).toHaveLength(6);
  expect(pending).toContain(lena.email.toLowerCase());
  await shot(page, 'flow-pod-sheet-sent-390');

  // Done closes it; the card shows the six invites without a reload.
  await tapReachable(page, sheet.getByRole('button', { name: 'Done' }), 'Done');
  await expect(sheet).toHaveCount(0);
  await expect(card.getByText('Invited (6)')).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole('button', { name: 'Remind all (6)' })).toBeVisible();

  // Lena declines on her own screen: the director's card moves her to Declined, live.
  const code = (await pool.query<{ code: string }>(`SELECT code FROM invites WHERE pod_id = $1 AND LOWER(invitee_email) = $2 AND status = 'pending'`, [podId, lena.email.toLowerCase()])).rows[0].code;
  expect((await apiAs(lena, 'POST', `/invites/${code}/decline`)).status).toBe(200);
  await expect(card.getByText('Declined (2)')).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('Invited (5)')).toBeVisible();

  // A reminder the local API cannot email (no mail provider) says so in the server's own sentence.
  const clausRow = card.locator('li', { hasText: CLAUS });
  await clausRow.getByRole('button', { name: 'Remind' }).click();
  await expect(page.getByText('We could not send the reminder just now. Please try again.')).toBeVisible({ timeout: 20_000 });

  // Withdraw asks first, then the invite is gone from the card and the database.
  acceptNextDialog(page);
  await clausRow.getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByText('Invite withdrawn. Its link no longer works.')).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('Invited (4)')).toBeVisible({ timeout: 20_000 });
  expect(await pendingPodInvites()).toHaveLength(4);
  await shot(page, 'flow-pod-status-390');
});

test('the event page opens the sheet on ?invite=1 on its pod, invites everyone in the pod in one press, and offers email and a link with the real cap', async () => {
  test.setTimeout(180_000);
  const page = await pageAt(director, `/sessions/${sessionId}?invite=1`, PHONE);
  const sheet = sheetOf(page, 'Invite people');
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  const podTab = sheet.getByRole('button', { name: 'This pod (8)' });
  await expect(podTab).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  await expect(rowsOf(sheet)).toHaveCount(8);
  await expect(rowOf(sheet, goer.id)).toContainText('Going');
  await expect(rowOf(sheet, goer.id).getByRole('checkbox')).toBeDisabled();
  await expect(rowOf(sheet, strangers[0])).toBeVisible();

  const everyone = sheet.getByRole('button', { name: `Invite everyone in ${podName} (7)` });
  await expectReachable(page, everyone, 'Invite everyone');
  await shot(page, 'flow-event-sheet-pod-390');
  await everyone.click();
  await expect(page.getByText('7 invitations sent.')).toBeVisible({ timeout: 20_000 });
  for (const id of podMemberIds.filter((id) => id !== goer.id)) await expect(rowOf(sheet, id)).toContainText('Invited');
  await expect(sheet.getByRole('button', { name: /^Invite everyone in / })).toHaveCount(0);

  // Your connections, against the event: Gil is going, the five connections in the pod are invited.
  await sheet.getByRole('button', { name: 'Your connections' }).click();
  await expect(rowsOf(sheet)).toHaveCount(30, { timeout: 20_000 });
  await expect(rowOf(sheet, goer.id)).toContainText('Going');
  await expect(rowOf(sheet, seeded[0].id)).toContainText('Invited');

  // Invite by email: the address is checked at the field, then sent.
  await sheet.getByRole('button', { name: 'Invite by email' }).click();
  const email = sheet.getByLabel('Their email address');
  await expect(email).toBeFocused();
  await email.fill('claus');
  await sheet.getByRole('button', { name: 'Send invite', exact: true }).click();
  await expect(sheet.getByText('Enter a whole email address, like name@example.com')).toBeVisible();
  const guest = `e2etest-invpick-guest-${RUN}@rsn-e2e.invalid`;
  await email.fill(guest);
  await sheet.getByRole('button', { name: 'Send invite', exact: true }).click();
  await expect(page.getByText(`Invitation sent to ${guest}.`)).toBeVisible({ timeout: 20_000 });
  await expect(email).toHaveValue('');

  // Share a link: the note says the event's real cap before the link is made, and the link allows exactly that.
  await sheet.getByRole('button', { name: 'Share a link' }).click();
  await expect(sheet.getByText('Anyone with this link can join the event, up to 50 people, for 7 days.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Make a link' }).click();
  const link = sheet.getByLabel('Invite link');
  await expect(link).toHaveValue(new RegExp(`/invite/[A-Za-z0-9_-]+$`), { timeout: 20_000 });
  const linkCode = (await link.inputValue()).split('/invite/')[1];
  const made = await pool.query<{ max_uses: number; invitee_email: string | null }>(`SELECT max_uses, invitee_email FROM invites WHERE code = $1`, [linkCode]);
  expect(made.rows[0]).toEqual({ max_uses: 50, invitee_email: null });
  await insideWindow(page, sendButton(sheet), 'Send invites (event)');
  await shot(page, 'flow-event-sheet-extras-390');

  // Done: the address no longer asks for the sheet, so a reload does not open it again.
  await tapReachable(page, sheet.getByRole('button', { name: 'Done' }), 'Done');
  await expect(sheet).toHaveCount(0);
  await expect(page).not.toHaveURL(/invite=1/);
  const card = statusCard(page);
  await expect(card.getByText('Invited (8)')).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('Shareable links (1)')).toBeVisible();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(statusCard(page)).toBeVisible({ timeout: 30_000 });
  await expect(sheetOf(page, 'Invite people')).toHaveCount(0);
});

for (const vp of WIDTHS) {
  test(`fits ${vp.width}px: the sheet's footer in the window, 44px targets, chips folded, no sideways scroll; the Invitations card too`, async () => {
    test.setTimeout(150_000);
    const page = await pageAt(director, `/pods/${podId}`, vp);
    await expect(statusCard(page)).toBeVisible({ timeout: 30_000 });
    await tapOnPage(page, page.getByRole('button', { name: 'Invite members' }), `Invite members at ${vp.width}`);
    const sheet = sheetOf(page, 'Invite members');
    await expect(rowsOf(sheet)).toHaveCount(30, { timeout: 20_000 });
    // Four people who can still be chosen (from the newest page), so three chips and "+1".
    const free = seeded.slice(13, 17);
    for (const s of free) await rowOf(sheet, s.id).click();
    await expect(sheet.getByRole('button', { name: 'Show all 4 chosen' })).toHaveText('+1');
    await expect(sendButton(sheet)).toHaveText('Send 4 invites');
    await expectReachable(page, sendButton(sheet), `Send 4 invites at ${vp.width}`);
    await insideWindow(page, sendButton(sheet), `Send 4 invites at ${vp.width}`);
    await expectReachable(page, sheet.getByRole('button', { name: 'Done' }), `Done at ${vp.width}`);
    await noSidewaysScroll(page, `pod sheet at ${vp.width}`);
    await nothingInsideScrollsSideways(sheet, `pod sheet at ${vp.width}`);
    await targetsBigEnough(sheet, `pod sheet at ${vp.width}`);
    await sheetToTop(sheet);
    await shot(page, `pod-sheet-${vp.width}`);
    // Closing without sending sends nothing.
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toHaveCount(0);
    expect(await pendingPodInvites()).toHaveLength(4);

    const card = statusCard(page);
    await card.scrollIntoViewIfNeeded();
    await noSidewaysScroll(page, `pod page at ${vp.width}`);
    await targetsBigEnough(card, `pod Invitations card at ${vp.width}`);
    await page.evaluate(() => document.querySelector('[data-testid="invite-status"]')?.scrollIntoView({ block: 'start' }));
    await shot(page, `pod-status-${vp.width}`);

    // The event: its sheet on the pod segment, and its card.
    await gotoRetry(page, `${APP}/sessions/${sessionId}`);
    await expect(statusCard(page)).toBeVisible({ timeout: 30_000 });
    await tapOnPage(page, page.getByRole('button', { name: 'Invite people' }), `Invite people at ${vp.width}`);
    const eventSheet = sheetOf(page, 'Invite people');
    await expect(eventSheet.getByRole('button', { name: 'This pod (8)' })).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
    await expect(rowsOf(eventSheet)).toHaveCount(8);
    await insideWindow(page, sendButton(eventSheet), `event Send at ${vp.width}`);
    await noSidewaysScroll(page, `event sheet at ${vp.width}`);
    await nothingInsideScrollsSideways(eventSheet, `event sheet at ${vp.width}`);
    await targetsBigEnough(eventSheet, `event sheet at ${vp.width}`);
    await shot(page, `event-sheet-${vp.width}`);
    await eventSheet.getByRole('button', { name: 'Done' }).click();
    const eventCard = statusCard(page);
    await eventCard.scrollIntoViewIfNeeded();
    await noSidewaysScroll(page, `event page at ${vp.width}`);
    await targetsBigEnough(eventCard, `event Invitations card at ${vp.width}`);
    await page.evaluate(() => document.querySelector('[data-testid="invite-status"]')?.scrollIntoView({ block: 'start' }));
    await shot(page, `event-status-${vp.width}`);
  });
}
