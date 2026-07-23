import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';

// PROD VERIFICATION — Task F4: the whole truthful loop, one spec (23 Jul 2026).
//
// Chains platform-match-loop.spec.ts (Phase 1: standing match -> poke ->
// accept -> chat unlocked) and intro-scheduling.spec.ts (Phase 2: intro
// seeded as first message -> availability -> confirm) into a single
// sequential journey, PLUS the branch-new behaviors this run must prove:
//
//   F1 — the SENDER's bell gains a `poke_accepted` notification when the
//        recipient accepts (not just the recipient's `poke` notification,
//        which Phase 1 already covered).
//   F3 — every accepted poke opens a >=1-message thread. Already exercised
//        by the intro seed; reasserted here as part of the same run.
//   D/B — the always-on re-onboarding gate (ProtectedRoute, keyed on
//        user.onboardingStatus) redirects ANY user — including admins,
//        deliberately no role exemption — to /onboarding unless
//        onboarding_status = 'completed'. createTestUser() seeds this column
//        as 'completed' by default (see e2e/helpers/auth.ts); the seeding
//        below still sets it explicitly so this spec stays self-describing
//        and immune to a helper-default change.
//   F2 — prod now really sends poke-request / poke-accepted emails. Every
//        seeded user sets notify_email = false so this run never emails a
//        real inbox. The poke send/accept calls succeeding at all with the
//        flag off (both gate branches taken, nothing thrown) is the
//        implicit regression assert for "no crash when suppressed".
//   E  — the admin per-user inspector (Task E3) surfaces the loop as an
//        audit trail: the poke (sent, accepted) on the Interactions tab,
//        the resulting thread on the Conversations tab (row only — opening
//        messages fires an audited DM read, so we don't do that
//        gratuitously here).
//
// REST drives whichever side isn't making the real click that turn; headed
// Chromium proves the actual screens for real. The standing responsive rule
// (mobile-first, no overflow) is asserted with boundingBox-fits-viewport —
// not just visibility — at 390px for the two pieces of fixed UI the brief
// calls out: the /matches card and the bell dropdown.

let browser: Browser;
let founder: TestUser, investor: TestUser, admin: TestUser;
const ctxs: BrowserContext[] = [];
let conversationId = '';

async function apiAs(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/**
 * Seed a test user's intent profile AND pin the two truthful-loop columns:
 *   - onboarding_status: createTestUser() already seeds 'completed' by
 *     default (e2e/helpers/auth.ts), but the D2 re-onboarding gate
 *     (ProtectedRoute) bounces any other value to /onboarding on every
 *     headed nav — pinned explicitly here so this spec never depends on
 *     the helper's default.
 *   - notify_email: defaults TRUE at the DB level, which would fire a real
 *     F2 email to the fake e2etest-*@example.com "recipient" via Resend.
 */
async function seedUser(u: TestUser, cols: Record<string, string | string[]> = {}) {
  const merged: Record<string, string | string[] | boolean> = {
    onboarding_status: 'completed',
    notify_email: false,
    ...cols,
  };
  const keys = Object.keys(merged);
  await pool.query(
    `UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, last_onboarded_at = NOW()
     WHERE id = $1`,
    [u.id, ...keys.map(k => merged[k])],
  );
}

async function openAs(u: TestUser, path: string, viewport = { width: 390, height: 844 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

const dayKey = (offsetDays: number, part: string) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}:${part}`;
};

/** boundingBox-fits-viewport, not just visible — the standing responsive
 *  rule: fixed/floating UI must never overflow the frame it renders in. */
async function assertFitsViewport(locator: ReturnType<Page['locator']>, viewportWidth: number, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} must have a bounding box`).toBeTruthy();
  expect(box!.x, `${label} must not start off-screen`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label} must fit within the ${viewportWidth}px viewport`).toBeLessThanOrEqual(viewportWidth);
}

test.beforeAll(async () => {
  founder = await createTestUser('tlfounder');
  investor = await createTestUser('tlinvestor');
  admin = await createTestUser('tladmin', 'admin');

  // Same guaranteed-fit seed as platform-match-loop.spec.ts: a designation
  // hit alone (score += 0.6) clears MATCH_THRESHOLD (0.45) regardless of
  // term overlap, so this pair matches deterministically every run.
  await seedUser(founder, {
    professional_role: ['Founder'],
    who_i_want_to_meet: 'investors and angels for my seed round',
    my_intent: 'raise funding for my SaaS startup',
  });
  await seedUser(investor, {
    professional_role: ['Angel Investor'],
    expertise_text: 'early stage SaaS investing',
  });
  // Nothing matching-related for the admin, but it IS still subject to the
  // always-on re-onboarding gate ("no role exemption, admins go through
  // onboarding too") when it opens /admin/users/:id headed below.
  await seedUser(admin);

  browser = await chromium.launch({ headless: false });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  const ids = [founder?.id, investor?.id, admin?.id].filter(Boolean);
  // user_pokes / dm_conversations / direct_messages / notifications all
  // FK-cascade from users, but delete explicitly first (same convention as
  // platform-match-loop.spec.ts / intro-scheduling.spec.ts) so a mid-run
  // failure still leaves a clean DB even if cleanup() below never runs.
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`, [ids]).catch(() => {});
  await pool.query(`DELETE FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`, [ids]).catch(() => {});
  await cleanup(pool, { ids }); // also sweeps notifications + audit_log by id
});

test('the whole truthful loop: match -> poke -> poke_accepted bell -> thread -> confirmed meeting -> admin inspector', async () => {
  test.setTimeout(420_000);

  // ── (1) A sees B on /matches with a human-readable reason ─────────────────
  const f1 = await apiAs(founder, 'GET', '/matches/platform');
  expect(f1.status).toBe(200);
  const suggested = f1.json.data.matches.map((m: any) => m.userId);
  expect(suggested, 'founder must be shown the investor').toContain(investor.id);
  const card = f1.json.data.matches.find((m: any) => m.userId === investor.id);
  expect(card.reason).toMatch(/investor/i);
  console.log(`  ✓ (1) founder sees investor. reason: "${card.reason}"`);

  const fPage = await openAs(founder, '/matches');
  // Scope to OUR investor's card — the founder's real list also contains
  // real prod members who happen to fit "investor" (platform-match-loop's
  // hard-won lesson: never .first() here, or an intro goes to a stranger).
  const investorCard = fPage.locator(`div.card-hover:has(a[href="/profile/${investor.id}"])`);
  await expect(investorCard).toBeVisible({ timeout: 20_000 });
  await expect(investorCard.getByText(card.reason)).toBeVisible();
  const meetBtn = investorCard.getByRole('button', { name: /I want to meet/i });
  await expect(meetBtn).toBeVisible();
  // (7) outcome-assert — the card itself must fit the 390px frame, not just render.
  await assertFitsViewport(investorCard, 390, '/matches card');
  await fPage.screenshot({ path: 'test-results/tl-matches-card.png' }).catch(() => {});
  console.log('  ✓ (1) headed: match card renders + fits the 390px viewport.');

  // ── (2) "I want to meet" -> B's bell shows the poke notification ─────────
  await meetBtn.click();
  await expect(investorCard.getByText(/Introduction requested/i)).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ (2) headed: "I want to meet" -> Introduction requested.');

  const bInbox = await apiAs(investor, 'GET', '/notifications');
  expect(bInbox.status).toBe(200);
  const pokeNotif = bInbox.json.data.notifications.find((n: any) => n.type === 'poke');
  expect(pokeNotif, 'investor must have a poke bell notification').toBeTruthy();
  expect(pokeNotif.title).toContain(founder.displayName);
  console.log(`  ✓ (2) investor's bell (API): "${pokeNotif.title}"`);

  const bPage = await openAs(investor, '/');
  // Two NotificationBell instances exist in the DOM (desktop aside + mobile
  // header); only one is visible per viewport (Tailwind `hidden md:flex` /
  // `md:hidden`) — `:visible` picks the one actually on screen at 390px.
  const bBell = bPage.locator('button:has(.lucide-bell):visible').first();
  await bBell.click();
  await expect(bPage.getByText(pokeNotif.title, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  // (7) outcome-assert — the dropdown panel (h3's grandparent — the actual
  // floating card, not just its header row) must sit inside the frame.
  const bPanel = bPage.locator('h3:has-text("Notifications")').locator('xpath=..').locator('xpath=..');
  await assertFitsViewport(bPanel, 390, 'bell dropdown (investor)');
  await bPage.screenshot({ path: 'test-results/tl-bell-poke.png' }).catch(() => {});
  console.log('  ✓ (2) headed: investor bell shows the poke, dropdown fits the 390px viewport.');

  // ── (3) B accepts -> A's bell gains poke_accepted (NEW, Task F1) ─────────
  const inbox = await apiAs(investor, 'GET', '/pokes/received');
  const poke = inbox.json.data.find((p: any) => p.senderId === founder.id);
  expect(poke, 'investor must have the pending introduction').toBeTruthy();
  expect(poke.message).toMatch(/should meet/i);

  const accept = await apiAs(investor, 'POST', `/pokes/${poke.id}/accept`);
  expect(accept.status).toBe(200);
  conversationId = accept.json.data.conversationId;
  expect(conversationId, 'accept must open a conversation').toBeTruthy();
  console.log('  ✓ (3) investor accepted -> conversation:', conversationId);

  const aInbox = await apiAs(founder, 'GET', '/notifications');
  expect(aInbox.status).toBe(200);
  const acceptedNotif = aInbox.json.data.notifications.find((n: any) => n.type === 'poke_accepted');
  expect(acceptedNotif, 'founder must gain a poke_accepted notification (Task F1)').toBeTruthy();
  expect(acceptedNotif.title).toContain(investor.displayName);
  console.log(`  ✓ (3) founder's bell (NEW, API): "${acceptedNotif.title}"`);

  await gotoRetry(fPage, `${APP}/`);
  const fBell = fPage.locator('button:has(.lucide-bell):visible').first();
  await fBell.click();
  await expect(fPage.getByText(acceptedNotif.title, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  const fPanel = fPage.locator('h3:has-text("Notifications")').locator('xpath=..').locator('xpath=..');
  await assertFitsViewport(fPanel, 390, 'bell dropdown (founder, poke_accepted)');
  await fPage.screenshot({ path: 'test-results/tl-bell-poke-accepted.png' }).catch(() => {});
  console.log('  ✓ (3) headed: founder bell shows poke_accepted, dropdown fits the 390px viewport.');

  // ── (4) The conversation has the intro as (at least) its first message ──
  const msgs = await apiAs(investor, 'GET', `/dm/conversations/${conversationId}/messages`);
  expect(msgs.status).toBe(200);
  const list = msgs.json.data?.messages ?? msgs.json.data ?? [];
  expect(list.length, 'thread must have >=1 message even though the poke carried one (Task F3)').toBeGreaterThanOrEqual(1);
  const introMsg = list.find((m: any) => /should meet/i.test(m.content));
  expect(introMsg, 'the introduction must be seeded as a real thread message').toBeTruthy();
  console.log(`  ✓ (4) thread seeded: "${introMsg.content.slice(0, 60)}..."`);

  // ── (5) Both pick overlapping windows -> confirm -> pinned + notified ───
  // (trimmed from intro-scheduling.spec.ts: skips its one-sided-window
  // 400 negative-case check, which belongs to that file, not this journey)
  const W_OVERLAP = dayKey(2, 'evening');
  const invSet = await apiAs(investor, 'PUT', `/dm/conversations/${conversationId}/scheduling/availability`,
    { windows: [W_OVERLAP, dayKey(4, 'morning')] });
  expect(invSet.status).toBe(200);
  const fSet = await apiAs(founder, 'PUT', `/dm/conversations/${conversationId}/scheduling/availability`,
    { windows: [W_OVERLAP, dayKey(3, 'morning')] });
  expect(fSet.status).toBe(200);
  expect(fSet.json.data.overlap).toEqual([W_OVERLAP]);
  console.log('  ✓ (5) both sides set availability — overlap:', fSet.json.data.overlap);

  await gotoRetry(fPage, `${APP}/messages/${conversationId}`);
  await fPage.getByRole('button', { name: /Find a time to meet/i }).click();
  await expect(fPage.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 10_000 });
  await expect(fPage.getByText('Both can').first()).toBeVisible({ timeout: 10_000 });
  await fPage.getByRole('button', { name: /^Confirm / }).first().click();
  await expect(fPage.getByText(/Meeting confirmed:/i).first()).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ (5) headed: founder confirmed the overlap in the real scheduler.');

  const conv = await pool.query(
    `SELECT meeting_confirmed_window, meeting_confirmed_by FROM dm_conversations WHERE id = $1`, [conversationId]);
  expect(conv.rows[0].meeting_confirmed_window).toBe(W_OVERLAP);
  expect(conv.rows[0].meeting_confirmed_by).toBe(founder.id);
  const meetingNotif = await pool.query(
    `SELECT id FROM notifications WHERE user_id = $1 AND type = 'meeting_confirmed'`, [investor.id]);
  expect(meetingNotif.rows.length).toBeGreaterThanOrEqual(1);
  console.log('  ✓ (5) conversation pinned + investor got the meeting_confirmed notification.');

  // ── (6) Admin inspector: Interactions shows the poke, Conversations lists the thread ──
  const adminPage = await openAs(admin, `/admin/users/${founder.id}`, { width: 1280, height: 900 });
  await adminPage.getByRole('button', { name: 'Reports & Interactions' }).click();
  const pokesSentSection = adminPage.locator('h3:has-text("Pokes sent")').locator('xpath=..');
  await expect(pokesSentSection.getByText(investor.displayName)).toBeVisible({ timeout: 15_000 });
  await expect(pokesSentSection.getByText('accepted', { exact: true })).toBeVisible();
  console.log('  ✓ (6) admin Interactions tab: poke to investor shows status accepted.');

  await adminPage.getByRole('button', { name: 'Conversations' }).click();
  await expect(adminPage.getByText('Access is audit logged.')).toBeVisible();
  // Row assertion only — do NOT click into it. Opening it fires an audited
  // DM read (INSERT INTO audit_log before the messages are returned) we
  // have no reason to generate for this run.
  await expect(adminPage.getByText(investor.displayName)).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ (6) admin Conversations tab: A-B thread listed (not opened — audit-log noise kept to a minimum).');

  console.log('  ✓ full truthful loop verified: match -> poke -> poke_accepted bell -> thread -> confirmed meeting -> admin inspector.');
});
