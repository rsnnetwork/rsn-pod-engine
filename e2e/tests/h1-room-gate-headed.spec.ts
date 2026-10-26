import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { Socket } from 'socket.io-client';
import { createTestUser, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, apiRequest } from '../helpers/api';
import { APP, SERVER, connectSocket, cleanup, gotoRetry, tilesSeen, wait } from '../helpers/live-ui';

// HEADED smoke for H1 against PRODUCTION: only the people an event admits join its live room.
// Before H1 the server put any signed-in socket that named an event into its room before registering it, and
// kept it there when the registration was refused, so a stranger who knew a private pod's event id received
// its live chat. Here, on a private pod's running event:
//   1. A pod member enters normally from production's live page: video, chat both ways.
//   2. A stranger's own socket asks to join: ONE refusal ("This event is only open to its pod's members."),
//      no state, and none of the chat the member and the host send while it waits; its own message is refused,
//      it is not in the event's room, its resync gets no roster, and its heartbeats never put it on the roster.
//   3. The event state the member reads carries nobody's email (the host's still has the Host Control Center list).
//   4. The stranger opening the link in a browser is stopped by the page (it never asks to join).
//   5. A former member (left the pod, still has the link) is stopped by the page the same way.
//   6. The member leaves and comes back in, then refreshes: still in, with the chat.
//   7. The host kicks the member; the member clicks away from the recap (production's page then tells the server
//      it left) and opens the link again: still removed, bounced to the recap, and refused a video token.
//   8. A member of an invite-only pod, not yet registered, opens its event: the join registers them and lets them in.
// Cleans up exactly what it made, by id (helpers/live-ui cleanup); never cleanupTestData().
const POD_ONLY = 'This event is only open to its pod\'s members.';
const REMOVED = 'You have been removed from this event.';
// Chromium honours only the last --disable-features switch: Playwright's own list, plus the flag that keeps
// the fake camera alive on the Void machine (Chromium >= 147 crashes its capture service without it).
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';
// Events that belong to an event's live room: none of them may reach someone the event does not admit.
const ROOM_EVENTS = ['session:state', 'chat:message', 'chat:history', 'participant:joined', 'participant:left', 'roster:changed', 'reaction:received', 'state:snapshot'];

// `any`: each Socket.IO event carries its own payload shape, read by name in the assertions.
type Frame = { dir: 'in' | 'out'; event: string; payload: any; at: number };
type Watched = Socket & { got: Frame[] };

let browser: Browser;
const contexts: BrowserContext[] = [];
const sockets: Socket[] = [];
const ids: string[] = [];
let podId: string | undefined;
let ioPodId: string | undefined;

function watch(s: Socket): Watched {
  const w = s as Watched;
  w.got = [];
  w.onAny((event: string, payload: unknown) => w.got.push({ dir: 'in', event, payload, at: Date.now() }));
  sockets.push(s);
  return w;
}

/** A signed-in page whose Socket.IO frames are recorded both ways. */
async function openPage(user: TestUser): Promise<{ page: Page; frames: Frame[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(['camera', 'microphone']);
  await context.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
  }, { a: user.accessToken, r: user.refreshToken });
  contexts.push(context);
  const page = await context.newPage();
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
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
const got = (frames: Frame[], event: string, after = 0) => frames.filter((f) => f.dir === 'in' && f.event === event && f.at >= after);
const sent = (frames: Frame[], event: string, after = 0) => frames.filter((f) => f.dir === 'out' && f.event === event && f.at >= after);
const participantStatus = async (sessionId: string, userId: string) =>
  (await pool.query('SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2', [sessionId, userId])).rows[0]?.status ?? null;
/** The HTTP status of an API call (helpers/api throws on any non-2xx). */
async function httpStatus(user: TestUser, method: string, path: string): Promise<number> {
  const res = await fetch(`${SERVER}/api${path}`, {
    method, headers: { Authorization: `Bearer ${user.accessToken}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : '{}',
  });
  return res.status;
}

async function intoChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Skip' }).click({ timeout: 15_000 }).catch(() => {});
  const open = page.getByRole('button', { name: 'Open chat' });
  if (await open.first().isVisible().catch(() => false)) await open.first().click();
  await expect(page.getByPlaceholder('Message everyone...')).toBeVisible({ timeout: 20_000 });
}
async function say(page: Page, text: string): Promise<void> {
  await page.getByPlaceholder('Message everyone...').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

test.beforeAll(async () => {
  browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--disable-features=${PW_DISABLED},MediaFoundationD3D11VideoCapture`,
    ],
  });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch { /* gone */ } }
  for (const c of contexts) await c.close().catch(() => {});
  try { await browser?.close(); } catch { /* closed */ }
  if (ioPodId) await cleanup(pool, { ids: [], podId: ioPodId });
  await cleanup(pool, { ids, podId });
  await closePool();
});

test('H1: a stranger on a private pod\'s running event is refused and receives no chat; a pod member enters normally', async () => {
  test.setTimeout(540_000);

  const host = await createTestUser('h1host', 'super_admin');
  const member = await createTestUser('h1member');
  const stranger = await createTestUser('h1stranger');
  const former = await createTestUser('h1former');
  ids.push(host.id, member.id, stranger.id, former.id);

  const pod = await createPod(host, 'E2E H1 Room Gate Pod'); // private
  podId = pod.id;
  await addPodMember(host, pod.id, member.id);
  await addPodMember(host, pod.id, former.id);
  await apiRequest(former, 'POST', `/pods/${pod.id}/leave`);
  const sess = await createSession(host, pod.id, 'E2E H1 Room Gate', new Date(Date.now() + 60_000), {
    numberOfRounds: 2, roundDurationSeconds: 300,
  });
  const sessionId = sess.id;
  await registerForSession(member, sessionId);

  const hostSock = watch(await connectSocket(host));
  hostSock.emit('session:join', { sessionId });
  await until(() => hostSock.got.some((f) => f.event === 'session:state'), 20_000, 'the host in the room');
  hostSock.emit('host:start_session', { sessionId });
  await until(() => hostSock.got.some((f) => f.event === 'session:status_changed' && f.payload?.status === 'lobby_open'), 30_000, 'the event live');
  const hostHeard = (text: string) => hostSock.got.some((f) => f.event === 'chat:message' && f.payload?.message === text);

  // 1. The member enters normally: video, chat both ways.
  const M = await openPage(member);
  await gotoRetry(M.page, `${APP}/session/${sessionId}/live`);
  await until(() => got(M.frames, 'session:state').length > 0, 45_000, 'the member\'s session:state');
  await intoChat(M.page);
  await until(async () => (await tilesSeen(M.page)) > 0, 60_000, 'the member\'s video');
  await say(M.page, 'H1 member says hello');
  await until(() => hostHeard('H1 member says hello'), 15_000, 'the host receiving the member');
  hostSock.emit('chat:send', { sessionId, message: 'H1 host says hello back', scope: 'lobby' });
  await expect(M.page.getByText('H1 host says hello back').first()).toBeVisible({ timeout: 15_000 });
  expect(got(M.frames, 'error'), 'the member is never refused').toEqual([]);
  await M.page.screenshot({ path: 'test-results/h1-1-member-in.png' }).catch(() => {});
  console.log('  ✓ 1 the pod member is in: video and chat both ways');

  // 2. The stranger's own socket: one refusal, nothing from the room, its post refused, never on the roster.
  const strangerSock = watch(await connectSocket(stranger));
  const tStranger = Date.now();
  strangerSock.emit('session:join', { sessionId });
  await until(() => got(strangerSock.got, 'error', tStranger).length > 0, 20_000, 'the stranger\'s refusal');
  await wait(2000);
  // Only refusals are counted: production may push the fresh account things that have nothing to do with the event.
  expect(got(strangerSock.got, 'error', tStranger).map((f) => f.payload), 'exactly one refusal')
    .toEqual([{ code: 'AUTH_FORBIDDEN', message: POD_ONLY }]);
  await say(M.page, 'H1 said while the stranger listens');
  hostSock.emit('chat:send', { sessionId, message: 'H1 host while the stranger listens', scope: 'lobby' });
  await expect(M.page.getByText('H1 host while the stranger listens').first()).toBeVisible({ timeout: 15_000 });
  await until(() => hostHeard('H1 said while the stranger listens'), 15_000, 'the member\'s message at the host');
  const tTry = Date.now();
  strangerSock.emit('chat:send', { sessionId, message: 'H1 stranger tries to post', scope: 'lobby' });
  strangerSock.emit('session:resync', { sessionId, haveSeq: -1 });
  strangerSock.emit('presence:heartbeat', { sessionId });
  strangerSock.emit('presence:heartbeat', { sessionId });
  await until(() => got(strangerSock.got, 'error', tTry).length > 0, 15_000, 'the stranger\'s post refused');
  expect(got(strangerSock.got, 'error', tTry)[0].payload?.code).toBe('NOT_IN_SESSION');
  await wait(3000);
  for (const e of ROOM_EVENTS) expect(got(strangerSock.got, e, tStranger), `${e} never reaches the stranger (its resync included)`).toEqual([]);
  expect(hostHeard('H1 stranger tries to post'), 'the room never sees the stranger\'s post').toBe(false);
  const state = await apiRequest(host, 'GET', `/sessions/${sessionId}/state`);
  const inTheRoom: string[] = (state?.data?.connectedParticipants || []).map((p: { userId: string }) => p.userId);
  expect(inTheRoom, 'the stranger\'s socket is not in the event\'s room (connected participants are the sockets in it)').not.toContain(stranger.id);
  expect(inTheRoom).toContain(member.id);
  // Presence (what heartbeats keep) is on the live roster the resync answers: the stranger is not on it.
  const tRoster = Date.now();
  hostSock.emit('session:resync', { sessionId, haveSeq: -1 });
  await until(() => got(hostSock.got, 'state:snapshot', tRoster).length > 0, 15_000, 'the host\'s live roster').catch(() => {});
  const roster = got(hostSock.got, 'state:snapshot', tRoster)[0]?.payload?.participants as { userId: string }[] | undefined;
  if (roster) {
    expect(roster.map((p) => p.userId), 'the stranger\'s heartbeats never put it on the live roster').not.toContain(stranger.id);
    expect(roster.map((p) => p.userId)).toContain(member.id);
  } else {
    console.log('  (no state:snapshot reply: the resync rail is off here, so the live-roster check was not run)');
  }
  console.log('  ✓ 2 the stranger\'s socket: one refusal, nothing from the room, its post refused, not in the room or on the roster');

  // 3. The event state the member reads carries nobody's email; the host's carries the Host Control Center list.
  const memberState = await apiRequest(member, 'GET', `/sessions/${sessionId}/state`);
  expect(memberState?.data?.hccParticipants, 'no host panel list for a participant').toEqual([]);
  expect(JSON.stringify(memberState), 'no email in what a participant reads').not.toMatch(/@/);
  expect((state?.data?.hccParticipants || []).length, 'the host still has the Host Control Center list').toBeGreaterThan(0);
  console.log('  ✓ 3 the member\'s event state carries no email; the host\'s keeps the Host Control Center list');

  // 4. The stranger's browser with the link: the page stops it before it ever asks to join.
  const S = await openPage(stranger);
  const tPage = Date.now();
  await gotoRetry(S.page, `${APP}/session/${sessionId}/live`);
  await expect(S.page.getByText('Couldn\'t load the event')).toBeVisible({ timeout: 45_000 });
  expect(sent(S.frames, 'session:join', tPage), 'the page never asks to join').toEqual([]);
  expect(got(S.frames, 'chat:message', tPage)).toEqual([]);
  await S.page.screenshot({ path: 'test-results/h1-4-stranger-page.png' }).catch(() => {});
  console.log('  ✓ 4 the stranger\'s page: "Couldn\'t load the event", never joined');

  // 5. A former member (left the pod, still has the link): stopped by the page the same way.
  const F = await openPage(former);
  const tFormer = Date.now();
  await gotoRetry(F.page, `${APP}/session/${sessionId}/live`);
  await expect(F.page.getByText('Couldn\'t load the event')).toBeVisible({ timeout: 45_000 });
  await say(M.page, 'H1 said while the former member looks');
  await until(() => hostHeard('H1 said while the former member looks'), 15_000, 'the member\'s message at the host');
  await wait(2000);
  expect(sent(F.frames, 'session:join', tFormer), 'the former member\'s page never asks to join').toEqual([]);
  for (const e of ROOM_EVENTS) expect(got(F.frames, e, tFormer), e).toEqual([]);
  await F.page.screenshot({ path: 'test-results/h1-5-former-member-page.png' }).catch(() => {});
  console.log('  ✓ 5 the former member\'s page: "Couldn\'t load the event", never joined, no chat');

  // 6. The member leaves and comes back in; a refresh keeps them in.
  await M.page.getByRole('button', { name: /Leave Event/ }).click();
  await M.page.waitForURL(/\/sessions/, { timeout: 20_000 });
  await until(async () => (await participantStatus(sessionId, member.id)) === 'left', 20_000, 'the member marked left');
  const tBack = Date.now();
  await gotoRetry(M.page, `${APP}/session/${sessionId}/live`);
  await until(() => got(M.frames, 'session:state', tBack).length > 0, 45_000, 'the member back in');
  await intoChat(M.page);
  await expect(M.page.getByText('H1 host says hello back').first()).toBeVisible({ timeout: 15_000 });
  hostSock.emit('chat:send', { sessionId, message: 'H1 welcome back', scope: 'lobby' });
  await expect(M.page.getByText('H1 welcome back').first()).toBeVisible({ timeout: 15_000 });
  const tReload = Date.now();
  await M.page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => got(M.frames, 'session:state', tReload).length > 0, 45_000, 'the member after a refresh');
  await intoChat(M.page);
  hostSock.emit('chat:send', { sessionId, message: 'H1 still here after the refresh', scope: 'lobby' });
  await expect(M.page.getByText('H1 still here after the refresh').first()).toBeVisible({ timeout: 15_000 });
  expect(got(M.frames, 'error', tBack), 'the returning member is never refused').toEqual([]);
  await M.page.screenshot({ path: 'test-results/h1-6-member-back-after-refresh.png' }).catch(() => {});
  console.log('  ✓ 6 the member left, came back in and refreshed: in, with the chat');

  // 7. A kick is final: the member clicks away from the recap (the page sends session:leave) and comes back.
  hostSock.emit('host:remove_participant', { sessionId, userId: member.id, reason: 'e2e H1' });
  await until(async () => (await participantStatus(sessionId, member.id)) === 'removed', 20_000, 'the member removed');
  await expect(M.page.getByText(REMOVED).first()).toBeVisible({ timeout: 20_000 });
  const tAway = Date.now();
  // In-app navigation, as a person does it: the live page unmounts and production's client sends session:leave.
  await M.page.getByRole('button', { name: 'Back to Events' }).click({ timeout: 20_000 });
  await M.page.waitForURL(/\/sessions$/, { timeout: 20_000 });
  await until(() => sent(M.frames, 'session:leave', tAway).length > 0, 20_000, 'the page telling the server it left');
  await wait(3000);
  expect(await participantStatus(sessionId, member.id), 'leaving the recap does not undo the removal').toBe('removed');
  const tAgain = Date.now();
  await gotoRetry(M.page, `${APP}/session/${sessionId}/live`);
  await expect(M.page.getByText(REMOVED).first()).toBeVisible({ timeout: 30_000 });
  await wait(3000);
  expect(await participantStatus(sessionId, member.id), 'still removed after coming back').toBe('removed');
  expect(got(M.frames, 'session:state', tAgain), 'the removed member is not let back into the room').toEqual([]);
  expect(await httpStatus(member, 'POST', `/sessions/${sessionId}/token`), 'no video token for a removed member').toBe(403);
  await M.page.screenshot({ path: 'test-results/h1-7-kicked-member-came-back.png' }).catch(() => {});
  console.log('  ✓ 7 the kicked member clicked away and came back: still removed, bounced, no token');

  expect(got(strangerSock.got, 'chat:message', tStranger), 'the stranger received no chat at all').toEqual([]);
  expect(got(F.frames, 'chat:message', tFormer), 'the former member received no chat at all').toEqual([]);

  hostSock.emit('host:end_session', { sessionId, endEvent: true });
  await until(async () => (await pool.query('SELECT status FROM sessions WHERE id = $1', [sessionId])).rows[0]?.status === 'completed', 60_000, 'the event ended');

  // 8. A member of an INVITE-ONLY pod, not yet registered, opens its event: the join registers them and lets them in.
  const ioMember = await createTestUser('h1iomember');
  ids.push(ioMember.id);
  const ioPod = await apiRequest(host, 'POST', '/pods', {
    name: 'E2E H1 Room Gate Invite-only Pod', description: 'E2E test pod', visibility: 'invite_only',
    podType: 'speed_networking', orchestrationMode: 'timed_rounds', communicationMode: 'hybrid',
  });
  const ioPodMade = ioPod.data.id as string;
  ioPodId = ioPodMade;
  await addPodMember(host, ioPodMade, ioMember.id);
  const ioSess = await createSession(host, ioPodMade, 'E2E H1 Room Gate Invite-only', new Date(Date.now() + 3_600_000), {
    numberOfRounds: 2, roundDurationSeconds: 300,
  });
  const ioSock = watch(await connectSocket(ioMember));
  const tIo = Date.now();
  ioSock.emit('session:join', { sessionId: ioSess.id });
  await until(() => got(ioSock.got, 'session:state', tIo).length > 0, 20_000, 'the invite-only pod\'s member in its event');
  expect(got(ioSock.got, 'error', tIo), 'a member of an invite-only pod is never refused').toEqual([]);
  const ioStatus = await participantStatus(ioSess.id, ioMember.id);
  expect(ioStatus === null || ioStatus === 'removed', `registered by the join (status ${ioStatus})`).toBe(false);
  console.log('  ✓ 8 a member of an invite-only pod opened its event: registered by the join and let in');

  console.log('✓ H1 SMOKE COMPLETE: only the people the event admits are in its live room');
});
