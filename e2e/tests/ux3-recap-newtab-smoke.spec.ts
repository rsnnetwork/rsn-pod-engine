import { test, expect, chromium, Browser } from '@playwright/test';
import { io, Socket } from 'socket.io-client';
import { createTestUser, cleanupTestData, TestUser, closePool, pool } from '../helpers/auth';
import { createPod, addPodMember, createSession, registerForSession, endSession } from '../helpers/api';

// HEADED smoke UX3 (#UX3 June-10 debrief), changed by CON-01 (25 Oct 2026, Stefan and Claus): the recap "Message"
// action used to open a NEW TAB (window.open) to keep the recap, but a new tab has no history behind it, so Back there did
// nothing. The recap is a post-event page, not the call, so it now opens the conversation in the SAME tab and Back
// returns to the recap. (The live event's end screen keeps its new tab, and says so.)
const SERVER = process.env.E2E_SERVER_URL || 'https://api.rsn.network';
const APP = process.env.E2E_APP_URL || 'https://app.rsn.network';

let host: TestUser, m1: TestUser, m2: TestUser;
let podId: string, sessionId: string;
let browser: Browser;
const sockets: Socket[] = [];

function connect(user: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(SERVER, { auth: { token: user.accessToken }, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 10_000);
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.beforeAll(async () => {
  host = await createTestUser('ux3host', 'super_admin');
  m1 = await createTestUser('ux3m1');
  m2 = await createTestUser('ux3m2');
  const pod = await createPod(host, 'E2E UX3 Pod');
  podId = pod.id;
  await addPodMember(host, podId, m1.id);
  await addPodMember(host, podId, m2.id);
  const sess = await createSession(host, podId, 'E2E UX3 recap', new Date(Date.now() + 60_000), { numberOfRounds: 1 });
  sessionId = sess.id;
  await Promise.all([registerForSession(m1, sessionId), registerForSession(m2, sessionId)]);
  browser = await chromium.launch({
    headless: false,
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

test('UX3 + CON-01: the recap Message action opens the conversation in this tab, and Back returns to the recap', async () => {
  test.setTimeout(150_000);

  // Drive a 1-round event to completion so m1 and m2 have a recap connection.
  const hostSock = await connect(host); sockets.push(hostSock);
  hostSock.emit('host:start_session', { sessionId });
  await wait(2500);
  const m1Sock = await connect(m1); sockets.push(m1Sock); m1Sock.emit('session:join', { sessionId });
  const m2Sock = await connect(m2); sockets.push(m2Sock); m2Sock.emit('session:join', { sessionId });
  await wait(4000);
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(3000);
  hostSock.emit('host:start_round', { sessionId }); await wait(4000);

  // Look up the m1↔m2 match so both can rate (a rating creates the meeting_record
  // that the recap's "people met" connection list is built from).
  const matchId = (await pool.query(
    `SELECT id FROM matches WHERE session_id=$1 AND status IN ('active','completed')
       AND (participant_a_id=$2 OR participant_b_id=$2) ORDER BY created_at DESC LIMIT 1`,
    [sessionId, m1.id],
  )).rows[0]?.id;
  expect(matchId, 'm1 should have a match this round').toBeTruthy();

  // End the round → rating window; both rate → meeting_record; then end the event.
  hostSock.emit('host:end_session', { sessionId }); await wait(3000);
  m1Sock.emit('rating:submit', { sessionId, matchId, qualityScore: 5, meetAgain: true });
  m2Sock.emit('rating:submit', { sessionId, matchId, qualityScore: 5, meetAgain: true });
  await wait(4000);
  hostSock.emit('host:force_close_rating', { sessionId }); await wait(2000);
  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(6000);

  // Open the recap as m1.
  const ctx = await browser.newContext();
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: m1.accessToken, r: m1.refreshToken });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.goto(`${APP}/sessions/${sessionId}/recap`, { waitUntil: 'domcontentloaded', timeout: 60_000 }); break; }
    catch (e) { if (attempt === 2) throw e; await wait(3000); }
  }

  await page.waitForTimeout(6000);
  // Diagnostics: did a meeting record get created, and what does the recap render?
  const mrCols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='meeting_records'")).rows.map((r:any)=>r.column_name);
  console.log('  meeting_records columns:', mrCols.join(','));
  const mr = (await pool.query(`SELECT * FROM meeting_records WHERE ${mrCols.includes('session_id') ? 'session_id=$1' : 'match_id=$1'} LIMIT 5`, [mrCols.includes('session_id') ? sessionId : matchId])).rows;
  console.log('  meeting_records rows:', mr.length, JSON.stringify(mr).slice(0, 300));
  await page.screenshot({ path: 'test-results/ux3-recap.png' }).catch(() => {});
  const bodyTxt = await page.locator('body').innerText().catch(() => '');
  console.log('  recap body text (first 400):', bodyTxt.replace(/\n+/g, ' | ').slice(0, 400));

  // Find a recap Message button (the mutual-match connection to m2).
  const msgBtn = page.locator('[data-testid^="recap-dm-button-"]').first();
  await expect(msgBtn, 'recap should show a Message button for the connection').toBeVisible({ timeout: 25_000 });
  await msgBtn.scrollIntoViewIfNeeded().catch(() => {});

  // The button is a link in this tab: no arrow, nothing about a new tab, and a finger-sized target.
  await expect(msgBtn, 'the recap Message is a link').toHaveAttribute('href', `/messages/new/${m2.id}`);
  await expect(msgBtn).not.toHaveAttribute('target', '_blank');
  await expect(msgBtn).not.toContainText('opens in a new tab');
  expect((await msgBtn.boundingBox())!.height, 'the Message link is at least 44px tall').toBeGreaterThanOrEqual(44);

  // Clicking it opens the compose route for the partner in THIS tab, and no second tab appears.
  const recapUrlBefore = page.url();
  await msgBtn.click();
  await expect(page, 'the compose route for the partner opens in this tab').toHaveURL(new RegExp(`/messages/new/${m2.id}`), { timeout: 30_000 });
  expect(ctx.pages().length, 'no second tab was opened').toBe(1);

  // Back returns to the recap, which is still the recap.
  await page.goBack();
  await expect(page, 'Back returns to the recap').toHaveURL(recapUrlBefore, { timeout: 30_000 });
  await expect(page.locator('[data-testid^="recap-dm-button-"]').first(), 'the recap is showing').toBeVisible({ timeout: 25_000 });

  await ctx.close();
  console.log('  ✓ recap Message opened the conversation in this tab, and Back returned to the recap');
});
