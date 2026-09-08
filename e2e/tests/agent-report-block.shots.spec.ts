import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser } from '../helpers/engine';
import fs from 'fs';
import path from 'path';

// Visual evidence for the 8 Sep fixes (chromium).
const OUT = path.resolve(__dirname, '../shots/report');
let browser: Browser;
const ctxs: BrowserContext[] = [];

async function apiAs(u: TestUser, method: string, p: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function pageAs(u: TestUser, p: string, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${p}`);
  return page;
}
function futureWindowKey(d = 3, part = 'afternoon') {
  // 9 Sep 2026: a concrete 30-min slot (UTC instant) at a LOCAL hour the picker shows.
  const dt = new Date();
  dt.setHours(({ morning: 9, afternoon: 14, evening: 18 } as Record<string, number>)[part] ?? 14, 0, 0, 0);
  dt.setDate(dt.getDate() + d);
  return dt.toISOString().replace('.000Z', 'Z');
}
async function convBetween(x: string, y: string) {
  return (await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id=$1 AND user_b_id=$2) OR (user_a_id=$2 AND user_b_id=$1)`, [x, y],
  )).rows[0]?.id;
}

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  browser = await launchBrowser();
});
test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanupByPrefix(pool, 'e2etest-shot2');
  await pool.end().catch(() => {});
});

test('capture report + block + join-from-message UI', async () => {
  test.setTimeout(180_000);
  const a = await createTestUser('shot2a');
  const b = await createTestUser('shot2b');
  const admin = await createTestUser('shot2admin', 'admin');
  await pool.query(`UPDATE users SET display_name=$1, job_title=$2, company=$3 WHERE id=$4`, ['Ana Rivera', 'Product Lead', 'Northwind', a.id]);
  await pool.query(`UPDATE users SET display_name=$1, job_title=$2, company=$3 WHERE id=$4`, ['Bo Meyer', 'Founder', 'Lumen', b.id]);

  // Connect + confirm an audio meeting so the thread has a "Meeting confirmed" line.
  const sent = await apiAs(a, 'POST', '/pokes', { recipientId: b.id, message: 'Coffee?' });
  await apiAs(b, 'POST', `/pokes/${sent.json.data.id}/accept`);
  const conv = await convBetween(a.id, b.id);
  const KEY = futureWindowKey(3, 'afternoon');
  await apiAs(a, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [KEY] });
  await apiAs(b, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [KEY] });
  await apiAs(a, 'POST', `/dm/conversations/${conv}/scheduling/confirm`, {
    window: KEY, startAt: new Date(`${KEY.split(':')[0]}T15:30:00`).toISOString(), durationMin: 30, type: 'video',
  });

  // 1) The thread: the "Meeting confirmed" message carries its own Join button.
  const chat = await pageAs(a, `/messages/${conv}`);
  await expect(chat.getByText(/Meeting confirmed/i).first()).toBeVisible({ timeout: 25_000 });
  await expect(chat.getByRole('button', { name: /Join meeting/i }).first()).toBeVisible();
  await chat.screenshot({ path: path.join(OUT, '01-join-from-message.png') });

  // 2) The report dialog with the "Also block" option + the Block button in the header.
  await chat.getByRole('button', { name: /Report this member/i }).click();
  await expect(chat.getByText(/Also block/i)).toBeVisible({ timeout: 10_000 });
  await chat.screenshot({ path: path.join(OUT, '02-report-with-block.png') });
  // Close the modal (Cancel).
  await chat.getByRole('button', { name: /^Cancel$/ }).click().catch(() => {});

  // 3) Admin moderation queue: file a report from the chat, then view it as admin.
  await apiAs(a, 'POST', '/reports', { reportedId: b.id, reason: 'harassment', description: 'Was rude in chat', conversationId: conv });
  const mod = await pageAs(admin, '/admin/moderation');
  await expect(mod.getByText(/Report against Bo Meyer/i)).toBeVisible({ timeout: 30_000 });
  await mod.screenshot({ path: path.join(OUT, '03-moderation-queue.png') });

  // 4) Open the conversation behind the report.
  await mod.getByRole('button', { name: /View the conversation/i }).first().click();
  await expect(mod.getByText(/Meeting confirmed/i).first()).toBeVisible({ timeout: 15_000 });
  await mod.screenshot({ path: path.join(OUT, '04-view-conversation.png') });

  console.log('shots written to', OUT);
  await cleanup(pool, { ids: [a.id, b.id, admin.id] });
});
