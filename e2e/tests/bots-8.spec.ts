import { test, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, closePool } from '../helpers/auth';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// ─── 8 MANUAL BOT BROWSERS for Ali's live event ─────────────────────────────
// Creates 8 users, adds them to the event's pod, registers them, and opens
// 8 HEADED windows already sitting on the live event page. Ali drives them
// by hand (ratings, leave buttons, everything). The script then idles until
// the sentinel file STOP-BOTS.txt appears next to this spec — create it to
// close all windows. Users are NOT auto-deleted (cleanup-e2e wipes them
// later — their emails end in rsn-e2e.invalid).
//
// Usage:  $env:EVENT_TITLE = "<event title>"   (exact title, case-insensitive)
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const EVENT_TITLE = process.env.EVENT_TITLE || '';
const STOP_FILE = path.join(__dirname, 'STOP-BOTS.txt');

const BOT_NAMES = ['Aisha Khan', 'Bilal Ahmed', 'Carla Reyes', 'Daniyal Raza',
  'Emma Stone', 'Farhan Malik', 'Grace Lee', 'Hassan Shah'];

let browser: Browser;

test('launch 8 manual bot browsers on the event', async () => {
  test.setTimeout(0); // runs until STOP-BOTS.txt appears

  if (!EVENT_TITLE) throw new Error('Set EVENT_TITLE env var to the event title first');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Find the event (newest match by title).
  const sess = await pool.query(
    `SELECT id, pod_id, title, status FROM sessions
     WHERE LOWER(title) = LOWER($1) ORDER BY created_at DESC LIMIT 1`,
    [EVENT_TITLE],
  );
  if (!sess.rows.length) throw new Error(`No session titled "${EVENT_TITLE}" found`);
  const { id: sessionId, pod_id: podId, status } = sess.rows[0];
  console.log(`  event: "${sess.rows[0].title}" (${sessionId.slice(0, 8)}) status=${status} pod=${String(podId).slice(0, 8)}`);

  // Create the 8 users, give them friendly names, pod membership + registration.
  const bots: TestUser[] = [];
  for (let i = 0; i < 8; i++) {
    const u = await createTestUser(`bot${i + 1}`);
    await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [BOT_NAMES[i], u.id]);
    u.displayName = BOT_NAMES[i];
    await pool.query(
      `INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')
       ON CONFLICT (pod_id, user_id) DO UPDATE SET status = 'active'`,
      [podId, u.id],
    );
    await pool.query(
      `INSERT INTO session_participants (session_id, user_id, status) VALUES ($1, $2, 'registered')
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sessionId, u.id],
    );
    bots.push(u);
    console.log(`  ✓ ${BOT_NAMES[i]} created + registered`);
  }
  await pool.end();

  // One Chromium, 8 separate windows (contexts), small staggered viewports.
  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-size=640,520',
    ],
  });
  const contexts: BrowserContext[] = [];
  for (const u of bots) {
    const ctx = await browser.newContext({ viewport: { width: 620, height: 470 } });
    await ctx.addInitScript((toks: { a: string; r: string }) => {
      localStorage.setItem('rsn_access', toks.a);
      localStorage.setItem('rsn_refresh', toks.r);
    }, { a: u.accessToken, r: u.refreshToken });
    const page: Page = await ctx.newPage();
    page.on('dialog', (d) => { d.accept().catch(() => {}); });
    await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 45_000 }).catch(() => {});
    contexts.push(ctx);
    console.log(`  ✓ window open: ${u.displayName}`);
  }

  console.log('');
  console.log('  ████ 8 BOT WINDOWS READY — they are all yours, Ali. ████');
  console.log('  To close everything: create the file e2e/tests/STOP-BOTS.txt');
  console.log('');

  // Idle until the sentinel appears.
  while (!fs.existsSync(STOP_FILE)) {
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('  STOP-BOTS.txt found — closing windows');
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  try { fs.unlinkSync(STOP_FILE); } catch { /* ignore */ }
  await closePool();
});
