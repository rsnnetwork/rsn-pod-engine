// Shared helpers for user-driven headed live-event specs (4 Jul edge-case
// matrix). Participants drive the REAL UI (rating forms, navigation); the host
// orchestrates via socket. Everything runs against prod.
import { Browser, BrowserContext, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { Pool } from 'pg';
import { TestUser } from './auth';

export const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
export const SERVER = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export function connectSocket(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: true });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket timeout')), 12_000);
  });
}

export async function gotoRetry(page: Page, url: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; }
    catch (e) { if (i === 2) throw e; await wait(3000); }
  }
}

export async function openParticipant(
  browser: Browser, ctxs: BrowserContext[], sessionId: string, u: TestUser,
  viewport = { width: 1024, height: 760 },
): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
  return page;
}

// ── Phase indicators (what the participant screen is showing) ────────────────
export const inLobby = (page: Page) => page.getByRole('button', { name: 'Compact', exact: true }).count().then(c => c > 0).catch(() => false);
export const inRating = (page: Page) => page.getByRole('button', { name: /Submit Rating/i }).count().then(c => c > 0).catch(() => false);
export const inBreakout = (page: Page) => page.getByRole('button', { name: /Back to Main Room/i }).count().then(c => c > 0).catch(() => false);
export const atRecap = (page: Page) => page.getByText(/Recap|Thanks for|see you|event (has )?ended|Rate your connections|Your connections/i).count().then(c => c > 0).catch(() => false);
// Video tiles this page renders (self + remotes). Converged lobby => > 1.
export const tilesSeen = (page: Page) => page.locator('video').count().catch(() => 0);
// The per-event check-in ("intent") modal — every participant must see it.
export const intentFormShown = (page: Page) =>
  page.getByRole('heading', { name: /What brings you here/i }).isVisible().catch(() => false);

/** Fill + submit the intent (check-in) modal if it's on screen. */
export async function submitIntent(page: Page, openness = 'Somewhat'): Promise<boolean> {
  if (!(await intentFormShown(page))) return false;
  await page.getByRole('button', { name: openness, exact: true }).first().click().catch(() => {});
  await page.getByRole('button', { name: 'Set', exact: true }).first().click().catch(() => {});
  await wait(1000);
  return true;
}

/** Fill and submit the REAL rating form if it's on screen. Returns true if it rated. */
export async function rateViaForm(page: Page, opts: { stars?: number; meetAgain?: boolean } = {}): Promise<boolean> {
  const stars = opts.stars ?? 5;
  const meetAgain = opts.meetAgain ?? true;
  const submit = page.getByRole('button', { name: /Submit Rating/i });
  if (!(await submit.isVisible().catch(() => false))) return false;
  const starBtns = page.locator('button:has(svg.lucide-star)');
  const n = await starBtns.count().catch(() => 0);
  if (n >= stars) await starBtns.nth(stars - 1).click().catch(() => {});
  if (meetAgain) await page.getByRole('button', { name: /Would you meet again|Would meet again/i }).click().catch(() => {});
  await submit.click().catch(() => {});
  await wait(1200); // let the confirmation card auto-continue
  return true;
}

/** Click the "Skip" link on the rating form if present. */
export async function skipRating(page: Page): Promise<boolean> {
  const skip = page.getByRole('button', { name: /^Skip$/i });
  if (!(await skip.isVisible().catch(() => false))) return false;
  await skip.click().catch(() => {});
  await wait(800);
  return true;
}

/** Robust teardown: sessions under the pod → members → pod → users. */
/**
 * Sweep every account a spec created, by its email prefix.
 *
 * Specs that create users INSIDE a test (a late joiner, a second sender) clean
 * them on the last line of that test — which never runs when an assertion above
 * it fails. On 3 Aug 2026 that left 11 test accounts live in production, where
 * they surfaced in real members' matching agents. afterAll should call this so
 * a failed test cannot leak an account into the network.
 *
 * Prefix-scoped on purpose: only ever `e2etest-<spec>` emails, never a name or
 * a LIKE that could reach a real member.
 */
export async function cleanupByPrefix(pool: Pool, prefix: string): Promise<number> {
  if (!prefix.startsWith('e2etest-')) {
    throw new Error(`refusing to sweep on "${prefix}" — must start with e2etest-`);
  }
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE $1`, [`${prefix}%`]);
  const ids = rows.map(r => r.id);
  if (ids.length === 0) return 0;
  await cleanup(pool, { ids });
  return ids.length;
}

export async function cleanup(pool: Pool, opts: { ids: string[]; podId?: string }): Promise<void> {
  const { ids, podId } = opts;
  if (podId) {
    const sess = await pool.query(`SELECT id FROM sessions WHERE pod_id=$1`, [podId]).catch(() => ({ rows: [] as any[] }));
    for (const s of sess.rows) {
      await pool.query(`DELETE FROM invites WHERE session_id=$1`, [s.id]).catch(() => {});
      await pool.query(`DELETE FROM encounter_history WHERE last_session_id=$1`, [s.id]).catch(() => {});
      await pool.query(`DELETE FROM sessions WHERE id=$1`, [s.id]).catch(() => {});
    }
    await pool.query(`DELETE FROM pod_members WHERE pod_id=$1`, [podId]).catch(() => {});
    await pool.query(`DELETE FROM pods WHERE id=$1`, [podId]).catch(() => {});
  }
  if (ids.length) {
    await pool.query(`DELETE FROM encounter_history WHERE user_a_id=ANY($1) OR user_b_id=ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM audit_log WHERE actor_id=ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM refresh_tokens WHERE user_id=ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM notifications WHERE user_id=ANY($1)`, [ids]).catch(() => {});
    // Wave 2: a test user that appears in someone's stored agent matches, or
    // that owns an agent, held a foreign key that made the DELETE below fail —
    // silently, because every statement here is best-effort. That is how 11
    // test accounts stayed live in production on 3 Aug and turned up in real
    // members' matches. Clear the matching layer first.
    await pool.query(`DELETE FROM agent_matches WHERE candidate_user_id=ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM agent_matches WHERE agent_id IN (SELECT id FROM matching_agents WHERE user_id=ANY($1))`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM matching_agents WHERE user_id=ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM direct_messages WHERE from_user_id=ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM dm_conversations WHERE user_a_id=ANY($1) OR user_b_id=ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM user_pokes WHERE sender_id=ANY($1) OR recipient_id=ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM user_intent_profiles WHERE user_id=ANY($1)`, [ids]).catch(() => {});
    await pool.query(`DELETE FROM onboarding_stage_events WHERE user_id=ANY($1)`, [ids]).catch(() => {});
    // Best-effort — a transient DNS/network blip during teardown must never
    // fail an otherwise-passing test (leftovers get swept by clean_ux).
    const del = await pool.query(`DELETE FROM users WHERE id=ANY($1) RETURNING id`, [ids]).catch(() => ({ rows: [] as any[] }));
    console.log(`Cleanup: ${del.rows.length} users, pod ${podId ?? '-'}`);
    // Say so loudly rather than leaving accounts in production unnoticed.
    if (del.rows.length < ids.length) {
      console.warn(`  ⚠ ${ids.length - del.rows.length} test account(s) SURVIVED cleanup — sweep them before they reach real members' matches`);
    }
  }
}

export type { Socket };
