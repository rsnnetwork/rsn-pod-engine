import { test, expect, chromium, Browser } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { apiRequest } from '../helpers/api';

// HEADED prod verification — Stefan (2 Jul):
//  1. A join request must notify the pod director LIVE: the open pod page
//     gains the Pending Requests section without a refresh, and the bell
//     receives a 'New Join Request' notification.
//  2. The pending requester appears ONCE (Pending Requests section only) —
//     no duplicate "Pending Approval" chip in the Members section, and the
//     Members count excludes pending people.
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let director: TestUser;
let requester: TestUser;
let podId: string;
let browser: Browser;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: any, url: string) => { for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } } };

test.beforeAll(async () => {
  director = await createTestUser('jrdirector');
  requester = await createTestUser('jrrequester');
  const res = await apiRequest(director, 'POST', '/pods', {
    name: 'E2E JoinReq Pod',
    description: 'E2E join-request notification pod',
    visibility: 'public_with_approval',
    podType: 'speed_networking',
    orchestrationMode: 'timed_rounds',
    communicationMode: 'hybrid',
  });
  podId = res.data.id;
  browser = await chromium.launch({ headless: false, slowMo: 300, args: ['--start-maximized'] });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  // Targeted cleanup by exact IDs only — never touch other e2e users that a
  // parallel session might be running right now.
  const userIds = [director?.id, requester?.id].filter(Boolean);
  if (podId) await pool.query(`DELETE FROM pods WHERE id = $1`, [podId]);
  if (userIds.length) {
    await pool.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [userIds]).catch(() => {});
    await pool.query(`DELETE FROM audit_log WHERE actor_id = ANY($1)`, [userIds]).catch(() => {});
    await pool.query(`DELETE FROM refresh_tokens WHERE user_id = ANY($1)`, [userIds]).catch(() => {});
    const del = await pool.query(`DELETE FROM users WHERE id = ANY($1) RETURNING id`, [userIds]);
    console.log(`Cleanup: ${del.rows.length} users, pod ${podId}`);
  }
});

test('join request notifies the director live + pending shows exactly once', async () => {
  test.setTimeout(240_000);

  // ── Director opens the pod page (desktop) ─────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: director.accessToken, r: director.refreshToken });
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}/pods/${podId}`);
  await page.waitForTimeout(5000); // let the page + socket settle

  // Baseline: no pending section yet
  await expect(page.getByText(/Pending Requests/i)).toHaveCount(0);

  // ── Requester asks to join via API (no browser needed) ───────────────────
  console.log('  >>> requester POSTs /request-join <<<');
  const joinRes = await apiRequest(requester, 'POST', `/pods/${podId}/request-join`);
  expect(joinRes.data.status).toBe('pending_approval');

  // ── LIVE update: Pending Requests section appears WITHOUT a refresh ──────
  await expect(page.getByText(/Pending Requests \(1\)/i), 'director page must gain the pending request live (realtime fanout)').toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(requester.displayName).first()).toBeVisible();
  console.log('  ✓ Pending Requests (1) appeared live, no refresh');

  // ── Bell: notification arrived (server truth + dropdown) ─────────────────
  const notifs = await apiRequest(director, 'GET', '/notifications');
  const jr = notifs.data.notifications.find((n: any) => n.type === 'join_request');
  expect(jr, 'director must have a join_request notification').toBeTruthy();
  expect(jr.title).toBe('New Join Request');
  expect(jr.body).toContain(requester.displayName);
  expect(jr.link).toBe(`/pods/${podId}`);
  expect(notifs.data.unreadCount).toBeGreaterThanOrEqual(1);

  const bell = page.locator('button:has(.lucide-bell)').first();
  await bell.click();
  await expect(page.getByText('New Join Request').first(), 'bell dropdown must show the join request').toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: 'test-results/joinreq-bell.png' }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.mouse.click(10, 400); // close the dropdown backdrop
  console.log('  ✓ bell shows New Join Request');

  // ── No duplicate: Pending Approval chip must NOT exist ───────────────────
  await expect(page.getByRole('button', { name: /Pending Approval/i })).toHaveCount(0);
  // Members count excludes the pending requester: 1 active member (director)
  await expect(page.getByText(/Members \(1\)/i)).toBeVisible();
  await expect(page.getByText(/Members \(2\)/i)).toHaveCount(0);
  await page.screenshot({ path: 'test-results/joinreq-once.png' }).catch(() => {});
  console.log('  ✓ pending shown once, Members count excludes pending');

  // ── Mobile pass (390px): section renders, fits viewport, no overflow ─────
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mob.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: director.accessToken, r: director.refreshToken });
  const mpage = await mob.newPage();
  await gotoRetry(mpage, `${APP}/pods/${podId}`);
  await expect(mpage.getByText(/Pending Requests \(1\)/i)).toBeVisible({ timeout: 20_000 });
  const box = await mpage.getByText(/Pending Requests \(1\)/i).boundingBox();
  expect(box, 'pending section must be inside the 390px viewport').toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const hasHScroll = await mpage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(hasHScroll, 'no horizontal scroll at 390px').toBe(false);
  await mpage.screenshot({ path: 'test-results/joinreq-mobile.png' }).catch(() => {});
  await mob.close();
  console.log('  ✓ 390px mobile: section fits, no horizontal scroll');

  // ── Approve still works from the section ─────────────────────────────────
  await page.locator('button[title="Approve"]').first().click();
  await expect(page.getByText(/Members \(2\)/i), 'approved requester must join the Members count').toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Pending Requests/i)).toHaveCount(0, { timeout: 20_000 });
  console.log('  ✓ approve flows: requester became an active member');

  await ctx.close();
});
