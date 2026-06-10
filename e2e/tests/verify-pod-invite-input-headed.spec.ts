import { test, expect, chromium, Browser } from '@playwright/test';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod } from '../helpers/api';

// HEADED prod verification — the Pod invite "Search existing users" input text
// must be readable (was white-on-white). Open the modal, type, assert dark text.
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser;
let podId: string;
let browser: Browser;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: any, url: string) => { for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } } };

test.beforeAll(async () => {
  host = await createTestUser('inputhost', 'super_admin');
  const pod = await createPod(host, 'E2E Input Pod'); podId = pod.id;
  browser = await chromium.launch({ headless: false, slowMo: 500, args: ['--start-maximized'] });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

test('Pod invite search input shows dark, readable text (not white-on-white)', async () => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string }) => { localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r); }, { a: host.accessToken, r: host.refreshToken });
  const page = await ctx.newPage();
  console.log('  >>> opening the pod page + invite modal <<<');
  await gotoRetry(page, `${APP}/pods/${podId}`);
  await page.waitForTimeout(4000);

  await page.getByRole('button', { name: /Invite Members/i }).first().click();
  const search = page.getByPlaceholder('Search by name or email...').first();
  await expect(search, 'the invite search input should be present').toBeVisible({ timeout: 15_000 });

  await search.fill('Zubair');
  await page.waitForTimeout(1500);
  const color = await search.evaluate((el) => getComputedStyle(el as HTMLElement).color);
  const m = color.match(/\d+/g)!.map(Number);
  const brightness = (m[0] + m[1] + m[2]) / 3;
  console.log(`  typed-text color=${color} brightness=${brightness.toFixed(0)} (must be dark, < 140)`);
  await page.screenshot({ path: 'test-results/verify-pod-invite-input.png' }).catch(() => {});
  expect(brightness, 'typed invite-search text must be dark/readable, not white').toBeLessThan(140);
  await page.waitForTimeout(3000);
  await ctx.close();
  console.log('  ✓ pod invite search input renders dark, readable text.');
});
