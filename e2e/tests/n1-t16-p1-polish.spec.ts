// P1 POLISH ON THE PREVIEW (T16, 25 Oct leftovers + the controller's X items), headed.
//
// One test per visible item, each with throwaway accounts (cleaned up by id) on the local stack or a preview:
//   A. item 1: a meeting under way offers no Cancel; one still to come does.
//   B. items 2, 3: the pods list at 360 holds a 60-character unbroken name inside the window and says "Active".
//   C. items 15, 27, 33, 34: a pod with 22 events says "Events (22)" with the soonest first; the Invitations card sits
//      above the members, names a member without their address, and Remind all says how far it is while every row's
//      Remind waits.
//   D. item 30: "Share a link" hands out the same open link the second time.
//   E. item 9: someone who is not in a private event's pod, at its live address, reads a final refusal with the
//      server's reason, never "Reconnecting".
//   F. item 17 + X1: a pod page whose socket was not yet up when the pod changed, and one whose socket dropped while
//      it changed, both show the change without a reload once their socket connects.
import { test, expect, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { cleanup, gotoRetry, idsOf, wait, APP, SERVER } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';

const RUN = Date.now() % 100_000;
const LONG = `Unbroken${'x'.repeat(52)}`; // 60 characters, no space
const POD_NAME = `T16 Pod ${RUN}`;

let browser: Browser;
let director: TestUser;
let member: TestUser;
let stranger: TestUser;
let podId = '';
let longPodId = '';
let convId = '';
const meetingIds: string[] = [];
const contexts: BrowserContext[] = [];

async function api(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function contextFor(u: TestUser, viewport = { width: 1280, height: 900 }): Promise<BrowserContext> {
  const ctx = await browser.newContext(process.env.E2E_DEVICE ? contextOptions() : { viewport });
  contexts.push(ctx);
  await primePreview(ctx);
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  return ctx;
}

async function open(ctx: BrowserContext, path: string, before?: (page: Page) => Promise<void>): Promise<Page> {
  const page = await ctx.newPage();
  if (before) await before(page);
  await gotoRetry(page, `${APP}${path}`);
  await page.evaluate(() => { (window as unknown as { __notReloaded?: boolean }).__notReloaded = true; });
  return page;
}
const notReloaded = (page: Page) => page.evaluate(() => (window as unknown as { __notReloaded?: boolean }).__notReloaded === true);

async function newPod(name: string): Promise<string> {
  const pod = await api(director, 'POST', '/pods', {
    name, description: 'throwaway', visibility: 'private', podType: 'speed_networking', orchestrationMode: 'timed_rounds', communicationMode: 'video',
  });
  expect(pod.status, JSON.stringify(pod.json)).toBe(201);
  return pod.json.data.id;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  browser = await launchBrowser();
  director = await createTestUser(`t16dir${RUN}`);
  member = await createTestUser(`t16mem${RUN}`);
  stranger = await createTestUser(`t16str${RUN}`);
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [`Dana Director ${RUN}`, director.id]);
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [`Mia Member ${RUN}`, member.id]);
  podId = await newPod(POD_NAME);
  expect([200, 201]).toContain((await api(director, 'POST', `/pods/${podId}/members`, { userId: member.id, role: 'member' })).status);
  // Director and member are connected (a request, accepted): their conversation holds the meetings.
  const sent = await api(director, 'POST', '/pokes', { recipientId: member.id, message: 'Coffee?' });
  expect(sent.status).toBe(201);
  expect((await api(member, 'POST', `/pokes/${sent.json.data.id}/accept`)).status).toBe(200);
  convId = (await pool.query<{ id: string }>(
    'SELECT id FROM dm_conversations WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)', [director.id, member.id],
  )).rows[0].id;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (meetingIds.length) await pool.query('DELETE FROM meetings WHERE id = ANY($1)', [meetingIds]).catch(() => {});
  for (const id of [podId, longPodId].filter(Boolean)) {
    await pool.query('DELETE FROM invites WHERE pod_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM session_participants WHERE session_id IN (SELECT id FROM sessions WHERE pod_id = $1)', [id]).catch(() => {});
  }
  // The second pod first: its director is one of the users, whose delete it would otherwise block.
  if (longPodId) await cleanup(pool, { ids: [], podId: longPodId });
  await cleanup(pool, { ids: idsOf(director, member, stranger), podId: podId || undefined });
});

test(`A: a meeting under way offers no Cancel; one still to come does (${engineLabel()})`, async () => {
  test.setTimeout(90_000);
  const [a, b] = [director.id, member.id].sort();
  const insert = async (minutesFromNow: number) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO meetings (conversation_id, user_a_id, user_b_id, start_at, duration_min, kind, confirmed_by)
       VALUES ($1, $2, $3, NOW() + make_interval(mins => $4), 30, 'video', $2) RETURNING id`,
      [convId, a, b, minutesFromNow],
    );
    meetingIds.push(rows[0].id);
    return rows[0].id;
  };
  const live = await insert(-5);
  const later = await insert(180);
  const page = await open(await contextFor(director, { width: 1280, height: 900 }), `/meetings/${live}`);
  await expect(page.getByRole('link', { name: /Open conversation/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Cancel meeting' })).toHaveCount(0);
  await gotoRetry(page, `${APP}/meetings/${later}`);
  await expect(page.getByRole('button', { name: 'Cancel meeting' })).toBeVisible({ timeout: 30_000 });
});

test(`B: the pods list at 360 keeps a 60-character name inside the window and says Active (${engineLabel()})`, async () => {
  test.setTimeout(90_000);
  longPodId = await newPod(LONG);
  const page = await open(await contextFor(director, { width: 360, height: 800 }), '/pods');
  const card = page.getByText(LONG, { exact: true });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), { timeout: 5_000 }).toBe(true);
  const row = page.locator('div').filter({ has: card }).filter({ hasText: 'Active' }).last();
  await expect(row).toContainText('Active');
  await expect(page.getByText('active', { exact: true })).toHaveCount(0);
});

test(`C: 22 events in order, and the Invitations card above the members, by name, with Remind all's progress (${engineLabel()})`, async () => {
  test.setTimeout(150_000);
  // One event made through the route, then 21 more copied from it, all later than the first.
  const first = await api(director, 'POST', '/sessions', {
    podId, title: `Soonest ${RUN}`, description: 'throwaway', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    config: { eventType: 'speed_networking', numberOfRounds: 3, maxParticipants: 50, roundDurationSeconds: 300 },
  });
  expect(first.status, JSON.stringify(first.json)).toBe(201);
  await pool.query(
    `INSERT INTO sessions
     SELECT (jsonb_populate_record(NULL::sessions, to_jsonb(s) || jsonb_build_object(
       'id', gen_random_uuid(), 'title', 'Later ' || n, 'scheduled_at', (NOW() + make_interval(days => 10 + n))::text))).*
       FROM sessions s, generate_series(1, 21) AS n WHERE s.id = $1`,
    [first.json.data.id],
  );
  // Three people invited by address: the member (an account, so named; out of the pod first, as an invitee is) and two
  // addresses with no account.
  expect((await api(director, 'DELETE', `/pods/${podId}/members/${member.id}`)).status).toBeLessThan(300);
  for (const email of [member.email, `t16-a-${RUN}@example.com`, `t16-b-${RUN}@example.com`]) {
    const r = await api(director, 'POST', '/invites', { type: 'pod', podId, inviteeEmail: email, maxUses: 1, expiresInHours: 168 });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }

  const page = await open(await contextFor(director, { width: 1280, height: 900 }), `/pods/${podId}`);
  const events = page.locator('#pod-events');
  await expect(events.getByRole('heading')).toHaveText(/Events \(22\)/, { timeout: 30_000 });
  await expect(events.getByText(/^(Soonest|Later) /).first()).toHaveText(`Soonest ${RUN}`);

  const card = page.getByTestId('invite-status');
  await expect(card).toBeVisible({ timeout: 30_000 });
  const cardTop = (await card.boundingBox())!.y;
  const membersTop = (await page.locator('#pod-members').boundingBox())!.y;
  expect(cardTop, 'the Invitations card sits above the member list').toBeLessThan(membersTop);
  await expect(card).toContainText(`Mia Member ${RUN}`);
  await expect(card).not.toContainText(member.email);

  // Remind all runs one reminder at a time: it says which, offers Stop, and no row's Remind can be pressed meanwhile.
  await page.route(/\/api\/invites\/[^/]+\/remind$/, async (route) => { await wait(1_200); await route.continue(); });
  await card.getByRole('button', { name: 'Remind all (3)' }).click();
  await expect(card.getByRole('button', { name: /^Sending [123] of 3…$/ })).toBeVisible({ timeout: 5_000 });
  await expect(card.getByRole('button', { name: 'Stop' })).toBeVisible();
  for (const remind of await card.getByRole('button', { name: 'Remind', exact: true }).all()) await expect(remind).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Remind all (3)' })).toBeVisible({ timeout: 20_000 });
  expect(await notReloaded(page)).toBe(true);
});

test(`D: Share a link hands out the same open link the second time (${engineLabel()})`, async () => {
  test.setTimeout(90_000);
  const page = await open(await contextFor(director, { width: 1280, height: 900 }), `/pods/${podId}`);
  const openLinkPanel = async () => {
    await page.getByRole('button', { name: /Invite members/ }).click();
    await page.getByRole('button', { name: /Share a link/ }).click();
  };
  await openLinkPanel();
  // The card's earlier invites are by address: no open link yet, so one is made.
  await page.getByRole('button', { name: 'Make a link' }).click();
  const field = page.getByLabel('Invite link');
  await expect(field).toHaveValue(/\/invite\/.+/, { timeout: 15_000 });
  const firstLink = await field.inputValue();
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await openLinkPanel();
  await expect(page.getByLabel('Invite link')).toHaveValue(firstLink, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Make a link' })).toHaveCount(0);
  const links = await pool.query("SELECT count(*)::int AS n FROM invites WHERE pod_id = $1 AND invitee_email IS NULL", [podId]);
  expect(links.rows[0].n, 'one link made, not two').toBe(1);
});

test(`E: a private event's live address refuses an outsider for good, in the server's words (${engineLabel()})`, async () => {
  test.setTimeout(90_000);
  const ev = await api(director, 'POST', '/sessions', {
    podId, title: `Private ${RUN}`, description: 'throwaway', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), visibility: 'private',
    config: { eventType: 'speed_networking', numberOfRounds: 3, maxParticipants: 50, roundDurationSeconds: 300 },
  });
  expect(ev.status, JSON.stringify(ev.json)).toBe(201);
  const ctx = await contextFor(stranger, { width: 390, height: 844 });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    new MutationObserver(() => { seen.push(document.body?.innerText ?? ''); }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await gotoRetry(page, `${APP}/session/${ev.json.data.id}/live`);
  await expect(page.getByRole('heading', { name: 'This event is not open to you.' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/registered or a pod member|private/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to events' })).toBeVisible();
  // Everything the page showed on its way to the refusal: never "Reconnecting", never a raw status.
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen.join(' | '));
  expect(seen).not.toMatch(/Reconnecting|status code/);
});

/** Holds a page's socket.io connections: `release()` lets the held one through; `drop()` closes the live one. */
function socketGate(page: Page) {
  let hold = true;
  let live: WebSocketRoute | null = null;
  let waiting: (() => void) | null = null;
  let connects = 0;
  const ready = page.routeWebSocket(/socket\.io/, async (ws) => {
    if (hold) await new Promise<void>((r) => { waiting = r; });
    ws.connectToServer();
    live = ws;
    connects += 1;
  });
  return {
    ready,
    connects: () => connects,
    release: () => { hold = false; waiting?.(); waiting = null; },
    holdNext: () => { hold = true; },
    drop: async () => { await live?.close(); live = null; },
  };
}

test(`F: a pod page shows a change sent before its socket's first connect, and one sent during a drop, without a reload (${engineLabel()})`, async () => {
  test.setTimeout(150_000);
  // The member is in the pod again (C took them out), so the pod's tags reach them.
  expect([200, 201]).toContain((await api(director, 'POST', `/pods/${podId}/members`, { userId: member.id, role: 'member' })).status);
  const ctx = await contextFor(member, { width: 1280, height: 900 });
  let gate!: ReturnType<typeof socketGate>;
  const page = await open(ctx, `/pods/${podId}`, async (p) => { gate = socketGate(p); await gate.ready; });
  const title = page.getByRole('heading', { level: 1 });
  await expect(title).toHaveText(POD_NAME, { timeout: 30_000 });

  // X1: the pod changes while this tab's socket has never connected; nothing tells it, until the first connect.
  const renamed = `${POD_NAME} renamed`;
  expect((await api(director, 'PUT', `/pods/${podId}`, { name: renamed })).status).toBe(200);
  await wait(2_000);
  await expect(title).toHaveText(POD_NAME);
  gate.release();
  await expect(title, 'the first connect reads the pod again').toHaveText(renamed, { timeout: 15_000 });

  // Item 17: the socket drops; the pod changes while the next connection is held; it shows once that one connects.
  gate.holdNext();
  await gate.drop();
  const again = `${POD_NAME} again`;
  await wait(1_500);
  expect((await api(director, 'PUT', `/pods/${podId}`, { name: again })).status).toBe(200);
  await wait(2_000);
  await expect(title).toHaveText(renamed);
  gate.release();
  await expect(title, 'the reconnect reads the pod again').toHaveText(again, { timeout: 20_000 });
  expect(gate.connects()).toBeGreaterThanOrEqual(2);
  expect(await notReloaded(page)).toBe(true);
});

test(`G: an incoming call rings again every few seconds in one tab until it is withdrawn (${engineLabel()})`, async () => {
  test.setTimeout(90_000);
  const ctx = await contextFor(member, { width: 1280, height: 900 });
  await ctx.addInitScript(() => {
    const w = window as unknown as { __rings: number };
    w.__rings = 0;
    window.addEventListener('reason:call-ring', () => { w.__rings += 1; });
  });
  const page = await open(ctx, '/pods');
  await page.waitForTimeout(3_000); // the socket is up and the page has said it is here (presence)
  const rings = () => page.evaluate(() => (window as unknown as { __rings: number }).__rings);
  const rung = await api(director, 'POST', `/calls/user/${member.id}`, { kind: 'video', durationMin: 15 });
  expect(rung.status, JSON.stringify(rung.json)).toBeLessThan(300);
  await expect.poll(rings, { timeout: 15_000, message: 'the ring repeats while the call rings' }).toBeGreaterThanOrEqual(3);
  expect((await api(director, 'POST', `/dm/call/requests/${rung.json.data.id}/cancel`)).status).toBeLessThan(300);
  await page.waitForTimeout(1_500);
  const after = await rings();
  await page.waitForTimeout(6_000);
  expect(await rings(), 'no ring after the call was withdrawn').toBe(after);
});
