// Browser UI test — drives Chromium against https://app.rsn.network to
// verify the Phase P "Join as host" banner renders for a non-director
// admin and disappears after the user picks an option.
//
// Auth bypass: client persists tokens in localStorage under `rsn_access` /
// `rsn_refresh`. We seed those keys directly so we don't need to navigate
// through the magic-link email flow.

import { test, expect, chromium } from '@playwright/test';
import { createTestUser, cleanupTestData, pool, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession, apiRequest } from '../helpers/api';

const APP = process.env.E2E_CLIENT_URL || 'https://app.rsn.network';

test.describe.serial('Phase P UI — Join-as banner + director toggle hidden', () => {
  let director: TestUser;
  let shradha: TestUser;
  let podId: string;
  let sessionId: string;

  test.beforeAll(async () => {
    director = await createTestUser('pjp-ui-director', 'member');
    shradha = await createTestUser('pjp-ui-shradha', 'admin');

    const pod = await createPod(director, 'E2E Phase P UI Pod');
    podId = pod.id;
    await addPodMember(director, podId, shradha.id);

    const sess = await createSession(director, podId, 'E2E Phase P UI', new Date(Date.now() + 60_000));
    sessionId = sess.id;
    await registerForSession(shradha, sessionId);
  });

  test.afterAll(async () => {
    try { await endSession(director, sessionId); } catch { /* may already be ended */ }
    const result = await cleanupTestData();
    // eslint-disable-next-line no-console
    console.log('Phase P UI cleanup:', result);
    await closePool();
  });

  test('admin (non-director) sees the join-as banner with both buttons', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Seed auth tokens before the SPA loads.
    await page.goto(APP);
    await page.evaluate(([access, refresh]) => {
      localStorage.setItem('rsn_access', access);
      localStorage.setItem('rsn_refresh', refresh);
    }, [shradha.accessToken, shradha.refreshToken]);

    // Navigate to the live event page.
    await page.goto(`${APP}/session/${sessionId}/live`);

    // The banner has data-testid="join-as-banner" with two child buttons.
    const banner = page.getByTestId('join-as-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });

    const hostBtn = page.getByTestId('join-as-banner-host');
    const participantBtn = page.getByTestId('join-as-banner-participant');
    await expect(hostBtn).toBeVisible();
    await expect(participantBtn).toBeVisible();

    await browser.close();
  });

  test('clicking "Join as participant" dismisses the banner and persists the override', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(APP);
    await page.evaluate(([access, refresh]) => {
      localStorage.setItem('rsn_access', access);
      localStorage.setItem('rsn_refresh', refresh);
    }, [shradha.accessToken, shradha.refreshToken]);
    await page.goto(`${APP}/session/${sessionId}/live`);

    const participantBtn = page.getByTestId('join-as-banner-participant');
    await expect(participantBtn).toBeVisible({ timeout: 15_000 });
    await participantBtn.click();

    // Banner should disappear within 5 seconds (after the snapshot resync).
    const banner = page.getByTestId('join-as-banner');
    await expect(banner).not.toBeVisible({ timeout: 10_000 });

    // Server-side: override is set to false.
    const row = await pool.query<{ acting_as_host: boolean | null }>(
      `SELECT acting_as_host FROM session_participants WHERE session_id = $1 AND user_id = $2`,
      [sessionId, shradha.id],
    );
    expect(row.rows[0]?.acting_as_host).toBe(false);

    await browser.close();
  });

  test('director on their OWN event does NOT see the join-as banner', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(APP);
    await page.evaluate(([access, refresh]) => {
      localStorage.setItem('rsn_access', access);
      localStorage.setItem('rsn_refresh', refresh);
    }, [director.accessToken, director.refreshToken]);
    await page.goto(`${APP}/session/${sessionId}/live`);

    // Wait for the page to load past the auth check.
    await page.waitForTimeout(5_000);

    const banner = page.getByTestId('join-as-banner');
    // Banner must NOT be visible for the director.
    await expect(banner).not.toBeVisible();

    await browser.close();
  });
});
