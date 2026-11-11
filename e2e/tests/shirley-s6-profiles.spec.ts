import { test, expect, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { pool } from '../helpers/auth';
import { APP, SERVER, cleanup, gotoRetry, teardown } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';

// SHIRLEY PILOT S6 (RSN 12, RSN 13): profiles people can preview and share, on production.
//
// Throwaway members (<run>@rsn-e2e.invalid), made in SQL and deleted by id at the end:
//   owner     the member whose profile is previewed and shared; private answers seeded with SECRET- words
//   stranger  a member with no connection to the owner
//   blocker   a member who has blocked the owner;   blockee   a member the owner has blocked
//   closed    a closed account that had a public link;   guest   an event guest
//
// Over the API: GET /users/:id answers a block (either way) exactly as it answers an unknown id; the preview is the brief
// a stranger is sent; the public link is made, opened signed out (public card only), replaced (the old one is the
// unknown 404), turned off (404), paused while hidden from search, refused to a guest, dead for a closed account and a
// blocked reader, and never appears in any other read. LinkedIn is saved in https. On the screens: at 360px the banner
// control and its size and crop hints, the photo opening the editor, the account menu (six rows of 44px, Escape), the
// preview, the public link made, opened signed out and turned off with a confirm; an iPhone-sized account menu; 1280px
// with no horizontal scroll.

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const RUN = Date.now().toString(36);
const WANT = `SECRET-WANT founders building climate hardware ${RUN}`;
const INTENT = `SECRET-INTENT raise a seed round ${RUN}`;
const OWNER_NAME = `S6 Owner ${RUN}`;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000006';

interface Person { id: string; email: string; token: string; refresh: string }

async function makePerson(label: string, opts: { kind?: 'member' | 'event_guest'; visible?: boolean; role?: 'member' | 'admin' } = {}): Promise<Person> {
  const id = uuid();
  const email = `s6-${label}-${RUN}@rsn-e2e.invalid`;
  const kind = opts.kind ?? 'member';
  await pool.query(
    `INSERT INTO users (id, email, display_name, first_name, last_name, status, role, profile_complete, onboarding_completed,
                        onboarding_status, onboarding_version, email_verified, company, job_title, industry, location,
                        account_kind, profile_visible)
     VALUES ($1, $2, $3, $4, 'Test', 'active', $7, true, true, 'completed', 2, true, 'TestCo', 'Test Account', 'Tech',
             'Lisbon, Portugal', $5, $6)`,
    [id, email, label === 'owner' ? OWNER_NAME : `S6 ${label} ${RUN}`, label === 'owner' ? 'Owner' : label, kind, opts.visible ?? kind === 'member', opts.role ?? 'member'],
  );
  const sessionId = uuid();
  const token = jwt.sign({ sub: id, email, role: opts.role ?? 'member', displayName: label, sessionId }, SECRET, { expiresIn: '1h' });
  const refresh = jwt.sign({ sub: id, sessionId, type: 'refresh' }, SECRET, { expiresIn: '1d' });
  return { id, email, token, refresh };
}

async function call(method: string, p: string, opts: { as?: Person; body?: unknown } = {}) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.as ? { Authorization: `Bearer ${opts.as.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

const openLink = (token: string, as?: Person) => call('GET', `/public/profiles/${encodeURIComponent(token)}`, { as });

let owner: Person | undefined;
let stranger: Person | undefined;
let blocker: Person | undefined;
let blockee: Person | undefined;
let closed: Person | undefined;
let guest: Person | undefined;
let admin: Person | undefined;
let browser: Browser | undefined;
const contexts: BrowserContext[] = [];
const people = () => [owner, stranger, blocker, blockee, closed, guest, admin].filter((p): p is Person => !!p);

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) is needed to sign the throwaway members').toBeTruthy();
  owner = await makePerson('owner');
  stranger = await makePerson('stranger');
  blocker = await makePerson('blocker');
  blockee = await makePerson('blockee');
  closed = await makePerson('closed');
  guest = await makePerson('guest', { kind: 'event_guest' });
  admin = await makePerson('admin', { role: 'admin' });
  await pool.query(
    `UPDATE users SET bio = $2, what_i_can_help_with = $3, who_i_want_to_meet = $4, my_intent = $5, interests = $6,
                      linkedin_url = NULL
      WHERE id = $1`,
    [owner.id, 'Curious about humans.', 'Hosting circles for curious people', WANT, INTENT, [`SECRET-INTEREST-${RUN}`]],
  );
  // The owner also blocks an admin: the admin inspector must still see them (S6 fix round 1).
  await pool.query(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2), ($3, $4), ($3, $5)`,
    [blocker.id, owner.id, owner.id, blockee.id, admin.id]);
  console.log(`[shirley-s6] engine=${engineLabel()} app=${APP} api=${SERVER}`);
});

test.afterAll(async () => {
  const ids = people().map((p) => p.id);
  await teardown(
    async () => { for (const c of contexts) await c.close().catch(() => {}); },
    async () => { await browser?.close().catch(() => {}); },
    () => pool.query(`DELETE FROM user_blocks WHERE blocker_id = ANY($1::uuid[]) OR blocked_id = ANY($1::uuid[])`, [ids]),
    () => cleanup(pool, { ids }),
  );
});

// ── The API ──────────────────────────────────────────────────────────────────────────────────

test('GET /users/:id answers a block, either way, exactly as it answers an unknown id', async () => {
  const unknown = await call('GET', `/users/${UNKNOWN_ID}`, { as: stranger });
  expect(unknown.status).toBe(404);
  for (const viewer of [blocker!, blockee!]) {
    const res = await call('GET', `/users/${owner!.id}`, { as: viewer });
    expect(res.status, viewer.email).toBe(404);
    expect(res.json).toEqual(unknown.json);
  }
  // An admin the owner blocked: the member-facing read is the same 404, the admin inspector's own read is not.
  expect((await call('GET', `/users/${owner!.id}`, { as: admin })).json).toEqual(unknown.json);
  const inspector = await call('GET', `/admin/users/${owner!.id}`, { as: admin });
  expect(inspector.status, JSON.stringify(inspector.json)).toBe(200);
  expect(inspector.json.data).toMatchObject({ id: owner!.id, email: owner!.email, displayName: OWNER_NAME });
  expect((await call('GET', `/admin/users/${owner!.id}`, { as: stranger })).status).toBe(403);
  const open = await call('GET', `/users/${owner!.id}`, { as: stranger });
  expect(open.status).toBe(200);
  expect(JSON.stringify(open.json)).not.toMatch(/SECRET-/);
});

test('the preview is the brief a member with no connection is sent, and carries nothing private', async () => {
  const preview = await call('GET', '/people/me/preview', { as: owner });
  expect(preview.status, JSON.stringify(preview.json)).toBe(200);
  const brief = await call('GET', `/people/${owner!.id}/brief`, { as: stranger });
  expect(brief.status).toBe(200);
  const p = preview.json.data;
  const b = brief.json.data;
  expect(p.person).toEqual(b.person);
  expect(p.theyCanBring).toBe(b.theyCanBring);
  expect(p.entities).toEqual(b.entities);
  expect(p.relationship).toEqual(b.relationship);
  expect(p.relationship.state).toBe('none');
  expect(p.youAreLookingFor).toBeNull();
  expect(JSON.stringify(p)).not.toMatch(/SECRET-|rsn-e2e\.invalid/);
});

test('the public link: made, opened signed out, replaced, turned off, paused, refused and never leaked', async () => {
  test.setTimeout(120_000);
  const never = await openLink('NeverMadeNeverMadeNeve');
  expect(never.status).toBe(404);
  const NOT_AVAILABLE = never.json;

  // Made once; a second press keeps it.
  expect((await call('GET', '/users/me/public-link', { as: owner })).json.data).toEqual({ link: null, paused: null });
  const made = await call('POST', '/users/me/public-link', { as: owner });
  expect(made.status, JSON.stringify(made.json)).toBe(200);
  const first: string = made.json.data.link.token;
  expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(made.json.data.link.path).toBe(`/p/${first}`);
  expect((await call('POST', '/users/me/public-link', { as: owner })).json.data.link.token).toBe(first);

  // Signed out: the public card only.
  const page = await openLink(first);
  expect(page.status).toBe(200);
  expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(page.headers.get('cache-control') ?? '').toMatch(/no-store/);
  expect(page.json.data.displayName).toBe(OWNER_NAME);
  expect(page.json.data.canBring).toBe('Hosting circles for curious people');
  expect(page.json.data).not.toHaveProperty('id');
  expect(JSON.stringify(page.json)).not.toMatch(/SECRET-|rsn-e2e\.invalid|profileVisible|whoIWantToMeet|myIntent|interests/);
  expect(JSON.stringify(page.json)).not.toContain(first);

  // The token is in no other read: the owner's own profile reads, another member's, a list.
  for (const [who, p] of [[owner, `/users/${owner!.id}`], [owner, '/users/me'], [owner, '/people/me/card'], [owner, '/people/me/preview'],
    [stranger, `/users/${owner!.id}`], [stranger, `/people/${owner!.id}/brief`], [stranger, `/people/everyone?q=${encodeURIComponent(OWNER_NAME)}`]] as const) {
    const res = await call('GET', p, { as: who });
    expect(res.status, p).toBe(200);
    expect(JSON.stringify(res.json), p).not.toContain(first);
  }

  // A signed-in reader with no block sees it; a block either way is the unknown 404.
  expect((await openLink(first, stranger)).status).toBe(200);
  expect((await openLink(first, blocker)).json).toEqual(NOT_AVAILABLE);
  expect((await openLink(first, blockee)).json).toEqual(NOT_AVAILABLE);

  // Replaced: only the new one works.
  const remade = await call('POST', '/users/me/public-link/regenerate', { as: owner });
  const second: string = remade.json.data.link.token;
  expect(second).not.toBe(first);
  expect((await openLink(first)).json).toEqual(NOT_AVAILABLE);
  expect((await openLink(second)).status).toBe(200);

  // Hidden from search: paused for the owner, the unknown 404 for everyone; shown again: it opens again.
  expect((await call('PUT', '/users/me', { as: owner, body: { profileVisible: false } })).status).toBe(200);
  expect((await call('GET', '/users/me/public-link', { as: owner })).json.data.paused).toBe('hidden');
  expect((await openLink(second)).json).toEqual(NOT_AVAILABLE);
  expect((await call('PUT', '/users/me', { as: owner, body: { profileVisible: true } })).status).toBe(200);
  expect((await openLink(second)).status).toBe(200);

  // Turned off: the link is the unknown 404, and replacing a link that is off is refused.
  const off = await call('DELETE', '/users/me/public-link', { as: owner });
  expect(off.json.data).toEqual({ link: null, paused: null });
  expect((await openLink(second)).json).toEqual(NOT_AVAILABLE);
  expect((await call('POST', '/users/me/public-link/regenerate', { as: owner })).status).toBe(409);

  // An event guest has no public profile.
  const guestTry = await call('POST', '/users/me/public-link', { as: guest });
  expect(guestTry.status).toBe(403);

  // A closed account's link opens nothing.
  const closedLink = await call('POST', '/users/me/public-link', { as: closed });
  expect(closedLink.status).toBe(200);
  await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [closed!.id]);
  expect((await openLink(closedLink.json.data.link.token)).json).toEqual(NOT_AVAILABLE);
});

test('LinkedIn is saved in https, in the one stored form', async () => {
  const saved = await call('PUT', '/users/me', { as: stranger, body: { linkedinUrl: `http://linkedin.com/in/s6-${RUN}` } });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  const row = await pool.query<{ linkedin_url: string }>(`SELECT linkedin_url FROM users WHERE id = $1`, [stranger!.id]);
  expect(row.rows[0].linkedin_url).toBe(`https://www.linkedin.com/in/s6-${RUN}`);
  const refused = await call('PUT', '/users/me', { as: stranger, body: { linkedinUrl: 'https://evil.example/in/x' } });
  expect(refused.status).toBe(400);
});

// ── The screens ──────────────────────────────────────────────────────────────────────────────

async function signedIn(p: Person, options: Parameters<Browser['newContext']>[0]): Promise<Page> {
  browser ??= await launchBrowser();
  const ctx = await browser.newContext(options);
  contexts.push(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: p.token, r: p.refresh });
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  return page;
}

async function signedOut(options: Parameters<Browser['newContext']>[0]): Promise<Page> {
  browser ??= await launchBrowser();
  const ctx = await browser.newContext(options);
  contexts.push(ctx);
  await primePreview(ctx);
  return ctx.newPage();
}

/** The box is inside the window's width and at least 44px tall. */
async function fits(page: Page, loc: ReturnType<Page['locator']>, what: string): Promise<void> {
  await expect(loc, what).toBeVisible();
  const box = await loc.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box, what).not.toBeNull();
  expect(box!.x, `${what} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what} right edge`).toBeLessThanOrEqual(width + 0.5);
  expect(box!.height, `${what} height`).toBeGreaterThanOrEqual(43.5);
}

async function noSideScroll(page: Page, where: string): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `${where}: no horizontal scroll`).toBeLessThanOrEqual(0);
}

const MENU_ROWS = ['View profile', 'Preview as others see it', 'Copy link', 'Edit profile', 'Settings', 'Log out'];

test('at 360px: banner, photo, account menu, preview and the public link, end to end', async () => {
  test.setTimeout(240_000);
  const phone = { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true };
  const page = await signedIn(owner!, phone);
  await gotoRetry(page, `${APP}/profile`);
  await expect(page.getByRole('heading', { name: OWNER_NAME })).toBeVisible({ timeout: 30_000 });
  await noSideScroll(page, '/profile at 360');

  // The banner control, and the editor's size and crop hints.
  const addBanner = page.getByRole('button', { name: 'Add banner' });
  await fits(page, addBanner, 'Add banner');
  await addBanner.click();
  const hints = page.getByTestId('banner-hints');
  await expect(hints).toContainText('Recommended size: 2400 × 800 px (3:1).');
  await expect(hints).toContainText('Wide screens crop the top and bottom');
  await page.getByRole('button', { name: 'Cancel' }).click();

  // The big photo opens the photo editor.
  await page.getByRole('button', { name: 'Change your photo' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit your photo' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Edit your photo' })).toBeHidden();

  // The LinkedIn prompt while there is none.
  await expect(page.getByTestId('linkedin-prompt-missing')).toBeVisible();

  // The account menu: six rows, each 44px and inside the window; Escape closes it and gives focus back.
  const trigger = page.getByRole('button', { name: 'Account menu' });
  await fits(page, trigger, 'account menu photo');
  await trigger.click();
  const menu = page.getByTestId('account-menu');
  await expect(menu).toBeVisible();
  for (const row of MENU_ROWS) await fits(page, menu.getByText(row, { exact: true }), `menu row ${row}`);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // Preview as others see it, from the menu: the member's view, with nothing private on it.
  await trigger.click();
  await menu.getByText('Preview as others see it', { exact: true }).click();
  await expect(page).toHaveURL(/\/profile\/preview$/);
  await expect(page.getByTestId('preview-notice')).toContainText('a member who has not met you');
  await expect(page.getByTestId('member-preview')).toContainText(OWNER_NAME);
  await expect(page.locator('body')).not.toContainText('SECRET-');
  await noSideScroll(page, '/profile/preview at 360');

  // Make the public link on Your profile.
  await gotoRetry(page, `${APP}/profile`);
  await page.getByTestId('make-public-link').click();
  const url = page.getByTestId('public-link-url');
  await expect(url).toHaveValue(/\/p\/[A-Za-z0-9_-]{22}$/);
  const publicUrl = await url.inputValue();
  await fits(page, page.getByTestId('copy-public-link'), 'Copy public link');
  await noSideScroll(page, '/profile with a public link at 360');

  // The preview now has the public tab.
  await gotoRetry(page, `${APP}/profile/preview`);
  await page.getByTestId('preview-public-tab').click();
  await expect(page.getByTestId('public-card')).toContainText(OWNER_NAME);

  // Signed out, at 360: the public card, no contact, nothing private.
  const outsider = await signedOut(phone);
  await gotoRetry(outsider, publicUrl);
  await expect(outsider.getByTestId('public-card')).toContainText(OWNER_NAME, { timeout: 30_000 });
  await expect(outsider.getByTestId('public-card')).toContainText('Hosting circles for curious people');
  await expect(outsider.locator('body')).not.toContainText('SECRET-');
  await expect(outsider.getByRole('link', { name: /Message|Meet/ })).toHaveCount(0);
  await expect(outsider.getByRole('button', { name: /Message|Meet|Video call/ })).toHaveCount(0);
  await expect(outsider.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await fits(outsider, outsider.getByRole('link', { name: 'Join REASON' }), 'Join REASON');
  await noSideScroll(outsider, '/p/:token at 360');

  // Turn it off, with the confirm; the outsider's next read is "not available".
  await gotoRetry(page, `${APP}/profile`);
  await page.getByTestId('revoke-public-link').click();
  await page.getByRole('dialog', { name: 'Turn off your public link?' }).getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByTestId('make-public-link')).toBeVisible({ timeout: 20_000 });
  await outsider.reload();
  await expect(outsider.getByTestId('public-link-unavailable')).toBeVisible({ timeout: 30_000 });
});

test('on an iPhone: the account menu opens under the photo, fits, and a tap outside closes it', async () => {
  test.setTimeout(120_000);
  const { defaultBrowserType: _engine, ...iphone } = devices['iPhone 14'];
  const page = await signedIn(owner!, iphone);
  await gotoRetry(page, `${APP}/`);
  const trigger = page.getByRole('button', { name: 'Account menu' });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.tap();
  const menu = page.getByTestId('account-menu');
  await expect(menu).toBeVisible();
  const triggerBox = (await trigger.boundingBox())!;
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height);
  for (const row of MENU_ROWS) await fits(page, menu.getByText(row, { exact: true }), `iPhone menu row ${row}`);
  await page.mouse.click(10, page.viewportSize()!.height - 200);
  await expect(menu).toBeHidden();
});

test('at 1280px: the account menu, the preview and Your profile, with no horizontal scroll', async () => {
  test.setTimeout(120_000);
  const page = await signedIn(owner!, { viewport: { width: 1280, height: 900 } });
  await gotoRetry(page, `${APP}/profile`);
  await expect(page.getByRole('heading', { name: OWNER_NAME })).toBeVisible({ timeout: 30_000 });
  await noSideScroll(page, '/profile at 1280');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByTestId('account-menu')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('account-menu')).toBeHidden();
  await gotoRetry(page, `${APP}/profile/preview`);
  await expect(page.getByTestId('member-preview')).toContainText(OWNER_NAME, { timeout: 30_000 });
  await expect(page.locator('body')).not.toContainText('SECRET-');
  await noSideScroll(page, '/profile/preview at 1280');
});
