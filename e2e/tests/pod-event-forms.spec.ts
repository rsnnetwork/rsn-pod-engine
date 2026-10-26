// The pod and event forms follow the shared definition (C7, 26 Oct 2026), on a phone, in a real browser.
//
// Stefan and Claus, 25 Oct (production): a Reason pod defaulted to Timed Rounds, so they set Free Form by hand; a
// "Video meeting" showed five 8-minute rounds and ran as speed networking; the title's "Required" sat far above the
// button. This walks what replaced that:
//   A. a Reason pod made without touching orchestration is saved as Freeform (communication video, never asked);
//   B. an event from that pod opens as a Video meeting with no round settings and a filled-in title; switching to
//      Speed networking shows the rounds; switching back after editing them asks "Switching to Video meeting removes
//      the round settings (3 rounds × 8 min). Continue?"; an empty title is said at the field and beside the sticky
//      button, both in view; the event is saved as a video meeting and opens with ?invite=1.
//
// Runs against production's client by default, a preview with E2E_APP_URL (+ E2E_VERCEL_SHARE), or the local stack
// through run-local-spec.sh. Its own members only (e2etest-…), deleted by id with what they made.
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { apiRequest } from '../helpers/api';
import { APP, cleanup } from '../helpers/live-ui';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { primePreview } from '../helpers/preview-bypass';
import { expectReachable } from '../helpers/viewport-fit';

const PHONE = { width: 390, height: 844 };
let browser: Browser;
let director: TestUser;
const podIds: string[] = [];
let reasonPod: { id: string; name: string };

async function signedIn(): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true });
  await primePreview(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: director.accessToken, r: director.refreshToken });
  return ctx;
}

async function open(ctx: BrowserContext, path: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded' });
  return page;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  director = await createTestUser('c7forms');
  const res = await apiRequest(director, 'POST', '/pods', { name: `E2E C7 Reason ${Date.now()}`, podType: 'reason', visibility: 'private' });
  reasonPod = { id: res.data.id, name: res.data.name };
  podIds.push(reasonPod.id);
  browser = await launchBrowser();
});

test.afterAll(async () => {
  await browser?.close().catch(() => {});
  for (const podId of podIds) await cleanup(pool, { ids: [], podId });
  await cleanup(pool, { ids: [director.id] });
});

test(`A: a Reason pod is Freeform without touching orchestration (${engineLabel()})`, async () => {
  test.setTimeout(120_000);
  const ctx = await signedIn();
  const page = await open(ctx, '/pods?create=true');
  const sheet = page.getByRole('dialog', { name: 'Create a Pod' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByText('Communication')).toHaveCount(0);
  await sheet.getByLabel('Pod name').fill(`E2E C7 Made ${Date.now()}`);
  await sheet.getByLabel('Pod type').selectOption('reason');
  await expect(sheet.getByLabel('Orchestration')).toHaveValue('free_form');
  await expect(sheet.getByText('Up to 12 recommended')).toBeVisible();
  const submit = sheet.getByRole('button', { name: 'Create Pod' });
  await expectReachable(page, submit, 'Create Pod');
  await submit.click();
  await page.waitForURL(/\/pods\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const id = page.url().split('/').pop()!;
  podIds.push(id);
  const pod = (await apiRequest(director, 'GET', `/pods/${id}`)).data;
  expect([pod.podType, pod.orchestrationMode, pod.communicationMode]).toEqual(['reason', 'free_form', 'video']);
  await ctx.close();
});

test(`B: an event from a Reason pod follows its type, asks before dropping rounds, says an empty title at the field (${engineLabel()})`, async () => {
  test.setTimeout(180_000);
  const ctx = await signedIn();
  const page = await open(ctx, `/sessions/new?podId=${reasonPod.id}`);
  const title = page.getByLabel('Title', { exact: true });
  await expect(page.getByText(`In ${reasonPod.name} · Reason Pod`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('radio', { name: /^Video meeting/ })).toBeChecked();
  await expect(title).toHaveValue(`Video meeting · ${reasonPod.name}`);
  await expect(page.getByLabel('Number of rounds')).toHaveCount(0);
  await expect(page.getByLabel('Length')).toHaveValue('60');

  await page.getByRole('radio', { name: /^Speed networking/ }).click();
  await expect(page.getByLabel('Number of rounds')).toHaveValue('5');
  await page.getByLabel('Number of rounds').fill('3');
  await page.getByRole('radio', { name: /^Video meeting/ }).click();
  const question = page.getByRole('alert').filter({ hasText: 'Switching to Video meeting' });
  await expect(question).toHaveText(/Switching to Video meeting removes the round settings \(3 rounds × 8 min\)\. Continue\?/);
  await expectReachable(page, question.getByRole('button', { name: 'Continue' }), 'Continue');
  await question.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Number of rounds')).toHaveCount(0);
  await expect(page.getByLabel('Length')).toHaveValue('60');

  await title.fill('');
  const schedule = page.getByRole('button', { name: 'Schedule Event' });
  await schedule.click();
  await expect(page.getByText('Give your event a title')).toBeVisible();
  const summary = page.getByRole('alert').filter({ hasText: 'Fix 1 thing:' });
  await expectReachable(page, summary.getByRole('button', { name: 'Title' }), 'the summary beside the button');
  await expectReachable(page, schedule, 'Schedule Event');
  await expectReachable(page, title, 'the Title field, not under the sticky bar');

  await title.fill(`E2E C7 meeting ${Date.now()}`);
  await schedule.click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]{36}\?invite=1$/, { timeout: 30_000 });
  const sessionId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByText('Video meeting · 60 min · up to 25')).toBeVisible({ timeout: 30_000 });
  const invite = page.getByRole('button', { name: 'Invite people' });
  await expectReachable(page, invite, 'Invite people');
  expect((await invite.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const event = (await apiRequest(director, 'GET', `/sessions/${sessionId}`)).data;
  expect(event.format).toBe('video_meeting');
  expect(event.config.numberOfRounds).toBeUndefined();
  expect([event.config.durationMinutes, event.config.maxParticipants]).toEqual([60, 25]);
  await ctx.close();
});
