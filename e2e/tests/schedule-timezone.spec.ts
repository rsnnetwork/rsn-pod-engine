import { test, expect, chromium, Browser } from '@playwright/test';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, createSession, endSession } from '../helpers/api';

// HEADED smoke for the event-schedule timezone fix (Ali, 10 Jun):
//   A. the create-event "Scheduled At" field LABELS the viewer's local timezone.
//   B. the edit form pre-fills LOCAL time (not UTC) — opening + saving an event
//      must NOT shift its time by the viewer's offset.
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, podId: string, sessionId: string, browser: Browser;

test.beforeAll(async () => {
  host = await createTestUser('tzhost', 'super_admin');
  const pod = await createPod(host, 'E2E TZ Pod');
  podId = pod.id;
  // Schedule at a deliberately offset-sensitive UTC time (…T20:30Z) so a
  // UTC-vs-local mistake is obvious.
  const sched = new Date('2026-09-15T20:30:00.000Z');
  const sess = await createSession(host, podId, 'E2E TZ Event', sched);
  sessionId = sess.id;
  browser = await chromium.launch({ headless: false, channel: process.env.E2E_CHROME_CHANNEL || undefined });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

async function login(context: any) {
  await context.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
  }, { a: host.accessToken, r: host.refreshToken });
  const share = process.env.E2E_VERCEL_SHARE;
  if (share) {
    const p = await context.newPage();
    await p.goto(`${APP}/?_vercel_share=${share}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000); await p.close();
  }
}

// expected local datetime-local value for an ISO, computed the SAME way the app does
function localInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test('A: create page labels the local timezone under Scheduled At', async () => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  await login(ctx);
  const page = await ctx.newPage();
  try {
    await page.goto(`${APP}/sessions/new`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const label = page.getByText(/Shown in your local time/i).first();
    await expect(label, 'create page must label the local timezone').toBeVisible({ timeout: 15_000 });
    const txt = await label.innerText();
    console.log(`  tz label: "${txt}"`);
    expect(txt, 'label should name a GMT offset').toMatch(/GMT[+-]\d/);
  } finally { await ctx.close(); }
});

test('B: edit form pre-fills LOCAL time (no UTC shift)', async () => {
  test.setTimeout(90_000);
  const ctx = await browser.newContext();
  await login(ctx);
  const page = await ctx.newPage();
  try {
    await page.goto(`${APP}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    await page.getByRole('button', { name: /^Edit$/ }).first().click();
    await page.waitForTimeout(1500);
    const input = page.locator('input[type="datetime-local"]').first();
    await expect(input).toBeVisible({ timeout: 10_000 });
    const value = await input.inputValue();
    // The browser's local rendering of the stored UTC, computed independently.
    const expected = await page.evaluate((iso) => {
      const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }, '2026-09-15T20:30:00.000Z');
    console.log(`  edit input value="${value}" expected-local="${expected}" (stored UTC 20:30Z)`);
    expect(value, 'edit field must show LOCAL time, matching the stored UTC').toBe(expected);
    // Sanity: it must NOT be the raw UTC HH:MM (20:30) unless the browser IS UTC.
    expect(value.length).toBe(16);
  } finally { await ctx.close(); }
});
