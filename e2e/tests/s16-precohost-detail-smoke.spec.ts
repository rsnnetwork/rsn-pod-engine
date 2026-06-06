import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession } from '../helpers/api';
import { Pool } from 'pg';

// HEADED smoke for S16 against PRODUCTION — co-host management on the EVENT
// DETAIL page (Ali, 6 Jun: "we need co-host pre event here on this page too").
//   1. The host opens /sessions/:id (NOT the live page) on a PHONE-sized
//      viewport, pre-event, and makes P1 a co-host from the participant row
//      (shield toggle, ≥44px tap target).
//   2. The row flips to Co-Host (badge + label).
//   3. P1 then opens the LIVE page → has the Control Center: an event-page
//      assignment grants real host powers on join.
//   4. The host demotes P1 from the same event-page toggle → P1's live page
//      loses the Control Center without a refresh (REST path emits the same
//      socket events as the drawer).
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser;
let browser: Browser;

async function gotoWithRetry(page: Page, url: string): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
      return;
    } catch (e) {
      if (i === 3) throw e;
      await page.waitForTimeout(5000);
    }
  }
}

async function openUser(user: TestUser, url: string, viewport?: { width: number; height: number }):
  Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(viewport ? { viewport } : {});
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoWithRetry(page, url);
  return { context, page };
}

const HCC = 'button[title="Open Host Control Center"]';

test.beforeAll(async () => {
  host = await createTestUser('s16host', 'super_admin');
  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('event-page co-host: phone-width pre-event assign → live host powers → event-page demote', async () => {
  test.setTimeout(300_000);

  const p1 = await createTestUser('s16p1');
  const p2 = await createTestUser('s16p2');
  const pod = await createPod(host, 'E2E S16 DetailCohost Pod');
  for (const u of [p1, p2]) await addPodMember(host, pod.id, u.id);
  const sess = await createSession(host, pod.id, 'E2E S16 Detail Smoke', new Date(Date.now() + 3600_000), {
    numberOfRounds: 1, roundDurationSeconds: 300,
  });
  await Promise.all([p1, p2].map((u) => registerForSession(u, sess.id)));

  // Host on the EVENT DETAIL page, phone-sized (mobile rule).
  const hostPg = await openUser(host, `${APP}/sessions/${sess.id}`, { width: 390, height: 844 });
  const makeP1 = hostPg.page.locator(`button[aria-label="Make ${p1.displayName} a co-host"]`).first();
  await expect(makeP1, 'shield toggle on the event page (pre-event)').toBeVisible({ timeout: 20_000 });

  // Mobile rule: ≥44px tap target, fully inside the viewport.
  const box = await makeP1.boundingBox();
  expect(box, 'toggle has a bounding box').toBeTruthy();
  expect(box!.width, 'toggle ≥44px wide').toBeGreaterThanOrEqual(44);
  expect(box!.height, 'toggle ≥44px tall').toBeGreaterThanOrEqual(44);
  expect(box!.x + box!.width, 'toggle inside the 390px viewport').toBeLessThanOrEqual(390);
  console.log(`  ✓ toggle tap target ${Math.round(box!.width)}×${Math.round(box!.height)}px at 390w`);

  await makeP1.click();
  await expect(hostPg.page.getByText('Co-Host', { exact: true }).first(),
    'row flips to Co-Host on the event page').toBeVisible({ timeout: 15_000 });
  console.log('  ✓ P1 assigned co-host from the EVENT page (pre-event)');

  // P1 opens the LIVE page → must have the host surface.
  const p1Pg = await openUser(p1, `${APP}/session/${sess.id}/live`);
  await expect(p1Pg.page.locator(HCC).first(),
    'P1 has the Control Center on the live page (event-page assignment grants powers)')
    .toBeVisible({ timeout: 30_000 });
  console.log('  ✓ P1 joined the live page WITH host powers');

  // Demote from the event page → P1's live page loses it WITHOUT refresh.
  const removeP1 = hostPg.page.locator(`button[aria-label="Remove ${p1.displayName} as co-host"]`).first();
  await expect(removeP1, 'toggle now reads Remove').toBeVisible({ timeout: 15_000 });
  await removeP1.click();
  {
    const end = Date.now() + 30_000;
    let gone = false;
    while (Date.now() < end) {
      if (!(await p1Pg.page.locator(HCC).first().isVisible().catch(() => false))) { gone = true; break; }
      await p1Pg.page.waitForTimeout(1500);
    }
    expect(gone, 'P1 loses the Control Center live after the event-page demote').toBe(true);
  }
  console.log('  ✓ event-page demote stripped P1’s host surface live (REST → socket fanout)');

  // S16.1 (Ali) — once the event is COMPLETED the toggle must disappear
  // ("event is completed! why still promote to co-host button is here").
  // This session was never started, so flip it terminal directly — the
  // assertion is purely about what the detail page renders for status.
  {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`UPDATE sessions SET status = 'completed', ended_at = NOW() WHERE id = $1`, [sess.id]);
    await pool.end();
  }
  await hostPg.page.reload({ waitUntil: 'commit' }).catch(() => {});
  await expect(hostPg.page.getByText('Completed', { exact: true }).first(),
    'event shows Completed').toBeVisible({ timeout: 20_000 });
  // Rows render, toggle does not.
  await expect(hostPg.page.getByText(p1.displayName, { exact: false }).first(),
    'participant rows still render post-event').toBeVisible({ timeout: 15_000 });
  const staleToggles = await hostPg.page.locator('button[aria-label*="co-host"]').count();
  expect(staleToggles, 'NO co-host toggles on a completed event').toBe(0);
  console.log('  ✓ S16.1: completed event shows no co-host toggles');

  for (const s of [hostPg, p1Pg]) { await s.context.close().catch(() => {}); }
  console.log('✓ S16 smoke complete: event-page co-host management browser-proven (phone width)');
});
