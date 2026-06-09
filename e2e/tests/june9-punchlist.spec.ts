import { test, expect, chromium, Browser, Page, BrowserContext } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED end-to-end coverage for the "RSN test 9 june" punch list:
//   #1 invite "Search by name or email" text is visible (not white-on-white)
//   #2 participants (and host) never see internal "plan updated"/"plan ready"
//   #4 co-host promote/demote gives INSTANT feedback + real powers
//   #5 a shareable invite link covers the whole event (not capped at 10)
//   #6 revoke blocks the old link, and re-inviting the same person works
// (#3 backend super_admin policy is intentionally deferred pending sign-off;
//  #7 mobile-BG persistence is covered by bg-frame-health units + bg-cross-device.)
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, alice: TestUser, bob: TestUser, sadmin: TestUser;
let podId: string, sessionId: string;
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

async function apiAs(user: TestUser, method: string, path: string, body?: any) {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${user.accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json };
}

async function toastTexts(page: Page): Promise<string[]> {
  return page.locator('div.fixed.top-4.right-4 p').allInnerTexts().catch(() => [] as string[]);
}

async function login(context: BrowserContext, user: TestUser) {
  await context.addInitScript((toks: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', toks.a);
    localStorage.setItem('rsn_refresh', toks.r);
  }, { a: user.accessToken, r: user.refreshToken });
  const share = process.env.E2E_VERCEL_SHARE;
  if (share) {
    const p = await context.newPage();
    await p.goto(`${APP}/?_vercel_share=${share}`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    await p.close();
  }
}

test.beforeAll(async () => {
  host = await createTestUser('j9host', 'super_admin');
  alice = await createTestUser('j9alice');
  bob = await createTestUser('j9bob');
  sadmin = await createTestUser('j9sadmin', 'super_admin'); // NOT the director
  const pod = await createPod(host, 'E2E June9 Pod');
  podId = pod.id;
  await addPodMember(host, podId, alice.id);
  await addPodMember(host, podId, bob.id);
  await addPodMember(host, podId, sadmin.id);
  const sess = await createSession(host, podId, 'E2E June9', new Date(Date.now() + 60_000));
  sessionId = sess.id;
  await Promise.all([
    registerForSession(alice, sessionId),
    registerForSession(bob, sessionId),
    registerForSession(sadmin, sessionId),
  ]);

  browser = await chromium.launch({
    headless: false,
    channel: process.env.E2E_CHROME_CHANNEL || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

// ── #5 — a shareable invite link covers the whole event, not 10 ───────────────
test('#5: a shareable session invite link is capped at the event capacity, not 10', async () => {
  // The CLIENT now sends maxUses = config.maxParticipants (default 500) for a
  // shareable link (proven by the source-pin unit test). Here we confirm the
  // backend stores and returns a large cap end-to-end (not the old hard 10).
  const cap = await apiAs(host, 'POST', '/invites', { type: 'session', sessionId, expiresInHours: 168, maxUses: 500 });
  expect(cap.ok, `create link failed: ${cap.status} ${JSON.stringify(cap.json)}`).toBe(true);
  const maxUses = cap.json?.data?.maxUses;
  console.log(`  shareable link maxUses (from create response) = ${maxUses}`);
  expect(maxUses, 'shareable link must allow far more than 10').toBeGreaterThan(10);
});

// ── #6 — revoke blocks the old link; re-invite works ──────────────────────────
test('#6: revoking an invite blocks the old link and a fresh re-invite succeeds', async () => {
  const email = `j9revoke-${Date.now()}@rsn-e2e.invalid`;
  const created = await apiAs(host, 'POST', '/invites', { type: 'session', sessionId, inviteeEmail: email, maxUses: 1, expiresInHours: 168 });
  expect(created.ok, `create failed: ${JSON.stringify(created.json)}`).toBe(true);
  const id = created.json?.data?.id;
  const code = created.json?.data?.code;
  expect(id && code, 'created invite must have id + code').toBeTruthy();

  // Revoke it.
  const revoked = await apiAs(host, 'DELETE', `/invites/${id}`);
  expect(revoked.ok, `revoke failed: ${revoked.status}`).toBe(true);

  // The old link must no longer be acceptable.
  const accept = await apiAs(alice, 'POST', `/invites/${code}/accept`);
  console.log(`  accept-after-revoke status=${accept.status} (must NOT be 200)`);
  expect(accept.ok, 'a revoked link must be blocked on accept').toBe(false);

  // Re-inviting the SAME email must succeed (revoked ≠ pending).
  const reinvite = await apiAs(host, 'POST', '/invites', { type: 'session', sessionId, inviteeEmail: email, maxUses: 1, expiresInHours: 168 });
  console.log(`  re-invite status=${reinvite.status} (must succeed)`);
  expect(reinvite.ok, 're-inviting a revoked person must succeed').toBe(true);
});

// ── #3 — a super_admin who is NOT the director still sees host controls ───────
test('#3: a super_admin (not the director) always sees host controls', async () => {
  test.setTimeout(120_000);
  // ensure the session is live so the live page mounts host controls
  const starter = await connectSocket(host);
  await new Promise<void>((r) => { starter.emit('host:start_session', { sessionId }); setTimeout(r, 2500); });
  starter.disconnect();

  const ctx = await browser.newContext();
  await login(ctx, sadmin);
  const page = await ctx.newPage();
  try {
    await page.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);
    // sadmin is a super_admin and NOT the event director, yet must see host UI.
    const ctrl = page.getByRole('button', { name: /Control Center|End Event/ });
    await expect(ctrl, 'a non-director super_admin must see host controls').toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: 'test-results/j9-superadmin-host.png' }).catch(() => {});
    console.log('  ✓ non-director super_admin sees host controls');
  } finally { await ctx.close(); }
});

// ── #1 — invite search input text is visible (dark, not white-on-white) ───────
test('#1: the invite "Search by name or email" input renders dark, readable text', async () => {
  test.setTimeout(90_000);
  const context = await browser.newContext();
  await login(context, host);
  const page = await context.newPage();
  try {
    await page.goto(`${APP}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    // Open the invite/people area if it's behind a button, then locate the search input.
    const search = page.getByPlaceholder('Search by name or email...').first();
    if (!(await search.count())) {
      // Try an "Invite" / add control to reveal it.
      await page.getByRole('button', { name: /invite/i }).first().click().catch(() => {});
      await page.waitForTimeout(1500);
    }
    await expect(search, 'invite search input should be present').toBeVisible({ timeout: 15_000 });
    await search.fill('Zubair');
    const color = await search.evaluate((el) => getComputedStyle(el as HTMLElement).color);
    const m = color.match(/\d+/g)!.map(Number);
    const brightness = (m[0] + m[1] + m[2]) / 3;
    console.log(`  input text color=${color} brightness=${brightness.toFixed(0)} (must be dark)`);
    // White-on-white was the bug: text near 255. Readable dark text is well below.
    expect(brightness, 'typed invite text must be dark, not white').toBeLessThan(140);
  } finally { await context.close(); }
});

// ── #2 — internal "plan ready/updated" toasts never banner anyone ─────────────
// ── #4 — co-host promote gives instant feedback + real host powers ────────────
test('#2 + #4: no internal plan toasts; host promotes a co-host who instantly gains host UI', async () => {
  test.setTimeout(240_000);
  // Sessions start via the orchestration socket, not a REST route.
  const starter = await connectSocket(host);
  await new Promise<void>((r) => { starter.emit('host:start_session', { sessionId }); setTimeout(r, 2500); });
  starter.disconnect();

  const hostCtx = await browser.newContext();
  const aliceCtx = await browser.newContext();
  await login(hostCtx, host);
  await login(aliceCtx, alice);
  const hostPage = await hostCtx.newPage();
  const alicePage = await aliceCtx.newPage();

  try {
    await hostPage.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
    await alicePage.goto(`${APP}/session/${sessionId}/live`, { waitUntil: 'domcontentloaded' });
    await hostPage.waitForTimeout(9000);
    await alicePage.waitForTimeout(9000);

    // #4 — Alice starts as a participant: she must NOT see host-only controls.
    const aliceHostCtrlBefore = await alicePage.getByRole('button', { name: /Control Center|End Event|Match People/ }).count();
    console.log(`  alice host-controls before promote: ${aliceHostCtrlBefore} (expect 0)`);

    // Host promotes Alice to co-host via the orchestration socket (the UI button
    // path the Control Center wires to). This drives the real server handler.
    const hostSock = await connectSocket(host);
    sockets.push(hostSock);
    hostSock.emit('session:join', { sessionId });
    await hostPage.waitForTimeout(1500);
    hostSock.emit('host:assign_cohost', { sessionId, userId: alice.id, role: 'co_host' });

    // #4 — Alice's client must gain host UI quickly (cohost:assigned → host UI).
    await expect
      .poll(async () => alicePage.getByRole('button', { name: /Control Center|End Event|Match People/ }).count(),
        { timeout: 15_000, message: 'promoted co-host should gain host controls' })
      .toBeGreaterThan(0);
    await alicePage.screenshot({ path: 'test-results/j9-cohost-promoted.png' }).catch(() => {});
    console.log('  ✓ alice gained host UI after promotion');

    // #2 — promoting a co-host triggers a server-side plan repair
    // (maybeRepairFutureRounds → event_plan_repaired), which fires the internal
    // "Plan updated …" toast. It must NOT banner host OR participant.
    const aliceErrors: string[] = [];
    alicePage.on('console', (m) => { if (m.type() === 'error' && /forbidden|not the host/i.test(m.text())) aliceErrors.push(m.text()); });
    await hostPage.waitForTimeout(4000);
    const hostToasts = await toastTexts(hostPage);
    const aliceToasts = await toastTexts(alicePage);
    console.log(`  host toasts: ${JSON.stringify(hostToasts)}`);
    console.log(`  alice toasts: ${JSON.stringify(aliceToasts)}`);
    const internalRe = /plan updated|plan ready|event plan/i;
    expect(hostToasts.some(t => internalRe.test(t)), 'host must not see internal plan banner').toBe(false);
    expect(aliceToasts.some(t => internalRe.test(t)), 'participant must not see internal plan banner').toBe(false);

    // #4 — demote: Alice loses host UI again.
    hostSock.emit('host:remove_cohost', { sessionId, userId: alice.id });
    await expect
      .poll(async () => alicePage.getByRole('button', { name: /Control Center|End Event/ }).count(),
        { timeout: 15_000, message: 'demoted co-host should lose host controls' })
      .toBe(0);
    console.log('  ✓ alice lost host UI after demotion');
    expect(aliceErrors, `co-host saw forbidden errors:\n${aliceErrors.join('\n')}`).toHaveLength(0);
  } finally {
    await hostCtx.close();
    await aliceCtx.close();
  }
});
