// TRF-2 (audit C3) — HEADED prod E2E for the per-user API rate limiter.
//
// Real browser at app.rsn.network (ONE real egress IP — the "venue NAT"
// scenario), firing GET /api/notifications as many authenticated throwaway
// users. Asserts the production behavior:
//   1. CROWD: 6 users each well under the limit, but >1 bucket's worth of
//      total traffic from one IP -> ZERO 429s (proves PER-USER keying; an
//      IP-keyed limiter would 429 past the bucket).
//   2. THROTTLE+ISOLATION: one user exceeding the limit gets 429s, while a
//      different user on the SAME IP keeps getting 200s.
//   3. WEBHOOK BYPASS: POST /api/webhooks/livekit returns 200 (never 429),
//      even right after a bucket was exhausted.
//
// Run against prod with the prod JWT secret:
//   JWT_SECRET=<prod> npx playwright test trf2-rate-limit-headed --config e2e/playwright.config.ts
//
// The forged-token "verify, not decode" security property is proven decisively
// by the local integration test (trf2-rate-limit-verify.test.ts); this prod run
// covers the scale/availability outcomes. Creates e2etest-* users, cleans up.

import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { createTestUser, cleanupTestData, pool, TestUser } from '../helpers/auth';

const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const API = process.env.E2E_CLIENT_API_BASE || 'https://rsn-api-h04m.onrender.com/api';
const LIMIT = parseInt(process.env.E2E_RATE_LIMIT || '240', 10);

// Fire `count` GET /api/notifications from inside the browser page using `token`,
// in parallel batches; return the array of HTTP statuses.
async function fireFromBrowser(page: Page, token: string, count: number, batch = 30): Promise<number[]> {
  return page.evaluate(async ({ apiBase, tok, n, b }) => {
    const out: number[] = [];
    for (let i = 0; i < n; i += b) {
      const slice = Array.from({ length: Math.min(b, n - i) }, () =>
        fetch(`${apiBase}/notifications`, { headers: { Authorization: 'Bearer ' + tok } })
          .then(r => r.status).catch(() => 0));
      out.push(...await Promise.all(slice));
    }
    return out;
  }, { apiBase: API, tok: token, n: count, b: batch });
}

test.describe.serial('TRF-2 — per-user API rate limiter (headed prod)', () => {
  let browser: Browser;
  let page: Page;
  let crowd: TestUser[] = [];
  let burst: TestUser;
  let bystander: TestUser;

  test.beforeAll(async () => {
    for (let i = 0; i < 6; i++) crowd.push(await createTestUser(`trf2-crowd-${i}`));
    burst = await createTestUser('trf2-burst');
    bystander = await createTestUser('trf2-bystander');

    browser = await chromium.launch({ headless: false });
    page = await browser.newPage();
    // Land on the real client origin so fetches carry the production
    // app.rsn.network -> API cross-origin path (and our one real IP).
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
  });

  test.afterAll(async () => {
    try { await page?.close(); } catch { /* ignore */ }
    try { await browser?.close(); } catch { /* ignore */ }
    const result = await cleanupTestData();
    // eslint-disable-next-line no-console
    console.log('TRF-2 headed cleanup:', result);
    try { await pool.end(); } catch { /* ignore */ }
  });

  test('CROWD: 6 users on one IP, >1 bucket of total traffic, ZERO 429s', async () => {
    const per = 45; // each user well under LIMIT(240); total 270 > one 240 bucket
    const results = await Promise.all(crowd.map(u => fireFromBrowser(page, u.accessToken, per)));
    const all = results.flat();
    const got429 = all.filter(s => s === 429).length;
    const got200 = all.filter(s => s === 200).length;
    // eslint-disable-next-line no-console
    console.log(`  crowd: ${all.length} reqs from one IP across 6 users -> 200:${got200} 429:${got429}`);
    expect(all.length).toBe(6 * per);          // 270, exceeds a single 240 bucket
    expect(got429).toBe(0);                     // per-user keying: nobody throttled
    expect(got200).toBe(all.length);
  });

  test('THROTTLE + ISOLATION: one user over the limit 429s; another on the same IP stays 200', async () => {
    const [burstStatuses, bystanderStatuses] = await Promise.all([
      fireFromBrowser(page, burst.accessToken, LIMIT + 30),  // 270 > 240 -> must 429
      fireFromBrowser(page, bystander.accessToken, 10),       // untouched bucket
    ]);
    const burst429 = burstStatuses.filter(s => s === 429).length;
    const burst200 = burstStatuses.filter(s => s === 200).length;
    const bystander429 = bystanderStatuses.filter(s => s === 429).length;
    // eslint-disable-next-line no-console
    console.log(`  burst user: 200:${burst200} 429:${burst429} | bystander 429:${bystander429}`);
    expect(burst429).toBeGreaterThan(0);                 // the heavy user IS throttled
    expect(burst200).toBeGreaterThanOrEqual(LIMIT - 5);  // ~240 allowed before 429
    expect(bystander429).toBe(0);                        // same IP, own bucket, fine
  });

  test('WEBHOOK BYPASS: POST /api/webhooks/livekit is never 429 (200 even after a bucket is exhausted)', async () => {
    const status = await page.evaluate(async ({ apiBase }) => {
      const r = await fetch(`${apiBase}/webhooks/livekit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/webhook+json' },
        body: '{}',
      }).catch(() => ({ status: 0 } as Response));
      return (r as Response).status;
    }, { apiBase: API });
    // eslint-disable-next-line no-console
    console.log(`  webhook POST -> ${status}`);
    expect(status).toBe(200);   // handler always acks 200; crucially NOT 429
  });
});
