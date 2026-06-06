import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke for S12-C1 (pre-event co-host) against PRODUCTION — Ali's
// described flow, browser-proven end to end:
//   1. PRE-START: the director opens the live page, opens the participant
//      drawer, and makes user A a co-host (the toggle used to be
//      director-only AND the page used to hide host surfaces pre-start).
//   2. User A — already on the page — gains the host surface (Control
//      Center opener); a RELOAD (fresh join) keeps it: joining the event
//      as a pre-assigned co-host lands you as a co-host.
//   3. IN-EVENT: the director promotes user B too (mid-event promote), and
//      DEMOTES pre-event co-host A — A's host surface disappears live.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser;
let browser: Browser;
const sockets: Socket[] = [];

function connectSocket(user: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: user.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 10000);
  });
}

async function gotoLive(page: Page, sessionId: string): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'commit', timeout: 45_000 });
      return;
    } catch (e) {
      if (i === 3) throw e;
      await page.waitForTimeout(5000);
    }
  }
}

async function openUserPage(user: TestUser, sessionId: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoLive(page, sessionId);
  return { context, page };
}

const HCC = 'button[title="Open Host Control Center"]';

async function hasHostSurface(page: Page): Promise<boolean> {
  return page.locator(HCC).first().isVisible().catch(() => false);
}

async function waitHostSurface(page: Page, want: boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await hasHostSurface(page)) === want) { console.log(`  ✓ ${label}`); return; }
    await page.waitForTimeout(1000);
  }
  throw new Error(`${label}: host surface did not become ${want} within ${timeoutMs}ms`);
}

test.beforeAll(async () => {
  host = await createTestUser('pchhost', 'super_admin');
  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  const result = await cleanupTestData();
  console.log('Cleanup:', result);
  await closePool();
});

test('pre-event co-host: assigned before start, lands as co-host, in-event promote + demote', async () => {
  test.setTimeout(420_000);

  const userA = await createTestUser('pch1');
  const userB = await createTestUser('pch2');
  const pod = await createPod(host, 'E2E PreCohost Pod');
  for (const u of [userA, userB]) await addPodMember(host, pod.id, u.id);
  const sess = await createSession(host, pod.id, 'E2E PreCohost Smoke', new Date(Date.now() + 120_000), {
    numberOfRounds: 1, roundDurationSeconds: 300,
  });
  const sessionId = sess.id;
  await Promise.all([userA, userB].map((u) => registerForSession(u, sessionId)));

  // ── PRE-START: nobody has started the event ──
  const hostPg = await openUserPage(host, sessionId);
  const aPg = await openUserPage(userA, sessionId);
  const bPg = await openUserPage(userB, sessionId);
  await hostPg.page.waitForTimeout(8000);

  expect(await hasHostSurface(hostPg.page), 'director sees the Control Center PRE-START (C1)').toBe(true);
  console.log('  ✓ director has the host surface before the event starts');
  expect(await hasHostSurface(aPg.page), 'user A is a plain participant initially').toBe(false);

  // Director opens the participant drawer and makes A a co-host — pre-start.
  await hostPg.page.locator('button[aria-label="Participants"]').first().click();
  const makeA = hostPg.page.locator(`button[aria-label="Make ${userA.displayName} a co-host"]`).first();
  await expect(makeA, 'co-host toggle visible for the director pre-start').toBeVisible({ timeout: 15_000 });
  await makeA.click();
  await expect(hostPg.page.getByText('Co-Host', { exact: true }).first(),
    'Co-Host badge appears in the drawer').toBeVisible({ timeout: 15_000 });
  console.log('  ✓ PRE-START assignment: A is a co-host (badge visible)');

  // A gains the host surface live…
  await waitHostSurface(aPg.page, true, 'A gains the Control Center (live push)');
  // …and KEEPS it on a fresh join (reload = "when they join they are co-host").
  await aPg.page.reload({ waitUntil: 'commit' }).catch(() => {});
  await aPg.page.waitForTimeout(6000);
  await waitHostSurface(aPg.page, true, 'A still a co-host after a fresh page join');

  // ── START the event ──
  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  await new Promise<void>((r) => { hostSock.emit('host:start_session', { sessionId }); setTimeout(r, 3000); });
  await hostPg.page.waitForTimeout(5000);

  // IN-EVENT: promote B from the drawer.
  const makeB = hostPg.page.locator(`button[aria-label="Make ${userB.displayName} a co-host"]`).first();
  if (!(await makeB.isVisible().catch(() => false))) {
    await hostPg.page.locator('button[aria-label="Participants"]').first().click();
  }
  await expect(makeB, 'co-host toggle for B visible mid-event').toBeVisible({ timeout: 15_000 });
  await makeB.click();
  await waitHostSurface(bPg.page, true, 'IN-EVENT promote: B gains the Control Center');

  // IN-EVENT: demote the PRE-EVENT co-host A.
  // Presence settle: right after start, a freshly-reloaded participant can
  // take a beat to land in the host's in-room drawer (and the cohort label
  // re-syncs with the ≤30s session:state safety net). Wait for A's ROW
  // first, then the Remove toggle — covering the full re-sync window.
  const removeA = hostPg.page.locator(`button[aria-label="Remove ${userA.displayName} as co-host"]`).first();
  {
    const end = Date.now() + 45_000;
    let toggles: (string | null)[] = [];
    while (Date.now() < end) {
      if (await removeA.isVisible().catch(() => false)) break;
      toggles = await hostPg.page.locator('button[aria-label*="co-host"]').evaluateAll(
        (els) => els.map((e) => e.getAttribute('aria-label')),
      ).catch(() => []);
      await hostPg.page.waitForTimeout(2000);
    }
    console.log('  drawer co-host toggles (last poll):', JSON.stringify(toggles));
  }
  await expect(removeA, 'demote toggle visible for A (within the re-sync window)').toBeVisible({ timeout: 5_000 });
  await removeA.click();
  await waitHostSurface(aPg.page, false, 'IN-EVENT demote: A loses the Control Center');

  try { await endSession(host, sessionId); } catch {}
  for (const s of [hostPg, aPg, bPg]) { await s.context.close().catch(() => {}); }
  console.log('✓ PRE-EVENT CO-HOST smoke complete: pre-start assign → join-as-cohost → in-event promote + demote, browser-proven');
});
