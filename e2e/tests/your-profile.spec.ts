// e2e/tests/your-profile.spec.ts
//
// "Your profile, the way others see it, with edit and a banner you can change" (21 Oct 2026). Stefan: "when I look
// at my profile, I should see my profile, how other people see it - and then edit, where applicable"; the 19 Oct
// feedback: "Users should be able to change their banner from their profile".
//
//   The banner        a member changes it on /profile (the picture is cut to its middle 3:1 band at 1500x500 in the
//                     browser), sees it there, and another member sees the same banner on their Human Profile;
//                     removed (it asks first), both go back to the default gradient. A second tab of the member's
//                     own profile follows the change with no refresh.
//   Your profile      the hero is the card other members get (GET /people/me/card), what only you see is apart,
//                     and every link goes where the brief says: Edit profile, Edit answers, Add your company, and
//                     "connect LinkedIn" to the LinkedIn field of the form, which has a way back. The Google photo
//                     outcome is read on the form, at /profile/edit.
//   More              the Human Profile's header offers Block and Report this member (the old profile's dialogs);
//                     the move bar steps aside while the report dialog is open; a block asks first, then leaves.
//   Unblock           the profile is closed to the one who blocked: its notice says "You blocked this member." and
//                     offers Unblock, which asks first and brings the profile back. The member who was blocked sees
//                     only "This profile is not available.", with no word of a block.
//   Every size        360 to 1440: nothing scrolls sideways, the name is never cut mid-word, and the banner's
//                     controls, the edit links and More can be pressed.
//
// Throwaway members only, deleted by id at the end. Run one engine at a time (one spec per process):
//   locally          bash /c/dev/_m1-local/oct21/run-local-spec.sh <worktree> <ui-port> <api-port> tests/your-profile.spec.ts
//   on the preview   E2E_APP_URL=https://<preview> E2E_VERCEL_SHARE=<token> E2E_JWT_SECRET=<key> npx playwright test tests/your-profile.spec.ts
//   E2E_ENGINE=webkit for Safari's engine; E2E_HEADED=0 runs it headless.

import { test, expect, Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

const ENGINE = engineLabel();
// A preview's API can take up to a minute to wake.
const SLOW = 75_000;
const run = Date.now().toString(36);
const OWNER = {
  name: `Ada Bannerlove ${run}`, company: 'Northwind Labs', title: 'Founder', industry: 'Fintech', location: 'Berlin, DE',
  bio: 'Building calm money tools for small teams.', offer: `Intros to retail buyers ${run}`,
  // What only the member may see. It must never reach another member's page. want and intent are the texts the matcher
  // keeps; meetWords and findWords are the member's own words in their answers.
  want: `private-want-${run}`, intent: `private-intent-${run}`, tz: 'Europe/Berlin',
  meetWords: `private-meet-${run}`, findWords: `private-find-${run}`,
};
// "Only you see this" reads the answers by their short labels, as screen 7 does (final review, 21 Oct 2026).
const OWNER_ANSWERS = [`Investors · “${OWNER.meetWords}”`, 'Raising funding', `“${OWNER.findWords}”`];
const VIEWER_NAME = `Vic Viewer ${run}`;
const REPORTED_NAME = `Rex Reported ${run}`;

let browser: Browser;
let owner: TestUser;
let viewer: TestUser;
let reported: TestUser;
const ids: string[] = [];

async function signedIn(u: TestUser, viewport = { width: 1280, height: 900 }): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  await primePreview(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return { ctx, page, errors };
}

/** Console errors a test did not make on purpose (a 404 is the answer for a blocked profile or a missing banner). */
const unexpected = (errors: string[]) =>
  errors.filter((e) => !/404|Not Found|Failed to load resource|Download the React DevTools|WebSocket|socket/i.test(e));

/** A JPEG made in the page: red top, green middle 3:1 band, blue bottom, so the banner's crop can be read back. */
async function stripedPicture(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ w, h }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d')!;
    const band = w / 3;
    x.fillStyle = '#d1242f'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#1a7f37'; x.fillRect(0, (h - band) / 2, w, band);
    x.fillStyle = '#0969da'; x.fillRect(0, (h + band) / 2, w, h);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }, { w: width, h: height });
  return Buffer.from(base64, 'base64');
}

const bannerOf = (page: Page) => page.getByTestId('profile-banner');
const pictureInput = (page: Page) => page.locator('input[type="file"][aria-label="Choose a banner picture"]');
const loadedWidth = (img: Locator) => img.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0));

/** The words of a heading that the browser broke across two lines: a name cut mid-word. */
function brokenWords(heading: Locator): Promise<string[]> {
  return heading.evaluate((h) => {
    const node = h.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return ['(the heading is not plain text)'];
    const out: string[] = [];
    let at = 0;
    for (const word of (node.textContent ?? '').split(' ')) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      if (new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size > 1) out.push(word);
      at += word.length + 1;
    }
    return out;
  });
}

async function noSidewaysScroll(page: Page, label: string) {
  const s = await page.evaluate(() => {
    const main = document.querySelector('main');
    return { doc: document.documentElement.scrollWidth - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
  });
  expect(s.doc, `${label}: the page is wider than the window`).toBeLessThanOrEqual(0);
  expect(s.main, `${label}: the page area scrolls sideways`).toBeLessThanOrEqual(1);
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  owner = await createTestUser(`yourprofile-owner-${run}`);
  viewer = await createTestUser(`yourprofile-viewer-${run}`);
  reported = await createTestUser(`yourprofile-reported-${run}`);
  ids.push(owner.id, viewer.id, reported.id);
  await pool.query(
    `UPDATE users SET display_name = $2, first_name = 'Ada', company = $3, job_title = $4, industry = $5, location = $6, bio = $7,
            what_i_can_help_with = $8, who_i_want_to_meet = $9, my_intent = $10, timezone = $11, linkedin_url = NULL,
            professional_role = ARRAY['Founder']::text[],
            onboarding_version = 2, looking_to_meet = ARRAY['meet_investors', 'meet_other']::text[], meet_other = $12,
            hoping_to_find = ARRAY['find_funding']::text[], find_specific = $13,
            can_offer = ARRAY['offer_advice_mentoring']::text[], self_kinds = ARRAY['self_founder_owner']::text[]
      WHERE id = $1`,
    [owner.id, OWNER.name, OWNER.company, OWNER.title, OWNER.industry, OWNER.location, OWNER.bio, OWNER.offer, OWNER.want, OWNER.intent, OWNER.tz,
      OWNER.meetWords, OWNER.findWords],
  );
  await pool.query(`UPDATE users SET display_name = $2, first_name = 'Vic' WHERE id = $1`, [viewer.id, VIEWER_NAME]);
  await pool.query(`UPDATE users SET display_name = $2, first_name = 'Rex' WHERE id = $1`, [reported.id, REPORTED_NAME]);
});

test.afterAll(async () => {
  await browser?.close();
  // Blocks and reports cascade with the members, so deleting the two members by id leaves nothing behind.
  await cleanup(pool, { ids });
});

test(`the banner: changed on your profile, seen there and on your Human Profile by another member, then removed (${ENGINE})`, async () => {
  test.setTimeout(240_000);
  const me = await signedIn(owner, { width: 1280, height: 900 });
  await gotoRetry(me.page, `${APP}/profile`);
  await expect(me.page.getByRole('heading', { level: 1, name: OWNER.name })).toBeVisible({ timeout: SLOW });
  await expect(bannerOf(me.page)).toBeVisible();
  await expect(bannerOf(me.page).locator('img')).toHaveCount(0);

  // Change banner: a tall picture is cut to its middle 3:1 band, at 1500x500.
  await pictureInput(me.page).setInputFiles({ name: 'tall.jpg', mimeType: 'image/jpeg', buffer: await stripedPicture(me.page, 1200, 1600) });
  await expect(me.page.getByText('Your banner is updated.')).toBeVisible({ timeout: 30_000 });
  const mine = bannerOf(me.page).locator('img');
  await expect.poll(() => loadedWidth(mine), { timeout: 20_000 }).toBe(1500);
  expect(await mine.evaluate((i: HTMLImageElement) => i.naturalHeight)).toBe(500);
  const src = await mine.getAttribute('src');
  expect(src).toMatch(new RegExp(`/api/users/${owner.id}/banner\\?v=\\d{13}$`));
  // Read the stored picture back (fetched, so the canvas can be read) and check it is all the green middle band.
  const corners = await me.page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const c = document.createElement('canvas');
    c.width = bitmap.width; c.height = bitmap.height;
    const x = c.getContext('2d')!;
    x.drawImage(bitmap, 0, 0);
    return [[30, 30], [750, 250], [1470, 470]].map(([px, py]) => Array.from(x.getImageData(px, py, 1, 1).data.slice(0, 3)));
  }, src!);
  for (const [r, g, b] of corners) expect({ r, g, b, middleBand: g > 100 && r < 70 && b < 90 }).toMatchObject({ middleBand: true });

  // Another member sees the same banner across the top of the Human Profile, above the hero, and nothing private.
  const them = await signedIn(viewer, { width: 390, height: 844 });
  await gotoRetry(them.page, `${APP}/people/${owner.id}`);
  const name = them.page.getByRole('heading', { level: 1, name: OWNER.name });
  await expect(name).toBeVisible({ timeout: SLOW });
  const theirs = bannerOf(them.page).locator('img');
  await expect(theirs).toHaveAttribute('src', src!);
  await expect.poll(() => loadedWidth(theirs), { timeout: 20_000 }).toBe(1500);
  const banner = (await bannerOf(them.page).boundingBox())!;
  expect(banner.y + banner.height).toBeLessThanOrEqual((await name.boundingBox())!.y);
  expect(await them.page.content()).not.toContain(`private-`);

  // Removed, after a confirmation: the default gradient on both pages.
  await bannerOf(me.page).getByRole('button', { name: 'Remove' }).click();
  const sheet = me.page.getByRole('dialog', { name: 'Remove your banner?' });
  await expect(sheet.getByText('Your profile goes back to the default banner.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Remove' }).click();
  await expect(me.page.getByText('Your banner is removed.')).toBeVisible({ timeout: 30_000 });
  await expect(bannerOf(me.page).locator('img')).toHaveCount(0);
  await them.page.reload();
  await expect(name).toBeVisible({ timeout: SLOW });
  await expect(bannerOf(them.page).locator('img')).toHaveCount(0);
  expect(unexpected(me.errors)).toEqual([]);
  expect(unexpected(them.errors)).toEqual([]);
  await me.ctx.close();
  await them.ctx.close();
});

test(`a second tab of your profile follows a new banner with no refresh (${ENGINE})`, async () => {
  test.setTimeout(180_000);
  const one = await signedIn(owner);
  const two = await one.ctx.newPage();
  await gotoRetry(one.page, `${APP}/profile`);
  await gotoRetry(two, `${APP}/profile`);
  for (const p of [one.page, two]) await expect(p.getByRole('heading', { name: 'Only you see this' })).toBeVisible({ timeout: SLOW });
  // Let the second tab's live connection come up first.
  await two.waitForTimeout(3000);
  await pictureInput(one.page).setInputFiles({ name: 'wide.jpg', mimeType: 'image/jpeg', buffer: await stripedPicture(one.page, 1500, 500) });
  await expect(one.page.getByText('Your banner is updated.')).toBeVisible({ timeout: 30_000 });
  await expect(bannerOf(two).locator('img')).toHaveCount(1, { timeout: 20_000 });
  await expect(bannerOf(two).getByRole('button', { name: 'Remove' })).toBeVisible();
  await one.ctx.close();
  await pool.query('UPDATE users SET banner_blob = NULL, banner_mime = NULL, banner_updated_at = NULL WHERE id = $1', [owner.id]);
});

test(`your profile is the way others see it, with what only you see apart, and every link goes where it should (${ENGINE})`, async () => {
  test.setTimeout(240_000);
  const { ctx, page, errors } = await signedIn(owner, { width: 1440, height: 900 });
  await gotoRetry(page, `${APP}/profile`);
  await expect(page.getByRole('heading', { level: 1, name: OWNER.name })).toBeVisible({ timeout: SLOW });
  await expect(page.getByText('Your profile, as others see it')).toBeVisible();
  await expect(page.getByText(`${OWNER.title} · ${OWNER.company}`)).toBeVisible();
  for (const tag of [OWNER.industry, OWNER.location, 'Founder']) await expect(page.getByText(tag, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(OWNER.bio)).toBeVisible();
  await expect(page.getByText(OWNER.offer)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Only you see this' })).toBeVisible();
  // Their own answers, by the short labels screen 7 shows, with their words in quotes: never the matcher's wording
  // for them (final review, 21 Oct 2026).
  const onlyYou = page.locator('section', { has: page.getByRole('heading', { name: 'Only you see this' }) });
  for (const line of [...OWNER_ANSWERS, OWNER.tz]) await expect(onlyYou.getByText(line, { exact: true })).toBeVisible();
  for (const text of [OWNER.want, OWNER.intent]) await expect(page.getByText(text)).toHaveCount(0);

  // Edit answers opens every answer, on screen 7, and Cancel comes back here.
  const editAnswers = page.getByRole('link', { name: 'Edit answers' });
  await expect(editAnswers).toHaveAttribute('href', '/onboarding?edit=profile');
  await editAnswers.click();
  await expect(page.getByRole('heading', { name: "Here's how others will see you" })).toBeVisible({ timeout: SLOW });
  await expect(page.getByRole('button', { name: 'Edit: Who would you like to meet?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByRole('heading', { name: 'Only you see this' })).toBeVisible({ timeout: SLOW });

  await expect(page.getByRole('link', { name: 'Add your company' })).toHaveAttribute('href', '/entities?create=1');
  await page.getByRole('link', { name: 'Edit profile' }).click();
  await expect(page).toHaveURL(/\/profile\/edit$/);
  await expect(page.getByRole('button', { name: 'Change photo' })).toBeVisible({ timeout: SLOW });
  // Profile is still the current entry on the form under it.
  await expect(page.getByRole('complementary').getByRole('link', { name: 'Profile', exact: true })).toHaveAttribute('aria-current', 'page');
  // What they can help with, who they want to meet and their intent come from their answers: shown, not edited, with
  // the way to the answers.
  const fromAnswers = page.getByRole('region', { name: 'From your answers' });
  for (const text of [OWNER.offer, OWNER.want, OWNER.intent]) await expect(fromAnswers.getByText(text, { exact: true })).toBeVisible();
  await expect(fromAnswers.getByRole('textbox')).toHaveCount(0);
  await expect(fromAnswers.getByRole('link', { name: 'Edit answers' })).toHaveAttribute('href', '/onboarding?edit=profile');
  // Settled and rounded: WebKit can report a 44px box as 43.99997px while the card's entrance animation runs.
  await expect.poll(async () => Math.round((await fromAnswers.getByRole('link', { name: 'Edit answers' }).boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await page.getByRole('link', { name: 'Back to your profile' }).click();
  await expect(page).toHaveURL(/\/profile$/);

  // "connect LinkedIn" opens the form at the LinkedIn field, with the cursor in it; once there is one, the card goes.
  await page.getByRole('link', { name: 'Add LinkedIn' }).click();
  await expect(page).toHaveURL(/\/profile\/edit#linkedin$/);
  const linkedin = page.locator('#linkedin');
  await expect(linkedin).toBeFocused({ timeout: 15_000 });
  await expectReachable(page, linkedin, 'the LinkedIn field');
  // Something that is not a profile link is said under the field, the cursor goes back to it, and nothing is sent.
  let saves = 0;
  page.on('request', (r) => { if (r.method() === 'PUT' && /\/api\/users\/me$/.test(new URL(r.url()).pathname)) saves += 1; });
  const help = page.getByRole('alert').filter({ hasText: 'Enter your LinkedIn profile link, for example linkedin.com/in/your-name' });
  await linkedin.fill('facebook.com/ada');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(help).toBeVisible();
  await expect(linkedin).toHaveAttribute('aria-invalid', 'true');
  await expect(linkedin).toBeFocused();
  expect(saves).toBe(0);
  // Half an address, with the phone app's share query on it, is saved as the one clean address (it used to become
  // https://linkedin.com/in/linkedin.com/in/..., query and all).
  await linkedin.fill(`linkedin.com/in/ada-bannerlove-${run}?utm_source=share&utm_medium=ios_app`);
  await expect(help).toHaveCount(0);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Profile updated!')).toBeVisible({ timeout: 30_000 });
  const clean = `https://www.linkedin.com/in/ada-bannerlove-${run}`;
  expect((await pool.query<{ linkedin_url: string }>('SELECT linkedin_url FROM users WHERE id = $1', [owner.id])).rows[0].linkedin_url).toBe(clean);
  await page.getByRole('link', { name: 'Back to your profile' }).click();
  await expect(page.getByRole('heading', { name: 'Only you see this' })).toBeVisible({ timeout: SLOW });
  await expect(page.getByText('Optimize your profile: connect LinkedIn')).toHaveCount(0);

  // The hero links to it, under the role line, in a new tab: on Your profile and on the Human Profile another member sees.
  for (const [who, p] of [['your profile', page], ['their Human Profile', (await signedIn(viewer, { width: 390, height: 844 })).page]] as const) {
    if (who !== 'your profile') {
      await gotoRetry(p, `${APP}/people/${owner.id}`);
      await expect(p.getByRole('heading', { level: 1, name: OWNER.name })).toBeVisible({ timeout: SLOW });
    }
    const link = p.getByRole('link', { name: /^LinkedIn/ });
    await expect(link, `${who}: the LinkedIn link`).toHaveAttribute('href', clean);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveText('LinkedIn ↗ (opens in a new tab)');
    await link.scrollIntoViewIfNeeded();
    await expect.poll(async () => Math.round((await link.boundingBox())!.height), { message: `${who}: the link is a 44px target` }).toBeGreaterThanOrEqual(44);
    await expectReachable(p, link, `${who}: the LinkedIn link`);
    const role = (await p.getByText(`${OWNER.title} · ${OWNER.company}`).boundingBox())!;
    expect((await link.boundingBox())!.y, `${who}: the link is under the role line`).toBeGreaterThanOrEqual(role.y + role.height - 1);
    if (who !== 'your profile') await p.context().close();
  }

  // The Google photo comes back to the form, and its outcome is said there.
  await gotoRetry(page, `${APP}/profile/edit?photo=none`);
  await expect(page.getByText('That Google account has no photo.')).toBeVisible({ timeout: SLOW });
  await expect(page).not.toHaveURL(/photo=/);
  // Your own id as a Human Profile is still your own profile.
  await gotoRetry(page, `${APP}/people/${owner.id}`);
  await expect(page).toHaveURL(/\/profile$/, { timeout: SLOW });
  expect(unexpected(errors)).toEqual([]);
  await ctx.close();
  await pool.query('UPDATE users SET linkedin_url = NULL WHERE id = $1', [owner.id]);
});

test(`More on the Human Profile: Report this member, and Block, which asks first and leaves; the notice then offers Unblock, which brings the profile back (${ENGINE})`, async () => {
  test.setTimeout(240_000);
  const { ctx, page, errors } = await signedIn(viewer, { width: 390, height: 844 });
  await gotoRetry(page, `${APP}/people/${owner.id}`);
  await expect(page.getByRole('heading', { level: 1, name: OWNER.name })).toBeVisible({ timeout: SLOW });
  const more = page.getByRole('button', { name: 'More' });
  await expectReachable(page, more, 'More');

  await more.click();
  await expectReachable(page, page.getByRole('button', { name: 'Block', exact: true }), 'Block');
  await page.getByRole('button', { name: 'Report this member' }).click();
  await expect(page.getByRole('heading', { name: `Report ${OWNER.name}` })).toBeVisible();
  // The move bar steps aside, so it cannot cover the dialog's buttons on a phone.
  await expect(page.getByRole('region', { name: 'Your move' })).toHaveCount(0);
  await page.waitForTimeout(700); // the dialog fades in
  await expectReachable(page, page.getByRole('button', { name: 'Submit report' }), 'Submit report');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('region', { name: 'Your move' })).toBeVisible();

  // Block asks first, with the old profile's words. Dismissed, nothing happens.
  const question = `Block ${OWNER.name}? They won't be able to message you and you won't be matched together in future events.`;
  page.once('dialog', (d) => { expect(d.message()).toBe(question); void d.dismiss(); });
  await more.click();
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: OWNER.name })).toBeVisible();
  expect((await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [viewer.id, owner.id])).rowCount).toBe(0);
  // Accepted: blocked, said, and the page leaves the profile (opened directly, so back is For You).
  page.once('dialog', (d) => void d.accept());
  await more.click();
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(page.getByText(`${OWNER.name} is blocked. They can no longer message you, and you won't be matched together.`)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  expect((await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [viewer.id, owner.id])).rowCount).toBe(1);

  // The profile is closed to the one who blocked, and its notice says so and offers Unblock (fix round 1: once every
  // people link opens this page, it is the only way to undo a block).
  await gotoRetry(page, `${APP}/people/${owner.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'You blocked this member.' })).toBeVisible({ timeout: SLOW });
  await expect(page.getByText('This profile is not available.')).toHaveCount(0);
  const unblock = page.getByRole('button', { name: 'Unblock' });
  await expectReachable(page, unblock, 'Unblock');
  expect((await unblock.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Unblock asks first. Dismissed, nothing changes.
  const unblockQuestion = 'Unblock this member? They will be able to message you again, and you may be matched together in future events.';
  page.once('dialog', (d) => { expect(d.message()).toBe(unblockQuestion); void d.dismiss(); });
  await unblock.click();
  await expect(page.getByRole('heading', { level: 1, name: 'You blocked this member.' })).toBeVisible();
  expect((await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [viewer.id, owner.id])).rowCount).toBe(1);
  // Accepted: unblocked, said, and the profile is back on the same page, with no refresh.
  page.once('dialog', (d) => void d.accept());
  await unblock.click();
  await expect(page.getByText('Unblocked.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name: OWNER.name })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'More' })).toBeVisible();
  expect((await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [viewer.id, owner.id])).rowCount).toBe(0);
  expect(unexpected(errors)).toEqual([]);
  await ctx.close();
});

test(`Report this member with "Also block" ticked: the report is sent, they are blocked, and Done leaves the profile (${ENGINE})`, async () => {
  test.setTimeout(180_000);
  const { ctx, page, errors } = await signedIn(viewer, { width: 390, height: 844 });
  await gotoRetry(page, `${APP}/people/${reported.id}`);
  await expect(page.getByRole('heading', { level: 1, name: REPORTED_NAME })).toBeVisible({ timeout: SLOW });
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: 'Report this member' }).click();
  await expect(page.getByRole('heading', { name: `Report ${REPORTED_NAME}` })).toBeVisible();
  await page.getByLabel('Details (optional)').fill(`spec ${run}`);
  await page.getByText(`Also block ${REPORTED_NAME}`).click();
  await page.getByRole('button', { name: 'Submit report' }).click();
  await expect(page.getByText(`You've also blocked ${REPORTED_NAME}.`)).toBeVisible({ timeout: 30_000 });
  expect((await pool.query('SELECT 1 FROM user_reports WHERE reporter_id = $1 AND reported_id = $2', [viewer.id, reported.id])).rowCount).toBe(1);
  expect((await pool.query('SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [viewer.id, reported.id])).rowCount).toBe(1);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await gotoRetry(page, `${APP}/people/${reported.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'You blocked this member.' })).toBeVisible({ timeout: SLOW });
  await expect(page.getByRole('button', { name: 'Unblock' })).toBeVisible();
  expect(unexpected(errors)).toEqual([]);
  await ctx.close();

  // The member who was blocked is told nothing: the plain notice, with no Unblock and no word of a block.
  const them = await signedIn(reported, { width: 390, height: 844 });
  await gotoRetry(them.page, `${APP}/people/${viewer.id}`);
  await expect(them.page.getByText('This profile is not available.')).toBeVisible({ timeout: SLOW });
  await expect(them.page.getByRole('button', { name: 'Unblock' })).toHaveCount(0);
  await expect(them.page.getByText(/blocked/i)).toHaveCount(0);
  expect(unexpected(them.errors)).toEqual([]);
  await them.ctx.close();
});

test(`every size: nothing scrolls sideways, no name is cut mid-word, and every control can be pressed (${ENGINE})`, async () => {
  test.setTimeout(600_000);
  const sizes = [
    { width: 360, height: 780 }, { width: 390, height: 844 }, { width: 414, height: 896 }, { width: 768, height: 1024 },
    { width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 900 },
  ];
  for (const size of sizes) {
    const at = `${size.width}px`;
    const own = await signedIn(owner, size);
    await gotoRetry(own.page, `${APP}/profile`);
    await expect(own.page.getByRole('heading', { name: 'Only you see this' })).toBeVisible({ timeout: SLOW });
    await noSidewaysScroll(own.page, `your profile at ${at}`);
    expect(await brokenWords(own.page.getByRole('heading', { level: 1 })), `your name at ${at}`).toEqual([]);
    await expectReachable(own.page, own.page.getByRole('button', { name: 'Change banner' }), `Change banner at ${at}`);
    for (const label of ['Edit profile', 'Edit answers', 'Add your company', 'Add LinkedIn']) {
      const link = own.page.getByRole('link', { name: label });
      await link.scrollIntoViewIfNeeded();
      expect((await link.boundingBox())!.height, `${label} at ${at}`).toBeGreaterThanOrEqual(44);
      await expectReachable(own.page, link, `${label} at ${at}`);
    }
    expect(unexpected(own.errors), `your profile at ${at}`).toEqual([]);
    await own.ctx.close();

    const other = await signedIn(viewer, size);
    await gotoRetry(other.page, `${APP}/people/${owner.id}`);
    await expect(other.page.getByRole('heading', { level: 1, name: OWNER.name })).toBeVisible({ timeout: SLOW });
    await noSidewaysScroll(other.page, `the Human Profile at ${at}`);
    expect(await brokenWords(other.page.getByRole('heading', { level: 1 })), `their name at ${at}`).toEqual([]);
    const more = other.page.getByRole('button', { name: 'More' });
    await expectReachable(other.page, more, `More at ${at}`);
    await more.click();
    for (const label of ['Block', 'Report this member']) {
      await expectReachable(other.page, other.page.getByRole('button', { name: label, exact: true }), `${label} at ${at}`);
    }
    await noSidewaysScroll(other.page, `More open at ${at}`);
    expect(unexpected(other.errors), `the Human Profile at ${at}`).toEqual([]);
    await other.ctx.close();
  }
});
