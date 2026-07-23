import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';

// Task B2 — client-side truthful state-driven onboarding openings + the
// 'searching' wait stage. The server's own enrichment/status behavior is
// proven by server/src/__tests__/routes/onboarding.test.ts; this spec is
// entirely about the CLIENT stage machine (ChatbotOnboarding.tsx), so
// GET /onboarding/status is stubbed per state via route interception.
//
// stubStatus uses route.fetch() + fulfill({ response, json }) rather than a
// fully synthetic fulfill(): that keeps the REAL response's headers (CORS
// included, since the app origin and the API origin differ in this prod-only
// harness) and only swaps the JSON body, so there is no need to hand-roll
// Access-Control-Allow-* headers here. Everything else (known/resume/enrich)
// hits the real backend: our test user never has a linkedin_url, so the
// client's own enrichment auto-trigger (fires only when known.linkedin
// exists) never calls POST /onboarding/enrich, and a fresh user always has
// no in-progress resume — so 'resume'/'enrich' need no stub either.
//
// The four strings mirror shared/src/types/onboarding.ts's OPENINGS. e2e is
// not an npm-workspace member (see e2e/package.json) so it can't import
// @rsn/shared the way the client does — kept in sync manually here; the
// client itself never duplicates these (imports OPENINGS as a value, see
// ChatbotOnboarding.tsx).
const OPENINGS = {
  searching: 'I am retrieving your public profile. This normally takes less than a minute.',
  found: 'I found your profile. Let me confirm what I understand about you.',
  partial: 'I found part of your profile, but I need your help filling the gaps.',
  not_found: 'I could not reliably identify your profile. Let us build it together.',
} as const;
type Opening = keyof typeof OPENINGS;

let browser: Browser;
let user: TestUser;
const ctxs: BrowserContext[] = [];

/** Stub GET /onboarding/status to always answer with whatever `getOpening()`
 *  currently returns — a plain closure over a `let` in the test lets a single
 *  test simulate a live transition (e.g. searching -> found) by mutating the
 *  variable between assertions, with no second route registration needed. */
async function stubStatus(page: Page, getOpening: () => Opening): Promise<void> {
  await page.route(`${SERVER}/api/onboarding/status`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const opening = getOpening();
    await route.fulfill({
      response,
      json: {
        success: true,
        data: {
          status: 'not_started',
          enrichment: { status: opening, error: null, startedAt: null, completedAt: null },
          opening,
        },
      },
    });
  });
}

async function openOnboarding(viewport = { width: 390, height: 844 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(
    (t: { a: string; r: string }) => {
      localStorage.setItem('rsn_access', t.a);
      localStorage.setItem('rsn_refresh', t.r);
    },
    { a: user.accessToken, r: user.refreshToken },
  );
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  return page;
}

// HostBubble + UserBubble both render with `whitespace-pre-wrap`; before any
// reply is sent only assistant bubbles exist, so `.first()` is reliably the
// opening line (openingMessages() pushes [opening, question] together).
const firstBubble = (page: Page) => page.locator('.whitespace-pre-wrap').first();

test.beforeAll(async () => {
  // This spec is entirely about the client-side onboarding stage machine, so
  // the seeded user should stay in the pre-onboarding state its intent
  // describes rather than picking up createTestUser()'s 'completed' default
  // (opt-out via the explicit onboardingStatus param — see e2e/helpers/auth.ts).
  user = await createTestUser('onbstates', 'member', 'not_started');
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try {
    await browser?.close();
  } catch {}
  await cleanup(pool, { ids: [user?.id].filter(Boolean) });
});

test('searching blocks chat and the confirm card, and shows the searching copy', async () => {
  test.setTimeout(60_000);
  const page = await openOnboarding();
  await stubStatus(page, () => 'searching');
  await gotoRetry(page, `${APP}/onboarding`);

  await expect(page.getByText(OPENINGS.searching)).toBeVisible({ timeout: 20_000 });
  // Blocked: no chat input, no confirm card — nothing to do until it resolves.
  await expect(page.locator('textarea[aria-label="Your answer"]')).toHaveCount(0);
  await expect(page.getByText(/Is it right\?/i)).toHaveCount(0);
  console.log('  ✓ searching: wait card shown, chat + confirm card both blocked.');
});

test('not_found skips the confirm card entirely and opens straight to chat', async () => {
  test.setTimeout(60_000);
  const page = await openOnboarding();
  await stubStatus(page, () => 'not_found');
  await gotoRetry(page, `${APP}/onboarding`);

  await expect(firstBubble(page)).toHaveText(OPENINGS.not_found, { timeout: 20_000 });
  await expect(page.getByText(/Is it right\?/i)).toHaveCount(0); // never, not even transiently
  await expect(page.locator('textarea[aria-label="Your answer"]')).toBeVisible();
  console.log('  ✓ not_found: no confirm card, chat opens directly with the not_found opening.');
});

test('found shows the confirm card first, then its opening as the first chat bubble', async () => {
  test.setTimeout(60_000);
  const page = await openOnboarding();
  await stubStatus(page, () => 'found');
  await gotoRetry(page, `${APP}/onboarding`);

  await expect(page.getByText(/Is it right\?/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(OPENINGS.searching)).toHaveCount(0); // wait card is gone by now
  await page.getByRole('button', { name: /Yes, continue/i }).click();

  await expect(firstBubble(page)).toHaveText(OPENINGS.found, { timeout: 15_000 });
  console.log('  ✓ found: confirm card first, then the found opening on continue.');
});

test('partial shows the confirm card first, then its opening as the first chat bubble', async () => {
  test.setTimeout(60_000);
  const page = await openOnboarding();
  await stubStatus(page, () => 'partial');
  await gotoRetry(page, `${APP}/onboarding`);

  await expect(page.getByText(/Is it right\?/i)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /Yes, continue/i }).click();

  await expect(firstBubble(page)).toHaveText(OPENINGS.partial, { timeout: 15_000 });
  console.log('  ✓ partial: confirm card first, then the partial opening on continue.');
});

test('searching -> found transitions live: the wait card swaps for the confirm card without a reload', async () => {
  test.setTimeout(60_000);
  let opening: Opening = 'searching';
  const page = await openOnboarding();
  // Reruns on every new document (full navigation/reload); stays 1 if the
  // transition below is a pure React state update.
  await page.addInitScript(() => {
    (window as unknown as { __navCount: number }).__navCount = ((window as unknown as { __navCount: number }).__navCount || 0) + 1;
  });
  await stubStatus(page, () => opening);
  await gotoRetry(page, `${APP}/onboarding`);

  await expect(page.getByText(OPENINGS.searching)).toBeVisible({ timeout: 20_000 });
  opening = 'found';
  // The next poll tick (every 2.5s, see ChatbotOnboarding.tsx) picks this up —
  // no page.reload() or page.goto() call anywhere in this test.
  await expect(page.getByText(/Is it right\?/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(OPENINGS.searching)).toHaveCount(0);

  const navCount = await page.evaluate(() => (window as unknown as { __navCount: number }).__navCount);
  expect(navCount).toBe(1);
  console.log('  ✓ searching→found: swapped live in place, no reload.');
});

test('searching wait card has no horizontal overflow at 360px (mobile-first floor)', async () => {
  test.setTimeout(60_000);
  const page = await openOnboarding({ width: 360, height: 740 });
  await stubStatus(page, () => 'searching');
  await gotoRetry(page, `${APP}/onboarding`);

  await expect(page.getByText(OPENINGS.searching)).toBeVisible({ timeout: 20_000 });
  const [scrollWidth, clientWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1); // +1: sub-pixel rounding
  console.log('  ✓ searching card: no horizontal overflow at 360px.');
});
