import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import {
  RUN, RUN_WIDTH, DEVICE, api, cleanupRun, expectNotReloaded, launch, made, markNotReloaded, noSidewaysScroll,
  openAs, seedPod, shot, tall, throwaway, where, type TestUser,
} from '../helpers/sweep';

// ─────────────────────────────────────────────────────────────────────────────
// WHO MAY OVERRIDE, AND BUYERS AND VENDORS, ON SCREEN (11 Nov 2026, Part 3 Task 13, the preview client for Task 12's
// server). Against the preview (E2E_APP_URL = preview.rsn.network), which talks to the production API. Run twice:
// chromium at 360px (default) and E2E_DEVICE="iPhone 14" (WebKit).
//
//   cohost    a co-host sees the choice as a read-only line, "Only the event's owner can change who may override these
//             rules.", and no tiles.
//   owner     the owner sees "Who can override these rules" with the tiles "Only me" (chosen) and "Me and my
//             co-hosts", each 44px and inside the screen; choosing the second saves (the stored choice is
//             owner_and_cohosts) with no reload, and the co-host's page, open all along, follows without a reload.
//   presets   the groups form lists a "Buyers and vendors" tile, which fills Buyers and Vendors; the create form's
//             matching style list has the "Buyers and vendors" / "Buyers meet vendors first" card.
//   widths    every new control fits the screen, and no page scrolls sideways.
//
// Throwaway accounts only (@rsn-e2e.invalid); every row deleted by id at the end.
// ─────────────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

const WIDTH = DEVICE ? RUN_WIDTH : 360;
const LIVE = 15_000;
const VENDORS_ID = '5e7b1a5e-0000-4000-8000-000000000005';

let browser: Browser;
let owner: TestUser;
let cohost: TestUser;
let podId = '';
let eventId = '';
let cohostPage: Page;

async function fitsWidth(page: Page, target: Locator, label: string): Promise<void> {
  await expect.poll(async () => {
    const box = await target.boundingBox();
    const view = page.viewportSize();
    if (!box || !view) return false;
    return box.x >= -0.5 && box.x + box.width <= view.width + 0.5;
  }, { message: `${label} fits the ${page.viewportSize()?.width}px screen`, timeout: 10_000 }).toBe(true);
}

async function storedOverride(): Promise<string | undefined> {
  const res = await api(owner, 'GET', `/sessions/${eventId}/groups`);
  return res.json?.data?.overrideBy;
}

test.beforeAll(async () => {
  browser = await launch();
  owner = await throwaway('Owner', { first: 'Olive' });
  cohost = await throwaway('Cohost', { first: 'Casey' });
  podId = await seedPod(owner, `P3T13 pod ${RUN}`, [cohost]);
  const scheduledAt = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
  const created = await api(owner, 'POST', '/sessions', {
    podId, title: `P3T13 override ${RUN}`, scheduledAt, config: { eventType: 'speed_networking', numberOfRounds: 2, maxParticipants: 20 },
  });
  expect(created.status, created.text).toBe(201);
  eventId = created.json.data.id;
  made.sessions.push(eventId);
  // Co-hosts are made from the event's registered participants (the server refuses anyone else with NOT_A_PARTICIPANT),
  // so the co-host registers first: before the groups, which would otherwise ask them for a group.
  const registered = await api(cohost, 'POST', `/sessions/${eventId}/register`);
  expect(registered.status, registered.text).toBe(201);
  const cohosted = await api(owner, 'POST', `/sessions/${eventId}/cohosts/${cohost.id}`);
  expect(cohosted.status, cohosted.text).toBeLessThan(300);
  const groups = await api(owner, 'PUT', `/sessions/${eventId}/groups`, {
    groups: [{ key: 'buyer', label: 'Buyers' }, { key: 'vendor', label: 'Vendors' }],
    question: 'Are you buying or selling?', allowMultiple: false, fallback: 'leave_unmatched',
    rounds: [{ fromRound: 1, toRound: 2, mode: 'cross_group', allowedPairs: [] }],
  });
  expect(groups.status, groups.text).toBe(200);
});

test.afterAll(async () => {
  await cleanupRun();
  await browser?.close();
});

test(`cohost: sees the choice read-only, with no tiles (${where()})`, async () => {
  test.setTimeout(120_000);
  ({ page: cohostPage } = await openAs(browser, cohost, `/sessions/${eventId}`, { width: WIDTH }));
  const setting = cohostPage.getByTestId('override-setting');
  await expect(setting).toBeVisible({ timeout: 30_000 });
  await expect(setting).toContainText('Who can override these rules');
  await expect(setting.getByTestId('override-readonly')).toContainText("Only the event's owner can change who may override these rules.");
  await expect(setting).toContainText('Now: only the owner.');
  await expect(setting.getByRole('radio')).toHaveCount(0);
  await fitsWidth(cohostPage, setting, 'the read-only setting');
  await markNotReloaded(cohostPage);
});

test(`owner: sees both tiles at 44px and switches to "Me and my co-hosts" (${where()})`, async () => {
  test.setTimeout(120_000);
  const { page } = await openAs(browser, owner, `/sessions/${eventId}`, { width: WIDTH });
  const setting = page.getByTestId('override-setting');
  await expect(setting).toBeVisible({ timeout: 30_000 });
  await expect(setting).toContainText('Who can override these rules');
  const only = setting.getByRole('radio', { name: 'Only me' });
  const both = setting.getByRole('radio', { name: 'Me and my co-hosts' });
  await expect(only).toBeChecked();
  await expect(both).not.toBeChecked();
  for (const [tile, label] of [[setting.getByTestId('override-owner'), 'Only me'], [setting.getByTestId('override-owner_and_cohosts'), 'Me and my co-hosts']] as const) {
    await tall(tile, label);
    await fitsWidth(page, tile, label);
  }
  await noSidewaysScroll(page, "the owner's event page");
  await markNotReloaded(page);
  await shot(page, 'override-owner');

  const saved = page.waitForResponse((r) => r.url().includes(`/api/sessions/${eventId}/groups`) && r.request().method() === 'PUT');
  // A press, then the checked state read with retries: the tile turns checked a tick after the press (the save's pending
  // state reaches the screen through the query client's next tick), which check()'s one immediate read can miss (iPad).
  await both.click();
  expect((await saved).status(), 'the choice was saved').toBe(200);
  await expect(both).toBeChecked({ timeout: LIVE });
  expect(await storedOverride()).toBe('owner_and_cohosts');
  await expectNotReloaded(page, "the owner's page");

  // The co-host's page, open all along, follows without a reload.
  await expect(cohostPage.getByTestId('override-setting')).toContainText('Now: the owner and the co-hosts.', { timeout: LIVE });
  await expect(cohostPage.getByTestId('override-setting').getByRole('radio')).toHaveCount(0);
  await expectNotReloaded(cohostPage, "the co-host's page");
  await shot(cohostPage, 'override-cohost');

  // The tile is checked the moment it is pressed, before the save answers: the stored choice is read after the save.
  const savedBack = page.waitForResponse((r) => r.url().includes(`/api/sessions/${eventId}/groups`) && r.request().method() === 'PUT');
  await expect(only, 'the first save has settled before the next press').toHaveAttribute('aria-disabled', 'false', { timeout: LIVE });
  await only.click();
  expect((await savedBack).status(), 'the choice was saved back').toBe(200);
  await expect(only).toBeChecked({ timeout: LIVE });
  expect(await storedOverride()).toBe('owner');
  await expect(cohostPage.getByTestId('override-setting')).toContainText('Now: only the owner.', { timeout: LIVE });
});

test(`presets: Buyers and vendors is in the groups form and in the matching style list (${where()})`, async () => {
  test.setTimeout(120_000);
  const { page } = await openAs(browser, owner, `/sessions/${eventId}`, { width: WIDTH });
  await page.getByTestId('groups-edit').click();
  const tile = page.getByTestId('group-preset-buyers_vendors');
  await expect(tile).toHaveText('Buyers and vendors', { timeout: LIVE });
  await tall(tile, 'Buyers and vendors preset');
  await fitsWidth(page, tile, 'Buyers and vendors preset');
  await tile.click();
  await expect(page.getByTestId('group-label').nth(0)).toHaveValue('Buyers');
  await expect(page.getByTestId('group-label').nth(1)).toHaveValue('Vendors');
  await expect(page.getByLabel('The question people answer when they register')).toHaveValue('Are you buying or selling?');
  await noSidewaysScroll(page, 'the groups form');
  await shot(page, 'override-groups-form');

  const create = await openAs(browser, owner, `/sessions/new?podId=${podId}`, { width: WIDTH });
  await create.page.getByRole('radio', { name: /^Speed networking/ }).click();
  const presets = create.page.getByTestId('matching-presets');
  const card = presets.getByRole('radio', { name: /^Buyers and vendors/ });
  await expect(presets).toContainText('Buyers meet vendors first', { timeout: LIVE });
  await expect(card).toBeVisible();
  // `has` is looked for inside each label, so it is the radio on its own (`card` starts from the list, which no label holds).
  const label = presets.locator('label').filter({ has: create.page.getByRole('radio', { name: /^Buyers and vendors/ }) });
  await tall(label, 'Buyers and vendors card');
  await fitsWidth(create.page, label, 'Buyers and vendors card');
  await card.check();
  await expect(card).toBeChecked();
  await noSidewaysScroll(create.page, 'the create form');
  await shot(create.page, 'override-create-style');
  const list = await api(owner, 'GET', '/sessions/matching-presets');
  expect((list.json.data as Array<{ id: string; name: string }>).some((p) => p.id === VENDORS_ID && p.name === 'Buyers and vendors')).toBe(true);
});
