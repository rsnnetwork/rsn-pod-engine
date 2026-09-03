import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// THE PROFILE CARD (13 Aug 2026 meeting, Task D1).
//
// Stefan: "Profile card needs a major visual upgrade" and "About was cut off /
// too narrow." This walks a profile with a long name, a long title and a long
// About at every width we support and asserts OUTCOMES: the whole About is
// rendered (no clip, no fixed box), nothing scrolls sideways, and the meeting
// action still stands where it was, at tap size.

let browser: Browser;
let viewer: TestUser;
let subject: TestUser;
const ctxs: BrowserContext[] = [];

const LONG_BIO = ('I build small, fast products for teams that cannot afford slow ones. ' +
  'Before that I ran platform engineering at two scale-ups and one bank, which taught me what not to do. ').repeat(4).trim();

async function setProfile(u: TestUser, cols: Record<string, string | string[] | null>) {
  const keys = Object.keys(cols);
  await pool.query(
    `UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [u.id, ...keys.map(k => cols[k])],
  );
}

async function openAs(u: TestUser, path: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

test.beforeAll(async () => {
  viewer = await createTestUser('profilecardviewer');
  subject = await createTestUser('profilecardsubject');
  await setProfile(subject, {
    display_name: 'Bartholomew Featherstonehaugh-Quartermaine',
    job_title: 'Principal Distributed Systems Engineer and Head of Platform',
    company: 'Quartermaine Featherstonehaugh Laboratories International',
    location: 'Copenhagen',
    bio: LONG_BIO,
    expertise_text: 'distributed systems, react, typescript',
    who_i_want_to_meet: 'founders who need a technical partner',
  });
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [viewer?.id, subject?.id].filter(Boolean);
  await cleanup(pool, { ids });
  const swept = await cleanupByPrefix(pool, 'e2etest-profilecard');
  if (swept) console.log(`  swept ${swept} leftover profilecard* account(s)`);
});

test('the whole About shows at every width, nothing scrolls sideways, and the meet action is tappable', async () => {
  test.setTimeout(300_000);
  for (const width of [360, 390, 768, 1024, 1280]) {
    const page = await openAs(viewer, `/profile/${subject.id}`, { width, height: 900 });

    const about = page.getByTestId('profile-about');
    await expect(about, `About present at ${width}px`).toBeVisible({ timeout: 30_000 });
    await expect(about).toContainText('one bank, which taught me what not to do');

    // Not clipped: no line-clamp, no fixed height — the box grows with the text.
    const clipped = await about.evaluate(el => el.scrollHeight > el.clientHeight + 2);
    expect(clipped, `About clipped at ${width}px`).toBe(false);

    // Long name and title wrap rather than overflow.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Featherstonehaugh');
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `sideways scroll at ${width}px`).toBeLessThanOrEqual(0);

    // The way through still stands, at tap size, inside the viewport.
    const meet = page.getByTestId('meet-state');
    await expect(meet).toBeVisible({ timeout: 20_000 });
    const box = await meet.boundingBox();
    expect(box!.height, `meet button tap target at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width, `meet button inside ${width}px`).toBeLessThanOrEqual(width);

    await page.context().close();
    console.log(`  ✓ ${width}px: About whole, no sideways scroll, meet button ${Math.round(box!.height)}px.`);
  }
});

test('the card is wider on desktop than it was, so About reads as prose rather than a column', async () => {
  const page = await openAs(viewer, `/profile/${subject.id}`, { width: 1280, height: 900 });
  const card = page.getByTestId('profile-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  const box = await card.boundingBox();
  // max-w-xl was 576px; the card now sits at max-w-3xl (768px) on desktop.
  expect(box!.width, 'card width on desktop').toBeGreaterThan(700);
});

test('your own profile shows no meet, block or report actions', async () => {
  const page = await openAs(subject, `/profile/${subject.id}`, { width: 390, height: 844 });
  await expect(page.getByTestId('profile-about')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('meet-state')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Block/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Report this member/ })).toHaveCount(0);
});
