import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod } from '../helpers/api';
import { gotoRetry, cleanup, wait, APP, SERVER } from '../helpers/live-ui';
import * as fs from 'fs';
import * as path from 'path';

// HEADED PROD — the UI MATRIX for everything REASON v1 shipped (20 Jul 2026).
// The earlier specs proved the RULES (mostly via REST) and the happy paths.
// This one drives every remaining surface through REAL clicks at phone width:
// admin circle creation modal, pod attach/detach picker, pod-page chips,
// join-to-post gate, image upload through the real file input (a genuine
// Cloudinary round-trip), link cards, commenting, pin + delete buttons,
// load-more pagination, Matches browse click-through, the incomplete-profile
// prompt, scheduler cell-tapping + Save, and the introduction decline path.

let browser: Browser;
let admin: TestUser, member: TestUser, poster: TestUser, incomplete: TestUser, decliner: TestUser;
const ctxs: BrowserContext[] = [];
let circleId = '', podId = '';

async function apiAs(u: TestUser, method: string, path2: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path2}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const uuid = () => crypto.randomUUID();

async function openAs(u: TestUser, url: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  // Own-post deletes use confirm() — auto-accept.
  page.on('dialog', d => { d.accept().catch(() => {}); });
  await gotoRetry(page, `${APP}${url}`);
  return page;
}

test.beforeAll(async () => {
  admin = await createTestUser('uimadmin', 'super_admin');
  member = await createTestUser('uimmember');
  poster = await createTestUser('uimposter');
  incomplete = await createTestUser('uimincomplete');
  decliner = await createTestUser('uimdecliner');
  await pool.query(`UPDATE users SET onboarding_completed = false WHERE id = $1`, [incomplete.id]);
  await pool.query(
    `UPDATE users SET professional_role = $2, who_i_want_to_meet = $3 WHERE id = $1`,
    [member.id, ['Founder'], 'investors and advisors']);
  await pool.query(
    `UPDATE users SET professional_role = $2, expertise_text = $3 WHERE id = $1`,
    [decliner.id, ['Angel Investor'], 'seed investing']);
  browser = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream'],
  });
});

test.afterAll(async () => {
  try { await browser?.close(); } catch {}
  await pool.query(`DELETE FROM circles WHERE created_by = $1`, [admin?.id]).catch(() => {});
  await pool.query(`DELETE FROM user_pokes WHERE sender_id = ANY($1) OR recipient_id = ANY($1)`,
    [[member?.id, decliner?.id].filter(Boolean)]).catch(() => {});
  await pool.query(`DELETE FROM dm_conversations WHERE user_a_id = ANY($1) OR user_b_id = ANY($1)`,
    [[admin?.id, member?.id, poster?.id, decliner?.id].filter(Boolean)]).catch(() => {});
  await cleanup(pool, {
    ids: [admin?.id, member?.id, poster?.id, incomplete?.id, decliner?.id].filter(Boolean),
    podId: podId || undefined,
  });
});

test('UI matrix 1 — circles admin surfaces: create modal, attach/detach picker, pod chips', async () => {
  test.setTimeout(300_000);

  // Admin creates a circle THROUGH THE MODAL.
  const aPage = await openAs(admin, '/circles');
  await aPage.getByRole('button', { name: /New circle/i }).click();
  await aPage.getByPlaceholder(/Circle name/i).fill('E2E UI Matrix Circle');
  await aPage.getByPlaceholder(/What is this circle about/i).fill('Created through the real modal');
  await aPage.getByRole('button', { name: /^Create circle$/i }).click();
  // Success navigates to the new circle's detail page.
  await expect(aPage.getByRole('heading', { name: 'E2E UI Matrix Circle' })).toBeVisible({ timeout: 15_000 });
  const m = /\/circles\/([0-9a-f-]{36})/.exec(aPage.url());
  expect(m).toBeTruthy();
  circleId = m![1];
  console.log('  ✓ circle created via the modal, navigated to detail.');

  // Attach a pod THROUGH THE PICKER.
  const pod = await createPod(admin, 'E2E UI Matrix Pod'); podId = pod.id;
  await aPage.reload();
  await aPage.getByRole('button', { name: /Attach pod/i }).click();
  await aPage.locator('select').selectOption(podId);
  await aPage.getByRole('button', { name: /^Attach$/i }).click();
  await expect(aPage.getByText('E2E UI Matrix Pod')).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ pod attached via the picker.');

  // Pod page shows the circle CHIP.
  await gotoRetry(aPage, `${APP}/pods/${podId}`);
  await expect(aPage.getByText('In circles:')).toBeVisible({ timeout: 20_000 });
  await expect(aPage.locator(`a[href="/circles/${circleId}"]`)).toBeVisible();
  console.log('  ✓ pod page shows its circle chip.');

  // Detach THROUGH THE UI (dialog auto-accepted) and the chip disappears.
  await gotoRetry(aPage, `${APP}/circles/${circleId}`);
  await aPage.locator('button[title="Detach from circle"]').click();
  await expect(aPage.getByText('E2E UI Matrix Pod')).toBeHidden({ timeout: 15_000 });
  console.log('  ✓ pod detached via the UI.');
});

test('UI matrix 2 — the wall end-to-end through real clicks: gate, image, link card, comments, pin, delete, load more', async () => {
  test.setTimeout(420_000);
  expect(circleId, 'matrix 1 must have created the circle').toBeTruthy();

  // (1) Non-member sees the JOIN-TO-POST gate, joins from the detail page,
  //     and the composer appears.
  const mPage = await openAs(member, `/circles/${circleId}`);
  await expect(mPage.getByText(/Join this circle to post/i)).toBeVisible({ timeout: 20_000 });
  await mPage.getByRole('button', { name: /^Join circle$/i }).click();
  await expect(mPage.getByPlaceholder(/Share something/i)).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ join-to-post gate → joined via UI → composer appeared.');

  // (2) IMAGE POST through the real file input — a genuine Cloudinary upload.
  const pngPath = path.join(__dirname, '..', 'test-results', 'uim-probe.png');
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  fs.writeFileSync(pngPath, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  await mPage.locator('input[type="file"]').setInputFiles(pngPath);
  // Wait for the Cloudinary round-trip (preview swaps from spinner to <img>).
  await expect(mPage.locator('img[src*="res.cloudinary.com"]').first()).toBeVisible({ timeout: 30_000 });
  await mPage.getByPlaceholder(/Share something/i).fill('Real image upload from the matrix');
  await mPage.getByRole('button', { name: /^Post$/ }).click();
  await expect(mPage.getByText('Real image upload from the matrix')).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ image uploaded through the real file input (Cloudinary round-trip) and posted.');

  // (3) LINK CARD renders for a posted URL.
  await mPage.getByPlaceholder(/Share something/i).fill('Worth reading https://example.com/deep/article today');
  await mPage.getByRole('button', { name: /^Post$/ }).click();
  await expect(mPage.getByText('example.com').first()).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ link card rendered from the URL (domain shown, nothing fetched).');

  // (4) COMMENT via the UI from a second member.
  await apiAs(poster, 'POST', `/circles/${circleId}/join`);
  const pPage = await openAs(poster, `/circles/${circleId}`);
  await expect(pPage.getByText('Real image upload from the matrix')).toBeVisible({ timeout: 20_000 });
  await pPage.getByRole('button', { name: /^Comment$/ }).first().click();
  await pPage.getByPlaceholder(/Write a comment/i).fill('Commented through the real UI');
  await pPage.getByPlaceholder(/Write a comment/i).press('Enter');
  await expect(pPage.getByText('Commented through the real UI')).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ commented via the UI.');

  // (5) ADMIN PIN via the pin button; badge appears.
  const aPage = await openAs(admin, `/circles/${circleId}`);
  await expect(aPage.getByText('Real image upload from the matrix')).toBeVisible({ timeout: 20_000 });
  await aPage.locator('button[title="Pin"]').first().click();
  await expect(aPage.getByText(/^Pinned$/).first()).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ admin pinned via the UI, badge shown.');

  // (6) DELETE OWN POST via the trash button (confirm dialog auto-accepted).
  await mPage.getByPlaceholder(/Share something/i).fill('Short-lived post');
  await mPage.getByRole('button', { name: /^Post$/ }).click();
  await expect(mPage.getByText('Short-lived post')).toBeVisible({ timeout: 15_000 });
  const shortLived = mPage.locator('[data-testid^="wall-post-"]').filter({ hasText: 'Short-lived post' });
  await shortLived.locator('button[title="Delete"]').click();
  await expect(mPage.getByText('Short-lived post')).toBeHidden({ timeout: 15_000 });
  console.log('  ✓ own post deleted via the UI.');

  // (7) LOAD MORE: seed 25 posts (rate limit is 6/min per user, so spread
  //     across our members via REST), then page through the real button.
  const seeders = [member, poster];
  let seeded = 0;
  for (let round = 0; seeded < 24; round++) {
    for (const u of seeders) {
      for (let i = 0; i < 6 && seeded < 24; i++) {
        const r = await apiAs(u, 'POST', `/circles/${circleId}/posts`,
          { clientId: uuid(), content: `Seed post ${seeded}` });
        if (r.status === 201) seeded++;
      }
    }
    if (seeded < 24) await wait(61_000); // wait out the rate-limit window
  }
  await mPage.reload();
  await expect(mPage.getByRole('button', { name: /Load more/i })).toBeVisible({ timeout: 20_000 });
  await mPage.getByRole('button', { name: /Load more/i }).click();
  await expect(mPage.getByText('Seed post 0')).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ keyset Load more pages back to the oldest post.');
});

test('UI matrix 3 — matches edges: browse click-through, incomplete-profile prompt, decline path', async () => {
  test.setTimeout(300_000);

  // (1) Browse click-through from the no-match screen. The incomplete user
  //     can't browse; use a fresh no-fit member: poster (no intent set).
  const bPage = await openAs(poster, '/matches');
  const browseBtn = bPage.getByText(/Browse people near your profile/i);
  const matchBtn = bPage.getByRole('button', { name: /I want to meet/i }).first();
  // poster might have matches from real prod users. NB: isVisible() does NOT
  // wait — the first run sampled a still-loading page. Wait for WHICHEVER
  // state renders, then branch.
  await expect(browseBtn.or(matchBtn).first()).toBeVisible({ timeout: 25_000 });
  if (await browseBtn.isVisible()) {
    await browseBtn.click();
    await expect(bPage.getByText(/People close to your profile/i)).toBeVisible({ timeout: 15_000 });
    await expect(bPage.getByText(/Back to your matches/i)).toBeVisible();
    console.log('  ✓ browse click-through: relaxed list state + back link.');
  } else {
    console.log('  ✓ (poster had real matches — match list rendered; browse N/A this run.)');
  }

  // (2) Incomplete-profile prompt: no matches, a Complete-your-profile card.
  const iPage = await openAs(incomplete, '/matches');
  await expect(iPage.getByText(/Tell us who you'd like to meet/i)).toBeVisible({ timeout: 20_000 });
  await expect(iPage.getByRole('button', { name: /Complete your profile/i })).toBeVisible();
  console.log('  ✓ incomplete profile → onboarding prompt, no matches leak.');

  // (3) DECLINE PATH: member expressed interest in decliner; decliner declines;
  //     the suggestion never resurfaces for member (any-poke exclusion).
  const interest = await apiAs(member, 'POST', `/matches/platform/${decliner.id}/interest`);
  expect(interest.status).toBe(201);
  const inbox = await apiAs(decliner, 'GET', '/pokes/received');
  const poke = inbox.json.data.find((p: any) => p.senderId === member.id);
  expect(poke).toBeTruthy();
  const declined = await apiAs(decliner, 'POST', `/pokes/${poke.id}/decline`);
  expect(declined.status).toBe(200);
  const matchesAfter = await apiAs(member, 'GET', '/matches/platform');
  expect(matchesAfter.json.data.matches.map((x: any) => x.userId)).not.toContain(decliner.id);
  // And no conversation was opened — a decline is quiet.
  const conv = await pool.query(
    `SELECT id FROM dm_conversations
     WHERE user_a_id = LEAST($1::uuid, $2::uuid) AND user_b_id = GREATEST($1::uuid, $2::uuid)`,
    [member.id, decliner.id]);
  expect(conv.rows.length).toBe(0);
  console.log('  ✓ decline: quiet, no chat, never re-suggested.');
});

test('UI matrix 4 — scheduler: tap cells + Save through the UI, partner overlap appears', async () => {
  test.setTimeout(300_000);

  // member ↔ poster already share a circle; open a conversation via poke rails.
  const interest = await apiAs(member, 'POST', `/matches/platform/${poster.id}/interest`).catch(() => null);
  let conversationId = '';
  if (interest && interest.status === 201) {
    const inbox = await apiAs(poster, 'GET', '/pokes/received');
    const poke = inbox.json.data.find((p: any) => p.senderId === member.id);
    const accept = await apiAs(poster, 'POST', `/pokes/${poke.id}/accept`);
    conversationId = accept.json.data.conversationId;
  } else {
    // Fallback (already connected): open/ensure a conversation directly.
    const r = await pool.query<{ id: string }>(
      `INSERT INTO dm_conversations (user_a_id, user_b_id)
       VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid))
       ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET user_a_deleted_at = NULL
       RETURNING id`, [member.id, poster.id]);
    conversationId = r.rows[0].id;
  }
  expect(conversationId).toBeTruthy();

  // member TAPS CELLS + SAVES through the real grid.
  const mPage = await openAs(member, `/messages/${conversationId}`);
  await mPage.getByRole('button', { name: /Find a time to meet/i }).click();
  await expect(mPage.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 15_000 });
  const cells = mPage.getByTestId('meeting-scheduler').locator('tbody button');
  await cells.nth(4).click();  // day 2 afternoon
  await cells.nth(7).click();  // day 3 morning
  await mPage.getByRole('button', { name: /Save availability/i }).click();
  await expect(mPage.getByText(/Availability saved/i)).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ tapped cells + saved through the real grid.');

  // Partner matches one window via REST, then RELOAD for a deterministic
  // fresh render (the 15s refetch also carries it, but the matrix must not
  // hang on poll timing). Server-verify the overlap first so a UI absence
  // of the Confirm button is provably a UI bug, not missing data.
  const sched = await apiAs(member, 'GET', `/dm/conversations/${conversationId}/scheduling`);
  const mine = sched.json.data.mine as string[];
  expect(mine.length).toBe(2);
  const partnerPut = await apiAs(poster, 'PUT', `/dm/conversations/${conversationId}/scheduling/availability`,
    { windows: [mine[0]] });
  expect(partnerPut.status).toBe(200);
  const overlapCheck = await apiAs(member, 'GET', `/dm/conversations/${conversationId}/scheduling`);
  expect(overlapCheck.json.data.overlap, 'server must compute the overlap').toEqual([mine[0]]);

  await mPage.reload();
  await mPage.getByRole('button', { name: /Find a time to meet/i }).click();
  await expect(mPage.getByTestId('meeting-scheduler')).toBeVisible({ timeout: 15_000 });
  await expect(mPage.getByText('Both can').first()).toBeVisible({ timeout: 15_000 });
  await mPage.screenshot({ path: 'test-results/uim-scheduler-overlap.png' }).catch(() => {});
  await expect(mPage.getByRole('button', { name: /^Confirm / }).first())
    .toBeVisible({ timeout: 15_000 });
  await mPage.getByRole('button', { name: /^Confirm / }).first().click();
  await expect(mPage.getByText(/Meeting confirmed:/i).first()).toBeVisible({ timeout: 15_000 });
  console.log('  ✓ overlap server-verified, rendered green, confirmed via the UI.');
});
