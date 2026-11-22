// e2e/tests/p2-matching-board.spec.ts
//
// Part 2 Task 13 (10 Nov 2026 spec, 06 and 07; acceptance 12/06 to 12/10): the organiser matching board on the preview.
// A throwaway host runs a founder / funder event (6 founders, 4 funders, every round "only different groups meet",
// people left over wait) and plans it on /sessions/:id/board.
//
// Desktop (Chromium, E2E_WIDTH 1280, drag and drop):
//   12/06 Auto generate: no room of rounds 1-3 holds two founders.
//   12/07 Founder A dragged onto funder B's occupied seat (round 2): the room checker refuses it with the reason and
//         the alternatives; as the event's owner the host seats them anyway; both are still on the board, swapped.
//   12/08 A room of round 1 is locked; a founder is dragged into the basket ("{n+1} people waiting"); Redistribute
//         seats the basket into the free seat with a valid partner, the count is back, nobody is lost, and the locked
//         room is untouched.
//   12/09 Auto generate again: the locked pair is the same two people in the same room.
//   12/10 Version 1 is published; a funder is marked late from round 2 (MoveSheet, then their meetings), round 1 is
//         redistributed, version 2 is published, and the late funder's notifications say "Your meetings for {title}
//         changed" (needs Task 9's publish routes on the server).
//   Two tabs: the second tab edits first; the first tab (its refetches held back, so it still shows the older board)
//         drops someone and is told "The board changed while you were editing..." and shows the new board.
// Phone (E2E_DEVICE="iPhone 14"): the same swap and basket steps through MoveSheet only, every row of the sheet 44px or
//   more, the page never wider than the window.
// Screenshots of the round view and the all-rounds view go to E2E_SHOTS_DIR (390 on the phone run, 1280 on desktop).
//
// People hold their place through the registration route with their group (`groupKeys`), the same write Task 6's call
// link registration makes. Throwaway accounts only (<id>@rsn-e2e.invalid), deleted by id with their pod and event.

import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  DEVICE, RUN, api, cleanupRun, launch, noSidewaysScroll, openAs, seedPod, shot, tall, throwaway, where, type TestUser,
} from '../helpers/sweep';
import { expectReachable } from '../helpers/viewport-fit';

const SLOW = 60_000;
const TITLE = `${RUN} founders and funders`;
const STALE = 'The board changed while you were editing. It is up to date now; try again.';

let browser: Browser;
let host: TestUser;
const founders: TestUser[] = [];
const funders: TestUser[] = [];
let eventId = '';

interface Seat { userId: string; displayName: string }
interface Room { roomNumber: number; seats: Seat[]; locked: boolean; verdict: { ok: boolean } }
interface Round { roundNumber: number; rooms: Room[]; basket: Seat[] }
interface Board { revision: number; rounds: Round[] }

const isFounder = (id: string) => founders.some((f) => f.id === id);
const isFunder = (id: string) => funders.some((f) => f.id === id);
const ids = (room: Room | undefined) => (room?.seats ?? []).map((s) => s.userId).sort();

async function board(): Promise<Board> {
  const res = await api(host, 'GET', `/sessions/${eventId}/schedule`);
  expect(res.status, res.text).toBe(200);
  return res.json.data as Board;
}
const roundOf = (b: Board, n: number) => b.rounds.find((r) => r.roundNumber === n)!;
const roomWith = (r: Round, userId: string) => r.rooms.find((room) => room.seats.some((s) => s.userId === userId));
const seatedCount = (r: Round) => r.rooms.reduce((n, room) => n + room.seats.length, 0);

const chip = (page: Page, userId: string) => page.getByTestId(`board-person-${userId}`);
const basketCount = (page: Page) => page.getByTestId('board-basket-count');
const waiting = (n: number) => `${n} ${n === 1 ? 'person' : 'people'} waiting`;
const roomLabel = (n: number) => `Room ${String(n).padStart(2, '0')}`;

/**
 * Drag a seated person into the basket as an organiser does on a board taller than the window: the basket is below the
 * fold, so the drag starts on the person, the basket's drop zone pins itself to the foot of the window, and the person
 * is dropped there. (A dragTo the basket itself scrolled the board mid-drag and the drag never started: preview smoke,
 * 11 Nov.)
 */
async function dragToBasket(page: Page, userId: string): Promise<void> {
  const source = chip(page, userId);
  await source.scrollIntoViewIfNeeded();
  const s = (await source.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 12, s.y + s.height / 2 + 12, { steps: 4 });
  const zone = page.getByTestId('board-basket-dropzone');
  await expect(zone).toBeVisible();
  // Inside the window and the topmost thing at its centre: never under the phone-width bottom bar.
  const z = await expectReachable(page, zone, 'the basket drop zone');
  await page.mouse.move(z.cx, z.cy, { steps: 8 });
  await page.mouse.up();
  await expect(zone).toBeHidden();
}

async function openRound(page: Page, n: number): Promise<void> {
  await page.getByRole('button', { name: `Round ${n}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `ROUND ${String(n).padStart(2, '0')} / MATCHING BOARD` })).toBeVisible();
}

/** Auto generate, answering the "plan every round again?" question when the board already has meetings. */
async function autoGenerate(page: Page): Promise<void> {
  const before = (await board()).revision;
  await page.getByRole('toolbar', { name: 'Board actions' }).getByRole('button', { name: 'Auto generate' }).click();
  const confirm = page.getByTestId('confirm-dialog-confirm');
  if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) await confirm.click();
  await expect.poll(async () => (await board()).revision, { timeout: SLOW }).toBeGreaterThan(before);
}

/** A founder seated in round `n` with a funder, in an unlocked room other than `not`. */
function founderPairIn(r: Round, not: number[] = []): { founder: string; funder: string; room: number } {
  const room = r.rooms.find((x) => !x.locked && !not.includes(x.roomNumber) && x.seats.length === 2
    && x.seats.some((s) => isFounder(s.userId)) && x.seats.some((s) => isFunder(s.userId)));
  expect(room, `round ${r.roundNumber} has an unlocked founder and funder room`).toBeTruthy();
  return {
    founder: room!.seats.find((s) => isFounder(s.userId))!.userId,
    funder: room!.seats.find((s) => isFunder(s.userId))!.userId,
    room: room!.roomNumber,
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = await launch();
  host = await throwaway('Hana');
  for (const name of ['Ada', 'Ben', 'Cleo', 'Dev', 'Esme', 'Femi']) founders.push(await throwaway(name));
  for (const name of ['Gus', 'Hal', 'Iris', 'Jo']) funders.push(await throwaway(name));
  const podId = await seedPod(host, `${RUN} board pod`, [...founders, ...funders]);

  // A week out, three rounds: no job looks at it during the run.
  const created = await api(host, 'POST', '/sessions', {
    podId, title: TITLE, description: 'E2E matching board', scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    config: { eventType: 'speed_networking', numberOfRounds: 3, maxParticipants: 50, roundDurationSeconds: 480 },
  });
  expect(created.status, created.text).toBe(201);
  eventId = created.json.data.id;

  const groups = await api(host, 'PUT', `/sessions/${eventId}/groups`, {
    groups: [{ key: 'founder', label: 'Founders' }, { key: 'funder', label: 'Funders' }],
    question: 'Are you a founder or a funder?', allowMultiple: false, fallback: 'leave_unmatched',
    rounds: [{ fromRound: 1, toRound: 3, mode: 'cross_group', allowedPairs: [] }],
  });
  expect(groups.status, groups.text).toBe(200);
  for (const f of founders) expect((await api(f, 'POST', `/sessions/${eventId}/register`, { groupKeys: ['founder'] })).status).toBe(201);
  for (const f of funders) expect((await api(f, 'POST', `/sessions/${eventId}/register`, { groupKeys: ['funder'] })).status).toBe(201);
  console.log(`[p2-matching-board] ${where()} event=${eventId}`);
});

test.afterAll(async () => {
  await cleanupRun();
  await browser?.close().catch(() => undefined);
});

test('desktop: generate, swap by drag, basket and redistribute, lock and regenerate, late and publish, a stale tab', async () => {
  test.skip(!!DEVICE, 'The desktop run drags; the phone run below uses MoveSheet.');
  test.setTimeout(600_000);
  const { page, errors } = await openAs(browser, host, `/sessions/${eventId}/board`);
  await expect(page.getByRole('heading', { name: 'ROUND 01 / MATCHING BOARD' })).toBeVisible({ timeout: SLOW });
  await expect(basketCount(page)).toHaveText(waiting(10));
  await noSidewaysScroll(page, 'the empty board');

  await test.step('12/06 Auto generate: no room of rounds 1-3 holds two founders', async () => {
    await autoGenerate(page);
    const b = await board();
    for (const n of [1, 2, 3]) {
      for (const room of roundOf(b, n).rooms) {
        expect(room.seats.filter((s) => isFounder(s.userId)).length, `round ${n} ${roomLabel(room.roomNumber)}`).toBeLessThanOrEqual(1);
      }
    }
    await expect(page.getByTestId('board-room-1')).toBeVisible();
    await shot(page, 'board-round');
  });

  let locked = { room: 0, people: [] as string[] };
  await test.step('lock a meeting of round 1 from its card', async () => {
    const r1 = roundOf(await board(), 1);
    const room = r1.rooms[0];
    locked = { room: room.roomNumber, people: ids(room) };
    await page.getByRole('button', { name: `Lock ${roomLabel(room.roomNumber)}` }).click();
    await expect(page.getByRole('button', { name: `Unlock ${roomLabel(room.roomNumber)}` })).toBeVisible();
    await expect.poll(async () => roundOf(await board(), 1).rooms.find((x) => x.roomNumber === locked.room)?.locked).toBe(true);
  });

  await test.step('12/07 founder A onto funder B\'s occupied seat: refused with the reason, seated anyway by the owner, both swapped', async () => {
    await openRound(page, 2);
    const r2 = roundOf(await board(), 2);
    const a = founderPairIn(r2);
    const b = founderPairIn(r2, [a.room]);
    await chip(page, a.founder).dragTo(chip(page, b.funder));
    const refusal = page.getByRole('dialog', { name: "That move doesn't fit" });
    await expect(refusal).toBeVisible({ timeout: SLOW });
    await expect(refusal.getByTestId('board-refusal-message')).toContainText("can't meet in this round");
    await refusal.getByRole('button', { name: 'Seat them anyway' }).click();
    await expect.poll(async () => {
      const now = roundOf(await board(), 2);
      return [roomWith(now, a.founder)?.roomNumber, roomWith(now, b.funder)?.roomNumber];
    }, { timeout: SLOW }).toEqual([b.room, a.room]);
    await expect(chip(page, a.founder)).toBeVisible();
    await expect(chip(page, b.funder)).toBeVisible();
  });

  let lateFunder = '';
  await test.step('12/08 a founder dragged into the basket, then Redistribute: a valid free seat, the locked room untouched', async () => {
    await openRound(page, 1);
    const r1 = roundOf(await board(), 1);
    const a = founderPairIn(r1, [locked.room]);
    lateFunder = a.funder;
    const waitingBefore = r1.basket.length;
    await dragToBasket(page, a.founder);
    await expect(basketCount(page)).toHaveText(waiting(waitingBefore + 1), { timeout: SLOW });
    await page.getByRole('button', { name: 'Redistribute' }).click();
    await expect(basketCount(page)).toHaveText(waiting(waitingBefore), { timeout: SLOW });
    const now = roundOf(await board(), 1);
    const refilled = roomWith(now, a.funder)!;
    expect(refilled.seats).toHaveLength(2);
    expect(refilled.verdict.ok).toBe(true);
    expect(refilled.seats.filter((s) => isFounder(s.userId))).toHaveLength(1);
    expect(seatedCount(now) + now.basket.length).toBe(10);
    const kept = now.rooms.find((x) => x.roomNumber === locked.room)!;
    expect([kept.locked, ids(kept)]).toEqual([true, locked.people]);
    console.log(`  founder A is ${roomWith(now, a.founder) ? 'seated' : 'waiting'} after Redistribute`);
  });

  await test.step('12/09 Auto generate again: the locked pair is the same two people in the same room', async () => {
    await autoGenerate(page);
    const kept = roundOf(await board(), 1).rooms.find((x) => x.roomNumber === locked.room)!;
    expect([kept.locked, ids(kept)]).toEqual([true, locked.people]);
    await expect(page.getByRole('button', { name: `Unlock ${roomLabel(locked.room)}` })).toBeVisible();
  });

  await test.step('12/10 publish version 1; a funder marked late from round 2; redistribute; version 2 tells them', async () => {
    await page.getByRole('toolbar', { name: 'Board actions' }).getByRole('button', { name: 'Publish' }).click();
    const panel = page.getByRole('dialog', { name: 'Publish the board' });
    await panel.getByRole('button', { name: 'Publish version 1' }).click({ timeout: SLOW });
    await expect(panel.getByTestId('publish-done')).toHaveText('Version 1 published', { timeout: SLOW });
    await panel.getByRole('button', { name: 'Close' }).click();

    // The late funder: seated in round 1 outside the locked meeting (generate may have moved them).
    const r1 = roundOf(await board(), 1);
    lateFunder = founderPairIn(r1, [locked.room]).funder;
    await chip(page, lateFunder).click();
    const sheetTitle = new RegExp(`, round 1$`);
    await page.getByRole('dialog', { name: sheetTitle }).getByTestId('move-show-meetings').click();
    const timeline = page.getByRole('dialog', { name: /'s meetings$/ });
    await timeline.getByRole('combobox', { name: 'Arrives for round' }).selectOption('2');
    await timeline.getByRole('button', { name: 'Mark late' }).click();
    await expect.poll(async () => !!roomWith(roundOf(await board(), 1), lateFunder), { timeout: SLOW }).toBe(false);
    await page.getByRole('button', { name: 'Redistribute' }).click();

    await page.getByRole('toolbar', { name: 'Board actions' }).getByRole('button', { name: 'Publish' }).click();
    await panel.getByRole('button', { name: 'Publish version 2' }).click({ timeout: SLOW });
    await expect(panel.getByTestId('publish-done')).toHaveText('Version 2 published', { timeout: SLOW });
    await panel.getByRole('button', { name: 'Close' }).click();
    const late = funders.find((f) => f.id === lateFunder)!;
    await expect.poll(async () => {
      const bell = await api(late, 'GET', '/notifications');
      return (bell.json?.data?.notifications ?? []).some((n: { title: string }) => n.title === `Your meetings for ${TITLE} changed`);
    }, { timeout: SLOW }).toBe(true);
  });

  await test.step('two tabs: the second edits first, the first is told the board changed and shows the new board', async () => {
    const second = await openAs(browser, host, `/sessions/${eventId}/board`);
    await expect(second.page.getByRole('heading', { name: 'ROUND 01 / MATCHING BOARD' })).toBeVisible({ timeout: SLOW });
    // The first tab hears nothing new: its refetches of the board are held back, so it still shows the older board.
    await page.route('**/api/sessions/*/schedule', (route) => route.abort());
    await openRound(page, 1);
    await second.page.getByRole('button', { name: `Unlock ${roomLabel(locked.room)}` }).click();
    await expect(second.page.getByRole('button', { name: `Lock ${roomLabel(locked.room)}` })).toBeVisible({ timeout: SLOW });
    await expect(page.getByRole('button', { name: `Unlock ${roomLabel(locked.room)}` })).toBeVisible();

    const r1 = roundOf(await board(), 1);
    const someone = founderPairIn(r1, [locked.room]).founder;
    await dragToBasket(page, someone);
    await expect(page.getByText(STALE)).toBeVisible({ timeout: SLOW });
    // The board the server sent back is on screen: the meeting the second tab unlocked reads unlocked here too.
    await expect(page.getByRole('button', { name: `Lock ${roomLabel(locked.room)}` })).toBeVisible();
    await page.unroute('**/api/sessions/*/schedule');
  });

  await test.step('the all-rounds view, its table scrolling inside its own frame', async () => {
    await page.getByRole('button', { name: 'All rounds' }).click();
    await expect(page.getByRole('heading', { name: 'ALL ROUNDS / MATCHING BOARD' })).toBeVisible();
    await expect(page.getByTestId('board-overview-row').first()).toBeVisible();
    await noSidewaysScroll(page, 'the all-rounds view');
    await shot(page, 'board-all-rounds');
  });
  expect(errors).toEqual([]);
});

test('phone: the same swap and basket through MoveSheet only, 44px rows, never wider than the window', async () => {
  test.skip(!DEVICE, 'The phone run (E2E_DEVICE="iPhone 14") selects and moves; the desktop run above drags.');
  test.setTimeout(600_000);
  const { page, errors } = await openAs(browser, host, `/sessions/${eventId}/board`);
  await expect(page.getByRole('heading', { name: 'ROUND 01 / MATCHING BOARD' })).toBeVisible({ timeout: SLOW });
  await noSidewaysScroll(page, 'the empty board on a phone');
  await autoGenerate(page);
  await noSidewaysScroll(page, 'the generated board on a phone');
  await shot(page, 'board-round');

  /** Every button of the sheet on screen is 44px or more, and the sheet fits the window. */
  const rowsAreTall = async (name: RegExp | string) => {
    const sheet = page.getByRole('dialog', { name });
    await expect(sheet).toBeVisible();
    const buttons = sheet.getByRole('button');
    for (let i = 0; i < await buttons.count(); i++) await tall(buttons.nth(i), `sheet button ${i + 1}`);
    await noSidewaysScroll(page, 'a sheet on a phone');
    return sheet;
  };

  await test.step('12/07 by select and move: founder A, "Swap with" funder B, seated anyway by the owner', async () => {
    await openRound(page, 2);
    const r2 = roundOf(await board(), 2);
    const a = founderPairIn(r2);
    const b = founderPairIn(r2, [a.room]);
    await chip(page, a.founder).tap();
    const sheet = await rowsAreTall(/, round 2$/);
    await sheet.getByTestId(`move-swap-${b.funder}`).tap();
    const refusal = await rowsAreTall("That move doesn't fit");
    await refusal.getByRole('button', { name: 'Seat them anyway' }).tap();
    await expect.poll(async () => {
      const now = roundOf(await board(), 2);
      return [roomWith(now, a.founder)?.roomNumber, roomWith(now, b.funder)?.roomNumber];
    }, { timeout: SLOW }).toEqual([b.room, a.room]);
  });

  await test.step('12/08 by select and move: "Move to the basket", then Redistribute', async () => {
    await openRound(page, 1);
    const r1 = roundOf(await board(), 1);
    const a = founderPairIn(r1);
    const waitingBefore = r1.basket.length;
    await chip(page, a.founder).tap();
    const sheet = await rowsAreTall(/, round 1$/);
    await sheet.getByTestId('move-basket').tap();
    await expect(basketCount(page)).toHaveText(waiting(waitingBefore + 1), { timeout: SLOW });
    // The result is said in the board's live region, and focus is on the person in their new place (fix round 1).
    await expect(page.getByTestId('board-announcement')).toContainText(`is waiting in the basket. ${waiting(waitingBefore + 1)}.`);
    await expect(chip(page, a.founder)).toBeFocused();
    const redistribute = page.getByRole('button', { name: 'Redistribute' });
    await tall(redistribute, 'Redistribute');
    await redistribute.tap();
    await expect(basketCount(page)).toHaveText(waiting(waitingBefore), { timeout: SLOW });
    const now = roundOf(await board(), 1);
    expect(roomWith(now, a.funder)!.verdict.ok).toBe(true);
    expect(seatedCount(now) + now.basket.length).toBe(10);
    await noSidewaysScroll(page, 'after Redistribute on a phone');
  });

  await test.step('the all-rounds view on a phone: the table scrolls inside its frame, the page does not', async () => {
    await page.getByRole('button', { name: 'All rounds' }).tap();
    await expect(page.getByTestId('board-overview-row').first()).toBeVisible();
    await noSidewaysScroll(page, 'the all-rounds view on a phone');
    const frame = await page.getByTestId('board-overview-scroll').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(frame.scroll).toBeGreaterThan(frame.client);
    await shot(page, 'board-all-rounds');
  });
  expect(errors).toEqual([]);
});
