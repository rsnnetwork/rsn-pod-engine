// e2e/tests/script-e-30oct.spec.ts
//
// SCRIPT E: ONE WALK OVER EVERY 30 OCT ITEM (T19, 2 Nov 2026), headed, against the preview (the controller's pass) or
// the local stack. "RSN Preview – Fixes for Ali (from 30 Oct review)" has 40 rows (workspace/audits/2026-11-01-
// feedback-30oct/CHECKLIST.md). Each test below walks one group of rows; each row is a test.step named by its row id,
// and for each row the walk:
//   - asserts what a person sees, not only that a page loads;
//   - watches a SECOND browser (another context, signed in as the other person, or as the same person on another
//     device) change without a reload (Review Focus 4);
//   - on the new surfaces, drives a removed, closed or blocked member through it and asserts they are refused or
//     absent: the Message button, the call, the invite sheet, circle and entity member lists, the notifications page
//     (Review Focus 3).
// The legacy shapes production holds each have a throwaway twin here (Review Focus 2): a pending request with REASON's
// line appended to the note, an event with no visibility, a circle whose creator has no membership row, members without
// a location or the new onboarding, and a Google photo at 96px.
//
// The flows are the n1-* specs' (each row names its spec); this walk does them once, together, on the same members.
// Steps that need a real LiveKit room (the call's Leave, the meeting room's video) are skipped on the local stack and in
// WebKit, with the reason, and run on the preview in Chromium.
//
// Throwaway members only (<id>@rsn-e2e.invalid, which can never receive mail), created through createTestUser; every
// row the walk makes is deleted by id in afterAll, and the teardown fails if an account survives. One engine per process:
//   locally          bash /c/dev/_m1-local/oct21/run-local-spec.sh <worktree> <ui-port> <api-port> tests/script-e-30oct.spec.ts
//   on the preview   bash /c/dev/_m1-local/run-stable.sh tests/script-e-30oct.spec.ts <chromium|webkit> ["iPhone 14"]
//   E2E_WIDTH=768 or 1024 for a tablet width; E2E_SHOTS_DIR to keep screenshots.

import { test, expect, type Browser, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import * as fs from 'fs';
import {
  APP, DEVICE, LOCAL, ROOMS, ROOM_SKIP, RUN, RUN_WIDTH, api, skipStep, bellCount, cleanupRun, connect, createCircle,
  drag, expectNotReloaded, gotoRetry, halves, roomLogsAtDebug, watchRoom, closeBrowsers, launch, made, markNotReloaded, noSidewaysScroll, openAs,
  openSignedOut, pictureSize, pinch, pool, scrollClear, seedPod, shot, tall, throwaway, where, type TestUser,
} from '../helpers/sweep';
import { acceptConfirmDialogs } from '../helpers/confirm-dialog';


const SECRET = (process.env.E2E_JWT_SECRET || process.env.JWT_SECRET || '').replace(/\r|\n/g, '');
const LIVE = 25_000;
const SLOW = 60_000;
const WELCOME = "Answer a few quick questions and we'll suggest potential mutuals for you.";
const NO_PASSWORD = "No password needed — we'll email you a link and a code.";
const ANSWERS = {
  lookingToMeet: ['meet_investors'], hopingToFind: ['find_funding'],
  canOffer: ['offer_advice_mentoring'], selfKinds: ['self_founder_owner'],
};

let browser: Browser;
// The people most rows share. Ana and Bo are connected; Cy is a stranger to everyone; Rex was Ana's and Bo's
// connection and is now removed (closed by an admin); Kit is Bo's connection whom Bo has blocked.
let admin: TestUser, ana: TestUser, bo: TestUser, cy: TestUser, rex: TestUser, kit: TestUser;
let convAB = '';
let convAnaRex = '';

const phone = () => RUN_WIDTH < 721;

test.beforeAll(async () => {
  expect(SECRET, 'E2E_JWT_SECRET (or JWT_SECRET) signs the throwaway accounts').toBeTruthy();
  browser = await launch();
  admin = await throwaway('Adam', { role: 'admin' });
  ana = await throwaway('Ana');
  bo = await throwaway('Bo');
  cy = await throwaway('Cy');
  rex = await throwaway('Rex');
  kit = await throwaway('Kit');
  convAB = await connect(ana, bo, `Hello Bo ${RUN}`);
  convAnaRex = await connect(rex, ana, `An old hello from Rex ${RUN}`);
  const convBoRex = await connect(rex, bo, `Rex to Bo ${RUN}`);
  const convBoKit = await connect(kit, bo, `Kit to Bo ${RUN}`);
  for (const [u, c] of [[ana, convAB], [bo, convAB], [ana, convAnaRex], [bo, convBoRex], [bo, convBoKit]] as const) {
    await api(u, 'POST', `/dm/conversations/${c}/read`);
  }
  // Rex is removed the way an admin removes (status deactivated); Bo blocks Kit.
  expect((await api(bo, 'POST', `/users/${kit.id}/block`, {})).status).toBeLessThan(300);
  await pool.query(`UPDATE users SET status = 'deactivated' WHERE id = $1`, [rex.id]);
  console.log(`[script-e] ${where()} app=${APP} local=${LOCAL} rooms=${ROOMS}`);
});

// Each test's browsers are closed when it ends: a later test (the call's room above all) never shares the machine with
// the pages of the tests before it.
test.afterEach(async () => {
  await closeBrowsers();
});

test.afterAll(async () => {
  await cleanupRun();
  await browser?.close().catch(() => undefined);
});

// ═══ 1. Profile ═════════════════════════════════════════════════════════════════════════════════════════════════

test('1.1, 1.3: the pencils place a photo and a banner, stored large, and a pod member sees the photo at once; an old 96px Google photo still shows', async () => {
  test.setTimeout(300_000);
  const podId = await seedPod(ana, `${RUN} Profile pod`, [bo]);
  const watcher = await openAs(browser, bo, `/pods/${podId}`);
  const podMembers = watcher.page.locator('#pod-members');
  await expect(podMembers.getByText(ana.displayName)).toBeVisible({ timeout: SLOW });
  await markNotReloaded(watcher.page);

  const me = await openAs(browser, ana, '/profile');
  await expect(me.page.getByRole('heading', { level: 1, name: ana.displayName })).toBeVisible({ timeout: SLOW });

  await test.step('1.1 the photo: pencil, place (zoom, pinch, drag), save; Bo\'s open pod page shows it without a reload', async () => {
    const pencil = me.page.getByRole('button', { name: 'Edit photo' });
    await tall(pencil, 'the photo pencil');
    await pencil.click();
    const sheet = me.page.getByRole('dialog', { name: 'Edit your photo' });
    await expect(sheet.getByText('No photo yet. Choose a picture to place it.')).toBeVisible({ timeout: 30_000 });
    await sheet.locator('input[type="file"]').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await halves(me.page, 2400, 1800) });
    const zoom = sheet.getByRole('slider', { name: 'Zoom' });
    await expect(zoom).toBeVisible({ timeout: 20_000 });
    await sheet.getByRole('button', { name: 'Zoom in' }).click();
    const plus = Number(await zoom.inputValue());
    expect(plus).toBeGreaterThan(1);
    await pinch(sheet.getByTestId('picture-frame'));
    await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(plus + 0.5);
    // Back to the whole height, so the stored square is the full 1024 (1.3); placed by a drag.
    await zoom.fill('1');
    await drag(me.page, sheet.getByTestId('picture-frame'), -300, 0);
    await noSidewaysScroll(me.page, 'the photo editor');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(me.page.getByText('Your photo is updated.')).toBeVisible({ timeout: 30_000 });
    const url = (await pool.query<{ avatar_url: string }>('SELECT avatar_url FROM users WHERE id = $1', [ana.id])).rows[0].avatar_url;
    expect(url).toMatch(new RegExp(`/api/users/${ana.id}/avatar\\?v=\\d+$`));
    await expect(me.page.locator(`img[src="${url}"]:visible`).first()).toBeVisible({ timeout: LIVE });
    await expect(podMembers.locator(`img[src*="/api/users/${ana.id}/avatar"]`).first(), 'Bo\'s pod page, never reloaded').toBeVisible({ timeout: LIVE });
    await expectNotReloaded(watcher.page, 'Bo\'s pod page');
    await shot(me.page, 'e-1.1-photo');

    await test.step('1.3 the photo is stored as a 1024 square from the original', async () => {
      expect(await pictureSize(me.page, url)).toEqual({ width: 1024, height: 1024 });
    });
  });

  await test.step('1.1 the banner: pencil, place, save; stored at 2400 by 800', async () => {
    const banner = me.page.getByTestId('profile-banner');
    await me.page.getByRole('button', { name: 'Add banner' }).click();
    const sheet = me.page.getByRole('dialog', { name: 'Edit your banner' });
    await sheet.locator('input[type="file"]').setInputFiles({ name: 'wide.jpg', mimeType: 'image/jpeg', buffer: await halves(me.page, 3000, 1500) });
    await expect(sheet.getByRole('slider', { name: 'Zoom' })).toBeVisible({ timeout: 20_000 });
    await drag(me.page, sheet.getByTestId('picture-frame'), 0, -150);
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(me.page.getByText('Your banner is updated.')).toBeVisible({ timeout: 30_000 });
    const img = banner.locator('img');
    await expect(img).toHaveAttribute('src', new RegExp(`/api/users/${ana.id}/banner\\?v=\\d+$`), { timeout: LIVE });
    expect(await pictureSize(me.page, (await img.getAttribute('src'))!)).toEqual({ width: 2400, height: 800 });
    await noSidewaysScroll(me.page, 'the profile with a photo and a banner');
  });

  await test.step('1.3 legacy: a member whose Google photo is the old 96px address still has a profile that draws', async () => {
    const old = await throwaway('Gus', { set: { avatar_url: `https://lh3.googleusercontent.com/a/ACg8ocT19${RUN}=s96-c` } });
    await gotoRetry(watcher.page, `${APP}/people/${old.id}`);
    await expect(watcher.page.getByRole('heading', { level: 1, name: old.displayName })).toBeVisible({ timeout: SLOW });
    await noSidewaysScroll(watcher.page, 'a profile with a 96px Google photo');
  });
});

// ═══ 1.2 and 2. Location and onboarding ═════════════════════════════════════════════════════════════════════════

test('1.2, 2.1, 2.2: an earlier-onboarding member is taken through the new onboarding, words for word, and must say where they are based; their other browser follows', async () => {
  test.setTimeout(300_000);
  const olga = await throwaway('Olga', { onboarding: 'old', set: { looking_to_meet: ['investors'] } });
  const first = await openAs(browser, olga, '/connections');
  const second = await openAs(browser, olga, '/');

  await test.step('2.1 mandatory: both browsers are taken to the new onboarding at sign-in', async () => {
    for (const [p, to] of [[first.page, '%2Fconnections'], [second.page, '']] as const) {
      await expect.poll(() => new URL(p.url()).pathname + new URL(p.url()).search, { timeout: SLOW }).toMatch(new RegExp(`^/onboarding${to ? `\\?(.*&)?redirect=${to}` : ''}`));
      await expect(p.getByRole('heading', { name: "Welcome to REASON. We're glad you're here." })).toBeVisible({ timeout: SLOW });
      await expect(p.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    }
    await markNotReloaded(second.page);
  });

  await test.step('2.2 the welcome text, word for word', async () => {
    await expect(first.page.getByText(WELCOME, { exact: true })).toBeVisible();
    await expect(first.page.locator('body')).not.toContainText(/\bRSN\b/);
    await shot(first.page, 'e-2.2-welcome');
  });

  await test.step('1.2 screen 7 refuses no place and a bare country, then takes a city', async () => {
    expect((await api(olga, 'PUT', '/onboarding/v2/answers', { ...ANSWERS, step: 'profile' })).status).toBe(200);
    await gotoRetry(first.page, `${APP}/onboarding?step=profile&redirect=%2Fconnections`);
    const field = first.page.getByLabel('Where are you based?', { exact: true });
    await expect(field).toBeVisible({ timeout: SLOW });
    await expect(field).toHaveValue('');
    const go = first.page.getByRole('button', { name: 'Show me my matches' });
    await go.click();
    await expect(first.page.getByText('Please add your city and country.', { exact: true })).toBeVisible();
    await field.fill('USA');
    await expect(first.page.getByText('Add your city too', { exact: true })).toBeVisible();
    await go.click();
    await expect(first.page.getByRole('alert').filter({ hasText: 'Add your city too' })).toBeVisible();
    expect((await pool.query('SELECT onboarding_version FROM users WHERE id = $1', [olga.id])).rows[0].onboarding_version).toBeNull();
    await field.fill('Copenhagen, Denmark');
    await go.click();
    await expect.poll(() => new URL(first.page.url()).pathname, { timeout: SLOW }).toBe('/connections');
    expect((await pool.query('SELECT onboarding_version, location FROM users WHERE id = $1', [olga.id])).rows[0])
      .toEqual({ onboarding_version: 2, location: 'Copenhagen, Denmark' });
  });

  await test.step('2.1 the second browser lets go without a reload once the first one finished', async () => {
    // The session follows user:<id> on every device (final sweep F1): a move inside the app is not sent back.
    await second.page.evaluate(() => { window.history.pushState({}, '', '/connections'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await expect.poll(() => new URL(second.page.url()).pathname, { timeout: SLOW }).toBe('/connections');
    await expectNotReloaded(second.page, 'the second browser');
  });

  await test.step('1.2 legacy: a new-onboarding member with no location is sent straight to the field, with no Cancel', async () => {
    // The shape production holds: the new onboarding confirmed, then no location (as t3b seeds it).
    const lou = await throwaway('Lou');
    expect((await api(lou, 'POST', '/onboarding/v2/confirm', ANSWERS)).status).toBe(200);
    await pool.query('UPDATE users SET location = NULL, tour_seen_at = NOW() WHERE id = $1', [lou.id]);
    const page = (await openAs(browser, lou, '/connections')).page;
    await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search, { timeout: SLOW }).toBe('/onboarding?edit=profile&redirect=%2Fconnections');
    const field = page.getByLabel('Where are you based?', { exact: true });
    await expect(field).toBeFocused({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await field.fill('Lisbon, Portugal');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: SLOW }).toBe('/connections');
  });

  await test.step('1.2 the profile form requires it too', async () => {
    const page = (await openAs(browser, bo, '/profile/edit')).page;
    const field = page.locator('#location');
    await expect(field).toHaveValue('Copenhagen, Denmark', { timeout: SLOW });
    await field.fill('USA');
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.locator('#location-error')).toHaveText('Add your city too');
    await page.context().close();
  });
});

// FINDING F1 (T19, 2 Nov 2026), fixed by F12: a member's other device, held at the onboarding gate, is told when they
// finish on the first one. The server sends user:<id> on the confirm, and the client re-reads the session on it
// (realtime/useSessionFollowsServer.ts), so a move inside the app on the other device is no longer sent back to
// onboarding and the device is never reloaded.
test('2.1 (finding F1): a second device held at the gate lets go without a reload once the member finishes on the first', async () => {
  test.setTimeout(150_000);
  const una = await throwaway('Una', { onboarding: 'old' });
  const second = await openAs(browser, una, '/');
  await expect(second.page.getByRole('heading', { name: "Welcome to REASON. We're glad you're here." })).toBeVisible({ timeout: SLOW });
  await markNotReloaded(second.page);
  expect((await api(una, 'POST', '/onboarding/v2/confirm', { ...ANSWERS, profile: { location: 'Copenhagen, Denmark' } })).status).toBe(200);
  await second.page.waitForTimeout(3_000);
  await second.page.evaluate(() => { window.history.pushState({}, '', '/connections'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await second.page.waitForTimeout(3_000);
  expect(new URL(second.page.url()).pathname, 'a move inside the app is not sent back to onboarding').toBe('/connections');
  await expectNotReloaded(second.page, 'the second device');
});

test('2.3: an admin sees a member\'s onboarding answers on the inspector and downloads them as a CSV', async () => {
  test.setTimeout(180_000);
  const mo = await throwaway('Mo');
  expect((await api(mo, 'POST', '/onboarding/v2/confirm', {
    ...ANSWERS, lookingToMeet: ['meet_investors', 'meet_other'], meetOther: `bakers in Vienna ${RUN}`,
  })).status).toBe(200);
  const page = (await openAs(browser, admin, `/admin/users/${mo.id}`, { width: DEVICE ? undefined : Math.max(RUN_WIDTH, 1024) })).page;
  await test.step('2.3 the card and the CSV', async () => {
    const card = page.getByTestId('onboarding-answers-card');
    await expect(card).toBeVisible({ timeout: SLOW });
    await expect(card.getByText('New onboarding', { exact: true })).toBeVisible();
    await expect(card.getByText(`“bakers in Vienna ${RUN}”`, { exact: true })).toBeVisible();
    await expect(card.getByText('Copenhagen, Denmark', { exact: true })).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      card.getByRole('button', { name: 'Download onboarding answers (CSV)' }).click(),
    ]);
    const csv = fs.readFileSync((await download.path())!, 'utf8');
    expect(csv.split('\n')[0]).toMatch(/^Name,Email,Onboarding,Status/);
    expect(csv).toContain(`bakers in Vienna ${RUN}`);
    expect(csv, 'a removed member is not in the CSV of active members').not.toContain(rex.email);
  });

  await test.step('2.3 the open card follows the member\'s new answers and city without a reload (finding F2)', async () => {
    const card = page.getByTestId('onboarding-answers-card');
    await markNotReloaded(page);
    expect((await api(mo, 'POST', '/onboarding/v2/confirm', {
      ...ANSWERS, lookingToMeet: ['meet_investors', 'meet_other'], meetOther: `potters in Porto ${RUN}`, profile: { location: 'Porto, Portugal' },
    })).status).toBe(200);
    await expect(card.getByText(`“potters in Porto ${RUN}”`, { exact: true })).toBeVisible({ timeout: SLOW });
    await expect(card.getByText('Porto, Portugal', { exact: true })).toBeVisible();
    // A profile save is told to the admins too: where they are based is on the card.
    expect((await api(mo, 'PUT', '/users/me', { location: 'Braga, Portugal' })).status).toBe(200);
    await expect(card.getByText('Braga, Portugal', { exact: true })).toBeVisible({ timeout: SLOW });
    await expectNotReloaded(page, 'the admin\'s inspector');
  });
});

// ═══ 3 and 4.1–4.2. Requests ════════════════════════════════════════════════════════════════════════════════════

test('3.1–3.4, 4.1, 4.2: the request card, a legacy request, Remove with Undo, the bar gone on both sides, and Message; never for the removed or blocked', async () => {
  test.setTimeout(300_000);
  const words = `zq${RUN}x wq${RUN}y vq${RUN}z`;
  const ayla = await throwaway('Ayla', { set: { who_i_want_to_meet: 'founders building software' } });
  const bram = await throwaway('Bram', { set: { job_title: 'Founder', professional_role: ['Founder'], who_i_want_to_meet: words } });
  const sana = await throwaway('Sana', { set: { expertise_text: words } });
  const lena = await throwaway('Lena');
  const note = `I think we have a useful reason to speak. (${RUN})`;
  const sent = await api(ayla, 'POST', `/matches/platform/${bram.id}/interest`, { note, format: 'video_20' });
  expect(sent.status, sent.text).toBe(201);
  // The legacy shape: a pending request whose note has REASON's line appended, and no line of its own.
  await pool.query(
    `INSERT INTO user_pokes (sender_id, recipient_id, status, message) VALUES ($1, $2, 'pending', $3)`,
    [lena.id, bram.id, `Note from Lena ${RUN}\n\nWhy REASON suggested this: Lena is looking to meet founders, and Bram is a Founder.`]);

  const inbox = await openAs(browser, bram, '/messages');
  await markNotReloaded(inbox.page);
  const cardOf = (text: string) => inbox.page.getByTestId('meeting-request').filter({ hasText: text }).first();

  await test.step('3.1 the card: heading, the note, REASON\'s line, no two boxes overlapping', async () => {
    const card = cardOf(`(${RUN})`);
    await expect(card).toBeVisible({ timeout: SLOW });
    const boxes = await card.evaluate((el) => [...el.querySelectorAll('[data-part], [data-testid="reason-line"]')]
      .filter((p) => !p.parentElement?.closest('[data-part], [data-testid="reason-line"]') || p.parentElement?.closest('[data-part], [data-testid="reason-line"]') === el)
      .map((p) => { const r = p.getBoundingClientRect(); return { n: (p as HTMLElement).dataset.part || 'reason', x: r.x, y: r.y, w: r.width, h: r.height }; })
      .filter((b) => b.w > 0 && b.h > 0));
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const p = boxes[i]; const q = boxes[j];
      const overlap = p.x < q.x + q.w - 0.5 && q.x < p.x + p.w - 0.5 && p.y < q.y + q.h - 0.5 && q.y < p.y + p.h - 0.5;
      expect(overlap, `"${p.n}" and "${q.n}" overlap`).toBe(false);
    }
    await noSidewaysScroll(inbox.page, 'Messages with requests');
    await shot(inbox.page, 'e-3.1-card');
  });

  await test.step('3.2 "<First> wants to meet you", the note as theirs, REASON\'s line apart; a new request arrives without a reload', async () => {
    const card = cardOf(`(${RUN})`);
    await expect(card.locator('[data-part="heading"]')).toHaveText('Ayla wants to meet you');
    await expect(card.locator('[data-part="note"] blockquote')).toContainText('I think we have a useful reason to speak.');
    await expect(card.getByTestId('reason-line')).toContainText('Why REASON suggested this');
    await expect(card.locator('[data-part="note"]')).not.toContainText('Why REASON');
    // The legacy row is split the same way (L6).
    const legacy = cardOf(`Note from Lena ${RUN}`);
    await expect(legacy.locator('[data-part="heading"]')).toHaveText('Lena wants to meet you');
    await expect(legacy.locator('[data-part="note"]')).not.toContainText('Why REASON');
    await expect(legacy.getByTestId('reason-line')).toContainText('Lena is looking to meet founders');
    // Cy asks now: Bram's page, open all along, shows it.
    expect((await api(cy, 'POST', `/matches/platform/${bram.id}/interest`, { note: `Cy here ${RUN}`, format: 'video_20' })).status).toBe(201);
    await expect(cardOf(`Cy here ${RUN}`).locator('[data-part="heading"]')).toHaveText('Cy wants to meet you', { timeout: LIVE });
    const bell = await pool.query<{ title: string }>(`SELECT title FROM notifications WHERE user_id = $1 AND title LIKE 'Cy%'`, [bram.id]);
    expect(bell.rows.map((r) => r.title)).toContain('Cy wants to meet you');
    await expectNotReloaded(inbox.page, 'Bram\'s Messages');
  });

  await test.step('3.3 "Remove" (not ×) with Undo; Bram\'s For You in another browser drops the card and gets it back', async () => {
    const forYou = await openAs(browser, bram, '/');
    const sanaCard = forYou.page.locator(`[data-person-id="${sana.id}"]`);
    await expect(sanaCard.first()).toBeVisible({ timeout: SLOW });
    await markNotReloaded(forYou.page);
    const profile = (await openAs(browser, bram, `/people/${sana.id}?from=For%20You`)).page;
    const bar = profile.getByRole('region', { name: 'Your move' });
    await expect(bar).toBeVisible({ timeout: SLOW });
    await expect(bar.getByText('×')).toHaveCount(0);
    await bar.getByRole('button', { name: 'Remove from For You' }).click();
    await expect(profile.getByText('Sana is removed from your For You. You can undo this here.')).toBeVisible();
    await expect(sanaCard, 'For You in the other browser drops her').toHaveCount(0, { timeout: LIVE });
    await bar.getByRole('button', { name: 'Put back in For You' }).click();
    await expect(bar.getByRole('button', { name: 'Remove from For You' })).toHaveText('Remove');
    await expect(sanaCard.first(), 'and gets her back').toBeVisible({ timeout: LIVE });
    await expectNotReloaded(forYou.page, 'Bram\'s For You');
    await expect(profile.getByRole('link', { name: 'Message' }), 'a stranger has no Message').toHaveCount(0);
  });

  await test.step('3.4, 4.1, 4.2 Bram accepts; both profiles lose the bar and offer Message without a reload; Message opens the thread', async () => {
    const aylaOnBram = (await openAs(browser, ayla, `/people/${bram.id}?from=For%20You`)).page;
    const bramOnAyla = (await openAs(browser, bram, `/people/${ayla.id}?from=For%20You`)).page;
    await expect(aylaOnBram.getByRole('region', { name: 'Your move' }).getByRole('button', { name: 'Request sent' })).toBeVisible({ timeout: SLOW });
    await expect(bramOnAyla.getByRole('region', { name: 'Your move' }).getByRole('button', { name: 'Accept' })).toBeVisible();
    await cardOf(`(${RUN})`).getByRole('button', { name: 'Accept' }).click();
    await inbox.page.waitForURL(/\/messages\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    for (const [page, who] of [[aylaOnBram, 'Ayla'], [bramOnAyla, 'Bram']] as const) {
      await expect(page.getByRole('region', { name: 'Your move' }), `${who}'s profile drops the bar`).toHaveCount(0, { timeout: LIVE });
      await expect(page.getByRole('link', { name: 'Message' }), `${who}'s profile offers Message`).toBeVisible();
    }
    await aylaOnBram.getByRole('link', { name: 'Message' }).click();
    await expect(aylaOnBram).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
    await expect(aylaOnBram.locator('[data-card="introduction"]')).toContainText('You asked to meet Bram. Bram accepted.', { timeout: LIVE });
    // An answer given twice is still one answer: one conversation, one introduction card.
    await api(bram, 'POST', `/pokes/${sent.json.data.id}/accept`);
    const conv = await pool.query<{ id: string }>(
      'SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)', [ayla.id, bram.id]);
    expect(conv.rows, 'one conversation').toHaveLength(1);
    const intro = await pool.query("SELECT 1 FROM direct_messages WHERE conversation_id = $1 AND kind = 'system'", [conv.rows[0].id]);
    expect(intro.rows, 'one introduction card').toHaveLength(1);
  });

  await test.step('4.1 no Message for a removed connection or a blocked one', async () => {
    const page = (await openAs(browser, bo, `/people/${rex.id}`)).page;
    await page.waitForTimeout(3_000);
    await expect(page.getByRole('link', { name: 'Message' }), 'Rex, removed').toHaveCount(0);
    await gotoRetry(page, `${APP}/people/${kit.id}`);
    await page.waitForTimeout(3_000);
    await expect(page.getByRole('link', { name: 'Message' }), 'Kit, blocked').toHaveCount(0);
    expect((await api(bo, 'POST', '/dm/messages', { toUserId: rex.id, content: 'still there?' })).status, 'the server refuses a message to Rex').toBeGreaterThanOrEqual(400);
    expect((await api(bo, 'POST', '/dm/messages', { toUserId: kit.id, content: 'still there?' })).status, 'and to Kit').toBeGreaterThanOrEqual(400);
  });
});

// ═══ 4.3–4.7. Messaging ═════════════════════════════════════════════════════════════════════════════════════════

test('4.3a, 4.3b, 4.4, 4.7a, 4.7b: names open profiles, Reply quotes live, "(1) REASON", gray bubbles, several emojis', async () => {
  test.setTimeout(300_000);
  const first = `Shall we meet on Tuesday ${RUN}?`;
  const answer = `Tuesday works ${RUN}`;
  const bubble = (page: Page, text: string) => page.locator('[data-message-id]').filter({ hasText: text }).first();

  await test.step('4.4 a new message: Bo\'s other browser reads "(1) REASON" without a reload, and "REASON" once read', async () => {
    const away = (await openAs(browser, bo, '/')).page;
    // Bo's other conversations were read in beforeAll; whatever else is unread, the count goes up by exactly one.
    await expect(away).toHaveTitle(/^(\(\d+\) )?REASON$/, { timeout: SLOW });
    await away.waitForTimeout(5_000);
    const before = Number((await away.title()).match(/^\((\d+)\)/)?.[1] ?? 0);
    const titleOf = (n: number) => (n ? `(${n}) REASON` : 'REASON');
    await markNotReloaded(away);
    expect((await api(ana, 'POST', '/dm/messages', { toUserId: bo.id, content: first })).status).toBe(201);
    await expect(away).toHaveTitle(titleOf(before + 1), { timeout: LIVE });
    const reader = (await openAs(browser, bo, `/messages/${convAB}`)).page;
    await expect(bubble(reader, first)).toBeVisible({ timeout: LIVE });
    await expect(away).toHaveTitle(titleOf(before), { timeout: LIVE });
    await expectNotReloaded(away, 'Bo\'s other browser');
    await reader.context().close();
  });

  const anaThread = (await openAs(browser, ana, `/messages/${convAB}`)).page;
  const boThread = (await openAs(browser, bo, `/messages/${convAB}`)).page;
  await expect(bubble(anaThread, first)).toBeVisible({ timeout: SLOW });
  await expect(bubble(boThread, first)).toBeVisible({ timeout: SLOW });
  await markNotReloaded(anaThread);

  await test.step('4.3b Bo replies to Ana\'s message; Ana\'s open thread shows the quote without a reload', async () => {
    await bubble(boThread, first).hover().catch(() => undefined);
    await bubble(boThread, first).getByTestId('reply-button').click({ force: true });
    await expect(boThread.getByTestId('reply-strip')).toContainText(`Replying to ${ana.displayName}: ${first}`);
    await tall(boThread.getByRole('button', { name: 'Cancel reply' }), 'Cancel reply');
    await boThread.locator('textarea').fill(answer);
    await boThread.locator('textarea').press('Enter');
    for (const [who, page] of [['Bo', boThread], ['Ana', anaThread]] as const) {
      await expect(bubble(page, answer).getByTestId('reply-quote'), `${who} sees the quote`).toContainText(first, { timeout: LIVE });
    }
    await expectNotReloaded(anaThread, 'Ana\'s thread');
  });

  await test.step('4.7a own bubble gray, theirs white with a border', async () => {
    const look = (el: ReturnType<Page['locator']>) => el.evaluate((n) => {
      const s = getComputedStyle(n);
      return { bg: s.backgroundColor, border: s.borderTopWidth, color: s.color };
    });
    expect(await look(boThread.getByTestId('bubble-own').filter({ hasText: answer }).first())).toMatchObject({ bg: 'rgb(243, 244, 246)', color: 'rgb(17, 24, 39)' });
    expect(await look(boThread.getByTestId('bubble-theirs').filter({ hasText: first }).first())).toMatchObject({ bg: 'rgb(255, 255, 255)', border: '1px' });
    // Ana's open browser draws Bo's reply, which arrived live, as theirs: white with a border.
    expect(await look(anaThread.getByTestId('bubble-theirs').filter({ hasText: answer }).first())).toMatchObject({ bg: 'rgb(255, 255, 255)', border: '1px' });
  });

  await test.step('4.7b three emojis in one opening of the picker, sent; Ana sees them live', async () => {
    if (skipStep(RUN_WIDTH < 640, 'The smile is hidden below 640px: a phone keyboard has its own emoji panel (by design).')) return;
    const box = boThread.locator('textarea');
    await box.fill(`Great ${RUN}`);
    await boThread.getByRole('button', { name: 'Add emoji' }).click();
    const picker = boThread.getByTestId('emoji-picker');
    for (const e of ['😀', '🎉', '👍']) {
      await picker.getByRole('button', { name: `Add ${e}` }).click();
      await expect(picker, 'the picker stays open').toBeVisible();
    }
    await expect(box).toHaveValue(`Great ${RUN}😀🎉👍`);
    await boThread.getByRole('button', { name: 'Send message' }).click();
    await expect(bubble(anaThread, `Great ${RUN}😀🎉👍`)).toBeVisible({ timeout: LIVE });
  });

  await test.step('4.3a the name opens the profile; a removed member\'s old thread names no one and links nowhere', async () => {
    await boThread.getByTestId('thread-partner-name').click();
    await expect(boThread).toHaveURL(new RegExp(`/people/${ana.id}\\?from=Messages$`), { timeout: 15_000 });
    await gotoRetry(anaThread, `${APP}/messages/${convAnaRex}`);
    await expect(anaThread.getByTestId('bubble-theirs').filter({ hasText: `An old hello from Rex ${RUN}` }).first()).toBeVisible({ timeout: SLOW });
    await expect(anaThread.getByTestId('former-member-header')).toBeVisible();
    await expect(anaThread.locator(`a[href^="/people/${rex.id}"]`), 'no link to a former member').toHaveCount(0);
    await expect(anaThread.getByTestId('former-member-composer')).toHaveText('This person is no longer a member of REASON, so they cannot get messages.');
  });
});

test('4.5: the notifications page: today, earlier, Load more, a new bell live, mark all read; a closed account\'s request offers nothing', async () => {
  test.setTimeout(240_000);
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at)
     SELECT $1, 'platform_match', 'Seeded ' || g, 'Someone you may want to meet', '/', g > 3, NOW() - interval '3 days' - (g || ' minutes')::interval
       FROM generate_series(1, 35) g`, [cy.id]);
  const poke = await pool.query<{ id: string }>(
    `INSERT INTO user_pokes (sender_id, recipient_id, status, message) VALUES ($1, $2, 'pending', 'Hello') RETURNING id`, [rex.id, cy.id]);
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, link, created_at) VALUES ($1, 'poke', $2, 'Hello', $3, NOW() - interval '2 hours')`,
    [cy.id, `${rex.displayName} asked to meet you`, `/messages?poke=${poke.rows[0].id}`]);
  const page = (await openAs(browser, cy, '/notifications')).page;
  const rows = page.getByTestId('notification-row');
  await expect(rows.first()).toBeVisible({ timeout: SLOW });
  await markNotReloaded(page);

  await test.step('4.5 Today and Earlier, Load more to the end, every row once', async () => {
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    const more = page.getByRole('button', { name: 'Load more' });
    for (let i = 0; i < 3 && await more.count() > 0; i++) { await more.click(); await page.waitForTimeout(800); }
    await expect(more).toHaveCount(0);
    for (const n of [1, 31, 35]) await expect(page.getByText(`Seeded ${n}`, { exact: true })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Earlier' })).toBeVisible();
    await noSidewaysScroll(page, '/notifications');
  });

  await test.step('4.5 removed: the closed account\'s request reads "No longer available", with no Accept or Decline', async () => {
    const gone = rows.filter({ hasText: `${rex.displayName} asked to meet you` });
    await expect(gone).toContainText('No longer available');
    await expect(gone.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  });

  await test.step('4.5 a new bell arrives on the open page without a reload; Mark all as read clears every dot', async () => {
    expect((await api(ana, 'POST', `/matches/platform/${cy.id}/interest`, { note: `Ana asks Cy ${RUN}`, format: 'video_20' })).status).toBe(201);
    const fresh = rows.filter({ hasText: 'Ana wants to meet you' });
    await expect(fresh).toBeVisible({ timeout: LIVE });
    await expect(fresh.getByRole('button', { name: 'Accept' })).toBeVisible();
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    await expect(page.locator('[data-testid="notification-row"][data-read="no"]')).toHaveCount(0, { timeout: LIVE });
    await expectNotReloaded(page, 'Cy\'s notifications');
    await page.getByRole('button', { name: 'Notifications' }).click();
    await expect(page.getByTestId('bell-see-all')).toBeVisible();
    await shot(page, 'e-4.5-notifications');
  });
});

test('4.6: a direct video call rings the connection on any screen, both land in one room; a stranger and a removed connection cannot call', async () => {
  test.setTimeout(240_000);
  // Each side's room logs (LiveKit at debug), so a room that never shows its people says why (preview, 2 Nov 2026).
  const callee = await openAs(browser, bo, '');
  await roomLogsAtDebug(callee.ctx);
  const calleeRoom = watchRoom(callee.page, 'Bo');
  await gotoRetry(callee.page, `${APP}/connections`);
  await expect(callee.page.getByRole('heading').first()).toBeVisible({ timeout: SLOW });
  const caller = await openAs(browser, ana, '');
  await roomLogsAtDebug(caller.ctx);
  const callerRoom = watchRoom(caller.page, 'Ana');
  await gotoRetry(caller.page, `${APP}/people/${bo.id}`);

  await test.step('4.6 Video call → the ring on Bo\'s People page without a reload → Accept → the same room', async () => {
    const call = caller.page.getByTestId('video-call-button');
    await expect(call).toBeVisible({ timeout: SLOW });
    await tall(call, 'Video call');
    await call.click();
    await caller.page.getByRole('button', { name: 'Send request' }).click();
    await expect(caller.page.getByTestId('call-outgoing')).toContainText(`Calling ${bo.displayName}…`, { timeout: 15_000 });
    const banner = callee.page.getByTestId('call-incoming');
    await expect(banner).toContainText(`${ana.displayName} is calling you`, { timeout: LIVE });
    await tall(banner.getByRole('button', { name: 'Accept' }), 'Accept');
    await shot(callee.page, 'e-4.6-ring');
    await banner.getByRole('button', { name: 'Accept' }).click();
    const room = new RegExp(`/meet/${convAB}\\?kind=video`);
    await callee.page.waitForURL(room, { timeout: LIVE });
    await caller.page.waitForURL(room, { timeout: LIVE });
    const kept = await pool.query<{ source: string }>(`SELECT source FROM meetings WHERE conversation_id = $1`, [convAB]);
    expect(kept.rows.map((r) => r.source)).toContain('instant');
  });

  await test.step('4.6 Leave ends it for both (a real room)', async () => {
    if (skipStep(!ROOMS, ROOM_SKIP)) return;
    const tiles = (p: Page) => p.locator('.lk-participant-tile');
    const bothInRoom = async () => {
      await expect(tiles(caller.page), 'Ana sees two people').toHaveCount(2, { timeout: 45_000 });
      await expect(tiles(callee.page), 'Bo sees two people').toHaveCount(2, { timeout: 45_000 });
    };
    await bothInRoom().catch(async (e: Error) => {
      await shot(caller.page, 'e-4.6-room-ana');
      await shot(callee.page, 'e-4.6-room-bo');
      throw new Error(`${e.message}\n${await callerRoom.report()}\n${await calleeRoom.report()}`);
    });
    await caller.page.getByRole('button', { name: 'Leave call and go back to chat' }).click();
    await caller.page.waitForURL(new RegExp(`/messages/${convAB}`));
    await expect(callee.page.getByTestId('partner-left')).toBeVisible({ timeout: 30_000 });
  });

  await test.step('4.6 a stranger has no button and the route refuses in a sentence; a removed connection cannot be called', async () => {
    const page = (await openAs(browser, cy, `/people/${ana.id}`)).page;
    await expect(page.getByRole('heading', { level: 1, name: ana.displayName })).toBeVisible({ timeout: SLOW });
    await expect(page.getByTestId('video-call-button')).toHaveCount(0);
    const refused = await api(cy, 'POST', `/calls/user/${ana.id}`, {});
    expect(refused.status).toBe(403);
    expect(refused.json.error.message).toBe('You can call the people you are connected with. Send a meeting request first.');
    await gotoRetry(caller.page, `${APP}/people/${rex.id}`);
    await caller.page.waitForTimeout(3_000);
    await expect(caller.page.getByTestId('video-call-button'), 'no Video call for Rex').toHaveCount(0);
    expect((await api(ana, 'POST', `/calls/user/${rex.id}`, {})).status, 'the server refuses to ring Rex').toBeGreaterThanOrEqual(400);
  });
});

// FINDING F3 (T19, 2 Nov 2026; fixed by n1-f3): a caller with a second tab of REASON open was put out of the call they
// rang from. The ring reaches every tab of the caller (user:<id>:calls reads the outgoing call again, so "Calling …"
// shows on every screen), and call:accepted sent EVERY such tab into /meet. Two connections with one identity joined
// the room and LiveKit put one out (DUPLICATE_IDENTITY, "client leave request reason: 2"). Now only the tab that rang
// enters (the call is marked placedHere where it was rung); every other tab ends its Calling card. Which tab LiveKit
// kept was timing, so a check on the tab that rang alone could pass on the bug: the other tab is watched from before
// the ring, and must never reach /meet/, never ask for a room token and never open a room connection.
test('4.6 (finding F3): a caller with a second tab open stays in the call they rang from, and the other tab never enters it', async () => {
  test.skip(!ROOMS, ROOM_SKIP);
  test.setTimeout(150_000);
  const pat = await throwaway('Pat');
  const quin = await throwaway('Quin');
  const conv = await connect(pat, quin, `Hello Quin ${RUN}`);
  const other = await openAs(browser, pat, `/messages/${conv}`);
  const otherTab = other.page;
  /** Every way the other tab could have gone into the call, as it happened. */
  const entered: string[] = [];
  otherTab.on('framenavigated', (f) => {
    if (f === otherTab.mainFrame() && new URL(f.url()).pathname.startsWith('/meet/')) entered.push(`went to ${f.url()}`);
  });
  otherTab.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('/call-token')) entered.push(`asked for a room token (${r.method()} ${new URL(r.url()).pathname})`);
  });
  otherTab.on('websocket', (ws) => {
    if (/\/rtc(\/|\?|$)/.test(ws.url())) entered.push(`opened a room connection (${ws.url().split('?')[0]})`);
  });
  await expect(otherTab.getByText(`Hello Quin ${RUN}`).filter({ visible: true }).first(), 'the other tab shows the thread').toBeVisible({ timeout: SLOW });
  const callee = (await openAs(browser, quin, '/connections')).page;
  const caller = await openAs(browser, pat, '');
  await roomLogsAtDebug(caller.ctx);
  const callerRoom = watchRoom(caller.page, 'Pat (the tab that rang)');
  await gotoRetry(caller.page, `${APP}/people/${quin.id}`);
  await expect(callee.getByRole('heading').first()).toBeVisible({ timeout: SLOW });

  await caller.page.getByTestId('video-call-button').click({ timeout: SLOW });
  await caller.page.getByRole('button', { name: 'Send request' }).click();
  // The other tab holds the call too (the precondition of F3): its Calling card shows.
  await expect(otherTab.getByTestId('call-outgoing'), 'the other tab shows the call ringing').toContainText(`Calling ${quin.displayName}…`, { timeout: LIVE });
  await callee.getByTestId('call-incoming').getByRole('button', { name: 'Accept' }).click({ timeout: LIVE });

  await caller.page.waitForURL(new RegExp(`/meet/${conv}`), { timeout: LIVE });
  await expect(caller.page.locator('.lk-participant-tile'), 'the tab that rang shows both people').toHaveCount(2, { timeout: 45_000 })
    .catch(async (e: Error) => {
      await shot(caller.page, 'e-f3-room-pat');
      throw new Error(`${e.message}\n${await callerRoom.report()}\nthe other tab: ${entered.join('; ') || 'did nothing'}`);
    });
  await expect(otherTab.getByTestId('call-outgoing'), 'the other tab ends its Calling card').toHaveCount(0, { timeout: LIVE });
  await caller.page.waitForTimeout(5_000);
  await expect(caller.page, 'the tab that rang stays in the call').toHaveURL(new RegExp(`/meet/${conv}`));
  await expect(caller.page.locator('.lk-participant-tile'), 'and still shows both people').toHaveCount(2);
  expect(entered, 'the other tab never went into the call').toEqual([]);
  expect(new URL(otherTab.url()).pathname, 'the other tab stays where it was').toBe(`/messages/${conv}`);
});

// ═══ 5. Meetings ════════════════════════════════════════════════════════════════════════════════════════════════

test('5a, 5b, 5c: chat in the meeting room, Add to calendar, and the feedback the admin sees live', async () => {
  test.setTimeout(360_000);
  const mia = await throwaway('Mia');
  const max = await throwaway('Max');
  const conv = await connect(mia, max, `Coffee about your seed round ${RUN}?`);
  const halfHour = 1_800_000;
  const slot = new Date(Math.ceil((Date.now() + 3 * 86_400_000) / halfHour) * halfHour).toISOString().replace('.000Z', 'Z');
  const later = new Date(Date.parse(slot) + 2 * halfHour).toISOString().replace('.000Z', 'Z');
  for (const u of [mia, max]) expect((await api(u, 'PUT', `/dm/conversations/${conv}/scheduling/availability`, { windows: [slot, later] })).status).toBe(200);
  expect((await api(mia, 'POST', `/dm/conversations/${conv}/scheduling/confirm`, { window: slot, durationMin: 45, type: 'video' })).status).toBe(200);
  const meetingId = (await pool.query<{ id: string }>('SELECT id FROM meetings WHERE conversation_id = $1', [conv])).rows[0].id;
  const compact = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  await test.step('5b Add to calendar: Google, Outlook.com and the file; Max\'s open page follows a move without a reload', async () => {
    const page = (await openAs(browser, mia, `/meetings/${meetingId}`)).page;
    const maxPage = (await openAs(browser, max, `/meetings/${meetingId}`)).page;
    await markNotReloaded(maxPage);
    await page.getByRole('button', { name: 'Add manually', exact: true }).click();
    const menu = page.getByTestId('add-to-calendar-menu');
    for (const id of ['calendar-google', 'calendar-outlook', 'calendar-ics']) await tall(menu.getByTestId(id), id);
    const google = new URL((await menu.getByTestId('calendar-google').getAttribute('href'))!);
    expect(google.searchParams.get('text')).toBe(`Meeting with ${max.displayName} on REASON`);
    const start = new Date(slot);
    expect(google.searchParams.get('dates')).toBe(`${compact(start)}/${compact(new Date(start.getTime() + 45 * 60_000))}`);
    expect(google.searchParams.get('details')).toContain(`/meet/${conv}?scheduled=1&kind=video`);
    const download = page.waitForEvent('download');
    await menu.getByTestId('calendar-ics').click();
    expect((await download).suggestedFilename()).toBe('reason-meeting.ics');
    await noSidewaysScroll(page, 'the meeting page');
    await page.keyboard.press('Escape');
    // Mia moves it an hour; Max's page, open all along, offers the new time.
    const moved = new Date(start.getTime() + 3_600_000);
    expect((await api(mia, 'POST', `/dm/conversations/${conv}/scheduling/confirm`, {
      window: moved.toISOString().replace('.000Z', 'Z'), durationMin: 45, type: 'video',
    })).status).toBe(200);
    await expect.poll(async () => {
      await maxPage.getByRole('button', { name: 'Add manually', exact: true }).click();
      const href = await maxPage.getByTestId('add-to-calendar-menu').getByTestId('calendar-google').getAttribute('href').catch(() => null);
      await maxPage.keyboard.press('Escape');
      return href ? new URL(href).searchParams.get('dates')?.split('/')[0] : null;
    }, { message: 'Max\'s page offers the moved time', timeout: LIVE }).toBe(compact(moved));
    await expectNotReloaded(maxPage, 'Max\'s meeting page');
    await page.context().close();
    await maxPage.context().close();
  });

  await test.step('5a Chat in the room: Mia writes, Max\'s Chat counts it and he reads it live; a block made in the call is refused in words', async () => {
    const a = (await openAs(browser, mia, `/meet/${conv}?kind=video`)).page;
    const b = (await openAs(browser, max, `/meet/${conv}?kind=video`)).page;
    for (const p of [a, b]) await expect(p.getByTestId('call-chat-toggle')).toBeVisible({ timeout: SLOW });
    await tall(a.getByTestId('call-chat-toggle'), 'Chat');
    await a.getByTestId('call-chat-toggle').click();
    const panelA = a.getByTestId('call-chat-panel');
    const line = `Can you hear me? ${RUN}`;
    await panelA.getByLabel('Message').fill(line);
    await panelA.getByLabel('Message').press('Enter');
    await expect(panelA.getByText(line)).toBeVisible();
    await expect(b.getByTestId('call-chat-unread')).toHaveText('1', { timeout: LIVE });
    await b.getByTestId('call-chat-toggle').click();
    await expect(b.getByTestId('call-chat-panel').getByText(line)).toBeVisible();
    await noSidewaysScroll(b, 'the room with the chat open');
    await shot(b, 'e-5a-meeting-chat');
    // Blocked during the call: the next line is refused, kept in the box, and nothing is written.
    expect((await api(max, 'POST', `/users/${mia.id}/block`, {})).status).toBeLessThan(300);
    const refused = `Still there? ${RUN}`;
    await panelA.getByLabel('Message').fill(refused);
    await panelA.getByRole('button', { name: 'Send' }).click();
    await expect(panelA.getByRole('alert')).toHaveText(/no longer|cannot|can't/i, { timeout: 15_000 });
    await expect(panelA.getByLabel('Message')).toHaveValue(refused);
    expect((await pool.query('SELECT 1 FROM direct_messages WHERE content = $1', [refused])).rows).toHaveLength(0);
    await api(max, 'DELETE', `/users/${mia.id}/block`);
    await a.context().close();
    await b.context().close();
  });

  await test.step('5c both answer "how did it go"; the admin\'s open /admin/feedback lists both rows without a reload; a member is refused', async () => {
    const [x, y] = [mia.id, max.id].sort();
    const past = (await pool.query<{ id: string }>(
      `INSERT INTO meetings (conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, confirmed_by)
       VALUES ($1, $2, $3, NOW() - interval '10 minutes', 30, 'video', $2) RETURNING id`, [conv, x, y])).rows[0].id;
    const adminPage = (await openAs(browser, admin, '/admin/feedback', { width: DEVICE ? undefined : Math.max(RUN_WIDTH, 1024) })).page;
    await expect(adminPage.getByRole('heading', { name: 'Meeting feedback' })).toBeVisible({ timeout: SLOW });
    await markNotReloaded(adminPage);
    const ours = adminPage.getByTestId('feedback-row').filter({ hasText: mia.displayName });
    await expect(ours).toHaveCount(0);
    const sheetOf = (page: Page, name: string) => page.getByRole('dialog', { name: `How did your meeting with ${name} go?` });
    const answer = async (u: TestUser, partner: TestUser, worth: string, problem?: string) => {
      const page = (await openAs(browser, u, `/meetings/${past}`)).page;
      await expect(page.getByRole('heading', { name: 'How did it go?' })).toBeVisible({ timeout: SLOW });
      await page.getByRole('button', { name: 'Answer', exact: true }).click();
      const sheet = sheetOf(page, partner.displayName);
      await sheet.getByRole('button', { name: worth, exact: true }).click();
      if (problem) await sheet.getByRole('button', { name: problem, exact: true }).click();
      await scrollClear(sheet.getByRole('button', { name: 'Send', exact: true }));
      await sheet.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(sheet).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByText('Thanks. Your feedback is saved.')).toBeVisible();
      await page.context().close();
    };
    await answer(mia, max, 'Yes');
    await answer(max, mia, 'Maybe', 'Connection');
    await expect(ours, 'two rows, one from each, without a reload').toHaveCount(2, { timeout: LIVE });
    await expect(adminPage.getByTestId('feedback-row').filter({ hasText: 'Connection' }).first()).toContainText('Maybe');
    await expectNotReloaded(adminPage, 'the admin\'s feedback page');
    const member = (await openAs(browser, cy, '/admin/feedback')).page;
    await expect(member.getByRole('heading', { name: 'Admins only' })).toBeVisible({ timeout: SLOW });
    expect((await api(cy, 'GET', '/admin/feedback')).status).toBe(403);
  });
});

test('5d, 8.4: no password; a signed-out meeting link signs in by the emailed code and lands back on the meeting; logging out one browser leaves the other signed in', async () => {
  test.setTimeout(240_000);
  const sid = await throwaway('Sid');
  const meeting = `/meet/${crypto.randomUUID()}?scheduled=1&kind=video`;
  const page = await openSignedOut(browser);

  await test.step('8.4 the sign-in page says no password is needed, and the email carries a code the waiting screen takes', async () => {
    await page.goto(`${APP}${meeting}`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/\/login\?redirect=%2Fmeet%2F/, { timeout: SLOW });
    await expect(page.getByText(NO_PASSWORD)).toBeVisible({ timeout: SLOW });
    await page.getByPlaceholder('you@example.com').fill(sid.email);
    const answer = page.waitForResponse((r) => r.url().includes('/auth/magic-link') && r.request().method() === 'POST' && !r.url().includes('/code'));
    await page.getByRole('button', { name: 'Email me a link and a code' }).click();
    const body = await (await answer).json();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    let code: string = body?.data?.devCode ?? '';
    if (!code) {
      // The preview and production never hand the code back: write the hash of a code chosen here on the link just
      // asked for, with the server's own keyed hash (n1-t4's way).
      code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const row = await pool.query<{ id: string; token_hash: string }>(
        `SELECT id, token_hash FROM magic_links WHERE email = $1 AND purpose = 'login' ORDER BY created_at DESC LIMIT 1`, [sid.email]);
      const hash = crypto.createHmac('sha256', SECRET).update(`sign-in-code:${row.rows[0].token_hash}:${code}`).digest('hex');
      await pool.query(`UPDATE magic_links SET code_hash = $2 WHERE id = $1`, [row.rows[0].id, hash]);
    }
    const field = page.getByLabel('6-digit code from the email');
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');
    await tall(field, 'the code field');
    await field.fill(code);
  });

  await test.step('5d the signed-out meeting link lands back on that meeting after sign-in', async () => {
    await expect(page).toHaveURL(`${APP}${meeting}`, { timeout: SLOW });
    expect(await page.evaluate(() => localStorage.getItem('rsn_tokens'))).toBeTruthy();
  });

  await test.step('5d logging out here leaves Sid\'s other browser signed in (there is no "sign out everywhere", L13)', async () => {
    const other = (await openAs(browser, sid, '/connections')).page;
    await expect(other.getByRole('heading').first()).toBeVisible({ timeout: SLOW });
    await markNotReloaded(other);
    await gotoRetry(page, `${APP}/connections`);
    if (phone()) {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
      await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Log out' }).click();
    } else {
      await page.getByRole('button', { name: 'Your account' }).click();
      await page.getByRole('button', { name: 'Log out' }).first().click();
    }
    await page.getByRole('dialog', { name: 'Log out?' }).getByRole('button', { name: 'Log out' }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: LIVE }).toBe('/login');
    await other.waitForTimeout(5_000);
    expect(new URL(other.url()).pathname, 'the other browser is still in').toBe('/connections');
    expect(await other.evaluate(() => localStorage.getItem('rsn_tokens'))).toBeTruthy();
    await expectNotReloaded(other, 'Sid\'s other browser');
  });
});

// ═══ 6. Events ══════════════════════════════════════════════════════════════════════════════════════════════════

test('6.1a–c and a legacy event: who can join, a request approved live, a private event hidden, a public one registers on Register', async () => {
  test.setTimeout(300_000);
  const host = await throwaway('Hana');
  const stranger = await throwaway('Sven');
  const podId = await seedPod(host, `${RUN} Events pod`);
  const h = (await openAs(browser, host, `/sessions/new?podId=${podId}`)).page;
  const s = (await openAs(browser, stranger, '/sessions')).page;
  let approvalId = '';

  await test.step('6.1a "Public with approval": a stranger asks, the host\'s Requests card shows it live, approves, the stranger\'s page turns Registered live', async () => {
    const field = h.getByTestId('event-access-field');
    await expect(field).toBeVisible({ timeout: SLOW });
    await expect(field.getByRole('radio', { name: /Private/ })).toBeChecked();
    await field.getByTestId('event-access-public_with_approval').click();
    await h.getByLabel('Title').fill(`${RUN} Approval evening`);
    await h.getByRole('button', { name: 'Schedule Event' }).click();
    await h.waitForURL(/\/sessions\/[0-9a-f-]{36}/, { timeout: 30_000 });
    approvalId = h.url().match(/sessions\/([0-9a-f-]{36})/)![1];
    made.sessions.push(approvalId);
    await gotoRetry(h, `${APP}/sessions/${approvalId}`);
    const card = h.getByTestId('event-requests-card');
    await expect(card).toContainText('No one is waiting for a place.', { timeout: SLOW });
    await markNotReloaded(h);
    await gotoRetry(s, `${APP}/sessions/${approvalId}`);
    await s.getByTestId('event-request-open').click();
    await s.getByTestId('event-request-message').fill(`I would like to come ${RUN}.`);
    await s.getByTestId('event-request-send').click();
    await expect(s.getByTestId('event-request-sent')).toBeVisible({ timeout: 15_000 });
    await markNotReloaded(s);
    await expect(card.getByTestId('event-request-row'), 'the host\'s card, without a reload').toHaveCount(1, { timeout: LIVE });
    await expect(card).toContainText('Requests (1)');
    await card.getByTestId('event-request-approve').click();
    await expect(s.getByText('Registered', { exact: true }), 'the stranger\'s page, without a reload').toBeVisible({ timeout: LIVE });
    await expectNotReloaded(h, 'the host\'s event page');
    await expectNotReloaded(s, 'the stranger\'s event page');
    // A removed member cannot ask.
    expect((await api(rex, 'POST', `/sessions/${approvalId}/requests`, { message: 'me too' })).status, 'Rex is refused').toBeGreaterThanOrEqual(400);
  });

  await test.step('6.1c "Private": not in a stranger\'s Events, and its address answers the private notice', async () => {
    const priv = await api(host, 'POST', '/sessions', {
      podId, title: `${RUN} Private dinner`, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), format: 'speed_networking', visibility: 'private',
    });
    expect(priv.status, priv.text).toBe(201);
    made.sessions.push(priv.json.data.id);
    await gotoRetry(s, `${APP}/sessions`);
    await expect(s.getByText(`${RUN} Approval evening`).first()).toBeVisible({ timeout: SLOW });
    await expect(s.getByText(`${RUN} Private dinner`)).toHaveCount(0);
    await gotoRetry(s, `${APP}/sessions/${priv.json.data.id}`);
    await expect(s.getByTestId('event-private-title')).toHaveText('This event is private', { timeout: SLOW });
  });

  await test.step('6.1b "Public": opening it registers nobody; Register does', async () => {
    const pub = await api(host, 'POST', '/sessions', {
      podId, title: `${RUN} Open evening`, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), format: 'speed_networking', visibility: 'public',
    });
    expect(pub.status, pub.text).toBe(201);
    made.sessions.push(pub.json.data.id);
    await gotoRetry(s, `${APP}/sessions/${pub.json.data.id}`);
    await expect(s.getByTestId('event-register')).toBeVisible({ timeout: SLOW });
    expect((await pool.query('SELECT 1 FROM session_participants WHERE session_id = $1 AND user_id = $2', [pub.json.data.id, stranger.id])).rows).toHaveLength(0);
    await s.getByTestId('event-register').click();
    await expect(s.getByText('Registered', { exact: true })).toBeVisible({ timeout: LIVE });
  });

  await test.step('6.1 legacy: an event from the old form (no visibility) in a public pod keeps its pod\'s rules', async () => {
    const publicPod = await seedPod(host, `${RUN} Public pod`, [], 'speed_networking', 'public');
    const legacy = await api(host, 'POST', '/sessions', {
      podId: publicPod, title: `${RUN} Old form event`, scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      format: 'speed_networking', config: { numberOfRounds: 3, roundDurationSeconds: 300, maxParticipants: 20 },
    });
    expect(legacy.status, legacy.text).toBe(201);
    expect(legacy.json.data.visibility).toBeNull();
    made.sessions.push(legacy.json.data.id);
    await gotoRetry(s, `${APP}/sessions/${legacy.json.data.id}`);
    await expect(s.getByTestId('event-register')).toBeVisible({ timeout: SLOW });
    await s.getByTestId('event-register').click();
    await expect(s.getByText('Registered', { exact: true })).toBeVisible({ timeout: LIVE });
  });
});

test('6.1d, 6.1e, 6.2: an in-person event with its place (a pod member sees it arrive), the speed-networking presets, and Matching on every type', async () => {
  test.setTimeout(300_000);
  const director = await throwaway('Dora');
  const member = await throwaway('Milo');
  const pod = await api(director, 'POST', '/pods', {
    name: `${RUN} Reason pod`, description: 'throwaway', visibility: 'private', podType: 'reason', orchestrationMode: 'free_form', communicationMode: 'video',
  });
  expect(pod.status, pod.text).toBe(201);
  const podId = pod.json.data.id;
  made.pods.push(podId);
  expect([200, 201]).toContain((await api(director, 'POST', `/pods/${podId}/members`, { userId: member.id, role: 'member' })).status);
  const place = `The Ivy, 1-5 West St, London ${RUN}`;
  const podPage = (await openAs(browser, member, `/pods/${podId}`)).page;
  await expect(podPage.locator('#pod-events')).toBeVisible({ timeout: SLOW });
  await markNotReloaded(podPage);
  const form = (await openAs(browser, director, `/sessions/new?podId=${podId}`)).page;

  await test.step('6.1d In person: "Where" is required, the place and Open in maps show, no video room; the member\'s pod page lists it without a reload', async () => {
    await form.getByRole('radio', { name: /^In person/ }).click();
    const whereField = form.getByLabel('Where', { exact: true });
    await expect(whereField).toBeVisible();
    await form.getByLabel('Title', { exact: true }).fill(`${RUN} Dinner in town`);
    await form.getByRole('button', { name: 'Schedule Event' }).click();
    await expect(form.getByText('Say where the event happens: an address or a venue.').first()).toBeVisible();
    await whereField.fill(place);
    await expect(form.getByTestId('matching-section')).toContainText("Video meetings don't pair people.");
    await form.getByRole('button', { name: 'Schedule Event' }).click();
    await form.waitForURL(/\/sessions\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const id = form.url().match(/\/sessions\/([0-9a-f-]{36})/)![1];
    made.sessions.push(id);
    await gotoRetry(form, `${APP}/sessions/${id}`);
    await expect(form.getByTestId('event-place')).toContainText(place, { timeout: SLOW });
    await expect(form.getByRole('link', { name: /Open in maps/ })).toHaveAttribute('href', `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`);
    await expect(form.getByRole('button', { name: /Go Live|Enter Event|Enter Live Event/ })).toHaveCount(0);
    expect((await api(director, 'POST', `/sessions/${id}/token`, {})).json.error.message).toBe('This event happens in person, so there is no video room.');
    await expect(podPage.locator('#pod-events').getByText(`${RUN} Dinner in town`)).toBeVisible({ timeout: LIVE });
    await expectNotReloaded(podPage, 'the member\'s pod page');
  });

  await test.step('6.1e, 6.2 Speed networking: "Founders and investors" and "Not again for a while"; the facts line names the preset; the pod page lists it live', async () => {
    await gotoRetry(form, `${APP}/sessions/new?podId=${podId}`);
    await form.getByRole('radio', { name: /^Speed networking/ }).click();
    const presets = form.getByTestId('matching-presets');
    await expect(presets).toContainText('Founders meet investors first');
    await expect(presets).toContainText('People hiring meet people looking for a role first');
    await presets.getByRole('radio', { name: /^Founders and investors/ }).check();
    await form.getByRole('radio', { name: /^Not again for a while/ }).check();
    await form.getByLabel('Months apart').fill('6');
    await form.getByLabel('Title', { exact: true }).fill(`${RUN} Founders night`);
    await form.getByRole('button', { name: 'Schedule Event' }).click();
    await form.waitForURL(/\/sessions\/[0-9a-f-]{36}/, { timeout: 30_000 });
    const id = form.url().match(/\/sessions\/([0-9a-f-]{36})/)![1];
    made.sessions.push(id);
    await gotoRetry(form, `${APP}/sessions/${id}`);
    await expect(form.getByText(/Speed networking · Founders and investors ·/)).toBeVisible({ timeout: SLOW });
    expect((await api(director, 'GET', `/sessions/${id}`)).json.data.config).toMatchObject({ matchingPolicy: 'cooldown', cooldownMonths: 6 });
    await expect(podPage.locator('#pod-events').getByText(`${RUN} Founders night`)).toBeVisible({ timeout: LIVE });
  });

  await test.step('6.2 on Video meeting the Matching section says it pairs nobody and switches to Speed networking through the question', async () => {
    await gotoRetry(form, `${APP}/sessions/new?podId=${podId}`);
    await expect(form.getByRole('radio', { name: /^Video meeting/ })).toBeChecked({ timeout: SLOW });
    const section = form.getByTestId('matching-section');
    await expect(section).toContainText("Video meetings don't pair people. Choose Speed networking to match people one to one.");
    // A length was chosen, so switching asks before it drops the video meeting's settings.
    await form.getByLabel('Length').selectOption('90');
    await section.getByRole('button', { name: 'Choose Speed networking' }).click();
    await form.getByRole('alert').filter({ hasText: 'Switching to Speed networking' }).getByRole('button', { name: 'Continue' }).click();
    await expect(form.getByTestId('matching-presets')).toBeVisible();
    await noSidewaysScroll(form, 'the event form');
  });
});

test('6.3: a circle\'s manager schedules an event for the whole circle; a member outside its pod sees it live and registers; outsiders and the removed are not told', async () => {
  test.setTimeout(240_000);
  const manager = await throwaway('Nia');
  const member = await throwaway('Ned');
  const outsider = await throwaway('Oz');
  const circleName = `${RUN} Founders circle`;
  const circleId = (await pool.query<{ id: string }>(
    `INSERT INTO circles (name, created_by, member_count) VALUES ($1, $2, 3) RETURNING id`, [circleName, manager.id])).rows[0].id;
  made.circles.push(circleId);
  await pool.query(`INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [circleId, manager.id, member.id, rex.id]);
  const podId = await seedPod(manager, `${RUN} Circle pod`);
  await pool.query(`INSERT INTO circle_pods (circle_id, pod_id, added_by) VALUES ($1, $2, $3)`, [circleId, podId, manager.id]);
  const mem = (await openAs(browser, member, `/circles/${circleId}`)).page;
  await expect(mem.getByTestId('circle-events-empty')).toHaveText('No upcoming events yet.', { timeout: SLOW });
  await expect(mem.getByTestId('circle-schedule-event'), 'a plain member is not offered it').toHaveCount(0);
  await markNotReloaded(mem);
  let sessionId = '';

  await test.step('6.3 the manager schedules from the circle page; the member\'s page lists it and the bell rings without a reload', async () => {
    const m = (await openAs(browser, manager, `/circles/${circleId}`)).page;
    await m.getByTestId('circle-schedule-event').click();
    await m.waitForURL(new RegExp(`/sessions/new\\?circleId=${circleId}`), { timeout: 30_000 });
    await expect(m.getByTestId('event-circle-preset')).toContainText(`For everyone in ${circleName}`, { timeout: SLOW });
    await m.getByLabel('Pod', { exact: true }).selectOption(podId);
    await m.getByLabel('Title').fill(`${RUN} Circle evening`);
    const created = m.waitForResponse((r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST');
    await m.getByRole('button', { name: 'Schedule Event' }).click();
    const res = await created;
    expect(res.status()).toBe(201);
    sessionId = (await res.json()).data.id;
    made.sessions.push(sessionId);
    const row = mem.getByTestId('circle-event').filter({ hasText: `${RUN} Circle evening` });
    await expect(row).toBeVisible({ timeout: LIVE });
    await expect(bellCount(mem)).toBeVisible({ timeout: LIVE });
    await expectNotReloaded(mem, 'the member\'s circle page');
    const bells = await pool.query<{ user_id: string }>('SELECT user_id FROM notifications WHERE link = $1', [`/sessions/${sessionId}`]);
    expect(bells.rows.map((b) => b.user_id), 'the member is rung; the removed member is not').toEqual([member.id]);
    await row.click();
    await expect(mem.getByText('Registered', { exact: true })).toBeVisible({ timeout: SLOW });
    expect((await pool.query('SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2', [podId, member.id])).rows, 'not added to the pod').toHaveLength(0);
  });

  await test.step('6.3 someone outside the circle sees the private notice and cannot register', async () => {
    const o = (await openAs(browser, outsider, `/sessions/${sessionId}`)).page;
    await expect(o.getByTestId('event-private-title')).toHaveText('This event is private', { timeout: SLOW });
    expect((await api(outsider, 'POST', `/sessions/${sessionId}/register`)).status).toBe(403);
  });
});

// ═══ 7. Entities and circles ════════════════════════════════════════════════════════════════════════════════════

test('7.1–7.3: an entity\'s claim waits for its admin, approved live; its logo; a member removed; linked to a circle live; a closed account is never listed', async () => {
  test.setTimeout(300_000);
  const owner = await throwaway('Olu', { set: { company: null } });
  const claimant = await throwaway('Cai', { set: { company: null } });
  const second = await throwaway('Sev', { set: { company: null } });
  const manager = await throwaway('Mae');
  const name = `${RUN} Lighthouse`;
  const ent = await api(owner, 'POST', '/entities', { name, kind: 'company', role: 'founder' });
  expect(ent.status, ent.text).toBe(201);
  const entityId = ent.json.data.id;
  made.entities.push(entityId);
  // The second member asked and was approved; Rex, a closed account, has an approved link (a twin of the rows a
  // removed member leaves behind), which must never put him in the entity's People.
  expect((await api(second, 'POST', `/entities/${entityId}/members`, { role: 'advisor' })).json?.data?.status).toBe('pending');
  expect((await api(owner, 'POST', `/entities/${entityId}/members/${second.id}/approve`)).status).toBe(200);
  await pool.query(`INSERT INTO entity_members (entity_id, user_id, role, status) VALUES ($1, $2, 'advisor', 'active')`, [entityId, rex.id]);
  const own = (await openAs(browser, owner, `/entities/${entityId}`)).page;
  const cla = (await openAs(browser, claimant, `/entities/${entityId}`)).page;
  await expect(own.getByRole('heading', { name, level: 1 })).toBeVisible({ timeout: SLOW });
  await markNotReloaded(own);
  await markNotReloaded(cla);
  const personCard = (page: Page, u: TestUser) => page.locator(`a[data-person-id="${u.id}"]`);

  await test.step('7.2 removed: a closed account linked to the entity is not in its People', async () => {
    await expect(personCard(own, second)).toBeVisible({ timeout: SLOW });
    await expect(personCard(own, rex)).toHaveCount(0);
  });

  await test.step('7.2 a claim waits; the owner\'s Requests shows it live; Approve lists them live on both pages', async () => {
    await expect(cla.getByRole('heading', { name: `Are you part of ${name}?` })).toBeVisible({ timeout: SLOW });
    await cla.getByLabel('Your role', { exact: true }).selectOption('employee');
    await cla.getByRole('button', { name: 'Ask to join', exact: true }).click();
    await expect(cla.getByRole('heading', { name: `Waiting for ${name}'s admins to approve you.` })).toBeVisible({ timeout: LIVE });
    await expect(personCard(cla, claimant), 'not listed while it waits').toHaveCount(0);
    const row = own.getByTestId('entity-requests').locator(`[data-request-id="${claimant.id}"]`);
    await expect(row, 'the owner\'s page, without a reload').toBeVisible({ timeout: LIVE });
    await tall(row.getByRole('button', { name: 'Approve' }), 'Approve');
    await scrollClear(row.getByRole('button', { name: 'Approve' }));
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(personCard(own, claimant)).toContainText('Employee', { timeout: LIVE });
    await expect(cla.getByRole('heading', { name: 'Employee', level: 2 }), 'the claimant\'s page flips without a reload').toBeVisible({ timeout: LIVE });
  });

  await test.step('7.2 the owner removes a member after the confirm; they leave People at once, on the claimant\'s page too', async () => {
    await expect(personCard(cla, second)).toBeVisible({ timeout: LIVE });
    const remove = own.getByRole('button', { name: `Remove ${second.displayName}` });
    await scrollClear(remove);
    await remove.click();
    await own.getByRole('dialog', { name: `Remove ${second.displayName}?` }).getByTestId('confirm-dialog-confirm').click();
    await expect(personCard(own, second)).toHaveCount(0, { timeout: LIVE });
    await expect(personCard(cla, second), 'the claimant\'s page, without a reload').toHaveCount(0, { timeout: LIVE });
  });

  await test.step('7.1 the logo: the owner\'s pencil, placed and saved; the member\'s open page shows it without a reload', async () => {
    const pencil = own.getByRole('button', { name: 'Add logo' });
    await scrollClear(pencil);
    await tall(pencil, 'the logo pencil');
    await expect(cla.getByRole('button', { name: /logo$/ }), 'no pencil for a member').toHaveCount(0);
    await pencil.click();
    const sheet = own.getByRole('dialog', { name: 'Add logo' });
    await sheet.locator('input[type="file"]').setInputFiles({ name: 'logo.jpg', mimeType: 'image/jpeg', buffer: await halves(own, 1200, 900) });
    await expect(sheet.getByRole('slider', { name: 'Zoom' })).toBeVisible({ timeout: 20_000 });
    await pinch(sheet.getByTestId('picture-frame'));
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(own.getByText(`${name}'s logo is updated.`)).toBeVisible({ timeout: 30_000 });
    const logo = `img[src*="/api/entities/${entityId}/logo?v="]`;
    await expect(own.locator(logo).first()).toBeVisible({ timeout: LIVE });
    await expect(cla.locator(logo).first(), 'the member\'s page, without a reload').toBeVisible({ timeout: LIVE });
    await expectNotReloaded(cla, 'the member\'s entity page');
  });

  await test.step('7.3 a circle\'s manager links the entity; a member\'s open circle page and the entity page show it live', async () => {
    const circleName = `${RUN} Lighthouse circle`;
    const circleId = (await pool.query<{ id: string }>(
      `INSERT INTO circles (name, created_by, member_count) VALUES ($1, $2, 2) RETURNING id`, [circleName, manager.id])).rows[0].id;
    made.circles.push(circleId);
    await pool.query(`INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [circleId, manager.id, claimant.id]);
    const man = (await openAs(browser, manager, `/circles/${circleId}`)).page;
    await gotoRetry(cla, `${APP}/circles/${circleId}`);
    await expect(cla.getByRole('heading', { name: circleName, level: 1 })).toBeVisible({ timeout: SLOW });
    await markNotReloaded(cla);
    const orgs = man.getByTestId('circle-organisations');
    await expect(orgs.getByText('No organisations are linked to this circle yet.')).toBeVisible({ timeout: SLOW });
    await scrollClear(orgs.getByRole('button', { name: 'Link an entity' }));
    await orgs.getByRole('button', { name: 'Link an entity' }).click();
    const sheet = man.getByRole('dialog', { name: 'Link an entity' });
    await sheet.getByTestId('link-entity-search').fill(name);
    await sheet.locator(`[data-link-entity="${entityId}"]`).getByRole('button', { name: 'Link' }).click();
    await expect(man.getByText(`${name} is linked to ${circleName}.`)).toBeVisible({ timeout: LIVE });
    await expect(cla.getByTestId('circle-organisations').locator(`[data-entity-row="${entityId}"]`), 'the member\'s circle page').toContainText(name, { timeout: LIVE });
    await expect(own.getByTestId('entity-circles').locator(`[data-circle-id="${circleId}"]`), 'the entity page').toContainText(circleName, { timeout: LIVE });
    await expectNotReloaded(cla, 'the member\'s circle page');
    await expectNotReloaded(own, 'the owner\'s entity page');
  });
});

test('7.4–7.6 and a legacy circle: invite from the sheet (never a removed connection), a closed circle approved live, a new pod from the circle; a creator with no membership row still runs it', async () => {
  test.setTimeout(300_000);
  const owner = await throwaway('Oona', { role: 'admin' });
  const invitee = await throwaway('Ivo');
  const requester = await throwaway('Rae');
  const circleName = `${RUN} Builders circle`;
  const circleId = await createCircle(owner, circleName);
  for (const other of [invitee, rex]) {
    const [a, b] = owner.id < other.id ? [owner.id, other.id] : [other.id, owner.id];
    await pool.query(`INSERT INTO dm_conversations (user_a_id, user_b_id, last_message_at) VALUES ($1, $2, NOW())`, [a, b]);
  }
  // A closed account who is in the circle: never in its member list.
  await pool.query(`INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, 'member')`, [circleId, rex.id]);
  // The invitee's page is open (and its live connection up) before anything is sent to them.
  const inv = (await openAs(browser, invitee, '/circles')).page;
  await expect(inv.getByRole('button', { name: 'Notifications' })).toBeVisible({ timeout: SLOW });
  const o = (await openAs(browser, owner, `/circles/${circleId}`)).page;
  await acceptConfirmDialogs(o);
  const members = o.getByTestId('circle-members');
  await expect(members.getByText(owner.displayName)).toBeVisible({ timeout: SLOW });
  await markNotReloaded(o);

  await test.step('7.4 removed: a closed account is in neither the member list nor the invite sheet', async () => {
    await expect(members.getByText(rex.displayName)).toHaveCount(0);
    await o.getByTestId('circle-invite').click();
    const sheet = o.getByRole('dialog', { name: 'Invite people' });
    await expect(sheet.getByTestId(`invite-candidate-${invitee.id}`)).toBeVisible({ timeout: SLOW });
    await expect(sheet.getByTestId(`invite-candidate-${rex.id}`)).toHaveCount(0);
  });

  await test.step('7.4 invite from the sheet; the invitee\'s bell rings live, Accept lands on the circle, the owner\'s list shows them live', async () => {
    const sheet = o.getByRole('dialog', { name: 'Invite people' });
    await sheet.getByTestId(`invite-candidate-${invitee.id}`).click();
    await sheet.getByTestId('invite-send').click();
    await expect(sheet.getByTestId(`invite-candidate-${invitee.id}`)).toContainText('Invited', { timeout: LIVE });
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(bellCount(inv), 'the invitee\'s bell, without a reload').toBeVisible({ timeout: LIVE });
    await inv.getByRole('button', { name: 'Notifications' }).click();
    await inv.getByTestId('notification-row').filter({ hasText: circleName }).first().getByRole('button', { name: 'Accept' }).click();
    await inv.waitForURL(new RegExp(`/circles/${circleId}`), { timeout: 30_000 });
    await expect(members.getByText(invitee.displayName), 'the owner\'s page, without a reload').toBeVisible({ timeout: LIVE });
  });

  await test.step('7.5 Closed: a non-member sees the locked page and asks; the owner approves live; the page unlocks live', async () => {
    await o.getByTestId('manage-open').click(); // Shirley pilot S3: Who can join is in the Manage menu
    await o.getByTestId('circle-settings').click();
    await o.getByTestId('circle-policy-closed').check();
    await o.getByTestId('circle-policy-save').click();
    await expect(o.getByTestId('circle-closed-badge')).toBeVisible({ timeout: LIVE });
    await o.getByTestId('circle-requests-open').click();
    const requests = o.getByTestId('circle-requests');
    await expect(requests.getByText('Nobody is waiting to join.')).toBeVisible({ timeout: LIVE });
    const req = (await openAs(browser, requester, `/circles/${circleId}`)).page;
    await expect(req.getByTestId('circle-locked')).toContainText('This circle is closed. Ask to join to see its wall, members and events.', { timeout: SLOW });
    await expect(req.getByTestId('circle-members')).toHaveCount(0);
    expect((await api(requester, 'GET', `/circles/${circleId}/members`)).status, 'the server hides its members too').toBeGreaterThanOrEqual(400);
    await markNotReloaded(req);
    await req.getByTestId(`circle-join-${circleId}`).click();
    const ask = requests.getByTestId(`circle-request-${requester.id}`);
    await expect(ask, 'the owner\'s panel, without a reload').toBeVisible({ timeout: LIVE });
    await ask.getByRole('button', { name: 'Approve' }).click();
    await o.keyboard.press('Escape');
    await expect(req.getByTestId('circle-locked'), 'the requester\'s page unlocks without a reload').toHaveCount(0, { timeout: LIVE });
    await expect(req.getByTestId('circle-members').getByText(requester.displayName)).toBeVisible({ timeout: LIVE });
    await expectNotReloaded(req, 'the requester\'s circle page');
  });

  await test.step('7.6 New pod from the circle: made and attached in one step; the owner\'s other browser lists it live', async () => {
    const other = (await openAs(browser, owner, `/circles/${circleId}`)).page;
    await expect(other.getByTestId('circle-pods')).toBeVisible({ timeout: SLOW });
    await markNotReloaded(other);
    await o.getByTestId('circle-new-pod').click();
    const form = o.getByRole('dialog', { name: `New pod in ${circleName}` });
    await form.getByLabel('Pod name').fill(`${RUN} Breakfast pod`);
    const madePod = o.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/pods');
    await o.getByRole('button', { name: 'Create Pod' }).click();
    const res = await madePod;
    expect(res.status()).toBe(201);
    made.pods.push((await res.json()).data.id);
    await expect(o.getByText(`${RUN} Breakfast pod is created and added to ${circleName}.`)).toBeVisible({ timeout: LIVE });
    await expect(other.getByTestId('circle-pods').getByText(`${RUN} Breakfast pod`), 'the other browser, without a reload').toBeVisible({ timeout: LIVE });
    expect(new URL(o.url()).pathname).toBe(`/circles/${circleId}`);
    await expectNotReloaded(other, 'the owner\'s other browser');
  });

  await test.step('7.4 legacy: a circle whose creator has no membership row is still run by its creator', async () => {
    const legacyId = (await pool.query<{ id: string }>(
      `INSERT INTO circles (name, created_by, member_count) VALUES ($1, $2, 0) RETURNING id`, [`${RUN} Old circle`, ana.id])).rows[0].id;
    made.circles.push(legacyId);
    const page = (await openAs(browser, ana, `/circles/${legacyId}`)).page;
    await expect(page.getByRole('heading', { name: `${RUN} Old circle`, level: 1 })).toBeVisible({ timeout: SLOW });
    await expect(page.getByTestId('circle-invite')).toBeVisible();
    await expect(page.getByTestId('circle-schedule-event')).toBeVisible();
  });
});

// ═══ 8. Logo and admin ══════════════════════════════════════════════════════════════════════════════════════════

test('8.1: the official sheep and REASON top left, whole, signed in and out; the manifest is served', async () => {
  test.setTimeout(120_000);
  const manifest = await fetch(`${APP}/manifest.webmanifest`);
  expect(manifest.status).toBe(200);
  expect((await manifest.json()).name).toBe('REASON');
  const page = (await openAs(browser, bo, '/')).page;
  const logo = page.locator('img[src="/reason-mark-small.png"]:visible').first();
  await expect(logo).toBeVisible({ timeout: SLOW });
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(480);
  const inside = await logo.evaluate((img: HTMLImageElement) => {
    const r = img.getBoundingClientRect();
    const link = img.closest('a')!.getBoundingClientRect();
    return r.left >= link.left - 0.5 && r.right <= link.right + 0.5 && r.top >= link.top - 0.5 && r.bottom <= link.bottom + 0.5 && r.top >= 0;
  });
  expect(inside, 'the mark sits whole inside its link').toBe(true);
  await shot(page, 'e-8.1-logo');
});

test('8.2, 8.3: an admin removes a member in an in-page dialog that says what happened; they leave a second member\'s People, pod and inbox live; Reactivate brings them back', async () => {
  test.setTimeout(300_000);
  const target = await throwaway('Tess');
  const friend = await throwaway('Finn');
  const podId = await seedPod(friend, `${RUN} Friends pod`, [target]);
  const [a, b] = friend.id < target.id ? [friend.id, target.id] : [target.id, friend.id];
  const conv = await pool.query<{ id: string }>(`INSERT INTO dm_conversations (user_a_id, user_b_id, last_message_at) VALUES ($1, $2, NOW()) RETURNING id`, [a, b]);
  await pool.query(`INSERT INTO direct_messages (conversation_id, from_user_id, content) VALUES ($1, $2, $3)`, [conv.rows[0].id, target.id, `An old hello ${RUN}`]);
  const people = await openAs(browser, friend, '/connections', { width: DEVICE ? undefined : 1280 });
  const podPage = await people.ctx.newPage();
  const inbox = await people.ctx.newPage();
  await expect(people.page.getByText(target.displayName).first()).toBeVisible({ timeout: SLOW });
  await gotoRetry(podPage, `${APP}/pods/${podId}`);
  await expect(podPage.locator('#pod-members').getByText(target.displayName)).toBeVisible({ timeout: SLOW });
  await gotoRetry(inbox, `${APP}/messages`);
  await expect(inbox.getByText(target.displayName).first()).toBeVisible({ timeout: SLOW });
  const adminPage = (await openAs(browser, admin, '/admin/users', { width: DEVICE ? undefined : Math.max(RUN_WIDTH, 1024) })).page;
  await adminPage.getByPlaceholder('Search by name or email...').fill(target.displayName);
  const row = adminPage.getByTestId(`admin-user-${target.id}`);

  await test.step('8.2 Remove asks in the page, then says what happened in a sentence', async () => {
    await expect(adminPage.getByTestId('admin-users-list-active').getByTestId(`admin-user-${target.id}`)).toBeVisible({ timeout: SLOW });
    await row.getByTestId(`admin-user-remove-${target.id}`).click();
    await adminPage.getByRole('dialog', { name: `Remove ${target.displayName}?` }).getByTestId('confirm-dialog-confirm').click();
    await expect(adminPage.getByText(`${target.displayName} was removed. They are under Removed now.`)).toBeVisible({ timeout: LIVE });
    await expect(adminPage.getByTestId('admin-users-list-active').getByTestId(`admin-user-${target.id}`)).toHaveCount(0, { timeout: LIVE });
  });

  await test.step('8.3 the removed member leaves People, the pod and the inbox of an open browser; the old chat says Former member', async () => {
    await expect(people.page.getByText(target.displayName)).toHaveCount(0, { timeout: LIVE });
    await expect(podPage.locator('#pod-members').getByText(target.displayName)).toHaveCount(0, { timeout: LIVE });
    await expect(inbox.getByText(target.displayName)).toHaveCount(0, { timeout: LIVE });
    await expect(inbox.getByText('Former member').first()).toBeVisible({ timeout: LIVE });
  });

  await test.step('8.3 Reactivate brings them back, live', async () => {
    await adminPage.getByTestId('admin-users-tab-deactivated').click();
    const removedRow = adminPage.getByTestId('admin-users-list-deactivated').getByTestId(`admin-user-${target.id}`);
    await removedRow.getByTestId(`admin-user-activate-${target.id}`).click();
    await adminPage.getByRole('dialog', { name: `Reactivate ${target.displayName}?` }).getByTestId('confirm-dialog-confirm').click();
    await expect(adminPage.getByText(`${target.displayName} is active again. They are under Active now.`)).toBeVisible({ timeout: LIVE });
    await expect(people.page.getByText(target.displayName).first()).toBeVisible({ timeout: LIVE });
    await expect(podPage.locator('#pod-members').getByText(target.displayName)).toBeVisible({ timeout: LIVE });
  });
});

