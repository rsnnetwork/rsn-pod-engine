import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod } from '../helpers/api';
import { gotoRetry, cleanup, cleanupByPrefix, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';

// ─────────────────────────────────────────────────────────────────────────────
// Two cards (Stefan, 9 Sep 2026). The onboarding-built profile — why you're
// here, who you want to meet, interests — is PRIVATE: only you and admins see
// it. Everyone else gets the public card. Proven on prod at the API (the
// payload itself has no private keys) and on the real page as viewer, owner
// and admin, at phone and desktop widths. Emails never reach normal members
// through member lists. No LLM — safe across engines.
// ─────────────────────────────────────────────────────────────────────────────

let browser: Browser;
let viewer: TestUser, subject: TestUser, admin: TestUser;
let podId = '';
const ctxs: BrowserContext[] = [];

const PRIVATE_KEYS = ['email', 'phone', 'interests', 'reasonsToConnect', 'whatICareAbout',
  'whoIWantToMeet', 'whyIWantToMeet', 'myIntent', 'goals', 'matchingNotes', 'onboardingStatus'];
const WANT = 'founders who need a technical cofounder for a climate robotics company';
const WHY = 'I want to join an early team as CTO after eleven years at Siemens';
const INTEREST = 'competitive sailing';
const HELP = 'frontend architecture reviews and hiring plans';

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function openAs(u: TestUser, path: string, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const ctx = await browser.newContext(contextOptions(viewport));
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
  viewer = await createTestUser('privviewer');
  subject = await createTestUser('privsubject');
  admin = await createTestUser('privadmin', 'admin');
  await pool.query(
    `UPDATE users SET display_name = $2, job_title = $3, company = $4, bio = $5,
        expertise_text = $6, what_i_can_help_with = $7,
        who_i_want_to_meet = $8, why_i_want_to_meet = $9, my_intent = $10,
        interests = $11, reasons_to_connect = $12, what_i_care_about = $13
      WHERE id = $1`,
    [subject.id, 'Priv Subject', 'Principal Engineer', 'QF Labs', 'I build robots.',
      'distributed systems, react', HELP, WANT, WHY, 'become a CTO',
      [INTEREST], ['find a cofounder'], 'climate'],
  );
  console.log(`[profile-privacy] engine=${engineLabel()} app=${APP}`);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  try { await browser?.close(); } catch { /* noop */ }
  for (const c of ctxs) { try { await c.close(); } catch { /* noop */ } }
  await cleanup(pool, { ids: [viewer.id, subject.id, admin.id], podId: podId || undefined });
  await cleanupByPrefix(pool, 'e2etest-priv');
  await pool.end().catch(() => {});
});

test('1) the API hands another member the public card only; owner and admin get the full profile', async () => {
  const asViewer = await apiAs(viewer, 'GET', `/users/${subject.id}`);
  expect(asViewer.status).toBe(200);
  const pub = asViewer.json.data;
  expect(pub.displayName).toBe('Priv Subject');
  expect(pub.bio).toBe('I build robots.');
  expect(pub.expertiseText).toBe('distributed systems, react');
  expect(pub.whatICanHelpWith).toBe(HELP);
  for (const k of PRIVATE_KEYS) expect(pub, `${k} must not reach another member`).not.toHaveProperty(k);
  expect(JSON.stringify(pub)).not.toContain(WANT);
  expect(JSON.stringify(pub)).not.toContain(INTEREST);

  const asOwner = await apiAs(subject, 'GET', `/users/${subject.id}`);
  expect(asOwner.json.data.whoIWantToMeet).toBe(WANT);
  expect(asOwner.json.data.interests).toEqual([INTEREST]);

  const asAdmin = await apiAs(admin, 'GET', `/users/${subject.id}`);
  expect(asAdmin.json.data.whyIWantToMeet).toBe(WHY);
  expect(asAdmin.json.data.email).toBe(subject.email);
});

test('2) member lists carry no emails for normal members; admins keep them; the invite list is host-only', async () => {
  const pod = await createPod(admin, 'E2E Privacy Pod');
  podId = pod.id;
  for (const u of [viewer, subject]) {
    const add = await apiAs(admin, 'POST', `/pods/${podId}/members`, { userId: u.id });
    expect([200, 201]).toContain(add.status);
  }
  const asMember = await apiAs(viewer, 'GET', `/pods/${podId}/members`);
  expect(asMember.status).toBe(200);
  expect(asMember.json.data.length).toBeGreaterThanOrEqual(2);
  for (const row of asMember.json.data) {
    expect(row).not.toHaveProperty('email');
    expect(row).not.toHaveProperty('interests');
    expect(row.displayName).toBeTruthy();
  }
  const asAdmin = await apiAs(admin, 'GET', `/pods/${podId}/members`);
  expect(asAdmin.json.data.some((r: any) => r.email === subject.email)).toBe(true);

  // The "who to invite" list (emails) is for the event's host and admins only.
  const forInvite = await apiAs(viewer, 'GET', `/pods/${podId}/members/for-invite?sessionId=00000000-0000-0000-0000-000000000000`);
  expect(forInvite.status).toBe(403);

  // Inviting someone you picked works by user id now (the list has no address).
  const byId = await apiAs(admin, 'POST', '/invites', { type: 'platform', maxUses: 1, inviteeUserId: viewer.id });
  expect([201, 400, 409]).toContain(byId.status); // created, or refused because they are already a member — never a schema error
  expect(byId.json?.error?.code).not.toBe('VALIDATION_ERROR');
});

test('3) on the real page: a viewer sees the public card, the owner and an admin see the private card too', async () => {
  test.setTimeout(240_000);
  for (const width of [390, 1280]) {
    const page = await openAs(viewer, `/profile/${subject.id}`, { width, height: 900 });
    await expect(page.getByTestId('profile-about')).toContainText('I build robots.', { timeout: 30_000 });
    await expect(page.getByText(HELP)).toBeVisible();
    await expect(page.getByTestId('private-card')).toHaveCount(0);
    for (const s of [WANT, WHY, INTEREST, 'Who I Want to Meet', 'Reasons to Connect', 'Private card']) {
      await expect(page.getByText(s, { exact: false }), `viewer must not see "${s}" at ${width}px`).toHaveCount(0);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `sideways scroll at ${width}px`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `shots/privacy/viewer-${width}-${engineLabel()}.png`, fullPage: true }).catch(() => {});
    await page.context().close();
  }

  const own = await openAs(subject, `/profile/${subject.id}`, { width: 390, height: 900 });
  const priv = own.getByTestId('private-card');
  await expect(priv).toBeVisible({ timeout: 30_000 });
  await expect(priv).toContainText('Only you and admins can see this');
  await expect(priv).toContainText(WANT);
  await expect(priv).toContainText(INTEREST);
  const lock = priv.getByText('Only you and admins can see this');
  const box = await lock.boundingBox();
  expect(box!.x + box!.width, 'private label fits a 390px phone').toBeLessThanOrEqual(390);
  await own.screenshot({ path: `shots/privacy/owner-390-${engineLabel()}.png`, fullPage: true }).catch(() => {});

  const adm = await openAs(admin, `/profile/${subject.id}`, { width: 1280, height: 900 });
  await expect(adm.getByTestId('private-card')).toBeVisible({ timeout: 30_000 });
  await expect(adm.getByTestId('private-card')).toContainText('Admin view');
  await expect(adm.getByTestId('private-card')).toContainText(WHY);
  await adm.screenshot({ path: `shots/privacy/admin-1280-${engineLabel()}.png`, fullPage: true }).catch(() => {});
});
