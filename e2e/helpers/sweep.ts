// e2e/helpers/sweep.ts
//
// What the final-sweep specs (script-a to script-e, T19, 2 Nov 2026) share: throwaway members on the reserved test
// domain, signed-in browsers at the run's width or device, the API as a member, the checks every screen gets (no
// sideways scroll, not reloaded), and a teardown that deletes exactly what the run made, by id. The flows themselves
// are the n1-* specs' and the 25 Oct specs'; this file only keeps them from being copied five times.
//
// Width and device: E2E_DEVICE="iPhone 14" for a phone (its own viewport and touch), otherwise E2E_WIDTH (default
// 1280) with a desktop height, touch below 1024. One spec per process, as every headed spec here.

import { chromium, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page, expect, test } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { createTestUser, pool, type TestUser } from './auth';
import { APP, SERVER, cleanup, gotoRetry, teardown } from './live-ui';
import { primePreview } from './preview-bypass';
import { engineLabel, pickEngine } from './engine';

export { APP, SERVER, pool, gotoRetry };
export type { TestUser };

const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');

/** The local stack (run-local-spec.sh): its API mocks LiveKit, so no real room ever connects there. */
export const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(APP);
export const DEVICE_NAME = process.env.E2E_DEVICE || '';
export const DEVICE = DEVICE_NAME ? (devices as Record<string, BrowserContextOptions>)[DEVICE_NAME] : null;
export const WIDTH = Number(process.env.E2E_WIDTH || 1280);
export const IS_WEBKIT = process.env.E2E_ENGINE === 'webkit';
/** A real LiveKit room needs the preview or production, and Chromium (Windows WebKit has no WebRTC). */
export const ROOMS = !LOCAL && !IS_WEBKIT;
export const ROOM_SKIP = LOCAL
  ? 'The local API mocks LiveKit, so no room connects: this step runs on the preview (Chromium).'
  : "Playwright's WebKit on Windows has no WebRTC, so it cannot join a LiveKit room: this step runs in Chromium.";
/**
 * A step that cannot run here says why and is left out, without stopping the steps after it (test.skip inside a step
 * would skip the rest of the test). The reason is kept as a "skipped step" annotation on the test's result.
 */
export function skipStep(when: boolean, reason: string): boolean {
  if (!when) return false;
  test.info().annotations.push({ type: 'skipped step', description: reason });
  console.log(`  (step skipped: ${reason})`);
  return true;
}

/** The width the run is looked at: the device's own, or E2E_WIDTH. */
export const RUN_WIDTH = DEVICE?.viewport?.width ?? WIDTH;
export const where = () => `${engineLabel()}${DEVICE ? '' : ` ${WIDTH}px`}`;

const SHOTS = process.env.E2E_SHOTS_DIR || '';

// Chromium >= 147 on Windows loses the fake camera through Media Foundation capture, and honours only the last
// --disable-features switch, so Playwright's own list is repeated before the extra one (global constraint 9).
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';

/** The run's browser: Chromium with the fake camera and microphone, or WebKit. Headed unless E2E_HEADED=0. */
export async function launch(): Promise<Browser> {
  const engine = pickEngine();
  return engine.launch({
    headless: process.env.E2E_HEADED === '0',
    ...(engine === chromium ? {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
        `--disable-features=${PW_DISABLED},MediaFoundationD3D11VideoCapture`],
    } : {}),
  });
}

// ── What the run made ──────────────────────────────────────────────────────────────────────────────────────────
// Every row a spec makes is named here the moment it exists, and only these are deleted, by id.
export interface Made {
  users: string[]; pods: string[]; circles: string[]; entities: string[]; groups: string[]; sessions: string[];
}
export const made: Made = { users: [], pods: [], circles: [], entities: [], groups: [], sessions: [] };

/** A short id for this run, in names only this run uses. */
export const RUN = `zq${Date.now().toString(36)}`;

interface Throwaway {
  role?: 'member' | 'admin';
  /** completed = a v2 finisher based in a city (createTestUser's default); old = finished only the earlier onboarding,
   *  no location; fresh = just approved, nothing answered. */
  onboarding?: 'completed' | 'old' | 'fresh';
  first?: string;
  last?: string;
  /** SQL `, column = $n` pieces with their values, applied after the name. */
  set?: Record<string, unknown>;
}

/**
 * A throwaway member on the reserved test domain (`<id>@rsn-e2e.invalid`, which can never receive mail), named
 * "<first> <last>" with this run's id, and its tokens signed for that address (accepting an invite checks the
 * signed-in address against the invite's). createTestUser seeds a v2 finisher based in Copenhagen; `onboarding`
 * gives the other shapes production holds.
 */
export async function throwaway(label: string, opts: Throwaway = {}): Promise<TestUser> {
  const role = opts.role ?? 'member';
  const u = await createTestUser(`t19${label}`, role, opts.onboarding === 'fresh' ? 'not_started' : 'completed');
  made.users.push(u.id);
  const first = opts.first ?? label;
  const last = opts.last ?? RUN;
  const name = `${first} ${last}`;
  const email = `${u.id}@rsn-e2e.invalid`;
  const cols: string[] = [];
  const values: unknown[] = [u.id, email, name, first, last];
  if (opts.onboarding === 'old') cols.push('onboarding_version = NULL', 'location = NULL');
  if (opts.onboarding === 'fresh') cols.push('onboarding_completed = false', 'location = NULL', 'company = NULL', 'job_title = NULL', 'industry = NULL');
  for (const [col, value] of Object.entries(opts.set ?? {})) {
    values.push(value);
    cols.push(`${col} = $${values.length}`);
  }
  await pool.query(
    `UPDATE users SET email = $2, display_name = $3, first_name = $4, last_name = $5,
            notification_prefs = jsonb_set(COALESCE(notification_prefs, '{}'::jsonb), '{dm_email}', 'false')
            ${cols.length ? `, ${cols.join(', ')}` : ''}
      WHERE id = $1`,
    values,
  );
  const sessionId = uuid();
  return {
    id: u.id, email, displayName: name,
    accessToken: jwt.sign({ sub: u.id, email, role, displayName: name, sessionId }, SECRET, { expiresIn: '2h' }),
    refreshToken: jwt.sign({ sub: u.id, sessionId, type: 'refresh' }, SECRET, { expiresIn: '1d' }),
  };
}

export const firstName = (u: TestUser) => u.displayName.split(' ')[0];

/** The API as this member, as their own page calls it. */
export async function api(u: TestUser, method: string, p: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${SERVER}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null; // `any`: every route answers its own shape, read by name in the assertions.
  try { json = text ? JSON.parse(text) : null; } catch { /* a file, not JSON */ }
  return { status: res.status, json, text };
}

/** A and B connected the way members are: A asks to meet, B accepts. The conversation's id. */
export async function connect(a: TestUser, b: TestUser, note = `Hello ${RUN}`): Promise<string> {
  const asked = await api(a, 'POST', '/pokes', { recipientId: b.id, message: note });
  expect(asked.status, asked.text).toBe(201);
  const accepted = await api(b, 'POST', `/pokes/${asked.json.data.id}/accept`);
  expect(accepted.status, accepted.text).toBe(200);
  return conversationOf(a, b);
}

export async function conversationOf(a: TestUser, b: TestUser): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`, [a.id, b.id]);
  return r.rows[0]?.id ?? '';
}

/** A pod this run owns, its director first, then each member active (SQL, as the n1 specs seed them). */
export async function seedPod(director: TestUser, name: string, members: TestUser[] = [], podType = 'speed_networking', visibility = 'private'): Promise<string> {
  const pod = await pool.query<{ id: string }>(
    `INSERT INTO pods (name, created_by, visibility, status, pod_type) VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
    [name, director.id, visibility, podType]);
  const id = pod.rows[0].id;
  made.pods.push(id);
  await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'director', 'active')`, [id, director.id]);
  for (const m of members) await pool.query(`INSERT INTO pod_members (pod_id, user_id, role, status) VALUES ($1, $2, 'member', 'active')`, [id, m.id]);
  return id;
}

/** A circle this run owns, created as production's admin does (POST /circles), so its creator is its owner. */
export async function createCircle(owner: TestUser, name: string): Promise<string> {
  const res = await api(owner, 'POST', '/circles', { name, description: 'A throwaway circle.' });
  expect(res.status, res.text).toBe(201);
  made.circles.push(res.json.data.id);
  return res.json.data.id;
}

// ── Browsers ───────────────────────────────────────────────────────────────────────────────────────────────────
const contexts: BrowserContext[] = [];

/** The context options of the run: the device's, or E2E_WIDTH (or `width`) with touch below 1024. */
export function viewportOptions(width?: number): BrowserContextOptions {
  if (DEVICE) return { ...DEVICE };
  const w = width ?? WIDTH;
  return { viewport: { width: w, height: w < 768 ? 844 : 900 }, hasTouch: w < 1024 };
}

export interface Opened { ctx: BrowserContext; page: Page; errors: string[] }

/**
 * A browser of its own, signed in as this member, at the run's width (or `width`), opened at `p`. Each is a separate
 * context: a second one is a second browser, which is what "without a reload" is watched in.
 */
export async function openAs(browser: Browser, u: TestUser, p: string, opts: { width?: number; extra?: BrowserContextOptions } = {}): Promise<Opened> {
  const ctx = await browser.newContext({
    ...viewportOptions(opts.width),
    acceptDownloads: true,
    ...(pickEngine() === chromium ? { permissions: ['camera', 'microphone'] } : {}),
    ...opts.extra,
  });
  contexts.push(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  await primePreview(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!/ResizeObserver loop|access control checks/.test(e.message)) errors.push(`${u.displayName}: ${e.message}`); });
  if (p) await gotoRetry(page, `${APP}${p}`);
  return { ctx, page, errors };
}

/** A signed-out browser at the run's width. */
export async function openSignedOut(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext(viewportOptions());
  contexts.push(ctx);
  await primePreview(ctx);
  return ctx.newPage();
}

export async function closeBrowsers(): Promise<void> {
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
}

/** A marker on the page itself: gone if the document is loaded again. */
export const markNotReloaded = (page: Page) => page.evaluate(() => { (window as unknown as { __t19: number }).__t19 = 1; });
export async function expectNotReloaded(page: Page, label: string): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __t19?: number }).__t19 === 1), `${label}: the page was not reloaded`).toBe(true);
}

export async function noSidewaysScroll(page: Page, label: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    { message: `${label}: the page is wider than its window`, timeout: 5_000 }).toBeLessThanOrEqual(0);
}

/** At least 44px tall (read to the half pixel: an entrance animation can leave a sub-pixel of scale behind). */
export async function tall(target: Locator, label: string): Promise<void> {
  await expect.poll(async () => (await target.boundingBox())?.height ?? 0, { message: `${label}: at least 44px tall`, timeout: 10_000 })
    .toBeGreaterThanOrEqual(43.5);
}

/** The bell's unread count on this page, as a locator (absent when nothing is unread). */
export const bellCount = (page: Page) => page.getByRole('button', { name: 'Notifications' }).locator('span').filter({ hasText: /^\d+$/ });

export async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const tag = `${engineLabel()}${DEVICE ? '' : `-${WIDTH}`}`.replace(/[^a-z0-9]+/gi, '-');
  await page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`) }).catch(() => undefined);
}

/** A JPEG made in the page: red left half, blue right half (T3a's), so which part was kept can be read back. */
export async function halves(page: Page, width: number, height: number): Promise<Buffer> {
  const base64 = await page.evaluate(async ({ w, h }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d')!;
    x.fillStyle = '#d1242f'; x.fillRect(0, 0, w / 2, h);
    x.fillStyle = '#0969da'; x.fillRect(w / 2, 0, w / 2, h);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }, { w: width, h: height });
  return Buffer.from(base64, 'base64');
}

/** The size of a picture at an address, read in the page. */
export function pictureSize(page: Page, url: string): Promise<{ width: number; height: number }> {
  return page.evaluate(async (u) => {
    const bitmap = await createImageBitmap(await (await fetch(u)).blob());
    return { width: bitmap.width, height: bitmap.height };
  }, url);
}

/** A two-finger pinch on the frame, as touch pointers (T3a's): the fingers spread from 40px apart to 120px. */
export function pinch(frame: Locator) {
  return frame.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    const cx = r.left + r.width / 2;
    const fire = (type: string, id: number, x: number) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: cy, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', 11, cx - 20);
    fire('pointerdown', 12, cx + 20);
    for (let s = 1; s <= 4; s += 1) { fire('pointermove', 11, cx - 20 - 10 * s); fire('pointermove', 12, cx + 20 + 10 * s); }
    fire('pointerup', 11, cx - 60);
    fire('pointerup', 12, cx + 60);
  });
}

/** Drag the picture in the frame by dx, dy with a pointer. */
export async function drag(page: Page, frame: Locator, dx: number, dy: number): Promise<void> {
  const box = (await frame.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

/** Scroll a control to the middle of the window (clear of a phone's fixed tab bar), at once. */
export const scrollClear = (target: Locator) =>
  target.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior }));

// ── Teardown ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Deletes exactly what the run made, by id, every step even if an earlier one fails, then checks nothing is left:
 * an account that survives is named in the failure so it can be removed by its id.
 */
export async function cleanupRun(extra: Array<() => Promise<unknown>> = []): Promise<void> {
  const ids = [...made.users];
  await teardown(
    () => closeBrowsers(),
    ...extra,
    () => (made.groups.length ? pool.query('DELETE FROM dm_groups WHERE id = ANY($1::uuid[])', [made.groups]) : Promise.resolve()),
    () => (made.sessions.length ? pool.query('DELETE FROM dm_groups WHERE session_id = ANY($1::uuid[])', [made.sessions]) : Promise.resolve()),
    () => (made.sessions.length ? pool.query(
      `DELETE FROM post_event_message_recipients WHERE job_id IN (SELECT id FROM post_event_message_jobs WHERE session_id = ANY($1::uuid[]))`, [made.sessions]) : Promise.resolve()),
    () => (made.sessions.length ? pool.query('DELETE FROM post_event_message_jobs WHERE session_id = ANY($1::uuid[])', [made.sessions]) : Promise.resolve()),
    () => (made.circles.length ? pool.query('DELETE FROM invites WHERE circle_id = ANY($1::uuid[])', [made.circles]) : Promise.resolve()),
    () => (made.circles.length ? pool.query('DELETE FROM circle_pods WHERE circle_id = ANY($1::uuid[])', [made.circles]) : Promise.resolve()),
    () => (made.circles.length ? pool.query('DELETE FROM circle_members WHERE circle_id = ANY($1::uuid[])', [made.circles]) : Promise.resolve()),
    () => (made.circles.length ? pool.query('DELETE FROM circles WHERE id = ANY($1::uuid[])', [made.circles]) : Promise.resolve()),
    () => (made.entities.length ? pool.query('DELETE FROM entities WHERE id = ANY($1::uuid[])', [made.entities]) : Promise.resolve()),
    // Pods made by a form are found by their director (one of ours), never by a name.
    async () => {
      if (!ids.length) return;
      const r = await pool.query<{ id: string }>('SELECT id FROM pods WHERE created_by = ANY($1::uuid[])', [ids]);
      for (const p of r.rows) if (!made.pods.includes(p.id)) made.pods.push(p.id);
    },
    // Invites hold their pod, their event and the member who accepted them without a cascade: they go first.
    () => (made.pods.length || ids.length ? pool.query(
      `DELETE FROM invites WHERE pod_id = ANY($1::uuid[]) OR accepted_by_user_id = ANY($2::uuid[])
          OR session_id IN (SELECT id FROM sessions WHERE pod_id = ANY($1::uuid[]))`, [made.pods, ids]) : Promise.resolve()),
    () => (ids.length ? pool.query(
      `DELETE FROM post_event_message_recipients WHERE job_id IN (SELECT id FROM post_event_message_jobs WHERE created_by = ANY($1::uuid[]))`, [ids]) : Promise.resolve()),
    () => (ids.length ? pool.query('DELETE FROM post_event_message_jobs WHERE created_by = ANY($1::uuid[])', [ids]) : Promise.resolve()),
    async () => { for (const podId of made.pods) await cleanup(pool, { ids: [], podId }); },
    () => (ids.length ? pool.query('DELETE FROM person_responses WHERE user_id = ANY($1::uuid[]) OR target_user_id = ANY($1::uuid[])', [ids]) : Promise.resolve()),
    () => (ids.length ? pool.query('DELETE FROM user_blocks WHERE blocker_id = ANY($1::uuid[]) OR blocked_id = ANY($1::uuid[])', [ids]) : Promise.resolve()),
    () => (ids.length ? pool.query('DELETE FROM magic_links WHERE email = ANY($1::text[])', [ids.map((id) => `${id}@rsn-e2e.invalid`)]) : Promise.resolve()),
    () => cleanup(pool, { ids }),
    async () => {
      if (!ids.length) return;
      const left = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = ANY($1::uuid[])', [ids]);
      expect(left.rows.map((r) => r.id), 'throwaway accounts that survived cleanup (remove them by these ids)').toEqual([]);
    },
  );
}
