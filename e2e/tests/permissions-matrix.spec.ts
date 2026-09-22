import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Shradha's deck, P3: "anyone can create a circle" was reported as a fault.
//
// It is not true, and the screenshot that showed it was taken on a super_admin
// account — the one role that can. Rather than reply with an assertion, prove
// it from a plain member's session, on production, both in the UI and against
// the API directly. A client finding closed by argument is not closed.
//
// The genuine finding underneath it was different and is fixed separately: a
// member who cannot run an event was shown no button and no reason, which
// reads as something broken rather than as a rule.
// ─────────────────────────────────────────────────────────────────────────────

const PHONE = { width: 390, height: 844 };
let browser: Browser;
const ctxs: BrowserContext[] = [];
const made: string[] = [];

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string, viewport = PHONE): Promise<Page> {
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
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

test.beforeAll(async () => {
  console.log(`[permissions-matrix] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  try { await browser?.close(); } catch { /* noop */ }
  if (made.length) await cleanup(pool, { ids: made });
  await cleanupByPrefix(pool, 'e2etest-perm');
  await pool.end().catch(() => {});
});

test('a plain member cannot create a circle, in the UI or behind it', async () => {
  test.setTimeout(180_000);
  const member = await createTestUser('permmember');
  made.push(member.id);

  // The server is the part that matters: a missing button is a preference, a
  // refused request is the rule.
  const attempt = await apiAs(member, 'POST', '/circles', {
    name: `E2E perm probe ${Date.now()}`, description: 'should never be created',
  });
  expect([401, 403], `a member got ${attempt.status} creating a circle`).toContain(attempt.status);
  console.log(`  ✓ POST /circles as a member → ${attempt.status}`);

  // And nothing was written despite the refusal.
  const leaked = await pool.query(`SELECT id FROM circles WHERE created_by = $1`, [member.id]);
  expect(leaked.rows, 'no circle row was created').toHaveLength(0);

  // The screen agrees with the server.
  const page = await openAs(member, '/circles');
  await page.waitForTimeout(2500);
  const create = page.getByRole('button', { name: /new circle|create circle/i });
  await expect(create, 'a member is not offered the create form').toHaveCount(0);
  console.log('  ✓ and the Circles page offers a member no way to create one');
});

test('an admin can, which is what the screenshot actually showed', async () => {
  test.setTimeout(180_000);
  const admin = await createTestUser('permadmin', 'super_admin');
  made.push(admin.id);

  const page = await openAs(admin, '/circles');
  await expect(
    page.getByRole('button', { name: /new circle|create circle/i }).first(),
    'an admin IS offered it — the deck screenshot was taken on this role',
  ).toBeVisible({ timeout: 30_000 });
  console.log('  ✓ the same page on a super_admin does offer it');
});

test('a member who cannot run an event is told who can', async () => {
  test.setTimeout(180_000);
  const member = await createTestUser('permevent');
  made.push(member.id);

  const page = await openAs(member, '/sessions');
  await expect(page.getByText(/Events are run by pod directors and hosts/i))
    .toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /New Event/i }), 'and is not offered the button')
    .toHaveCount(0);

  // Not a dead end: the way to become one is on the page.
  const route = page.getByRole('button', { name: /Start a pod|Browse pods/i }).first();
  await expect(route).toBeVisible();
  console.log('  ✓ the rule is stated, with a way through it');

  // The server refuses too, so the missing button is not the only guard. Send
  // a VALID body for a real pod the member belongs to but does not run —
  // otherwise a 400 for a malformed request would pass as proof of a rule it
  // never reached.
  const director = await createTestUser('permdirector');
  made.push(director.id);
  const pod = (await apiAs(director, 'POST', '/pods', {
    name: `E2E perm pod ${Date.now()}`, description: 'permission probe', isPublic: true,
  })).json?.data;
  expect(pod?.id, 'the director could create a pod').toBeTruthy();
  await pool.query(
    `INSERT INTO pod_members (pod_id, user_id, role, status)
     VALUES ($1, $2, 'member', 'active') ON CONFLICT DO NOTHING`,
    [pod.id, member.id],
  );

  const attempt = await apiAs(member, 'POST', '/sessions', {
    podId: pod.id,
    title: 'E2E perm probe',
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    durationMinutes: 30,
  });
  expect(attempt.status, `a member of the pod got ${attempt.status} creating an event in it`).toBe(403);
  console.log(`  ✓ POST /sessions in a pod they are a MEMBER of → ${attempt.status}`);

  // And the director of that same pod can, so the refusal is about the role.
  const allowed = await apiAs(director, 'POST', '/sessions', {
    podId: pod.id,
    title: `E2E perm allowed ${Date.now()}`,
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    durationMinutes: 30,
  });
  expect(allowed.status, 'the pod director can').toBe(201);
  console.log('  ✓ the director of the same pod → 201, so the rule is the role');
  await cleanup(pool, { ids: [], podId: pod.id });
});
