import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { createTestUser, pool, type TestUser } from '../helpers/auth';
import { createPod, endSession } from '../helpers/api';
import { APP, SERVER, cleanup, connectSocket, gotoRetry, idsOf, teardown, wait, type Socket } from '../helpers/live-ui';
import { contextOptions, engineLabel, launchBrowser } from '../helpers/engine';
import { acceptConfirmDialogs } from '../helpers/confirm-dialog';

// AN EVENT FOR A WHOLE CIRCLE (30 Oct review 6.5; T13, 1 Nov 2026; L20)
//
// "It should be possible to create an event for a whole Circle." Headed, browsers that are never reloaded:
//   1. The circle's manager (its owner, a plain member of REASON) schedules an event from the circle page: the form
//      says who it is for, lists the circle's pod first and starts Private, meaning the circle.
//   2. A circle member who is NOT in the pod, watching the circle page, sees the event appear without a reload and is
//      rung (event_invite). They open it, are registered without joining the pod, and enter its live room.
//   3. Someone outside the circle does not see it, and its address answers the private notice.
//   4. A plain member of the circle is not offered "Schedule an event", and the server refuses them in a sentence.
// Throwaway accounts, circle and pod only, deleted by id at the end.

const RUN = `zq${Date.now().toString(36)}`;
const SECRET = process.env.E2E_JWT_SECRET || process.env.JWT_SECRET;
let browser: Browser;
let manager: TestUser | undefined, member: TestUser | undefined, plain: TestUser | undefined, stranger: TestUser | undefined;
let circleId = '';
let circleName = '';
let podId: string | undefined;
let plainPodId: string | undefined;
let sessionId: string | undefined;
const contexts: BrowserContext[] = [];
const traced: Array<{ ctx: BrowserContext; label: string }> = [];
const sockets: Socket[] = [];

// `any`: each Socket.IO event carries its own payload shape, read by name in the assertions.
type Frame = { dir: 'in' | 'out'; event: string; payload: any; at: number };

/** A throwaway account on the reserved test domain, with a name only this run uses. */
async function throwaway(label: string): Promise<TestUser> {
  const u = await createTestUser(`t13${label}`);
  const name = `${RUN} ${label}`;
  const email = `${u.id}@rsn-e2e.invalid`;
  await pool.query(`UPDATE users SET email = $2, display_name = $3, first_name = $3 WHERE id = $1`, [u.id, email, name]);
  const sid = uuid();
  return {
    ...u, email, displayName: name,
    accessToken: jwt.sign({ sub: u.id, email, role: 'member', displayName: name, sessionId: sid }, SECRET!, { expiresIn: '1h' }),
    refreshToken: jwt.sign({ sub: u.id, sessionId: sid, type: 'refresh' }, SECRET!, { expiresIn: '1d' }),
  };
}

/**
 * A signed-in page whose Socket.IO frames are recorded (the app's socket is websocket-only, client/src/lib/socket.ts,
 * so every frame passes the page's websocket listener). Each page is traced; a failing run keeps the traces
 * (E2E_TRACE_DIR, else the test's output folder), so a failure can be read afterwards.
 */
async function signedIn(user: TestUser, label: string): Promise<{ page: Page; frames: Frame[] }> {
  const ctx = await browser.newContext(contextOptions({ width: 1280, height: 900 }));
  contexts.push(ctx);
  traced.push({ ctx, label });
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  await ctx.addInitScript((t) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: user.accessToken, r: user.refreshToken });
  const page = await ctx.newPage();
  await acceptConfirmDialogs(page);
  const frames: Frame[] = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/socket.io/')) return;
    const read = (dir: 'in' | 'out', data: string | Buffer) => {
      const s = typeof data === 'string' ? data : data.toString();
      if (!s.startsWith('42')) return;
      const i = s.indexOf('[');
      if (i < 0) return;
      try { const [event, payload] = JSON.parse(s.slice(i)); frames.push({ dir, event, payload, at: Date.now() }); } catch { /* not an event */ }
    };
    ws.on('framereceived', (f) => read('in', f.payload));
    ws.on('framesent', (f) => read('out', f.payload));
  });
  return { page, frames };
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await wait(300); }
  throw new Error(`timed out waiting for ${what}`);
}
const got = (frames: Frame[], event: string) => frames.filter((f) => f.dir === 'in' && f.event === event);

async function call(user: TestUser, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${SERVER}/api${path}`, {
    method, headers: { Authorization: `Bearer ${user.accessToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  manager = await throwaway('Manager');
  member = await throwaway('Member');
  plain = await throwaway('Plain');
  stranger = await throwaway('Stranger');
  // A circle as production holds one since migration 118: its creator is its owner. The manager is a plain member of
  // REASON, so this proves the circle's own rule (L21), not an admin's.
  circleId = uuid();
  circleName = `${RUN} Founders`;
  await pool.query(`INSERT INTO circles (id, name, created_by, member_count) VALUES ($1, $2, $3, 3)`, [circleId, circleName, manager.id]);
  await pool.query(
    `INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member'), ($1, $4, 'member')`,
    [circleId, manager.id, member.id, plain.id],
  );
  // The manager's pod, attached to the circle; the member is NOT in it. The plain member directs a pod of their own.
  podId = (await createPod(manager, `${RUN} Manager pod`)).id;
  await pool.query(`INSERT INTO circle_pods (circle_id, pod_id, added_by) VALUES ($1, $2, $3)`, [circleId, podId, manager.id]);
  plainPodId = (await createPod(plain, `${RUN} Plain pod`)).id;
});

// A failing run keeps every page's trace (npx playwright show-trace <file>); a passing run keeps none.
test.afterEach(async ({}, testInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  const dir = process.env.E2E_TRACE_DIR || testInfo.outputPath('traces');
  const stamp = `${Date.now()}-${engineLabel().replace(/\W+/g, '-')}`;
  for (const { ctx, label } of traced) {
    await ctx.tracing.stop(failed ? { path: `${dir}/${stamp}-${label}.zip` } : undefined).catch(() => undefined);
  }
  if (failed) console.log(`Traces kept in ${dir} (${stamp}-*.zip)`);
});

test.afterAll(async () => {
  await teardown(
    () => (sessionId && manager ? endSession(manager, sessionId).catch(() => undefined) : Promise.resolve()),
    ...sockets.map((s) => async () => { s.disconnect(); }),
    ...contexts.map((c) => () => c.close()),
    () => browser?.close(),
    () => (circleId ? pool.query(`DELETE FROM circle_pods WHERE circle_id = $1`, [circleId]) : Promise.resolve()),
    () => (circleId ? pool.query(`DELETE FROM circle_members WHERE circle_id = $1`, [circleId]) : Promise.resolve()),
    () => (circleId ? pool.query(`DELETE FROM circles WHERE id = $1`, [circleId]) : Promise.resolve()),
    () => cleanup(pool, { ids: [], podId: plainPodId }),
    () => cleanup(pool, { ids: idsOf(manager, member, plain, stranger), podId }),
  );
});

test(`a manager schedules for the whole circle; a member outside the pod sees it live, registers and enters (${engineLabel()})`, async () => {
  test.setTimeout(300_000);
  const m = await signedIn(manager!, 'manager');
  const mem = await signedIn(member!, 'member');

  // ── 1. The member watches the circle page; the manager schedules from it ────────────────────────────────────
  await gotoRetry(mem.page, `${APP}/circles/${circleId}`);
  await expect(mem.page.getByTestId('circle-events-empty')).toHaveText('No upcoming events yet.', { timeout: 30_000 });
  await expect(mem.page.getByTestId('circle-schedule-event')).toHaveCount(0);
  // The member's bell holds nothing yet, so a count later proves the bell reached this page without a reload.
  const memberBellCount = mem.page.getByRole('button', { name: 'Notifications' }).locator('span').filter({ hasText: /^\d+$/ });
  await expect(mem.page.getByRole('button', { name: 'Notifications' })).toBeVisible({ timeout: 30_000 });
  await expect(memberBellCount).toHaveCount(0);

  await gotoRetry(m.page, `${APP}/circles/${circleId}`);
  await m.page.getByTestId('circle-schedule-event').click();
  await m.page.waitForURL(new RegExp(`/sessions/new\\?circleId=${circleId}`), { timeout: 30_000 });
  await expect(m.page.getByTestId('event-circle-preset')).toContainText(`For everyone in ${circleName} · 3 members`, { timeout: 30_000 });
  const podSelect = m.page.getByLabel('Pod', { exact: true });
  await expect(podSelect.locator('optgroup').first()).toHaveAttribute('label', `In ${circleName}`);
  await podSelect.selectOption(podId!);
  const access = m.page.getByTestId('event-access-field');
  await expect(access.getByRole('radio', { name: /Private/ })).toBeChecked();
  await expect(access.getByTestId('event-access-private-circle')).toHaveText(`Private: only ${circleName}'s members and people you invite`);
  const title = `${RUN} Circle evening`;
  await m.page.getByLabel('Title').fill(title);
  const created = m.page.waitForResponse((r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST');
  await m.page.getByRole('button', { name: 'Schedule Event' }).click();
  const answer = await created;
  expect(answer.status()).toBe(201);
  const event = (await answer.json()).data;
  sessionId = event.id;
  expect(event).toMatchObject({ circleId, podId, visibility: 'private' });
  await m.page.waitForURL(new RegExp(`/sessions/${sessionId}`), { timeout: 30_000 });
  await m.page.keyboard.press('Escape');
  await expect(m.page.getByTestId('event-circle')).toHaveText(`For ${circleName}`, { timeout: 30_000 });

  // ── 2. The member's page, never reloaded, lists it, marked for the circle; the bell rang ──────────────────────
  const row = mem.page.getByTestId('circle-event').filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByTestId('circle-event-for-circle')).toHaveText('For this circle');
  // The bell reached the member's own client: the push on their socket, and the count on their screen (empty before).
  await until(() => got(mem.frames, 'notification:new').some((f) => f.payload?.title === `New event in ${circleName}`), 30_000, 'the member\'s bell push');
  await expect(memberBellCount).toBeVisible({ timeout: 30_000 });
  const bells = await pool.query(`SELECT user_id, type FROM notifications WHERE link = $1`, [`/sessions/${sessionId}`]);
  expect(bells.rows.map((b) => b.user_id).sort()).toEqual([member!.id, plain!.id].sort());
  expect(bells.rows.every((b) => b.type === 'event_invite')).toBe(true);

  // The member opens it: registered by opening it (the circle is its audience), and never added to the pod.
  await row.click();
  await mem.page.waitForURL(new RegExp(`/sessions/${sessionId}`), { timeout: 30_000 });
  await expect(mem.page.getByTestId('event-circle')).toHaveText(`For ${circleName}`, { timeout: 30_000 });
  await expect(mem.page.getByText('Registered', { exact: true })).toBeVisible({ timeout: 30_000 });
  const place = await pool.query(`SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`, [sessionId, member!.id]);
  expect(place.rows[0]?.status).toBe('registered');
  const inPod = await pool.query(`SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2`, [podId, member!.id]);
  expect(inPod.rows).toHaveLength(0);

  // ── 3. Someone outside the circle: not listed, and the address answers the private notice ────────────────────
  const s = await signedIn(stranger!, 'stranger');
  const listed = await call(stranger!, 'GET', '/sessions');
  expect((listed.json.data?.sessions ?? listed.json.data ?? []).map((x: { id: string }) => x.id)).not.toContain(sessionId);
  await gotoRetry(s.page, `${APP}/sessions/${sessionId}`);
  await expect(s.page.getByTestId('event-private-title')).toHaveText('This event is private', { timeout: 30_000 });
  expect((await call(stranger!, 'POST', `/sessions/${sessionId}/register`)).status).toBe(403);

  // ── 4. A plain member of the circle: no button, and the route refuses them in a sentence ─────────────────────
  const p = await signedIn(plain!, 'plain');
  await gotoRetry(p.page, `${APP}/circles/${circleId}`);
  await expect(p.page.getByTestId('circle-event').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
  await expect(p.page.getByTestId('circle-schedule-event')).toHaveCount(0);
  const refused = await call(plain!, 'POST', '/sessions', {
    podId: plainPodId, title: `${RUN} Not mine to schedule`, scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    format: 'speed_networking', circleId, config: { numberOfRounds: 3, roundDurationSeconds: 480, maxParticipants: 20 },
  });
  expect(refused.status).toBe(403);
  expect(refused.json.error?.message).toBe(`Only the people who run ${circleName} can schedule an event for it.`);
  await gotoRetry(p.page, `${APP}/sessions/new?circleId=${circleId}`);
  await expect(p.page.getByText(`Only the people who run ${circleName} can schedule an event for it.`)).toBeVisible({ timeout: 30_000 });

  // ── 5. The live room: the manager opens it; the member (not in the pod) enters; the outsider is refused ───────
  const host = await connectSocket(manager!);
  sockets.push(host);
  const hostGot: string[] = [];
  host.onAny((e: string, payload: any) => {
    if (e === 'session:status_changed') hostGot.push(`${e}:${payload?.status}`);
    else if (e === 'participant:joined') hostGot.push(`${e}:${payload?.userId}`);
    else hostGot.push(e);
  });
  host.emit('session:join', { sessionId });
  await until(() => hostGot.includes('session:state'), 20_000, 'the host in the room');
  host.emit('host:start_session', { sessionId });
  await until(() => hostGot.includes('session:status_changed:lobby_open'), 30_000, 'the event live');

  const enteredAt = Date.now();
  await gotoRetry(mem.page, `${APP}/session/${sessionId}/live`);
  // The member's own page is let in: its socket asks to join and receives the room's state, which the server sends
  // only after it admits them, and no refusal. The room tells the host the member joined (also only after admission).
  await until(() => mem.frames.some((f) => f.dir === 'out' && f.event === 'session:join' && f.at >= enteredAt), 30_000, 'the member\'s page asking to join');
  await until(() => mem.frames.some((f) => f.dir === 'in' && f.event === 'session:state' && f.at >= enteredAt), 45_000, 'the room\'s state on the member\'s page');
  await until(() => hostGot.includes(`participant:joined:${member!.id}`), 45_000, 'the member admitted to the room');
  // The room's own page is drawn for them: the event's title is in it and its Leave Event is in reach. The title is
  // only checked as present: on a 390px phone the live top bar's state chip and Leave Event take the whole line and the
  // title is squeezed to 0px (the same bar on production; reported apart, not this event's surface).
  await expect(mem.page.getByText(title, { exact: true }).first()).toBeAttached({ timeout: 30_000 });
  await expect(mem.page.getByRole('button', { name: 'Leave Event' })).toBeVisible({ timeout: 30_000 });
  await expect(mem.page.getByText('You have been removed from this event.')).toHaveCount(0);
  const memberRefusals = got(mem.frames, 'error').map((f) => f.payload?.message ?? f.payload);
  expect(memberRefusals, 'the member is never refused').toEqual([]);
  const inRoom = await call(member!, 'GET', `/sessions/${sessionId}/state`);
  expect(inRoom.status).toBe(200);

  const outsider = await connectSocket(stranger!);
  sockets.push(outsider);
  const outsiderGot: string[] = [];
  outsider.onAny((e: string) => { outsiderGot.push(e); });
  outsider.emit('session:join', { sessionId });
  await until(() => outsiderGot.includes('error'), 20_000, 'the outsider\'s refusal');
  expect(outsiderGot).not.toContain('session:state');
  await mem.page.screenshot({ path: `test-results/n1-t13-member-in-room-${engineLabel().replace(/\W+/g, '-')}.png` }).catch(() => {});
});
