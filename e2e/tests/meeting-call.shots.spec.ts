import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser } from '../helpers/engine';
import fs from 'fs';
import path from 'path';

// Visual evidence for the W-meet meeting/call feature (8 Sep 2026). Captures the
// real prod UI at desktop + phone widths so Ali can eyeball it. Chromium only.

const OUT = path.resolve(__dirname, '../shots/meeting');
let browser: Browser;
let a: TestUser, b: TestUser;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function ctxFor(u: TestUser, viewport: { width: number; height: number }): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  return ctx;
}

async function pageAt(u: TestUser, p: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await ctxFor(u, viewport);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${p}`);
  return page;
}

function futureWindowKey(daysAhead = 3, daypart = 'afternoon'): string {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.toISOString().slice(0, 10)}:${daypart}`;
}
async function convBetween(x: string, y: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`, [x, y],
  );
  return r.rows[0]?.id;
}

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  a = await createTestUser('shota');
  b = await createTestUser('shotb');
  await pool.query(`UPDATE users SET display_name=$1, job_title=$2, company=$3 WHERE id=$4`, ['Ana Rivera', 'Product Lead', 'Northwind', a.id]);
  await pool.query(`UPDATE users SET display_name=$1, job_title=$2, company=$3 WHERE id=$4`, ['Bo Meyer', 'Founder', 'Lumen', b.id]);
  const sent = await apiAs(a, 'POST', '/pokes', { recipientId: b.id, message: 'Coffee?' });
  const accepted = await apiAs(b, 'POST', `/pokes/${sent.json.data.id}/accept`);
  expect(accepted.status).toBe(200);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanup(pool, { ids: [a.id, b.id] });
  await cleanupByPrefix(pool, 'e2etest-shot');
  await pool.end().catch(() => {});
});

test('capture meeting + call UI', async () => {
  test.setTimeout(180_000);
  const convId = await convBetween(a.id, b.id);

  // Give the pair an overlap and a confirmed audio meeting via API.
  const KEY = futureWindowKey(3, 'afternoon');
  await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] });
  await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY] });
  const day = KEY.split(':')[0];
  const startAt = new Date(`${day}T15:30:00`).toISOString();
  await apiAs(a, 'POST', `/dm/conversations/${convId}/scheduling/confirm`, { window: KEY, startAt, durationMin: 45, type: 'audio' });

  // 1) Desktop thread — pinned Join card + Meet-now header buttons.
  const desk = await pageAt(a, `/messages/${convId}`, { width: 1280, height: 900 });
  await expect(desk.getByTestId('thread-meeting-banner')).toBeVisible({ timeout: 25_000 });
  await desk.screenshot({ path: path.join(OUT, '01-desktop-thread-join-card.png') });

  // 2) Desktop scheduler finalize — audio/video toggle. Use a NEW overlap so a
  //    Confirm button is present, then open the exact-time step.
  const KEY2 = futureWindowKey(6, 'morning');
  await apiAs(a, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY, KEY2] });
  await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [KEY, KEY2] });
  await desk.reload();
  const findTime = desk.getByRole('button', { name: /Find a time to meet/i });
  await findTime.first().click();
  await expect(desk.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 20_000 });
  const confirmBtn = desk.getByRole('button', { name: /^Confirm .*(morning|afternoon|evening)/i }).first();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click();
    await expect(desk.getByRole('button', { name: /Confirm meeting/i })).toBeVisible({ timeout: 10_000 });
  }
  await desk.screenshot({ path: path.join(OUT, '02-desktop-scheduler-audio-video.png') });

  // 3) The call room (A joins).
  const meet = await pageAt(a, `/meet/${convId}?kind=video`, { width: 1280, height: 900 });
  await expect(meet.getByText(/^Video call$/)).toBeVisible({ timeout: 20_000 });
  await meet.waitForTimeout(2500);
  await meet.screenshot({ path: path.join(OUT, '03-desktop-call-room.png') });

  // 4) Incoming-call ring on B — trigger a Meet-now from A (B online).
  const bDesk = await pageAt(b, `/messages/${convId}`, { width: 1280, height: 900 });
  await bDesk.waitForTimeout(2500);
  await apiAs(a, 'POST', `/dm/conversations/${convId}/call/start`, { kind: 'video' });
  await expect(bDesk.getByText(/is calling/i)).toBeVisible({ timeout: 20_000 });
  await bDesk.screenshot({ path: path.join(OUT, '04-desktop-incoming-call-banner.png') });

  // 5) Mobile 390 — thread with the Join card.
  const mob = await pageAt(a, `/messages/${convId}`, { width: 390, height: 844 });
  await expect(mob.getByTestId('thread-meeting-banner')).toBeVisible({ timeout: 25_000 });
  await mob.screenshot({ path: path.join(OUT, '05-mobile-thread-join-card.png') });

  // 6) Mobile availability dot — B changes availability, A sees the dot behind
  //    the More-actions button.
  await apiAs(b, 'PUT', `/dm/conversations/${convId}/scheduling/availability`, { windows: [futureWindowKey(8, 'evening')] });
  const mob2 = await pageAt(a, `/messages/${convId}`, { width: 390, height: 844 });
  await expect(mob2.getByRole('button', { name: /More actions .*updated their availability/i })).toBeVisible({ timeout: 25_000 });
  await mob2.screenshot({ path: path.join(OUT, '06-mobile-availability-dot.png') });

  console.log('shots written to', OUT);
});
