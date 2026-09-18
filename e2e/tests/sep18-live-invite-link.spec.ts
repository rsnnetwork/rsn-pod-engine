import { test, expect, chromium, Browser, Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, createSession, endSession, apiRequest } from '../helpers/api';
import { primePreview } from '../helpers/preview-bypass';

// HEADED prod verification — Shradha's 18 Sep 2026 review, finding 2:
// "the event link says anyone can join, but it did not work." The live page's
// Invite modal shared a bare /sessions/:id URL; a member outside the event's
// private pod got "Access restricted" from it. The modal now shares a real
// event invite link (/invite/<code>), reused across opens, and an outsider
// who accepts it lands on the event with access.
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const API = process.env.E2E_API_URL || 'https://rsn-api-h04m.onrender.com';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, outsider: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(u: TestUser): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(SERVER, { auth: { token: u.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => res(s)); s.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket timeout')), 10_000);
  });
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const gotoRetry = async (page: Page, url: string) => {
  for (let i = 0; i < 3; i++) { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }); return; } catch (e) { if (i === 2) throw e; await wait(3000); } }
};
async function statusOf(u: TestUser, path: string): Promise<number> {
  const res = await fetch(`${API}/api${path}`, { headers: { Authorization: `Bearer ${u.accessToken}` } });
  return res.status;
}

test.beforeAll(async () => {
  host = await createTestUser('s18invhost', 'super_admin');
  outsider = await createTestUser('s18outsider');
  const pod = await createPod(host, 'E2E Sep18 Invite Pod'); podId = pod.id; // private pod (helper default)
  const sess = await createSession(host, podId, 'Sep18 invite link', new Date(Date.now() + 60_000), { numberOfRounds: 1 });
  sessionId = sess.id;
  browser = await chromium.launch({ headless: false, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
});

test.afterAll(async () => {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await endSession(host, sessionId); } catch {}
  console.log('Cleanup:', await cleanupTestData());
  await closePool();
});

async function pageAs(u: TestUser, width = 1200): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await ctx.addInitScript((t: { a: string; r: string; sid: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
    sessionStorage.setItem(`rsn_checkin_${t.sid}`, '1');
  }, { a: u.accessToken, r: u.refreshToken, sid: sessionId });
  await primePreview(ctx);
  return ctx.newPage();
}

async function openInviteModal(page: Page): Promise<string> {
  await page.getByTitle('Open Host Control Center').click();
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const link = page.getByTestId('live-invite-link');
  await expect(link).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => link.inputValue(), { timeout: 20_000, message: 'the modal must show a real invite link' })
    .toMatch(/\/invite\/[A-Za-z0-9_-]+$/);
  const url = await link.inputValue();
  await expect(page.getByText('Anyone with this link can join the event.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeEnabled();
  return url;
}

test('Sep18: the live Invite modal shares a real invite link an outsider can join with', async () => {
  test.setTimeout(240_000);

  // The bare event URL is gated for an outsider of a private pod: that is the
  // link the modal used to hand out.
  expect(await statusOf(outsider, `/sessions/${sessionId}`), 'outsider is denied the bare session URL').toBe(403);

  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId }); await wait(2500);

  const hostPage = await pageAs(host);
  await gotoRetry(hostPage, `${APP}/session/${sessionId}/live`);
  await hostPage.waitForTimeout(6000);

  const url1 = await openInviteModal(hostPage);
  const code = url1.split('/invite/')[1];
  console.log('  invite link:', url1);
  await hostPage.screenshot({ path: 'test-results/sep18-invite-modal.png' }).catch(() => {});

  // The invite exists as an open, whole-event link (no invitee, event capacity, 7 days).
  const inv = (await pool.query('SELECT invitee_email, max_uses, use_count, expires_at, session_id FROM invites WHERE code=$1', [code])).rows[0];
  expect(inv, 'invite row exists').toBeTruthy();
  expect(inv.session_id).toBe(sessionId);
  expect(inv.invitee_email).toBeNull();
  expect(Number(inv.max_uses)).toBe(50); // createSession helper's maxParticipants
  expect(inv.expires_at).toBeTruthy();

  // Reopening the modal reuses the same link instead of minting another code.
  await hostPage.keyboard.press('Escape');
  await hostPage.waitForTimeout(800);
  const url2 = await openInviteModal(hostPage);
  expect(url2, 'the same open link is reused').toBe(url1);
  const count = (await pool.query("SELECT COUNT(*)::int AS n FROM invites WHERE session_id=$1 AND invitee_email IS NULL", [sessionId])).rows[0].n;
  expect(count, 'exactly one open link for the event').toBe(1);
  await hostPage.keyboard.press('Escape');

  // The outsider opens the link, accepts, and lands on the event, not on "Access restricted".
  const outPage = await pageAs(outsider);
  await gotoRetry(outPage, url1);
  await outPage.getByRole('button', { name: 'Accept Invite' }).click();
  await expect(outPage).toHaveURL(new RegExp(`/sessions?/${sessionId}`), { timeout: 30_000 });
  await outPage.waitForTimeout(3000);
  await expect(outPage.getByText('Access restricted')).toHaveCount(0);
  await expect(outPage.getByText('Sep18 invite link').first()).toBeVisible({ timeout: 20_000 });
  await outPage.screenshot({ path: 'test-results/sep18-invite-outsider-landed.png' }).catch(() => {});

  const part = (await pool.query('SELECT status FROM session_participants WHERE session_id=$1 AND user_id=$2', [sessionId, outsider.id])).rows[0];
  expect(part, 'outsider is registered for the event').toBeTruthy();
  expect(await statusOf(outsider, `/sessions/${sessionId}`), 'outsider can now read the event').toBe(200);
  const used = (await pool.query('SELECT use_count FROM invites WHERE code=$1', [code])).rows[0];
  expect(Number(used.use_count)).toBe(1);

  // The same person opening the link again is told they are already in
  // (409 SESSION_ALREADY_REGISTERED), which the invite page turns into
  // "taking you to the event"; the link keeps its remaining uses for others.
  await expect(apiRequest(outsider, 'POST', `/invites/${code}/accept`)).rejects.toThrow(/SESSION_ALREADY_REGISTERED/);
  const after = (await pool.query('SELECT use_count FROM invites WHERE code=$1', [code])).rows[0];
  expect(Number(after.use_count)).toBe(1);

  console.log('  ✓ Sep18 invite link: real /invite code, reused across opens, outsider joined with access.');
});
