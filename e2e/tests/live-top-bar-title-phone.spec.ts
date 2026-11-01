import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession } from '../helpers/api';
import { APP, gotoRetry, cleanup, idsOf, teardown, connectSocket, submitIntent, wait, type Socket } from '../helpers/live-ui';
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
// Throwaway accounts only, deleted by id. E2E_ENGINE=webkit and E2E_DEVICE="iPhone 14" pick the engine and phone.

const TITLE = 'Founders and Investors Evening: Autumn Speed Networking Night';
const WIDTHS = [360, 390];

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
  await gotoRetry(memberPage, `${APP}/session/${sessionId}/live`);
  await expect(memberPage.getByRole('button', { name: 'Leave Event' })).toBeVisible({ timeout: 45_000 });
  await wait(1_500);
  await submitIntent(memberPage);
  await expectTitleReadable(memberPage, 'the member');
  await memberPage.screenshot({ path: `test-results/live-top-bar-title-member-${engineLabel().replace(/\W+/g, '-')}.png` }).catch(() => {});

  const hostPage = await open(host);
  await gotoRetry(hostPage, `${APP}/session/${sessionId}/live`);
  await expect(hostPage.getByRole('button', { name: 'Leave Event' })).toBeVisible({ timeout: 45_000 });
  await expectTitleReadable(hostPage, 'the host');
  await hostPage.screenshot({ path: `test-results/live-top-bar-title-host-${engineLabel().replace(/\W+/g, '-')}.png` }).catch(() => {});
});
