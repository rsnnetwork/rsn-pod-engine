import { test, expect, chromium, Browser, BrowserContext } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession } from '../helpers/api';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { profileLinkSelector } from '../helpers/profile-link';

// PROD VERIFICATION — REASON v1 Phase 3a (19 Jul 2026): circles core.
// Circle = community (WHO); pods ATTACH to circles many-to-many. Admin-created
// v1, open join. Verifies the authz matrix (non-admin create rejected), the
// idempotent join + transactional counter, and the detail aggregation
// (members + attached pod + that pod's upcoming event). Headed: a member on a
// phone width joins from the real UI.
// T2 (1 Nov 2026), D3: the circle page names an attached pod's event only to someone who may open it. The pod starts
// private, so a member of the circle who is not in the pod is not told its event's title, the admin is; once the pod
// is public, everyone is.

let browser: Browser;
let admin: TestUser, m1: TestUser, m2: TestUser;
const ctxs: BrowserContext[] = [];
let circleId = '', podId = '', sessionId = '';

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test.beforeAll(async () => {
  admin = await createTestUser('circadmin', 'super_admin');
  m1 = await createTestUser('circm1');
  m2 = await createTestUser('circm2');
  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  // circles.created_by has no cascade — remove circles BEFORE users.
  if (circleId) await pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]).catch(() => {});
  await cleanup(pool, { ids: [admin?.id, m1?.id, m2?.id].filter(Boolean), podId: podId || undefined });
});

test('circles core: admin creates, members join idempotently, detail aggregates pods + events', async () => {
  test.setTimeout(300_000);

  // (1) AUTHZ: a plain member cannot create a circle.
  const forbidden = await apiAs(m1, 'POST', '/circles', { name: 'Sneaky Circle' });
  expect(forbidden.status).toBe(403);
  console.log('  ✓ non-admin create rejected (403).');

  // (2) Admin creates the circle; duplicate name at the same level rejected.
  const created = await apiAs(admin, 'POST', '/circles', {
    name: 'E2E Founders', description: 'Verification circle',
  });
  expect(created.status).toBe(201);
  circleId = created.json.data.id;
  const dupe = await apiAs(admin, 'POST', '/circles', { name: 'e2e founders' });
  expect(dupe.status).toBe(409);
  console.log('  ✓ admin created circle; case-insensitive duplicate rejected (409).');

  // (3) Attach a pod with an upcoming event → detail must aggregate both.
  const pod = await createPod(admin, 'E2E Circle Pod'); podId = pod.id;
  const sess = await createSession(admin, podId, 'E2E Circle Event', new Date(Date.now() + 3600_000), {
    numberOfRounds: 1, roundDurationSeconds: 60, ratingWindowSeconds: 20,
  });
  sessionId = sess.id;
  const attach = await apiAs(admin, 'POST', `/circles/${circleId}/pods`, { podId });
  expect(attach.status).toBe(201);

  // (4) Open join, IDEMPOTENT: joining twice counts once. Since R10a the creator is the circle's owner and a member, so
  // the circle starts at 1 and m1 makes it 2, after the first join and after the second.
  const fresh = await apiAs(admin, 'GET', `/circles/${circleId}`);
  expect(fresh.json.data.memberCount, 'the creator is the owner, and a member').toBe(1);
  expect(fresh.json.data.members.map((m: any) => m.userId)).toEqual([admin.id]);
  expect((await apiAs(m1, 'POST', `/circles/${circleId}/join`)).status).toBe(200);
  const afterFirst = await apiAs(m1, 'GET', `/circles/${circleId}`);
  expect(afterFirst.json.data.memberCount).toBe(2);
  expect((await apiAs(m1, 'POST', `/circles/${circleId}/join`)).status).toBe(200);
  const detail1 = await apiAs(m1, 'GET', `/circles/${circleId}`);
  expect(detail1.json.data.memberCount, 'double-join must count ONCE').toBe(2);
  expect(detail1.json.data.members.map((m: any) => m.userId).sort()).toEqual([admin.id, m1.id].sort());
  expect(detail1.json.data.isMember).toBe(true);
  // T14: the pod is private and m1 is not in it, so the circle page does not name it to them; the admin sees it.
  expect(detail1.json.data.pods.map((p: any) => p.podId), 'a private pod is named only to its members').not.toContain(podId);
  expect((await apiAs(admin, 'GET', `/circles/${circleId}`)).json.data.pods.map((p: any) => p.podId)).toContain(podId);
  // D3: the pod is private and m1 is not in it, so its event is not named to them; the admin may open it.
  expect(detail1.json.data.upcomingEvents.map((e: any) => e.id), "a private pod's event is not named to a non-member").not.toContain(sessionId);
  const adminDetail = await apiAs(admin, 'GET', `/circles/${circleId}`);
  expect(adminDetail.json.data.upcomingEvents.map((e: any) => e.id)).toContain(sessionId);
  // Once the pod is public, anyone may open its event, and the circle page names it to everyone.
  expect((await apiAs(admin, 'PUT', `/pods/${podId}`, { visibility: 'public' })).status).toBe(200);
  const detailPublic = await apiAs(m1, 'GET', `/circles/${circleId}`);
  expect(detailPublic.json.data.upcomingEvents.map((e: any) => e.id)).toContain(sessionId);
  expect(detailPublic.json.data.pods.map((p: any) => p.podId), 'a public pod is named to everyone').toContain(podId);
  console.log('  ✓ idempotent join (creator + m1 = 2) + detail aggregates the pod; its event is named only to people who may open it.');

  // (5) Leave decrements exactly once: the owner stays.
  await apiAs(m1, 'POST', `/circles/${circleId}/leave`);
  const detail2 = await apiAs(m1, 'GET', `/circles/${circleId}`);
  expect(detail2.json.data.memberCount).toBe(1);
  expect(detail2.json.data.members.map((m: any) => m.userId)).toEqual([admin.id]);
  console.log('  ✓ leave decrements to 1 (the owner stays).');

  // (6) HEADED — m2 on a phone width joins from the real UI.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: m2.accessToken, r: m2.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}/circles`);

  const card = page.locator(`div.card-hover:has(a[href="/circles/${circleId}"])`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: /^Join$/ }).click();
  await expect(card.getByRole('button', { name: /^Leave$/ })).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ headed: joined from the real card on mobile width.');

  await gotoRetry(page, `${APP}/circles/${circleId}`);
  // The member row links to their profile (the Human Profile on the preview) — unique on the page (the sidebar's
  // own-user chip is a bare /profile link and is hidden on mobile anyway).
  await expect(page.locator(profileLinkSelector(m2.id, 'Circles'))).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('E2E Circle Event')).toBeVisible();
  await page.screenshot({ path: 'test-results/circle-detail.png' }).catch(() => {});
  console.log('  ✓ headed: detail page shows the new member + the upcoming event.');

  // (7) Archive hides it from members but never deletes rows.
  const arch = await apiAs(admin, 'POST', `/circles/${circleId}/archive`);
  expect(arch.status).toBe(200);
  const gone = await apiAs(m1, 'GET', `/circles/${circleId}`);
  expect(gone.status).toBe(404);
  const rows = await pool.query(`SELECT archived_at FROM circles WHERE id = $1`, [circleId]);
  expect(rows.rows[0].archived_at, 'archived, not deleted').not.toBeNull();
  console.log('  ✓ archive hides the circle; the row (and members) survive.');
});
