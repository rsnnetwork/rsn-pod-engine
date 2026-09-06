import { test, expect, chromium, webkit, Browser, BrowserContext, Page, devices } from '@playwright/test';
import fs from 'node:fs';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod } from '../helpers/api';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';

// UI/UX AUDIT ACROSS DEVICES (4 Sep 2026, Ali: "the UI/UX must be the best one
// for desktop and mobile users, handy and easy to use").
//
// Every member-facing page, seeded with real-looking data, on emulated small
// Android, iPhone, Pixel, iPad portrait and landscape, and two desktop widths.
// Per page and device it screenshots the first screen and measures what a
// person would feel before they can name it: sideways scroll, tap targets
// under 44px, inputs under 16px (iOS zooms the page on focus), fixed bars
// covering the last content, and text under 12px. The summary lands in
// e2e/shots/uiux/summary.json; the screenshots next to it. Nothing here
// asserts a design; it produces the evidence a person then looks at.

const OUT = 'shots/uiux';
let chrome: Browser;
let member: TestUser, mate: TestUser, admin: TestUser, fresh: TestUser;
const ctxs: BrowserContext[] = [];
let circleId = '', podId = '', agentId = '', convId = '', postId = '';

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

type DeviceSpec = { name: string; ctx: Record<string, unknown>; engine: 'chromium' | 'webkit' };
const DEVICES: DeviceSpec[] = [
  { name: 'android-360', ctx: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, engine: 'chromium' },
  { name: 'pixel-7', ctx: { ...devices['Pixel 7'] }, engine: 'chromium' },
  { name: 'iphone-14', ctx: { ...devices['iPhone 14'] }, engine: 'webkit' },
  { name: 'ipad-portrait', ctx: { ...devices['iPad (gen 7)'] }, engine: 'webkit' },
  { name: 'ipad-landscape', ctx: { ...devices['iPad (gen 7) landscape'] }, engine: 'webkit' },
  { name: 'desktop-1280', ctx: { viewport: { width: 1280, height: 800 } }, engine: 'chromium' },
  { name: 'desktop-1536', ctx: { viewport: { width: 1536, height: 864 } }, engine: 'chromium' },
];

interface Metrics {
  vw: number; vh: number; overflow: number;
  small: Array<{ tag: string; text: string; w: number; h: number }>;
  zoomInputs: Array<{ tag: string; fs: number; ph: string }>;
  tinyText: Array<{ text: string; fs: number }>;
  covered: number; // px of the last main content hidden under a fixed bottom bar
  fixedBars: Array<{ cls: string; top: number; h: number }>;
}

async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const overflow = document.documentElement.scrollWidth - vw;
    const vis = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < vh; };
    const label = (el: Element) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el as HTMLElement).innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const small: Metrics['small'] = [];
    for (const el of Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]'))) {
      if (!vis(el)) continue;
      const cs = getComputedStyle(el);
      if (el.tagName === 'A' && cs.display === 'inline') continue; // prose links
      const r = el.getBoundingClientRect();
      if (r.height < 40 || r.width < 40) small.push({ tag: el.tagName.toLowerCase(), text: label(el), w: Math.round(r.width), h: Math.round(r.height) });
    }
    const zoomInputs: Metrics['zoomInputs'] = [];
    for (const el of Array.from(document.querySelectorAll('input, textarea, select'))) {
      if (!vis(el)) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) zoomInputs.push({ tag: el.tagName.toLowerCase(), fs, ph: el.getAttribute('placeholder') || label(el) });
    }
    const tinyText: Metrics['tinyText'] = [];
    const seen = new Set<string>();
    for (const el of Array.from(document.querySelectorAll('p, span, a, button, label, div, li, td, th, h1, h2, h3, h4, h5, h6'))) {
      if (!vis(el)) continue;
      const own = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => (n.textContent || '').trim()).join(' ').trim();
      if (!own) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 12 && !seen.has(own)) { seen.add(own); tinyText.push({ text: own.slice(0, 40), fs }); }
    }
    const fixedBars: Metrics['fixedBars'] = [];
    let bottomBarTop = vh;
    for (const el of Array.from(document.querySelectorAll('nav, header, footer, div'))) {
      const cs = getComputedStyle(el); if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      const r = el.getBoundingClientRect(); if (r.width < vw * 0.6 || r.height === 0) continue;
      fixedBars.push({ cls: (el.className || '').toString().slice(0, 50), top: Math.round(r.top), h: Math.round(r.height) });
      if (r.bottom >= vh - 2 && r.top < bottomBarTop) bottomBarTop = r.top;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    const main = document.querySelector('main') || document.body;
    let lastBottom = 0;
    for (const el of Array.from(main.querySelectorAll('*'))) {
      const cs = getComputedStyle(el); if (cs.position === 'fixed' || cs.position === 'sticky') continue;
      const r = el.getBoundingClientRect(); if (r.height > 0 && r.width > 0) lastBottom = Math.max(lastBottom, r.bottom);
    }
    const covered = Math.max(0, Math.round(lastBottom - bottomBarTop));
    window.scrollTo(0, 0);
    return { vw, vh, overflow, small: small.slice(0, 30), zoomInputs, tinyText: tinyText.slice(0, 12), covered, fixedBars };
  });
}

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  admin = await createTestUser('uiuxadmin', 'super_admin');
  member = await createTestUser('uiux');
  mate = await createTestUser('uiuxmate');
  fresh = await createTestUser('uiuxfresh', 'member', 'not_started');
  await pool.query(`UPDATE users SET display_name = 'Nadia Berg', first_name = 'Nadia', last_name = 'Berg', job_title = 'Founder', company = 'Fjord Analytics', bio = 'Building analytics for Nordic fintech teams. Ex-Spotify. Happy to talk pricing, hiring and early customers.' WHERE id = $1`, [member.id]);
  await pool.query(`UPDATE users SET display_name = 'Tomas Lindqvist', first_name = 'Tomas', last_name = 'Lindqvist', job_title = 'Senior React Engineer', company = 'Klarna', bio = 'Shipped consumer products for a decade. Looking for a founder to build with.' WHERE id = $1`, [mate.id]);
  await pool.query(`UPDATE users SET onboarding_completed = false, linkedin_url = NULL WHERE id = $1`, [fresh.id]);

  circleId = (await apiAs(admin, 'POST', '/circles', { name: 'Nordic Fintech Founders', description: 'Founders and operators building financial products in the Nordics.' })).json.data.id;
  for (const u of [member, mate]) await apiAs(u, 'POST', `/circles/${circleId}/join`);
  const post = await apiAs(mate, 'POST', `/circles/${circleId}/posts`, { clientId: crypto.randomUUID(), content: 'We just opened our beta to 200 freelancers in Copenhagen. Feedback welcome: https://www.example.com/beta' });
  postId = post.json?.data?.id || '';
  if (postId) {
    await apiAs(member, 'POST', `/circles/posts/${postId}/react`, { reaction: 'celebrate' });
    await apiAs(member, 'POST', `/circles/posts/${postId}/comments`, { content: 'Congrats! How are you handling invoicing across currencies?' });
  }
  const pod = await createPod(admin, 'Copenhagen Founders Pod'); podId = pod.id;
  await apiAs(admin, 'POST', `/circles/${circleId}/pods`, { podId });
  await apiAs(member, 'POST', `/pods/${podId}/join`).catch(() => null);
  const agent = await apiAs(member, 'POST', '/agents', { label: 'Developers', wantText: 'senior react developers who have shipped consumer products' });
  agentId = agent.json?.data?.id || '';
  const poke = await apiAs(mate, 'POST', '/pokes', { recipientId: member.id, message: 'Would love to compare notes on pricing.' });
  if (poke.status === 201) {
    const acc = await apiAs(member, 'POST', `/pokes/${poke.json.data.id}/accept`);
    convId = acc.json?.data?.conversationId || '';
    if (convId) {
      await apiAs(member, 'POST', '/dm/messages', { toUserId: mate.id, content: 'Happy to. Are you free Thursday? My notes are at www.example.com/pricing' }).catch(() => null);
      await apiAs(mate, 'POST', '/dm/messages', { toUserId: member.id, content: 'Thursday works. I will bring numbers from our last three launches.' }).catch(() => null);
    }
  }
  chrome = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  try { await chrome?.close(); } catch {}
  if (circleId) await pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]).catch(() => {});
  const ids = [admin?.id, member?.id, mate?.id, fresh?.id].filter(Boolean);
  await pool.query(`DELETE FROM direct_messages WHERE conversation_id IN (SELECT id FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1))`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids, podId: podId || undefined });
  await cleanupByPrefix(pool, 'e2etest-uiux');
});

test('every member page, every device: screenshots and measurements', async () => {
  test.setTimeout(1_500_000);
  const pages: Array<[string, string, TestUser | null]> = [
    ['home', '/', member],
    ['agents', '/agents', member],
    ['agent-detail', agentId ? `/agents/${agentId}` : '/agents', member],
    ['pods', '/pods', member],
    ['pod-detail', podId ? `/pods/${podId}` : '/pods', member],
    ['circles', '/circles', member],
    ['circle-detail', `/circles/${circleId}`, member],
    ['messages', '/messages', member],
    ['conversation', convId ? `/messages/${convId}` : '/messages', member],
    ['search', '/search', member],
    ['profile', '/profile', member],
    ['public-profile', `/profile/${mate.id}`, member],
    ['invites', '/invites', member],
    ['sessions', '/sessions', member],
    ['settings', '/settings', member],
    ['onboarding-asklink', '/onboarding', fresh],
    ['login', '/login', null],
    ['request-to-join', '/request-to-join', null],
  ];

  const summary: Record<string, Record<string, Metrics & { shot: string }>> = {};
  let wk: Browser | null = null;
  try { wk = await webkit.launch({ headless: false }); } catch (e) { console.log(`  (webkit not available: ${(e as Error).message.split('\n')[0]}; iPhone/iPad run in chromium)`); }

  for (const d of DEVICES) {
    const browser = d.engine === 'webkit' && wk ? wk : chrome;
    summary[d.name] = {};
    for (const [name, path, user] of pages) {
      const ctx = await browser.newContext({ ...(d.ctx as any) });
      ctxs.push(ctx);
      if (user) {
        await ctx.addInitScript((t: { a: string; r: string }) => {
          localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
        }, { a: user.accessToken, r: user.refreshToken });
      }
      await primePreview(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', () => {});
      try {
        await gotoRetry(page, `${APP}${path}`);
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(800);
        if (name === 'circle-detail' && postId) {
          await page.getByTestId(`comment-button-${postId}`).click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(500);
        }
        if (name === 'home' && user) {
          // The bell panel is part of the first screen people open.
          await page.locator('button:has(.lucide-bell):visible').first().click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${OUT}/${d.name}--home-bell.png` });
          await page.keyboard.press('Escape').catch(() => {});
          await page.mouse.click(5, 5).catch(() => {});
          await page.waitForTimeout(200);
        }
        const shot = `${OUT}/${d.name}--${name}.png`;
        await page.screenshot({ path: shot });
        const m = await measure(page);
        summary[d.name][name] = { ...m, shot };
        const flags = [
          m.overflow > 0 ? `OVERFLOW ${m.overflow}px` : '',
          m.small.length ? `small targets ${m.small.length}` : '',
          m.zoomInputs.length ? `zoom inputs ${m.zoomInputs.length}` : '',
          m.covered > 0 ? `covered ${m.covered}px` : '',
          m.tinyText.length ? `tiny text ${m.tinyText.length}` : '',
        ].filter(Boolean).join(' | ');
        console.log(`  ${d.name.padEnd(15)} ${name.padEnd(18)} ${flags || 'clean'}`);
      } catch (err) {
        console.log(`  ${d.name.padEnd(15)} ${name.padEnd(18)} FAILED: ${(err as Error).message.split('\n')[0]}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  }
  if (wk) await wk.close().catch(() => {});
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(`  summary: ${OUT}/summary.json`);
  expect(Object.keys(summary).length).toBe(DEVICES.length);
});
