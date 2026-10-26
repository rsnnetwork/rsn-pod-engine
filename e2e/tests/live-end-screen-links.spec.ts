import { test, expect, Browser, BrowserContext } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, idsOf, teardown, APP } from '../helpers/live-ui';
import { createPod, addPodMember, createSession, registerForSession } from '../helpers/api';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// 26 Oct 2026 (CON-01 and the review of the first fix): the live event's end screen names the people a member met, and
// each name is a link that opens their profile in a NEW tab, because a same-tab move there would drop the call. So
// each says so: a small arrow, and "(opens in a new tab)" for a screen reader.
//
// The review found the avatars on those rows squeezed into ovals on a phone (the name beside each was allowed to take
// all the width). This checks them as a person sees them: each avatar is a square, the arrow is on screen, nothing
// runs off the side, and clicking a name opens a new tab while the event tab stays where it is.
//
// The end screen is what a member sees on opening a finished event, so a finished event is enough: no LiveKit room
// is needed. The list of people met is answered by the page itself here (a long name makes the row tight).
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let host: TestUser, viewer: TestUser, peer: TestUser;
let podId = '', sessionId = '';
const ctxs: BrowserContext[] = [];
const LONG_NAME = 'Alexandria Montgomery-Featherstonehaugh';

test.beforeAll(async () => {
  host = await createTestUser('endhost');
  viewer = await createTestUser('endviewer');
  peer = await createTestUser('endpeer');
  await pool.query(`UPDATE users SET display_name = $1, job_title = 'Designer', company = 'Studio' WHERE id = $2`, [LONG_NAME, peer.id]);
  podId = (await createPod(host, `E2E End screen pod ${Date.now().toString().slice(-7)}`)).id;
  await addPodMember(host, podId, viewer.id);
  await addPodMember(host, podId, peer.id);
  sessionId = (await createSession(host, podId, 'E2E End screen event', new Date(Date.now() + 3_600_000))).id;
  await registerForSession(viewer, sessionId);
  await pool.query(`UPDATE sessions SET status = 'completed', started_at = now() - interval '1 hour', ended_at = now() WHERE id = $1`, [sessionId]);
  console.log(`[live-end-screen-links] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  // An account whose creation failed is undefined here and has nothing to delete; each step runs even if another fails.
  await teardown(
    () => cleanup(pool, { ids: [], podId }),
    () => cleanup(pool, { ids: idsOf(host, viewer, peer) }),
    () => cleanupByPrefix(pool, 'e2etest-end'),
    () => pool.end().catch(() => {}),
  );
});

for (const vp of [{ width: 360, height: 900 }, { width: 390, height: 900 }, { width: 1100, height: 900 }]) {
  test(`the end screen's names open a new tab and say so, with round avatars and no side scroll at ${vp.width}px`, async () => {
    test.setTimeout(120_000);
    const opts = contextOptions(vp);
    const ctx = await browser.newContext({ ...opts, viewport: vp });
    await ctx.addInitScript((t: { a: string; r: string }) => {
      localStorage.setItem('rsn_access', t.a);
      localStorage.setItem('rsn_refresh', t.r);
      localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
    }, { a: viewer.accessToken, r: viewer.refreshToken });
    ctxs.push(ctx);
    await primePreview(ctx);
    const conn = {
      userId: peer.id, displayName: LONG_NAME, company: 'Studio', jobTitle: 'Designer', qualityScore: 4,
      meetAgain: true, theirMeetAgain: true, mutualMeetAgain: true, roundNumber: 1, isManual: false,
    };
    await ctx.route('**/ratings/sessions/*/people-met', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { connections: [conn], mutualConnections: [conn], totalRounds: 1, roundsAttended: 1, uniquePeopleMet: 1, totalMeetings: 1, mutualMatches: 1 } }),
    }));
    const page = await ctx.newPage();
    page.on('pageerror', () => {});
    await gotoRetry(page, `${APP}/session/${sessionId}/live`);
    await expect(page.getByRole('heading', { name: 'Event ended' })).toBeVisible({ timeout: 40_000 });
    // The per-event check-in asks what brings them here, and covers the page until answered or skipped.
    const skip = page.getByRole('button', { name: /^Skip$/ });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.waitForTimeout(900);

    const links = page.locator(`a[href="/profile/${peer.id}"]`);
    await expect(links).toHaveCount(2); // Mutual Matches, and the round
    for (const link of await links.all()) {
      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
      await expect(link).toContainText('↗');
      await expect(link.locator('.sr-only')).toHaveText('(opens in a new tab)');
      // The avatar is a circle: as wide as it is tall, however long the name beside it.
      const avatar = link.locator('img, div').first();
      const box = (await avatar.boundingBox())!;
      expect(Math.abs(box.width - box.height), `the avatar is ${Math.round(box.width)} by ${Math.round(box.height)}`).toBeLessThanOrEqual(1);
      expect(box.width).toBeGreaterThanOrEqual(30);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // A name opens a new tab; the event tab does not move.
    const [tab] = await Promise.all([ctx.waitForEvent('page'), links.first().click()]);
    await tab.waitForLoadState('domcontentloaded');
    await expect(tab).toHaveURL(new RegExp(`/profile/${peer.id}$`));
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/live`));
    await expect(page.getByRole('heading', { name: 'Event ended' })).toBeVisible();
  });
}
