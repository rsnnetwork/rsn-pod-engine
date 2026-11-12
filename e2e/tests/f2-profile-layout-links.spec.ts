// e2e/tests/f2-profile-layout-links.spec.ts
//
// Stefan, 10 Nov 2026: "if there is no banner, it shouldn't be there? there is A LOT of space not being used on that
// page. The profile picture should be top centered too? There should also be website next to linkedin link, and
// perhaps other social media too?"
//
//   No banner     another member's profile has no banner element at all when they have none, and the photo is the
//                 first thing in the hero, centred. Your own profile shows a slim "Add banner" button instead.
//   Links         the edit form saves Website, Instagram, X and Facebook (a wrong one is said under its own box, nothing
//                 is saved), and another member's profile shows each as an icon + label button that opens the right address in a new tab.
//   Every size    360, 768 and 1280: nothing scrolls sideways, the photo's centre is the card's centre, every link fits the window.
//
// Throwaway members only, deleted by id at the end. Run one engine at a time (one spec per process):
//   E2E_APP_URL=https://<app> npx playwright test tests/f2-profile-layout-links.spec.ts   (through the quiet-browsers wrapper)

import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

const ENGINE = engineLabel();
const SLOW = 75_000;
const run = Date.now().toString(36);
const OWNER_NAME = `Lena Linkful ${run}`;
const VIEWER_NAME = `Vic Viewer ${run}`;
const LINKS = {
  website: 'https://lena-links.example/about',
  instagram: 'https://www.instagram.com/lena.links',
  x: 'https://x.com/lena_links',
  facebook: 'https://www.facebook.com/lena.links',
};
const SIZES = [{ width: 360, height: 780 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }];

let browser: Browser;
let owner: TestUser;
let viewer: TestUser;
const ids: string[] = [];

async function signedIn(u: TestUser, viewport = { width: 1280, height: 900 }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  await primePreview(ctx);
  return { ctx, page: await ctx.newPage() };
}

async function noSidewaysScroll(page: Page, label: string) {
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await expect.poll(over, { message: `${label}: the page is wider than the window`, timeout: 5_000 }).toBeLessThanOrEqual(0);
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  owner = await createTestUser(`f2-owner-${run}`);
  viewer = await createTestUser(`f2-viewer-${run}`);
  ids.push(owner.id, viewer.id);
  await pool.query(
    `UPDATE users SET display_name = $2, first_name = 'Lena', company = 'Northwind Labs', job_title = 'Founder', industry = 'Fintech',
            bio = 'Building calm money tools for small teams.', linkedin_url = 'https://www.linkedin.com/in/lena-links',
            professional_role = ARRAY['Founder']::text[], onboarding_version = 2
      WHERE id = $1`,
    [owner.id, OWNER_NAME],
  );
  await pool.query(`UPDATE users SET display_name = $2, first_name = 'Vic' WHERE id = $1`, [viewer.id, VIEWER_NAME]);
});

test.afterAll(async () => {
  await browser?.close();
  await cleanup(pool, { ids });
});

test(`the edit form saves the four links, and a wrong one is said under its own box and saves nothing (${ENGINE})`, async () => {
  test.setTimeout(180_000);
  const me = await signedIn(owner, { width: 390, height: 844 });
  await gotoRetry(me.page, `${APP}/profile/edit`);
  const website = me.page.getByLabel('Website', { exact: true });
  await expect(website).toBeVisible({ timeout: SLOW });

  // A wrong Instagram (another site) is refused next to its own box, and nothing else is saved with it.
  await website.fill('lena-links.example/about');
  await me.page.getByLabel('Instagram', { exact: true }).fill('evil.example/instagram.com');
  await me.page.getByRole('button', { name: /save/i }).first().click();
  await expect(me.page.getByText('Enter your Instagram link, for example instagram.com/your-name')).toBeVisible();
  const stored = await pool.query(`SELECT website_url, instagram_url FROM users WHERE id = $1`, [owner.id]);
  expect(stored.rows[0]).toEqual({ website_url: null, instagram_url: null });

  // All four right: saved in the stored form (https put in front of the website).
  await me.page.getByLabel('Instagram', { exact: true }).fill(LINKS.instagram);
  await me.page.getByLabel('X', { exact: true }).fill(LINKS.x);
  await me.page.getByLabel('Facebook', { exact: true }).fill(LINKS.facebook);
  await me.page.getByRole('button', { name: /save/i }).first().click();
  await expect(me.page.getByText('Profile updated!')).toBeVisible({ timeout: 30_000 });
  const after = await pool.query(`SELECT website_url, instagram_url, x_url, facebook_url FROM users WHERE id = $1`, [owner.id]);
  expect(after.rows[0]).toEqual({ website_url: LINKS.website, instagram_url: LINKS.instagram, x_url: LINKS.x, facebook_url: LINKS.facebook });
  await me.ctx.close();
});

for (const size of SIZES) {
  test(`another member's profile at ${size.width}px: no banner gap, centred photo, every link opens its own address (${ENGINE})`, async () => {
    test.setTimeout(180_000);
    await pool.query(
      `UPDATE users SET website_url = $2, instagram_url = $3, x_url = $4, facebook_url = $5 WHERE id = $1`,
      [owner.id, LINKS.website, LINKS.instagram, LINKS.x, LINKS.facebook],
    );
    const them = await signedIn(viewer, size);
    await gotoRetry(them.page, `${APP}/people/${owner.id}`);
    await expect(them.page.getByRole('heading', { level: 1, name: OWNER_NAME })).toBeVisible({ timeout: SLOW });

    // No banner: the element is not there, and the photo is the first thing under the header.
    await expect(them.page.getByTestId('profile-banner')).toHaveCount(0);
    const photo = them.page.getByTestId('profile-photo');
    const card = photo.locator('xpath=..');
    const p = await photo.boundingBox();
    const c = await card.boundingBox();
    expect(p && c).toBeTruthy();
    expect(Math.abs((p!.x + p!.width / 2) - (c!.x + c!.width / 2))).toBeLessThanOrEqual(2);
    const header = await them.page.locator('header').first().boundingBox();
    expect(c!.y - (header!.y + header!.height)).toBeLessThan(40);

    // The links: LinkedIn first, then the four, each at least 44px tall, inside the window, opening a new tab with no opener.
    const row = them.page.getByTestId('profile-links');
    const links = row.getByRole('link');
    await expect(links).toHaveCount(5);
    // Each link's accessible name is its label plus the screen-reader-only "(opens in a new tab)"; innerText would carry both.
    const names = ['LinkedIn', 'Website', 'Instagram', 'X', 'Facebook'];
    for (let i = 0; i < names.length; i += 1) await expect(links.nth(i)).toHaveAccessibleName(`${names[i]} (opens in a new tab)`);
    const expected = ['https://www.linkedin.com/in/lena-links', LINKS.website, LINKS.instagram, LINKS.x, LINKS.facebook];
    for (let i = 0; i < 5; i += 1) {
      const link = links.nth(i);
      await expect(link).toHaveAttribute('href', expected[i]);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      const box = await expectReachable(them.page, link, `link ${names[i]}`);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width);
    }
    await noSidewaysScroll(them.page, `${size.width}px`);
    await them.ctx.close();
  });
}

test(`a member with no links sees no links row, and your own profile offers "Add banner" instead of an empty strip (${ENGINE})`, async () => {
  test.setTimeout(180_000);
  await pool.query(`UPDATE users SET website_url = NULL, instagram_url = NULL, x_url = NULL, facebook_url = NULL, linkedin_url = NULL WHERE id = $1`, [owner.id]);
  const them = await signedIn(viewer, { width: 390, height: 844 });
  await gotoRetry(them.page, `${APP}/people/${owner.id}`);
  await expect(them.page.getByRole('heading', { level: 1, name: OWNER_NAME })).toBeVisible({ timeout: SLOW });
  await expect(them.page.getByTestId('profile-links')).toHaveCount(0);
  await them.ctx.close();

  const me = await signedIn(owner, { width: 390, height: 844 });
  await gotoRetry(me.page, `${APP}/profile`);
  await expect(me.page.getByRole('heading', { level: 1, name: OWNER_NAME })).toBeVisible({ timeout: SLOW });
  await expect(me.page.getByTestId('profile-banner')).toHaveCount(0);
  const add = me.page.getByRole('button', { name: 'Add banner' });
  await expectReachable(me.page, add, 'Add banner');
  await add.click();
  await expect(me.page.getByRole('dialog', { name: 'Edit your banner' })).toBeVisible();
  await noSidewaysScroll(me.page, 'your profile, 390px');
  await me.ctx.close();
});
