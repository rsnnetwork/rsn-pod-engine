import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';

// Task D2 — always-on re-onboarding route gate. D1 made GET /auth/session
// return onboardingStatus ('not_started'|'in_progress'|'completed'|
// 'needs_review'|'update_required'); ProtectedRoute now redirects to
// /onboarding whenever that status isn't 'completed', except the exempt
// paths (/onboarding itself, /invite/:code, and /session/:id/live). See
// client/src/components/layout/ProtectedRoute.tsx.
//
// createTestUser() only sets the legacy onboarding_completed boolean; the
// new onboarding_status column defaults to 'not_started' (migration 069),
// so every scenario here sets it explicitly via `pool` to the exact status
// under test — the same "real user + direct DB setup" pattern the rest of
// the harness uses (see e2e/helpers/auth.ts, e2e/tests/onboarding-states.spec.ts).
//
// Scenario (b) drives the real ChatbotOnboarding UI through to the confirm
// step, but stubs the three onboarding endpoints that would otherwise need a
// real LLM round trip (status/chat/confirm) — same route.fetch()+fulfill()
// technique as onboarding-states.spec.ts's stubStatus, which forwards the
// real response and only swaps the JSON body. The confirm stub also performs
// the real DB flip (onboarding_status='completed') that the real backend
// would do, so the subsequent GET /auth/session (never stubbed) reports the
// gate as satisfied exactly like it would after a real confirm — proving the
// CLIENT gate/redirect contract without needing a live Anthropic call.

let browser: Browser;
const ctxs: BrowserContext[] = [];
const userIds: string[] = [];

async function setStatus(userId: string, status: string): Promise<void> {
  await pool.query(`UPDATE users SET onboarding_status = $2 WHERE id = $1`, [userId, status]);
}

async function openPage(user: TestUser, viewport = { width: 390, height: 844 }): Promise<Page> {
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

test.beforeAll(async () => {
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try {
    await browser?.close();
  } catch {}
  await cleanup(pool, { ids: userIds });
});

test('update_required user landing on / is redirected to /onboarding', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-a');
  userIds.push(user.id);
  await setStatus(user.id, 'update_required');

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/`);

  await page.waitForURL(/\/onboarding(\?|$)/, { timeout: 20_000 });
  expect(page.url()).toContain('/onboarding');
  expect(decodeURIComponent(page.url())).toContain('redirect=/');
  console.log('  ✓ update_required + / -> redirected to /onboarding with redirect param.');
});

test('completed user is untouched — no redirect away from /', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-c');
  userIds.push(user.id);
  await setStatus(user.id, 'completed');

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/`);

  // Give the SPA a beat to mount and for ProtectedRoute to evaluate the gate;
  // then assert it settled on the real target, not /onboarding.
  await page.waitForLoadState('networkidle').catch(() => {});
  expect(page.url()).not.toContain('/onboarding');
  console.log('  ✓ completed status: no gate redirect, stayed on /.');
});

test('completing onboarding (stubbed chat + confirm) exits the gate and lands on the redirect target', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-b');
  userIds.push(user.id);
  await setStatus(user.id, 'update_required');

  const page = await openPage(user);

  // Force the fast not_found path (skips the confirm card, opens straight to
  // chat) so the test never depends on real enrichment timing.
  await page.route(`${SERVER}/api/onboarding/status`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        success: true,
        data: {
          status: 'update_required',
          enrichment: { status: 'not_found', error: null, startedAt: null, completedAt: null },
          opening: 'not_found',
        },
      },
    });
  });

  // Stub the one chat turn so "ready" flips immediately — no real LLM call.
  await page.route(`${SERVER}/api/onboarding/chat`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { reply: 'Thanks, that helps.', ready: true } }),
    });
  });

  // Best-effort live-profile call fired in the background — stub so it never
  // reaches a real LLM either (fire-and-forget on the client, .catch()'d).
  await page.route(`${SERVER}/api/onboarding/profile`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { profile: {} } }),
    });
  });

  // Stub confirm: perform the real DB flip a genuine confirm call would do
  // (onboarding_status='completed'), then answer success — this is the
  // "stubbing the confirm" path the task brief allows in place of driving a
  // real LLM extraction call.
  await page.route(`${SERVER}/api/onboarding/confirm`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await setStatus(user.id, 'completed');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { summary: 'stub summary', profileComplete: true } }),
    });
  });

  // Land on a distinct protected path so "lands on the redirect target" is a
  // meaningful assertion (not just the same path we started from).
  await gotoRetry(page, `${APP}/profile`);
  await page.waitForURL(/\/onboarding\?redirect=/, { timeout: 20_000 });
  expect(decodeURIComponent(page.url())).toContain('redirect=/profile');

  await expect(page.locator('textarea[aria-label="Your answer"]')).toBeVisible({ timeout: 20_000 });
  await page.locator('textarea[aria-label="Your answer"]').fill('I want to meet other founders.');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('button', { name: /Yes, use this/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Yes, use this/i }).click();

  // checkSession() re-fetches the REAL /auth/session (never stubbed), which
  // now reports 'completed' thanks to the DB flip above — the gate should
  // let the client-side navigate(redirect) land on /profile and stay there.
  await page.waitForURL(/\/profile$/, { timeout: 20_000 });
  expect(page.url()).not.toContain('/onboarding');
  console.log('  ✓ confirm completes onboarding_status and lands on the original redirect target (/profile).');
});

test('/invite/:code passes through ungated for an update_required user', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-d');
  userIds.push(user.id);
  await setStatus(user.id, 'update_required');

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/invite/does-not-exist-e2e`);
  await page.waitForLoadState('networkidle').catch(() => {});

  expect(page.url()).not.toContain('/onboarding');
  expect(page.url()).toContain('/invite/does-not-exist-e2e');
  console.log('  ✓ /invite/:code exempt: no gate redirect even with update_required status.');
});

test('a live-session path passes through ungated for an update_required user', async () => {
  test.setTimeout(60_000);
  const user = await createTestUser('reonb-e');
  userIds.push(user.id);
  await setStatus(user.id, 'update_required');

  const page = await openPage(user);
  await gotoRetry(page, `${APP}/session/does-not-exist-e2e/live`);
  await page.waitForLoadState('networkidle').catch(() => {});

  expect(page.url()).not.toContain('/onboarding');
  console.log('  ✓ /session/:id/live exempt: no gate redirect even with update_required status.');
});
