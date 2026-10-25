import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable, tapReachable } from '../helpers/viewport-fit';
// The made-up people the pictures name: the shared list itself, so a name changed there is followed here.
import { EXAMPLE_PEOPLE } from '../../shared/src/onboarding/example-people';

// ─────────────────────────────────────────────────────────────────────────────
// "How REASON works" (Shradha's deck, task 2; the client's feedback of 19 Oct).
//
// The complaint: members were never told what the product is or how it works,
// and "after onboarding, users are left with no guidance on next steps."
//
// It plays once, over their own suggestions, for someone who has just
// finished. Nobody who onboarded before it existed is interrupted, and it
// stays re-openable from Support afterwards.
//
// 19 Oct: the heading and the description above the picture, and finishing or
// skipping it lands on For You, except when it is replayed from Support, which
// stays where it is.
//
// 25 Oct (Stefan and Claus): the pictures may show people again, as long as it is
// plain they are made up. So: the heading, the description, then "Examples only.
// These are not real members.", then a picture whose people are the shared
// EXAMPLE_PEOPLE (English names and roles, the sheep for a photo), every picture
// carrying an "Example" tag.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE = { width: 390, height: 844 };
let browser: Browser;
const ctxs: BrowserContext[] = [];
const made: string[] = [];

// The people the first pictures showed, with no label. Never back: the examples are the shared list's.
const OLD_EXAMPLE_PEOPLE = /Amara|Okafor|Tomas|Lind\b|Priya|Raman|Northwind|Baltic/;
const CAPTION = 'Examples only. These are not real members.';
const TITLES = ['For You', 'Matches', 'Meetings', 'Circles & events'];
// How many example people each picture names (For You suggests two, Matches shows three) and how many Example tags it
// carries (one on each suggested person; one on the frame of each list).
const PEOPLE_IN_PICTURE = [2, 3, 0, 0];
const TAGS_IN_PICTURE = [2, 1, 1, 1];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const ANSWERS = {
  intent: 'get_advice', lookingToMeet: ['advisors_mentors'], canOffer: ['introductions_network'],
  industries: ['software_ai'], industryOther: null, selfKinds: ['founders'],
  jobTitle: null, company: null, about: null,
};

/** Someone who has just come out of the five steps. */
async function justOnboarded(suffix: string): Promise<TestUser> {
  const u = await createTestUser(suffix, 'member', 'not_started');
  made.push(u.id);
  await pool.query(`UPDATE users SET onboarding_completed = false WHERE id = $1`, [u.id]);
  expect((await apiAs(u, 'POST', '/onboarding/answers/confirm', ANSWERS)).status).toBe(200);
  return u;
}

async function openAs(u: TestUser, path: string, viewport = PHONE): Promise<Page> {
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
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

const tour = (page: Page) => page.getByTestId('how-rsn-works');
const slide = (page: Page) => tour(page).locator('[aria-roledescription="slide"]');
const pathOf = (page: Page) => new URL(page.url()).pathname;

/** The heading, the description and the caption all end above the picture's top edge, in that order. */
async function expectWordsAboveThePicture(page: Page, title: string) {
  const card = slide(page);
  const heading = await card.getByRole('heading', { name: title }).boundingBox();
  const description = await card.locator('p').first().boundingBox();
  const caption = await card.getByText(CAPTION, { exact: true }).boundingBox();
  const picture = await card.getByTestId('tour-picture').boundingBox();
  expect(heading, `${title}: heading not drawn`).not.toBeNull();
  expect(description, `${title}: description not drawn`).not.toBeNull();
  expect(caption, `${title}: the caption is not drawn`).not.toBeNull();
  expect(picture, `${title}: picture not drawn`).not.toBeNull();
  expect(heading!.y + heading!.height, `${title}: the heading is not above the picture`).toBeLessThanOrEqual(picture!.y);
  expect(description!.y + description!.height, `${title}: the description is not above the picture`).toBeLessThanOrEqual(picture!.y);
  expect(heading!.y, `${title}: the heading is not above the description`).toBeLessThan(description!.y);
  expect(description!.y + description!.height, `${title}: the caption is not under the description`).toBeLessThanOrEqual(caption!.y + 1);
  expect(caption!.y + caption!.height, `${title}: the caption is not above the picture`).toBeLessThanOrEqual(picture!.y);
  // It is said once, and outside the picture, which a screen reader skips: it is what tells everyone they are made up.
  await expect(card.getByText(CAPTION)).toHaveCount(1);
  await expect(card.getByTestId('tour-picture')).toHaveAttribute('aria-hidden', 'true');
  await expect(card.getByTestId('tour-picture').getByText(CAPTION)).toHaveCount(0);
}

/**
 * The people in the picture are the shared list's, each with its own role and a sheep for a photo, and the picture
 * says Example; nothing the old pictures showed, and no name or role cut off.
 */
async function expectLabelledExamples(page: Page, index: number) {
  const title = TITLES[index];
  await expect(tour(page), `${title}: a person the old pictures showed is back`).not.toContainText(OLD_EXAMPLE_PEOPLE);
  const picture = slide(page).getByTestId('tour-picture');
  const lines = (await picture.innerText()).split('\n').map((line) => line.trim()).filter(Boolean);
  const names = lines.filter((line) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(line));
  for (const name of names) {
    const person = EXAMPLE_PEOPLE.find((p) => p.name === name);
    expect(person, `${title}: ${name} is not one of the example people`).toBeTruthy();
    expect(lines[lines.indexOf(name) + 1], `${title}: ${name} is not shown with the role the list gives`).toBe(person!.role);
  }
  expect(names.length, `${title}: how many example people it names`).toBe(PEOPLE_IN_PICTURE[index]);
  expect(lines.filter((line) => line === 'Example').length, `${title}: how many Example tags it carries`).toBe(TAGS_IN_PICTURE[index]);
  // Every tag is drawn, inside the picture's width.
  const frame = (await picture.boundingBox())!;
  const tags = picture.getByText('Example', { exact: true });
  for (let t = 0; t < (await tags.count()); t += 1) {
    await expect(tags.nth(t), `${title}: an Example tag is not drawn`).toBeVisible();
    const box = (await tags.nth(t).boundingBox())!;
    expect(box.x, `${title}: an Example tag is off the left of the picture`).toBeGreaterThanOrEqual(frame.x);
    expect(box.x + box.width, `${title}: an Example tag is off the right of the picture`).toBeLessThanOrEqual(frame.x + frame.width);
  }
  // Nothing in the picture is wider than the room it was given: no "Hannah M…".
  const cutOff = await picture.locator('span').evaluateAll((list) =>
    list.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent ?? ''));
  expect(cutOff, `${title}: words cut off`).toEqual([]);
  // The face is always a sheep, so it can never pass for a real photo, and each one loaded.
  const pictures = picture.locator('img');
  const sources = await pictures.evaluateAll((list) => list.map((i) => i.getAttribute('src') ?? ''));
  expect(sources.length, `${title}: no sheep in the picture`).toBeGreaterThan(0);
  for (const src of sources) expect(src, `${title}: an image that is not the sheep`).toMatch(/^\/sheep\//);
  // They load lazily, so give them a moment before calling one broken.
  await expect.poll(
    () => pictures.evaluateAll((list) => list.filter((i) => !(i as HTMLImageElement).complete || (i as HTMLImageElement).naturalWidth === 0).length),
    { message: `${title}: a sheep did not load`, timeout: 15_000 },
  ).toBe(0);
}

test.beforeAll(async () => {
  console.log(`[onboarding-tour] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  if (made.length) await cleanup(pool, { ids: made });
  await cleanupByPrefix(pool, 'e2etest-tour');
  await pool.end().catch(() => {});
});

test('it explains the product once, then never again', async () => {
  test.setTimeout(240_000);
  const me = await justOnboarded('tourfull');
  const page = await openAs(me, '/agents');

  await expect(tour(page)).toBeVisible({ timeout: 30_000 });
  // Opening on its own, it takes the keyboard's focus, on its main button (final review C7).
  await expect(page.getByRole('button', { name: /^Next$/ })).toBeFocused();
  // It is called what the product is called, on screen and to a screen reader.
  await expect(tour(page)).toHaveAttribute('aria-label', 'How REASON works');
  await expect(tour(page).getByText('How REASON works', { exact: true })).toBeVisible();
  // All four cards, in the deck's words, each reachable on a phone, each with its words and the caption above its picture,
  // whose people are the shared list's and are labelled Example.
  for (const [i, title] of TITLES.entries()) {
    await expect(tour(page).getByRole('heading', { name: title })).toBeVisible();
    await expectWordsAboveThePicture(page, title);
    await expectLabelledExamples(page, i);
    if (i < 3) await tapReachable(page, page.getByRole('button', { name: /^Next$/ }), `Next from ${title}`);
  }
  console.log('  ✓ four cards: words and caption above the picture, whose people are the labelled examples');
  // The last card is the clear next step the deck asks for.
  const cta = page.getByRole('button', { name: 'See my matches' });
  await expectReachable(page, cta, '"See my matches"');
  await tapReachable(page, cta, '"See my matches"');
  await expect(tour(page)).toHaveCount(0);
  // They opened it over Your searches; it ends on For You.
  await expect.poll(() => pathOf(page), { message: 'finishing the tour lands on For You' }).toBe('/');
  console.log('  ✓ walked all four cards and finished on For You');

  // It is done: reloading, or coming back on another device, does not replay it.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await expect(tour(page)).toHaveCount(0);

  const second = await openAs(me, '/');
  await second.waitForTimeout(2500);
  await expect(tour(second)).toHaveCount(0);
  console.log('  ✓ not shown again, on this device or another');

  const row = (await pool.query<{ tour_outcome: string | null }>(
    `SELECT tour_outcome FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row.tour_outcome).toBe('completed');
});

test('skipping it counts as seen, lands on For You, and it does not come back', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourskip');
  const page = await openAs(me, '/agents');
  await expect(tour(page)).toBeVisible({ timeout: 30_000 });
  await tapReachable(page, page.getByRole('button', { name: /^Skip$/ }), 'Skip');
  await expect(tour(page)).toHaveCount(0);
  await expect.poll(() => pathOf(page), { message: 'skipping the tour lands on For You' }).toBe('/');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await expect(tour(page)).toHaveCount(0);

  const row = (await pool.query<{ tour_outcome: string | null }>(
    `SELECT tour_outcome FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row.tour_outcome).toBe('skipped');
});

test('Escape skips it from any page and lands on For You', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourescape');
  const page = await openAs(me, '/agents');
  await expect(tour(page)).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect.poll(() => pathOf(page), { message: 'Escape lands on For You' }).toBe('/');

  const row = (await pool.query<{ tour_outcome: string | null }>(
    `SELECT tour_outcome FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row.tour_outcome).toBe('skipped');
});

test('finishing it on For You stays on For You', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourhome');
  const page = await openAs(me, '/');
  await expect(tour(page)).toBeVisible({ timeout: 30_000 });
  const entries = await page.evaluate(() => history.length);

  await tapReachable(page, page.getByRole('button', { name: /Go to card 4/ }), 'the fourth dot');
  await tapReachable(page, page.getByRole('button', { name: 'See my matches' }), '"See my matches"');
  await expect(tour(page)).toHaveCount(0);

  // Already there: nothing was opened on top of the page they were on.
  expect(pathOf(page)).toBe('/');
  expect(await page.evaluate(() => history.length)).toBe(entries);
});

test('closing the tab in the middle brings it back', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourhalf');
  const page = await openAs(me, '/agents');
  await expect(tour(page)).toBeVisible({ timeout: 30_000 });
  await tapReachable(page, page.getByRole('button', { name: /^Next$/ }), 'Next');
  await expect(tour(page).getByRole('heading', { name: 'Matches' })).toBeVisible();

  // Left halfway: they were never told the rest, so they are still owed it.
  await page.close();
  const again = await openAs(me, '/');
  await expect(tour(again)).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ still owed after leaving halfway');
});

test('someone who onboarded before it existed is never interrupted', async () => {
  test.setTimeout(120_000);
  // Exactly how every existing member looks: completed, with no tour stamp.
  const old = await createTestUser('tourold');
  made.push(old.id);
  const page = await openAs(old, '/agents');
  await page.waitForTimeout(3000);
  await expect(tour(page)).toHaveCount(0);
  console.log('  ✓ existing members carry on undisturbed');
});

test('it can be opened again from Support, without changing how it was left, and it stays on Support', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourreplay');
  // They skipped it the first time.
  expect((await apiAs(me, 'POST', '/onboarding/tour', { outcome: 'skipped' })).status).toBe(200);

  const page = await openAs(me, '/support');
  await expect(page.getByRole('heading', { name: /How REASON works/i })).toBeVisible({ timeout: 30_000 });
  const open = page.getByRole('button', { name: /Open the tour/i });
  await expect(open).toBeVisible({ timeout: 30_000 });
  await tapReachable(page, open, '"Open the tour"');
  await expect(tour(page)).toBeVisible();
  await expect(tour(page)).toHaveAttribute('aria-label', 'How REASON works');
  await expect(tour(page).getByRole('heading', { name: 'For You' })).toBeVisible();

  // Escape is a way out of anything that covers the screen.
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  expect(pathOf(page), 'replaying and leaving it stays on Support').toBe('/support');

  // Walked to the end, the last button is "Done", and it too leaves them where they were.
  await tapReachable(page, open, '"Open the tour" again');
  await tapReachable(page, page.getByRole('button', { name: /Go to card 4/ }), 'the fourth dot');
  await expect(page.getByRole('button', { name: 'See my matches' })).toHaveCount(0);
  await tapReachable(page, page.getByRole('button', { name: 'Done' }), '"Done"');
  await expect(tour(page)).toHaveCount(0);
  expect(pathOf(page), 'finishing a replay stays on Support').toBe('/support');

  // Replaying does not rewrite how they left it the first time.
  const row = (await pool.query<{ tour_outcome: string | null }>(
    `SELECT tour_outcome FROM users WHERE id = $1`, [me.id],
  )).rows[0];
  expect(row.tour_outcome).toBe('skipped');
  console.log('  ✓ replayable from Support, it stayed on Support and left the record alone');
});

// Final review, 21 Oct 2026 (C7): the tour never took the keyboard's focus, and every card change handed it back to the
// page behind the dialog.
test('the keyboard: focus goes into the tour as it opens, stays in it through every card, and comes back once to what opened it', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourkeys');
  expect((await apiAs(me, 'POST', '/onboarding/tour', { outcome: 'skipped' })).status).toBe(200);
  const page = await openAs(me, '/support', { width: 1280, height: 800 });
  const open = page.getByRole('button', { name: /Open the tour/i });
  await expect(open).toBeVisible({ timeout: 30_000 });
  // Count every time focus lands on the button that opened it.
  await open.evaluate((el) => {
    (window as unknown as { openerFocus: number }).openerFocus = 0;
    el.addEventListener('focus', () => { (window as unknown as { openerFocus: number }).openerFocus += 1; });
  });
  const openerFocus = () => page.evaluate(() => (window as unknown as { openerFocus: number }).openerFocus);
  const focusInTour = () => page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="how-rsn-works"]');
    const at = document.activeElement;
    return { inside: !!dialog && !!at && dialog.contains(at), text: (at?.textContent ?? '').trim() };
  });

  await open.focus();
  // Counted from here: the focus the test just gave it is not one the tour handed back.
  await page.evaluate(() => { (window as unknown as { openerFocus: number }).openerFocus = 0; });
  await page.keyboard.press('Enter');
  await expect(tour(page)).toBeVisible();
  // It opens with focus on its main button, so Enter moves on at once.
  await expect.poll(focusInTour).toEqual({ inside: true, text: 'Next' });

  const seen = [TITLES[0]];
  for (const title of TITLES.slice(1)) {
    await page.keyboard.press('Enter');
    await expect(tour(page).getByRole('heading', { name: title })).toBeVisible();
    seen.push(title);
    expect((await focusInTour()).inside, `${title}: focus is still in the tour`).toBe(true);
  }
  expect(seen).toEqual(TITLES);
  await expect.poll(focusInTour).toEqual({ inside: true, text: 'Done' });
  // The arrows move too, and Tab goes round inside the dialog without leaving it.
  await page.keyboard.press('ArrowLeft');
  await expect(tour(page).getByRole('heading', { name: 'Meetings' })).toBeVisible();
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
    expect((await focusInTour()).inside, `Tab ${i + 1}: focus stays in the tour`).toBe(true);
  }
  expect(await openerFocus(), 'focus never went back to the page behind while the tour was open').toBe(0);

  // Closing hands it back, once, to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(tour(page)).toHaveCount(0);
  await expect(open).toBeFocused();
  await page.waitForTimeout(500);
  expect(await openerFocus()).toBe(1);
  console.log('  ✓ focus: into the tour on open, kept through four cards, the arrows and Tab, and back once on close');
});

test('when saving it fails, it says so inside the dialog and can be tried again', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('tourfail');
  const page = await openAs(me, '/agents');
  await expect(tour(page)).toBeVisible({ timeout: 30_000 });

  await page.route('**/onboarding/tour', (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Something went wrong' } }) })
    : route.continue()));
  await tapReachable(page, page.getByRole('button', { name: /^Skip$/ }), 'Skip');
  // Said inside the dialog, where it cannot cover Skip and a screen reader in a modal still hears it.
  await expect(tour(page).getByRole('alert')).toHaveText("We couldn't save that. Please try again.");
  // Nothing was recorded, so it is still there and still owed.
  await expect(tour(page)).toBeVisible();
  const before = (await pool.query<{ tour_outcome: string | null }>(`SELECT tour_outcome FROM users WHERE id = $1`, [me.id])).rows[0];
  expect(before.tour_outcome).toBeNull();

  await page.unroute('**/onboarding/tour');
  await tapReachable(page, page.getByRole('button', { name: /^Skip$/ }), 'Skip again');
  await expect(tour(page)).toHaveCount(0);
  const after = (await pool.query<{ tour_outcome: string | null }>(`SELECT tour_outcome FROM users WHERE id = $1`, [me.id])).rows[0];
  expect(after.tour_outcome).toBe('skipped');
  console.log('  ✓ a failed save says so, and trying again works');
});

test('every control can be pressed on a small phone', async () => {
  test.setTimeout(180_000);
  const me = await justOnboarded('toursmall');
  const page = await openAs(me, '/agents', { width: 360, height: 640 });
  await expect(tour(page)).toBeVisible({ timeout: 30_000 });

  await expectReachable(page, page.getByRole('button', { name: /^Skip$/ }), 'Skip');
  await expectReachable(page, page.getByRole('button', { name: /^Next$/ }), 'Next');
  // The dots are 8px of paint inside a 44px target.
  const dot = page.getByRole('button', { name: /Go to card 3/ });
  const box = await dot.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await tapReachable(page, dot, 'the third dot');
  await expect(tour(page).getByRole('heading', { name: 'Meetings' })).toBeVisible();

  // The words and the caption are above the picture here too, and the whole picture is inside the window.
  await expectWordsAboveThePicture(page, 'Meetings');
  const picture = (await slide(page).getByTestId('tour-picture').boundingBox())!;
  expect(picture.x).toBeGreaterThanOrEqual(0);
  expect(picture.x + picture.width).toBeLessThanOrEqual(360);
  // On every card of a 360px phone: the names and roles fit (none cut off), and each Example tag is inside the picture.
  for (const [i, title] of TITLES.entries()) {
    await tapReachable(page, page.getByRole('button', { name: new RegExp(`Go to card ${i + 1}`) }), `the dot for ${title}`);
    await expect(tour(page).getByRole('heading', { name: title })).toBeVisible();
    await expectWordsAboveThePicture(page, title);
    await expectLabelledExamples(page, i);
  }

  // The last card's button is reachable too.
  await tapReachable(page, page.getByRole('button', { name: /Go to card 4/ }), 'the fourth dot');
  await expectReachable(page, page.getByRole('button', { name: 'See my matches' }), '"See my matches"');

  // And nothing is pushed off the side.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  console.log('  ✓ reachable at 360px, no sideways scroll');
});
