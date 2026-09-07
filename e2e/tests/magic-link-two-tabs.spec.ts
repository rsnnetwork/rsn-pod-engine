import { test, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { APP } from '../helpers/live-ui';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// 7 Sep 2026 — Stefan's REASON test: the sign-in link "did not work on the first
// try" and he was "logged out unexpectedly" mid-session. Root cause (reproduced
// against prod before the fix): tokens lived in two localStorage keys written in
// two setItem calls, so a second open tab read a half-updated pair and wrote the
// STALE refresh token back over the freshly-issued one. Every refresh then 401'd
// and the session died ~15 min in.
//
// This spec reproduces exactly that shape: a returning user with an EXPIRED pair
// already in localStorage, a second tab open, clicking a real magic link. It
// must land in the app AND keep the fresh refresh token AND survive an access
// token expiry without being logged out.
//
// RED against the pre-fix bundle (both tabs end on /login, storage holds the
// stale refresh). GREEN against the fixed bundle.
// ─────────────────────────────────────────────────────────────────────────────

dotenvConfig({ path: path.resolve(__dirname, '../../server/.env') });
const JWT_SECRET = (process.env.JWT_SECRET || process.env.E2E_JWT_SECRET || '').replace(/\r|\n/g, '');
const DB = process.env.DATABASE_URL;

const fp = (t?: string | null) =>
  t ? crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 12) : String(t);

test.describe('magic link login survives a second tab + stale tokens (Stefan 7 Sep)', () => {
  test('lands in the app on the first click, keeps the fresh refresh token, and survives access expiry', async () => {
    test.skip(!JWT_SECRET || !DB, 'needs JWT_SECRET + DATABASE_URL (export from Render env / e2e/.jwt_secret)');
    test.setTimeout(180_000);

    const pool = new Pool({ connectionString: DB, ssl: { rejectUnauthorized: false } });
    const id = crypto.randomUUID();
    const email = `e2etest-2tab-${Date.now()}@example.com`;
    let browser: Browser | null = null;

    try {
      await pool.query(
        `INSERT INTO users (id,email,display_name,first_name,last_name,status,role,profile_complete,onboarding_completed,onboarding_status,email_verified,company,job_title,industry,reasons_to_connect)
         VALUES ($1,$2,'E2E TwoTab','E2E','TwoTab','active','member',true,true,'completed',true,'TestCo','Test Account','Tech',ARRAY['Testing']::text[])`,
        [id, email],
      );

      // A returning user's browser holds an OLD, already-expired pair.
      const now = Math.floor(Date.now() / 1000);
      const staleAccess = jwt.sign(
        { sub: id, email, role: 'member', displayName: 'E2E TwoTab', sessionId: crypto.randomUUID(), iat: now - 90_000, exp: now - 3600 },
        JWT_SECRET,
      );
      const staleRefresh = jwt.sign(
        { sub: id, sessionId: crypto.randomUUID(), type: 'refresh', iat: now - 90_000, exp: now - 3600 },
        JWT_SECRET,
      );

      // A real, unused magic link.
      const linkToken = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1,$2,NOW()+INTERVAL '1 hour')`,
        [email, crypto.createHash('sha256').update(linkToken).digest('hex')],
      );

      console.log(`[magic-link-two-tabs] engine=${engineLabel()} app=${APP}`);
      browser = await launchBrowser();
      const ctx = await browser.newContext(contextOptions());

      // When running against a protected Vercel preview, prime the context with
      // the share cookie once (E2E_VERCEL_SHARE from get_access_to_vercel_url).
      const SHARE = process.env.E2E_VERCEL_SHARE || '';
      if (SHARE) {
        const primer = await ctx.newPage();
        await primer.goto(`${APP}/?_vercel_share=${SHARE}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await primer.waitForTimeout(1500);
        await primer.close();
      }
      // Seed the stale pair (both legacy keys AND the new atomic key) before any
      // script runs, once per context.
      await ctx.addInitScript(([a, r]) => {
        if (!localStorage.getItem('rsn_2tab_seeded')) {
          localStorage.setItem('rsn_access', a);
          localStorage.setItem('rsn_refresh', r);
          localStorage.setItem('rsn_tokens', JSON.stringify({ access: a, refresh: r }));
          localStorage.setItem('rsn_2tab_seeded', '1');
        }
      }, [staleAccess, staleRefresh]);

      // Capture the refresh token the server issues at verify.
      let issuedRefresh: string | null = null;
      const refreshStatuses: number[] = [];
      const wire = (page: import('@playwright/test').Page) => {
        page.on('response', async (res) => {
          const u = res.url();
          if (u.includes('/api/auth/verify') && res.status() === 200) {
            try { issuedRefresh = (await res.json())?.data?.refreshToken ?? issuedRefresh; } catch { /* noop */ }
          }
          if (u.includes('/api/auth/refresh')) refreshStatuses.push(res.status());
        });
      };

      // Tab A: an idle login page (the "other tab" that corrupts the pair).
      const tabA = await ctx.newPage();
      wire(tabA);
      await tabA.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
      await tabA.waitForTimeout(3000);

      // Tab B: the magic-link click.
      const tabB = await ctx.newPage();
      wire(tabB);
      await tabB.goto(`${APP}/auth/verify?token=${linkToken}`, { waitUntil: 'domcontentloaded' });

      // MUST leave the verify + login screens — i.e. actually sign in.
      await tabB.waitForFunction(
        () => !location.pathname.startsWith('/auth/verify') && !location.pathname.startsWith('/login'),
        null,
        { timeout: 60_000 },
      );
      await tabB.waitForTimeout(3000);

      expect(tabB.url()).not.toContain('/login');
      expect(tabB.url()).not.toContain('/auth/verify');

      // The FRESH refresh token must have survived — not the stale seeded one.
      const stored = await tabB.evaluate(() => {
        const raw = localStorage.getItem('rsn_tokens');
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
      });
      expect(stored, 'rsn_tokens present after verify').toBeTruthy();
      expect(issuedRefresh, 'server issued a refresh at verify').toBeTruthy();
      expect(fp(stored.refresh), 'stored refresh == server-issued fresh token (not the stale one)').toBe(fp(issuedRefresh));
      expect(fp(stored.refresh)).not.toBe(fp(staleRefresh));

      // Now force an access-token expiry (short 20s access) and reload — the
      // session must refresh and stay alive, not bounce to /login.
      const shortAccess = jwt.sign(
        { sub: id, email, role: 'member', displayName: 'E2E TwoTab', sessionId: crypto.randomUUID() },
        JWT_SECRET,
        { expiresIn: '20s' },
      );
      await tabB.evaluate((t) => {
        const raw = localStorage.getItem('rsn_tokens');
        const cur = raw ? JSON.parse(raw) : {};
        localStorage.setItem('rsn_tokens', JSON.stringify({ access: t, refresh: cur.refresh }));
        localStorage.setItem('rsn_access', t);
      }, shortAccess);

      refreshStatuses.length = 0;
      await tabB.reload({ waitUntil: 'domcontentloaded' });
      await tabB.waitForTimeout(30_000); // ride past the 20s access expiry

      expect(tabB.url(), 'still in the app after access-token expiry').not.toContain('/login');
      expect(refreshStatuses.some((s) => s === 200), 'a refresh succeeded (200) after expiry').toBeTruthy();
      expect(refreshStatuses.every((s) => s !== 401), 'no refresh 401 after the fix').toBeTruthy();
    } finally {
      if (browser) await browser.close().catch(() => {});
      // Clean up by exact id.
      for (const [tbl, col] of [
        ['refresh_tokens', 'user_id'], ['audit_log', 'actor_id'],
        ['notifications', 'user_id'], ['onboarding_stage_events', 'user_id'],
        ['user_intent_profiles', 'user_id'],
      ] as const) {
        await pool.query(`DELETE FROM ${tbl} WHERE ${col}=$1`, [id]).catch(() => {});
      }
      await pool.query(`DELETE FROM magic_links WHERE email=$1`, [email]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id=$1`, [id]).catch(() => {});
      await pool.end().catch(() => {});
    }
  });
});
