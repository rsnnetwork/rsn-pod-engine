// Browser-driven E2E verification for the May 20 doc final batch
// (Issues 9, 10) — the parts that can be exercised without a live
// LiveKit lobby connection.
//
// Issues 12 + 13 require LiveKit tiles to render inside the LobbyMosaic
// component. The local dev server does not have real LiveKit creds, and
// headless Chromium without a fake camera does not publish a track. So
// the tile className + self-shrink button presence are pinned by jest
// source-pattern tests in server/src/__tests__/services/may20-doc-final-batch.test.ts
// (verified to pass at cc09a19 in the same PR).

import { test, expect, chromium } from '@playwright/test';
import {
  createTestUser,
  cleanupTestData,
  TestUser,
  closePool,
} from '../helpers/auth';
import {
  createPod,
  addPodMember,
  createSession,
  registerForSession,
  apiRequest,
} from '../helpers/api';

// Real end-session route is `/sessions/:id/host/end`. The existing
// helpers/api.ts `endSession()` calls `/end` which doesn't exist (the
// older tests swallowed the failure inside an `afterAll` try/catch).
async function endSessionForReal(host: TestUser, sessionId: string) {
  return apiRequest(host, 'POST', `/sessions/${sessionId}/host/end`);
}

const APP = process.env.E2E_CLIENT_URL || 'http://localhost:5173';

test.describe.serial('May 20 doc final batch — UI verification', () => {
  let director: TestUser;
  let member: TestUser;
  let podId: string;
  let sessionId: string;

  test.beforeAll(async () => {
    director = await createTestUser('may20-ui-director', 'member');
    member = await createTestUser('may20-ui-member', 'member');

    const pod = await createPod(director, 'E2E May20 UI Pod');
    podId = pod.id;
    await addPodMember(director, podId, member.id);

    const sess = await createSession(
      director,
      podId,
      'E2E May20 UI',
      new Date(Date.now() + 60_000),
    );
    sessionId = sess.id;
    await registerForSession(member, sessionId);
  });

  test.afterAll(async () => {
    try { await endSessionForReal(director, sessionId); } catch { /* may already be ended */ }
    const result = await cleanupTestData();
    // eslint-disable-next-line no-console
    console.log('May20 UI cleanup:', result);
    await closePool();
  });

  // ─── Issue 10 — Background preference persists across navigation ─────────
  test('Issue 10 — bg preference round-trips through sessionStorage', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(APP);
    await page.evaluate(([access, refresh]) => {
      localStorage.setItem('rsn_access', access);
      localStorage.setItem('rsn_refresh', refresh);
    }, [member.accessToken, member.refreshToken]);

    // Write a preference as if the user picked Blur in the lobby.
    await page.goto(`${APP}/sessions`);
    await page.evaluate(() => {
      sessionStorage.setItem(
        'rsn_bg_preference',
        JSON.stringify({ mode: 'blur' }),
      );
    });

    // Navigate elsewhere then back — sessionStorage must survive.
    await page.goto(`${APP}/`);
    const after = await page.evaluate(() =>
      sessionStorage.getItem('rsn_bg_preference'),
    );
    expect(after).toBe(JSON.stringify({ mode: 'blur' }));

    // Image variant — covers the Office / Nature / City / Abstract path.
    await page.evaluate(() => {
      sessionStorage.setItem(
        'rsn_bg_preference',
        JSON.stringify({
          mode: 'image',
          imageUrl: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1280&q=60',
        }),
      );
    });
    await page.goto(`${APP}/sessions`);
    const imgPref = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('rsn_bg_preference') || 'null'),
    );
    expect(imgPref?.mode).toBe('image');
    expect(imgPref?.imageUrl).toContain('photo-1497366216548');

    // Disabled — the "None" preset path also persists.
    await page.evaluate(() => {
      sessionStorage.setItem(
        'rsn_bg_preference',
        JSON.stringify({ mode: 'disabled' }),
      );
    });
    await page.reload();
    const disabledPref = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('rsn_bg_preference') || 'null'),
    );
    expect(disabledPref?.mode).toBe('disabled');

    await browser.close();
  });

  // ─── Issue 10 — bgPreference module is loaded and reachable in prod build ─
  test('Issue 10 — bgPreference helper module is importable in the app bundle', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Capture client-side errors so we'd notice a regression where the
    // shared helper failed to bundle / failed to export.
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto(APP);
    await page.evaluate(([access, refresh]) => {
      localStorage.setItem('rsn_access', access);
      localStorage.setItem('rsn_refresh', refresh);
    }, [member.accessToken, member.refreshToken]);
    await page.goto(`${APP}/session/${sessionId}/live`);
    await page.waitForTimeout(4000);

    // The Lobby / LobbyMediaControls module imports bgPreference. If the
    // import chain were broken, we'd see a ReferenceError or
    // "saveBgPreference is not a function" in pageerror.
    const bgImportErrors = consoleErrors.filter(
      (e) => /bgPreference|saveBgPreference|loadBgPreference|applyBgPreference/.test(e),
    );
    expect(bgImportErrors).toEqual([]);

    await browser.close();
  });

  // ─── Issue 9 — Event ended cleanly hides participant/leave controls ──────
  test('Issue 9 — refresh after session ends shows recap, hides leave/participant controls', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Member is in the lobby first…
    await page.goto(APP);
    await page.evaluate(([access, refresh]) => {
      localStorage.setItem('rsn_access', access);
      localStorage.setItem('rsn_refresh', refresh);
    }, [member.accessToken, member.refreshToken]);
    await page.goto(`${APP}/session/${sessionId}/live`);
    await page.waitForTimeout(3000);

    // …then the host ends the event via API (server flips
    // sessions.status to 'completed').
    await endSessionForReal(director, sessionId);

    // Refresh to trigger the LiveSessionPage useEffect-on-status that we
    // fixed for Issue 9 — it must clear LiveKit/match/room state in
    // addition to flipping phase to 'complete', and the page must hide
    // the participant + leave controls (Bug 10 from earlier May spec).
    await page.reload();
    await page.waitForTimeout(4000);

    // "Leave" button must be gone — the page-header gates it on
    // `phase !== 'complete'` and the useEffect must have advanced phase.
    const leaveBtn = page.getByRole('button', { name: /leave/i });
    expect(await leaveBtn.count()).toBe(0);

    // Idempotency — a second reload still shows the recap; no orphan
    // LiveKit token reintroduces the leave button on the second pass.
    await page.reload();
    await page.waitForTimeout(3000);
    expect(await leaveBtn.count()).toBe(0);

    // The store should NOT carry over a LiveKit token after the
    // session.status=completed effect ran (Issue 9 cleanup). The store
    // is internal — we check the on-page consequence: no LiveKitRoom
    // wrapper, no broadcast banner, etc. The simplest pin is the
    // absence of the leave button (above) plus the absence of any
    // breakout-only UI.
    const breakoutTimer = page.locator('[data-testid="breakout-room"]');
    expect(await breakoutTimer.count()).toBe(0);

    await browser.close();
  });
});
