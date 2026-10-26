import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { Socket } from 'socket.io-client';
import { randomUUID } from 'crypto';
import { createTestUser, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, apiRequest } from '../helpers/api';
import { APP, SERVER, connectSocket, cleanup, gotoRetry, wait } from '../helpers/live-ui';

// HEADED smoke for H1b against PRODUCTION: the live-event follow-ups after the room gate.
//   1. A host's fresh personal invite brings a kicked member back, and they stay back. The member, kicked from a
//      running event, accepts the host's new invite in the browser and opens the event again: in, with the chat.
//      36 seconds later (past the server's 30-second reconciler, which used to write the removal back over them)
//      they are still in: never bounced, their row not removed, a video token, chat both ways, and a refresh too.
//   2. In a running video meeting, a guest's message and reaction reach the others while the director is out. The
//      director starts the meeting and steps out; a guest's message is sent (it used to be refused with "Chat is
//      available once the host joins") and shows on another guest's page, and their reaction reaches that page. On a
//      client that keeps the meeting's chat open while the director is out (the preview's meeting room), the page's
//      own message goes out too; production's lobby keeps its input closed while the host is away, as before.
// Cleans up exactly what it made, by id (helpers/live-ui cleanup); never cleanupTestData().
const REMOVED = 'You have been removed from this event.';
const HOST_GATE = 'Chat is available once the host joins';
// The local stack signs no video tokens (its LiveKit keys are blank): there the membership check is what is read.
const LOCAL = /\/\/(127\.0\.0\.1|localhost)[:/]/.test(SERVER);
// Chromium honours only the last --disable-features switch: Playwright's own list, plus the flag that keeps
// the fake camera alive on the Void machine (Chromium >= 147 crashes its capture service without it).
const PW_DISABLED = 'AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints';

// `any`: each Socket.IO event carries its own payload shape, read by name in the assertions.
type Frame = { dir: 'in' | 'out'; event: string; payload: any; at: number };
type Watched = Socket & { got: Frame[] };

let browser: Browser;
const contexts: BrowserContext[] = [];
const sockets: Socket[] = [];
const ids: string[] = [];
let podId: string | undefined;

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
const participantStatus = async (sessionId: string, userId: string) =>
  (await pool.query('SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2', [sessionId, userId])).rows[0]?.status ?? null;
/** The answer to a video-token request: its HTTP status and error code (helpers/api throws on any non-2xx). */
async function tokenAnswer(user: TestUser, sessionId: string): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${SERVER}/api/sessions/${sessionId}/token`, {
    method: 'POST', headers: { Authorization: `Bearer ${user.accessToken}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, code: body?.error?.code };
}
/** A socket's chat:send, with the acknowledgement new clients ask for. */
function sendWithAck(s: Socket, sessionId: string, message: string): Promise<{ ok: boolean; code?: string; message?: string } | null> {
  return new Promise((resolve) => {
    s.timeout(10_000).emit('chat:send', { sessionId, message, scope: 'lobby', clientId: randomUUID() },
      (err: Error | null, res: { ok: boolean; code?: string; message?: string }) => resolve(err ? null : res));
  });
}

/** The chat panel open, whatever opens it on this client (production's "Open chat", the meeting room's Chat). */
async function openChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Skip' }).click({ timeout: 8_000 }).catch(() => {});
  const lobbyChat = page.getByRole('button', { name: 'Open chat' });
  if (await lobbyChat.first().isVisible().catch(() => false)) { await lobbyChat.first().click(); return; }
  const meetingChat = page.getByRole('button', { name: 'Chat', exact: true });
  if (await meetingChat.first().isVisible().catch(() => false)
      && (await meetingChat.first().getAttribute('title')) === 'Open the chat') await meetingChat.first().click();
}
async function intoChat(page: Page): Promise<void> {
  await openChat(page);
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
  await cleanup(pool, { ids, podId });
  await closePool();
});

test('H1b: a kicked member re-invited by the host stays in past the reconciler; a meeting guest chats while the director is out', async () => {
  test.setTimeout(480_000);

  const host = await createTestUser('h1bhost', 'super_admin');
  const member = await createTestUser('h1bmember');
  const guest1 = await createTestUser('h1bguest1');
  const guest2 = await createTestUser('h1bguest2');
  ids.push(host.id, member.id, guest1.id, guest2.id);

  const pod = await createPod(host, 'E2E H1b Live Follow-ups Pod'); // private
  podId = pod.id;
  for (const u of [member, guest1, guest2]) await addPodMember(host, pod.id, u.id);
  const sess = await createSession(host, pod.id, 'E2E H1b Re-invite', new Date(Date.now() + 60_000), {
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

  // 1a. The member is in, then the host removes them.
  const M = await openPage(member);
  await gotoRetry(M.page, `${APP}/session/${sessionId}/live`);
  await until(() => got(M.frames, 'session:state').length > 0, 45_000, 'the member\'s session:state');
  await intoChat(M.page);
  await say(M.page, 'H1b member before the kick');
  await until(() => hostHeard('H1b member before the kick'), 15_000, 'the host receiving the member');
  hostSock.emit('host:remove_participant', { sessionId, userId: member.id, reason: 'e2e H1b' });
  await until(async () => (await participantStatus(sessionId, member.id)) === 'removed', 20_000, 'the member removed');
  await expect(M.page.getByText(REMOVED).first()).toBeVisible({ timeout: 20_000 });
  expect((await tokenAnswer(member, sessionId)).status, 'no video token while removed').toBe(403);
  await M.page.screenshot({ path: 'test-results/h1b-1-kicked.png' }).catch(() => {});
  console.log('  ✓ 1a the member was in, then removed: the removed screen, no video token');

  // 1b. A fresh personal invite from the host, accepted in the browser, and the event opened again.
  const invited = await apiRequest(host, 'POST', '/invites', {
    type: 'session', sessionId, inviteeEmail: member.email, maxUses: 1, expiresInHours: 168,
  });
  const code = invited?.data?.code as string;
  expect(code, 'the host\'s fresh personal invite').toBeTruthy();
  await gotoRetry(M.page, `${APP}/invite/${code}`);
  await M.page.getByRole('button', { name: 'Accept Invite' }).click({ timeout: 30_000 });
  await M.page.waitForURL(new RegExp(`/sessions?/${sessionId}`), { timeout: 30_000 });
  await until(async () => (await participantStatus(sessionId, member.id)) === 'registered', 20_000, 'the member registered again');
  const tBack = Date.now();
  await gotoRetry(M.page, `${APP}/session/${sessionId}/live`);
  await until(() => got(M.frames, 'session:state', tBack).length > 0, 45_000, 'the member back in the room');
  await intoChat(M.page);
  hostSock.emit('chat:send', { sessionId, message: 'H1b welcome back', scope: 'lobby' });
  await expect(M.page.getByText('H1b welcome back').first()).toBeVisible({ timeout: 15_000 });
  await until(async () => (await participantStatus(sessionId, member.id)) === 'in_lobby', 20_000, 'the member in the lobby');
  await M.page.screenshot({ path: 'test-results/h1b-2-back-in.png' }).catch(() => {});
  console.log('  ✓ 1b the member accepted the host\'s fresh invite in the browser and is back in, with the chat');

  // 1c. Past the server's 30-second reconciler: still in, and not bounced.
  await wait(36_000);
  expect(got(M.frames, 'session:evicted', tBack), 'never bounced after coming back').toEqual([]);
  expect(got(M.frames, 'host:participant_removed', tBack), 'never told they were removed again').toEqual([]);
  expect(await M.page.getByText(REMOVED).count(), 'no removed screen').toBe(0);
  expect(await participantStatus(sessionId, member.id), 'the removal was not written back').toBe('in_lobby');
  const token = await tokenAnswer(member, sessionId);
  if (LOCAL) expect(token.status === 200 || token.code === 'LIVEKIT_TOKEN_ERROR', `past the video-token membership check (${token.status} ${token.code ?? ''})`).toBe(true);
  else expect(token.status, 'a video token for the re-admitted member').toBe(200);
  await say(M.page, 'H1b member after the reconciler');
  await until(() => hostHeard('H1b member after the reconciler'), 15_000, 'the host receiving the member after the reconciler');
  hostSock.emit('chat:send', { sessionId, message: 'H1b host after the reconciler', scope: 'lobby' });
  await expect(M.page.getByText('H1b host after the reconciler').first()).toBeVisible({ timeout: 15_000 });
  const tReload = Date.now();
  await M.page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => got(M.frames, 'session:state', tReload).length > 0, 45_000, 'the member after a refresh');
  expect(got(M.frames, 'session:evicted', tReload), 'a refresh keeps them in').toEqual([]);
  await M.page.screenshot({ path: 'test-results/h1b-3-still-in-after-36s.png' }).catch(() => {});
  console.log('  ✓ 1c 36 s later: still in, not bounced, row in_lobby, past the token check, chat both ways, a refresh too');

  hostSock.emit('host:end_session', { sessionId, endEvent: true });
  await until(async () => (await pool.query('SELECT status FROM sessions WHERE id = $1', [sessionId])).rows[0]?.status === 'completed', 60_000, 'the event ended');

  // 2. A running video meeting with its director out.
  const meeting = await apiRequest(host, 'POST', '/sessions', {
    podId: pod.id, title: 'E2E H1b Meeting', description: 'E2E test meeting',
    scheduledAt: new Date(Date.now() + 60_000).toISOString(), format: 'video_meeting', config: { maxParticipants: 50 },
  });
  const meetingId = meeting.data.id as string;
  for (const u of [guest1, guest2]) await registerForSession(u, meetingId);
  const tMeet = Date.now();
  hostSock.emit('session:join', { sessionId: meetingId });
  await until(() => got(hostSock.got, 'session:state', tMeet).length > 0, 20_000, 'the director in the meeting');
  hostSock.emit('host:start_session', { sessionId: meetingId });
  await until(() => got(hostSock.got, 'session:status_changed', tMeet).some((f) => f.payload?.status === 'lobby_open'), 30_000, 'the meeting started');
  const g1 = watch(await connectSocket(guest1));
  g1.emit('session:join', { sessionId: meetingId });
  await until(() => got(g1.got, 'session:state', tMeet).length > 0, 20_000, 'the first guest in the meeting');
  const G2 = await openPage(guest2);
  await gotoRetry(G2.page, `${APP}/session/${meetingId}/live`);
  await until(() => got(G2.frames, 'session:state').length > 0, 45_000, 'the second guest\'s page in the meeting');
  await openChat(G2.page);

  hostSock.emit('session:leave', { sessionId: meetingId });
  await until(async () => (await participantStatus(meetingId, host.id)) === 'left', 20_000, 'the director out of the meeting');
  await wait(1500);
  const tOut = Date.now();
  const ack = await sendWithAck(g1, meetingId, 'H1b guest while the director is out');
  expect(ack, `the guest's message is sent, not refused (${JSON.stringify(ack)})`).toMatchObject({ ok: true });
  await expect(G2.page.getByText('H1b guest while the director is out').first()).toBeVisible({ timeout: 15_000 });
  g1.emit('reaction:send', { sessionId: meetingId, type: 'wave' });
  await until(() => got(G2.frames, 'reaction:received', tOut).some((f) => f.payload?.type === 'wave'), 15_000, 'the guest\'s reaction on the other page');
  const stored = await pool.query('SELECT content FROM event_chat_messages WHERE session_id = $1', [meetingId]);
  expect(stored.rows.map((r) => r.content), 'the message is kept with the meeting').toContain('H1b guest while the director is out');
  // The page's own message, where the client keeps the meeting's chat open with the director out.
  const input = G2.page.getByPlaceholder('Message everyone...');
  if (await input.isVisible().catch(() => false)) {
    await say(G2.page, 'H1b page while the director is out');
    await until(() => got(g1.got, 'chat:message', tOut).some((f) => f.payload?.message === 'H1b page while the director is out'), 15_000, 'the page\'s message at the other guest');
    console.log('  ✓ 2 (this client keeps the meeting chat open) the page\'s own message went out with the director away');
  } else {
    console.log('  (this client closes its chat input while the host is away, as production\'s lobby does; the receiving side was checked)');
  }
  expect(await G2.page.getByText(HOST_GATE).count(), 'no refusal on the guest\'s page').toBe(0);
  expect(got(G2.frames, 'error', tOut).map((f) => f.payload), 'no refusal reaches the guest\'s page').toEqual([]);
  await G2.page.screenshot({ path: 'test-results/h1b-4-meeting-guest-chat.png' }).catch(() => {});
  console.log('  ✓ 2 a running meeting with its director out: a guest\'s message and reaction reach the other guest\'s page');

  hostSock.emit('session:join', { sessionId: meetingId });
  await wait(1500);
  hostSock.emit('host:end_session', { sessionId: meetingId, endEvent: true });
  await until(async () => (await pool.query('SELECT status FROM sessions WHERE id = $1', [meetingId])).rows[0]?.status === 'completed', 60_000, 'the meeting ended');

  console.log('✓ H1b SMOKE COMPLETE: a host\'s fresh invite brings a kicked member back for good; a meeting\'s chat does not wait for its director');
});
