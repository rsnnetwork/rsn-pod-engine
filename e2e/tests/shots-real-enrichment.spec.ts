import { test, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';

// Opt-in (SHOTS=1): screenshots of what production extracted for real
// accounts whose LinkedIn URLs Ali supplied on 3 Sep 2026. Two views:
//   1. the admin inspector for each account (as a temp admin, deleted after)
//   2. the onboarding confirm card as the member would see it (nothing is
//      clicked; the card is only looked at)
// Writes PNGs to e2e/shots/.

test.skip(!process.env.SHOTS, 'set SHOTS=1 to capture');

const JWT_SECRET = fs.readFileSync(path.join(__dirname, '../.jwt_secret'), 'utf8').trim();

const ACCOUNTS = [
  { id: 'c52d876d-b314-4b7c-9c24-c2008d35af37', tag: 'ali', email: 'alihamza891840@gmail.com', role: 'admin', name: 'Raja Ali King' },
  { id: 'af509ec9-3628-4ef5-ab78-2d8ea8aea955', tag: 'ahmed-882', email: 'malikahmedjaved882@gmail.com', role: 'member', name: 'Malik Ahmed Javed' },
  { id: 'cdabda51-1eee-452f-b29e-5c9c62dbe3fe', tag: 'ahmed-1011', email: 'malikahmedjaved1011@gmail.com', role: 'member', name: 'Malik Ahmed Javed' },
];

let browser: Browser;
let admin: TestUser;
const ctxs: BrowserContext[] = [];

function tokensFor(a: { id: string; email: string; role: string; name: string }) {
  const sessionId = `shots-${Date.now()}`;
  return {
    a: jwt.sign({ sub: a.id, email: a.email, role: a.role, displayName: a.name, sessionId }, JWT_SECRET, { expiresIn: '20m' }),
    r: jwt.sign({ sub: a.id, sessionId, type: 'refresh' }, JWT_SECRET, { expiresIn: '20m' }),
  };
}

async function openWith(t: { a: string; r: string }, url: string, width: number): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 900 } });
  await ctx.addInitScript((x: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', x.a); localStorage.setItem('rsn_refresh', x.r);
  }, t);
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, url);
  return page;
}

test.beforeAll(async () => {
  admin = await createTestUser('shotsenrichadmin', 'admin');
  browser = await chromium.launch({ headless: true });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await browser?.close(); } catch {}
  await cleanup(pool, { ids: [admin?.id].filter(Boolean) });
  await cleanupByPrefix(pool, 'e2etest-shotsenrichadmin');
});

test('capture admin inspector + member confirm card for the real accounts', async () => {
  test.setTimeout(300_000);
  for (const a of ACCOUNTS) {
    // 1. Admin inspector.
    const insp = await openWith({ a: admin.accessToken, r: admin.refreshToken }, `${APP}/admin/users/${a.id}`, 1280);
    await insp.waitForTimeout(3000);
    await insp.screenshot({ path: `shots/enrich-${a.tag}-admin-inspector.png`, fullPage: true });
    await insp.context().close();

    // 2. The member's own onboarding view, phone width. Look, do not click.
    const t = tokensFor(a);
    const page = await openWith(t, `${APP}/onboarding`, 390);
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `shots/enrich-${a.tag}-member-390.png`, fullPage: true });
    console.log(`  ${a.tag}: landed on ${page.url()}`);
    await page.context().close();
  }
});
