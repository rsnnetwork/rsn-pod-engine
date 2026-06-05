import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';
import { Pool } from 'pg';

// HEADED edge-case smoke for WS2/WS3 against PRODUCTION — the cases the main
// smokes left to unit pins, now browser-driven:
//
// TEST 1 (6 users → 3 pairs, one 300s round):
//   pair2 — CANCELLED ROOM: P2b's page closes ~5s into the round; the grace
//           expires on a <30s no-rating match → 'cancelled' → the survivor
//           gets NO rating form and goes straight back to the main room.
//   pair1 — LEAVE EVENT BUTTON: P1a clicks the real top-bar "Leave Event"
//           mid-round (match >30s old by then); P1b sees the waiting banner,
//           then at grace expiry the "didn't return" form ('completed').
//   pair3 — DOUBLE-LEAVE RACE + "DIDN'T WORK": both members click
//           "Back to Main Room" SIMULTANEOUSLY; FOR-UPDATE serialization
//           must give both a coherent exit (a rating form or main room, no
//           stuck room). One of them rates via the new "didn't work" action;
//           the DB row must carry excluded_from_quality_stats = TRUE.
//
// TEST 2 (3 users): TRIO MECHANICS — algorithm trio if the engine forms one
//   (odd eligible count), else a forced manual 3-person breakout. One member
//   leaves via the real button → their form covers BOTH partners (two
//   sequential partner forms); the survivors KEEP TALKING (still in the room
//   10s later). On the algorithm path the round then ends and each survivor's
//   round-end form includes THE DEPARTED (2 partners) — the departed_user_ids
//   round-trip, browser-proven.
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

async function readBreakoutSeconds(page: Page): Promise<number | null> {
  const texts = await page.locator('span.font-mono').allInnerTexts().catch(() => [] as string[]);
  for (const t of texts) {
    const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  return null;
}

async function waitForBreakout(page: Page, label: string, timeoutMs = 120_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await readBreakoutSeconds(page)) !== null) { console.log(`  ✓ ${label} in breakout`); return; }
    await page.waitForTimeout(1500);
  }
  throw new Error(`${label}: not in breakout within ${timeoutMs}ms`);
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

// S14-hardened rating submit: a stuck form still shows "How was your chat
// with", so visibility-only assertions passed even when the SUBMIT 403'd
// (the departed-member validation bug Ali caught live). Every submit must
// provably ADVANCE: the partner name changes or the form closes — and no
// error toast appears.
async function currentPartnerName(page: Page): Promise<string | null> {
  const t = await page.getByText(/How was your chat with/i).first().textContent().catch(() => null);
  return t ? t.replace(/\s+/g, ' ').trim() : null;
}

async function rateOne(page: Page, label: string): Promise<void> {
  const before = await currentPartnerName(page);
  await page.locator('button:has(svg.lucide-star)').nth(3).click(); // 4 stars
  await page.getByText('Submit Rating', { exact: true }).first().click();
  const deadline = Date.now() + 12_000;
  let advanced = false;
  while (Date.now() < deadline) {
    const failed = await page.getByText(/Failed to submit/i).first().isVisible().catch(() => false);
    expect(failed, `${label}: rating submit must not fail`).toBe(false);
    const now = await currentPartnerName(page);
    if (now === null || now !== before) { advanced = true; break; }
    await page.waitForTimeout(800);
  }
  expect(advanced, `${label}: the form must ADVANCE after submit (was stuck on "${before}")`).toBe(true);
  console.log(`  ✓ ${label}: submitted + advanced`);
}

async function settledPairs(
  hostSock: Socket, anyPage: Page, sessionId: string, expectedMatches: number,
): Promise<Array<{ a: string; b: string; c?: string }>> {
  let latest: Array<{ a: string; b: string; c?: string }> = [];
  hostSock.on('host:match_preview', (data: any) => {
    latest = (data?.matches || []).map((m: any) => ({
      a: m.participantA?.userId, b: m.participantB?.userId, c: m.participantC?.userId,
    }));
  });
  let result: Array<{ a: string; b: string; c?: string }> = [];
  for (let attempt = 1; attempt <= 8; attempt++) {
    latest = [];
    hostSock.emit('host:generate_matches', { sessionId });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && latest.length === 0) await anyPage.waitForTimeout(500);
    console.log(`  preview attempt ${attempt}: ${latest.length} matches`);
    result = latest;
    if (result.length === expectedMatches) break;
    await anyPage.waitForTimeout(4000);
  }
  return result;
}

test.beforeAll(async () => {
  host = await createTestUser('wsedgehost', 'super_admin');
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

test('edges: cancelled room (no form), Leave-Event grace, double-leave race + didnt-work flag', async () => {
  test.setTimeout(540_000);

  const users = await Promise.all(
    ['wse1', 'wse2', 'wse3', 'wse4', 'wse5', 'wse6'].map((n) => createTestUser(n)),
  );
  const pod = await createPod(host, 'E2E WS2 Edge Pod');
  const sess = await createSession(host, pod.id, 'E2E Edge Smoke', new Date(Date.now() + 60_000), {
    numberOfRounds: 1,
    roundDurationSeconds: 300,
  });
  const sessionId = sess.id;
  for (const u of users) await addPodMember(host, pod.id, u.id);
  await Promise.all(users.map((u) => registerForSession(u, sessionId)));
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  const sessions = new Map<string, { context: BrowserContext; page: Page }>();
  for (const u of users) sessions.set(u.id, await openUserPage(u, sessionId));
  await sessions.get(users[0].id)!.page.waitForTimeout(9000);

  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  hostSock.emit('session:join', { sessionId });
  await sessions.get(users[0].id)!.page.waitForTimeout(2000);
  const pairs = await settledPairs(hostSock, sessions.get(users[0].id)!.page, sessionId, 3);
  console.log('  pairs:', JSON.stringify(pairs));
  expect(pairs.length, '6 participants must yield 3 pairs').toBe(3);
  hostSock.emit('host:confirm_round', { sessionId });
  const confirmedAt = Date.now();

  const byId = (id: string) => users.find((u) => u.id === id)!;
  const P1a = byId(pairs[0].a), P1b = byId(pairs[0].b);
  const P2a = byId(pairs[1].a), P2b = byId(pairs[1].b);
  const P3a = byId(pairs[2].a), P3b = byId(pairs[2].b);
  for (const u of users) await waitForBreakout(sessions.get(u.id)!.page, u.displayName);

  // ── EDGE 1: CANCELLED ROOM — close P2b within 30s of the round ──
  const roundAge = () => Math.round((Date.now() - confirmedAt) / 1000);
  console.log(`  EDGE 1: P2b page closes at ${roundAge()}s of round (cancelled-room path)…`);
  const p2aPage = sessions.get(P2a.id)!.page;
  await sessions.get(P2b.id)!.page.close(); // grace expiry will see a <30s no-rating match → cancelled
  // P2a: waiting banner, then straight back to MAIN with NO rating form.
  await expect(p2aPage.getByText(/Waiting for your partner to reconnect/i).first(), 'P2a waiting banner')
    .toBeVisible({ timeout: 20_000 });
  console.log('  ✓ P2a sees waiting banner');
  let p2aSawForm = false;
  let p2aInMain = false;
  {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (await p2aPage.getByText(/didn.t return|Rate your conversation/i).first().isVisible().catch(() => false)) {
        p2aSawForm = true; break;
      }
      if ((await readBreakoutSeconds(p2aPage)) === null) { p2aInMain = true; break; }
      await p2aPage.waitForTimeout(1200);
    }
  }
  expect(p2aSawForm, 'a <30s cancelled room must NOT prompt a rating').toBe(false);
  expect(p2aInMain, 'P2a must land back in the main room').toBe(true);
  console.log('  ✓ EDGE 1: cancelled room → no form, straight to main');

  // ── EDGE 2: LEAVE EVENT BUTTON mid-round (match now >30s → completed) ──
  if (roundAge() < 40) await p2aPage.waitForTimeout((40 - roundAge()) * 1000);
  console.log(`  EDGE 2: P1a clicks the real Leave Event button at ${roundAge()}s…`);
  const p1aPage = sessions.get(P1a.id)!.page;
  const p1bPage = sessions.get(P1b.id)!.page;
  await p1aPage.getByText('Leave Event', { exact: true }).first().click();
  // The leaver's page navigates away (to /sessions) — that's the event exit.
  await p1aPage.waitForURL(/\/sessions/, { timeout: 20_000 }).catch(() => {});
  console.log(`  P1a now at: ${p1aPage.url()}`);
  await expect(p1bPage.getByText(/Waiting for your partner to reconnect/i).first(), 'P1b waiting banner after partner Leave Event')
    .toBeVisible({ timeout: 20_000 });
  console.log('  ✓ P1b sees waiting banner (Leave Event no longer orphans the partner)');
  await expect(p1bPage.getByText(/didn.t return/i).first(), 'P1b gets the partner-no-return form at grace expiry')
    .toBeVisible({ timeout: 40_000 });
  console.log('  ✓ EDGE 2: Leave-Event grace → survivor form');
  await p1bPage.getByText('Skip', { exact: true }).first().click().catch(() => {});

  // ── EDGE 3: DOUBLE-LEAVE RACE + "DIDN'T WORK" flag ──
  console.log('  EDGE 3: P3a and P3b click Back to Main Room SIMULTANEOUSLY…');
  const p3aPage = sessions.get(P3a.id)!.page;
  const p3bPage = sessions.get(P3b.id)!.page;
  await Promise.all([
    p3aPage.getByText('Back to Main Room', { exact: true }).first().click(),
    p3bPage.getByText('Back to Main Room', { exact: true }).first().click(),
  ]);
  // Both must reach a coherent exit: a rating form OR the main room — never
  // a stuck dead room. (Who gets which form depends on who won the demote.)
  const coherentExit = async (page: Page, label: string): Promise<'form' | 'main'> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await page.getByText(/Rate your|didn.t return/i).first().isVisible().catch(() => false)) return 'form';
      if ((await readBreakoutSeconds(page)) === null) return 'main';
      await page.waitForTimeout(1000);
    }
    throw new Error(`${label}: stuck in a dead room after simultaneous leave`);
  };
  const [exitA, exitB] = await Promise.all([coherentExit(p3aPage, 'P3a'), coherentExit(p3bPage, 'P3b')]);
  console.log(`  ✓ double-leave coherent: P3a=${exitA}, P3b=${exitB}`);

  // Whoever has a form: P3a uses the NEW "didn't work" action.
  const formPage = exitA === 'form' ? p3aPage : exitB === 'form' ? p3bPage : null;
  const formUser = exitA === 'form' ? P3a : P3b;
  if (formPage) {
    await formPage.getByText(/conversation didn.t work/i).first().click();
    await formPage.waitForTimeout(3000);
    expect(await readBreakoutSeconds(formPage), 'didnt-work submitter lands in main').toBeNull();
    // DB truth: the rating row exists and carries the exclusion flag.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const row = await pool.query(
      `SELECT excluded_from_quality_stats AS x, quality_score AS q FROM ratings WHERE from_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [formUser.id],
    );
    await pool.end();
    console.log(`  didnt-work row: ${JSON.stringify(row.rows[0])}`);
    expect(row.rows[0]?.x, 'rating row must be excluded_from_quality_stats').toBe(true);
    console.log('  ✓ EDGE 3: didnt-work click recorded + excluded from stats (DB-verified)');
  } else {
    console.log('  (both raced straight to main — no form to exercise didnt-work here)');
  }

  try { await endSession(host, sessionId); } catch {}
  for (const s of sessions.values()) { await s.context.close().catch(() => {}); }
  console.log('✓ EDGE SMOKE 1 complete: cancelled-no-form, Leave-Event grace, double-leave race, didnt-work flag');
});

test('edges: trio — leaver rates BOTH partners, survivors keep talking, departed rated at round end', async () => {
  test.setTimeout(600_000);

  const trio = await Promise.all(['wst1', 'wst2', 'wst3'].map((n) => createTestUser(n)));
  const pod = await createPod(host, 'E2E WS2 Trio Pod');
  const sess = await createSession(host, pod.id, 'E2E Trio Smoke', new Date(Date.now() + 60_000), {
    numberOfRounds: 1,
    roundDurationSeconds: 180,
  });
  const sessionId = sess.id;
  for (const u of trio) await addPodMember(host, pod.id, u.id);
  await Promise.all(trio.map((u) => registerForSession(u, sessionId)));
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  const sessions = new Map<string, { context: BrowserContext; page: Page }>();
  for (const u of trio) sessions.set(u.id, await openUserPage(u, sessionId));
  await sessions.get(trio[0].id)!.page.waitForTimeout(9000);

  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  hostSock.emit('session:join', { sessionId });
  await sessions.get(trio[0].id)!.page.waitForTimeout(2000);

  // Algorithm path: 3 eligible → the engine should form ONE trio.
  const matches = await settledPairs(hostSock, sessions.get(trio[0].id)!.page, sessionId, 1);
  console.log('  trio preview:', JSON.stringify(matches));
  const isAlgorithmTrio = matches.length === 1 && !!matches[0].c;
  if (isAlgorithmTrio) {
    hostSock.emit('host:confirm_round', { sessionId });
  } else {
    // Fallback: force a manual 3-person breakout (deterministic trio).
    console.log('  engine did not form a trio — forcing a manual 3-person room');
    hostSock.emit('host:create_breakout_bulk', {
      sessionId,
      rooms: [{ participantIds: trio.map((u) => u.id) }],
      sharedDurationSeconds: 180,
      timerVisibility: 'visible',
    });
  }
  for (const u of trio) await waitForBreakout(sessions.get(u.id)!.page, u.displayName);

  // The LEAVER: first trio member clicks Back to Main Room → their form
  // must cover BOTH partners (two sequential partner forms).
  const leaver = trio[0];
  const survivors = [trio[1], trio[2]];
  const leaverPage = sessions.get(leaver.id)!.page;
  console.log(`  ${leaver.displayName} leaves the trio…`);
  await leaverPage.getByText('Back to Main Room', { exact: true }).first().click();
  await expect(leaverPage.getByText(/Rate your conversation/i).first(), 'leaver gets the rating form')
    .toBeVisible({ timeout: 15_000 });
  await rateOne(leaverPage, 'leaver form 1');
  await expect(leaverPage.getByText(/How was your chat with/i).first(), 'leaver gets a SECOND partner form (trio)')
    .toBeVisible({ timeout: 10_000 });
  await rateOne(leaverPage, 'leaver form 2 (second partner)');
  console.log('  ✓ leaver SUBMITTED ratings for BOTH partners');
  await leaverPage.waitForTimeout(3000);
  expect(await readBreakoutSeconds(leaverPage), 'leaver lands in main').toBeNull();

  // SURVIVORS keep talking — still in the breakout 10s later.
  await sessions.get(survivors[0].id)!.page.waitForTimeout(10_000);
  for (const s of survivors) {
    expect(await readBreakoutSeconds(sessions.get(s.id)!.page), `${s.displayName} still in the room (trio continues)`)
      .not.toBeNull();
  }
  console.log('  ✓ survivors keep talking after the leaver departs');

  if (isAlgorithmTrio) {
    // ROUND END: each survivor's form must include THE DEPARTED — i.e. TWO
    // partners (each other + the leaver). The trio progress dots / second
    // sequential form prove the departed_user_ids round-trip in a browser.
    console.log('  waiting for round end (departed-at-round-end check)…');
    const s0Page = sessions.get(survivors[0].id)!.page;
    await expect(s0Page.getByText(/How was your chat with/i).first(), 'survivor gets the round-end form')
      .toBeVisible({ timeout: 200_000 });
    // S14: SUBMIT both — the second form is the DEPARTED member, and that
    // submit is exactly what 403'd in Ali's live test (slot-only validation).
    await rateOne(s0Page, 'survivor form 1');
    await expect(s0Page.getByText(/How was your chat with/i).first(),
      'survivor must get a SECOND partner form — the DEPARTED is included at round end')
      .toBeVisible({ timeout: 10_000 });
    await rateOne(s0Page, 'survivor form 2 (the DEPARTED — submit must succeed)');
    console.log('  ✓ departed member rated AND submitted at round end (browser-proven)');
  } else {
    console.log('  (manual-room trio: departed-at-round-end not applicable — stays unit-pinned)');
  }

  try { await endSession(host, sessionId); } catch {}
  for (const s of sessions.values()) { await s.context.close().catch(() => {}); }
  console.log('✓ EDGE SMOKE 2 complete: trio mechanics browser-verified');
});

// TEST 3 (3 users): BROWSER-CLOSE + REOPEN FROM A TRIO — Ali's live repro
// (2026-06-05, event "vv"): a trio member closes the browser mid-round;
// after the 15s grace they're demoted (room continues for the other two).
// Reopening (Ctrl+Shift+T) must land them in the MAIN room WITH the
// late-return rating form covering BOTH partners they actually talked to —
// pre-S14 the replay only matched COMPLETED matches with the user still in
// the slots, so a departed-from-active-trio returner got NOTHING.
test('edges: trio browser-close → grace demote → reopen gets the late-return form (both partners)', async () => {
  test.setTimeout(600_000);

  const trio = await Promise.all(['wsr1', 'wsr2', 'wsr3'].map((n) => createTestUser(n)));
  const pod = await createPod(host, 'E2E WS2 Reopen Pod');
  const sess = await createSession(host, pod.id, 'E2E Reopen Smoke', new Date(Date.now() + 60_000), {
    numberOfRounds: 1,
    roundDurationSeconds: 300,
  });
  const sessionId = sess.id;
  for (const u of trio) await addPodMember(host, pod.id, u.id);
  await Promise.all(trio.map((u) => registerForSession(u, sessionId)));
  const hostInit = await connectSocket(host);
  await new Promise<void>((r) => { hostInit.emit('host:start_session', { sessionId }); setTimeout(r, 2000); });
  hostInit.disconnect();

  const sessions = new Map<string, { context: BrowserContext; page: Page }>();
  for (const u of trio) sessions.set(u.id, await openUserPage(u, sessionId));
  await sessions.get(trio[0].id)!.page.waitForTimeout(9000);

  const hostSock = await connectSocket(host);
  sockets.push(hostSock);
  hostSock.emit('session:join', { sessionId });
  await sessions.get(trio[0].id)!.page.waitForTimeout(2000);

  const matches = await settledPairs(hostSock, sessions.get(trio[0].id)!.page, sessionId, 1);
  console.log('  trio preview:', JSON.stringify(matches));
  if (matches.length === 1 && !!matches[0].c) {
    hostSock.emit('host:confirm_round', { sessionId });
  } else {
    console.log('  engine did not form a trio — forcing a manual 3-person room');
    hostSock.emit('host:create_breakout_bulk', {
      sessionId,
      rooms: [{ participantIds: trio.map((u) => u.id) }],
      sharedDurationSeconds: 300,
      timerVisibility: 'visible',
    });
  }
  for (const u of trio) await waitForBreakout(sessions.get(u.id)!.page, u.displayName);

  // The CLOSER: simulate a browser close (page.close keeps the context and
  // its localStorage tokens — exactly Ctrl+W then Ctrl+Shift+T).
  const closer = trio[0];
  const survivors = [trio[1], trio[2]];
  console.log(`  ${closer.displayName} closes the browser tab…`);
  await sessions.get(closer.id)!.page.close();

  // Past the 15s grace → demoted; the room must CONTINUE for the other two.
  await sessions.get(survivors[0].id)!.page.waitForTimeout(25_000);
  for (const s of survivors) {
    expect(await readBreakoutSeconds(sessions.get(s.id)!.page), `${s.displayName} still in the room after the demote`)
      .not.toBeNull();
  }
  console.log('  ✓ room continued for the survivors through the grace expiry');

  // REOPEN: same context, fresh tab.
  console.log(`  ${closer.displayName} reopens the tab…`);
  const reopened = await sessions.get(closer.id)!.context.newPage();
  reopened.on('dialog', (d) => { d.accept().catch(() => {}); });
  await gotoLive(reopened, sessionId);

  // The late-return rating form must appear — and cover BOTH partners.
  await expect(reopened.getByText(/How was your chat with/i).first(),
    'reopened member gets the late-return rating form (pre-S14: nothing)')
    .toBeVisible({ timeout: 30_000 });
  await rateOne(reopened, 'reopen form 1');
  await expect(reopened.getByText(/How was your chat with/i).first(),
    'reopened member gets a SECOND partner form (talked to both)')
    .toBeVisible({ timeout: 10_000 });
  await rateOne(reopened, 'reopen form 2');

  // After rating they belong in the MAIN room (demoted members do not
  // re-enter a continuing breakout — by design).
  await reopened.waitForTimeout(3000);
  expect(await readBreakoutSeconds(reopened), 'reopened member lands in main after rating').toBeNull();
  console.log('  ✓ reopen → late-return form (2 partners) → submitted → main room');

  try { await endSession(host, sessionId); } catch {}
  for (const s of sessions.values()) { await s.context.close().catch(() => {}); }
  console.log('✓ EDGE SMOKE 3 complete: browser-close reopen path browser-verified');
});
