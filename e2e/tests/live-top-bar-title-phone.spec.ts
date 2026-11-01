import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession } from '../helpers/api';
import { APP, gotoRetry, cleanup, idsOf, teardown, connectSocket, type Socket } from '../helpers/live-ui';
import { launchBrowser, contextOptions, engineLabel } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

// ─── The live room's top bar shows the event's title on a phone (2 Nov 2026) ─────────────────────────
//
// On a 390px iPhone the room-state chip "Main Room · Round 1 of 5" and Leave Event filled the one-line top bar and
// squeezed the title's box to 0px: a member on a phone never saw which event they were in. Now the chip says
// "Round 1/5" under 640px and the title takes its own line when the controls leave it less than 10rem.
//
// At 360 and 390, for a member and for the host in the main room of a five-round event:
//   - the title's box is wider than 0, visible, and wide enough to read (its whole text, or at least 120px);
//   - the title and the controls do not overlap; Leave Event is 44px tall and reachable; nothing scrolls sideways;
//   - the chip shows "Round 1/5" and keeps its full words as its title.
// Production fix (2 Nov 2026): on production this spec found Leave Event under the member's check-in toast ("Thanks,
// we will use this for your matches."): toasts were fixed to the window's top right, over the whole bar on a phone.
// In the live room they now open below the bar. So the member's check is made while that toast is still up, and the
// toast must sit below the bar. The event runs with config.testMode=false: production never draws the test-mode
// banner (its heuristic is off there), so locally too the bar sits at the top of the screen, as a real member sees it.
// Production smoke fix (2 Nov 2026): the toast lives 2.5s, and on production a slow Set answer or a slow check-in exit
// outlasted it. The member's page now holds the toast store's own dismiss timer until the check is done, waits for the
// check-in and its backdrop to finish leaving and for the card to come to rest, reads the whole scene in one evaluate,
// then lets the timer run and sees the toast go.
// Throwaway accounts only, deleted by id. E2E_ENGINE=webkit and E2E_DEVICE="iPhone 14" pick the engine and phone.

const TITLE = 'Founders and Investors Evening: Autumn Speed Networking Night';
const WIDTHS = [360, 390];
const THANKS = 'Thanks, we will use this for your matches.';
/** A portal dialog's backdrop (client/src/components/ui/Modal.tsx), never anything inside the app's own #root. */
const CHECK_IN_BACKDROP = 'body > div.fixed.inset-0.z-50 > div[class~="bg-black/60"]';

let browser: Browser;
let host: TestUser;
let member: TestUser;
let partner: TestUser;
let podId: string;
let sessionId: string;
const contexts: BrowserContext[] = [];
const sockets: Socket[] = [];

async function open(user: TestUser): Promise<Page> {
  const ctx = await browser.newContext(contextOptions({ width: 390, height: 800 }));
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: user.accessToken, r: user.refreshToken });
  contexts.push(ctx);
  return ctx.newPage();
}

async function statusIs(status: string, ms: number): Promise<void> {
  await expect.poll(async () => (await pool.query('SELECT status FROM sessions WHERE id = $1', [sessionId])).rows[0]?.status,
    { message: `the event reaches ${status}`, timeout: ms }).toBe(status);
}

/**
 * Holds the toast store's own dismiss timer in this page until the spec releases it, so a toast stays up for as long
 * as the check takes, on any network. Only the store's timer is held (the one callback that drops toasts from the
 * list); every other timer, animation and request runs as normal. Production's 2.5s let the toast go before a slow
 * Set answer or a slow check-in exit had finished (R10u smoke).
 */
function holdToastTimers(): void {
  const held: Array<() => void> = [];
  const realSetTimeout = window.setTimeout.bind(window);
  const patched = (handler: TimerHandler, ms?: number, ...args: unknown[]): number => {
    if (typeof handler === 'function' && /toasts\s*\.\s*filter/.test(String(handler))) {
      held.push(() => (handler as (...a: unknown[]) => void)(...args));
      return 0;
    }
    return realSetTimeout(handler, ms, ...args);
  };
  window.setTimeout = patched as typeof window.setTimeout;
  const w = window as unknown as { __heldToasts: () => number; __releaseToasts: () => number };
  w.__heldToasts = () => held.length;
  w.__releaseToasts = () => { const all = held.splice(0); all.forEach((fire) => fire()); return all.length; };
}

interface Box { x: number; y: number; width: number; height: number }
interface ToastScene { vw: number; vh: number; bar: Box; card: Box; leave: Box; leaveHit: string; title: Box; titleHit: string }

/** Everything the check judges, read in one go so nothing moves between the reads. */
async function readToastScene(page: Page, title: string, thanks: string): Promise<ToastScene> {
  return page.evaluate(({ title, thanks }) => {
    const box = (el: Element): Box => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const hit = (el: Element): string => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!top) return 'nothing';
      if (top === el || el.contains(top)) return 'self';
      return `${top.tagName.toLowerCase()}.${String((top as HTMLElement).className).split(' ').slice(0, 3).join('.')}`;
    };
    const heading = Array.from(document.querySelectorAll('h2')).find((h) => h.textContent === title)!;
    const leave = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Leave Event')!;
    const message = Array.from(document.querySelectorAll('p')).find((p) => p.textContent === thanks)!;
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      bar: box(heading.parentElement!.parentElement!), card: box(message.parentElement!),
      leave: box(leave), leaveHit: hit(leave), title: box(heading), titleHit: hit(heading),
    };
  }, { title, thanks });
}

/** After the member presses Set: the "Thanks" toast is up, below the bar, and Leave Event is still reachable. */
async function expectToastBelowBar(page: Page): Promise<void> {
  const width = page.viewportSize()!.width;
  const label = `the member at ${width}px with the check-in toast up`;
  const toast = page.getByText(THANKS, { exact: true });
  await expect(toast, `${label}: the toast is shown`).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as { __heldToasts: () => number }).__heldToasts()),
    `${label}: the toast's own timer is held while it is checked`).toBeGreaterThanOrEqual(1);
  // The check-in closes as the toast opens: judge the bar once the check-in and its backdrop have finished leaving.
  await expect(page.getByRole('heading', { name: /What brings you here/i }), `${label}: the check-in has closed`).toHaveCount(0, { timeout: 15_000 });
  // The check-in is a Modal: it renders through a portal as a direct child of <body> (`fixed inset-0 z-50`), its
  // backdrop the `bg-black/60` layer inside. Only that one is waited for: the room's video tiles inside #root carry
  // `bg-black/60` name and mute badges too (on production, where the tiles are real, a page-wide match never cleared).
  await expect(page.locator(CHECK_IN_BACKDROP), `${label}: the check-in's backdrop has gone`).toHaveCount(0, { timeout: 15_000 });
  // The card slides in from the right: wait until it has come to rest.
  let previous = '';
  await expect.poll(async () => {
    const now = JSON.stringify(await toast.locator('xpath=..').boundingBox());
    const still = now === previous;
    previous = now;
    return still;
  }, { message: `${label}: the toast has come to rest`, timeout: 10_000, intervals: [150] }).toBe(true);

  const scene = await readToastScene(page, TITLE, THANKS);
  expect(scene.leaveHit, `${label}: Leave Event is the topmost thing at its centre`).toBe('self');
  expect(scene.leave.height, `${label}: Leave Event is 44px tall`).toBeGreaterThanOrEqual(44);
  expect(scene.leave.x, `${label}: Leave Event starts on the screen`).toBeGreaterThanOrEqual(0);
  expect(scene.leave.y, `${label}: Leave Event starts on the screen`).toBeGreaterThanOrEqual(0);
  expect(scene.leave.x + scene.leave.width, `${label}: Leave Event ends on the screen`).toBeLessThanOrEqual(scene.vw + 0.5);
  expect(scene.titleHit, `${label}: the title is the topmost thing at its centre`).toBe('self');
  expect(scene.title.width, `${label}: the title has width`).toBeGreaterThan(0);
  expect(scene.card.y, `${label}: the toast opens below the bar`).toBeGreaterThanOrEqual(scene.bar.y + scene.bar.height);
  expect(scene.card.x, `${label}: the toast starts on the screen`).toBeGreaterThanOrEqual(0);
  expect(scene.card.x + scene.card.width, `${label}: the toast ends on the screen`).toBeLessThanOrEqual(scene.vw + 0.5);
  await expect(toast, `${label}: the toast was up for the whole check`).toBeVisible();

  // Let the toast's own timer run: it goes as it would have, so the hold only lengthened it.
  expect(await page.evaluate(() => (window as unknown as { __releaseToasts: () => number }).__releaseToasts()), `${label}: the held timer is let go`).toBeGreaterThanOrEqual(1);
  await expect(toast, `${label}: the toast goes once its timer runs`).toHaveCount(0, { timeout: 5_000 });
}

async function expectTitleReadable(page: Page, who: string): Promise<void> {
  const height = page.viewportSize()?.height ?? 800;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height });
    const label = `${who} at ${width}px`;
    const title = page.getByRole('heading', { name: TITLE, exact: true });
    await expect(title, `${label}: the title is visible`).toBeVisible({ timeout: 30_000 });
    const chip = page.locator(`[title="Main Room · Round 1 of 5"]`);
    await expect(chip, `${label}: the chip keeps its full words as its title`).toHaveCount(1, { timeout: 30_000 });
    await expect(chip, `${label}: the chip says the round briefly`).toContainText('Round 1/5');

    // The layout settles a frame after a resize in WebKit: judge it once the title's box stops changing.
    await expect.poll(async () => (await title.boundingBox())?.width ?? 0, { message: `${label}: the title has width`, timeout: 5_000 }).toBeGreaterThan(0);
    const box = (await title.boundingBox())!;
    const natural = await title.evaluate((el) => el.scrollWidth);
    expect(box.width, `${label}: the title is wide enough to read`).toBeGreaterThanOrEqual(Math.min(natural, 120));
    expect(box.x, `${label}: the title starts on the screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${label}: the title ends on the screen`).toBeLessThanOrEqual(width + 0.5);

    const leave = page.getByRole('button', { name: 'Leave Event', exact: true });
    const leaveBox = await expectReachable(page, leave, `${label}: Leave Event`);
    expect(leaveBox.height, `${label}: Leave Event is 44px tall`).toBeGreaterThanOrEqual(44);
    const people = await expectReachable(page, page.getByRole('button', { name: 'Participants', exact: true }), `${label}: Participants`);
    for (const control of [leaveBox, people, (await chip.boundingBox())!]) {
      const overlaps = box.x < control.x + control.width && control.x < box.x + box.width
        && box.y < control.y + control.height && control.y < box.y + box.height;
      expect(overlaps, `${label}: the title and the controls do not overlap`).toBe(false);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label}: no sideways scroll`).toBe(true);
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = await launchBrowser();
  host = await createTestUser('livetitlehost', 'admin');
  member = await createTestUser('livetitlemember');
  partner = await createTestUser('livetitlepartner');
  podId = (await createPod(host, 'Live title phone pod')).id;
  await addPodMember(host, podId, member.id);
  await addPodMember(host, podId, partner.id);
  sessionId = (await createSession(host, podId, TITLE, new Date(Date.now() + 60_000), { numberOfRounds: 5, roundDurationSeconds: 600 })).id;
  // The event's own row only: no test-mode banner, as production shows none (the route does not take this field).
  await pool.query(`UPDATE sessions SET config = config || '{"testMode": false}'::jsonb WHERE id = $1`, [sessionId]);
  await registerForSession(member, sessionId);
  await registerForSession(partner, sessionId);
});

test.afterAll(async () => {
  await teardown(
    async () => { for (const s of sockets) s.disconnect(); },
    async () => { for (const c of contexts) await c.close().catch(() => {}); },
    () => browser?.close(),
    () => cleanup(pool, { ids: idsOf(host, member, partner), podId }),
  );
});

test(`[${engineLabel()}] a phone shows the live event's title next to the round and Leave Event, for a member and the host`, async () => {
  test.setTimeout(240_000);
  // The host's actions come from a socket that never joins the room, so the host's own page is never evicted by it.
  const driver = await connectSocket(host);
  sockets.push(driver);
  driver.emit('host:start_session', { sessionId });
  await statusIs('lobby_open', 30_000);
  const other = await connectSocket(partner);
  sockets.push(other);
  other.emit('session:join', { sessionId });

  const memberPage = await open(member);
  await memberPage.addInitScript(holdToastTimers);
  await memberPage.setViewportSize({ width: WIDTHS[0], height: memberPage.viewportSize()?.height ?? 800 });
  await gotoRetry(memberPage, `${APP}/session/${sessionId}/live`);
  await expect(memberPage.getByRole('button', { name: 'Leave Event', exact: true })).toBeAttached({ timeout: 45_000 });
  // Every member is asked the check-in once on entering; Set saves the answer and thanks them with a toast.
  await expect(memberPage.getByRole('heading', { name: /What brings you here/i })).toBeVisible({ timeout: 30_000 });
  await expect(memberPage.locator(CHECK_IN_BACKDROP), 'the check-in\'s backdrop is found while it is open').toHaveCount(1);
  const answered = memberPage.waitForResponse((r) => r.request().method() === 'POST' && /\/sessions\/[^/]+\/intention$/.test(new URL(r.url()).pathname), { timeout: 30_000 });
  await memberPage.getByRole('button', { name: 'Set', exact: true }).click();
  expect((await answered).ok(), 'the check-in answer is saved').toBe(true);
  await expectToastBelowBar(memberPage);
  await expectTitleReadable(memberPage, 'the member');
  await memberPage.screenshot({ path: `test-results/live-top-bar-title-member-${engineLabel().replace(/\W+/g, '-')}.png` }).catch(() => {});

  const hostPage = await open(host);
  await gotoRetry(hostPage, `${APP}/session/${sessionId}/live`);
  await expect(hostPage.getByRole('button', { name: 'Leave Event', exact: true })).toBeVisible({ timeout: 45_000 });
  await expectTitleReadable(hostPage, 'the host');
  await hostPage.screenshot({ path: `test-results/live-top-bar-title-host-${engineLabel().replace(/\W+/g, '-')}.png` }).catch(() => {});
});
