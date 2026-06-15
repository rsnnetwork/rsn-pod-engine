// SEC-1 (audit C1) — HEADED prod E2E for the acting-as-host privilege gate.
//
// Drives a REAL browser at app.rsn.network logged in as a real member, then:
//   1. asserts the member sees NO host-control surface (HostControls / the
//      pinned-off "join as host" banner),
//   2. from the authenticated browser origin, proves the gate end-to-end:
//        member  + value:true  -> 403 ("Only platform admins ...")  [escalation blocked]
//        member  + value:false -> 200                               [de-escalation open]
//        no auth + value:true  -> 401                               [auth required]
//
// Run against prod with a prod-valid JWT secret:
//   JWT_SECRET=<prod> npx playwright test sec1-acting-as-host-headed --config e2e/playwright.config.ts
// (server/.env's JWT_SECRET does NOT match prod — pass the Render/e2e secret.)
//
// Creates throwaway users (e2etest-*) and cleans them up by ID afterward.

import { test, expect, chromium, Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createTestUser, cleanupTestData, pool, TestUser } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, startSession, endSession } from '../helpers/api';

const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';
const API_BASE = process.env.E2E_CLIENT_API_BASE || 'https://rsn-api-h04m.onrender.com/api';
const SHOTS = path.join(__dirname, '../test-results/sec1-headed');

test.describe.serial('SEC-1 — acting-as-host gate (headed prod E2E)', () => {
  let host: TestUser;
  let member: TestUser;
  let podId: string;
  let sessionId: string;
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    host = await createTestUser('sec1-host', 'super_admin');
    member = await createTestUser('sec1-member', 'member');

    const pod = await createPod(host, 'E2E SEC-1 Pod');
    podId = pod.id;
    await addPodMember(host, podId, member.id);

    const sched = new Date(Date.now() + 60_000);
    const sess = await createSession(host, podId, 'E2E SEC-1 acting-as-host', sched);
    sessionId = sess.id;
    await registerForSession(member, sessionId);
    try { await startSession(host, sessionId); } catch { /* session may already be live */ }

    browser = await chromium.launch({
      headless: false,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
    page = await ctx.newPage();
  });

  test.afterAll(async () => {
    try { await page?.close(); } catch { /* ignore */ }
    try { await browser?.close(); } catch { /* ignore */ }
    try { await endSession(host, sessionId); } catch { /* may already be ended */ }
    const result = await cleanupTestData();
    // eslint-disable-next-line no-console
    console.log('SEC-1 headed cleanup:', result);
    try { await pool.end(); } catch { /* ignore */ }
  });

  test('member is logged in and sees NO host controls on the live event page', async () => {
    // Authenticate the browser by injecting the member's prod token.
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ a, r }) => {
      localStorage.setItem('rsn_access', a);
      localStorage.setItem('rsn_refresh', r);
    }, { a: member.accessToken, r: member.refreshToken });

    await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000); // let the SPA hydrate + socket connect
    await page.screenshot({ path: path.join(SHOTS, '01-member-live-view.png'), fullPage: true }).catch(() => {});

    // Not bounced to the login page (i.e. the token authenticated).
    expect(page.url()).not.toContain('/login');

    // The pinned-off "join as host" banner must never render for a member.
    const joinAsHostBanner = await page.locator('[data-testid="join-as-banner-host"]').count();
    expect(joinAsHostBanner).toBe(0);

    // No host-only control affordances. HostControls only mounts when isHost;
    // assert its signature buttons are absent for this member.
    for (const label of ['Match People', 'End Round', 'End Event', 'Start Round']) {
      const visible = await page.getByRole('button', { name: new RegExp(label, 'i') })
        .first().isVisible().catch(() => false);
      // eslint-disable-next-line no-console
      console.log(`  host control "${label}" visible to member:`, visible);
      expect(visible).toBe(false);
    }
    // eslint-disable-next-line no-console
    console.log('  ✓ member view carries no host controls');
  });

  test('the gate is enforced end-to-end from the authenticated browser origin', async () => {
    const res = await page.evaluate(async ({ apiBase, sid, token }) => {
      async function call(value: boolean, withAuth: boolean) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (withAuth) headers['Authorization'] = 'Bearer ' + token;
        const r = await fetch(`${apiBase}/sessions/${sid}/host/acting-as-host`, {
          method: 'POST', headers, body: JSON.stringify({ value }),
        });
        let body: any = null; try { body = await r.json(); } catch { /* non-JSON */ }
        const msg = body && (body.error?.message || body.message) || '';
        return { status: r.status, msg };
      }
      return {
        memberOptIn: await call(true, true),
        memberOptOut: await call(false, true),
        unauth: await call(true, false),
      };
    }, { apiBase: API_BASE, sid: sessionId, token: member.accessToken });

    // eslint-disable-next-line no-console
    console.log('  in-browser gate results:', JSON.stringify(res));

    // Escalation blocked.
    expect(res.memberOptIn.status).toBe(403);
    expect(res.memberOptIn.msg).toMatch(/platform admin/i);
    // De-escalation stays open (member flipping back via the HCC toggle path).
    expect(res.memberOptOut.status).toBe(200);
    // Auth required.
    expect(res.unauth.status).toBe(401);

    // DB cross-check: the failed opt-in left no escalation on the member's row.
    const row = await pool.query<{ acting_as_host: boolean | null }>(
      `SELECT acting_as_host FROM session_participants WHERE session_id = $1 AND user_id = $2`,
      [sessionId, member.id],
    );
    // value:false succeeded last, so the row is false (opt-out), never true.
    expect(row.rows[0]?.acting_as_host).not.toBe(true);
    // eslint-disable-next-line no-console
    console.log('  ✓ escalation blocked (403), de-escalation open (200), unauth (401), row never escalated');
  });
});
