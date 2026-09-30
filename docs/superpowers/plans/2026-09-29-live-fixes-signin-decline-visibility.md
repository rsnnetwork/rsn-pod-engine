# Live Fixes: Sign-in Link Origin, Final Declines, Profile Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three live faults found in the 26–29 Sep 2026 audit: sign-in emails can point at any website, a declined meeting request can be re-sent forever, and the Settings "Profile visibility" switch does nothing.

**Architecture:** Three independent, root-level server fixes, each shipped on its own through the normal staging → main flow (per-bug ship process), each with a unit test that fails on today's code and a headed production smoke. Client changes are limited to wording and one disabled-button state.

**Tech Stack:** Express 4 + PostgreSQL (raw SQL via `query()`), Zod, Jest + ts-jest + supertest (server), React 18 + React Query (client), Playwright (E2E against production with throwaway users).

**Spec:** Audit findings — `workspace/audits/2026-09-26-reason-foundation/loop.md` (decline + visibility), deploy scan of 29 Sep (sign-in origin, confirmed at `server/src/services/identity/identity.service.ts:277-291`).

## Global Constraints

- One fix per deploy: fix → full server suite + client typecheck → staging CI → fast-forward main → Render + Vercel live → headed production smoke → `/checkhole` → next fix.
- Commit messages: plain-sentence subject, short "why" body, **no AI attribution lines of any kind** (Ali's global rule overrides any default footer).
- Migrations: none needed in this plan.
- User-facing text says "event", never "session"; no raw codes in messages.
- Server tests live in `server/src/__tests__/**`, run with `cd server && npx jest <file> --coverage=false`; full suite `cd server && npx jest`; client typecheck `cd client && npx tsc --noEmit`.
- E2E runs against production with throwaway users (`createTestUser`) and cleans up by exact id (`cleanup(pool, { ids })`), never by name pattern.

## Review Focus

- **A sign-in link requested from a real member's normal page** (app.rsn.network, via email or after an invite) must keep working exactly as today. Pinned by the Task 1 "keeps" cases and the Task 1 production smoke.
- **The person who declined can still ask the sender later.** A "no" blocks only the sender, not the other direction. Pinned in the Task 2 unit test and the E2E.
- **A hidden member stays reachable for people who already know them.** Messages and the profile page are unchanged; only search and suggestions drop them. Pinned by the Task 3 E2E, which opens the hidden member's profile by link.
- **A newcomer who hides themselves must not trigger "someone new matches" bells.** Pinned by the Task 3 unit test on `notifyMatchesOfNewUser`.
- **Double-clicking "I want to meet" after a decline** must yield one friendly refusal, not a new bell each time. Covered because the refusal happens before any insert (Task 2 test asserts no INSERT is issued).

---

### Task 1: Sign-in links only point at our own sites

> **Superseded detail (30 Sep 2026, review ruling):** the shipped allow-list is an exact list (the CLIENT_URL origin, `https://app.rsn.network`, `https://preview.rsn.network`, plus http localhost/127.0.0.1 in dev), not "any https *.rsn.network host": the apex is a separate site and `api.rsn.network` would log live tokens. `https://rsn.network` therefore falls back. An end-to-end test of the emailed link was added (`magic-link-emailed-link.test.ts`). Commits d8d7364b and 0ba86eb7.

**Files:**
- Create: `server/src/services/identity/client-origin.ts`
- Modify: `server/src/services/identity/identity.service.ts:277-291` (remove the local `resolveClientBaseUrl`) and `:359` (call the new one)
- Test: `server/src/__tests__/services/identity/magic-link-origin.test.ts`

**Interfaces:**
- Produces: `resolveClientBaseUrl(requested: string | undefined, cfg: { clientUrl: string; isDev: boolean }): string` and `isAllowedClientOrigin(origin: URL, cfg): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/identity/magic-link-origin.test.ts
// 29 Sep 2026: a sign-in email must only ever open one of our own sites.
// Before this, POST /auth/magic-link accepted ANY http(s) clientUrl, so anyone
// could make RSN email a member a genuine sign-in link, carrying a live
// token, that opened on a site they controlled.
import { resolveClientBaseUrl } from '../../../services/identity/client-origin';

const prod = { clientUrl: 'https://app.rsn.network', isDev: false };
const dev = { clientUrl: 'http://localhost:5173', isDev: true };

describe('sign-in links only point at our own sites', () => {
  it.each([
    [undefined, 'https://app.rsn.network'],
    ['https://app.rsn.network', 'https://app.rsn.network'],
    ['https://preview.rsn.network', 'https://preview.rsn.network'],
    ['https://rsn.network', 'https://rsn.network'],
  ])('keeps %s', (requested, expected) => {
    expect(resolveClientBaseUrl(requested, prod)).toBe(expected);
  });

  it.each([
    'https://evil.example',
    'https://rsn.network.evil.example',
    'https://evilrsn.network',
    'http://app.rsn.network',
    'https://rsn-client-evil-rsnnetwork.vercel.app',
    'https://anything.vercel.app',
    'javascript:alert(1)',
    'not a url',
    'http://localhost:5173',
  ])('falls back to the main app for %s', (requested) => {
    expect(resolveClientBaseUrl(requested, prod)).toBe('https://app.rsn.network');
  });

  it('drops any path, query or credentials from an allowed address', () => {
    expect(resolveClientBaseUrl('https://user:pw@preview.rsn.network/x?y=1', prod))
      .toBe('https://preview.rsn.network');
  });

  it('allows localhost only in development', () => {
    expect(resolveClientBaseUrl('http://localhost:5173', dev)).toBe('http://localhost:5173');
    expect(resolveClientBaseUrl('http://127.0.0.1:5173', dev)).toBe('http://127.0.0.1:5173');
  });

  it('identity.service builds the emailed link through the allow-list, not its own parser', () => {
    // Source pin: the old local resolver accepted any origin. Comments stripped
    // so a mention in a comment cannot satisfy the pin.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '../../../services/identity/identity.service.ts'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/from '\.\/client-origin'/);
    expect(src).not.toMatch(/function resolveClientBaseUrl/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest src/__tests__/services/identity/magic-link-origin.test.ts --coverage=false`
Expected: FAIL with `Cannot find module '../../../services/identity/client-origin'`.

- [ ] **Step 3: Write the allow-list**

```ts
// server/src/services/identity/client-origin.ts
// ─── Where a sign-in link may point ──────────────────────────────────────────
//
// 29 Sep 2026: the magic-link request carries the page's own address so the
// email opens the same site the member asked from (the app, a preview on
// preview.rsn.network). Before this ANY http(s) address was accepted, so anyone
// could make RSN email a member a genuine sign-in link, carrying a live token,
// that opened on a site they controlled. Only our own domain qualifies now.
// Vercel *.vercel.app hosts are deliberately NOT allowed: anyone can create a
// Vercel project whose name ends in "-rsnnetwork", so no pattern there is ours.

export interface ClientOriginConfig {
  clientUrl: string;
  isDev: boolean;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isAllowedClientOrigin(origin: URL, cfg: ClientOriginConfig): boolean {
  const main = parse(cfg.clientUrl);
  if (main && origin.origin === main.origin) return true;

  const host = origin.hostname.toLowerCase();
  if (origin.protocol === 'https:' && (host === 'rsn.network' || host.endsWith('.rsn.network'))) {
    return true;
  }
  if (cfg.isDev && origin.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')) {
    return true;
  }
  return false;
}

/** The site a sign-in email opens: the asking page's origin if it is ours, else the main app. */
export function resolveClientBaseUrl(requested: string | undefined, cfg: ClientOriginConfig): string {
  const fallback = cfg.clientUrl.replace(/\/$/, '');
  if (!requested) return fallback;
  const parsed = parse(requested);
  if (!parsed || !isAllowedClientOrigin(parsed, cfg)) return fallback;
  return parsed.origin;
}
```

- [ ] **Step 4: Use it in identity.service**

In `server/src/services/identity/identity.service.ts`:
1. Add next to the other local imports (after `import { assertCanSignIn, signInRefusal } from './account-access';`):

```ts
import { resolveClientBaseUrl } from './client-origin';
```

2. Delete the whole local function at lines 277-291 (`function resolveClientBaseUrl(requestedClientUrl?: string): string { ... }`), keeping the `// ─── Magic Link Authentication ───` banner above it.
3. Replace line 359:

```ts
  const clientBaseUrl = resolveClientBaseUrl(requestedClientUrl);
```

with:

```ts
  const clientBaseUrl = resolveClientBaseUrl(requestedClientUrl, {
    clientUrl: config.clientUrl,
    isDev: config.isDev,
  });
```

- [ ] **Step 5: Run the test and the neighbours that pin this file**

Run: `cd server && npx jest src/__tests__/services/identity src/__tests__/services/magic-link-invite-redirect.test.ts --coverage=false`
Expected: PASS (the invite-redirect pin still finds `${clientBaseUrl}/auth/verify?token=${token}`).

- [ ] **Step 6: Full suite + typecheck, then commit**

Run: `cd server && npx jest` (expect all green) and `cd server && npx tsc --noEmit` (expect no output).

```bash
git add server/src/services/identity/client-origin.ts server/src/services/identity/identity.service.ts server/src/__tests__/services/identity/magic-link-origin.test.ts
git commit -m "Sign-in emails only open our own sites" -m "The magic-link request accepted any web address as the site to open, so anyone could make RSN email a member a real sign-in link carrying a live token that opened elsewhere. Only app.rsn.network and other rsn.network sites qualify now; anything else falls back to the main app."
```

- [ ] **Step 7: Ship and smoke**

Ship with the staging → main flow (`/shipphase` steps). Production smoke (headed, Chromium):
1. Open `https://app.rsn.network/login`, request a link for Ali's own address, open it from the email: sign-in completes on app.rsn.network.
2. `curl -s -X POST https://rsn-api-h04m.onrender.com/api/auth/magic-link -H "Content-Type: application/json" -d '{"email":"<an rsn-e2e.invalid test user>","clientUrl":"https://evil.example"}'` returns 200 with the generic message (the link itself is now built on app.rsn.network; the unit test is the proof of the address).
3. `/checkhole` clean.

---

### Task 2: A "no" to a meeting request stays a no

**Files:**
- Modify: `server/src/services/poke/poke.service.ts:142-145` (new check after the block check)
- Modify: `client/src/features/profile/PublicProfilePage.tsx:256-273` (declined-by-them state)
- Modify: `server/src/__tests__/services/orchestration/s22-dm-lock-visible-reason.test.ts:71-73` (pin the new wording)
- Test: `server/src/__tests__/services/poke/poke-decline-final.test.ts`
- E2E: `e2e/tests/live-fixes-29sep.spec.ts` (Task 2 section)

**Interfaces:**
- Consumes: `sendPoke(senderId, recipientId, message?, agentId?)` (unchanged signature).
- Produces: `sendPoke` now throws `AppError(403, AUTH_FORBIDDEN, 'They declined your earlier request, so you cannot send another one.')` when a declined request from sender → recipient exists.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/poke/poke-decline-final.test.ts
// 29 Sep 2026: after someone declines, the sender could ask again from search
// or a profile as often as they liked, each time with a bell and an email.
const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: (client: { query: typeof mockQuery }) => unknown) => cb({ query: mockQuery }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: () => {} }) }, __esModule: true }));
jest.mock('../../../realtime/emit', () => ({
  emitEntities: jest.fn().mockResolvedValue(undefined),
  getRealtimeIo: () => null,
  setRealtimeIo: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../services/block/block.service', () => ({ areBlocked: async () => false, __esModule: true }));

import { sendPoke } from '../../../services/poke/poke.service';

function arm(opts: { declined: boolean }) {
  mockQuery.mockImplementation((sql: string) => {
    if (/status = 'declined'/.test(sql)) return Promise.resolve({ rows: opts.declined ? [{ id: 'p-old' }] : [] });
    if (/FROM encounter_history/.test(sql)) return Promise.resolve({ rows: [] });
    if (/SELECT id FROM users WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: [{ id: 'u-b' }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('a declined request is final for the sender', () => {
  beforeEach(() => mockQuery.mockReset());

  it('refuses a new request after the recipient declined one, and inserts nothing', async () => {
    arm({ declined: true });
    await expect(sendPoke('u-a', 'u-b', 'hello again')).rejects.toMatchObject({
      statusCode: 403,
      message: 'They declined your earlier request, so you cannot send another one.',
    });
    const inserts = mockQuery.mock.calls.map(c => String(c[0])).filter(s => /INSERT INTO user_pokes/.test(s));
    expect(inserts).toHaveLength(0);
  });

  it('only looks at declines FROM this sender TO this recipient (the decliner can still ask)', async () => {
    arm({ declined: false });
    await sendPoke('u-b', 'u-a', 'my turn').catch(() => undefined);
    const declineCheck = mockQuery.mock.calls.find(c => /status = 'declined'/.test(String(c[0])))!;
    expect(String(declineCheck[0])).toMatch(/sender_id = \$1 AND recipient_id = \$2/);
    expect(declineCheck[1]).toEqual(['u-b', 'u-a']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest src/__tests__/services/poke/poke-decline-final.test.ts --coverage=false`
Expected: FAIL. The first case resolves or fails later (no 403 with that message), and the second finds no decline check. (`AppError` exposes `statusCode` and `code`, per `server/src/middleware/errors.ts:4-20`.)

- [ ] **Step 3: Add the check in sendPoke**

In `server/src/services/poke/poke.service.ts`, directly after the block check (line 144, `}` of `if (await blockService.areBlocked(...))`), insert:

```ts
  // 29 Sep 2026: a "no" stays a no. Before this the person who declined could
  // be asked again from search or a profile as often as the sender liked, each
  // time with a bell and an email. Only sender → recipient is checked: the
  // person who said no can still ask later.
  const declined = await query<{ id: string }>(
    `SELECT id FROM user_pokes
      WHERE sender_id = $1 AND recipient_id = $2 AND status = 'declined'
      LIMIT 1`,
    [senderId, recipientId],
  );
  if (declined.rows.length > 0) {
    throw new AppError(
      403,
      ErrorCodes.AUTH_FORBIDDEN,
      'They declined your earlier request, so you cannot send another one.',
    );
  }
```

- [ ] **Step 4: Run the new test and the existing poke suites**

Run: `cd server && npx jest src/__tests__/services/poke src/__tests__/services/matching --coverage=false`
Expected: PASS. If an existing test arms `mockQuery` with a catch-all that returns `rows: [{...}]` for every query, the new decline check reads that row and throws. Fix such a test by adding `if (/status = 'declined'/.test(sql)) return Promise.resolve({ rows: [] });` as the first branch of its mock, never by weakening the new check.

- [ ] **Step 5: Show the state on the profile**

In `client/src/features/profile/PublicProfilePage.tsx`, replace the final `) : (` branch at lines 256-273 (the "I want to meet" button block) with:

```tsx
                      ) : meetingRequest?.status === 'declined' && meetingRequest.sentByMe ? (
                        <>
                          <Button size="sm" variant="ghost" disabled className="min-h-[44px] text-xs" data-testid="meet-state">
                            <Send className="mr-1.5 h-3.5 w-3.5" /> Request declined
                          </Button>
                          <span className="text-[11px] text-gray-400">They declined your earlier request</span>
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            onClick={() => interestMutation.mutate()}
                            isLoading={interestMutation.isPending}
                            className="min-h-[44px] text-xs"
                            data-testid="meet-state"
                          >
                            <Send className="mr-1.5 h-3.5 w-3.5" /> I want to meet
                          </Button>
                          <span className="text-[11px] text-gray-400">
                            {meetingRequest?.status === 'declined'
                              ? 'You declined their earlier request'
                              : 'Messaging unlocks once they accept'}
                          </span>
                        </>
                      )}
```

- [ ] **Step 6: Update the pin that reads this block**

In `server/src/__tests__/services/orchestration/s22-dm-lock-visible-reason.test.ts`, replace line 73:

```ts
    expect(block).toMatch(/A previous request was declined/);
```

with:

```ts
    expect(block).toMatch(/They declined your earlier request/);
    expect(block).toMatch(/You declined their earlier request/);
```

Run: `cd server && npx jest src/__tests__/services/orchestration/s22-dm-lock-visible-reason.test.ts --coverage=false`. Expected: PASS.

- [ ] **Step 7: Write the production E2E (Task 2 section)**

```ts
// e2e/tests/live-fixes-29sep.spec.ts
import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP, SERVER } from '../helpers/live-ui';
import { launchBrowser } from '../helpers/engine';

const PHONE = { width: 390, height: 844 };
let browser: Browser;
const ctxs: BrowserContext[] = [];
const made: string[] = [];

async function api(u: TestUser, method: string, path: string, body?: unknown) {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function openAs(u: TestUser, path: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: PHONE });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  const page = await ctx.newPage();
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

test.beforeAll(async () => { browser = await launchBrowser(); });
test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
  await browser?.close();
  if (made.length) await cleanup(pool, { ids: made });
});

test('a declined request is final for the sender; the decliner can still ask', async () => {
  const a = await createTestUser('lf-decline-a'); made.push(a.id);
  const b = await createTestUser('lf-decline-b'); made.push(b.id);

  const first = await api(a, 'POST', `/matches/platform/${b.id}/interest`);
  expect(first.status).toBe(201);
  const declined = await api(b, 'POST', `/pokes/${first.body.data.id}/decline`);
  expect(declined.status).toBe(200);

  const bells = async () => (await pool.query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'poke'`, [b.id])).rows[0].n as number;
  const before = await bells();
  expect((await api(a, 'POST', `/matches/platform/${b.id}/interest`)).status).toBe(403);
  expect((await api(a, 'POST', `/pokes`, { recipientId: b.id })).status).toBe(403);
  expect(await bells()).toBe(before);

  const page = await openAs(a, `/profile/${b.id}`);
  await expect(page.getByTestId('meet-state')).toHaveText(/Request declined/);
  await expect(page.getByTestId('meet-state')).toBeDisabled();

  expect((await api(b, 'POST', `/matches/platform/${a.id}/interest`)).status).toBe(201);
});
```

Run after the deploy lands: `cd e2e && E2E_HEADED=1 npx playwright test tests/live-fixes-29sep.spec.ts -g "declined request is final"`
Expected: 1 passed.

- [ ] **Step 8: Full suite, typecheck, commit, ship**

Run `cd server && npx jest` and `cd client && npx tsc --noEmit`, then:

```bash
git add server/src/services/poke/poke.service.ts server/src/__tests__/services/poke/poke-decline-final.test.ts server/src/__tests__/services/orchestration/s22-dm-lock-visible-reason.test.ts client/src/features/profile/PublicProfilePage.tsx e2e/tests/live-fixes-29sep.spec.ts
git commit -m "A declined meeting request is final for the sender" -m "After someone declined, the sender could ask again from search or a profile as often as they liked, each time with a bell and an email. The server now refuses a new request from the sender a person declined; the person who said no can still ask later. The profile shows the declined state instead of the button."
```

Ship via staging → main, then run the Step 7 spec headed against production, then `/checkhole`.

---

### Task 3: "Show me in search and suggestions" actually works

**Files:**
- Modify: `server/src/services/user/user-search.service.ts:62-64`
- Modify: `server/src/services/matching/platform-match.service.ts` (`loadCandidates` WHERE at ~431-433; `notifyMatchesOfNewUser` start at ~592)
- Modify: `server/src/services/matching/agent-matching.service.ts:86-88`
- Modify: `client/src/features/settings/SettingsPage.tsx:198-203`
- Test: `server/src/__tests__/services/user/profile-visible-filter.test.ts`
- E2E: `e2e/tests/live-fixes-29sep.spec.ts` (Task 3 section)

**Interfaces:**
- Produces: members with `users.profile_visible = false` are absent from Find people, both suggestion pools and new-member bells. Profile pages, messages and events are unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/services/user/profile-visible-filter.test.ts
// 29 Sep 2026: Settings → Privacy "Profile visibility" was saved but never read.
// It now means: hidden members do not appear in search or suggestions, and a
// hidden newcomer triggers no "someone new matches" bells. People who already
// know them still see their profile and messages.
import * as fs from 'fs';
import * as path from 'path';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: () => {} }) }, __esModule: true }));

import { searchMembers } from '../../../services/user/user-search.service';
import { notifyMatchesOfNewUser } from '../../../services/matching/platform-match.service';

const stripComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, '').replace(/--[^\n`]*/g, '');
const read = (rel: string) => stripComments(fs.readFileSync(path.join(__dirname, '../../../services', rel), 'utf8'));

describe('profile visibility is honoured', () => {
  beforeEach(() => mockQuery.mockReset());

  it('Find people skips hidden members', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await searchMembers('u-viewer', 'claus', 20);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/u\.profile_visible = true/);
  });

  it('both suggestion pools skip hidden members', () => {
    const platform = read('matching/platform-match.service.ts');
    const loadCandidates = platform.slice(platform.indexOf('async function loadCandidates'), platform.indexOf('export async function getPlatformMatches'));
    expect(loadCandidates).toMatch(/u\.profile_visible = true/);
    const agents = read('matching/agent-matching.service.ts');
    const pool = agents.slice(agents.indexOf('async function loadCandidatesFor'), agents.indexOf('async function loadCandidatesFor') + 2500);
    expect(pool).toMatch(/u\.profile_visible = true/);
  });

  it('a hidden newcomer sends nobody a "someone new matches" bell', async () => {
    // Fixtures mirror platform-match.test.ts: an investor newcomer and a founder
    // who wants investors score above MATCH_THRESHOLD, so without the fix a
    // bell IS inserted. The test therefore fails on today's code.
    const base = {
      avatarUrl: null, jobTitle: null, company: null, whatICanHelpWith: null, whatICareAbout: null,
      goals: null, interests: null, whyIWantToMeet: null, onboardingCompleted: true,
    };
    const newcomer = {
      ...base, id: 'u-new', displayName: 'Iqbal', professionalRole: ['Angel Investor'],
      expertiseText: 'early stage SaaS investing', myIntent: null, whoIWantToMeet: null,
    };
    const member = {
      ...base, id: 'u-member', displayName: 'Fatima', professionalRole: ['Founder'], expertiseText: null,
      whoIWantToMeet: 'investors and angels for my seed round', myIntent: 'raise funding for my SaaS startup',
    };
    mockQuery.mockImplementation((sql: string) => {
      if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [newcomer] });
      if (/SELECT profile_visible FROM users/.test(sql)) return Promise.resolve({ rows: [{ profile_visible: false }] });
      if (/WHERE u\.id <> \$1/.test(sql)) return Promise.resolve({ rows: [member] });
      if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'n1', created_at: new Date() }] });
      return Promise.resolve({ rows: [] });
    });
    const sent = await notifyMatchesOfNewUser('u-new');
    expect(sent).toBe(0);
    const inserts = mockQuery.mock.calls.map(c => String(c[0])).filter(s => /INSERT INTO notifications/.test(s));
    expect(inserts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx jest src/__tests__/services/user/profile-visible-filter.test.ts --coverage=false`
Expected: FAIL on all three cases.

- [ ] **Step 3: Filter search**

In `server/src/services/user/user-search.service.ts`, after line 64 (`AND u.onboarding_completed = true`), add:

```sql
        AND u.profile_visible = true
```

- [ ] **Step 4: Filter both suggestion pools**

In `server/src/services/matching/platform-match.service.ts` `loadCandidates`, after `AND u.onboarding_completed = true` (the one directly under `WHERE u.id <> $1 AND u.status = 'active'`), add:

```sql
       AND u.profile_visible = true
```

In `server/src/services/matching/agent-matching.service.ts` `loadCandidatesFor`, after line 88 (`AND u.onboarding_completed = true`), add:

```sql
        AND u.profile_visible = true
```

- [ ] **Step 5: Hidden newcomers send no bells**

In `server/src/services/matching/platform-match.service.ts` `notifyMatchesOfNewUser`, directly after `if (!newcomer || !newcomer.onboardingCompleted) return 0;` add:

```ts
    // 29 Sep 2026: a member who chose not to appear in suggestions must not be
    // announced to others as "someone new matches" either.
    const visibility = await query<{ profile_visible: boolean }>(
      `SELECT profile_visible FROM users WHERE id = $1`,
      [newUserId],
    );
    if (visibility.rows[0]?.profile_visible === false) return 0;
```

Before this change the third test fails: the founder is scored against the investor newcomer and a `platform_match` bell is inserted (`sent` = 1). After it, the function returns 0 before the member query runs.

- [ ] **Step 6: Honest wording in Settings**

In `client/src/features/settings/SettingsPage.tsx` lines 198-203, replace the label and description:

```tsx
          <Toggle
            enabled={profileVisible}
            onToggle={() => setProfileVisible(!profileVisible)}
            label="Show me in search and suggestions"
            description="People you already know can still see your profile and message you."
          />
```

- [ ] **Step 7: Run tests, including the matching suites**

Run: `cd server && npx jest src/__tests__/services/user src/__tests__/services/matching --coverage=false`
Expected: PASS.

- [ ] **Step 8: Production E2E (Task 3 section, append to the same spec file)**

```ts
test('a hidden member leaves search and suggestions, and comes back', async () => {
  const run = Date.now().toString(36);
  const viewer = await createTestUser('lf-vis-viewer'); made.push(viewer.id);
  const hidden = await createTestUser('lf-vis-hidden'); made.push(hidden.id);
  const name = `Zqv${run} Hidden`;
  await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [name, hidden.id]);
  const found = async () => ((await api(viewer, 'GET', `/users/find?q=Zqv${run}`)).body?.data ?? []).map((r: any) => r.userId);

  expect(await found()).toContain(hidden.id);
  expect((await api(hidden, 'PUT', '/users/me', { profileVisible: false })).status).toBe(200);
  expect(await found()).not.toContain(hidden.id);
  const browse = await api(viewer, 'GET', '/matches/platform?browse=1');
  expect((browse.body?.data?.matches ?? []).map((m: any) => m.userId)).not.toContain(hidden.id);

  // Still reachable by link for someone who has it.
  const profile = await openAs(viewer, `/profile/${hidden.id}`);
  await expect(profile.getByText(name)).toBeVisible();

  const settings = await openAs(hidden, '/settings');
  await expect(settings.getByText('Show me in search and suggestions')).toBeVisible();

  expect((await api(hidden, 'PUT', '/users/me', { profileVisible: true })).status).toBe(200);
  expect(await found()).toContain(hidden.id);
});
```

- [ ] **Step 9: Full suite, typecheck, commit, ship**

```bash
git add server/src/services/user/user-search.service.ts server/src/services/matching/platform-match.service.ts server/src/services/matching/agent-matching.service.ts server/src/__tests__/services/user/profile-visible-filter.test.ts client/src/features/settings/SettingsPage.tsx e2e/tests/live-fixes-29sep.spec.ts
git commit -m "Profile visibility now hides a member from search and suggestions" -m "The Settings switch was saved but nothing read it. Hidden members no longer appear in Find people or either suggestion list, and a hidden newcomer triggers no new-match bells. People who already know them still see their profile and messages; the Settings wording now says exactly that."
```

Ship via staging → main, run the Task 3 spec headed against production, `/checkhole`, then update `progress.md` with all three fixes, evidence and "not verified here" items.

---

## Follow-ups noted, not in this plan

- Two more Settings switches are stored but never read: "Match notifications" and "Event reminders". Wire them up or remove them next.
- `GET /users/blocked` is shadowed by `GET /users/:id` (`server/src/routes/users.ts:241` vs `:399`). It has no client caller today; move it above `/:id` when the blocked list is built.
- `GET /users/:id` returns the public card to someone the member blocked. Decide with the Human Profile work whether a block hides the profile both ways.
