import { test, expect, chromium, Browser } from '@playwright/test';
import { gotoRetry, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

// Opt-in (SHOTS=1): Ali's own Developers agent on production, viewed as Ali,
// after the own-roles repair and the kept-row reason refresh. Stefan must be
// shown as CEO / Founder, never as a developer. Nothing is clicked.

test.skip(!process.env.SHOTS, 'set SHOTS=1 to capture');

const JWT_SECRET = fs.readFileSync(path.join(__dirname, '../.jwt_secret'), 'utf8').trim();
const ALI = { id: 'c52d876d-b314-4b7c-9c24-c2008d35af37', email: 'alihamza891840@gmail.com', role: 'admin', name: 'Raja Ali King' };
const AGENT = '1f6dd0f9-eb7c-40a4-a51c-d5b0a98475b3';

let browser: Browser;
test.beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
test.afterAll(async () => { try { await browser?.close(); } catch {} });

test("Ali's Developers agent no longer calls Stefan a developer", async () => {
  test.setTimeout(120_000);
  const sessionId = `shots-${Date.now()}`;
  const a = jwt.sign({ sub: ALI.id, email: ALI.email, role: ALI.role, displayName: ALI.name, sessionId }, JWT_SECRET, { expiresIn: '15m' });
  const r = jwt.sign({ sub: ALI.id, sessionId, type: 'refresh' }, JWT_SECRET, { expiresIn: '15m' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a, r });
  await primePreview(ctx);
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}/agents/${AGENT}`);
  await expect(page.getByText('Stefan Avivson').first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shots/agent-developers-after.png', fullPage: true });

  const text = ((await page.locator('body').textContent()) || '').replace(/\s+/g, ' ');
  const idx = text.indexOf('Stefan Avivson');
  const around = text.slice(Math.max(0, idx - 20), idx + 220);
  console.log(`  STEFAN CARD: ${around}`);
  expect(text).not.toMatch(/Stefan Avivson is a developer/i);
  expect(around).toMatch(/CEO|Founder/);
  await ctx.close();
});
