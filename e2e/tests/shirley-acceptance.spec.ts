import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { APP, SERVER, cleanup, connectSocket, gotoRetry, idsOf, teardown, wait, type Socket } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser, pickEngine } from '../helpers/engine';
import { acceptConfirmDialogs, confirmInPage } from '../helpers/confirm-dialog';
import { primePreview } from '../helpers/preview-bypass';

// ─────────────────────────────────────────────────────────────────────────────
// SHIRLEY PILOT S9: THE ACCEPTANCE REHEARSAL (11 Nov 2026 brief, "Five user acceptance tests" 01-05)
//
// Shirley's real setup, with throwaway accounts (@rsn-e2e.invalid) only:
//   - "Curious Humans <run>", owned by a Stefan-like account (a plain member: a throwaway admin makes the circle, hands
//     it to Stefan and leaves, so nothing below rests on admin powers). Stefan hands it to Shirley through the real UI:
//     Manage → Members → Manage Shirley → Make owner, the confirm dialog read and pressed on Stefan's page; Stefan is
//     then a moderator (badge, database, and refused a role change and a handover), and Shirley's page, never
//     reloaded, says "You own this circle".
//   - Shirley (a plain member) makes the pods "Curious 12 <run>" (Public with approval at first) and "Human Edge <run>"
//     (Private) in the circle, then sets Curious 12 to Private through Manage → Visibility (the Edit Pod sheet): the
//     member in both pods sees "Private" without a reload, and the circle member outside it watches it leave the
//     circle's pod list without a reload.
//   - "Both" is in both pods, "One" only in Human Edge (both are circle members), "Outsider" is in nothing. Shirley is
//     connected to Both and One (an accepted request), as members who message each other are.
// Then each acceptance test exactly as the brief words it, as its own test, each needing only the setup above (so one
// can run alone with -g, and one failure does not hide the others):
//   01 Shirley owns the Circle: signed in as Shirley (no admin role, refused an admin route), she edits Curious Humans
//      (a member's page shows the new words live), invites a moderator by email from the Invite sheet (their bell
//      rings without a reload, they accept from it and land on the circle; they are made moderator and their page
//      gains Manage live, without Visibility) and creates a new pod from the circle page.
//   02 Curious 12 stays private: Shirley invites an outsider (a brand-new address, the account made after the
//      invitation) to Curious 12 from the pod's Invite sheet; they accept the link, land in Curious 12 and read its
//      discussion, while Shirley's page lists them without a reload; Human Edge stays "Pod not found" for them. The
//      Outsider and One (a circle member outside Curious 12) cannot find it (browse, the circle page, Shirley's
//      profile, which-circles) nor read it (overview, discussion, a post link): no answer names it, no bell points at
//      it.
//   03 Messaging is safely isolated: on a phone, Shirley records a note to Person A (Both), stops without sending, and
//      opens Person B (One): B's box has no note, no recording, an empty text box; the server holds nothing for B and
//      B's own page, never reloaded, shows nothing. Back in A's thread the note is still "Not sent"; sent, A's page
//      shows exactly one voice note live and B still has none.
//   04 An event works from start to finish: Shirley schedules a video meeting in Curious 12 from the pod page, invites
//      its members from the sheet the form opens; Both's bell rings live, Both accepts from it (registered); nobody
//      outside the pod is rung, listed or let in. Both join the native room (Chromium: real fake-camera video both
//      ways), Shirley ends it for everyone, everyone sees "Meeting ended", and "Back to pod" returns to the pod's
//      Discussion, where Both's words reach Shirley's page without a reload.
//   05 Calendar booking does not duplicate: Shirley books the one time Both offered, from the thread's scheduler; each
//      of them gets exactly one invitation (logged as sent once, a repeated confirm sends nothing more), the .ics file
//      is a valid REQUEST for that time pointing back into REASON, Both's page shows the booking live, and Shirley never
//      leaves app.rsn.network (no popup, no Microsoft or Google sign-in, no calendar connection asked for).
// Every test also checks its screens at 360px and 1280px: each control checked inside the window, the page never
// scrolling sideways, and the controls the pilot added at least 44px tall.
//
// Engines (E2E_ENGINE / E2E_DEVICE, as the other specs): everything runs on Chromium, WebKit, the iPhone and the tablet,
// except what WebKit cannot do on this machine: Playwright's WebKit for Windows has no microphone or camera to fake
// (no --use-fake-device-for-media-stream) and no WebRTC, so test 03 is skipped there and test 04 drives the meeting from
// the host's socket and checks it on the event page instead of inside the LiveKit room. Not covered: iOS Safari's own
// recorder and LiveKit on a real iPhone (Ali's phone list).
// Everything this spec makes is deleted by id at the end (the circle, every pod a throwaway directs, their invites and
// events, then the people).
// ─────────────────────────────────────────────────────────────────────────────

const RUN = `s9${Date.now().toString(36)}`;
const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const WEBKIT = process.env.E2E_ENGINE === 'webkit';
const NO_MEDIA = 'Playwright\'s WebKit for Windows has no fake microphone or camera and no WebRTC, so it cannot record a voice note or join LiveKit';
// Chromium >= 147 on Windows loses the fake camera through Media Foundation capture; Chromium honours only the last
// --disable-features switch, so Playwright's own defaults are repeated before the extra one (as the call specs do).
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';

const CIRCLE = `Curious Humans ${RUN}`;
const C12 = `Curious 12 ${RUN}`;
const EDGE = `Human Edge ${RUN}`;

type Size = { width: number; height: number };
const DESKTOP: Size = { width: 1280, height: 900 };
const PHONE: Size = { width: 390, height: 844 };
const SMALL: Size = { width: 360, height: 780 };
/** The two widths every test checks its screens at. */
const FIT_WIDTHS: Size[] = [SMALL, DESKTOP];

let browser: Browser;
let maker: TestUser | undefined, stefan: TestUser | undefined, shirley: TestUser | undefined;
let both: TestUser | undefined, one: TestUser | undefined, outsider: TestUser | undefined;
let modInvitee: TestUser | undefined, newcomer: TestUser | undefined;
let circleId = '';
let c12 = '';
let edge = '';
let convBoth = '';
let convOne = '';
const podsMade: string[] = [];
const contexts: BrowserContext[] = [];
const sockets: Socket[] = [];

/** A throwaway on the reserved test domain, with this run's name, whose token carries that address (an invitation by
 *  address is checked against it). No message emails. */
async function throwaway(label: string, role: 'member' | 'admin' = 'member', email?: string): Promise<TestUser> {
  const u = await createTestUser(`s9${label}`, role);
  const name = `${RUN} ${label}`;
  const address = email ?? `${u.id}@rsn-e2e.invalid`;
  await pool.query(
    `UPDATE users SET email = $2, display_name = $3, first_name = $3,
            notification_prefs = jsonb_set(COALESCE(notification_prefs, '{}'::jsonb), '{dm_email}', 'false')
      WHERE id = $1`,
    [u.id, address, name],
  );
  const sessionId = uuid();
  return {
    ...u, email: address, displayName: name,
    accessToken: jwt.sign({ sub: u.id, email: address, role, displayName: name, sessionId }, SECRET, { expiresIn: '2h' }),
    refreshToken: jwt.sign({ sub: u.id, sessionId, type: 'refresh' }, SECRET, { expiresIn: '1d' }),
  };
}

// `any`: each route answers its own shape, read by field in the assertions.
async function api(who: TestUser, method: string, p: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON (an .ics) */ }
  return { status: res.status, json, text };
}

/** Chromium with the fake microphone and camera the call specs use; WebKit as the engine helper launches it. */
async function launch(): Promise<Browser> {
  if (WEBKIT) return launchBrowser();
  return pickEngine().launch({
    headless: process.env.E2E_HEADED === '0',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
      `--disable-features=${PW_DISABLED},MediaFoundationD3D11VideoCapture`],
  });
}

/** Someone signed in, in a browser context of their own (the project's device when one is set). `confirm: false`
 *  leaves in-page confirm dialogs for the test to read and press itself. */
async function signedIn(user: TestUser, viewport: Size, opts: { confirm?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext(contextOptions(viewport));
  contexts.push(ctx);
  await primePreview(ctx);
  await ctx.addInitScript((t) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await ctx.newPage();
  if (opts.confirm !== false) await acceptConfirmDialogs(page);
  return page;
}

async function closeContexts(): Promise<void> {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
}

/** A flag on the window that a reload would wipe, so "without a reload" is checked, not assumed. */
const markNotReloaded = (page: Page) => page.evaluate(() => { (window as unknown as { __s9: boolean }).__s9 = true; });
async function expectNotReloaded(page: Page, label: string): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __s9?: boolean }).__s9 === true), `${label}: no reload happened`).toBe(true);
}

async function noSideScroll(page: Page, label: string): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, `${label}: the page does not scroll sideways`).toBeLessThanOrEqual(1);
}

/** A control a person can see and press at this width: wholly inside the window once scrolled to (isVisible alone
 *  misses one pushed off the side), and at least 44px tall when it is one the pilot added (`tap`). */
async function fits(page: Page, locator: Locator, label: string, opts: { tap?: boolean } = {}): Promise<void> {
  await expect(locator, `${label}: on screen`).toBeVisible({ timeout: 20_000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const vp = page.viewportSize()!;
  expect(box, `${label}: has a box`).not.toBeNull();
  const b = box!;
  expect(Math.round(b.x), `${label}: left edge inside ${vp.width}px`).toBeGreaterThanOrEqual(0);
  expect(Math.round(b.x + b.width), `${label}: right edge inside ${vp.width}px`).toBeLessThanOrEqual(vp.width + 1);
  expect(Math.round(b.y), `${label}: top edge inside the window`).toBeGreaterThanOrEqual(0);
  expect(Math.round(b.y + b.height), `${label}: bottom edge inside ${vp.height}px`).toBeLessThanOrEqual(vp.height + 1);
  if (opts.tap) expect(b.height, `${label}: a 44px tap target`).toBeGreaterThanOrEqual(44);
}

/** Runs `check` at 360px and at 1280px (no sideways scroll at either), then gives the page its own size back. */
async function atBothWidths(page: Page, label: string, check: (width: number) => Promise<void>): Promise<void> {
  const own = page.viewportSize();
  for (const size of FIT_WIDTHS) {
    await page.setViewportSize(size);
    await wait(400); // the layout's own change of breakpoint, settled
    await check(size.width);
    await noSideScroll(page, `${label} at ${size.width}px`);
  }
  if (own) await page.setViewportSize(own);
  await wait(400);
}

const bell = (page: Page) => page.getByRole('button', { name: 'Notifications' });
const bellCount = (page: Page) => bell(page).locator('span').filter({ hasText: /^\d+$/ });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Opens the bell and presses Accept on the invitation whose row names `words`. */
async function acceptFromBell(page: Page, words: RegExp): Promise<void> {
  await expect(bellCount(page), 'the bell counts it, without a reload').toBeVisible({ timeout: 45_000 });
  await bell(page).click();
  const row = page.getByTestId('notification-row')
    .filter({ hasText: words })
    .filter({ has: page.getByRole('button', { name: 'Accept' }) })
    .first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Accept' }).click();
}

/** Opens the Manage menu (a sheet on a phone, a menu on a desktop) and returns its panel. */
async function openManage(page: Page): Promise<Locator> {
  await page.getByTestId('manage-open').click();
  const menu = page.getByTestId('manage-menu');
  await expect(menu).toBeVisible({ timeout: 20_000 });
  return menu;
}

/** A thread open, its header naming the other person. A slow first load gets one reload before the test gives up
 *  (the voice spec's fix round 4: the header waits for the inbox). */
async function openThread(page: Page, conversationId: string, partnerName: string): Promise<void> {
  await gotoRetry(page, `${APP}/messages/${conversationId}`);
  const header = page.getByTestId('thread-partner-name');
  try {
    await expect(header).toHaveText(partnerName, { timeout: 30_000 });
  } catch {
    await page.reload();
    await expect(header, 'the thread header after one reload').toHaveText(partnerName, { timeout: 45_000 });
  }
}

/** Opens another conversation from the inbox list, through "Back to inbox" where the phone hides the list. */
async function openPartner(page: Page, name: string): Promise<void> {
  const link = page.getByRole('link', { name: new RegExp(escapeRe(name)) }).first();
  if (!(await link.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Back to inbox' }).first().click();
  await link.click();
  await expect(page.getByTestId('thread-partner-name')).toHaveText(name, { timeout: 30_000 });
}

/** Connect two people (a request, accepted) and return their conversation. */
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

const statusOf = async (sessionId: string) => (await pool.query<{ status: string }>('SELECT status FROM sessions WHERE id = $1', [sessionId])).rows[0]?.status;

// ── The setup: Shirley's space as it will be on production ───────────────────────────────────────────────────────

test.beforeAll(async () => {
  test.setTimeout(480_000);
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway accounts').toBeTruthy();
  browser = await launch();
  maker = await throwaway('Maker', 'admin');
  stefan = await throwaway('Stefan');
  shirley = await throwaway('Shirley');
  both = await throwaway('Both');
  one = await throwaway('One');
  outsider = await throwaway('Outsider');
  modInvitee = await throwaway('Moderator');

  // A throwaway admin makes the circle (POST /circles is admin-only) and hands it to Stefan, a plain member, then
  // leaves: Stefan owns Curious Humans as he does on production, without any admin rights of his own.
  const made = await api(maker, 'POST', '/circles', { name: CIRCLE, description: 'A broad, open circle for curious people.' });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  circleId = made.json.data.id;
  for (const who of [stefan, shirley, both, one]) expect((await api(who, 'POST', `/circles/${circleId}/join`)).status).toBe(200);
  expect((await api(maker, 'POST', `/circles/${circleId}/transfer`, { toUserId: stefan.id })).status).toBe(200);
  expect((await api(maker, 'POST', `/circles/${circleId}/leave`)).status).toBe(200);

  // ── Stefan hands the circle to Shirley through the page: Manage → Members → Make owner, and the confirm ──────────
  const sp = await signedIn(stefan, DESKTOP, { confirm: false });
  const shp = await signedIn(shirley, PHONE);
  await gotoRetry(shp, `${APP}/circles/${circleId}`);
  await expect(shp.getByTestId(`circle-join-${circleId}`), 'Shirley starts as a member').toHaveText('Leave', { timeout: 30_000 });
  await markNotReloaded(shp);
  await gotoRetry(sp, `${APP}/circles/${circleId}`);
  await expect(sp.getByTestId(`circle-owner-${circleId}`)).toHaveText('You own this circle', { timeout: 30_000 });
  const stefanMenu = await openManage(sp);
  await stefanMenu.getByTestId('manage-members').click();
  await expect(sp.getByTestId('circle-members')).toBeInViewport({ timeout: 10_000 });
  const manageShirley = sp.getByTestId(`circle-member-manage-${shirley.id}`);
  await atBothWidths(sp, 'the owner\'s member row', async (w) => { await fits(sp, manageShirley, `Manage Shirley @${w}`, { tap: true }); });
  await manageShirley.click();
  const makeOwner = sp.getByTestId('circle-member-action-make-owner');
  await fits(sp, makeOwner, 'Make owner', { tap: true });
  await makeOwner.click();
  const question = sp.getByRole('dialog', { name: `Make ${shirley.displayName} the owner of ${CIRCLE}?` });
  await expect(question).toBeVisible({ timeout: 10_000 });
  await expect(question.getByTestId('confirm-dialog-body')).toHaveText(
    `${shirley.displayName} will own ${CIRCLE}: they choose its moderators, who can join, and can hand it on. You become a moderator, so you keep running it with them, but you can no longer change roles or hand it over.`,
  );
  await atBothWidths(sp, 'the handover question', async (w) => { await fits(sp, question.getByTestId('confirm-dialog-confirm'), `Make owner (confirm) @${w}`, { tap: true }); });
  await confirmInPage(sp);
  await expect(sp.getByText(`${shirley.displayName} now owns ${CIRCLE}. You are a moderator.`)).toBeVisible({ timeout: 20_000 });
  await expect(sp.getByTestId(`circle-role-${shirley.id}`)).toHaveText('OWNER', { timeout: 20_000 });
  await expect(sp.getByTestId(`circle-role-${stefan.id}`), 'Stefan is now a moderator').toHaveText('MOD', { timeout: 20_000 });
  // Stefan keeps the managers' menu, without Visibility (who can join is the owner's alone).
  const asModerator = await openManage(sp);
  await expect(asModerator.getByTestId('circle-edit')).toBeVisible();
  await expect(asModerator.getByTestId('circle-settings')).toHaveCount(0, { timeout: 20_000 });
  await sp.keyboard.press('Escape');
  const roles = await pool.query<{ user_id: string; role: string }>(`SELECT user_id, role FROM circle_members WHERE circle_id = $1 AND user_id = ANY($2)`, [circleId, [stefan.id, shirley.id]]);
  expect(Object.fromEntries(roles.rows.map((r) => [r.user_id, r.role]))).toEqual({ [stefan.id]: 'moderator', [shirley.id]: 'owner' });
  expect((await api(stefan, 'PATCH', `/circles/${circleId}/members/${both.id}/role`, { role: 'moderator' })).status, 'a moderator cannot change roles').toBe(403);
  expect((await api(stefan, 'POST', `/circles/${circleId}/transfer`, { toUserId: both.id })).status, 'nor hand the circle on').toBe(403);
  // Shirley's own page, never reloaded, says she owns it.
  await expect(shp.getByTestId(`circle-owner-${circleId}`)).toHaveText('You own this circle', { timeout: 30_000 });
  await expectNotReloaded(shp, 'Shirley\'s circle page');

  // ── Shirley's two pods in the circle, and who is in them ─────────────────────────────────────────────────────
  for (const [name, visibility, set] of [
    [C12, 'public_with_approval', (id: string) => { c12 = id; }],
    [EDGE, 'private', (id: string) => { edge = id; }],
  ] as const) {
    const pod = await api(shirley, 'POST', '/pods', { name, podType: 'reason', visibility, circleId });
    expect(pod.status, JSON.stringify(pod.json)).toBe(201);
    set(pod.json.data.id);
    podsMade.push(pod.json.data.id);
  }
  for (const [podId, who] of [[c12, both], [edge, both], [edge, one]] as const) {
    expect((await api(shirley, 'POST', `/pods/${podId}/members`, { userId: who.id, role: 'member' })).status).toBe(201);
  }
  convBoth = await connect(shirley, both);
  convOne = await connect(shirley, one);

  // ── Shirley sets Curious 12 to Private through Manage → Visibility ────────────────────────────────────────────
  const bp = await signedIn(both, DESKTOP);
  const op = await signedIn(one, PHONE);
  await gotoRetry(bp, `${APP}/pods/${c12}`);
  await expect(bp.getByRole('heading', { name: C12 })).toBeVisible({ timeout: 30_000 });
  await expect(bp.getByText('Public with approval', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await gotoRetry(op, `${APP}/circles/${circleId}`);
  await expect(op.getByTestId('circle-pods').getByText(C12), 'a circle member sees the approval pod listed').toBeVisible({ timeout: 30_000 });
  await markNotReloaded(bp);
  await markNotReloaded(op);
  const dp = await signedIn(shirley, DESKTOP);
  await gotoRetry(dp, `${APP}/pods/${c12}`);
  await expect(dp.getByRole('heading', { name: C12 })).toBeVisible({ timeout: 30_000 });
  await atBothWidths(dp, 'the pod\'s Manage menu', async (w) => {
    const menu = await openManage(dp);
    await fits(dp, menu.getByTestId('manage-visibility'), `Visibility @${w}`, { tap: true });
    await dp.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
  const podMenu = await openManage(dp);
  await expect(podMenu.getByTestId('manage-visibility')).toContainText('Now: Public with approval.');
  await podMenu.getByTestId('manage-visibility').click();
  const edit = dp.getByRole('dialog', { name: 'Edit Pod' });
  await expect(edit).toBeVisible({ timeout: 20_000 });
  // Scoped to the sheet: the REASON logo's own label also matches a bare label search.
  const visibility = edit.getByLabel('Visibility', { exact: true });
  await visibility.selectOption('private');
  await expect(edit.getByText('Not listed anywhere. Only its members see it.', { exact: false })).toBeVisible();
  await atBothWidths(dp, 'the Edit Pod sheet', async (w) => { await fits(dp, edit.getByRole('button', { name: 'Save Changes' }), `Save Changes @${w}`); });
  await edit.getByRole('button', { name: 'Save Changes' }).click();
  await expect(dp.getByText('Pod updated')).toBeVisible({ timeout: 20_000 });
  await expect(edit).toHaveCount(0);
  const after = await openManage(dp);
  await expect(after.getByTestId('manage-visibility')).toContainText('Now: Private.', { timeout: 20_000 });
  await dp.keyboard.press('Escape');
  expect((await pool.query<{ visibility: string }>('SELECT visibility FROM pods WHERE id = $1', [c12])).rows[0].visibility).toBe('private');
  // Without a reload: Both's pod page says Private; One's circle page no longer lists Curious 12.
  await expect(bp.getByText('Private', { exact: true }).first(), 'the member\'s page says Private').toBeVisible({ timeout: 30_000 });
  await expect(bp.getByText('Public with approval', { exact: true })).toHaveCount(0);
  await expect(op.getByTestId('circle-pods').getByText(C12), 'the private pod leaves a non-member\'s circle page').toHaveCount(0, { timeout: 30_000 });
  await expect(op.getByTestId('circle-pods').getByText(EDGE), 'One still sees the pod they are in').toBeVisible();
  await expectNotReloaded(bp, 'Both\'s pod page');
  await expectNotReloaded(op, 'One\'s circle page');
  await closeContexts();
});

test.afterEach(async () => {
  await closeContexts();
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  const ids = idsOf(maker, stefan, shirley, both, one, outsider, modInvitee, newcomer);
  // Every pod a throwaway of this run directs (the setup's two, test 01's new one, any a failed run left), by id.
  const directed = ids.length
    ? (await pool.query<{ pod_id: string }>(`SELECT DISTINCT pod_id FROM pod_members WHERE user_id = ANY($1) AND role = 'director'`, [ids]).catch(() => ({ rows: [] as Array<{ pod_id: string }> }))).rows.map((r) => r.pod_id)
    : [];
  const pods = [...new Set([...podsMade, ...directed])];
  await teardown(
    () => closeContexts(),
    () => browser?.close(),
    () => (circleId ? pool.query(`DELETE FROM invites WHERE circle_id = $1`, [circleId]) : Promise.resolve()),
    () => (pods.length ? pool.query(`DELETE FROM invites WHERE pod_id = ANY($1)`, [pods]) : Promise.resolve()),
    () => (ids.length ? pool.query(`DELETE FROM invites WHERE inviter_id = ANY($1)`, [ids]) : Promise.resolve()),
    () => (circleId ? pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]) : Promise.resolve()),
    ...pods.map((podId) => () => cleanup(pool, { ids: [], podId })),
    // The pods by their ids, then the people by theirs: never by a name.
    () => cleanup(pool, { ids }),
  );
});

// ── 01 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`01 Shirley owns the Circle: she edits Curious Humans, invites a moderator and creates a new pod, with no admin access (${engineLabel()})`, async () => {
  test.setTimeout(420_000);
  const s = shirley!; const m = modInvitee!; const b = both!;

  // No elevated access: a plain member, refused an admin route.
  expect((await pool.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [s.id])).rows[0].role).toBe('member');
  expect((await api(s, 'GET', '/admin/stats')).status, 'Shirley has no admin access').toBe(403);

  const sp = await signedIn(s, DESKTOP);
  const bp = await signedIn(b, PHONE);
  await gotoRetry(sp, `${APP}/circles/${circleId}`);
  await expect(sp.getByTestId(`circle-owner-${circleId}`)).toHaveText('You own this circle', { timeout: 30_000 });
  await gotoRetry(bp, `${APP}/circles/${circleId}`);
  await expect(bp.getByRole('heading', { name: CIRCLE })).toBeVisible({ timeout: 30_000 });
  await expect(bp.getByTestId('manage-open'), 'a member has no Manage').toHaveCount(0);
  await markNotReloaded(bp);

  // The circle page at 360 and 1280: the owner's actions and every Manage entry, Visibility included.
  await atBothWidths(sp, 'the owner\'s circle page', async (w) => {
    for (const id of ['manage-open', 'circle-invite', 'circle-schedule-event', 'circle-new-pod']) await fits(sp, sp.getByTestId(id), `${id} @${w}`, { tap: true });
    const menu = await openManage(sp);
    for (const id of ['circle-edit', 'manage-members', 'circle-invitations', 'manage-pods', 'manage-events', 'circle-settings', 'manage-moderation']) {
      await fits(sp, menu.getByTestId(id), `${id} @${w}`, { tap: true });
    }
    await sp.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  // ── Edit Curious Humans ─────────────────────────────────────────────────────────────────────────────────────
  const words = `Curious people meeting curious people (${RUN}).`;
  const menu = await openManage(sp);
  await menu.getByTestId('circle-edit').click();
  const form = sp.getByTestId('circle-edit-form');
  await expect(form).toBeVisible({ timeout: 10_000 });
  await atBothWidths(sp, 'the edit sheet', async (w) => { await fits(sp, sp.getByTestId('circle-edit-save'), `Save @${w}`, { tap: true }); });
  await sp.getByTestId('circle-edit-description').fill(words);
  await sp.getByTestId('circle-edit-save').click();
  await expect(sp.getByText('Saved.')).toBeVisible({ timeout: 20_000 });
  await expect(form).toHaveCount(0);
  await expect(sp.getByText(words)).toBeVisible({ timeout: 20_000 });
  await expect(bp.getByText(words), 'a member\'s page shows the new description without a reload').toBeVisible({ timeout: 30_000 });
  expect((await pool.query<{ description: string }>('SELECT description FROM circles WHERE id = $1', [circleId])).rows[0].description).toBe(words);

  // ── Invite a moderator: by email from the Invite sheet; they accept from their bell ───────────────────────────
  const mp = await signedIn(m, DESKTOP);
  await gotoRetry(mp, `${APP}/circles`);
  await expect(bell(mp)).toBeVisible({ timeout: 30_000 });
  await markNotReloaded(mp);
  await sp.getByTestId('circle-invite').click();
  const sheet = sp.getByRole('dialog', { name: 'Invite people' });
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Invite by email' }).click();
  await atBothWidths(sp, 'the invite sheet', async (w) => { await fits(sp, sheet.getByRole('button', { name: 'Send invite', exact: true }), `Send invite @${w}`, { tap: true }); });
  await sheet.getByLabel('Their email address').fill(m.email);
  await sheet.getByRole('button', { name: 'Send invite', exact: true }).click();
  await expect(sp.getByText(`Invitation sent to ${m.email}.`)).toBeVisible({ timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Done' }).click();
  const invite = await pool.query(`SELECT 1 FROM invites WHERE circle_id = $1 AND inviter_id = $2 AND lower(invitee_email) = lower($3)`, [circleId, s.id, m.email]);
  expect(invite.rowCount, 'one invitation, from Shirley, to that address').toBe(1);

  await acceptFromBell(mp, new RegExp(escapeRe(CIRCLE)));
  await mp.waitForURL(new RegExp(`/circles/${circleId}$`), { timeout: 30_000 });
  await expectNotReloaded(mp, 'the invitee\'s page');
  await expect(sp.getByTestId('circle-members').getByText(m.displayName).first(),'Shirley\'s page lists them without a reload').toBeVisible({ timeout: 30_000 });
  await expect(mp.getByTestId('manage-open')).toHaveCount(0);

  const manageThem = sp.getByTestId(`circle-member-manage-${m.id}`);
  await manageThem.click();
  const makeMod = sp.getByTestId('circle-member-action-make-moderator');
  await atBothWidths(sp, 'the member sheet', async (w) => { await fits(sp, makeMod, `Make moderator @${w}`, { tap: true }); });
  await makeMod.click();
  await expect(sp.getByText(`${m.displayName} is now a moderator of ${CIRCLE}.`)).toBeVisible({ timeout: 20_000 });
  await expect(sp.getByTestId(`circle-role-${m.id}`)).toHaveText('MOD', { timeout: 20_000 });
  // Their page gains Manage without a reload, with no Visibility in it.
  await expect(mp.getByTestId('manage-open'), 'the new moderator\'s page gains Manage').toBeVisible({ timeout: 30_000 });
  const modMenu = await openManage(mp);
  await expect(modMenu.getByTestId('circle-edit')).toBeVisible();
  await expect(modMenu.getByTestId('circle-invitations')).toBeVisible();
  await expect(modMenu.getByTestId('circle-settings'), 'Visibility is the owner\'s alone').toHaveCount(0);
  await mp.keyboard.press('Escape');
  await expectNotReloaded(mp, 'the moderator\'s page');
  expect((await pool.query<{ role: string }>('SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2', [circleId, m.id])).rows[0].role).toBe('moderator');

  // ── Create a new pod from the circle page ──────────────────────────────────────────────────────────────────
  const name = `Breakfast pod ${RUN}`;
  await sp.getByTestId('circle-new-pod').click();
  const podForm = sp.getByRole('dialog', { name: `New pod in ${CIRCLE}` });
  await expect(podForm).toBeVisible({ timeout: 20_000 });
  await podForm.getByLabel('Pod name').fill(name);
  await atBothWidths(sp, 'the new pod form', async (w) => { await fits(sp, podForm.getByRole('button', { name: 'Create Pod' }), `Create Pod @${w}`); });
  const made = sp.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/pods');
  await podForm.getByRole('button', { name: 'Create Pod' }).click();
  const answer = await made;
  expect(answer.status()).toBe(201);
  const pod = (await answer.json()).data as { id: string; circleId?: string };
  podsMade.push(pod.id);
  expect(pod.circleId, 'made in the circle').toBe(circleId);
  await expect(sp.getByText(`${name} is created and added to ${CIRCLE}.`)).toBeVisible({ timeout: 20_000 });
  await expect(sp.getByTestId('circle-pods').getByText(name)).toBeVisible({ timeout: 20_000 });
  expect(new URL(sp.url()).pathname, 'Shirley stays on the circle').toBe(`/circles/${circleId}`);
  const director = await pool.query<{ role: string }>('SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2', [pod.id, s.id]);
  expect(director.rows[0]?.role, 'Shirley directs the new pod').toBe('director');
});

// ── 02 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test(`02 Curious 12 stays private: an outsider invited to the founding pod gets in; a nonmember cannot discover it or read its discussion (${engineLabel()})`, async () => {
  test.setTimeout(420_000);
  const s = shirley!; const x = outsider!; const o = one!; const b = both!;

  // The protected discussion: words only Curious 12's members may read.
  const words = `${RUN} protected words for Curious 12 only`;
  const posted = await api(s, 'POST', `/pods/${c12}/wall/posts`, { clientId: uuid(), content: words });
  expect(posted.status, JSON.stringify(posted.json)).toBe(201);
  const postId = posted.json.data.id as string;

  // ── Shirley invites an outsider: a brand-new address, from the pod's Invite sheet ────────────────────────────
  const sp = await signedIn(s, DESKTOP);
  await gotoRetry(sp, `${APP}/pods/${c12}`);
  await expect(sp.getByRole('heading', { name: C12 })).toBeVisible({ timeout: 30_000 });
  await expect(sp.getByTestId('pod-wall').getByText(words)).toBeVisible({ timeout: 30_000 });
  const inviteButton = sp.getByRole('button', { name: 'Invite members', exact: true }).first();
  await atBothWidths(sp, 'the director\'s pod page', async (w) => {
    await fits(sp, sp.getByTestId('manage-open'), `Manage @${w}`, { tap: true });
    await fits(sp, inviteButton, `Invite members @${w}`);
  });
  await markNotReloaded(sp);
  const address = `s9-newcomer-${RUN}@rsn-e2e.invalid`;
  await inviteButton.click();
  const sheet = sp.getByRole('dialog', { name: 'Invite members' });
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Invite by email' }).click();
  await atBothWidths(sp, 'the pod invite sheet', async (w) => { await fits(sp, sheet.getByRole('button', { name: 'Send invite', exact: true }), `Send invite @${w}`, { tap: true }); });
  await sheet.getByLabel('Their email address').fill(address);
  await sheet.getByRole('button', { name: 'Send invite', exact: true }).click();
  await expect(sp.getByText(`Invitation sent to ${address}.`)).toBeVisible({ timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Done' }).click();
  const row = await pool.query<{ code: string }>(`SELECT code FROM invites WHERE pod_id = $1 AND lower(invitee_email) = lower($2)`, [c12, address]);
  expect(row.rows, 'one invitation to that address, for Curious 12').toHaveLength(1);
  const code = row.rows[0].code;

  // The outsider signs up with that address and accepts the link at 360px: Curious 12, its discussion, and no more.
  newcomer = await throwaway('Newcomer', 'member', address);
  const np = await signedIn(newcomer, SMALL);
  await gotoRetry(np, `${APP}/invite/${code}`);
  const accept = np.getByRole('button', { name: 'Accept Invite' });
  await expect(np.getByText('You\'re invited!')).toBeVisible({ timeout: 30_000 });
  await atBothWidths(np, 'the invitation page', async (w) => { await fits(np, accept, `Accept Invite @${w}`); });
  await accept.click();
  await np.waitForURL(new RegExp(`/pods/${c12}$`), { timeout: 30_000 });
  await expect(np.getByRole('heading', { name: C12 })).toBeVisible({ timeout: 30_000 });
  await expect(np.getByTestId('pod-wall').getByText(words), 'the invited member reads the discussion').toBeVisible({ timeout: 30_000 });
  await atBothWidths(np, 'the new member\'s pod page', async (w) => {
    await fits(np, np.getByRole('textbox', { name: 'Write something to the pod…' }), `the discussion box @${w}`);
  });
  await expect(sp.locator('#pod-members').getByText(newcomer.displayName).first(),'Shirley\'s page lists the new member without a reload').toBeVisible({ timeout: 30_000 });
  await expectNotReloaded(sp, 'Shirley\'s pod page');
  // Joining Curious 12 lets them into Curious 12 only.
  await gotoRetry(np, `${APP}/pods/${edge}`);
  await expect(np.getByRole('heading', { name: 'Pod not found' })).toBeVisible({ timeout: 30_000 });
  expect((await api(newcomer, 'GET', `/pods/${edge}`)).status).toBe(404);

  // ── Nonmembers: the Outsider (in nothing) and One (in the circle and Human Edge, not Curious 12) ─────────────
  for (const [who, label] of [[x, 'the outsider'], [o, 'a circle member outside the pod']] as const) {
    const browse = await api(who, 'GET', '/pods?browse=true');
    expect(browse.status).toBe(200);
    expect(JSON.stringify(browse.json), `${label}: not in the pods list`).not.toContain(c12);
    const circle = await api(who, 'GET', `/circles/${circleId}`);
    expect(JSON.stringify(circle.json), `${label}: not on the circle`).not.toContain(c12);
    const profile = await api(who, 'GET', `/people/${s.id}/communities?limit=50`);
    expect(profile.status).toBe(200);
    expect(JSON.stringify(profile.json), `${label}: not on Shirley's profile`).not.toContain(c12);
    for (const [p, status] of [[`/pods/${c12}`, 404], [`/circles/of-pod/${c12}`, 404], [`/pods/${c12}/wall/posts`, 404], [`/pods/${c12}/members`, 403]] as const) {
      const read = await api(who, 'GET', p);
      expect(read.status, `${label}: ${p}`).toBe(status);
      expect(read.text, `${label}: ${p} never carries the discussion`).not.toContain(words);
    }
    const bells = await pool.query(
      `SELECT 1 FROM notifications WHERE user_id = $1
          AND (COALESCE(link, '') LIKE '%' || $2 || '%' OR COALESCE(title, '') || ' ' || COALESCE(body, '') LIKE '%' || $3 || '%')`,
      [who.id, c12, C12],
    );
    expect(bells.rowCount, `${label}: no bell points at it`).toBe(0);
  }
  // A member of both pods sees both on the circle; One sees Human Edge only.
  const bothCircle = JSON.stringify((await api(b, 'GET', `/circles/${circleId}`)).json);
  expect(bothCircle).toContain(c12);
  expect(bothCircle).toContain(edge);
  expect(JSON.stringify((await api(o, 'GET', `/circles/${circleId}`)).json)).toContain(edge);

  // On screen at 360px: the outsider's view of Shirley's profile, the circle, the pod and a link to its post.
  const xp = await signedIn(x, SMALL);
  await gotoRetry(xp, `${APP}/people/${s.id}`);
  await expect(xp.getByText(s.displayName).first()).toBeVisible({ timeout: 30_000 });
  await expect(xp.getByText(C12), 'Shirley\'s profile does not name it').toHaveCount(0);
  await gotoRetry(xp, `${APP}/circles/${circleId}`);
  await expect(xp.getByRole('heading', { name: CIRCLE })).toBeVisible({ timeout: 30_000 });
  await expect(xp.getByText(C12), 'the circle does not name it').toHaveCount(0);
  await gotoRetry(xp, `${APP}/pods/${c12}?post=${postId}`);
  await expect(xp.getByRole('heading', { name: 'Pod not found' })).toBeVisible({ timeout: 30_000 });
  await expect(xp.getByText(words)).toHaveCount(0);
  await expect(xp.getByText(C12)).toHaveCount(0);
  await atBothWidths(xp, 'the outsider\'s "Pod not found"', async (w) => { await fits(xp, xp.getByRole('heading', { name: 'Pod not found' }), `the notice @${w}`); });
  const op = await signedIn(o, SMALL);
  await gotoRetry(op, `${APP}/circles/${circleId}`);
  await expect(op.getByTestId('circle-pods').getByText(EDGE)).toBeVisible({ timeout: 30_000 });
  await expect(op.getByText(C12), 'One\'s circle page does not name it').toHaveCount(0);
  await gotoRetry(op, `${APP}/pods/${c12}`);
  await expect(op.getByRole('heading', { name: 'Pod not found' })).toBeVisible({ timeout: 30_000 });
  await expect(op.getByText(words)).toHaveCount(0);
});

// ── 03 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const voiceIn = async (conversationId: string) => Number((await pool.query<{ n: string }>(
  `SELECT COUNT(*)::text AS n FROM direct_messages WHERE conversation_id = $1 AND attachment_type = 'audio'`, [conversationId],
)).rows[0].n);
const audioBubbles = (page: Page) => page.locator('[data-testid^="dm-audio-message-"]');

test(`03 messaging is safely isolated: a note recorded to Person A and stopped never reaches Person B (${engineLabel()})`, async () => {
  test.skip(WEBKIT, `${NO_MEDIA}; the recorder runs on Chromium (phone and desktop widths), iOS Safari's on Ali's phone`);
  test.setTimeout(300_000);
  const s = shirley!; const a = both!; const bee = one!;

  // Person A and Person B each have their conversation with Shirley open, never reloaded.
  const ap = await signedIn(a, DESKTOP);
  const bp = await signedIn(bee, DESKTOP);
  await openThread(ap, convBoth, s.displayName);
  await openThread(bp, convOne, s.displayName);
  await markNotReloaded(ap);
  await markNotReloaded(bp);
  const aBefore = await voiceIn(convBoth);

  // Shirley, on a phone. Cloudinary's upload is answered by a stand-in so nothing is stored there; the server's own
  // Cloudinary-host check still runs on the address.
  const page = await signedIn(s, PHONE);
  await page.route('https://api.cloudinary.com/**', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ secure_url: `https://res.cloudinary.com/demo/video/upload/v1/e2e-s9-${RUN}.webm`, duration: 2.4, bytes: 4096, format: 'webm' }),
    });
  });
  await openThread(page, convBoth, a.displayName);
  const main = page.getByRole('main');

  // Record a note to Person A, stop without sending.
  await main.getByRole('button', { name: 'Record a voice note' }).click();
  await expect(page.getByTestId('dm-recording-bar')).toBeVisible({ timeout: 15_000 });
  await atBothWidths(page, 'the recording bar', async (w) => { await fits(page, page.getByTestId('dm-recording-stop'), `Stop @${w}`, { tap: true }); });
  await wait(1_500);
  await page.getByTestId('dm-recording-stop').click();
  const draft = page.getByTestId('dm-voice-draft');
  await expect(draft).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('dm-voice-draft-status')).toHaveText('Not sent');
  await expect(draft).toContainText(`Voice note to ${a.displayName}`);
  await expect(page.getByTestId('dm-voice-send')).toHaveText('Send voice note');
  await expect(page.getByTestId('dm-audio-preview'), 'the timer says how long the take is').toContainText(/0:00 \/ 0:0[1-9]/);
  await atBothWidths(page, 'the unsent note', async (w) => {
    await fits(page, page.getByTestId('dm-voice-send'), `Send voice note @${w}`, { tap: true });
    await fits(page, page.getByTestId('dm-voice-discard'), `Discard @${w}`, { tap: true });
  });
  await expect(page.getByTestId('dm-voice-draft-status'), 'still the same unsent note after the resizes').toHaveText('Not sent');

  // Open Person B: no note, no recording, an empty box; nothing stored for B; B's own page shows nothing.
  await openPartner(page, bee.displayName);
  await expect(draft, 'no voice note in B\'s box').toHaveCount(0);
  await expect(page.getByTestId('dm-recording-bar'), 'no recording in B\'s box').toHaveCount(0);
  await expect(main.getByText('Not sent'), 'nothing says Not sent').toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Send voice note' })).toHaveCount(0);
  await expect(main.locator('textarea'), 'B\'s text box is empty').toHaveValue('');
  expect(await voiceIn(convOne), 'no voice message stored to B').toBe(0);
  expect(await voiceIn(convBoth), 'nothing sent to A either, yet').toBe(aBefore);
  const bSide = await api(bee, 'GET', `/dm/conversations/${convOne}/messages`);
  expect(bSide.status).toBe(200);
  expect((bSide.json.data as Array<{ attachmentType?: string | null }>).filter((msg) => msg.attachmentType === 'audio'), 'B has received no voice message').toHaveLength(0);
  await expect(audioBubbles(bp), 'B\'s own page shows no voice note').toHaveCount(0);
  await atBothWidths(page, 'B\'s thread', async (w) => { await fits(page, main.getByRole('button', { name: 'Record a voice note' }), `Record @${w}`); });

  // Back to Person A: the note is still there, still not sent; sent, it reaches A alone.
  await openPartner(page, a.displayName);
  await expect(page.getByTestId('dm-voice-draft-status'), 'kept in A\'s thread only').toHaveText('Not sent', { timeout: 15_000 });
  await page.getByTestId('dm-voice-send').click();
  await expect(page.getByText(`Voice note sent to ${a.displayName}.`)).toBeVisible({ timeout: 30_000 });
  await expect(draft).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => voiceIn(convBoth), { timeout: 30_000, message: 'exactly one voice message to A' }).toBe(aBefore + 1);
  await wait(3_000);
  expect(await voiceIn(convBoth), 'still exactly one').toBe(aBefore + 1);
  expect(await voiceIn(convOne), 'none to B, ever').toBe(0);
  await expect(audioBubbles(ap), 'A\'s page shows the note without a reload').toHaveCount(aBefore + 1, { timeout: 30_000 });
  await expect(audioBubbles(bp), 'B\'s page still shows none').toHaveCount(0);
  await expectNotReloaded(ap, 'A\'s thread');
  await expectNotReloaded(bp, 'B\'s thread');
  await page.unrouteAll({ behavior: 'wait' });
});

// ── 04 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tiles whose <video> shows real frames from the (fake) camera. */
const playingTiles = (page: Page) => page.locator('[data-testid="meeting-tile"] video').evaluateAll((vs) =>
  (vs as HTMLVideoElement[]).filter((v) => v.readyState >= 2 && v.videoWidth > 0).length);
const badgeOf = (page: Page) => page.getByText(/^(Ended|Live now|Upcoming)$/).first();

test(`04 an event works from start to finish: scheduled in the pod, members invited, the native room, ended, back to the discussion (${engineLabel()})`, async () => {
  test.setTimeout(600_000);
  const s = shirley!; const b = both!; const o = one!; const x = outsider!;
  const title = `Curious evening ${RUN}`;

  // ── Schedule a pod event from Curious 12 ──────────────────────────────────────────────────────────────────
  const sp = await signedIn(s, DESKTOP);
  const bp = await signedIn(b, PHONE);
  await gotoRetry(bp, `${APP}/pods/${c12}`);
  await expect(bp.getByRole('heading', { name: C12 })).toBeVisible({ timeout: 30_000 });
  await markNotReloaded(bp);
  await gotoRetry(sp, `${APP}/pods/${c12}`);
  const schedule = sp.getByRole('button', { name: 'Schedule Event' });
  await atBothWidths(sp, 'the director\'s pod page', async (w) => { await fits(sp, schedule, `Schedule Event @${w}`); });
  await schedule.click();
  await sp.waitForURL(new RegExp(`/sessions/new\\?podId=${c12}`), { timeout: 30_000 });
  await expect(sp.getByText(`In ${C12} · Reason Pod`)).toBeVisible({ timeout: 30_000 });
  await expect(sp.getByRole('radio', { name: /^Video meeting/ }), 'a REASON pod meets on video').toBeChecked();
  await sp.getByLabel('Title', { exact: true }).fill(title);
  const submit = sp.getByRole('button', { name: 'Schedule Event' });
  await atBothWidths(sp, 'the event form', async (w) => { await fits(sp, submit, `Schedule Event (form) @${w}`); });
  const created = sp.waitForResponse((r) => new URL(r.url()).pathname === '/api/sessions' && r.request().method() === 'POST');
  await submit.click();
  const answer = await created;
  expect(answer.status()).toBe(201);
  const event = (await answer.json()).data as { id: string; podId: string; format: string };
  const sessionId = event.id;
  expect(event).toMatchObject({ podId: c12, format: 'video_meeting' });
  expect(await statusOf(sessionId), 'scheduled, not a draft').toBe('scheduled');

  // ── Invite the pod's members from the sheet the form opens ─────────────────────────────────────────────────
  await sp.waitForURL(new RegExp(`/sessions/${sessionId}\\?invite=1$`), { timeout: 30_000 });
  const sheet = sp.getByRole('dialog', { name: 'Invite people' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByRole('button', { name: /^This pod/ })).toHaveAttribute('aria-pressed', 'true');
  const everyone = sheet.getByRole('button', { name: new RegExp(`^Invite everyone in ${escapeRe(C12)} \\(`) });
  await atBothWidths(sp, 'the event invite sheet', async (w) => { await fits(sp, everyone, `Invite everyone @${w}`, { tap: true }); });
  await everyone.click();
  await expect(sp.getByText(/\d+ invitations? sent\./).first()).toBeVisible({ timeout: 20_000 });
  await sheet.getByRole('button', { name: 'Done' }).click();
  await expect(sheet).toHaveCount(0);

  // Both's bell rings without a reload; nobody outside the pod is rung.
  await expect.poll(async () => (await pool.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'event_invite'`, [b.id])).rowCount,
    { timeout: 30_000, message: 'Both is invited' }).toBeGreaterThanOrEqual(1);
  const rungOutside = await pool.query(`SELECT user_id FROM notifications WHERE user_id = ANY($1) AND type = 'event_invite'`, [idsOf(o, x, stefan)]);
  expect(rungOutside.rows, 'nobody outside Curious 12 is invited').toEqual([]);
  await acceptFromBell(bp, new RegExp(`${escapeRe(title)}|${escapeRe(C12)}`));
  await bp.waitForURL(new RegExp(`/sessions/${sessionId}`), { timeout: 30_000 });
  await expectNotReloaded(bp, 'Both\'s page (the bell)');
  await expect.poll(async () => (await pool.query<{ status: string }>(
    'SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2', [sessionId, b.id])).rows[0]?.status,
  { timeout: 30_000, message: 'accepting registers Both' }).toBe('registered');
  await expect(bp.getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 });
  await atBothWidths(bp, 'the event page', async (w) => { await fits(bp, bp.getByRole('link', { name: 'Back to pod' }), `Back to pod (event page) @${w}`); });

  // Outside the pod: not listed, not let in, and its page says so (360px).
  for (const [who, label] of [[o, 'One'], [x, 'the outsider']] as const) {
    const listed = await api(who, 'GET', '/sessions');
    expect(JSON.stringify(listed.json), `${label}: not in the events list`).not.toContain(sessionId);
    expect((await api(who, 'POST', `/sessions/${sessionId}/register`)).status, `${label}: cannot register`).toBeGreaterThanOrEqual(400);
  }
  const xp = await signedIn(x, SMALL);
  await gotoRetry(xp, `${APP}/sessions/${sessionId}`);
  await expect(xp.getByTestId('event-private-title').or(xp.getByRole('heading', { name: 'Access restricted' })), 'the event page refuses them').toBeVisible({ timeout: 30_000 });
  await expect(xp.getByText(title)).toHaveCount(0);
  const op = await signedIn(o, SMALL);
  await gotoRetry(op, `${APP}/circles/${circleId}`);
  await expect(op.getByRole('heading', { name: CIRCLE })).toBeVisible({ timeout: 30_000 });
  await expect(op.getByText(title), 'the circle does not show a private pod\'s event to a non-member').toHaveCount(0);

  // ── The native room, the end, and back to the discussion ──────────────────────────────────────────────────
  if (WEBKIT) {
    test.info().annotations.push({ type: 'skipped step', description: `Inside the LiveKit room: ${NO_MEDIA}. The meeting is started and ended from Shirley's host socket; Both follows it on the event page.` });
    const host = await connectSocket(s);
    sockets.push(host);
    host.emit('session:join', { sessionId });
    host.emit('host:start_session', { sessionId });
    await expect.poll(() => statusOf(sessionId), { timeout: 30_000, message: 'the meeting is live' }).toBe('lobby_open');
    await expect(badgeOf(bp), 'Both sees it live without a reload').toHaveText('Live now', { timeout: 30_000 });
    host.emit('host:end_session', { sessionId, endEvent: true });
    await expect.poll(() => statusOf(sessionId), { timeout: 60_000, message: 'the meeting is completed' }).toBe('completed');
    await expect(badgeOf(bp), 'Both sees it end without a reload').toHaveText('Ended', { timeout: 30_000 });
    await expectNotReloaded(bp, 'Both\'s event page');
    await bp.getByRole('link', { name: 'Back to pod' }).click();
    await gotoRetry(sp, `${APP}/pods/${c12}`);
  } else {
    await gotoRetry(sp, `${APP}/session/${sessionId}/live`);
    await gotoRetry(bp, `${APP}/session/${sessionId}/live`);
    await expect(bp.getByText(`Waiting for ${s.displayName} to start the meeting`), 'Both waits for Shirley by name').toBeVisible({ timeout: 60_000 });
    const start = sp.getByRole('button', { name: /Start meeting/ });
    await expect(start).toBeVisible({ timeout: 60_000 });
    await start.click();
    await expect.poll(() => statusOf(sessionId), { timeout: 30_000, message: 'the meeting is live' }).toBe('lobby_open');
    for (const [page, who] of [[sp, 'Shirley'], [bp, 'Both']] as const) {
      await expect.poll(() => playingTiles(page), { timeout: 90_000, message: `${who}: both cameras play` }).toBe(2);
    }
    await atBothWidths(bp, 'the meeting room', async (w) => { await fits(bp, bp.getByTestId('meeting-leave'), `Leave @${w}`, { tap: true }); });
    await expect(bp.getByTestId('meeting-end'), 'a guest cannot end it').toHaveCount(0);
    await sp.getByTestId('meeting-end').click();
    const endDialog = sp.getByRole('alertdialog', { name: 'End the meeting for everyone?' });
    await expect(endDialog).toContainText('Everyone will be disconnected.');
    await endDialog.getByRole('button', { name: 'End for everyone' }).click();
    for (const [page, who] of [[sp, 'Shirley'], [bp, 'Both']] as const) {
      await expect(page.getByRole('heading', { name: 'Meeting ended' }), `${who}: Meeting ended`).toBeVisible({ timeout: 30_000 });
    }
    await expect.poll(() => statusOf(sessionId), { timeout: 30_000, message: 'the event is completed' }).toBe('completed');
    const back = bp.getByRole('button', { name: 'Back to pod' });
    await atBothWidths(bp, 'the meeting\'s end', async (w) => { await fits(bp, back, `Back to pod @${w}`, { tap: true }); });
    await back.click();
    await sp.getByRole('button', { name: 'Back to pod' }).click();
  }

  // Back in the pod's discussion: Both writes, Shirley's page shows it without a reload.
  for (const page of [bp, sp]) {
    await expect(page, 'back on the pod').toHaveURL(new RegExp(`/pods/${c12}$`), { timeout: 30_000 });
    await expect(page.locator('#pod-discussion').getByRole('heading', { name: 'Discussion' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('pod-wall')).toBeVisible({ timeout: 30_000 });
  }
  await markNotReloaded(sp);
  const thanks = `Thank you all, that was a good evening (${RUN})`;
  const box = bp.getByRole('textbox', { name: 'Write something to the pod…' });
  await atBothWidths(bp, 'the pod discussion', async (w) => {
    await fits(bp, box, `the discussion box @${w}`);
  });
  await box.fill(thanks);
  await bp.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(sp.getByTestId('pod-wall').getByText(thanks), 'Shirley reads it without a reload').toBeVisible({ timeout: 30_000 });
  await expectNotReloaded(sp, 'Shirley\'s pod page');
});

// ── 05 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A 30-minute slot some days out at a local hour: on the scheduler's grid, never past (the scheduler spec's rule). */
function futureSlot(daysAhead: number, hour: number): string {
  const dt = new Date();
  dt.setHours(hour, 0, 0, 0);
  dt.setDate(dt.getDate() + daysAhead);
  return dt.toISOString().replace('.000Z', 'Z');
}
const compact = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Opens the thread's scheduler: "Find a time to meet", from "More actions" where the phone keeps it. */
async function openScheduler(page: Page): Promise<void> {
  const findTime = page.getByRole('button', { name: /Find a time to meet/i });
  const more = page.getByRole('button', { name: 'More actions' });
  await findTime.or(more).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (await more.isVisible().catch(() => false)) await more.click();
  await findTime.filter({ visible: true }).first().click();
  await expect(page.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('slot-grid').getByText('They can').first(), 'the time Both offered is on the grid').toBeVisible({ timeout: 20_000 });
}

test(`05 calendar booking does not duplicate: one slot, one valid invitation each, and Shirley stays in REASON (${engineLabel()})`, async () => {
  test.setTimeout(360_000);
  const s = shirley!; const b = both!;
  const KEY = futureSlot(3, 14);

  // Both offers one time; their thread with Shirley stays open, never reloaded.
  expect((await api(b, 'PUT', `/dm/conversations/${convBoth}/scheduling/availability`, { windows: [KEY] })).status).toBe(200);
  const bp = await signedIn(b, PHONE);
  await openThread(bp, convBoth, s.displayName);
  await markNotReloaded(bp);

  // Shirley books it from the thread. Everything her page does is watched for a step outside REASON.
  const page = await signedIn(s, DESKTOP);
  const left: string[] = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame() && f.url() !== 'about:blank' && !f.url().startsWith(APP)) left.push(`navigated to ${f.url()}`); });
  page.context().on('page', (p) => { left.push(`opened a window at ${p.url()}`); });
  page.on('request', (r) => {
    if (/login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|accounts\.google\.com|graph\.microsoft\.com/.test(r.url())) left.push(`asked ${r.url()}`);
  });
  await openThread(page, convBoth, b.displayName);
  await openScheduler(page);
  await expect(page.getByRole('dialog').filter({ hasText: /Outlook|Microsoft/ }), 'no calendar sign-in is asked for').toHaveCount(0);
  const save = page.getByRole('button', { name: /Save and send availability/i });
  const schedulerOpen = () => page.getByTestId('meeting-scheduler').isVisible().catch(() => false);
  // "Save and send availability" appears only once a time is chosen (SchedulerSaveBar shows it while unsaved), so the
  // time is chosen first at each width, and only if the choice is not already standing (a second tap would undo it).
  const slot = page.locator(`[data-slot="${KEY}"]`);
  const chooseTheTime = async () => {
    if (!(await schedulerOpen())) await openScheduler(page);
    if (await save.isVisible().catch(() => false)) return;
    await slot.scrollIntoViewIfNeeded();
    await slot.click();
    await expect(save).toBeVisible({ timeout: 10_000 });
  };
  await atBothWidths(page, 'the scheduler', async (w) => {
    await chooseTheTime();
    await fits(page, save, `Save and send availability @${w}`);
  });
  await chooseTheTime();
  await save.click();
  // Saving a time the other person already offered books it: the thread gains the "Meeting confirmed" card (there is
  // no separate toast; the card and the booking's API answer below are the proof).
  await expect(page.getByTestId('system-message-card').filter({ hasText: /Meeting confirmed/i }).last()).toBeVisible({ timeout: 30_000 });

  // Booked: the thread says the invitation went by email, with Join and a quiet Add manually.
  const card = page.getByTestId('system-message-card').filter({ hasText: /Meeting confirmed/i }).last();
  await expect(card.getByTestId('invite-line')).toHaveText('Calendar invitation sent by email.', { timeout: 30_000 });
  const join = card.getByRole('button', { name: /Join meeting/ });
  const add = card.getByRole('button', { name: 'Add manually' });
  await atBothWidths(page, 'the booked meeting', async (w) => {
    await fits(page, join, `Join meeting @${w}`, { tap: true });
    await fits(page, add, `Add manually @${w}`, { tap: true });
  });
  const sched = await api(s, 'GET', `/dm/conversations/${convBoth}/scheduling`);
  const confirmed = sched.json.data.confirmed as { window: string; meetingId: string; durationMin: number | null; type: 'audio' | 'video' | null; inviteEmail: string };
  expect(confirmed.window, 'the one time Both offered is booked').toBe(KEY);
  expect(confirmed.inviteEmail).toBe('sent');
  const meetingId = confirmed.meetingId;
  expect(meetingId).toBeTruthy();

  // Exactly one invitation each, logged as sent; a repeated confirm sends nothing more.
  const invitations = async () => (await pool.query<{ user_id: string; status: string }>(
    `SELECT user_id, status FROM meeting_invite_emails WHERE meeting_id = $1 ORDER BY user_id`, [meetingId],
  )).rows;
  const pair = [s.id, b.id].sort();
  await expect.poll(async () => (await invitations()).map((r) => `${r.user_id}:${r.status}`), { timeout: 30_000, message: 'one invitation each, sent' })
    .toEqual(pair.map((id) => `${id}:sent`));
  const again = await api(s, 'POST', `/dm/conversations/${convBoth}/scheduling/confirm`, {
    window: KEY, durationMin: confirmed.durationMin ?? 30, type: confirmed.type ?? 'video', expectedWindow: KEY,
  });
  expect(again.status, JSON.stringify(again.json)).toBe(200);
  await wait(3_000);
  expect(await invitations(), 'still one invitation each').toHaveLength(2);
  const still = (await api(s, 'GET', `/dm/conversations/${convBoth}/scheduling`)).json.data.confirmed as { window: string; meetingId: string };
  expect(still, 'the same one meeting, at the same time').toMatchObject({ window: KEY, meetingId });

  // Both's page shows the booking without a reload, with their own invitation said.
  const theirCard = bp.getByTestId('system-message-card').filter({ hasText: /Meeting confirmed/i }).last();
  await expect(theirCard, 'Both sees the booking without a reload').toBeVisible({ timeout: 30_000 });
  await expect(theirCard.getByTestId('invite-line')).toHaveText('Calendar invitation sent by email.', { timeout: 30_000 });
  await expectNotReloaded(bp, 'Both\'s thread');

  // The invitation is a valid calendar file for that time, pointing back into REASON: the download on Shirley's page,
  // and Both's own copy.
  await add.click();
  const menu = page.getByTestId('add-to-calendar-menu');
  await expect(menu.getByRole('menuitem').first()).toContainText('Download calendar file (.ics)');
  await expect(page.getByTestId('calendar-note')).toHaveText('You already have this in your email. Adding it here may create a second entry.');
  const download = page.waitForEvent('download');
  await menu.getByTestId('calendar-ics').click();
  const file = await download;
  const ics = fs.readFileSync((await file.path())!, 'utf8').replace(/\r?\n[ \t]/g, '');
  const theirs = await api(b, 'GET', `/meetings/${meetingId}/calendar.ics`);
  expect(theirs.status).toBe(200);
  for (const [text, whose] of [[ics, 'Shirley\'s download'], [theirs.text.replace(/\r?\n[ \t]/g, ''), 'Both\'s copy']] as const) {
    expect(text, `${whose}: a calendar`).toContain('BEGIN:VCALENDAR');
    expect(text.match(/BEGIN:VEVENT/g), `${whose}: one event`).toHaveLength(1);
    expect(text, `${whose}: an invitation`).toContain('METHOD:REQUEST');
    expect(text, `${whose}: this meeting`).toContain(`UID:meeting-${meetingId}@rsn.network`);
    expect(text, `${whose}: the booked time`).toContain(`DTSTART:${compact(KEY)}`);
    expect(text, `${whose}: joined in REASON`).toContain(`/meet/${convBoth}`);
  }
  await page.keyboard.press('Escape');

  // Shirley never left REASON: no other site, no popup, no Microsoft or Google sign-in.
  expect(left, 'Shirley stayed in REASON throughout').toEqual([]);
  expect(new URL(page.url()).origin).toBe(new URL(APP).origin);
  expect(new URL(page.url()).pathname).toBe(`/messages/${convBoth}`);
});
