// e2e/tests/n1-t3a-picture-editor.spec.ts
//
// 30 Oct review, T3a: "Profile picture and banner has no edit button. Add an edit (pencil) button directly on the
// profile picture. Edit button that allows to fix the size or position." and "Pictures look pixelated."
//
//   The photo    the pencil on your photo (bottom right of the hero) opens the picture editor; a picture is chosen,
//                dragged, zoomed (the + button, a two-finger pinch, the keyboard) and saved. The server cuts the 1024
//                square from it: the new photo shows on the profile and in the header with no reload. Opened again,
//                the editor has the picture you chose and where you placed it; moved and saved, only the crop changes.
//   The banner   the same with the pencil on the banner: 2400 by 800, reopened with its crop, placed again.
//   Every size   at the width given (7 widths, or the device's own): nothing scrolls sideways with the editor open,
//                the pencils, Cancel and Save are inside the window and at least 44px.
//
// Throwaway members only (emails at rsn-e2e.invalid), deleted by id at the end. One engine per process:
//   locally          bash /c/dev/_m1-local/oct21/run-local-spec.sh <worktree> <ui-port> <api-port> tests/n1-t3a-picture-editor.spec.ts
//   on the preview   E2E_APP_URL=https://<preview> E2E_VERCEL_SHARE=<token> E2E_JWT_SECRET=<key> npx playwright test tests/n1-t3a-picture-editor.spec.ts
//   E2E_ENGINE=webkit for Safari's engine; E2E_DEVICE="iPhone 14" for a phone; E2E_HEADED=1 to watch.

import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { gotoRetry, cleanup, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

const ENGINE = engineLabel();
const SLOW = 75_000;
const run = Date.now().toString(36);
const WIDTHS = process.env.E2E_DEVICE ? [0] : [360, 390, 414, 768, 1024, 1280, 1440];

let browser: Browser;
const ids: string[] = [];

test.beforeAll(async () => { browser = await launchBrowser(); });
test.afterAll(async () => {
  await browser?.close();
  await cleanup(pool, { ids });
});

async function member(label: string): Promise<TestUser> {
  const u = await createTestUser(`t3a-${label}-${run}`);
  ids.push(u.id);
  await pool.query(
    `UPDATE users SET email = $2, display_name = $3, first_name = 'Pia', onboarding_version = 2 WHERE id = $1`,
    [u.id, `t3a-${label}-${run}@rsn-e2e.invalid`, `Pia Picture ${label}`],
  );
  return u;
}

async function signedIn(u: TestUser, width: number): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext(width ? { viewport: { width, height: width < 768 ? 780 : 900 } } : contextOptions());
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

const unexpected = (errors: string[]) => errors.filter((e) => !/404|Not Found|Failed to load resource|DevTools|WebSocket|socket|access control checks/i.test(e));

/** A JPEG made in the page: red left half, blue right half, so which part was kept can be read back. */
async function halves(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ w, h }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d')!;
    x.fillStyle = '#d1242f'; x.fillRect(0, 0, w / 2, h);
    x.fillStyle = '#0969da'; x.fillRect(w / 2, 0, w / 2, h);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }, { w: width, h: height });
  return Buffer.from(base64, 'base64');
}

/** The size of a picture at an address, and the colour at its middle, read in the page. */
function pictureAt(page: Page, url: string) {
  return page.evaluate(async (u) => {
    const bitmap = await createImageBitmap(await (await fetch(u)).blob());
    const c = document.createElement('canvas');
    c.width = bitmap.width; c.height = bitmap.height;
    const x = c.getContext('2d')!;
    x.drawImage(bitmap, 0, 0);
    const [r, , b] = Array.from(x.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data);
    return { width: bitmap.width, height: bitmap.height, red: r > 150 && b < 100, blue: b > 150 && r < 100 };
  }, url);
}

async function stored(id: string) {
  const r = await pool.query(
    `SELECT avatar_url, avatar_crop, md5(avatar_source_blob) AS avatar_source, banner_crop, md5(banner_source_blob) AS banner_source
       FROM users WHERE id = $1`, [id]);
  return r.rows[0];
}

async function noSidewaysScroll(page: Page, label: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    { message: `${label}: the page is wider than the window`, timeout: 5_000 }).toBeLessThanOrEqual(0);
}

/** Every button in the editor is 44px tall, and Cancel and Save are inside the window. */
async function editorFits(page: Page, sheet: Locator, label: string) {
  await noSidewaysScroll(page, label);
  for (const name of ['Cancel', 'Save']) await expectReachable(page, sheet.getByRole('button', { name, exact: true }), `${label}: ${name}`);
  const short = await sheet.locator('button').evaluateAll((all) => all
    .filter((b) => (b as HTMLElement).offsetParent !== null)
    .map((b) => ({ name: b.getAttribute('aria-label') || b.textContent?.trim(), h: Math.round(b.getBoundingClientRect().height) }))
    .filter((b) => b.h < 44));
  expect(short, `${label}: buttons under 44px`).toEqual([]);
}

/** Drag the picture in the frame by dx, dy with a pointer. */
async function drag(page: Page, frame: Locator, dx: number, dy: number) {
  const box = (await frame.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

/** A two-finger pinch on the frame, as touch pointers: the fingers spread from 40px apart to 120px. */
function pinch(frame: Locator) {
  return frame.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    const cx = r.left + r.width / 2;
    const fire = (type: string, id: number, x: number) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: cy, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', 11, cx - 20);
    fire('pointerdown', 12, cx + 20);
    for (let s = 1; s <= 4; s += 1) { fire('pointermove', 11, cx - 20 - 10 * s); fire('pointermove', 12, cx + 20 + 10 * s); }
    fire('pointerup', 11, cx - 60);
    fire('pointerup', 12, cx + 60);
  });
}

const zoomOf = (sheet: Locator) => sheet.getByRole('slider', { name: 'Zoom' }).inputValue().then(Number);

for (const width of WIDTHS) {
  const at = width ? `${width}px` : process.env.E2E_DEVICE ?? 'device';

  test(`the photo: pencil, place, save, shown everywhere at once, reopened where it was, placed again (${ENGINE}, ${at})`, async () => {
    test.setTimeout(240_000);
    const owner = await member(`photo${width}`);
    const { ctx, page, errors } = await signedIn(owner, width);
    await gotoRetry(page, `${APP}/profile`);
    await expect(page.getByRole('heading', { level: 1, name: `Pia Picture photo${width}` })).toBeVisible({ timeout: SLOW });
    const pencil = page.getByRole('button', { name: 'Edit photo' });
    await expectReachable(page, pencil, `${at}: the photo's pencil`);
    expect((await pencil.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // No photo yet: the editor asks for one.
    await pencil.click();
    const sheet = page.getByRole('dialog', { name: 'Edit your photo' });
    await expect(sheet.getByText('No photo yet. Choose a picture to place it.')).toBeVisible({ timeout: 30_000 });
    await sheet.locator('input[type="file"]').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await halves(page, 1600, 1200) });
    const frame = sheet.getByTestId('picture-frame');
    await expect(sheet.getByRole('slider', { name: 'Zoom' })).toBeVisible({ timeout: 20_000 });
    await editorFits(page, sheet, `${at}: the photo editor`);

    // Placed: zoomed in with + and a pinch, dragged right (so more of the red left half shows), nudged with a key.
    await sheet.getByRole('button', { name: 'Zoom in' }).click();
    const afterPlus = await zoomOf(sheet);
    expect(afterPlus).toBeGreaterThan(1);
    await pinch(frame);
    await expect.poll(() => zoomOf(sheet)).toBeGreaterThan(afterPlus + 0.5);
    await drag(page, frame, 400, 0);
    await frame.focus();
    await page.keyboard.press('ArrowRight');
    const zoom = await zoomOf(sheet);
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Your photo is updated.')).toBeVisible({ timeout: 30_000 });
    await expect(sheet).toHaveCount(0);

    // Kept: the picture as it was chosen and where it was placed; the photo everyone sees is the red part, a square of
    // the part kept (1200 / zoom pixels: zoomed this far in it is under 1024, and it is never enlarged).
    const first = await stored(owner.id);
    expect(first.avatar_url).toMatch(new RegExp(`/api/users/${owner.id}/avatar\\?v=\\d+$`));
    expect(first.avatar_crop.zoom).toBeCloseTo(zoom, 1);
    expect(first.avatar_crop.x).toBeLessThan(0.5);
    const cut = await pictureAt(page, first.avatar_url);
    expect(cut).toMatchObject({ red: true, height: cut.width });
    expect(Math.abs(cut.width - Math.min(1024, Math.round(1200 / first.avatar_crop.zoom)))).toBeLessThanOrEqual(1);
    // On the profile and in the header, with no reload: every picture of this member is the new one.
    const shown = page.locator(`img[src="${first.avatar_url}"]:visible`);
    await expect(shown.first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('header a[aria-label="Your profile"] img')).toHaveAttribute('src', first.avatar_url);
    await noSidewaysScroll(page, `${at}: the profile with a photo`);

    // Reopened: the picture chosen and where it was placed. Zoomed all the way out, moved to the blue half and saved:
    // only the crop changes, and the photo is the full 1024 square.
    await pencil.click();
    await expect(sheet.getByRole('slider', { name: 'Zoom' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => zoomOf(sheet)).toBeCloseTo(first.avatar_crop.zoom, 1);
    await expect(frame.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
    await sheet.getByRole('slider', { name: 'Zoom' }).fill('1');
    await drag(page, frame, -900, 0);
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sheet).toHaveCount(0, { timeout: 30_000 });
    const second = await stored(owner.id);
    expect(second.avatar_source).toBe(first.avatar_source);
    expect(second.avatar_crop.x).toBeGreaterThan(0.5);
    expect(second.avatar_url).not.toBe(first.avatar_url);
    expect(await pictureAt(page, second.avatar_url)).toMatchObject({ width: 1024, height: 1024, blue: true });
    await expect(page.locator('header a[aria-label="Your profile"] img')).toHaveAttribute('src', second.avatar_url, { timeout: 20_000 });

    // Cancel leaves everything as it was.
    await pencil.click();
    await expect(sheet.getByRole('slider', { name: 'Zoom' })).toBeVisible({ timeout: 30_000 });
    await drag(page, frame, 300, 0);
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect((await stored(owner.id)).avatar_url).toBe(second.avatar_url);
    expect(unexpected(errors)).toEqual([]);
    await ctx.close();
  });

  test(`the banner: pencil, place, save at 2400 by 800, reopened where it was, placed again (${ENGINE}, ${at})`, async () => {
    test.setTimeout(240_000);
    const owner = await member(`banner${width}`);
    const { ctx, page, errors } = await signedIn(owner, width);
    await gotoRetry(page, `${APP}/profile`);
    await expect(page.getByRole('heading', { level: 1, name: `Pia Picture banner${width}` })).toBeVisible({ timeout: SLOW });
    const banner = page.getByTestId('profile-banner');
    const pencil = banner.getByRole('button', { name: 'Edit banner' });
    await expectReachable(page, pencil, `${at}: the banner's pencil`);
    expect((await pencil.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await pencil.click();
    const sheet = page.getByRole('dialog', { name: 'Edit your banner' });
    await expect(sheet.getByText('No banner yet. Choose a picture to place it.')).toBeVisible({ timeout: 30_000 });
    await sheet.locator('input[type="file"]').setInputFiles({ name: 'wide.jpg', mimeType: 'image/jpeg', buffer: await halves(page, 3000, 1500) });
    await expect(sheet.getByRole('slider', { name: 'Zoom' })).toBeVisible({ timeout: 20_000 });
    await editorFits(page, sheet, `${at}: the banner editor`);
    const frame = sheet.getByTestId('picture-frame');
    await drag(page, frame, 0, -200);
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Your banner is updated.')).toBeVisible({ timeout: 30_000 });
    await expect(sheet).toHaveCount(0);

    const img = banner.locator('img');
    await expect(img).toHaveAttribute('src', new RegExp(`/api/users/${owner.id}/banner\\?v=\\d+$`), { timeout: 20_000 });
    const firstUrl = (await img.getAttribute('src'))!;
    expect(await pictureAt(page, firstUrl)).toMatchObject({ width: 2400, height: 800 });
    const first = await stored(owner.id);
    expect(first.banner_crop.y).toBeGreaterThan(0.5);

    // Reopened with its crop; zoomed in and saved: the picture kept is the same, the crop and the address are new.
    await pencil.click();
    await expect(sheet.getByRole('slider', { name: 'Zoom' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => zoomOf(sheet)).toBeCloseTo(1, 1);
    await sheet.getByRole('button', { name: 'Zoom in' }).click();
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sheet).toHaveCount(0, { timeout: 30_000 });
    const second = await stored(owner.id);
    expect(second.banner_source).toBe(first.banner_source);
    expect(second.banner_crop.zoom).toBeGreaterThan(1);
    await expect(img).not.toHaveAttribute('src', firstUrl, { timeout: 20_000 });
    await noSidewaysScroll(page, `${at}: the profile with a banner`);
    expect(unexpected(errors)).toEqual([]);
    await ctx.close();
  });
}
