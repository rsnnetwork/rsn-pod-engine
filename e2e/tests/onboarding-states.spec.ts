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
// no in-progress resume — so 'resume'/'enrich' need no stub either. The one
// exception is the none -> searching -> found transition test at the bottom,
// which is ABOUT the auto-trigger: it stubs /known (adds a linkedin) and
// answers POST /onboarding/enrich synthetically so no real provider run can
// ever start from this spec.
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
let freshUser: TestUser; // For test 6: candidate seeding with no saved profile
let asklinkUser: TestUser; // For the ask-for-LinkedIn tests: no linkedin_url on file
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

async function openOnboarding(viewport = { width: 390, height: 844 }, testUser = user): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(
    (t: { a: string; r: string }) => {
      localStorage.setItem('rsn_access', t.a);
      localStorage.setItem('rsn_refresh', t.r);
    },
    { a: testUser.accessToken, r: testUser.refreshToken },
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
  // Task asklink: ChatbotOnboarding now asks once for a LinkedIn URL up front
  // when known.linkedin is empty (a new 'asklink' stage, decided before the
  // searching poll ever runs — see ChatbotOnboarding.tsx). createTestUser never
  // seeds linkedin_url, so every test below that reuses this shared `user`
  // would now land on the ask screen instead of the state it means to test.
  // Reconciliation: give the shared user a linkedin_url here (least invasive —
  // one line, vs. stubbing GET /onboarding/known in every existing test body)
  // so those tests keep exercising the states they're actually about; the
  // ask-screen behavior itself gets its own dedicated tests below, using a
  // separate user with no linkedin_url.
  await pool.query("UPDATE users SET linkedin_url = $2 WHERE id = $1", [
    user.id,
    'https://www.linkedin.com/in/onbstates-shared-e2e',
  ]);
  // Test 6 (none → searching → found) requires a fresh profile with no saved
  // fields so that the LinkedIn candidate fills the confirm card. createTestUser
  // seeds company='TestCo', so create a dedicated user and blank those fields.
  freshUser = await createTestUser('onbfresh', 'member', 'not_started');
  await pool.query(
    "UPDATE users SET company = NULL, job_title = NULL, bio = NULL, industry = NULL, location = NULL WHERE id = $1",
    [freshUser.id]
  );
  // Task asklink: dedicated user with NO linkedin_url on file, for the two
  // ask-screen tests below.
  asklinkUser = await createTestUser('onbasklink', 'member', 'not_started');
  await pool.query(
    "UPDATE users SET company = NULL, job_title = NULL, bio = NULL, industry = NULL, location = NULL, linkedin_url = NULL WHERE id = $1",
    [asklinkUser.id]
  );
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try {
    await browser?.close();
  } catch {}
  await cleanup(pool, { ids: [user?.id, freshUser?.id, asklinkUser?.id].filter(Boolean) });
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

test('none with a LinkedIn on file does NOT settle: the client fires the enrich trigger, keeps polling through none -> searching, and lands found', async () => {
  // Pins the CRITICAL-1 fix: enrichment.status 'none' maps to opening
  // 'not_found' server-side, but when a LinkedIn URL is on file that first
  // response is the very poll that TRIGGERS the search — settling on it
  // would flash "could not identify" while the job it just started runs
  // (the approved join-request preload case: cached blob, state columns
  // still 'none'). The client must keep polling instead.
  test.setTimeout(90_000);
  let phase: 'none' | 'searching' | 'found' = 'none';
  let enrichCalls = 0;
  let statusCalls = 0;
  const candidate = {
    fullName: 'Onb States',
    currentRole: 'CTO',
    currentCompany: 'Acme GmbH',
    industry: 'Software',
    location: 'Berlin',
    summary: 'Builds things.',
    likelyWantsToMeet: ['investors'],
    likelyOffers: ['engineering leadership'],
    linkedinUrl: 'https://www.linkedin.com/in/onbstates-e2e',
  };

  const page = await openOnboarding({ width: 390, height: 844 }, freshUser);

  // The trigger only fires when known.linkedin exists — add one to the real
  // /known response (route.fetch keeps the genuine CORS headers).
  await page.route(`${SERVER}/api/onboarding/known`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.data = { ...json.data, linkedin: candidate.linkedinUrl };
    await route.fulfill({ response, json });
  });

  // Answer the enrich trigger synthetically — 202 searching, no real provider
  // run. OPTIONS preflight continues to the real backend (it answers CORS);
  // the POST itself never leaves the browser, so ACAO is hand-rolled ('*' is
  // fine — the client's axios never uses credentials mode).
  await page.route(`${SERVER}/api/onboarding/enrich`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    enrichCalls += 1;
    await route.fulfill({
      status: 202,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { status: 'searching' } }),
    });
  });

  // Status stub mirrors the real server mapping per phase: 'none' reads as
  // opening 'not_found' (that is the trap), then searching, then found with
  // the candidate riding along exactly like the fixed GET /onboarding/status.
  await page.route(`${SERVER}/api/onboarding/status`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    statusCalls += 1;
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        success: true,
        data: {
          status: 'not_started',
          enrichment: {
            status: phase,
            error: null,
            startedAt: null,
            completedAt: null,
            ...(phase === 'found' ? { candidate } : {}),
          },
          opening: phase === 'none' ? 'not_found' : phase,
        },
      },
    });
  });

  await gotoRetry(page, `${APP}/onboarding`);

  // The 'none' poll fired the trigger...
  await expect.poll(() => enrichCalls, { timeout: 20_000 }).toBeGreaterThan(0);
  // ...and the client did NOT settle on that same response: two more polls
  // later it is still on the wait card — no chat, no confirm card, and above
  // all no "could not identify" opening.
  const settledAt = statusCalls;
  await expect.poll(() => statusCalls, { timeout: 20_000 }).toBeGreaterThanOrEqual(settledAt + 2);
  await expect(page.getByText(OPENINGS.searching)).toBeVisible();
  await expect(page.locator('textarea[aria-label="Your answer"]')).toHaveCount(0);
  await expect(page.getByText(/Is it right\?/i)).toHaveCount(0);
  console.log('  ✓ none+linkedin: trigger fired, client kept polling instead of settling not_found.');

  // The triggered job progresses: none -> searching (still waiting) -> found.
  phase = 'searching';
  await expect(page.getByText(OPENINGS.searching)).toBeVisible();
  phase = 'found';
  await expect(page.getByText(/Is it right\?/i)).toBeVisible({ timeout: 15_000 });
  // CRITICAL-2 seam: the candidate seeded the confirm card.
  await expect(page.getByText('Acme GmbH')).toBeVisible();
  await expect(page.getByText('Builds things.')).toBeVisible();

  await page.getByRole('button', { name: /Yes, continue/i }).click();
  await expect(firstBubble(page)).toHaveText(OPENINGS.found, { timeout: 15_000 });
  console.log('  ✓ none→searching→found: landed the found opening with the candidate on the card.');
});

test('failed status with a LinkedIn on file retries once via the enrich trigger; a second failed response settles on the partial opening (profile data already on file)', async () => {
  // Pins the retry-once fix: enrichment.status 'failed' is no longer a life
  // sentence when a LinkedIn URL is on file — the client fires ONE retry (same
  // trigger as the none-branch above) and treats that first failed response as
  // still-searching rather than settling on it. If the retry itself concludes
  // in failure again, the client settles this time, using the server's honest
  // opening: since this member has substantive profile data on file, the
  // Claus-rule mapping opens 'partial' (never the not_found "could not
  // identify" copy next to a card that already shows real data) even though
  // enrichment genuinely failed twice. This stub sets `opening` directly to
  // mirror what GET /onboarding/status now returns for failed+hasProfileData.
  test.setTimeout(60_000);
  let enrichCalls = 0;

  const page = await openOnboarding({ width: 390, height: 844 }, freshUser);

  // The trigger only fires when known.linkedin exists.
  await page.route(`${SERVER}/api/onboarding/known`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.data = { ...json.data, linkedin: 'https://www.linkedin.com/in/onbstates-failed-e2e' };
    await route.fulfill({ response, json });
  });

  // Answer the retry synthetically — 202 searching, no real provider run.
  await page.route(`${SERVER}/api/onboarding/enrich`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    enrichCalls += 1;
    await route.fulfill({
      status: 202,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { status: 'searching' } }),
    });
  });

  // enrichment.status stays 'failed' on every poll (the retry concludes in
  // failure again), but opening is 'partial' throughout, mirroring the fixed
  // server mapping for failed+hasProfileData=true.
  await page.route(`${SERVER}/api/onboarding/status`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        success: true,
        data: {
          status: 'not_started',
          enrichment: { status: 'failed', error: null, startedAt: null, completedAt: null },
          opening: 'partial',
        },
      },
    });
  });

  await gotoRetry(page, `${APP}/onboarding`);

  // The first 'failed' poll fires the retry trigger and does NOT settle: still
  // the searching wait card, no confirm card, no chat input.
  await expect.poll(() => enrichCalls, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.getByText(OPENINGS.searching)).toBeVisible();
  await expect(page.locator('textarea[aria-label="Your answer"]')).toHaveCount(0);
  await expect(page.getByText(/Is it right\?/i)).toHaveCount(0);
  console.log('  ✓ failed+linkedin: first response not settled, retry trigger fired once.');

  // The very next poll settles: the retry concluded in failure again, but the
  // opening honors the profile data on file — partial, never not_found.
  await expect(page.getByText(/Is it right\?/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(OPENINGS.not_found)).toHaveCount(0);
  await page.getByRole('button', { name: /Yes, continue/i }).click();
  await expect(firstBubble(page)).toHaveText(OPENINGS.partial, { timeout: 15_000 });

  // Retry-once: exactly one enrich call ever fired, no infinite loop.
  expect(enrichCalls).toBe(1);
  console.log('  ✓ failed→failed: retried once, settled partial (profile data on file), never not_found.');
});

test('searching wait card has no horizontal overflow at 360px (mobile-first floor)', async () => {
  test.setTimeout(60_000);
  const page = await openOnboarding({ width: 360, height: 740 });
  await stubStatus(page, () => 'searching');
  await gotoRetry(page, `${APP}/onboarding`);

  await expect(page.getByText(OPENINGS.searching)).toBeVisible({ timeout: 20_000 });
  // Poll until animations settle and the overflow assertion is stable.
  await expect.poll(
    async () => {
      const [scrollWidth, clientWidth] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      return scrollWidth <= clientWidth + 1; // +1: sub-pixel rounding
    },
    { timeout: 10_000 }
  ).toBe(true);
  console.log('  ✓ searching card: no horizontal overflow at 360px.');
});

test('searching wait card fits at tablet and desktop widths (768, 1024, 1280)', async () => {
  // Three sequential full page loads against prod; 60s flaked under
  // parallel-file CPU contention (timeout, never an assert failure).
  test.setTimeout(150_000);
  const viewports = [768, 1024, 1280];

  for (const width of viewports) {
    const page = await openOnboarding({ width, height: 900 });
    await stubStatus(page, () => 'searching');
    await gotoRetry(page, `${APP}/onboarding`);

    // (a) The searching copy is visible
    await expect(page.getByText(OPENINGS.searching)).toBeVisible({ timeout: 20_000 });

    // (b) No horizontal overflow at the document level
    await expect.poll(
      async () => {
        const [scrollWidth, clientWidth] = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ]);
        return scrollWidth <= clientWidth + 1; // +1: sub-pixel rounding
      },
      { timeout: 10_000 }
    ).toBe(true);

    // (c) The wait card's boundingBox fits within the viewport width
    // 0.5px tolerance: under non-integer devicePixelRatio (Windows display scaling)
    // Chromium reports fractional boundingBox readback for CSS-pinned elements.
    const cardLocator = page.locator('div').filter({
      has: page.getByText(OPENINGS.searching),
    }).first();
    const box = await cardLocator.boundingBox();
    expect(box, `wait card must have a bounding box at ${width}px`).toBeTruthy();
    expect(box!.x, `wait card must not start off-screen at ${width}px`).toBeGreaterThanOrEqual(0);
    expect(
      box!.x + box!.width,
      `wait card must fit within the ${width}px viewport`
    ).toBeLessThanOrEqual(width + 0.5);

    // Detach route handlers BEFORE closing: the client polls /status every
    // 2.5s, and a poll in flight during teardown makes the handler's
    // route.fetch() throw "context has been closed". ignoreErrors swallows
    // exactly that race.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.context().close();
    console.log(`  ✓ searching card: fits at ${width}px.`);
  }
});

// Task asklink — members with no LinkedIn URL on file are asked once, up
// front, before the searching poll ever starts (a new 'asklink' stage, keyed
// on GET /onboarding/known's linkedin field, decided in ChatbotOnboarding's
// mount effect). asklinkUser has linkedin_url = NULL (see beforeAll), so the
// real /onboarding/known response naturally has no linkedin — no need to stub
// that route for either test below.

test('asklink: a member with no LinkedIn on file sees the ask screen; Skip settles on the honest not_found opening with no confirm card', async () => {
  test.setTimeout(60_000);
  const page = await openOnboarding({ width: 390, height: 844 }, asklinkUser);
  await stubStatus(page, () => 'not_found');
  await gotoRetry(page, `${APP}/onboarding`);

  await expect(page.locator('input[aria-label="Your LinkedIn URL"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: /Fetch my details/i })).toBeDisabled();
  // Blocked, same as the searching wait card: no chat, no confirm card yet.
  await expect(page.locator('textarea[aria-label="Your answer"]')).toHaveCount(0);
  await expect(page.getByText(/Is it right\?/i)).toHaveCount(0);

  await page.getByRole('button', { name: /Skip for now/i }).click();

  // Skip sets no URL client-side; the searching effect's poll settles on the
  // server's honest opening on the very first response (no confirm card,
  // straight to chat) — same "none + no URL" settle-immediately behavior the
  // other states tests above already pin.
  await expect(firstBubble(page)).toHaveText(OPENINGS.not_found, { timeout: 20_000 });
  await expect(page.getByText(/Is it right\?/i)).toHaveCount(0);
  console.log('  ✓ asklink: ask screen shown for a no-URL member; Skip settled the honest not_found opening.');
});

test('asklink: a pasted bare slug canonicalizes into the enrich trigger and lands on the confirm card', async () => {
  test.setTimeout(90_000);
  let phase: 'none' | 'searching' | 'found' = 'none';
  let enrichBody: unknown = null;
  const candidate = {
    fullName: 'Onb Asklink',
    currentRole: 'Founder',
    currentCompany: 'Slug Co',
    industry: 'Software',
    location: 'Berlin',
    summary: 'Builds things.',
    likelyWantsToMeet: ['investors'],
    likelyOffers: ['engineering leadership'],
    linkedinUrl: 'https://www.linkedin.com/in/onbasklink-e2e-slug',
  };

  const page = await openOnboarding({ width: 390, height: 844 }, asklinkUser);

  // Answer the enrich trigger synthetically — 202 searching, no real provider
  // run — and capture the body so the canonicalized URL can be asserted.
  await page.route(`${SERVER}/api/onboarding/enrich`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    enrichBody = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      headers: { 'access-control-allow-origin': '*' },
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { status: 'searching' } }),
    });
  });

  // 'none' -> the trap (client must keep polling instead of settling
  // not_found, same as the none+linkedin test above) -> searching -> found.
  await page.route(`${SERVER}/api/onboarding/status`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        success: true,
        data: {
          status: 'not_started',
          enrichment: {
            status: phase,
            error: null,
            startedAt: null,
            completedAt: null,
            ...(phase === 'found' ? { candidate } : {}),
          },
          opening: phase === 'none' ? 'not_found' : phase,
        },
      },
    });
  });

  await gotoRetry(page, `${APP}/onboarding`);

  const askInput = page.locator('input[aria-label="Your LinkedIn URL"]');
  await expect(askInput).toBeVisible({ timeout: 20_000 });
  const fetchButton = page.getByRole('button', { name: /Fetch my details/i });
  await expect(fetchButton).toBeDisabled();

  // A bare slug (no scheme, no /in/) — the lenient case the design calls out.
  await askInput.fill('onbasklink-e2e-slug');
  await expect(fetchButton).toBeEnabled();
  await fetchButton.click();

  // Submitting routes straight into 'searching', which fires the enrich
  // trigger with the canonicalized URL — never the raw slug the member typed.
  await expect(page.getByText(OPENINGS.searching)).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => enrichBody, { timeout: 20_000 })
    .toEqual({ linkedinUrl: 'https://www.linkedin.com/in/onbasklink-e2e-slug' });
  console.log('  ✓ asklink: bare slug canonicalized before the enrich trigger fired.');

  // The triggered job progresses: none -> searching (still waiting) -> found.
  phase = 'searching';
  await expect(page.getByText(OPENINGS.searching)).toBeVisible();
  phase = 'found';
  await expect(page.getByText(/Is it right\?/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Slug Co')).toBeVisible();

  await page.getByRole('button', { name: /Yes, continue/i }).click();
  await expect(firstBubble(page)).toHaveText(OPENINGS.found, { timeout: 15_000 });
  console.log('  ✓ asklink: none→searching→found landed the found opening with the candidate on the card.');
});
