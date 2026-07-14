import { test, expect, chromium, webkit, devices, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { createPod, createSession, registerForSession, addPodMember } from '../helpers/api';
import {
  connectSocket, gotoRetry, cleanup, wait, APP,
  inLobby, inRating, inBreakout, tilesSeen, intentFormShown, rateViaForm, Socket,
} from '../helpers/live-ui';

// HEADED PROD — 14 Jul live test. alihammza was on a SLOW MOBILE (Safari/mobile
// engine). His socket dropped + reconnected 7+ times in 4 minutes; after round 1
// he was STUCK at 'checked_in' in the main room and even a refresh couldn't get
// him back. The desktop users were fine.
//
// This runs the storming participant in WEBKIT with a real iPhone profile (the
// closest engine to his browser) and the stable participants + host in CHROMIUM
// (desktop). After round 1 the mobile user's connection STORMS — one long
// outage (past the 15s grace → marked 'left', long enough to churn many socket
// reconnect attempts) plus churny short drops — then STEADIES.
//
// THE BAR (the fixes shipped in cbd8dcf):
//   • infinite reconnection — the socket never dead-ends at "please refresh";
//   • recovery burst — a behind client re-converges within seconds of any good
//     window, at any live phase.
// So once the network steadies the mobile user MUST auto-recover into the main
// room and take part in round 2 — never stuck, no refresh.

let chromeB: Browser;   // desktop participants + nothing else
let webkitB: Browser;   // the mobile (storming) participant
let host: TestUser;
const P: TestUser[] = [];              // P[0] = mobile/webkit, P[1..] = desktop/chromium
const ctxs: BrowserContext[] = [];
const pages: Page[] = [];
let hostSock: Socket;
let podId = '', sessionId = '';
const NP = 3;
const MOBILE = 0;                      // index of the storming mobile user
const pageOf = (i: number) => pages[i];

async function pollAll(fn: (p: Page) => Promise<boolean>, label: string, timeout = 60_000) {
  await expect.poll(async () => (await Promise.all(pages.map(p => fn(p)))).filter(Boolean).length,
    { timeout, message: label }).toBe(NP);
}

/** Open one participant on a specific engine. WebKit gets a real iPhone profile
 *  + granted media (no Chromium fake-device flags exist there). */
async function open(browser: Browser, u: TestUser, mobile: boolean): Promise<void> {
  const ctx = await browser.newContext(
    mobile
      ? { ...devices['iPhone 13'] }                // webkit, 390×844, isMobile+touch
      : { viewport: { width: 1280, height: 800 } }, // chromium desktop
  );
  // Playwright's WebKit on Windows exposes NO fake media device — worse,
  // `navigator.mediaDevices` is `undefined`, so the Lobby's getUserMedia call
  // throws into its error boundary ("Something went wrong in Lobby") and the
  // normal lobby UI never renders. A real iPhone HAS mediaDevices + a camera,
  // so this is purely a headless-WebKit gap (the exact thing Chromium's
  // --use-fake-device flag papers over automatically). Give WebKit a synthetic
  // camera so it behaves like a real device and we can exercise the reconnect
  // path on the actual Safari engine.
  if (mobile) {
    await ctx.addInitScript(() => {
      if (!(navigator as any).mediaDevices) {
        const makeStream = () => {
          try {
            const c = document.createElement('canvas'); c.width = 320; c.height = 240;
            const g = c.getContext('2d');
            setInterval(() => { if (g) { g.fillStyle = '#223355'; g.fillRect(0, 0, 320, 240); } }, 200);
            return (c as any).captureStream ? (c as any).captureStream(10) : new MediaStream();
          } catch { return new MediaStream(); }
        };
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: async () => makeStream(),
            enumerateDevices: async () => [],
            getSupportedConstraints: () => ({}),
            addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
          },
        });
      }
    });
  }
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a); localStorage.setItem('rsn_refresh', t.r);
  }, { a: u.accessToken, r: u.refreshToken });
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  ctxs.push(ctx); pages.push(page);
  await gotoRetry(page, `${APP}/session/${sessionId}/live`);
}

/** Dismiss the per-event intent form if it's up (so it can't cover the room). */
async function clearIntent(page: Page): Promise<void> {
  if (await intentFormShown(page).catch(() => false)) {
    await page.getByRole('button', { name: /^(Set|Skip)$/i }).first().click().catch(() => {});
    await wait(800);
  }
}

/** A slow-mobile reconnect STORM on one context, then the network steadies.
 *  One long outage past the grace + churny short drops — alihammza's trace. */
async function storm(ctx: BrowserContext): Promise<void> {
  await ctx.setOffline(true);  await wait(45_000); // long outage → 'left' + many reconnect attempts
  await ctx.setOffline(false); await wait(6_000);  // brief good window
  await ctx.setOffline(true);  await wait(12_000); // churn
  await ctx.setOffline(false); await wait(5_000);
  await ctx.setOffline(true);  await wait(12_000); // churn
  await ctx.setOffline(false);                     // network now STEADY
}

test.beforeAll(async () => {
  host = await createTestUser('ux7host', 'super_admin');
  for (let i = 1; i <= NP; i++) P.push(await createTestUser(`ux7p${i}`));
  const pod = await createPod(host, 'E2E UX7 Mobile Pod'); podId = pod.id;
  await Promise.all(P.map(u => addPodMember(host, podId, u.id)));
  const sess = await createSession(host, podId, 'VERIFY mobile webkit reconnect', new Date(Date.now() + 60_000), {
    numberOfRounds: 2, roundDurationSeconds: 150, ratingWindowSeconds: 25,
  });
  sessionId = sess.id;
  await Promise.all(P.map(u => registerForSession(u, sessionId)));
  chromeB = await chromium.launch({
    headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  webkitB = await webkit.launch({ headless: false });
});

test.afterAll(async () => {
  try { hostSock?.close(); } catch {}
  try { await chromeB?.close(); } catch {}
  try { await webkitB?.close(); } catch {}
  await cleanup(pool, { ids: [host?.id, ...P.map(p => p.id)].filter(Boolean), podId });
});

test('slow mobile (WebKit) storms its connection after round 1 and STILL recovers to the main room — never stuck, no refresh', async () => {
  test.setTimeout(600_000);
  hostSock = await connectSocket(host);

  // p0 = MOBILE on WebKit (the "alihammza" user); p1, p2 = DESKTOP on Chromium.
  await open(webkitB, P[MOBILE], true);
  for (let i = 1; i < NP; i++) await open(chromeB, P[i], false);
  await wait(6000);
  for (const p of pages) await clearIntent(p);

  hostSock.emit('host:start_session', { sessionId }); await wait(3000);
  await pollAll(inLobby, 'all (incl. mobile WebKit) in the main room after start');
  console.log('  ✓ mobile WebKit user reached the main room on start.');

  // ── Round 1 → breakouts (mobile user included) ──
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(8000);
  await pollAll(inBreakout, 'round 1: all (incl. mobile) in breakouts');
  console.log('  ✓ mobile WebKit user entered its round-1 breakout.');

  // ── Round 1 ends → rating → back to the main room ──
  hostSock.emit('host:end_session', { sessionId }); await wait(4000); // → ROUND_RATING
  for (let i = 0; i < NP; i++) if (await inRating(pageOf(i))) await rateViaForm(pageOf(i), { stars: 4 });
  hostSock.emit('host:force_close_rating', { sessionId });            // → ROUND_TRANSITION
  await pollAll(inLobby, 'round 1: all returned to the main room (pre-storm)', 60_000);

  // ── The mobile user's connection STORMS (exactly alihammza's failure point:
  //    stuck after round 1, refresh didn't help), then STEADIES. ──
  console.log('  >>> mobile WebKit storm: 45s outage (→ left) + churny drops <<<');
  await storm(ctxs[MOBILE]);
  console.log('  >>> mobile network steadied — must auto-recover to the main room, no refresh <<<');

  // THE BAR: the mobile user auto-recovers into the main room within seconds.
  await expect.poll(() => inLobby(pageOf(MOBILE)),
    { timeout: 60_000, message: 'stormed mobile WebKit user MUST recover into the main room once steady (never stuck)' }).toBe(true);
  await pageOf(MOBILE).screenshot({ path: 'test-results/ux7-mobile-recovered.png' }).catch(() => {});
  // Best-effort convergence signal — LOGGED, not asserted. WebKit WebRTC under
  // Playwright is unreliable at rendering <video> tiles, so we don't gate the
  // "not stuck" verdict on it. The hard proof the user recovered as a real,
  // matchable participant is that they re-enter a breakout in round 2 below.
  const mobileTiles = await tilesSeen(pageOf(MOBILE));
  console.log(`  ✓ mobile WebKit user RECOVERED into the main room after the storm (tiles seen: ${mobileTiles}).`);

  // And it can still take part in round 2 — proves it recovered as a real,
  // matchable participant, not a stuck zombie.
  hostSock.emit('host:generate_matches', { sessionId }); await wait(6000);
  hostSock.emit('host:confirm_matches', { sessionId }); await wait(2500);
  hostSock.emit('host:start_round', { sessionId }); await wait(8000);
  await pollAll(inBreakout, 'round 2: recovered mobile user + all enter breakouts');
  console.log('  ✓ recovered mobile WebKit user joined round 2 normally.');

  hostSock.emit('host:end_session', { sessionId }); await wait(4000);
  for (let i = 0; i < NP; i++) if (await inRating(pageOf(i))) await rateViaForm(pageOf(i), { stars: 4 });
  hostSock.emit('host:end_session', { sessionId, endEvent: true }); await wait(6000);
});
