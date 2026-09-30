# REASON Milestone 1 (Shell, For You, Human Card, Human Profile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first milestone of Stefan's approved REASON design. That means the new app shell on desktop and phone, the For You home, the Human Card and the Human Profile. It runs on real data at `preview.rsn.network` for Stefan to review before anything reaches members.

**Architecture:** Two parts.

- **Part A** adds server capability that nothing in today's app calls ("dark"), and ships it to production through the normal staging → main flow:
  - migration 101;
  - `/api/people/*` for the person brief, Save/Pass, "what happened" and recent connections;
  - a personal note and preferred format on the existing meeting request;
  - richer For You data.
- **Part B** is client-only, on branch `reason-m1`:
  - it is never merged to main until Stefan approves;
  - Vercel builds it as a preview, and `preview.rsn.network` is pointed at that branch;
  - old pages keep working inside the new shell.

**Tech Stack:**
- Server: Express 4, PostgreSQL (raw SQL), Zod, Jest + ts-jest + supertest.
- Client: React 18, React Router, React Query, Zustand, Tailwind 3.4.
- Shared: the `@rsn/shared` package.
- Verification: Playwright E2E against production data with throwaway users.

**Spec:**
- `workspace/assets/RSN OVERHAUL/2026-09-28 Ali handoff (v3 + v4)/REASON_Ali_Handoff_v4/READ_ME_FIRST.txt`
- `.../REASON_Ali_Handoff_v4/IMPLEMENTATION_CHECKLIST.txt`
- `.../REASON_Ali_Handoff_v4/prototype/index.html` (the approved UX reference: layout, copy, colours, sizes)
- `.../REASON_Ali_Handoff_v4/reference/REASON_Strategic_Foundation.pdf`
- `.../REASON technical mapping - Ali 2026-09-29.pdf`. Stefan approved its four points "as written" on 29 Sep 2026.
- Audit: `workspace/audits/2026-09-26-reason-foundation/` (live code facts with file:line).

## Global Constraints

- **Do not redesign.** Reproduce the v4 prototype's layout, copy, palette (ink `#11131a`, muted `#6d7380`, line `#e8e9ec`, soft `#f7f7f8`, warm `#fbfaf7`, pink `#fff1ef`, green `#18a86b`, amber `#c77a14`), radii, type scale and Inter font. Only these deviations are allowed:
  1. The brand red is `#DE322E`, hover `#C52B28`, not `#ef3f35` (approved point 4: contrast).
  2. The prototype's own layout faults are fixed:
     - the 721–980px rail shows its icons, each with an aria-label;
     - the For You card uses its 4-column layout only at ≥1420px and stacks below that, so nothing clips at 1024 or 1280;
     - every touch target is ≥44px.
  3. Privacy (approved point 1): another member's wants are never shown until the per-reason share switch exists.
     - Cards show **"They can bring"** (their public offer) and **"You are looking for"** (the viewer's own want). They do not show "They need" or "You can bring".
     - The Human Profile's "Active reasons" column says the person has not shared them yet.
  4. Responses are **Meet / Save / Pass** (approved point 2 and the v4 prototype). Save means "maybe later" and keeps the person. Pass means "not relevant" and hides them from For You until undone.
  5. The explanation text and the "first 20 minutes" line are fixed templates built from members' own answers, with no AI (approved point 3).
  6. Nothing is invented:
     - the "Suggested entities" panel and the event photo are left out;
     - a section with no real data shows an honest sheep empty state.
- **Logo:** the official sheep mark `client/public/rsn-sheep.png` (pixel-identical to `OFFICIAL_LOGO_REFERENCE.png`) with the "REASON" wordmark and a small "RSN". Ship none of the prototype's `logo_*.png` files.
- **Sheep poses:** the prototype's set, resized to 384px (≤200KB each), served from `client/public/sheep/v4/`.
- **Responsive, mobile-first:**
  - Verify at 360, 390, 430, 768, 1024, 1280, 1440 and 1920px, in Chromium and WebKit.
  - No horizontal scroll, no clipped text or buttons.
  - Bottom bar at ≤720px.
  - `env(safe-area-inset-*)` on every fixed bar.
  - Inputs are 16px on phones.
- **Real-time:** every server mutation emits entity tags. Every `useQuery` declares `meta.entities`, which the `phase-may19-realtime-migration-phase6` server test enforces over all of `client/src`.
- **Migrations:** the next file is `101_…`. No `BEGIN`/`COMMIT` in the file, because the runner wraps each file itself.
- **Commits:** plain-sentence subject, a short "why" body, and **no AI attribution lines**. Ali's global rule overrides any default footer.
- **Wording:** user-facing text says "event", never "session".
- **Production data:** the preview reads and writes production data. "Meet" there sends a real request. E2E uses throwaway users and cleans up by exact id.
- **Order:** this plan starts after `docs/superpowers/plans/2026-09-29-live-fixes-signin-decline-visibility.md` has shipped. Its Task 1 lets sign-in emails open `preview.rsn.network`, and its Task 3 edits the same `loadCandidates` query as Task A6.

## Review Focus

- **Very long names or companies, and members with no photo.** Cards and the profile must not overflow at 360px, and initials must replace the photo. Pinned in Task B7 (seeded 60-character name, no avatar, overflow asserts).
- **Another member's private "who I want to meet" text must never reach the page.** Pinned by the Task A5 unit test (`person` carries no private keys; the opener never quotes them) and the Task B7 DOM assertion on a seeded secret.
- **A blocked or closed account opened by link** shows "This profile is not available" and no data. Pinned by the Task A5 unit test (404) and Task B7 (`/people/<blocked>`).
- **Double-pressing "Send request"** creates exactly one request. Pinned in Task B7 (double click, then assert exactly one `user_pokes` row).
- **The For You data request failing** shows an error with "Try again", never a blank page. Pinned in Task B7 (the route is forced to 500).

---

## Part A: server capability, shipped dark to production

### Task A1: Shared vocabulary and the three new database pieces

**Files:**
- Create: `shared/src/types/reason.ts`
- Modify: `shared/src/index.ts` (append exports)
- Create: `server/src/db/migrations/101_reason_m1.sql`
- Test: `server/src/__tests__/services/people/reason-shared.test.ts`
- Test: `server/src/__tests__/db/migration-101.test.ts`

**Interfaces:**
- Produces:
  - types `PersonResponse`, `MeetingFormat`, `WorthContinuing`, `OutcomeKey`, `RelationshipState`, `MatchStrength`, `PrimaryAction`, `PersonBrief`, `RecentConnection`;
  - values `MEETING_FORMATS`, `OUTCOME_KEYS`, `OUTCOME_LABELS`, `primaryActionFor(state): PrimaryAction`;
  - tables `person_responses` and `meeting_outcomes`, and column `user_pokes.preferred_format`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/__tests__/services/people/reason-shared.test.ts
// Jest maps @rsn/shared to shared/src (server/jest.config.js), so no build is needed to run this.
import { primaryActionFor, OUTCOME_KEYS, OUTCOME_LABELS, MEETING_FORMATS } from '@rsn/shared';

describe('REASON shared vocabulary (milestone 1)', () => {
  it.each([
    ['none', 'meet'],
    ['requested', 'requested'],
    ['incoming', 'respond'],
    ['declined', 'declined'],
    ['connected', 'continue'],
    ['met', 'continue'],
  ] as const)('state %s offers %s', (state, action) => {
    expect(primaryActionFor(state)).toBe(action);
  });

  it('outcomes are exactly the Foundation S10 list, each with a label', () => {
    expect([...OUTCOME_KEYS]).toEqual([
      'follow_up', 'introduction', 'potential_customer', 'potential_partnership',
      'advice', 'investment', 'hiring', 'friendship', 'nothing_yet',
    ]);
    for (const k of OUTCOME_KEYS) expect(OUTCOME_LABELS[k]).toBeTruthy();
  });

  it('meeting formats are the three the v4 prototype offers', () => {
    expect(MEETING_FORMATS.map(f => f.label)).toEqual([
      '20 minute video conversation', 'In person coffee', 'Message first',
    ]);
  });
});
```

```ts
// server/src/__tests__/db/migration-101.test.ts
import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/101_reason_m1.sql'), 'utf8');

describe('migration 101 (REASON milestone 1)', () => {
  it('has no BEGIN/COMMIT (the runner wraps each file in its own transaction)', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
  it('adds both tables and the request format column, idempotently, cascading with the user', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS person_responses/);
    expect(sql).toMatch(/UNIQUE \(user_id, target_user_id\)/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS meeting_outcomes/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS preferred_format/);
    expect((sql.match(/ON DELETE CASCADE/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/__tests__/services/people/reason-shared.test.ts src/__tests__/db/migration-101.test.ts --coverage=false`
Expected: FAIL. `primaryActionFor` is not exported, and `ENOENT` for the migration file.

- [ ] **Step 3: Write the shared types**

```ts
// shared/src/types/reason.ts
// ─── REASON milestone 1 (29 Sep 2026) ────────────────────────────────────────
// Shared by the server (validation, payloads) and the client (For You, the
// Human Profile). The VALUES here are rendered by the client, so index.ts also
// gives each its own named re-export (Rollup CJS interop; see OPENINGS there).

import type { PublicMember } from './user';

export type PersonResponse = 'saved' | 'passed';
export type MeetingFormat = 'video_20' | 'coffee' | 'message_first';
export type WorthContinuing = 'yes' | 'maybe' | 'no';
export type MatchStrength = 'strong' | 'close';
export type RelationshipState = 'none' | 'requested' | 'incoming' | 'declined' | 'connected' | 'met';
export type PrimaryAction = 'meet' | 'requested' | 'respond' | 'declined' | 'continue';

export const MEETING_FORMATS: ReadonlyArray<{ key: MeetingFormat; label: string }> = [
  { key: 'video_20', label: '20 minute video conversation' },
  { key: 'coffee', label: 'In person coffee' },
  { key: 'message_first', label: 'Message first' },
];

// Foundation S10, "What came from the conversation?"
export const OUTCOME_KEYS = [
  'follow_up', 'introduction', 'potential_customer', 'potential_partnership',
  'advice', 'investment', 'hiring', 'friendship', 'nothing_yet',
] as const;
export type OutcomeKey = (typeof OUTCOME_KEYS)[number];

export const OUTCOME_LABELS: Record<OutcomeKey, string> = {
  follow_up: 'Follow up',
  introduction: 'Introduction',
  potential_customer: 'Potential customer',
  potential_partnership: 'Potential partnership',
  advice: 'Advice',
  investment: 'Investment',
  hiring: 'Hiring',
  friendship: 'Friendship',
  nothing_yet: 'Nothing yet',
};

/** What the main button on a person offers, given where the relationship stands. */
export function primaryActionFor(state: RelationshipState): PrimaryAction {
  switch (state) {
    case 'requested': return 'requested';
    case 'incoming': return 'respond';
    case 'declined': return 'declined';
    case 'connected':
    case 'met': return 'continue';
    default: return 'meet';
  }
}

export interface PersonBrief {
  person: PublicMember;
  match: { reason: string; strength: MatchStrength } | null;
  /** The person's own public offer ("what I can help with"). */
  theyCanBring: string | null;
  /** The VIEWER's own want. Never the other person's (those stay private). */
  youAreLookingFor: string | null;
  opener: string;
  relationship: {
    state: RelationshipState;
    pokeId: string | null;
    timesMet: number;
    lastMetAt: string | null;
    saved: boolean;
    passed: boolean;
    outcomes: Array<{ worthContinuing: WorthContinuing; outcomes: OutcomeKey[]; createdAt: string }>;
  };
  shared: {
    circles: Array<{ id: string; name: string }>;
    pods: Array<{ id: string; name: string }>;
    upcomingEvents: Array<{ id: string; title: string; scheduledAt: string }>;
  };
  path: { id: string; displayName: string } | null;
}

export interface RecentConnection {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  connectedAt: string;
}
```

- [ ] **Step 4: Export them from the package**

Append to `shared/src/index.ts`:

```ts
export * from './types/reason';
// Real VALUES the client renders (For You, the Human Profile), so each needs
// its own statically analysable named export, same as OPENINGS above.
import {
  MEETING_FORMATS as _MEETING_FORMATS, OUTCOME_KEYS as _OUTCOME_KEYS,
  OUTCOME_LABELS as _OUTCOME_LABELS, primaryActionFor as _primaryActionFor,
} from './types/reason';
export const MEETING_FORMATS = _MEETING_FORMATS;
export const OUTCOME_KEYS = _OUTCOME_KEYS;
export const OUTCOME_LABELS = _OUTCOME_LABELS;
export const primaryActionFor = _primaryActionFor;
```

- [ ] **Step 5: Write the migration**

```sql
-- server/src/db/migrations/101_reason_m1.sql
-- REASON milestone 1 (29 Sep 2026). Save / Pass on a person, what happened
-- after two people met, and the format a meeting request asks for.
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

CREATE TABLE IF NOT EXISTS person_responses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response       TEXT NOT NULL CHECK (response IN ('saved', 'passed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id <> target_user_id),
  UNIQUE (user_id, target_user_id)
);
CREATE INDEX IF NOT EXISTS idx_person_responses_user ON person_responses (user_id, response);
CREATE INDEX IF NOT EXISTS idx_person_responses_target ON person_responses (target_user_id);

CREATE TABLE IF NOT EXISTS meeting_outcomes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worth_continuing TEXT NOT NULL CHECK (worth_continuing IN ('yes', 'maybe', 'no')),
  outcome_keys     TEXT[] NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id <> target_user_id)
);
CREATE INDEX IF NOT EXISTS idx_meeting_outcomes_pair ON meeting_outcomes (user_id, target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_outcomes_target ON meeting_outcomes (target_user_id);

ALTER TABLE user_pokes
  ADD COLUMN IF NOT EXISTS preferred_format TEXT NULL
  CHECK (preferred_format IN ('video_20', 'coffee', 'message_first'));
```

- [ ] **Step 6: Run the tests, and build shared for the client**

Run: `cd server && npx jest src/__tests__/services/people/reason-shared.test.ts src/__tests__/db/migration-101.test.ts --coverage=false && cd .. && npm run build:shared`
Expected: PASS (both files), and the shared build succeeds (the client and the running server read `shared/dist`).

- [ ] **Step 7: Prove the migration runs against real data, without touching production**

Create `workspace/scripts/try-migration.mjs` (private workspace repo, not the code repo):

```js
// Runs one migration file inside BEGIN … ROLLBACK against the given database.
import fs from 'node:fs';
import pg from 'pg';

const [, , url, file] = process.argv;
const sql = fs.readFileSync(file, 'utf8');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  console.log('migration OK:', file);
} finally {
  await client.query('ROLLBACK');
  await client.end();
}
```

Run it against a throwaway Neon branch of production (the project id is in memory `reference_neon_cli.md`):

```bash
neonctl branches create --project-id "$NEON_PROJECT_ID" --name try-101
node workspace/scripts/try-migration.mjs "$(neonctl connection-string try-101 --project-id "$NEON_PROJECT_ID")" server/src/db/migrations/101_reason_m1.sql
neonctl branches delete try-101 --project-id "$NEON_PROJECT_ID"
```

Expected: `migration OK: server/src/db/migrations/101_reason_m1.sql`.

- [ ] **Step 8: Commit**

```bash
git add shared/src/types/reason.ts shared/src/index.ts server/src/db/migrations/101_reason_m1.sql server/src/__tests__/services/people/reason-shared.test.ts server/src/__tests__/db/migration-101.test.ts
git commit -m "REASON vocabulary and tables for Save, Pass and meeting outcomes" -m "Milestone 1 of Stefan's approved design needs a place to remember Save and Pass on a person, what came of a meeting, and the format a meeting request asks for. Additive only: two new tables and one nullable column."
```

---

### Task A2: Save and Pass

**Files:**
- Create: `server/src/services/people/person-response.service.ts`
- Create: `server/src/services/people/text.ts`
- Create: `server/src/routes/people.ts`
- Modify: `server/src/middleware/rateLimit.ts` (append a limiter)
- Modify: `server/src/index.ts:59` and `:350` (import and mount)
- Test: `server/src/__tests__/services/people/person-response.test.ts`
- Test: `server/src/__tests__/routes/people-routes.test.ts`

**Interfaces:**
- Consumes: `PersonResponse` (A1).
- Produces:
  - `setResponse(userId, targetId, response): Promise<void>`
  - `clearResponse(userId, targetId): Promise<void>`
  - `getResponse(userId, targetId): Promise<PersonResponse | null>`
  - `clip(text, max?): string | null`
  - `PUT /api/people/:userId/response {response}` and `DELETE /api/people/:userId/response`, each emitting `user:<actor>` through the existing `fanoutUserEntity` (`server/src/realtime/fanout.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/__tests__/services/people/person-response.test.ts
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));

import { setResponse, clearResponse, getResponse } from '../../../services/people/person-response.service';
import { clip } from '../../../services/people/text';

describe('Save / Pass on a person', () => {
  beforeEach(() => mockQuery.mockReset());

  it('upserts one row per pair, so Save then Pass leaves Pass', async () => {
    mockQuery.mockImplementation((sql: string) =>
      Promise.resolve({ rows: /SELECT id FROM users/.test(sql) ? [{ id: 'u-b' }] : [] }));
    await setResponse('u-a', 'u-b', 'saved');
    await setResponse('u-a', 'u-b', 'passed');
    const upserts = mockQuery.mock.calls.filter(c => /INSERT INTO person_responses/.test(String(c[0])));
    expect(upserts).toHaveLength(2);
    expect(String(upserts[1][0])).toMatch(/ON CONFLICT \(user_id, target_user_id\)/);
    expect(upserts[1][1]).toEqual(['u-a', 'u-b', 'passed']);
  });

  it('refuses yourself and unknown people', async () => {
    await expect(setResponse('u-a', 'u-a', 'saved')).rejects.toMatchObject({ statusCode: 400 });
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(setResponse('u-a', 'u-ghost', 'saved')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('clears and reads back', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await clearResponse('u-a', 'u-b');
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/DELETE FROM person_responses/);
    mockQuery.mockResolvedValueOnce({ rows: [{ response: 'saved' }] });
    await expect(getResponse('u-a', 'u-b')).resolves.toBe('saved');
  });

  it('clip trims, shortens and turns blank into null', () => {
    expect(clip('  ')).toBeNull();
    expect(clip(null)).toBeNull();
    expect(clip('abc', 10)).toBe('abc');
    expect(clip('a'.repeat(200), 20)).toHaveLength(20);
  });
});
```

```ts
// server/src/__tests__/routes/people-routes.test.ts
import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active before any route runs.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockSet = jest.fn().mockResolvedValue(undefined);
const mockClear = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/people/person-response.service', () => ({
  setResponse: (...a: unknown[]) => mockSet(...a),
  clearResponse: (...a: unknown[]) => mockClear(...a),
  getResponse: jest.fn(),
  __esModule: true,
}));
const mockFanout = jest.fn().mockResolvedValue(undefined);
jest.mock('../../realtime/fanout', () => ({ fanoutUserEntity: (...a: unknown[]) => mockFanout(...a), __esModule: true }));

import peopleRoutes from '../../routes/people';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/people', peopleRoutes);
app.use(notFoundHandler);
app.use(errorHandler);

const token = (sub = 'u-viewer') =>
  jwt.sign({ sub, email: `${sub}@example.com`, role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' });
const TARGET = '5f0c3a3e-8d7b-4a57-9d0e-1f2a3b4c5d6e';

describe('PUT/DELETE /people/:userId/response', () => {
  beforeEach(() => { mockSet.mockClear(); mockClear.mockClear(); mockFanout.mockClear(); });

  it('saves, then tells the member\'s own screens to refresh', async () => {
    const res = await request(app).put(`/people/${TARGET}/response`).set('Authorization', `Bearer ${token()}`).send({ response: 'saved' });
    expect(res.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith('u-viewer', TARGET, 'saved');
    expect(mockFanout).toHaveBeenCalledWith('u-viewer');
  });

  it('rejects an unknown response, a bad id, and a missing token', async () => {
    const bad = await request(app).put(`/people/${TARGET}/response`).set('Authorization', `Bearer ${token()}`).send({ response: 'like' });
    expect(bad.status).toBe(400);
    const badId = await request(app).put('/people/not-a-uuid/response').set('Authorization', `Bearer ${token()}`).send({ response: 'saved' });
    expect(badId.status).toBe(400);
    const anon = await request(app).put(`/people/${TARGET}/response`).send({ response: 'saved' });
    expect(anon.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('undoes', async () => {
    const res = await request(app).delete(`/people/${TARGET}/response`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(mockClear).toHaveBeenCalledWith('u-viewer', TARGET);
    expect(mockFanout).toHaveBeenCalledWith('u-viewer');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/__tests__/services/people/person-response.test.ts src/__tests__/routes/people-routes.test.ts --coverage=false`
Expected: FAIL with "Cannot find module" for the new service and route.

- [ ] **Step 3: Write the helper and the service**

```ts
// server/src/services/people/text.ts
/** Trimmed text shortened to `max` characters (with an ellipsis), or null when blank. */
export function clip(text: string | null | undefined, max = 160): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
```

```ts
// server/src/services/people/person-response.service.ts
// ─── Save / Pass on a person (REASON milestone 1, 29 Sep 2026) ───────────────
// Save = "maybe later": kept, and marked. Pass = "not relevant right now":
// hidden from For You until undone. One row per (member, person); the latest
// choice wins. Private to the member who made it.

import { query } from '../../db';
import { ErrorCodes, type PersonResponse } from '@rsn/shared';
import { AppError, NotFoundError } from '../../middleware/errors';

export async function setResponse(userId: string, targetId: string, response: PersonResponse): Promise<void> {
  if (userId === targetId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot save or pass yourself');
  }
  const target = await query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [targetId]);
  if (target.rows.length === 0) throw new NotFoundError('User', targetId);
  await query(
    `INSERT INTO person_responses (user_id, target_user_id, response)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, target_user_id)
     DO UPDATE SET response = EXCLUDED.response, updated_at = NOW()`,
    [userId, targetId, response],
  );
}

export async function clearResponse(userId: string, targetId: string): Promise<void> {
  await query(`DELETE FROM person_responses WHERE user_id = $1 AND target_user_id = $2`, [userId, targetId]);
}

export async function getResponse(userId: string, targetId: string): Promise<PersonResponse | null> {
  const r = await query<{ response: PersonResponse }>(
    `SELECT response FROM person_responses WHERE user_id = $1 AND target_user_id = $2`,
    [userId, targetId],
  );
  return r.rows[0]?.response ?? null;
}
```

- [ ] **Step 4: Add the rate limiter**

Append to the end of `server/src/middleware/rateLimit.ts` (not between `authLimiter` and `inviteLimiter`, which a test reads in order):

```ts
// REASON milestone 1 (29 Sep 2026): Save / Pass / "what happened" writes.
export const peopleWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildStore('people-write'),
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a moment, then try again.' } },
});
```

- [ ] **Step 5: Write the route file**

```ts
// server/src/routes/people.ts
// ─── People (REASON milestone 1, 29 Sep 2026) ────────────────────────────────
// PUT    /people/:userId/response  { response: 'saved' | 'passed' }
// DELETE /people/:userId/response
// (Task A3 adds POST /people/:userId/outcome; Task A5 adds the brief and
//  /people/connections/recent.)

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { ApiResponse } from '@rsn/shared';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { peopleWriteLimiter } from '../middleware/rateLimit';
import { fanoutUserEntity } from '../realtime/fanout';
import * as responses from '../services/people/person-response.service';

const router = Router();

const userParams = z.object({ userId: z.string().uuid('Not a member id') });
const responseBody = z.object({ response: z.enum(['saved', 'passed']) });

// Every write here changes only the member's own view. fanoutUserEntity emits
// user:<id>, which their For You, profile brief and side panels listen on.

router.put(
  '/:userId/response',
  authenticate,
  peopleWriteLimiter,
  validate(userParams, 'params'),
  validate(responseBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await responses.setResponse(req.user!.userId, req.params.userId, req.body.response);
      void fanoutUserEntity(req.user!.userId);
      res.json({ success: true, data: { response: req.body.response } } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/:userId/response',
  authenticate,
  peopleWriteLimiter,
  validate(userParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await responses.clearResponse(req.user!.userId, req.params.userId);
      void fanoutUserEntity(req.user!.userId);
      res.json({ success: true, data: { response: null } } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
```

- [ ] **Step 6: Mount it**

In `server/src/index.ts`, after line 59 (`import matchesRoutes from './routes/matches';`) add `import peopleRoutes from './routes/people';`. After line 350 (`app.use('/api/matches', matchesRoutes);`) add `app.use('/api/people', peopleRoutes);`.

- [ ] **Step 7: Run the tests**

Run: `cd server && npx jest src/__tests__/services/people src/__tests__/routes/people-routes.test.ts --coverage=false`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/people server/src/routes/people.ts server/src/middleware/rateLimit.ts server/src/index.ts server/src/__tests__/services/people/person-response.test.ts server/src/__tests__/routes/people-routes.test.ts
git commit -m "Members can save or pass on a person" -m "Save keeps someone for later; Pass hides them from For You until undone. Private to the member, one row per pair, rate limited, and the member's own screens refresh through the user entity tag."
```

---

### Task A3: "What happened?" after two people met

**Files:**
- Create: `server/src/services/people/meeting-outcome.service.ts`
- Modify: `server/src/routes/people.ts` (add the POST)
- Test: `server/src/__tests__/services/people/meeting-outcome.test.ts`
- Modify test: `server/src/__tests__/routes/people-routes.test.ts` (add a mock and cases)

**Interfaces:**
- Consumes: `WorthContinuing`, `OutcomeKey`, `OUTCOME_KEYS` (A1); `peopleWriteLimiter`, `userParams`, and the `fanoutUserEntity` import in `routes/people.ts` (A2).
- Produces:
  - `recordOutcome(userId, targetId, worth, keys): Promise<{ id; worthContinuing; outcomes; createdAt }>`
  - `POST /api/people/:userId/outcome {worthContinuing, outcomes[]}` → 201. It returns 409 when the two are not connected.

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/__tests__/services/people/meeting-outcome.test.ts
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));

import { recordOutcome } from '../../../services/people/meeting-outcome.service';

describe('recording what came of a meeting', () => {
  beforeEach(() => mockQuery.mockReset());

  it('stores the answer once the two are connected, without duplicate outcomes', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/AS ok/.test(sql)) return Promise.resolve({ rows: [{ ok: true }] });
      return Promise.resolve({ rows: [{ id: 'o1', created_at: new Date('2026-09-30T10:00:00Z') }] });
    });
    const out = await recordOutcome('u-a', 'u-b', 'yes', ['introduction', 'introduction', 'advice']);
    expect(out).toEqual({ id: 'o1', worthContinuing: 'yes', outcomes: ['introduction', 'advice'], createdAt: '2026-09-30T10:00:00.000Z' });
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO meeting_outcomes/.test(String(c[0])))!;
    expect(insert[1]).toEqual(['u-a', 'u-b', 'yes', ['introduction', 'advice']]);
  });

  it('checks the ordered pair (encounters and conversations store user_a < user_b)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] }).mockResolvedValueOnce({ rows: [{ id: 'o', created_at: new Date() }] });
    await recordOutcome('u-z', 'u-a', 'maybe', []);
    expect(mockQuery.mock.calls[0][1]).toEqual(['u-a', 'u-z']);
  });

  it('refuses strangers and yourself', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ok: false }] });
    await expect(recordOutcome('u-a', 'u-b', 'no', [])).rejects.toMatchObject({ statusCode: 409 });
    await expect(recordOutcome('u-a', 'u-a', 'no', [])).rejects.toMatchObject({ statusCode: 400 });
  });
});
```

Append to `server/src/__tests__/routes/people-routes.test.ts`, with the mock next to the others at the top:

```ts
const mockRecord = jest.fn().mockResolvedValue({ id: 'o1', worthContinuing: 'yes', outcomes: ['advice'], createdAt: '2026-09-30T10:00:00.000Z' });
jest.mock('../../services/people/meeting-outcome.service', () => ({ recordOutcome: (...a: unknown[]) => mockRecord(...a), __esModule: true }));
```

```ts
describe('POST /people/:userId/outcome', () => {
  it('records and returns 201', async () => {
    const res = await request(app).post(`/people/${TARGET}/outcome`).set('Authorization', `Bearer ${token()}`)
      .send({ worthContinuing: 'yes', outcomes: ['advice'] });
    expect(res.status).toBe(201);
    expect(mockRecord).toHaveBeenCalledWith('u-viewer', TARGET, 'yes', ['advice']);
  });
  it('rejects answers outside the Foundation list', async () => {
    const res = await request(app).post(`/people/${TARGET}/outcome`).set('Authorization', `Bearer ${token()}`)
      .send({ worthContinuing: 'definitely', outcomes: ['marriage'] });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/__tests__/services/people/meeting-outcome.test.ts src/__tests__/routes/people-routes.test.ts --coverage=false`
Expected: FAIL. The service module is missing, and the route returns 404.

- [ ] **Step 3: Write the service**

```ts
// server/src/services/people/meeting-outcome.service.ts
// ─── "Worth continuing?" / "What came from it?" (Foundation S10) ──────────────
// Asked after two people have met or connected. Private to the member who
// answers. Stored as a history (latest first), not a single overwrite, so
// REASON can later learn which introductions create value.

import { query } from '../../db';
import { ErrorCodes, type OutcomeKey, type WorthContinuing } from '@rsn/shared';
import { AppError, ConflictError } from '../../middleware/errors';

export interface RecordedOutcome {
  id: string;
  worthContinuing: WorthContinuing;
  outcomes: OutcomeKey[];
  createdAt: string;
}

export async function recordOutcome(
  userId: string,
  targetId: string,
  worthContinuing: WorthContinuing,
  keys: OutcomeKey[],
): Promise<RecordedOutcome> {
  if (userId === targetId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot record a meeting with yourself');
  }
  const [a, b] = userId < targetId ? [userId, targetId] : [targetId, userId];
  const link = await query<{ ok: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM encounter_history e WHERE e.user_a_id = $1 AND e.user_b_id = $2)
       OR EXISTS (SELECT 1 FROM dm_conversations c WHERE c.user_a_id = $1 AND c.user_b_id = $2)
     ) AS ok`,
    [a, b],
  );
  if (!link.rows[0]?.ok) {
    throw new ConflictError(ErrorCodes.VALIDATION_ERROR, 'You can record what happened once you two are connected.');
  }
  const outcomes = [...new Set(keys)];
  const inserted = await query<{ id: string; created_at: Date }>(
    `INSERT INTO meeting_outcomes (user_id, target_user_id, worth_continuing, outcome_keys)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [userId, targetId, worthContinuing, outcomes],
  );
  const row = inserted.rows[0];
  return { id: row.id, worthContinuing, outcomes, createdAt: row.created_at.toISOString() };
}
```

- [ ] **Step 4: Add the route**

In `server/src/routes/people.ts`, add these imports:

```ts
import { OUTCOME_KEYS } from '@rsn/shared';
import * as outcomes from '../services/people/meeting-outcome.service';
```

Add this schema:

```ts
const outcomeBody = z.object({
  worthContinuing: z.enum(['yes', 'maybe', 'no']),
  outcomes: z.array(z.enum(OUTCOME_KEYS)).max(OUTCOME_KEYS.length).default([]),
});
```

Add this handler before `export default router;`:

```ts
router.post(
  '/:userId/outcome',
  authenticate,
  peopleWriteLimiter,
  validate(userParams, 'params'),
  validate(outcomeBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await outcomes.recordOutcome(
        req.user!.userId, req.params.userId, req.body.worthContinuing, req.body.outcomes,
      );
      void fanoutUserEntity(req.user!.userId);
      res.status(201).json({ success: true, data } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 5: Run the tests, then commit**

Run: `cd server && npx jest src/__tests__/services/people src/__tests__/routes/people-routes.test.ts --coverage=false`
Expected: PASS.

```bash
git add server/src/services/people/meeting-outcome.service.ts server/src/routes/people.ts server/src/__tests__/services/people/meeting-outcome.test.ts server/src/__tests__/routes/people-routes.test.ts
git commit -m "Members can record whether a meeting was worth continuing" -m "Foundation S10: after two people met, ask 'Worth continuing?' and 'What came from it?'. Stored as a private history per member, only once the two are connected."
```

---

### Task A4: A personal note and preferred format on a meeting request

**Files:**
- Modify: `server/src/routes/matches.ts:32-45` (validate the optional body)
- Modify: `server/src/services/matching/platform-match.service.ts` (`expressInterest`, ~L530-564)
- Modify: `server/src/services/poke/poke.service.ts`:
  - the `UserPoke` type at L100-108;
  - `sendPoke`: its signature, the insert at L170-181, the realtime emits at L225-228 and before the return at L242-246;
  - the `acceptPoke` (L290-291, L391-396), `declinePoke` (L465-466, L484-489) and `listReceivedPokes` (L503-520) row reads.
- Modify: `client/src/features/messages/MeetingRequests.tsx` (type at L24-33, the two message paragraphs at L139-141 and L265-267)
- Test: `server/src/__tests__/services/matching/platform-match.test.ts` (append)
- Test: `server/src/__tests__/services/poke/poke.service.test.ts` (one new test, one updated assertion at L586)
- Test: `server/src/__tests__/routes/matches-interest.test.ts` (new)

**Why the realtime change is in this task:** the new Meet button must turn into "Request sent" on the sender's other open screens, and the recipient's request list must refresh. Today `sendPoke` emits nothing for the sender, and emits the recipient's tags only when their bell is on (L197). The bell setting should silence the notification, not stop screens updating.

**Interfaces:**
- Consumes: `MeetingFormat`, `MEETING_FORMATS` (A1).
- Produces:
  - `expressInterest(userId, targetUserId, agentId?, opts?: { note?: string; format?: MeetingFormat })`. With a note, the request reads: the member's note, a blank line, then "Why REASON suggested this: <reason>." (the prototype's "with the reason attached"). Without a note it is unchanged.
  - `sendPoke(senderId, recipientId, message?, agentId?, preferredFormat?)`
  - `UserPoke.preferredFormat: MeetingFormat | null`
  - `POST /api/matches/platform/:userId/interest` accepts an optional `{ note (≤300 characters), format }`.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/__tests__/services/matching/platform-match.test.ts`:

```ts
describe('expressInterest with a personal note and format (milestone 1)', () => {
  beforeEach(() => { mockQuery.mockReset(); mockSendPoke.mockReset(); mockSendPoke.mockResolvedValue({ id: 'p1' }); });

  function armProfiles() {
    mockQuery.mockImplementation((sql: string, params: unknown[]) => {
      if (/WHERE u\.id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [(params as string[])[0] === 'u-founder' ? FOUNDER_SEEKING_INVESTORS : INVESTOR] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  it('leads with the member\'s own note and attaches REASON\'s reason, with the format', async () => {
    armProfiles();
    await expressInterest('u-founder', 'u-investor', undefined, { note: '  I would love your view on our seed round.  ', format: 'coffee' });
    const [sender, recipient, message, agentId, format] = mockSendPoke.mock.calls[0];
    expect([sender, recipient, agentId, format]).toEqual(['u-founder', 'u-investor', undefined, 'coffee']);
    expect(message).toMatch(/^I would love your view on our seed round\.\n\nWhy REASON suggested this: Fatima is looking to meet .+ — you're an Angel Investor\.$/);
    expect(String(message).length).toBeLessThanOrEqual(500);
  });

  it('a note with no reason to attach is sent as written', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expressInterest('u-founder', 'u-investor', undefined, { note: 'Hello there' });
    expect(mockSendPoke.mock.calls[0][2]).toBe('Hello there');
  });

  it('without a note it still writes the introduction itself, and passes no format', async () => {
    armProfiles();
    await expressInterest('u-founder', 'u-investor');
    const [, , message, agentId, format] = mockSendPoke.mock.calls[0];
    expect(message).toMatch(/We think you two should meet\.$/);
    expect(agentId).toBeUndefined();
    expect(format).toBeUndefined();
  });
});
```

```ts
// server/src/__tests__/routes/matches-interest.test.ts
import express from 'express';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-jwt-secret';
jest.mock('../../config', () => ({
  default: { jwtSecret: JWT_SECRET, env: 'test', isDev: false, isProd: false, isTest: true, rateLimitWindowMs: 60000, rateLimitMaxRequests: 1000 },
  __esModule: true,
}));
jest.mock('../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));
jest.mock('../../db', () => ({
  // authenticate() checks the member is still active before any route runs.
  query: jest.fn().mockResolvedValue({ rows: [{ status: 'active' }] }),
  transaction: jest.fn(),
  __esModule: true,
}));
const mockInterest = jest.fn().mockResolvedValue({ id: 'p1' });
jest.mock('../../services/matching/platform-match.service', () => ({
  getPlatformMatches: jest.fn(),
  expressInterest: (...a: unknown[]) => mockInterest(...a),
  __esModule: true,
}));

import matchesRoutes from '../../routes/matches';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/matches', matchesRoutes);
app.use(notFoundHandler);
app.use(errorHandler);
const auth = { Authorization: `Bearer ${jwt.sign({ sub: 'u-a', email: 'a@example.com', role: 'member', sessionId: 's-1' }, JWT_SECRET, { expiresIn: '1h' })}` };

describe('POST /matches/platform/:userId/interest', () => {
  beforeEach(() => mockInterest.mockClear());

  it('still works with no body (today\'s callers)', async () => {
    const res = await request(app).post('/matches/platform/u-b/interest').set(auth);
    expect(res.status).toBe(201);
    expect(mockInterest).toHaveBeenCalledWith('u-a', 'u-b', undefined, { note: undefined, format: undefined });
  });

  it('passes a note and format through', async () => {
    const res = await request(app).post('/matches/platform/u-b/interest').set(auth).send({ note: 'Hi', format: 'video_20' });
    expect(res.status).toBe(201);
    expect(mockInterest).toHaveBeenCalledWith('u-a', 'u-b', undefined, { note: 'Hi', format: 'video_20' });
  });

  it('rejects an unknown format and an over-long note', async () => {
    expect((await request(app).post('/matches/platform/u-b/interest').set(auth).send({ format: 'dinner' })).status).toBe(400);
    expect((await request(app).post('/matches/platform/u-b/interest').set(auth).send({ note: 'x'.repeat(301) })).status).toBe(400);
    expect(mockInterest).not.toHaveBeenCalled();
  });
});
```

Append to `server/src/__tests__/services/poke/poke.service.test.ts` (it already has `armSend`, `mockShouldSendBell`, `mockEmitEntities`, `SENDER`, `RECIPIENT`):

```ts
describe('sendPoke — both members\' screens refresh (29 Sep 2026)', () => {
  it('tells the sender and the recipient, whatever the recipient\'s bell setting', async () => {
    armSend('hi');
    mockShouldSendBell.mockResolvedValue(false);

    await pokeService.sendPoke(SENDER, RECIPIENT, 'hi');

    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), [SENDER], [`user:${SENDER}`, `user:${SENDER}:invites`]);
    expect(mockEmitEntities).toHaveBeenCalledWith(expect.anything(), [RECIPIENT], [`user:${RECIPIENT}`, `user:${RECIPIENT}:invites`]);
    const tags = mockEmitEntities.mock.calls.flatMap(c => c[2] as string[]);
    expect(tags).not.toContain(`user:${RECIPIENT}:notifications`);
  });

  it('stores the preferred format and returns it', async () => {
    armSend('hi');
    const poke = await pokeService.sendPoke(SENDER, RECIPIENT, 'hi', undefined, 'coffee');
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO user_pokes/.test(String(c[0])))!;
    expect(insert[1]).toEqual([expect.any(String), SENDER, RECIPIENT, 'hi', null, 'coffee']);
    expect(poke).toHaveProperty('preferredFormat');
  });
});
```

In the same file, the bell-gating test at L574-589 pinned the old behaviour. Replace its line 586 (`expect(mockEmitEntities).not.toHaveBeenCalled();`) with:

```ts
    // 29 Sep 2026: the bell toggle silences the notification, not the data.
    // Screens still refresh; only the bell's own tag is withheld.
    const tags = mockEmitEntities.mock.calls.flatMap(c => c[2] as string[]);
    expect(tags).not.toContain(`user:${RECIPIENT}:notifications`);
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/__tests__/services/matching/platform-match.test.ts src/__tests__/services/poke/poke.service.test.ts src/__tests__/routes/matches-interest.test.ts --coverage=false`
Expected: FAIL. The note is ignored, the route passes only two arguments, the sender is never told, and the insert has no format.

- [ ] **Step 3: Validate the body in the route**

In `server/src/routes/matches.ts`, add these imports:

```ts
import { z } from 'zod';
import { validate } from '../middleware/validate';
```

Add this schema above the POST route:

```ts
// Milestone 1 (29 Sep 2026): the Meet sheet adds a personal "why now" note and
// a preferred format. Both optional: today's callers POST with no body at all.
// 300 leaves room for REASON's reason inside the request's 500 characters.
const interestBody = z.object({
  note: z.string().trim().max(300).optional(),
  format: z.enum(['video_20', 'coffee', 'message_first']).optional(),
});
```

Replace the POST route's middleware list and service call with:

```ts
router.post(
  '/platform/:userId/interest',
  authenticate,
  validate(interestBody),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const poke = await platformMatchService.expressInterest(req.user!.userId, req.params.userId, undefined, {
        note: req.body.note,
        format: req.body.format,
      });
      const response: ApiResponse = { success: true, data: poke };
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);
```

- [ ] **Step 4: Put the note first in expressInterest, with the reason attached**

In `server/src/services/matching/platform-match.service.ts` (the file has no `@rsn/shared` import today):
1. Below `import { UserPoke } from '../poke/poke.service';` (line 25) add `import type { MeetingFormat } from '@rsn/shared';`.
2. Add a fourth parameter after `agentId?: string,` (line 536):

```ts
  /** Milestone 1 (29 Sep 2026): the Meet sheet's "Why now?" note and preferred format. */
  opts: { note?: string; format?: MeetingFormat } = {},
```

3. Replace line 539 (`let message = 'We think you two should meet.';`) with:

```ts
  const note = opts.note?.trim() || null;
  let message = note ?? 'We think you two should meet.';
```

4. Replace lines 559-561 (the `message = reason ? … : …;` assignment) with:

```ts
    if (note) {
      // The v4 Meet sheet: the member's own words first, "with the reason attached".
      message = reason ? `${note}\n\nWhy REASON suggested this: ${reason}.` : note;
    } else {
      message = reason
        ? `${reason}. We think you two should meet.`
        : `${senderName} thinks you fit what they're looking for. We think you two should meet.`;
    }
```

5. Replace line 563 (the `return`) with:

```ts
  return pokeService.sendPoke(userId, targetUserId, message.slice(0, 500), agentId, opts.format);
```

- [ ] **Step 5: Store the format on the request**

In `server/src/services/poke/poke.service.ts`:
1. Add `import type { MeetingFormat } from '@rsn/shared';` near the other imports.
2. Add `preferredFormat: MeetingFormat | null;` as the last field of `interface UserPoke` (L100-108).
3. Add the fifth parameter to `sendPoke` after `agentId?: string,`:

```ts
  /** Milestone 1: the format the sender would like (shown to the recipient). */
  preferredFormat?: MeetingFormat,
```

4. Replace the insert at L170-181 with:

```ts
    const result = await query<{
      id: string; sender_id: string; recipient_id: string;
      status: 'pending' | 'accepted' | 'declined';
      message: string | null;
      responded_at: Date | null;
      created_at: Date;
      preferred_format: MeetingFormat | null;
    }>(
      `INSERT INTO user_pokes (id, sender_id, recipient_id, message, status, agent_id, preferred_format)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)
       RETURNING id, sender_id, recipient_id, status, message, responded_at, created_at, preferred_format`,
      [pokeId, senderId, recipientId, trimmedMessage, agentId ?? null, preferredFormat ?? null],
    );
```

5. Replace the return object at L242-246 with:

```ts
    return {
      id: r.id, senderId: r.sender_id, recipientId: r.recipient_id,
      status: r.status, message: r.message, respondedAt: r.responded_at,
      createdAt: r.created_at, preferredFormat: r.preferred_format ?? null,
    };
```

6. Every other place that builds a `UserPoke` object (`acceptPoke`, `declinePoke` L484-489, `listReceivedPokes`) must now set `preferredFormat`:
   - In `listReceivedPokes`, add `p.preferred_format` to the SELECT, `preferred_format: MeetingFormat | null` to its row type, and `preferredFormat: r.preferred_format ?? null` to the mapped object.
   - In `declinePoke` and `acceptPoke`, add `preferred_format` to their `SELECT … FROM user_pokes WHERE id = $1` and `preferredFormat: p.preferred_format ?? null` to the returned object.
   - Run `cd server && npx tsc --noEmit` to list any construction site this missed, and fix each the same way.
7. In the bell block, change the emit at L225-228 so it carries only the bell's own tag:

```ts
          emitEntities(
            io, [recipientId],
            [E.userNotifications(recipientId)],
          ).catch(() => {});
```

8. Directly before the `return {` of `sendPoke` (L242), add:

```ts
    // 29 Sep 2026: both members' screens refresh whatever the recipient's bell
    // setting is. The bell toggle silences the notification, not the data.
    try {
      const { io } = await import('../../index');
      const { emitEntities } = await import('../../realtime/emit');
      const { E } = await import('../../realtime/entities');
      emitEntities(io, [senderId], [E.user(senderId), E.userInvites(senderId)]).catch(() => {});
      emitEntities(io, [recipientId], [E.user(recipientId), E.userInvites(recipientId)]).catch(() => {});
    } catch { /* realtime is non-fatal */ }
```

- [ ] **Step 6: Show the format to the recipient**

In `client/src/features/messages/MeetingRequests.tsx`:
1. Add `import { MEETING_FORMATS } from '@rsn/shared';`.
2. Add `preferredFormat?: 'video_20' | 'coffee' | 'message_first' | null;` to `interface PendingRequest`.
3. Add this helper under the interface:

```ts
const formatLabel = (f: PendingRequest['preferredFormat']) => MEETING_FORMATS.find(m => m.key === f)?.label ?? null;
```

4. A note now arrives as two paragraphs (the member's words, then "Why REASON suggested this: …"), so both message paragraphs keep their line breaks. Line 140 becomes:

```tsx
          <p className="mt-3 whitespace-pre-line break-words text-sm text-gray-600">{req.message}</p>
```

and line 265 becomes:

```tsx
                <p className="mt-1 whitespace-pre-line break-words text-xs text-gray-600">
```

5. After the focused card's `{req.message && (…)}` block (L139-141), add:

```tsx
        {formatLabel(req.preferredFormat) && (
          <p className="mt-1 text-xs text-gray-500">Prefers {formatLabel(req.preferredFormat)?.toLowerCase()}</p>
        )}
```

6. After the list row's message paragraph (L265-267), add:

```tsx
                {formatLabel(r.preferredFormat) && (
                  <p className="mt-0.5 text-[11px] text-gray-500">Prefers {formatLabel(r.preferredFormat)?.toLowerCase()}</p>
                )}
```

- [ ] **Step 7: Run tests and typecheck, then commit**

Run: `npm run build:shared && cd server && npx jest src/__tests__/services/matching src/__tests__/services/poke src/__tests__/routes/matches-interest.test.ts --coverage=false && npx tsc --noEmit && cd ../client && npx tsc --noEmit`
Expected: PASS, and both typechecks clean.

```bash
git add server/src/routes/matches.ts server/src/services/matching/platform-match.service.ts server/src/services/poke/poke.service.ts client/src/features/messages/MeetingRequests.tsx server/src/__tests__/services/matching/platform-match.test.ts server/src/__tests__/services/poke/poke.service.test.ts server/src/__tests__/routes/matches-interest.test.ts
git commit -m "A meeting request can carry a personal note and a preferred format" -m "The Meet sheet in the new design asks 'Why now?' and a format (20 minute video, in person coffee, message first). The member's note leads and REASON's reason is attached below it. Both are optional, so today's one-tap requests are unchanged; the recipient sees the preferred format on the request. Sending a request now refreshes the sender's and the recipient's screens even when the recipient's bell is off."
```

---

### Task A5: The person brief and recent connections

**Files:**
- Modify: `server/src/services/matching/platform-match.service.ts:398` (export `loadProfile`)
- Create: `server/src/services/people/person-brief.service.ts`
- Modify: `server/src/routes/people.ts` (add two GETs)
- Test: `server/src/__tests__/services/people/person-brief.test.ts`
- Modify test: `server/src/__tests__/routes/people-routes.test.ts` (add a mock and cases)

**Interfaces:**
- Consumes:
  - `getUserById` (identity.service), `toPublicMember` (public-card), `areBlocked` (block.service);
  - `loadProfile`, `scoreFit`, `MATCH_THRESHOLD`, `BROWSE_THRESHOLD` (platform-match);
  - `getPokeWith` (poke.service), `getResponse` (A2), `clip` (A2).
- Produces:
  - `getPersonBrief(viewerId, targetId): Promise<PersonBrief>`
  - `listRecentConnections(userId): Promise<RecentConnection[]>`
  - `GET /api/people/:userId/brief`
  - `GET /api/people/connections/recent`

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/__tests__/services/people/person-brief.test.ts
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({ default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }, __esModule: true }));

const mockBlocked = jest.fn();
jest.mock('../../../services/block/block.service', () => ({ areBlocked: (...a: unknown[]) => mockBlocked(...a), __esModule: true }));
const mockGetUser = jest.fn();
jest.mock('../../../services/identity/identity.service', () => ({ getUserById: (...a: unknown[]) => mockGetUser(...a), __esModule: true }));
const mockLoadProfile = jest.fn();
const mockScore = jest.fn();
jest.mock('../../../services/matching/platform-match.service', () => ({
  loadProfile: (...a: unknown[]) => mockLoadProfile(...a),
  scoreFit: (...a: unknown[]) => mockScore(...a),
  MATCH_THRESHOLD: 0.45,
  BROWSE_THRESHOLD: 0.12,
  __esModule: true,
}));
const mockPokeWith = jest.fn();
jest.mock('../../../services/poke/poke.service', () => ({ getPokeWith: (...a: unknown[]) => mockPokeWith(...a), __esModule: true }));
const mockGetResponse = jest.fn();
jest.mock('../../../services/people/person-response.service', () => ({ getResponse: (...a: unknown[]) => mockGetResponse(...a), __esModule: true }));

import { getPersonBrief, listRecentConnections } from '../../../services/people/person-brief.service';
import { PRIVATE_MEMBER_KEYS } from '../../../services/user/public-card';

const VIEWER = 'a0000000-0000-4000-8000-000000000001';
const TARGET = 'b0000000-0000-4000-8000-000000000002';
const target = {
  id: TARGET, displayName: 'Sarah Chen', firstName: 'Sarah', lastName: 'Chen', avatarUrl: null, bio: 'Building Harbor.',
  company: 'Harbor Collective', jobTitle: 'Founder', industry: 'Consumer', location: 'London', linkedinUrl: null,
  languages: [], professionalRole: ['Founder'], expertiseText: null, whatICanHelpWith: 'Introductions to European retailers',
  whoIWantToMeet: 'SECRET-WANT operators who scaled DTC', whyIWantToMeet: 'SECRET-WHY', myIntent: 'SECRET-INTENT',
  email: 'sarah@example.com', status: 'active',
};

function arm(o: {
  blocked?: boolean; poke?: unknown; response?: string | null;
  enc?: Record<string, unknown> | null; conv?: Record<string, unknown> | null; score?: number;
} = {}) {
  mockBlocked.mockResolvedValue(!!o.blocked);
  mockGetUser.mockResolvedValue(target);
  mockLoadProfile.mockImplementation((id: string) => Promise.resolve(
    id === VIEWER
      ? { id, whoIWantToMeet: 'founders in consumer', myIntent: null }
      : { id, whoIWantToMeet: target.whoIWantToMeet, whatICanHelpWith: target.whatICanHelpWith, expertiseText: null },
  ));
  mockScore.mockReturnValue({ score: o.score ?? 0.6, reason: "You're looking to meet founders — Sarah Chen is a Founder" });
  mockPokeWith.mockResolvedValue(o.poke ?? null);
  mockGetResponse.mockResolvedValue(o.response ?? null);
  mockQuery.mockImplementation((sql: string) => {
    if (/FROM encounter_history WHERE/.test(sql)) return Promise.resolve({ rows: o.enc ? [o.enc] : [] });
    if (/FROM dm_conversations WHERE/.test(sql)) return Promise.resolve({ rows: o.conv ? [o.conv] : [] });
    return Promise.resolve({ rows: [] });
  });
}

describe('getPersonBrief', () => {
  beforeEach(() => jest.clearAllMocks());

  it('never carries the other member\'s private fields, and the opener never quotes them', async () => {
    arm();
    const brief = await getPersonBrief(VIEWER, TARGET);
    for (const k of PRIVATE_MEMBER_KEYS) expect(brief.person).not.toHaveProperty(k);
    expect(JSON.stringify(brief)).not.toMatch(/SECRET-/);
    expect(brief.theyCanBring).toBe('Introductions to European retailers');
    expect(brief.youAreLookingFor).toBe('founders in consumer');
  });

  it('builds "your path" only from relationships both people chose', async () => {
    arm();
    await getPersonBrief(VIEWER, TARGET);
    const sql = mockQuery.mock.calls.map(c => String(c[0])).find(s => /FROM encounter_history e1/.test(s))!;
    expect(sql).toMatch(/e1\.times_met > 0 OR e1\.last_session_id IS NOT NULL/);
    expect(sql).toMatch(/mutual_meet_again = true/);
    expect(sql).toMatch(/p\.status = 'accepted'/);
    expect(sql).toMatch(/user_blocks/);
  });

  it('hides blocked and closed people as not found, and refuses yourself', async () => {
    arm({ blocked: true });
    await expect(getPersonBrief(VIEWER, TARGET)).rejects.toMatchObject({ statusCode: 404 });
    arm();
    mockGetUser.mockResolvedValue({ ...target, status: 'deactivated' });
    await expect(getPersonBrief(VIEWER, TARGET)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getPersonBrief(VIEWER, VIEWER)).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each([
    ['none', {}],
    ['requested', { poke: { id: 'p1', status: 'pending', sentByMe: true } }],
    ['incoming', { poke: { id: 'p2', status: 'pending', sentByMe: false } }],
    ['declined', { poke: { id: 'p3', status: 'declined', sentByMe: true } }],
    ['connected', { poke: { id: 'p4', status: 'accepted', sentByMe: true }, enc: { times_met: 0, last_met_at: new Date(), last_session_id: null } }],
    ['met', { enc: { times_met: 2, last_met_at: new Date('2026-09-01'), last_session_id: 's1' } }],
    ['met', { conv: { id: 'c1', joined_a: new Date(), joined_b: new Date() } }],
  ] as const)('relationship state %s', async (state, o) => {
    arm(o as never);
    const brief = await getPersonBrief(VIEWER, TARGET);
    expect(brief.relationship.state).toBe(state);
  });

  it('counts meetings from events and from a held 1:1 meeting', async () => {
    arm({ enc: { times_met: 2, last_met_at: new Date('2026-09-01'), last_session_id: 's1' }, conv: { id: 'c1', joined_a: new Date(), joined_b: new Date() } });
    expect((await getPersonBrief(VIEWER, TARGET)).relationship.timesMet).toBe(3);
  });

  it('only calls it a match above the browse threshold', async () => {
    arm({ score: 0.6 });
    expect((await getPersonBrief(VIEWER, TARGET)).match?.strength).toBe('strong');
    arm({ score: 0.2 });
    expect((await getPersonBrief(VIEWER, TARGET)).match?.strength).toBe('close');
    arm({ score: 0.05 });
    expect((await getPersonBrief(VIEWER, TARGET)).match).toBeNull();
  });

  it('carries the member\'s own Save/Pass', async () => {
    arm({ response: 'passed' });
    const r = (await getPersonBrief(VIEWER, TARGET)).relationship;
    expect(r.passed).toBe(true);
    expect(r.saved).toBe(false);
  });
});

describe('listRecentConnections', () => {
  it('lists accepted requests either way, newest first, skipping blocked people', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ user_id: TARGET, display_name: 'Sarah Chen', avatar_url: null, connected_at: new Date('2026-09-20T10:00:00Z') }] });
    const out = await listRecentConnections(VIEWER);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/status = 'accepted'/);
    expect(sql).toMatch(/user_blocks/);
    expect(sql).toMatch(/ORDER BY p\.responded_at DESC/);
    expect(out).toEqual([{ userId: TARGET, displayName: 'Sarah Chen', avatarUrl: null, connectedAt: '2026-09-20T10:00:00.000Z' }]);
  });
});
```

Append to `server/src/__tests__/routes/people-routes.test.ts`, with the mock at the top:

```ts
const mockBrief = jest.fn().mockResolvedValue({ person: { id: 'x' } });
const mockRecent = jest.fn().mockResolvedValue([]);
jest.mock('../../services/people/person-brief.service', () => ({
  getPersonBrief: (...a: unknown[]) => mockBrief(...a),
  listRecentConnections: (...a: unknown[]) => mockRecent(...a),
  __esModule: true,
}));
```

```ts
describe('GET brief and recent connections', () => {
  it('serves the brief for a valid id only', async () => {
    expect((await request(app).get(`/people/${TARGET}/brief`).set('Authorization', `Bearer ${token()}`)).status).toBe(200);
    expect(mockBrief).toHaveBeenCalledWith('u-viewer', TARGET);
    expect((await request(app).get('/people/nope/brief').set('Authorization', `Bearer ${token()}`)).status).toBe(400);
  });
  it('serves recent connections (a path that must not be swallowed by /:userId)', async () => {
    const res = await request(app).get('/people/connections/recent').set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(mockRecent).toHaveBeenCalledWith('u-viewer');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/__tests__/services/people/person-brief.test.ts src/__tests__/routes/people-routes.test.ts --coverage=false`
Expected: FAIL. The module is missing, and the routes return 404.

- [ ] **Step 3: Export loadProfile**

In `server/src/services/matching/platform-match.service.ts` line 398, change `async function loadProfile(` to `export async function loadProfile(`.

- [ ] **Step 4: Write the brief service**

```ts
// server/src/services/people/person-brief.service.ts
// ─── The Human Profile brief (REASON milestone 1, 29 Sep 2026) ───────────────
// Everything the Human Profile shows about ONE person, from where the viewer
// stands: who they are (the public card only), why REASON thinks they matter,
// where the relationship is, what you share, and one path through someone you
// both really know. The other member's wants never leave the server (Stefan,
// 9 Sep): until the per-reason share switch exists, the brief carries only
// what they OFFER and what the VIEWER is looking for.

import { query } from '../../db';
import {
  ErrorCodes, type OutcomeKey, type PersonBrief, type RecentConnection,
  type RelationshipState, type WorthContinuing,
} from '@rsn/shared';
import { AppError, NotFoundError } from '../../middleware/errors';
import * as blockService from '../block/block.service';
import { getUserById } from '../identity/identity.service';
import { toPublicMember } from '../user/public-card';
import { loadProfile, scoreFit, MATCH_THRESHOLD, BROWSE_THRESHOLD } from '../matching/platform-match.service';
import { getPokeWith } from '../poke/poke.service';
import { getResponse } from './person-response.service';
import { clip } from './text';

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const endSentence = (s: string) => s.replace(/[.!?…]+$/, '');

/** "The first 20 minutes": fixed wording from the two members' own answers (approved point 3). */
function openerFor(first: string, theyCanBring: string | null, youAreLookingFor: string | null, sharedEvent: string | null): string {
  const parts: string[] = [];
  parts.push(theyCanBring
    ? `Ask ${first} about ${lowerFirst(endSentence(theyCanBring))}.`
    : `Start with why REASON put you two together.`);
  if (youAreLookingFor) parts.push(`Then say what you are looking for: ${lowerFirst(endSentence(youAreLookingFor))}.`);
  if (sharedEvent) parts.push(`You will both be at ${sharedEvent}.`);
  return parts.join(' ');
}

/**
 * "Your path": one person between you, never a mutual-connection count. Each
 * hop is a relationship both of its people chose: you genuinely met M, and M
 * and the person both said "meet again" or accepted a meeting request.
 * Driven from the viewer's own encounters, so it reads a handful of rows.
 */
async function findPath(viewerId: string, targetId: string): Promise<{ id: string; displayName: string } | null> {
  const r = await query<{ id: string; display_name: string }>(
    `SELECT m.id, m.display_name
       FROM encounter_history e1
       JOIN users m ON m.id = CASE WHEN e1.user_a_id = $1 THEN e1.user_b_id ELSE e1.user_a_id END
      WHERE (e1.user_a_id = $1 OR e1.user_b_id = $1)
        AND (e1.times_met > 0 OR e1.last_session_id IS NOT NULL)
        AND m.id <> $2 AND m.status = 'active'
        AND (
          EXISTS (SELECT 1 FROM encounter_history e2
                   WHERE e2.user_a_id = LEAST($2::uuid, m.id) AND e2.user_b_id = GREATEST($2::uuid, m.id)
                     AND e2.mutual_meet_again = true)
          OR EXISTS (SELECT 1 FROM user_pokes p
                      WHERE p.status = 'accepted'
                        AND ((p.sender_id = m.id AND p.recipient_id = $2)
                          OR (p.sender_id = $2 AND p.recipient_id = m.id))))
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
                         WHERE (b.blocker_id IN ($1, $2) AND b.blocked_id = m.id)
                            OR (b.blocker_id = m.id AND b.blocked_id IN ($1, $2)))
      ORDER BY e1.last_met_at DESC
      LIMIT 1`,
    [viewerId, targetId],
  );
  const row = r.rows[0];
  return row ? { id: row.id, displayName: row.display_name } : null;
}

export async function getPersonBrief(viewerId: string, targetId: string): Promise<PersonBrief> {
  if (viewerId === targetId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'This is your own profile');
  }
  if (await blockService.areBlocked(viewerId, targetId)) throw new NotFoundError('User', targetId);
  const target = await getUserById(targetId);
  if (target.status !== 'active') throw new NotFoundError('User', targetId);

  const [a, b] = viewerId < targetId ? [viewerId, targetId] : [targetId, viewerId];
  const [me, them, poke, response, enc, conv, outcomeRows, circles, pods, events, path] = await Promise.all([
    loadProfile(viewerId),
    loadProfile(targetId),
    getPokeWith(viewerId, targetId),
    getResponse(viewerId, targetId),
    query<{ times_met: number; last_met_at: Date; last_session_id: string | null }>(
      `SELECT times_met, last_met_at, last_session_id FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2`,
      [a, b]),
    query<{ id: string; joined_a: Date | null; joined_b: Date | null }>(
      `SELECT id, meeting_joined_a_at AS joined_a, meeting_joined_b_at AS joined_b FROM dm_conversations WHERE user_a_id = $1 AND user_b_id = $2`,
      [a, b]),
    query<{ worth_continuing: WorthContinuing; outcome_keys: OutcomeKey[]; created_at: Date }>(
      `SELECT worth_continuing, outcome_keys, created_at FROM meeting_outcomes
        WHERE user_id = $1 AND target_user_id = $2 ORDER BY created_at DESC LIMIT 5`,
      [viewerId, targetId]),
    query<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM circle_members x
         JOIN circle_members y ON y.circle_id = x.circle_id
         JOIN circles c ON c.id = x.circle_id
        WHERE x.user_id = $1 AND y.user_id = $2 AND c.archived_at IS NULL
        ORDER BY c.name LIMIT 5`,
      [viewerId, targetId]),
    query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM pod_members x
         JOIN pod_members y ON y.pod_id = x.pod_id
         JOIN pods p ON p.id = x.pod_id
        WHERE x.user_id = $1 AND y.user_id = $2 AND x.status = 'active' AND y.status = 'active' AND p.status = 'active'
        ORDER BY p.name LIMIT 5`,
      [viewerId, targetId]),
    query<{ id: string; title: string; scheduled_at: Date }>(
      `SELECT s.id, s.title, s.scheduled_at FROM session_participants x
         JOIN session_participants y ON y.session_id = x.session_id
         JOIN sessions s ON s.id = x.session_id
        WHERE x.user_id = $1 AND y.user_id = $2
          AND x.status NOT IN ('removed', 'left', 'no_show') AND y.status NOT IN ('removed', 'left', 'no_show')
          AND s.status = 'scheduled' AND s.scheduled_at > NOW()
        ORDER BY s.scheduled_at ASC LIMIT 3`,
      [viewerId, targetId]),
    findPath(viewerId, targetId),
  ]);

  const fit = me && them ? scoreFit(me, them) : null;
  const strength = !fit ? null : fit.score >= MATCH_THRESHOLD ? 'strong' : fit.score >= BROWSE_THRESHOLD ? 'close' : null;

  const e = enc.rows[0];
  const c = conv.rows[0];
  const metAtEvent = !!e && (e.times_met > 0 || !!e.last_session_id);
  const metOneToOne = !!(c?.joined_a && c?.joined_b);
  const state: RelationshipState =
    metAtEvent || metOneToOne ? 'met'
      : poke?.status === 'accepted' || !!c ? 'connected'
        : poke?.status === 'pending' ? (poke.sentByMe ? 'requested' : 'incoming')
          : poke?.status === 'declined' && poke.sentByMe ? 'declined'
            : 'none';

  const person = toPublicMember(target);
  const first = person.firstName || person.displayName.split(' ')[0] || 'them';
  // `||`, not `??`: a blank answer is '', which must fall through.
  const theyCanBring = clip(them?.whatICanHelpWith || them?.expertiseText);
  const youAreLookingFor = clip(me?.whoIWantToMeet || me?.myIntent);
  const upcomingEvents = events.rows.map(r => ({ id: r.id, title: r.title, scheduledAt: r.scheduled_at.toISOString() }));

  return {
    person,
    match: fit && strength ? { reason: fit.reason, strength } : null,
    theyCanBring,
    youAreLookingFor,
    opener: openerFor(first, theyCanBring, youAreLookingFor, upcomingEvents[0]?.title ?? null),
    relationship: {
      state,
      pokeId: poke?.status === 'pending' && !poke.sentByMe ? poke.id : null,
      timesMet: Math.max(e?.times_met ?? 0, metAtEvent ? 1 : 0) + (metOneToOne ? 1 : 0),
      lastMetAt: metAtEvent && e ? e.last_met_at.toISOString() : null,
      saved: response === 'saved',
      passed: response === 'passed',
      outcomes: outcomeRows.rows.map(r => ({
        worthContinuing: r.worth_continuing, outcomes: r.outcome_keys, createdAt: r.created_at.toISOString(),
      })),
    },
    shared: { circles: circles.rows, pods: pods.rows, upcomingEvents },
    path,
  };
}

export async function listRecentConnections(userId: string): Promise<RecentConnection[]> {
  const r = await query<{ user_id: string; display_name: string; avatar_url: string | null; connected_at: Date }>(
    `SELECT u.id AS user_id, u.display_name, u.avatar_url, p.responded_at AS connected_at
       FROM user_pokes p
       JOIN users u ON u.id = CASE WHEN p.sender_id = $1 THEN p.recipient_id ELSE p.sender_id END
      WHERE (p.sender_id = $1 OR p.recipient_id = $1)
        AND p.status = 'accepted' AND p.responded_at IS NOT NULL
        AND u.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
                         WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
                            OR (b.blocker_id = u.id AND b.blocked_id = $1))
      ORDER BY p.responded_at DESC
      LIMIT 5`,
    [userId],
  );
  return r.rows.map(row => ({
    userId: row.user_id, displayName: row.display_name, avatarUrl: row.avatar_url,
    connectedAt: row.connected_at.toISOString(),
  }));
}
```

- [ ] **Step 5: Add the routes**

In `server/src/routes/people.ts`, add `import * as brief from '../services/people/person-brief.service';`. Then add these two handlers **above** the `/:userId/response` routes. `/connections/recent` must come first so it is never read as a user id.

```ts
router.get('/connections/recent', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await brief.listRecentConnections(req.user!.userId);
    res.json({ success: true, data } as ApiResponse);
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:userId/brief',
  authenticate,
  validate(userParams, 'params'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await brief.getPersonBrief(req.user!.userId, req.params.userId);
      res.json({ success: true, data } as ApiResponse);
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 6: Run the tests, typecheck, commit**

Run: `cd server && npx jest src/__tests__/services/people src/__tests__/routes/people-routes.test.ts src/__tests__/services/matching --coverage=false && npx tsc --noEmit`
Expected: PASS, and the typecheck is clean.

```bash
git add server/src/services/matching/platform-match.service.ts server/src/services/people/person-brief.service.ts server/src/routes/people.ts server/src/__tests__/services/people/person-brief.test.ts server/src/__tests__/routes/people-routes.test.ts
git commit -m "The Human Profile brief: who they are, why they matter to you, and where you stand" -m "One call for the new person page: the public card, REASON's reason, the relationship state and history, shared circles, pods and upcoming events, and one path through someone you both really know. The other member's wants never leave the server."
```

---

### Task A6: For You data (saved, passed, richer cards, private events)

**Files:**
- Modify: `server/src/services/matching/platform-match.service.ts`:
  - `PlatformMatch` L54-66 and `PlatformMatchesResult` L68-72;
  - `loadCandidates` L413-467 (after the live-fixes plan added `profile_visible`);
  - `getPlatformMatches` L471-522.
- Test: `server/src/__tests__/services/matching/platform-match.test.ts` (append)

**Interfaces:**
- Consumes: `clip` (A2).
- Produces:
  - Each match gains `industry`, `theyCanBring`, `saved`, `strength`; the payload gains `youAreLookingFor`.
  - Passed people are excluded.
  - `nextEvent` respects pod visibility.

- [ ] **Step 1: Write the failing tests**

Append to the `getPlatformMatches` describe block in `platform-match.test.ts`:

```ts
  it('For You cards carry saved, strength, industry and the public offer; the payload carries the viewer\'s own want', async () => {
    armQueries({
      me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true },
      candidates: [{ ...INVESTOR, industry: 'Venture capital', whatICanHelpWith: 'Seed cheques and intros', saved: true }],
    });
    const res = await getPlatformMatches('u-founder');
    expect(res.youAreLookingFor).toBe('investors and angels for my seed round');
    expect(res.matches[0]).toMatchObject({
      industry: 'Venture capital', theyCanBring: 'Seed cheques and intros', saved: true, strength: 'strong',
    });
  });

  it('people the member passed on are excluded, and the Save state is read in the same query', async () => {
    armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true }, candidates: [] });
    await getPlatformMatches('u-founder');
    const candidateSql = mockQuery.mock.calls.map(c => c[0] as string).find(s => /u\.id <> \$1/.test(s))!;
    expect(candidateSql).toMatch(/LEFT JOIN person_responses pr/);
    expect(candidateSql).toMatch(/pr\.response IS NULL OR pr\.response <> 'passed'/);
  });

  it('the next event never reveals a private pod\'s event', async () => {
    armQueries({ me: { ...FOUNDER_SEEKING_INVESTORS, onboardingCompleted: true }, candidates: [] });
    await getPlatformMatches('u-founder');
    const call = mockQuery.mock.calls.find(c => /FROM sessions/.test(String(c[0])))!;
    expect(String(call[0])).toMatch(/visibility IN \('public', 'invite_only'\)/);
    expect(String(call[0])).toMatch(/pod_members/);
    expect(call[1]).toEqual(['u-founder']);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx jest src/__tests__/services/matching/platform-match.test.ts --coverage=false`
Expected: FAIL on all three.

- [ ] **Step 3: Extend the types**

In `PlatformMatch` add:

```ts
  industry: string | null;
  /** Their own public offer (what they can help with). Never their wants. */
  theyCanBring: string | null;
  saved: boolean;
  strength: 'strong' | 'close';
```

In `PlatformMatchesResult` add:

```ts
  /** The viewer's OWN want, shown back to them on each card. */
  youAreLookingFor: string | null;
```

- [ ] **Step 4: Read Save/Pass in loadCandidates**

In `loadCandidates` (lines 413-467 before the live-fixes plan; that plan adds one line after 435):
1. Add `saved: boolean | null;` to both inline row types (the return type at 413-416 and the `query<…>` type at 417-419), next to `pokeSentByOwner`.
2. Change line 422 from `(pk.sender_id = $1) AS "pokeSentByOwner"` to:

```sql
            (pk.sender_id = $1) AS "pokeSentByOwner",
            (pr.response = 'saved') AS "saved"
```

3. After line 432 (`) pk ON TRUE`) add:

```sql
     LEFT JOIN person_responses pr ON pr.user_id = $1 AND pr.target_user_id = u.id
```

4. After `AND u.profile_visible = true` (added by the live-fixes plan under `AND u.onboarding_completed = true`) add:

```sql
       AND (pr.response IS NULL OR pr.response <> 'passed')
```

- [ ] **Step 5: Map the new fields, and filter the next event**

In `server/src/services/matching/platform-match.service.ts` add `import { clip } from '../people/text';`. In `getPlatformMatches`:
1. Replace the next-event query with:

```ts
  const nextEventRes = await query<{ id: string; title: string; scheduledAt: Date }>(
    `SELECT s.id, s.title, s.scheduled_at AS "scheduledAt"
       FROM sessions s
      WHERE s.status = 'scheduled' AND s.scheduled_at > NOW()
        AND (s.pod_id IN (SELECT id FROM pods WHERE visibility IN ('public', 'invite_only'))
             OR s.pod_id IN (SELECT pod_id FROM pod_members WHERE user_id = $1 AND status = 'active'))
      ORDER BY s.scheduled_at ASC LIMIT 1`,
    [userId],
  );
```

2. Change the not-onboarded early return to `return { matches: [], profileIncomplete: true, nextEvent, youAreLookingFor: null };`.
3. In the `.map(x => ({ … }))`, after `company: x.c.company,` add:

```ts
      industry: x.c.industry ?? null,
      theyCanBring: clip(x.c.whatICanHelpWith || x.c.expertiseText),
      saved: x.c.saved === true,
      strength: (x.fit.score >= MATCH_THRESHOLD ? 'strong' : 'close') as 'strong' | 'close',
```

4. Change the final return to (`||`, not `??`: a blank answer is `''`, which must fall through):

```ts
  return { matches, profileIncomplete: false, nextEvent, youAreLookingFor: clip(me.whoIWantToMeet || me.myIntent) };
```

- [ ] **Step 6: Keep the old /matches page compiling**

`client/src/features/matches/MatchesPage.tsx:24-41` has its own copies of the types. They only need to be a subset, so no change is required. Confirm with `cd client && npx tsc --noEmit` (expect clean).

- [ ] **Step 7: Run tests, commit**

Run: `cd server && npx jest src/__tests__/services/matching --coverage=false && npx tsc --noEmit`
Expected: PASS, and the typecheck is clean.

```bash
git add server/src/services/matching/platform-match.service.ts server/src/__tests__/services/matching/platform-match.test.ts
git commit -m "For You data: saved and passed people, public offers, and no private events" -m "The suggestions feed now carries each person's public offer, industry, Save state and match strength, drops anyone the member passed on, and returns the member's own want for the card. The next-event card no longer shows a private pod's event to people outside the pod."
```

---

### Task A7: Ship Part A to production and prove it

**Files:**
- Create: `e2e/tests/reason-m1-api.spec.ts`

- [ ] **Step 1: Pre-flight**

Run: `npm run build:shared && cd server && npx jest && npx tsc --noEmit && cd ../client && npx tsc --noEmit`
Expected: every suite green and both typechecks clean. Record the test counts for `progress.md`.

- [ ] **Step 2: Ship**

Follow `/shipphase`:
1. Push `staging` and wait for CI green by SHA.
2. Fast-forward `main` and push, then wait for main CI green.
3. Wait for Render to be live on the SHA and for the Vercel production bundle hash to change.
4. Check that `/health` returns 200.

Then confirm the migration ran. Read-only SQL against production:

```sql
SELECT filename FROM _migrations WHERE filename = '101_reason_m1.sql';
```

Expected: one row.

- [ ] **Step 3: Write the API smoke**

```ts
// e2e/tests/reason-m1-api.spec.ts
// Production smoke for the dark milestone-1 endpoints (29 Sep 2026).
import { test, expect } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { cleanup, SERVER } from '../helpers/live-ui';

// createTestUser makes active, onboarded members (e2etest-…@example.com);
// cleanup() deletes the users rows, so person_responses, meeting_outcomes and
// user_blocks go with them (ON DELETE CASCADE).

const made: string[] = [];
// Response bodies are read loosely on purpose: each assertion names the one
// field it checks, and typing every endpoint here would duplicate the server.
type Json = any;
async function api(u: TestUser, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${SERVER}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
test.afterAll(async () => { if (made.length) await cleanup(pool, { ids: made }); });

type FeedCard = { userId: string; saved: boolean };
type ReceivedPoke = { id: string; senderId: string; message: string | null; preferredFormat: string | null };

test('Save, Pass, brief, note + format, outcome and recent connections work on production', async () => {
  test.setTimeout(180_000);
  const run = Date.now().toString(36);
  // Three made-up words only these two share, and no job-category word (a
  // word like "specialists" is a category the matcher gives every analyst,
  // which would put real members ahead of the test people).
  const words = `zq${run} wx${run} vk${run}`;
  const a = await createTestUser('m1-a'); made.push(a.id);
  const b = await createTestUser('m1-b'); made.push(b.id);
  await pool.query(`UPDATE users SET who_i_want_to_meet = $1 WHERE id = $2`, [words, a.id]);
  await pool.query(`UPDATE users SET expertise_text = $1, what_i_can_help_with = $2, who_i_want_to_meet = $3 WHERE id = $4`,
    [words, 'Intros to retail buyers', `secret-want-${run}`, b.id]);
  const feed = async () => (await api(a, 'GET', '/matches/platform')).body.data.matches as FeedCard[];

  // b is suggested; Save marks the card; Pass hides it; undo brings it back.
  expect((await feed()).map(m => m.userId)).toContain(b.id);
  expect((await api(a, 'PUT', `/people/${b.id}/response`, { response: 'saved' })).status).toBe(200);
  expect((await feed()).find(m => m.userId === b.id)?.saved).toBe(true);
  expect((await api(a, 'PUT', `/people/${b.id}/response`, { response: 'passed' })).status).toBe(200);
  expect((await feed()).map(m => m.userId)).not.toContain(b.id);
  expect((await api(a, 'DELETE', `/people/${b.id}/response`)).status).toBe(200);
  expect((await feed()).map(m => m.userId)).toContain(b.id);

  // The brief: public card only, b's own want never included.
  const brief = await api(a, 'GET', `/people/${b.id}/brief`);
  expect(brief.status).toBe(200);
  expect(JSON.stringify(brief.body)).not.toContain(`secret-want-${run}`);
  expect(brief.body.data.theyCanBring).toBe('Intros to retail buyers');
  expect(brief.body.data.youAreLookingFor).toBe(words);
  expect(brief.body.data.relationship.state).toBe('none');

  // A request with a note and format: b sees the note first and the format.
  const req = await api(a, 'POST', `/matches/platform/${b.id}/interest`, { note: `Hello ${run}`, format: 'coffee' });
  expect(req.status).toBe(201);
  const received = await api(b, 'GET', '/pokes/received');
  const mine = (received.body.data as ReceivedPoke[]).find(p => p.senderId === a.id)!;
  expect(mine.message?.startsWith(`Hello ${run}`)).toBe(true);
  expect(mine.preferredFormat).toBe('coffee');

  // Accept, then both can record an outcome, and it shows in recent connections.
  expect((await api(b, 'POST', `/pokes/${mine.id}/accept`)).status).toBe(200);
  expect((await api(a, 'POST', `/people/${b.id}/outcome`, { worthContinuing: 'yes', outcomes: ['introduction'] })).status).toBe(201);
  const after = await api(a, 'GET', `/people/${b.id}/brief`);
  expect(after.body.data.relationship.state).toBe('connected');
  expect(after.body.data.relationship.outcomes[0]).toMatchObject({ worthContinuing: 'yes', outcomes: ['introduction'] });
  const recent = await api(a, 'GET', '/people/connections/recent');
  expect((recent.body.data as Array<{ userId: string }>).map(r => r.userId)).toContain(b.id);

  // Blocked people are not found.
  await pool.query(`INSERT INTO user_blocks (id, blocker_id, blocked_id) VALUES (gen_random_uuid(), $1, $2)`, [b.id, a.id]);
  expect((await api(a, 'GET', `/people/${b.id}/brief`)).status).toBe(404);
});
```

- [ ] **Step 4: Run it against production, check the old UI, finish**

Run: `cd e2e && npx playwright test tests/reason-m1-api.spec.ts`
Expected: 1 passed.

Then do these checks:
1. **Old UI.** Open `https://app.rsn.network/messages` headed as a throwaway recipient who has a request with a format. The request card shows "Prefers in person coffee", and the rest of Messages is unchanged.
2. **Health.** Run `/checkhole`.
3. **Commit the spec:**

```bash
git add e2e/tests/reason-m1-api.spec.ts
git commit -m "E2E: milestone 1 people endpoints on production"
```

---

## Part B: the new client, on branch `reason-m1` (preview only)

### Task B1: Branch, look, logo, sheep, and the shared pieces

**Files:**
- Branch: `git checkout -b reason-m1` from `main` (after Part A is live)
- Modify: `client/tailwind.config.js` (`theme.extend.colors.reason`, `theme.extend.fontFamily.reason`)
- Create: `client/public/sheep/v4/{match,curious,hopeful,thinking}.png` (only the poses these screens use)
- Create: `client/src/features/reason/brand/ReasonMark.tsx`
- Create: `client/src/features/reason/brand/ReasonSheep.tsx`
- Create: `client/src/features/reason/ui/icons.tsx`
- Create: `client/src/features/reason/ui/PageHead.tsx`
- Create: `client/src/features/reason/ui/Sheet.tsx`
- Test: `server/src/__tests__/client/reason-m1-look.test.ts`

**Interfaces:**
- Produces:
  - Tailwind classes `text-reason-ink`, `text-reason-muted`, `border-reason-line`, `bg-reason-soft`, `bg-reason-warm`, `bg-reason-red`, `hover:bg-reason-red-hover`, `bg-reason-pink`, `font-reason`;
  - `<ReasonMark variant="full" | "rail" | "mobile" />`, `<ReasonSheep pose className />`, `<ReasonIcon name />`, `<PageHead eyebrow title subtitle pose />`, `<Sheet open onClose title footer>`;
  - `type ReasonSheepPose`, `type ReasonIconName`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/client/reason-m1-look.test.ts
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '../../../../client');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

describe('REASON look (milestone 1)', () => {
  it('Tailwind carries the prototype palette with the accessible brand red', () => {
    const tw = read('tailwind.config.js');
    expect(tw).toMatch(/reason:\s*\{/);
    expect(tw).toMatch(/red: '#DE322E'/);
    expect(tw).toMatch(/ink: '#11131a'/);
  });
  it('sheep poses are web-sized (<= 200KB each)', () => {
    for (const pose of ['match', 'curious', 'hopeful', 'thinking']) {
      const size = fs.statSync(path.join(root, `public/sheep/v4/${pose}.png`)).size;
      expect(size).toBeLessThanOrEqual(200 * 1024);
    }
  });
  it('the logo is the official sheep mark, not a prototype crop', () => {
    const mark = read('src/features/reason/brand/ReasonMark.tsx');
    expect(mark).toMatch(/\/rsn-sheep\.png/);
    expect(mark).not.toMatch(/logo_mark|logo_crop/);
  });
  it('sheets portal to body, are real dialogs, and respect the iPhone home bar', () => {
    const sheet = read('src/features/reason/ui/Sheet.tsx');
    expect(sheet).toMatch(/createPortal\([\s\S]*document\.body/);
    expect(sheet).toMatch(/role="dialog"/);
    expect(sheet).toMatch(/aria-modal="true"/);
    expect(sheet).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(sheet).toMatch(/h-11 w-11/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/__tests__/client/reason-m1-look.test.ts --coverage=false`
Expected: FAIL.

- [ ] **Step 3: Add the palette and font**

In `client/tailwind.config.js` `theme.extend.colors`, add:

```js
        // REASON milestone 1: Stefan's v4 prototype palette. The red is the
        // existing brand red (#ef3f35 fails AA with white text).
        reason: {
          ink: '#11131a', muted: '#6d7380', line: '#e8e9ec', soft: '#f7f7f8', warm: '#fbfaf7',
          red: '#DE322E', 'red-hover': '#C52B28', pink: '#fff1ef', green: '#18a86b', amber: '#c77a14',
        },
```

In `theme.extend.fontFamily`, add:

```js
        reason: ['Inter', 'ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Arial', 'sans-serif'],
```

(Inter is already loaded in `client/index.html`.)

- [ ] **Step 4: Make the web-sized sheep**

Run in PowerShell. This machine has System.Drawing; it has no sharp or ImageMagick.

```powershell
Add-Type -AssemblyName System.Drawing
$src = 'C:\dev\RSN\workspace\assets\RSN OVERHAUL\2026-09-28 Ali handoff (v3 + v4)\REASON_Ali_Handoff_v4\prototype\assets'
$dst = 'C:\dev\RSN\client\public\sheep\v4'
New-Item -ItemType Directory -Force $dst | Out-Null
foreach ($pose in 'match','curious','hopeful','thinking') {
  $img = [System.Drawing.Image]::FromFile("$src\sheep_$pose.png")
  $bmp = New-Object System.Drawing.Bitmap 384, 384, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img, 0, 0, 384, 384)
  $bmp.Save("$dst\$pose.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  "{0,-10} {1,7:N0} bytes" -f $pose, (Get-Item "$dst\$pose.png").Length
}
```

Expected: four files, each well under 200KB. Open two of them to check the transparency survived: `Start-Process "$dst\match.png"`.

- [ ] **Step 5: Write the brand pieces and icons**

```tsx
// client/src/features/reason/brand/ReasonMark.tsx
import { cn } from '@/lib/utils';

// The official sheep mark (pixel-identical to Stefan's OFFICIAL_LOGO_REFERENCE)
// with the REASON wordmark. "rail" hides the words at 721–980px.
export default function ReasonMark({ variant = 'full' }: { variant?: 'full' | 'rail' | 'mobile' }) {
  return (
    <span className="flex min-w-0 items-center gap-2" role="img" aria-label="REASON">
      <img
        src="/rsn-sheep.png"
        alt=""
        className={variant === 'mobile' ? 'h-[26px] w-[34px] shrink-0 object-contain' : 'h-[30px] w-[40px] shrink-0 object-contain'}
      />
      <span className={cn('items-end gap-1', variant === 'rail' ? 'hidden min-[981px]:flex' : 'flex')}>
        <strong className={cn('font-extrabold leading-none tracking-[-0.04em]', variant === 'mobile' ? 'text-[19px]' : 'text-[24px]')}>
          REASON
        </strong>
        {variant !== 'mobile' && <small className="mb-0.5 text-[10px] tracking-[0.12em] text-reason-muted">RSN</small>}
      </span>
    </span>
  );
}
```

```tsx
// client/src/features/reason/brand/ReasonSheep.tsx
import { cn } from '@/lib/utils';

export type ReasonSheepPose = 'match' | 'curious' | 'hopeful' | 'thinking';

export default function ReasonSheep({ pose, className }: { pose: ReasonSheepPose; className?: string }) {
  return <img src={`/sheep/v4/${pose}.png`} alt="" aria-hidden="true" loading="lazy" className={cn('object-contain', className)} />;
}
```

```tsx
// client/src/features/reason/ui/icons.tsx
// Stroke icons copied from Stefan's v4 prototype (index.html, the `icons` map).
import type { ReactElement, SVGProps } from 'react';

export type ReasonIconName =
  | 'foryou' | 'people' | 'entities' | 'circles' | 'pods' | 'events'
  | 'messages' | 'introductions' | 'profile' | 'settings' | 'support' | 'more';

const PATHS: Record<ReasonIconName, ReactElement> = {
  foryou: <><path d="M12 3 4.5 8.2v7.6L12 21l7.5-5.2V8.2L12 3Z" /><circle cx="12" cy="12" r="2.4" /><path d="M12 5.5v3M6.8 9l2.7 1.5m7.7-1.5-2.7 1.5" /></>,
  people: <><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-4 2-6 5-6s5 2 5 6M13 19c.3-3 1.8-4.5 4-4.5 2.4 0 4 1.7 4 4.5" /><path d="M11 11.2 14 10.5" /></>,
  entities: <><path d="M5 4h9v16H5zM14 8h5v12h-5" /><path d="M8 8h3M8 12h3M8 16h3M16 12h1M16 16h1" /></>,
  circles: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="4" r="1.4" /><circle cx="19" cy="14" r="1.4" /><circle cx="5" cy="14" r="1.4" /></>,
  pods: <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><circle cx="8" cy="19" r="2" /><circle cx="16" cy="19" r="2" /><path d="m10.7 6.5-4 4M13.3 6.5l4 4M6.8 13.7l1.8 3.4M17.2 13.7l-1.8 3.4M10 19h4" /></>,
  events: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /></>,
  messages: <><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><circle cx="9" cy="11" r=".7" /><circle cx="12" cy="11" r=".7" /><circle cx="15" cy="11" r=".7" /></>,
  introductions: <><path d="M8.5 14.5 6 17a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0" /><path d="m15.5 9.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" /><path d="m8 16 8-8" /></>,
  profile: <><circle cx="12" cy="8" r="3" /><path d="M5 21c0-5 2.6-7 7-7s7 2 7 7" /><circle cx="18.5" cy="5.5" r="1" /></>,
  settings: <><path d="M5 6h14M5 12h14M5 18h14" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="11" cy="18" r="2" /></>,
  support: <><circle cx="12" cy="12" r="8" /><path d="M9.8 9a2.4 2.4 0 1 1 3.6 2.1c-.9.5-1.4 1-1.4 2.2" /><circle cx="12" cy="17" r=".7" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
};

export function ReasonIcon({ name, ...props }: { name: ReasonIconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}
    >
      {PATHS[name]}
    </svg>
  );
}
```

- [ ] **Step 6: Write PageHead and Sheet**

```tsx
// client/src/features/reason/ui/PageHead.tsx
import ReasonSheep, { type ReasonSheepPose } from '../brand/ReasonSheep';

interface Props { eyebrow: string; title: string; subtitle: string; pose: ReasonSheepPose }

export default function PageHead({ eyebrow, title, subtitle, pose }: Props) {
  return (
    <header className="mb-[18px] grid grid-cols-[minmax(0,1fr)_68px] items-end gap-2.5 min-[721px]:mb-[22px] min-[721px]:flex min-[721px]:items-start min-[721px]:justify-between min-[721px]:gap-7">
      <div className="min-w-0">
        <p className="text-[9px] font-extrabold uppercase tracking-[0.13em] text-[#7b8190] min-[721px]:text-[11px] min-[721px]:tracking-[0.14em]">{eyebrow}</p>
        <h1 className="mt-1.5 text-[28px] font-extrabold leading-[1.02] tracking-[-0.045em] [overflow-wrap:anywhere] min-[391px]:text-[31px] min-[721px]:mt-[7px] min-[721px]:text-[42px] min-[721px]:leading-none">{title}</h1>
        <p className="mt-[7px] text-[14px] leading-[1.42] text-reason-muted min-[721px]:mt-2 min-[721px]:text-[17px] min-[721px]:leading-[1.45]">{subtitle}</p>
      </div>
      <ReasonSheep pose={pose} className="h-[66px] w-[62px] justify-self-end min-[391px]:h-[72px] min-[391px]:w-[68px] min-[721px]:h-[92px] min-[721px]:w-[116px] min-[721px]:[filter:drop-shadow(0_12px_14px_rgba(0,0,0,.06))]" />
    </header>
  );
}
```

```tsx
// client/src/features/reason/ui/Sheet.tsx
// Bottom sheet on phones, centred dialog from 768px. Portalled to <body>: an
// ancestor with a transform (animate-fade-in-up) would otherwise trap a fixed
// overlay inside it (memory: Modal/Overlay Portal Trap).
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }

export default function Sheet({ open, onClose, title, children, footer }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  // Parents pass inline arrows. Reading the latest one through a ref keeps the
  // effect below from re-running (and stealing focus) on every parent render.
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    // The dialog itself takes focus, not a field: a focused field opens the
    // phone keyboard over the sheet before the member has read it.
    panel.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-[rgba(12,14,18,.45)] font-reason text-reason-ink md:items-center md:p-6"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full flex-col rounded-t-[20px] bg-white shadow-[0_30px_80px_rgba(0,0,0,.18)] outline-none md:max-h-[86vh] md:w-[min(560px,100%)] md:rounded-[20px]"
      >
        <div className="flex items-center justify-between gap-3 px-[15px] pt-[18px] md:px-5 md:pt-5">
          <h2 className="text-[20px] font-bold tracking-[-0.02em]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#f3f4f6]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-[15px] pb-3 md:px-5">{children}</div>
        {footer && (
          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-reason-line bg-white px-[15px] pt-2.5 pb-[calc(12px+env(safe-area-inset-bottom))] md:px-5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 7: Run the test and typecheck, commit**

Run: `cd server && npx jest src/__tests__/client/reason-m1-look.test.ts --coverage=false && cd ../client && npx tsc --noEmit`
Expected: PASS, and the typecheck is clean.

```bash
git add client/tailwind.config.js client/public/sheep/v4 client/src/features/reason server/src/__tests__/client/reason-m1-look.test.ts
git commit -m "REASON look: palette, official sheep logo, sheep poses, sheets" -m "The building blocks of Stefan's approved design: the v4 palette with the accessible brand red, the official sheep mark with the REASON wordmark, the prototype's sheep poses at web size, its icons, the page header and a phone-first sheet."
```

---

### Task B2: The REASON shell (desktop, tablet rail, phone bar, More sheet)

**Files:**
- Create: `client/src/features/reason/shell/nav.ts`
- Create: `client/src/features/reason/shell/ReasonShell.tsx`
- Create: `client/src/features/reason/shell/ShellSidebar.tsx`
- Create: `client/src/features/reason/shell/ShellTopbar.tsx`
- Create: `client/src/features/reason/shell/MobileNav.tsx`
- Create: `client/src/features/reason/shell/ProfileMenu.tsx`
- Create: `client/src/features/reason/shell/LogoutSheet.tsx`
- Create: `client/src/features/reason/shell/ComingSoonPage.tsx`
- Create: `client/src/features/reason/shell/PeopleTabs.tsx` (Find people, Your searches, Everyone who fits, People you have met: today's four people pages, so none is lost)
- Modify: `client/src/App.tsx` (imports at L16 and L20, layout route L207, `/` L208, new routes)
- Modify: `client/src/features/search/SearchPage.tsx:13` and `:44` (take `?q=` from the top search)
- Modify: `client/src/lib/sentry.ts` (report preview errors as "preview")
- Test: `server/src/__tests__/client/reason-m1-shell.test.ts`

**Interfaces:**
- Consumes: B1 pieces; `NotificationBell`, `ToastContainer`, `OnboardingTour`, `Avatar`, `useAuthStore`, `E`, `api`.
- Produces:
  - `MAIN_NAV`, `SUB_NAV`, `NAV_BY_KEY`, `MOBILE_PRIMARY`, `MOBILE_MORE`, `type NavKey`, `type NavItem`;
  - `<ReasonShell />` as the layout route element;
  - `<ComingSoonPage kind="entities" | "introductions" />`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/client/reason-m1-shell.test.ts
import * as fs from 'fs';
import * as path from 'path';

// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');

describe('REASON shell (milestone 1)', () => {
  it('desktop navigation follows the prototype order', () => {
    const labels = [...read('features/reason/shell/nav.ts').matchAll(/label: '([^']+)'/g)].map(m => m[1]);
    expect(labels).toEqual(['For You', 'People', 'Entities', 'Circles', 'Pods', 'Events', 'Messages', 'Introductions', 'Profile', 'Settings', 'Support']);
  });
  it('the phone bar is For You, People, Events, Messages and More; More holds the rest', () => {
    const nav = read('features/reason/shell/nav.ts');
    expect(nav).toMatch(/MOBILE_PRIMARY[^=]*=\s*\['foryou', 'people', 'events', 'messages'\]/);
    expect(nav).toMatch(/MOBILE_MORE[^=]*=\s*\['entities', 'circles', 'pods', 'introductions', 'settings', 'support'\]/);
  });
  it('the tablet rail keeps its icons (the prototype hid them) and names each one', () => {
    const side = read('features/reason/shell/ShellSidebar.tsx');
    expect(side).toMatch(/aria-label=\{item\.label\}/);
    expect(side).toMatch(/<span className="hidden min-\[981px\]:inline">\{item\.label\}<\/span>/);
    expect(side).not.toMatch(/<ReasonIcon[^>]*hidden/);
  });
  it('fixed bars respect iPhone safe areas; phone tabs are at least 44px', () => {
    expect(read('features/reason/shell/MobileNav.tsx')).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(read('features/reason/shell/MobileNav.tsx')).toMatch(/min-h-\[56px\]/);
    expect(read('features/reason/shell/ShellTopbar.tsx')).toMatch(/env\(safe-area-inset-top\)/);
  });
  it('People keeps every existing people page one tap away', () => {
    const tabs = read('features/reason/shell/PeopleTabs.tsx');
    for (const to of ['/search', '/agents', '/matches', '/encounters']) expect(tabs).toContain(`to: '${to}'`);
    expect(read('features/reason/shell/ReasonShell.tsx')).toMatch(/\{inPeople && <PeopleTabs \/>\}/);
  });
  it('the shell keeps the old layout\'s "Complete your profile" nudge', () => {
    const shell = read('features/reason/shell/ReasonShell.tsx');
    expect(shell).toMatch(/onboardingCompleted === false/);
    expect(shell).toMatch(/Complete your profile/);
    expect(shell).toMatch(/to="\/onboarding"/);
  });
  it('App uses the new shell, For You at /, a full-screen Human Profile, and the coming-soon pages', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/<ProtectedRoute><ReasonShell \/><\/ProtectedRoute>/);
    expect(app).toMatch(/<Route path="\/" element=\{<ForYouPage \/>\} \/>/);
    expect(app).toMatch(/path="\/people\/:userId"/);
    expect(app).toMatch(/<ComingSoonPage kind="entities" \/>/);
    expect(app).toMatch(/<ComingSoonPage kind="introductions" \/>/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/__tests__/client/reason-m1-shell.test.ts --coverage=false`
Expected: FAIL (the files are missing).

- [ ] **Step 3: Navigation config**

```ts
// client/src/features/reason/shell/nav.ts
// Stefan's v4 navigation. People points at today's "Find people" until the
// People screen is rebuilt (next milestone); Entities and Introductions show an
// honest "coming next" page until then.
import type { ReasonIconName } from '../ui/icons';

export type NavKey = Exclude<ReasonIconName, 'more'>;
export interface NavItem { key: NavKey; label: string; to: string; match: (path: string) => boolean }

const under = (...prefixes: string[]) => (p: string) => prefixes.some(x => p === x || p.startsWith(`${x}/`));

export const MAIN_NAV: NavItem[] = [
  { key: 'foryou', label: 'For You', to: '/', match: (p) => p === '/' },
  { key: 'people', label: 'People', to: '/search', match: under('/search', '/agents', '/matches', '/encounters', '/people') },
  { key: 'entities', label: 'Entities', to: '/entities', match: under('/entities') },
  { key: 'circles', label: 'Circles', to: '/circles', match: under('/circles') },
  { key: 'pods', label: 'Pods', to: '/pods', match: under('/pods') },
  { key: 'events', label: 'Events', to: '/sessions', match: under('/sessions') },
  { key: 'messages', label: 'Messages', to: '/messages', match: under('/messages') },
  { key: 'introductions', label: 'Introductions', to: '/introductions', match: under('/introductions') },
];

export const SUB_NAV: NavItem[] = [
  { key: 'profile', label: 'Profile', to: '/profile', match: (p) => p === '/profile' },
  { key: 'settings', label: 'Settings', to: '/settings', match: under('/settings') },
  { key: 'support', label: 'Support', to: '/support', match: under('/support') },
];

export const NAV_BY_KEY = Object.fromEntries([...MAIN_NAV, ...SUB_NAV].map(i => [i.key, i])) as Record<NavKey, NavItem>;
export const MOBILE_PRIMARY: NavKey[] = ['foryou', 'people', 'events', 'messages'];
export const MOBILE_MORE: NavKey[] = ['entities', 'circles', 'pods', 'introductions', 'settings', 'support'];
```

- [ ] **Step 4: The shell and its parts**

```tsx
// client/src/features/reason/shell/ReasonShell.tsx
// Replaces AppLayout for every signed-in page on the preview. Socket life,
// entity invalidation and the incoming-call banner live in App.tsx, so they
// keep working here unchanged.
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import ToastContainer from '@/components/ui/Toast';
import OnboardingTour from '@/features/onboarding/OnboardingTour';
import ShellSidebar from './ShellSidebar';
import ShellTopbar from './ShellTopbar';
import MobileNav from './MobileNav';
import PeopleTabs, { PEOPLE_TABS } from './PeopleTabs';

export default function ReasonShell() {
  const { pathname } = useLocation();
  const user = useAuthStore((s) => s.user);
  const userId = user?.id as string | undefined;
  const { data: unread } = useQuery({
    queryKey: ['dm-unread-count'],
    queryFn: () => api.get('/dm/unread-count').then((r) => r.data.data.count as number),
    enabled: !!userId,
    meta: { entities: userId ? [E.userDms(userId)] : [] },
  });
  const unreadCount = unread ?? 0;
  const inPeople = PEOPLE_TABS.some((t) => pathname === t.to || pathname.startsWith(`${t.to}/`));
  // The old layout's nudge, kept. For You says the same thing in its own card.
  const nudgeProfile = user?.onboardingCompleted === false && pathname !== '/';

  return (
    <div className="min-h-[100dvh] bg-white font-reason text-reason-ink antialiased">
      <ShellSidebar unreadCount={unreadCount} />
      <div className="min-w-0 min-[721px]:pl-[82px] min-[981px]:pl-[232px]">
        <ShellTopbar />
        <main className="mx-auto w-full max-w-[1400px] px-[13px] pb-[calc(96px+env(safe-area-inset-bottom))] pt-4 min-[721px]:px-[22px] min-[721px]:pb-10 min-[721px]:pt-[22px]">
          {nudgeProfile && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#f3dcb8] bg-[#fff8ec] px-4 py-3 text-[13px]">
              <span><strong>Complete your profile</strong> so REASON can suggest people with a reason to meet you.</span>
              <Link to="/onboarding" className="flex min-h-[44px] items-center rounded-[11px] bg-reason-red px-4 font-bold text-white">Complete now</Link>
            </div>
          )}
          {inPeople && <PeopleTabs />}
          <Outlet />
        </main>
      </div>
      <MobileNav unreadCount={unreadCount} />
      <OnboardingTour />
      <ToastContainer />
    </div>
  );
}
```

```tsx
// client/src/features/reason/shell/PeopleTabs.tsx
// Until People is rebuilt (next milestone), the four existing people pages sit
// under one row of tabs, so none of them is lost from the new navigation.
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

export const PEOPLE_TABS = [
  { to: '/search', label: 'Find people' },
  { to: '/agents', label: 'Your searches' },
  { to: '/matches', label: 'Everyone who fits' },
  { to: '/encounters', label: 'People you have met' },
] as const;

export default function PeopleTabs() {
  return (
    <nav aria-label="People" className="-mx-[13px] mb-4 flex gap-1.5 overflow-x-auto px-[13px] min-[721px]:mx-0 min-[721px]:px-0">
      {PEOPLE_TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) => cn(
            'flex min-h-[44px] shrink-0 items-center rounded-full border px-3.5 text-[13px] font-bold',
            isActive ? 'border-[#ffc9c4] bg-reason-pink text-reason-red' : 'border-reason-line text-[#4d5562] hover:bg-reason-soft',
          )}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
```

```tsx
// client/src/features/reason/shell/ShellSidebar.tsx
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import ReasonMark from '../brand/ReasonMark';
import { ReasonIcon } from '../ui/icons';
import { MAIN_NAV, SUB_NAV, type NavItem } from './nav';
import ProfileMenu from './ProfileMenu';

function SideLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  return (
    <NavLink
      to={item.to}
      aria-label={item.label}
      title={item.label}
      className={cn(
        'relative flex min-h-[44px] items-center justify-center gap-3 rounded-xl px-2.5 text-[15px] transition-colors min-[981px]:justify-start',
        active ? 'bg-reason-pink font-bold text-reason-red shadow-[inset_3px_0_0_#DE322E]' : 'text-[#515968] hover:bg-reason-soft hover:text-[#111]',
      )}
    >
      <ReasonIcon name={item.key} className="shrink-0" />
      <span className="hidden min-[981px]:inline">{item.label}</span>
      {!!badge && (
        <i className="absolute right-1 top-1 grid h-[21px] min-w-[21px] place-items-center rounded-full bg-reason-red px-1.5 text-[11px] font-extrabold not-italic text-white min-[981px]:static min-[981px]:ml-auto">
          {badge > 9 ? '9+' : badge}
        </i>
      )}
    </NavLink>
  );
}

export default function ShellSidebar({ unreadCount }: { unreadCount: number }) {
  const { pathname } = useLocation();
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-[82px] flex-col border-r border-reason-line bg-white px-3.5 pb-3.5 pt-4 min-[721px]:flex min-[981px]:w-[232px]">
      <div className="flex h-[52px] items-center justify-center px-2 pb-2 min-[981px]:justify-start">
        <ReasonMark variant="rail" />
      </div>
      <nav className="mt-2.5 grid gap-1" aria-label="Main">
        {MAIN_NAV.map((item) => (
          <SideLink key={item.key} item={item} active={item.match(pathname)} badge={item.key === 'messages' ? unreadCount : undefined} />
        ))}
      </nav>
      <div className="mt-auto grid gap-1 border-t border-reason-line pt-3">
        {SUB_NAV.map((item) => <SideLink key={item.key} item={item} active={item.match(pathname)} />)}
      </div>
      <ProfileMenu />
    </aside>
  );
}
```

```tsx
// client/src/features/reason/shell/ShellTopbar.tsx
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import NotificationBell from '@/components/ui/NotificationBell';
import { useAuthStore } from '@/stores/authStore';
import ReasonMark from '../brand/ReasonMark';

export default function ShellTopbar() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(`/search?q=${encodeURIComponent(term)}`);
  };
  return (
    <header className="sticky top-0 z-[12] grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[44px_44px] items-center gap-x-2.5 gap-y-[7px] border-b border-reason-line bg-white/95 px-3 pb-2.5 pt-[max(9px,env(safe-area-inset-top))] backdrop-blur-lg min-[721px]:flex min-[721px]:h-[66px] min-[721px]:gap-[18px] min-[721px]:px-[22px] min-[721px]:py-0">
      <Link to="/" aria-label="REASON home" className="flex min-h-[44px] items-center min-[721px]:hidden">
        <ReasonMark variant="mobile" />
      </Link>
      <form onSubmit={submit} role="search" className="relative col-span-2 row-start-2 w-full min-w-0 min-[721px]:w-[min(520px,52vw)]">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[#303641]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search REASON"
          placeholder="Search people, entities, circles, pods or events…"
          className="h-11 w-full rounded-xl border border-transparent bg-[#f4f5f7] pl-10 pr-3 text-[16px] outline-none transition focus:border-[#cfd2d8] focus:bg-white focus:shadow-[0_0_0_4px_rgba(222,50,46,.06)] min-[721px]:text-[15px]"
        />
      </form>
      <div className="col-start-2 row-start-1 flex items-center gap-2 min-[721px]:ml-auto">
        <NotificationBell />
        <Link to="/profile" aria-label="Your profile" className="grid h-11 w-11 place-items-center rounded-xl border border-reason-line bg-white">
          <Avatar src={user?.avatarUrl} name={user?.displayName || 'You'} size="sm" />
        </Link>
      </div>
    </header>
  );
}
```

```tsx
// client/src/features/reason/shell/LogoutSheet.tsx
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import Sheet from '../ui/Sheet';

export default function LogoutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const confirm = async () => {
    onClose();
    await logout();
    navigate('/login');
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Log out?"
      footer={(
        <>
          <button type="button" onClick={onClose} className="min-h-[44px] rounded-[11px] border border-reason-line px-4 text-[14px] font-bold">Cancel</button>
          <button type="button" onClick={confirm} className="min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white">Log out</button>
        </>
      )}
    >
      <p className="py-2 text-[14px] text-reason-muted">You can sign back in any time.</p>
    </Sheet>
  );
}
```

```tsx
// client/src/features/reason/shell/ProfileMenu.tsx
// The sidebar's account block. Holds what the prototype has no slot for but
// members must not lose: Invite, Admin (admins only) and Log out.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';
import { useAuthStore } from '@/stores/authStore';
import { isAdmin } from '@/lib/utils';
import LogoutSheet from './LogoutSheet';

function MenuLink({ to, label, onDone }: { to: string; label: string; onDone: () => void }) {
  return (
    <Link role="menuitem" to={to} onClick={onDone} className="flex min-h-[44px] items-center rounded-xl px-3 text-[14px] hover:bg-reason-soft">
      {label}
    </Link>
  );
}

export default function ProfileMenu() {
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (!user) return null;
  const name = user.displayName || 'You';
  const close = () => setOpen(false);
  return (
    <div className="relative mt-2.5 border-t border-reason-line pt-3.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Your account"
        className="flex min-h-[44px] w-full items-center justify-center gap-2.5 rounded-xl px-2 text-left hover:bg-reason-soft min-[981px]:justify-start"
      >
        <Avatar src={user.avatarUrl} name={name} size="md" />
        <span className="hidden min-w-0 flex-1 min-[981px]:block">
          <strong className="block truncate text-[13px]">{name}</strong>
          <span className="block text-[11px] text-reason-muted">View profile</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-[220px] rounded-2xl border border-reason-line bg-white p-1.5 shadow-[0_14px_40px_rgba(16,18,24,.12)]">
          <MenuLink to="/profile" label="View profile" onDone={close} />
          <MenuLink to="/invites" label="Invite someone" onDone={close} />
          {isAdmin(user.role) && <MenuLink to="/admin" label="Admin" onDone={close} />}
          <button
            type="button"
            role="menuitem"
            onClick={() => { close(); setConfirm(true); }}
            className="flex min-h-[44px] w-full items-center rounded-xl px-3 text-left text-[14px] text-reason-red hover:bg-reason-soft"
          >
            Log out
          </button>
        </div>
      )}
      <LogoutSheet open={confirm} onClose={() => setConfirm(false)} />
    </div>
  );
}
```

```tsx
// client/src/features/reason/shell/MobileNav.tsx
import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import Avatar from '@/components/ui/Avatar';
import { useAuthStore } from '@/stores/authStore';
import { cn, isAdmin } from '@/lib/utils';
import Sheet from '../ui/Sheet';
import { ReasonIcon } from '../ui/icons';
import { MOBILE_MORE, MOBILE_PRIMARY, NAV_BY_KEY } from './nav';
import LogoutSheet from './LogoutSheet';

const TAB = 'relative grid min-h-[56px] min-w-0 content-center justify-items-center gap-0.5 rounded-xl px-1 text-[10px] font-bold';

export default function MobileNav({ unreadCount }: { unreadCount: number }) {
  const { pathname } = useLocation();
  const user = useAuthStore((s) => s.user);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const moreActive = MOBILE_MORE.some((k) => NAV_BY_KEY[k].match(pathname)) || pathname === '/profile';
  const done = () => setMoreOpen(false);

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-[70] grid grid-cols-5 gap-0.5 border-t border-reason-line bg-white/95 pt-1.5 backdrop-blur-lg pb-[calc(6px+env(safe-area-inset-bottom))] pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))] min-[721px]:hidden"
      >
        {MOBILE_PRIMARY.map((key) => {
          const item = NAV_BY_KEY[key];
          const active = item.match(pathname);
          return (
            <NavLink key={key} to={item.to} className={cn(TAB, active ? 'bg-reason-pink text-reason-red' : 'text-[#697180]')}>
              <ReasonIcon name={key} />
              <span>{item.label}</span>
              {key === 'messages' && unreadCount > 0 && (
                <i className="absolute right-[18%] top-1 grid h-4 min-w-4 place-items-center rounded-full bg-reason-red px-1 text-[9px] not-italic text-white">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </i>
              )}
            </NavLink>
          );
        })}
        <button type="button" onClick={() => setMoreOpen(true)} aria-haspopup="dialog" className={cn(TAB, moreActive ? 'bg-reason-pink text-reason-red' : 'text-[#697180]')}>
          <ReasonIcon name="more" />
          <span>More</span>
        </button>
      </nav>

      <Sheet open={moreOpen} onClose={done} title="More">
        <div className="grid grid-cols-2 gap-2 pb-2">
          {MOBILE_MORE.map((key) => {
            const item = NAV_BY_KEY[key];
            const active = item.match(pathname);
            return (
              <Link
                key={key}
                to={item.to}
                onClick={done}
                className={cn('flex min-h-[48px] items-center gap-2.5 rounded-[13px] border px-3 text-[14px] font-bold', active ? 'border-[#ffc9c4] bg-reason-pink text-reason-red' : 'border-reason-line text-[#323946]')}
              >
                <ReasonIcon name={key} width={20} height={20} />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
        {user && (
          <div className="mt-2 grid gap-1 border-t border-reason-line pb-1 pt-3">
            <Link to="/profile" onClick={done} className="flex min-h-[48px] items-center gap-2.5 rounded-xl px-1">
              <Avatar src={user.avatarUrl} name={user.displayName || 'You'} size="sm" />
              <span>
                <strong className="block text-[13px]">{user.displayName || 'You'}</strong>
                <small className="text-reason-muted">View profile</small>
              </span>
            </Link>
            <Link to="/invites" onClick={done} className="flex min-h-[44px] items-center rounded-xl px-1 text-[14px]">Invite someone</Link>
            {isAdmin(user.role) && <Link to="/admin" onClick={done} className="flex min-h-[44px] items-center rounded-xl px-1 text-[14px]">Admin</Link>}
            <button type="button" onClick={() => { done(); setConfirm(true); }} className="flex min-h-[44px] items-center rounded-xl px-1 text-left text-[14px] text-reason-red">Log out</button>
          </div>
        )}
      </Sheet>
      <LogoutSheet open={confirm} onClose={() => setConfirm(false)} />
    </>
  );
}
```

```tsx
// client/src/features/reason/shell/ComingSoonPage.tsx
import PageHead from '../ui/PageHead';
import ReasonSheep from '../brand/ReasonSheep';

const COPY = {
  entities: {
    eyebrow: 'THE NETWORK AROUND PEOPLE', title: 'Entities matter.',
    subtitle: 'Companies, funds, projects and organisations give relationships context.', pose: 'thinking',
    noteTitle: 'Organisations come next.', note: 'For now each person shows their company on their card and profile.',
  },
  introductions: {
    eyebrow: 'THE HUMAN BRIDGE', title: 'Introductions create leverage.',
    subtitle: 'Make the right introduction at the right time and let REASON learn what happened.', pose: 'hopeful',
    noteTitle: 'Introductions come in a later step.', note: 'Meeting requests you send and receive are in Messages.',
  },
} as const;

export default function ComingSoonPage({ kind }: { kind: keyof typeof COPY }) {
  const c = COPY[kind];
  return (
    <>
      <PageHead eyebrow={c.eyebrow} title={c.title} subtitle={c.subtitle} pose={c.pose} />
      <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5 min-[721px]:items-center min-[721px]:gap-5 min-[721px]:p-6">
        <ReasonSheep pose="curious" className="h-[58px] w-[58px] shrink-0 min-[721px]:h-[92px] min-[721px]:w-[92px]" />
        <div>
          <h2 className="text-[16px] font-bold">{c.noteTitle}</h2>
          <p className="mt-1 text-[13px] text-reason-muted">{c.note}</p>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 5: Wire the routes**

In `client/src/App.tsx`:
1. Delete line 16 (`import AppLayout from '@/components/layout/AppLayout';`) and line 20 (`import HomePage from '@/features/home/HomePage';`). The files stay: source-reading tests still pin them, and they are retired at merge time.
2. Add after line 17:

```tsx
import ReasonShell from '@/features/reason/shell/ReasonShell';
import ComingSoonPage from '@/features/reason/shell/ComingSoonPage';
import ForYouPage from '@/features/reason/for-you/ForYouPage';
import HumanProfilePage from '@/features/reason/human/HumanProfilePage';
```

3. Line 207 becomes `<Route element={<ProtectedRoute><ReasonShell /></ProtectedRoute>}>`.
4. Line 208 becomes `<Route path="/" element={<ForYouPage />} />`.
5. Directly after line 208, add:

```tsx
        <Route path="/entities" element={<ComingSoonPage kind="entities" />} />
        <Route path="/introductions" element={<ComingSoonPage kind="introductions" />} />
```

6. After the `/onboarding` route (L255), add:

```tsx
      <Route path="/people/:userId" element={<ProtectedRoute><><HumanProfilePage /><ToastContainer /></></ProtectedRoute>} />
```

(`ForYouPage` and `HumanProfilePage` arrive in Tasks B4 and B6. Until then, create each as a one-line placeholder, `export default function ForYouPage() { return null; }` and the same for `HumanProfilePage`, at the paths above so the build stays green. Replace them in B4/B6.)

- [ ] **Step 6: Let the top search open Find people with the words already in**

In `client/src/features/search/SearchPage.tsx` (`useEffect` is already imported on line 12):
- line 13 becomes `import { Link, useSearchParams } from 'react-router-dom';`
- line 44 becomes:

```tsx
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [q, setQ] = useState(urlQuery);
  // The top search bar lands here with ?q=; follow it when a new search arrives.
  useEffect(() => { setQ(urlQuery); }, [urlQuery]);
```

- [ ] **Step 7: Keep preview errors out of production's Sentry signal**

In `client/src/lib/sentry.ts`, add above `initSentry`:

```ts
/** Preview builds (preview.rsn.network, Vercel branch aliases) report as "preview", not "production". */
function sentryEnvironment(): string {
  const host = typeof window === 'undefined' ? '' : window.location.hostname;
  if (host.startsWith('preview.') || host.includes('-git-')) return 'preview';
  return import.meta.env.MODE;
}
```

Then change `environment: import.meta.env.MODE,` to `environment: sentryEnvironment(),`.

- [ ] **Step 8: Run tests, typecheck, look at it, commit**

Run: `cd server && npx jest src/__tests__/client --coverage=false && npx jest src/__tests__/services/phase-may19-realtime-migration-phase6.test.ts --coverage=false && cd ../client && npx tsc --noEmit`
Expected: PASS, and the typecheck is clean.

Then run the app locally (`npm run dev` and `npm run dev:client`), sign in as a throwaway user, and look at:
- 390px: the bottom bar and the More sheet.
- 768px: the rail shows icons.
- 1280px: the full sidebar.
- Several old pages inside the new shell: Circles, Pods, Events, Messages, Settings, Admin.
- People's four tabs (Find people, Your searches, Everyone who fits, People you have met), and the "Complete your profile" nudge for a member who has not finished onboarding.

Fix anything that overlaps.

```bash
git add client/src/features/reason/shell client/src/App.tsx client/src/features/search/SearchPage.tsx client/src/lib/sentry.ts client/src/features/reason/for-you client/src/features/reason/human server/src/__tests__/client/reason-m1-shell.test.ts
git commit -m "REASON shell: sidebar, tablet rail, phone bar and More sheet" -m "Stefan's v4 navigation on every page. The tablet rail keeps its icons (the prototype's hid them), the phone gets a bottom bar and a More sheet, every target is 44px, and Invite, Admin and Log out stay reachable from the account menu."
```

---

### Task B3: The Human Card and the client data layer

**Files:**
- Create: `client/src/features/reason/api.ts`
- Create: `client/src/features/reason/human/labels.ts`
- Create: `client/src/features/reason/human/HumanCard.tsx`
- Test: `server/src/__tests__/client/reason-m1-privacy.test.ts`

**Interfaces:**
- Consumes: `primaryActionFor`, `RelationshipState` (A1); the payloads from A5/A6.
- Produces:
  - `reasonKeys`, `fetchForYou`, `fetchBrief`, `fetchRecentConnections`, `setPersonResponse(userId, response|null)`, `sendMeetRequest(userId, note, format)`, `recordOutcomeRequest(userId, worth, outcomes)`, `stateFromPoke(status, sentByOwner)`, `errorMessage(err, fallback)`;
  - types `ForYouMatch`, `ForYouPayload`;
  - `PRIMARY_LABEL`, `STATE_LABEL`, `NEXT_MOVE`;
  - `<HumanCard person source onMeet onToggleSave busy />` and `type HumanCardPerson`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/client/reason-m1-privacy.test.ts
// Approved point 1 (29 Sep 2026): until the per-reason share switch exists, no
// REASON screen may show another member's wants.
import * as fs from 'fs';
import * as path from 'path';

const dir = path.join(__dirname, '../../../../client/src/features/reason');
const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]);

describe('REASON screens never show another member\'s wants', () => {
  it('no "They need" or "You can bring" labels anywhere in features/reason', () => {
    for (const f of files(dir).filter(f => /\.tsx?$/.test(f))) {
      const src = fs.readFileSync(f, 'utf8');
      expect({ f, hit: /They need|You can bring/.test(src) }).toEqual({ f, hit: false });
    }
  });
  it('the card shows the other person\'s offer and the viewer\'s own want', () => {
    const card = fs.readFileSync(path.join(dir, 'human/HumanCard.tsx'), 'utf8');
    expect(card).toMatch(/They can bring/);
    expect(card).toMatch(/You are looking for/);
    expect(card).toMatch(/primaryActionFor/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx jest src/__tests__/client/reason-m1-privacy.test.ts --coverage=false`
Expected: FAIL (`human/HumanCard.tsx` does not exist).

- [ ] **Step 3: The data layer and the labels**

```ts
// client/src/features/reason/api.ts
import api from '@/lib/api';
import type {
  MatchStrength, MeetingFormat, OutcomeKey, PersonBrief, PersonResponse,
  RecentConnection, RelationshipState, WorthContinuing,
} from '@rsn/shared';

export interface ForYouMatch {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  professionalRole: string | null;
  company: string | null;
  industry: string | null;
  reason: string;
  theyCanBring: string | null;
  saved: boolean;
  strength: MatchStrength;
  pokeStatus: 'pending' | 'accepted' | null;
  pokeSentByOwner: boolean | null;
}

export interface ForYouPayload {
  matches: ForYouMatch[];
  profileIncomplete: boolean;
  youAreLookingFor: string | null;
  nextEvent: { id: string; title: string; scheduledAt: string } | null;
}

export const reasonKeys = {
  all: ['reason'] as const,
  forYou: ['reason', 'for-you'] as const,
  brief: (userId: string) => ['reason', 'brief', userId] as const,
  recent: ['reason', 'recent-connections'] as const,
};

export function stateFromPoke(status: ForYouMatch['pokeStatus'], sentByOwner: boolean | null): RelationshipState {
  if (status === 'accepted') return 'connected';
  if (status === 'pending') return sentByOwner ? 'requested' : 'incoming';
  return 'none';
}

export const fetchForYou = () => api.get('/matches/platform').then((r) => r.data.data as ForYouPayload);
export const fetchBrief = (userId: string) => api.get(`/people/${userId}/brief`).then((r) => r.data.data as PersonBrief);
export const fetchRecentConnections = () => api.get('/people/connections/recent').then((r) => r.data.data as RecentConnection[]);

export const setPersonResponse = (userId: string, response: PersonResponse | null) =>
  response ? api.put(`/people/${userId}/response`, { response }) : api.delete(`/people/${userId}/response`);

export const sendMeetRequest = (userId: string, note: string, format: MeetingFormat) =>
  api.post(`/matches/platform/${userId}/interest`, { note, format });

export const recordOutcomeRequest = (userId: string, worthContinuing: WorthContinuing, outcomes: OutcomeKey[]) =>
  api.post(`/people/${userId}/outcome`, { worthContinuing, outcomes });

export function errorMessage(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
  return msg || fallback;
}
```

```ts
// client/src/features/reason/human/labels.ts
import type { PrimaryAction, RelationshipState } from '@rsn/shared';

export const PRIMARY_LABEL: Record<PrimaryAction, string> = {
  meet: 'Meet', requested: 'Request sent', respond: 'Respond', declined: 'Request declined', continue: 'Continue',
};

export const STATE_LABEL: Record<RelationshipState, string> = {
  none: 'New relationship', requested: 'Meeting requested', incoming: 'They asked to meet you',
  declined: 'Request declined', connected: 'Connected', met: 'Met',
};

export const NEXT_MOVE: Record<RelationshipState, string> = {
  none: 'Decide whether there is a reason to meet.',
  requested: 'Wait for their answer, then have the conversation.',
  incoming: 'They asked to meet you. Answer in Messages.',
  declined: 'They declined your earlier request.',
  connected: 'Pick a time together in Messages.',
  met: 'Record what happened, then continue while the reason is live.',
};
```

- [ ] **Step 4: The Human Card**

```tsx
// client/src/features/reason/human/HumanCard.tsx
// The one person card used everywhere (Stefan's v4: "Human cards are the
// universal person object"). Four columns only from 1420px, where they fit;
// below that it stacks, so the reason and the buttons never clip.
import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { primaryActionFor, type RelationshipState } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import { PRIMARY_LABEL } from './labels';

export interface HumanCardPerson {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: string | null;
  company: string | null;
  tags: string[];
  reason: string;
  theyCanBring: string | null;
  youAreLookingFor: string | null;
  state: RelationshipState;
  saved: boolean;
}

interface Props {
  person: HumanCardPerson;
  source: string;
  onMeet: (p: HumanCardPerson) => void;
  onToggleSave: (p: HumanCardPerson) => void;
  busy?: boolean;
}

export default function HumanCard({ person, source, onMeet, onToggleSave, busy }: Props) {
  const navigate = useNavigate();
  const profileUrl = `/people/${person.userId}?from=${encodeURIComponent(source)}`;
  const action = primaryActionFor(person.state);
  const inert = action === 'requested' || action === 'declined';

  const onPrimary = () => {
    if (action === 'meet') onMeet(person);
    else if (action === 'continue') navigate(`/messages/new/${person.userId}`);
    else if (action === 'respond') navigate(profileUrl);
  };
  const openProfile = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    navigate(profileUrl);
  };

  return (
    <article
      data-person-id={person.userId}
      onClick={openProfile}
      className="grid cursor-pointer grid-cols-[70px_minmax(0,1fr)] items-start gap-2.5 overflow-hidden rounded-[15px] border border-reason-line bg-white p-[11px] transition hover:shadow-[0_10px_28px_rgba(16,18,24,.06)] min-[721px]:grid-cols-[90px_minmax(0,1fr)] min-[721px]:gap-3.5 min-[721px]:p-3 min-[1420px]:grid-cols-[110px_minmax(160px,210px)_minmax(0,1fr)_150px] min-[1420px]:items-center"
    >
      <Link to={profileUrl} aria-label={`Open ${person.displayName}`} className="block">
        {/* Avatar shows initials when there is no photo, or when the photo fails to load. */}
        <Avatar
          src={person.avatarUrl}
          name={person.displayName}
          size="xl"
          className="h-[70px] w-[70px] rounded-xl min-[721px]:h-[88px] min-[721px]:w-[90px] min-[1420px]:h-[96px] min-[1420px]:w-[110px] min-[1420px]:rounded-[13px]"
        />
      </Link>

      <div className="min-w-0">
        <h3 className="text-[16px] font-bold leading-tight [overflow-wrap:anywhere] min-[721px]:text-[17px]">
          <Link to={profileUrl} className="hover:underline">{person.displayName}</Link>
        </h3>
        {person.role && <p className="mt-0.5 text-[12px] text-[#677080] [overflow-wrap:anywhere] min-[721px]:text-[13px]">{person.role}</p>}
        {person.company && <p className="mt-1.5 text-[12px] font-bold [overflow-wrap:anywhere] min-[721px]:text-[13px]">{person.company}</p>}
        {person.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {person.tags.slice(0, 3).map((t) => (
              <span key={t} className="rounded-full bg-[#f3f4f6] px-2 py-1 text-[10px] text-[#68707e]">{t}</span>
            ))}
          </div>
        )}
      </div>

      <div className="col-span-2 min-w-0 border-t border-[#f0f1f3] pt-2.5 min-[721px]:col-span-1 min-[721px]:col-start-2 min-[721px]:border-0 min-[721px]:pt-0 min-[1420px]:col-start-3">
        <strong className="block text-[12px]">Why you should meet</strong>
        <p className="mt-1 text-[12px] leading-snug text-[#626a78]">{person.reason}</p>
        {(person.theyCanBring || person.youAreLookingFor) && (
          <div className="mt-2.5 grid grid-cols-1 gap-2.5 min-[391px]:grid-cols-2">
            {person.theyCanBring && (
              <div className="min-w-0 text-[11px] text-[#697180]"><b className="block text-[#282c34]">They can bring</b>{person.theyCanBring}</div>
            )}
            {person.youAreLookingFor && (
              <div className="min-w-0 text-[11px] text-[#697180]"><b className="block text-[#282c34]">You are looking for</b>{person.youAreLookingFor}</div>
            )}
          </div>
        )}
      </div>

      <div className="col-span-2 grid grid-cols-2 gap-2 min-[721px]:col-span-1 min-[721px]:col-start-2 min-[1420px]:col-start-4 min-[1420px]:grid-cols-1">
        <button
          type="button"
          onClick={onPrimary}
          disabled={busy || inert}
          className={cn('min-h-[44px] rounded-[11px] px-3 text-[13px] font-bold transition',
            inert ? 'bg-[#f5f6f7] text-[#6d7380]' : 'bg-reason-red text-white shadow-[0_7px_18px_rgba(222,50,46,.18)] hover:bg-reason-red-hover')}
        >
          {PRIMARY_LABEL[action]}
        </button>
        <button
          type="button"
          onClick={() => onToggleSave(person)}
          disabled={busy}
          aria-pressed={person.saved}
          className="min-h-[44px] rounded-[11px] bg-[#f5f6f7] px-3 text-[13px] font-bold text-[#2d3440]"
        >
          {person.saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </article>
  );
}
```

- [ ] **Step 5: Run the test and typecheck, commit**

Run: `npm run build:shared && cd server && npx jest src/__tests__/client/reason-m1-privacy.test.ts --coverage=false && cd ../client && npx tsc --noEmit`
Expected: PASS, and the typecheck is clean.

```bash
git add client/src/features/reason/api.ts client/src/features/reason/human/labels.ts client/src/features/reason/human/HumanCard.tsx server/src/__tests__/client/reason-m1-privacy.test.ts
git commit -m "The Human Card" -m "One person card for every REASON screen: why you should meet, what they can bring and what you are looking for, Meet or Continue, and Save. It stacks below 1420px so nothing clips on laptops and tablets."
```

---

### Task B4: For You

**Files:**
- Replace the placeholder: `client/src/features/reason/for-you/ForYouPage.tsx`
- Create: `client/src/features/reason/for-you/ForYouRail.tsx`
- Create: `client/src/features/reason/for-you/ForYouEmpty.tsx`

**Interfaces:**
- Consumes: B1, B3, and `MeetSheet` from B5. Until B5 lands, create `human/MeetSheet.tsx` as `export default function MeetSheet(_: { person: unknown; onClose: () => void }) { return null; }`.
- Produces: `<ForYouPage />`.

- [ ] **Step 1: Write the page**

```tsx
// client/src/features/reason/for-you/ForYouPage.tsx
// "Who matters to me right now, and why?" A tight shortlist (max 5), never a
// directory (Stefan's v4: do not merge For You and People).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import PageHead from '../ui/PageHead';
import ReasonSheep from '../brand/ReasonSheep';
import HumanCard, { type HumanCardPerson } from '../human/HumanCard';
import MeetSheet from '../human/MeetSheet';
import ForYouRail from './ForYouRail';
import ForYouEmpty from './ForYouEmpty';
import { errorMessage, fetchForYou, reasonKeys, setPersonResponse, stateFromPoke, type ForYouMatch } from '../api';

const SHORTLIST = 5;

function toCard(m: ForYouMatch, youAreLookingFor: string | null): HumanCardPerson {
  return {
    userId: m.userId,
    displayName: m.displayName,
    avatarUrl: m.avatarUrl,
    role: m.professionalRole,
    company: m.company,
    tags: m.industry ? [m.industry] : [],
    reason: m.reason,
    theyCanBring: m.theyCanBring,
    youAreLookingFor,
    state: stateFromPoke(m.pokeStatus, m.pokeSentByOwner),
    saved: m.saved,
  };
}

export default function ForYouPage() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id as string | undefined;
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  const [meeting, setMeeting] = useState<HumanCardPerson | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: reasonKeys.forYou,
    queryFn: fetchForYou,
    enabled: !!userId,
    meta: { entities: userId ? [E.user(userId), E.userInvites(userId), E.userDms(userId)] : [] },
  });

  const save = useMutation({
    mutationFn: (p: HumanCardPerson) => setPersonResponse(p.userId, p.saved ? null : 'saved'),
    onSuccess: (_r, p) => {
      addToast(p.saved ? `${p.displayName} removed from saved` : `${p.displayName} saved`, 'success');
      qc.invalidateQueries({ queryKey: reasonKeys.all });
    },
    onError: (err) => addToast(errorMessage(err, 'Could not save that right now. Try again in a moment.'), 'error'),
  });

  const firstName = String(user?.firstName || user?.displayName || '').split(' ')[0];
  const cards = (data?.matches ?? []).slice(0, SHORTLIST).map((m) => toCard(m, data?.youAreLookingFor ?? null));

  return (
    <>
      <PageHead eyebrow="GOOD TO SEE YOU" title={firstName ? `Welcome, ${firstName}.` : 'Welcome.'} subtitle="Here are people you have a reason to meet." pose="match" />
      <div className="grid items-start gap-3 min-[981px]:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] min-[981px]:gap-[18px]">
        <section aria-labelledby="foryou-title" className="min-w-0 rounded-[15px] border border-reason-line bg-white p-[13px] shadow-[0_6px_24px_rgba(16,18,24,.025)] min-[721px]:rounded-[18px] min-[721px]:p-[18px]">
          {isLoading ? (
            <div className="grid gap-3.5" aria-busy="true">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[150px]" />)}
            </div>
          ) : isError ? (
            <div role="alert" className="flex flex-col items-start gap-3 py-4">
              <h2 id="foryou-title" className="text-[15px] font-bold">We could not load your people just now.</h2>
              <button type="button" onClick={() => refetch()} className="min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[13px] font-bold text-white">Try again</button>
            </div>
          ) : cards.length === 0 ? (
            <ForYouEmpty profileIncomplete={!!data?.profileIncomplete} nextEvent={data?.nextEvent ?? null} />
          ) : (
            <>
              <div className="mb-3 flex items-start justify-between gap-2 min-[721px]:mb-3.5">
                <div className="flex min-w-0 items-start gap-2 min-[721px]:items-center min-[721px]:gap-2.5">
                  <ReasonSheep pose="match" className="h-9 w-9 shrink-0 min-[721px]:h-[42px] min-[721px]:w-[42px]" />
                  <div className="min-w-0">
                    <h2 id="foryou-title" className="text-[18px] font-bold leading-[1.12] tracking-[-0.025em] min-[721px]:text-[22px]">
                      {cards.length === 1 ? '1 person you have a reason to meet' : `${cards.length} people you have a reason to meet`}
                    </h2>
                    <small className="mt-[3px] block text-[11px] leading-[1.35] text-reason-muted min-[721px]:mt-1 min-[721px]:text-[13px]">
                      Based on your current reasons, network and upcoming contexts.
                    </small>
                  </div>
                </div>
                <Link to="/matches" className="flex min-h-[44px] shrink-0 items-center px-1 text-[12px] text-[#575f6f] hover:text-reason-red">View all</Link>
              </div>
              <div className="grid gap-3.5">
                {cards.map((p) => (
                  <HumanCard
                    key={p.userId}
                    person={p}
                    source="For You"
                    busy={save.isPending && save.variables?.userId === p.userId}
                    onMeet={setMeeting}
                    onToggleSave={(x) => save.mutate(x)}
                  />
                ))}
              </div>
            </>
          )}
        </section>
        <ForYouRail nextEvent={data?.nextEvent ?? null} />
      </div>
      <MeetSheet person={meeting} onClose={() => setMeeting(null)} />
    </>
  );
}
```

- [ ] **Step 2: The side panels (hidden below 981px, like the prototype)**

```tsx
// client/src/features/reason/for-you/ForYouRail.tsx
// Real data only. No "Suggested entities" (no organisations yet) and no event
// photo (events have none): nothing is invented.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import Avatar from '@/components/ui/Avatar';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { fetchRecentConnections, reasonKeys } from '../api';

function RailCard({ title, to, children }: { title: string; to: string; children: ReactNode }) {
  return (
    <section className="rounded-[18px] border border-reason-line bg-white p-3.5 shadow-[0_6px_24px_rgba(16,18,24,.025)]">
      <div className="mb-2 flex items-center justify-between gap-3.5">
        <h3 className="text-[14px] font-bold">{title}</h3>
        <Link to={to} className="flex min-h-[44px] items-center px-1 text-[12px] text-[#575f6f] hover:text-reason-red">View all</Link>
      </div>
      {children}
    </section>
  );
}

const ROW = 'grid min-h-[44px] grid-cols-[38px_1fr_auto] items-center gap-2.5 border-t border-[#f0f1f3] py-2 first:border-t-0';

export default function ForYouRail({ nextEvent }: { nextEvent: { id: string; title: string; scheduledAt: string } | null }) {
  const userId = useAuthStore((s) => s.user?.id as string | undefined);
  const { data: pods } = useQuery({
    queryKey: ['my-pods', 'active'],
    queryFn: () => api.get('/pods?status=active').then((r) => (r.data.data ?? []) as Array<{ id: string; name: string; memberCount?: number }>),
    enabled: !!userId,
    meta: { entities: userId ? [E.userPods(userId)] : [] },
  });
  const { data: recent } = useQuery({
    queryKey: reasonKeys.recent,
    queryFn: fetchRecentConnections,
    enabled: !!userId,
    meta: { entities: userId ? [E.user(userId), E.userInvites(userId)] : [] },
  });
  const when = nextEvent ? new Date(nextEvent.scheduledAt) : null;

  return (
    <aside aria-label="Your context" className="hidden min-w-0 gap-3.5 min-[981px]:grid">
      <RailCard title="Your next event" to="/sessions">
        {nextEvent && when ? (
          <Link to={`/sessions/${nextEvent.id}`} className="grid grid-cols-[52px_1fr] gap-[11px]">
            <span className="grid h-[52px] place-items-center rounded-[10px] bg-reason-red text-center text-[11px] font-extrabold leading-tight text-white">
              {when.toLocaleString([], { month: 'short' }).toUpperCase()}<br />{String(when.getDate()).padStart(2, '0')}
            </span>
            <span className="min-w-0">
              <b className="block text-[13px] [overflow-wrap:anywhere]">{nextEvent.title}</b>
              <span className="text-[11px] text-reason-muted">{when.toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' })}</span>
            </span>
          </Link>
        ) : (
          <p className="text-[12px] text-reason-muted">No upcoming event yet. New ones appear here.</p>
        )}
      </RailCard>

      <RailCard title="Your pods" to="/pods">
        {(pods ?? []).length === 0 ? (
          <p className="text-[12px] text-reason-muted">You are not in a pod yet.</p>
        ) : (pods ?? []).slice(0, 3).map((p) => (
          <Link key={p.id} to={`/pods/${p.id}`} className={ROW}>
            <span className="grid h-[38px] w-[38px] place-items-center rounded-full bg-[#f1f2f4] font-extrabold">{p.name.charAt(0).toUpperCase()}</span>
            <span className="min-w-0">
              <b className="block truncate text-[12px]">{p.name}</b>
              {typeof p.memberCount === 'number' && <span className="text-[10px] text-reason-muted">{p.memberCount} members</span>}
            </span>
            <span aria-hidden="true">›</span>
          </Link>
        ))}
      </RailCard>

      <RailCard title="Recent introductions" to="/messages">
        {(recent ?? []).length === 0 ? (
          <p className="text-[12px] text-reason-muted">When someone accepts a meeting request, they show up here.</p>
        ) : (recent ?? []).map((r) => (
          <Link key={r.userId} to={`/people/${r.userId}?from=Introductions`} className={ROW}>
            <Avatar src={r.avatarUrl} name={r.displayName} size="sm" />
            <span className="min-w-0">
              <b className="block truncate text-[12px]">{r.displayName}</b>
              <span className="text-[10px] text-reason-muted">{new Date(r.connectedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
            </span>
            <i className="rounded-full bg-[#e9f8f1] px-2 py-1 text-[10px] font-extrabold not-italic text-[#168657]">Connected</i>
          </Link>
        ))}
      </RailCard>
    </aside>
  );
}
```

- [ ] **Step 3: The empty state (Foundation S7: never a dashboard of zeros)**

```tsx
// client/src/features/reason/for-you/ForYouEmpty.tsx
import { Link } from 'react-router-dom';
import ReasonSheep from '../brand/ReasonSheep';

interface Props { profileIncomplete: boolean; nextEvent: { id: string; title: string } | null }
const ACTION = 'flex min-h-[48px] items-center rounded-xl border border-reason-line px-3.5 text-[14px] font-bold';

export default function ForYouEmpty({ profileIncomplete, nextEvent }: Props) {
  if (profileIncomplete) {
    return (
      <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
        <ReasonSheep pose="thinking" className="h-[58px] w-[58px] shrink-0" />
        <div>
          <h2 id="foryou-title" className="text-[16px] font-bold">Tell REASON a little more about you.</h2>
          <p className="mt-1 text-[13px] text-reason-muted">Finish your profile and REASON can find people with a reason to meet you.</p>
          <Link to="/onboarding" className="mt-3 inline-flex min-h-[44px] items-center rounded-[11px] bg-reason-red px-4 text-[13px] font-bold text-white">Finish my profile</Link>
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
        <ReasonSheep pose="hopeful" className="h-[58px] w-[58px] shrink-0" />
        <div>
          <h2 id="foryou-title" className="text-[16px] font-bold">No one new to suggest right now.</h2>
          <p className="mt-1 text-[13px] text-reason-muted">New people join all the time. Here is what you can do meanwhile.</p>
        </div>
      </div>
      <Link to={nextEvent ? `/sessions/${nextEvent.id}` : '/sessions'} className={ACTION}>{nextEvent ? `Join ${nextEvent.title}` : 'See upcoming events'}</Link>
      <Link to="/invites" className={ACTION}>Invite people you would like here</Link>
      <Link to="/matches" className={ACTION}>Browse a wider circle of people</Link>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck, the realtime guard, look at it, commit**

Run: `cd client && npx tsc --noEmit && cd ../server && npx jest src/__tests__/services/phase-may19-realtime-migration-phase6.test.ts --coverage=false`
Expected: clean, and PASS (every new `useQuery` carries `meta.entities`).

Look at the page locally at 390, 768, 1024, 1280 and 1440. Fix any overlap before committing.

```bash
git add client/src/features/reason/for-you client/src/features/reason/human/MeetSheet.tsx
git commit -m "For You: the people you have a reason to meet" -m "A shortlist of up to five people from the real suggestions engine, with the next event, your pods and recent introductions beside it on wide screens. Empty, loading and error states each say what to do next."
```

---

### Task B5: The Meet sheet and the "What happened?" sheet

**Files:**
- Replace the placeholder: `client/src/features/reason/human/MeetSheet.tsx`
- Create: `client/src/features/reason/human/OutcomeSheet.tsx`

**Interfaces:**
- Consumes: `Sheet` (B1); `sendMeetRequest`, `recordOutcomeRequest`, `reasonKeys`, `errorMessage` (B3); `MEETING_FORMATS`, `OUTCOME_KEYS`, `OUTCOME_LABELS` (A1).
- Produces:
  - `<MeetSheet person={ {userId, displayName} | null } onClose />`
  - `<OutcomeSheet person={ {userId, displayName} | null } onClose />`

- [ ] **Step 1: The Meet sheet**

```tsx
// client/src/features/reason/human/MeetSheet.tsx
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MEETING_FORMATS, type MeetingFormat } from '@rsn/shared';
import { useToastStore } from '@/stores/toastStore';
import Sheet from '../ui/Sheet';
import { errorMessage, reasonKeys, sendMeetRequest } from '../api';

// The prototype's own default text.
const DEFAULT_NOTE = 'I think we have a useful reason to speak. I would like to compare notes and see whether there is anything worth continuing.';
// Leaves room for REASON's reason inside the request's 500 characters.
const MAX = 300;

interface Props { person: { userId: string; displayName: string } | null; onClose: () => void }

export default function MeetSheet({ person, onClose }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [note, setNote] = useState(DEFAULT_NOTE);
  const [format, setFormat] = useState<MeetingFormat>('video_20');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!person) return;
    setNote(DEFAULT_NOTE);
    setFormat('video_20');
    setError(null);
  }, [person]);

  const send = useMutation({
    mutationFn: () => sendMeetRequest(person!.userId, note.trim(), format),
    onSuccess: () => {
      addToast(`Meeting request sent to ${person!.displayName}`, 'success');
      qc.invalidateQueries({ queryKey: reasonKeys.all });
      onClose();
    },
    onError: (err) => setError(errorMessage(err, 'Could not send that request. Try again in a moment.')),
  });

  const length = note.trim().length;
  const invalid = length === 0 || length > MAX;
  // A ref, not isPending: a double tap lands before React re-renders the
  // button as disabled, and each tap would otherwise send its own request.
  const inFlight = useRef(false);
  const submit = () => {
    if (inFlight.current || invalid) return;
    inFlight.current = true;
    send.mutate(undefined, { onSettled: () => { inFlight.current = false; } });
  };

  return (
    <Sheet
      open={!!person}
      onClose={onClose}
      title={person ? `Meet ${person.displayName}` : 'Meet'}
      footer={(
        <>
          <button type="button" onClick={onClose} className="min-h-[44px] rounded-[11px] border border-reason-line px-4 text-[14px] font-bold">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={send.isPending || invalid}
            className="min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white disabled:opacity-60"
          >
            {send.isPending ? 'Sending…' : 'Send request'}
          </button>
        </>
      )}
    >
      <p className="mt-1 text-[13px] text-reason-muted">REASON will send a meeting request with the reason attached, so the conversation starts with context.</p>
      <label className="mt-3.5 grid gap-1.5 text-[12px] font-bold">
        Why now?
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          className="min-h-[90px] resize-y rounded-[11px] border border-reason-line p-3 text-[16px] font-normal md:text-[14px]"
        />
      </label>
      <p className={length > MAX ? 'mt-1 text-[11px] text-reason-red' : 'mt-1 text-[11px] text-reason-muted'}>{length} / {MAX}</p>
      <label className="mt-3 grid gap-1.5 text-[12px] font-bold">
        Preferred format
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value as MeetingFormat)}
          className="min-h-[44px] rounded-[11px] border border-reason-line bg-white px-3 text-[16px] font-normal md:text-[14px]"
        >
          {MEETING_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="mt-3 text-[13px] text-reason-red">{error}</p>}
    </Sheet>
  );
}
```

- [ ] **Step 2: The "What happened?" sheet**

```tsx
// client/src/features/reason/human/OutcomeSheet.tsx
// Foundation S10 and the v4 prototype's outcome modal.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OUTCOME_KEYS, OUTCOME_LABELS, type OutcomeKey, type WorthContinuing } from '@rsn/shared';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import Sheet from '../ui/Sheet';
import { errorMessage, reasonKeys, recordOutcomeRequest } from '../api';

const WORTH: Array<{ key: WorthContinuing; label: string }> = [
  { key: 'yes', label: 'Yes' }, { key: 'maybe', label: 'Maybe' }, { key: 'no', label: 'No' },
];
const CHIP = 'min-h-[44px] rounded-full border px-3.5 text-[13px] font-bold';

interface Props { person: { userId: string; displayName: string } | null; onClose: () => void }

export default function OutcomeSheet({ person, onClose }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [worth, setWorth] = useState<WorthContinuing | null>(null);
  const [picked, setPicked] = useState<OutcomeKey[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (person) { setWorth(null); setPicked([]); setError(null); } }, [person]);

  const save = useMutation({
    mutationFn: () => recordOutcomeRequest(person!.userId, worth!, picked),
    onSuccess: () => {
      addToast(`Saved what happened with ${person!.displayName}`, 'success');
      qc.invalidateQueries({ queryKey: reasonKeys.all });
      onClose();
    },
    onError: (err) => setError(errorMessage(err, 'Could not save that right now.')),
  });

  const toggle = (k: OutcomeKey) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  // Outcomes are a history, so a double tap would store the answer twice.
  const inFlight = useRef(false);
  const submit = () => {
    if (inFlight.current || !worth) return;
    inFlight.current = true;
    save.mutate(undefined, { onSettled: () => { inFlight.current = false; } });
  };

  return (
    <Sheet
      open={!!person}
      onClose={onClose}
      title={person ? `What happened with ${person.displayName}?` : 'What happened?'}
      footer={(
        <>
          <button type="button" onClick={onClose} className="min-h-[44px] rounded-[11px] border border-reason-line px-4 text-[14px] font-bold">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!worth || save.isPending}
            className="min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white disabled:opacity-60"
          >
            {save.isPending ? 'Saving…' : 'Save outcome'}
          </button>
        </>
      )}
    >
      <p className="mt-1 text-[13px] text-reason-muted">This is the moment REASON learns from the real relationship.</p>
      <fieldset className="mt-4">
        <legend className="text-[12px] font-bold">Worth continuing?</legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {WORTH.map((w) => (
            <button
              key={w.key}
              type="button"
              aria-pressed={worth === w.key}
              onClick={() => setWorth(w.key)}
              className={cn(CHIP, worth === w.key ? 'border-reason-red bg-reason-pink text-reason-red' : 'border-reason-line')}
            >
              {w.label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-4">
        <legend className="text-[12px] font-bold">What came from the conversation?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {OUTCOME_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={picked.includes(k)}
              onClick={() => toggle(k)}
              className={cn(CHIP, picked.includes(k) ? 'border-reason-red bg-reason-pink text-reason-red' : 'border-reason-line')}
            >
              {OUTCOME_LABELS[k]}
            </button>
          ))}
        </div>
      </fieldset>
      {error && <p role="alert" className="mt-3 text-[13px] text-reason-red">{error}</p>}
    </Sheet>
  );
}
```

- [ ] **Step 3: Typecheck, commit**

Run: `cd client && npx tsc --noEmit`. Expected: clean.

```bash
git add client/src/features/reason/human/MeetSheet.tsx client/src/features/reason/human/OutcomeSheet.tsx
git commit -m "Meet and What happened sheets" -m "Meet asks 'Why now?' and a preferred format, prefilled with the prototype's own words. What happened asks 'Worth continuing?' and what came from it, exactly as the Foundation lists."
```

---

### Task B6: The Human Profile

**Files:**
- Replace the placeholder: `client/src/features/reason/human/HumanProfilePage.tsx`
- Create: `client/src/features/reason/human/ProfileHero.tsx`
- Create: `client/src/features/reason/human/ProfileDetails.tsx`
- Create: `client/src/features/reason/human/MoveBar.tsx`

**Interfaces:**
- Consumes: `fetchBrief`, `setPersonResponse`, `reasonKeys`, `errorMessage` (B3); `labels.ts` (B3); B1 pieces; B5 sheets; `PersonBrief`, `primaryActionFor`, `OUTCOME_LABELS` (A1).
- Produces: the full-screen route element for `/people/:userId`.

- [ ] **Step 1: The page**

```tsx
// client/src/features/reason/human/HumanProfilePage.tsx
// Stefan's v4 "live relationship brief": full screen, its own header, and a
// bar at the bottom that always offers one useful move.
import { useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { primaryActionFor } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import ReasonMark from '../brand/ReasonMark';
import ReasonSheep from '../brand/ReasonSheep';
import ProfileHero from './ProfileHero';
import ProfileDetails from './ProfileDetails';
import MoveBar from './MoveBar';
import MeetSheet from './MeetSheet';
import OutcomeSheet from './OutcomeSheet';
import { STATE_LABEL } from './labels';
import { errorMessage, fetchBrief, reasonKeys, setPersonResponse } from '../api';

export default function HumanProfilePage() {
  const { userId = '' } = useParams();
  const [params] = useSearchParams();
  const source = (params.get('from') || 'Profile').slice(0, 40);
  const navigate = useNavigate();
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  const [meetOpen, setMeetOpen] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);

  const { data: brief, isLoading, isError } = useQuery({
    queryKey: reasonKeys.brief(userId),
    queryFn: () => fetchBrief(userId),
    enabled: !!userId && !!me && userId !== me,
    retry: false,
    meta: { entities: me && userId ? [E.user(me), E.user(userId), E.userInvites(me), E.userDms(me)] : [] },
  });

  const respond = useMutation({
    mutationFn: (response: 'saved' | 'passed' | null) => setPersonResponse(userId, response),
    onSuccess: (_r, response) => {
      qc.invalidateQueries({ queryKey: reasonKeys.all });
      const name = brief?.person.firstName || brief?.person.displayName || 'They';
      if (response === 'passed') addToast(`${name} will not be suggested in For You. You can undo this here.`, 'info');
      if (response === 'saved') addToast(`${name} saved`, 'success');
    },
    onError: (err) => addToast(errorMessage(err, 'Could not update that right now.'), 'error'),
  });

  if (me && userId === me) return <Navigate to="/profile" replace />;
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/'));

  return (
    <div className="min-h-[100dvh] bg-[#f6f5f3] font-reason text-reason-ink antialiased">
      <header className="sticky top-0 z-[5] flex h-[60px] items-center justify-between gap-3 border-b border-reason-line bg-white/95 pl-[max(11px,env(safe-area-inset-left))] pr-[max(11px,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] backdrop-blur-lg md:h-[70px] md:px-6">
        <div className="flex items-center gap-2.5">
          <button type="button" onClick={back} className="min-h-[44px] rounded-full border border-reason-line bg-white px-3.5 text-[13px] font-extrabold">← Back</button>
          <span className="hidden sm:inline"><ReasonMark variant="mobile" /></span>
        </div>
        {brief && (
          <span className="rounded-full bg-[#f2f3f5] px-2.5 py-1.5 text-[10px] font-extrabold text-[#555d69]">{STATE_LABEL[brief.relationship.state]}</span>
        )}
      </header>

      {isLoading ? (
        <div className="mx-auto grid w-[min(1240px,calc(100%-24px))] gap-3 py-4" aria-busy="true">
          <Skeleton className="h-[40vh]" />
          <Skeleton className="h-40" />
        </div>
      ) : isError || !brief ? (
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-16 text-center">
          <ReasonSheep pose="thinking" className="h-24 w-24" />
          <h1 className="text-[20px] font-bold">This profile is not available.</h1>
          <p className="text-[14px] text-reason-muted">It may have been closed, or it is not open to you.</p>
          <button type="button" onClick={back} className="min-h-[44px] rounded-[11px] bg-reason-red px-4 font-bold text-white">Go back</button>
        </div>
      ) : (
        <>
          <main className="mx-auto w-[min(1240px,calc(100%-24px))] pt-3 pb-[calc(116px+env(safe-area-inset-bottom))] md:w-[min(1240px,calc(100%-44px))] md:pt-6">
            <ProfileHero brief={brief} source={source} />
            <ProfileDetails brief={brief} source={source} onRecordOutcome={() => setOutcomeOpen(true)} />
          </main>
          <MoveBar
            brief={brief}
            busy={respond.isPending}
            onPrimary={() => {
              const action = primaryActionFor(brief.relationship.state);
              if (action === 'meet') setMeetOpen(true);
              else if (action === 'continue') navigate(`/messages/new/${userId}`);
              else if (action === 'respond' && brief.relationship.pokeId) navigate(`/messages?poke=${brief.relationship.pokeId}`);
            }}
            onToggleSave={() => respond.mutate(brief.relationship.saved ? null : 'saved')}
            onTogglePass={() => respond.mutate(brief.relationship.passed ? null : 'passed')}
          />
          <MeetSheet person={meetOpen ? { userId, displayName: brief.person.displayName } : null} onClose={() => setMeetOpen(false)} />
          <OutcomeSheet person={outcomeOpen ? { userId, displayName: brief.person.displayName } : null} onClose={() => setOutcomeOpen(false)} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: The hero (the human and the reason)**

```tsx
// client/src/features/reason/human/ProfileHero.tsx
import type { PersonBrief } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import ReasonSheep from '../brand/ReasonSheep';

const SIGNAL = { strong: 'Strong reason', close: 'Worth exploring' } as const;

// The prototype's own "where you found them" copy, by source.
function sourceLine(source: string, first: string): string {
  if (source === 'For You') return `REASON surfaced ${first} because this relationship looks unusually relevant to what you are trying to make happen now.`;
  if (source === 'People') return `You found ${first} while exploring the wider network. REASON still explains why this person may matter, rather than leaving you with a directory result.`;
  if (source === 'Messages') return 'This profile is the relationship layer behind your conversation. The history, reason and next useful move travel with the message thread.';
  if (source === 'Introductions') return 'This relationship arrived through an introduction. REASON keeps the introducer, reason and outcome as part of the relationship memory.';
  if (source !== 'Profile') return `You encountered ${first} through ${source}. REASON changes the context, not the human: the same person, with a reason specific to where you found them.`;
  return 'REASON explains why this person may matter to you right now.';
}

export default function ProfileHero({ brief, source }: { brief: PersonBrief; source: string }) {
  const p = brief.person;
  const first = p.firstName || p.displayName.split(' ')[0];
  const roleLine = [p.professionalRole.join(', ') || p.jobTitle, p.company].filter(Boolean).join(' · ');
  const tags = [p.industry, ...p.professionalRole].filter((t): t is string => !!t).slice(0, 4);

  return (
    <section className="grid gap-[11px] md:grid-cols-[260px_minmax(0,1fr)] md:gap-[18px] min-[981px]:grid-cols-[320px_minmax(0,1fr)_330px]">
      <div className="relative h-[43vh] min-h-[260px] overflow-hidden rounded-[21px] bg-[#ddd] shadow-[0_16px_50px_rgba(17,18,22,.08)] md:h-auto md:min-h-[430px] md:rounded-[26px]">
        {p.avatarUrl ? (
          // Avatar swaps a photo that fails to load for initials.
          <Avatar src={p.avatarUrl} name={p.displayName} size="2xl" className="h-full w-full rounded-none text-5xl" />
        ) : (
          <div className="grid h-full w-full place-items-center bg-[#eceae6]"><Avatar name={p.displayName} size="2xl" /></div>
        )}
        {brief.match && (
          <span className="absolute left-[18px] top-[18px] flex items-center gap-[7px] rounded-full bg-white px-3 py-2 text-[11px] font-black shadow-[0_8px_24px_rgba(0,0,0,.08)]">
            <i className="h-[7px] w-[7px] rounded-full bg-reason-red" />{SIGNAL[brief.match.strength]}
          </span>
        )}
      </div>

      <section className="flex min-w-0 flex-col rounded-[21px] border border-reason-line bg-white p-[18px] md:rounded-[26px] md:p-7">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#7b8190] md:text-[11px]">The human</p>
        <h1 className="mt-2 text-[40px] font-extrabold leading-[.94] tracking-[-0.055em] [overflow-wrap:anywhere] md:text-[52px]">{p.displayName}</h1>
        {roleLine && <p className="mt-3 text-[15px] text-reason-muted [overflow-wrap:anywhere]">{roleLine}</p>}
        {p.bio && <p className="mt-[17px] max-w-[620px] text-[18px] leading-[1.38] tracking-[-0.024em] md:mt-6 md:text-[21px]">{p.bio}</p>}
        {tags.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-1.5 pt-4 md:pt-6">
            {tags.map((t) => <span key={t} className="rounded-full bg-[#f3f4f6] px-2 py-1.5 text-[10px] text-[#68707e]">{t}</span>)}
          </div>
        )}
        <div className="mt-4 flex items-start gap-3 rounded-[18px] border border-reason-line bg-white p-3.5">
          <ReasonSheep pose="curious" className="h-12 w-12 shrink-0" />
          <div>
            <b className="block text-[12px]">You found {first} through {source}</b>
            <span className="mt-0.5 block text-[11px] leading-snug text-reason-muted">{sourceLine(source, first)}</span>
          </div>
        </div>
      </section>

      <aside className="flex flex-col rounded-[21px] bg-[#111216] p-[18px] text-white shadow-[0_16px_48px_rgba(17,18,22,.12)] md:col-span-2 md:rounded-[26px] md:p-[26px] min-[981px]:col-span-1">
        <p className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-[#b8bbc1] md:text-[11px]">The reason</p>
        <h2 className="mt-3 text-[26px] font-bold leading-[1.04] tracking-[-0.045em] md:text-[29px]">Why you and {first} might matter to each other.</h2>
        <p className="mt-3.5 text-[14px] leading-relaxed text-[#d4d6da]">
          {brief.match?.reason ?? `REASON has not found a clear reason yet. Start with what ${first} can bring.`}
        </p>
        <div className="mt-[18px] grid gap-2.5 md:mt-auto md:pt-[22px]">
          {brief.theyCanBring && (
            <div className="rounded-2xl border border-[#31343a] p-[13px]">
              <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#9ea2aa]">They can bring</span>
              <b className="mt-1.5 block text-[13px] leading-snug">{brief.theyCanBring}</b>
            </div>
          )}
          {brief.youAreLookingFor && (
            <div className="rounded-2xl border border-[#31343a] p-[13px]">
              <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#9ea2aa]">You are looking for</span>
              <b className="mt-1.5 block text-[13px] leading-snug">{brief.youAreLookingFor}</b>
            </div>
          )}
        </div>
      </aside>
    </section>
  );
}
```

- [ ] **Step 3: The detail sections**

```tsx
// client/src/features/reason/human/ProfileDetails.tsx
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { OUTCOME_LABELS, type PersonBrief } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { STATE_LABEL } from './labels';

const WORTH_LABEL = { yes: 'Worth continuing', maybe: 'Maybe worth continuing', no: 'Not worth continuing' } as const;

function Section({ kicker, title, children, className }: { kicker: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-[19px] border border-reason-line bg-white p-[17px] md:rounded-[24px] md:p-6', className)}>
      <h4 className="text-[11px] font-extrabold uppercase tracking-[0.11em]">{kicker}</h4>
      <h3 className="mt-3.5 text-[22px] font-bold tracking-[-0.035em] md:text-[24px]">{title}</h3>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function Timeline({ items }: { items: Array<{ title: string; text: string }> }) {
  return (
    <ul className="grid">
      {items.map((it, i) => (
        <li key={`${it.title}-${i}`} className="relative grid grid-cols-[18px_1fr] gap-2.5 pb-3.5 last:pb-0">
          <span className="mt-[5px] h-[7px] w-[7px] rounded-full bg-reason-red" aria-hidden="true" />
          <span><b className="block text-[12px]">{it.title}</b><span className="mt-[3px] block text-[11px] text-reason-muted">{it.text}</span></span>
        </li>
      ))}
    </ul>
  );
}

interface Props { brief: PersonBrief; source: string; onRecordOutcome: () => void }

export default function ProfileDetails({ brief, source, onRecordOutcome }: Props) {
  const p = brief.person;
  const r = brief.relationship;
  const first = p.firstName || p.displayName.split(' ')[0];
  const role = p.professionalRole.join(', ') || p.jobTitle;
  const { circles, pods, upcomingEvents } = brief.shared;
  const hasPath = !!brief.path || circles.length + pods.length + upcomingEvents.length > 0;
  const last = r.outcomes[0];

  const whyNow = [
    ...(brief.match ? [{ title: brief.match.strength === 'strong' ? 'Strong reason' : 'Worth exploring', text: 'REASON believes this is currently relevant.' }] : []),
    { title: source, text: 'This is the context where you encountered each other.' },
    ...(upcomingEvents[0] ? [{ title: upcomingEvents[0].title, text: 'You will both be there.' }] : []),
  ];

  return (
    <section className="mt-[11px] grid gap-[11px] md:mt-[18px] min-[981px]:grid-cols-[1.15fr_.85fr] min-[981px]:gap-[18px]">
      <Section kicker="Right now" title={`What ${first} is trying to make happen`}>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-[18px] bg-reason-soft p-4">
            <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8b8f96]">Active reasons</p>
            <p className="text-[12px] leading-relaxed text-[#454b55]">{first} has not shared what they are looking for yet.</p>
          </div>
          <div className="rounded-[18px] bg-reason-soft p-4">
            <p className="mb-2.5 text-[10px] font-extrabold uppercase tracking-[0.1em] text-[#8b8f96]">What {first} can bring</p>
            <p className="text-[12px] leading-relaxed text-[#454b55]">{brief.theyCanBring ?? `${first} has not said yet.`}</p>
          </div>
        </div>
      </Section>

      <Section kicker="Your path" title={hasPath ? 'You are not strangers.' : 'No shared path yet.'}>
        <p className="text-[14px] leading-relaxed text-[#505762]">REASON shows the shortest credible path, not a meaningless mutual-connection count.</p>
        {brief.path && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px] font-extrabold">
            <span className="rounded-full bg-[#111216] px-3 py-2 text-white">You</span>
            <span className="text-[#a5a9b0]" aria-hidden="true">→</span>
            <Link to={`/people/${brief.path.id}?from=${encodeURIComponent('Your path')}`} className="flex min-h-[44px] items-center rounded-full border border-reason-line bg-[#f6f5f3] px-3">{brief.path.displayName}</Link>
            <span className="text-[#a5a9b0]" aria-hidden="true">→</span>
            <span className="rounded-full border border-reason-line bg-[#f6f5f3] px-3 py-2">{first}</span>
          </div>
        )}
        {(circles.length > 0 || pods.length > 0 || upcomingEvents.length > 0) && (
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {circles.map((c) => <Link key={c.id} to={`/circles/${c.id}`} className="flex min-h-[44px] items-center rounded-full bg-[#f3f4f6] px-3 text-[12px]">{c.name}</Link>)}
            {pods.map((x) => <Link key={x.id} to={`/pods/${x.id}`} className="flex min-h-[44px] items-center rounded-full bg-[#f3f4f6] px-3 text-[12px]">{x.name}</Link>)}
            {upcomingEvents.map((e) => <Link key={e.id} to={`/sessions/${e.id}`} className="flex min-h-[44px] items-center rounded-full bg-[#f3f4f6] px-3 text-[12px]">{e.title}</Link>)}
          </div>
        )}
      </Section>

      <Section kicker="Entities & roles" title={p.company || 'No organisation shared yet'}>
        {p.company ? (
          <p className="text-[14px] leading-relaxed text-[#505762]">
            {first} is connected to this entity{role ? <> as <strong>{role}</strong></> : null}. REASON uses entity relationships as context, not as a replacement for the human.
          </p>
        ) : (
          <p className="text-[14px] leading-relaxed text-[#505762]">Organisations and roles arrive in the next step of REASON.</p>
        )}
      </Section>

      <Section kicker="The first 20 minutes" title="Skip the small talk." className="border-[#ffd4d0] bg-reason-pink">
        <p className="text-[20px] leading-[1.34] tracking-[-0.03em] text-[#252931] md:text-[24px]">“{brief.opener}”</p>
      </Section>

      <Section kicker="Why now" title="Context creates timing.">
        <Timeline items={whyNow} />
      </Section>

      <Section kicker="Relationship memory" title={r.timesMet > 0 ? `You have met ${r.timesMet} time${r.timesMet === 1 ? '' : 's'}.` : 'You have not met yet.'}>
        <Timeline
          items={[
            { title: STATE_LABEL[r.state], text: r.lastMetAt ? `Last met ${new Date(r.lastMetAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}.` : 'No meeting recorded yet.' },
            ...(last ? [{ title: WORTH_LABEL[last.worthContinuing], text: last.outcomes.length ? last.outcomes.map((k) => OUTCOME_LABELS[k]).join(', ') : 'Nothing noted.' }] : []),
          ]}
        />
        {(r.state === 'connected' || r.state === 'met') && (
          <button type="button" onClick={onRecordOutcome} className="mt-3.5 min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[13px] font-bold text-white">Record what happened</button>
        )}
      </Section>

      <Section kicker="What happens next" title="One useful move.">
        <p className="text-[14px] leading-relaxed text-[#505762]">REASON does not want you living on the profile. Meet, continue, save, or pass. The relationship state should move.</p>
      </Section>
    </section>
  );
}
```

- [ ] **Step 4: The move bar**

```tsx
// client/src/features/reason/human/MoveBar.tsx
import { primaryActionFor, type PersonBrief } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { NEXT_MOVE, PRIMARY_LABEL, STATE_LABEL } from './labels';

interface Props {
  brief: PersonBrief;
  busy: boolean;
  onPrimary: () => void;
  onToggleSave: () => void;
  onTogglePass: () => void;
}

export default function MoveBar({ brief, busy, onPrimary, onToggleSave, onTogglePass }: Props) {
  const r = brief.relationship;
  const action = primaryActionFor(r.state);
  const inert = action === 'requested' || action === 'declined';
  return (
    <footer className="fixed inset-x-0 bottom-0 z-[96] border-t border-reason-line bg-white/95 backdrop-blur-lg">
      <div className="mx-auto flex w-full items-center justify-between gap-3.5 px-[11px] pt-[9px] pb-[calc(9px+env(safe-area-inset-bottom))] md:w-[min(1240px,calc(100%-44px))] md:px-0 md:py-3">
        <div className="hidden min-w-0 md:block">
          <b className="block text-[13px]">{STATE_LABEL[r.state]}</b>
          <span className="text-[11px] text-reason-muted">{r.passed ? 'You passed on this person for now.' : NEXT_MOVE[r.state]}</span>
        </div>
        <div className="grid w-full grid-cols-[1fr_48px_48px] gap-2 md:flex md:w-auto">
          <button
            type="button"
            onClick={onPrimary}
            disabled={inert || busy}
            className={cn('min-h-[48px] rounded-[11px] px-5 text-[14px] font-bold',
              inert ? 'bg-[#f5f6f7] text-[#6d7380]' : 'bg-reason-red text-white shadow-[0_7px_18px_rgba(222,50,46,.18)]')}
          >
            {PRIMARY_LABEL[action]}
          </button>
          <button
            type="button"
            onClick={onToggleSave}
            disabled={busy}
            aria-pressed={r.saved}
            aria-label={r.saved ? 'Remove from saved' : 'Save'}
            className="grid min-h-[48px] min-w-[48px] place-items-center rounded-[11px] border border-reason-line bg-white text-[18px]"
          >
            {r.saved ? '★' : '☆'}
          </button>
          <button
            type="button"
            onClick={onTogglePass}
            disabled={busy}
            aria-pressed={r.passed}
            aria-label={r.passed ? 'Undo pass' : 'Pass: not relevant right now'}
            className="grid min-h-[48px] min-w-[48px] place-items-center rounded-[11px] border border-reason-line bg-white text-[18px]"
          >
            {r.passed ? '↺' : '×'}
          </button>
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 5: Typecheck, the privacy and realtime guards, look at it, commit**

Run: `cd client && npx tsc --noEmit && cd ../server && npx jest src/__tests__/client src/__tests__/services/phase-may19-realtime-migration-phase6.test.ts --coverage=false`
Expected: clean, and PASS.

Look at the page locally, from a card and by direct link, at 360, 390, 768, 1024 and 1440. Fix any overlap before committing.

```bash
git add client/src/features/reason/human
git commit -m "The Human Profile: a live relationship brief" -m "Who they are, why you might matter to each other, what they can bring, your path and shared contexts, the first 20 minutes, the relationship's memory, and one move at the bottom: Meet or Continue, Save, or Pass. A blocked or closed profile says it is not available."
```

---

### Task B7: Prove it on the preview, on every screen size

**Files:**
- Create: `e2e/tests/reason-m1.spec.ts`

- [ ] **Step 1: Push the branch so Vercel builds the preview**

Run the full pre-flight first (the `staging` CI does not run on feature branches):

```bash
npm run build:shared && (cd server && npx jest) && (cd client && npx tsc --noEmit)
git push -u origin reason-m1
```

Wait for the Vercel preview for the branch to be READY. Read its branch alias (the `…-git-reason-m1-….vercel.app` URL) from the Vercel MCP `list_deployments` for project `rsn-client`, or from the commit's Vercel status on GitHub. Mint a share token for it with the Vercel MCP `get_access_to_vercel_url`. Then, in the shell that runs the tests:

```bash
export E2E_APP_URL=<the branch alias URL>
export E2E_VERCEL_SHARE=<the share token>
```

The share token dies on every push, so mint a new one after each push.

- [ ] **Step 2: Write the spec**

```ts
// e2e/tests/reason-m1.spec.ts
// Milestone 1 on the preview (29 Sep 2026): the shell, For You, the Human Card
// and the Human Profile, driven by clicks, at every size Stefan's checklist
// names, on production data with throwaway users.
import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { createTestUser, TestUser, pool } from '../helpers/auth';
import { gotoRetry, cleanup, APP } from '../helpers/live-ui';
import { primePreview } from '../helpers/preview-bypass';
import { launchBrowser, engineLabel } from '../helpers/engine';
import { expectReachable } from '../helpers/viewport-fit';

const SIZES: Array<[number, number]> = [[360, 780], [390, 844], [430, 932], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]];
let browser: Browser;
const ctxs: BrowserContext[] = [];
const made: string[] = [];
const run = Date.now().toString(36);
const LONG_NAME = `Maximilian Alexander Konstantin Bartholomew-Worthington ${run}`;
let viewer: TestUser, longName: TestUser, secretive: TestUser, giver: TestUser, met: TestUser, blocked: TestUser;
const pageErrors: string[] = [];

async function openAs(u: TestUser, path: string, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t: { a: string; r: string }) => {
    localStorage.setItem('rsn_access', t.a);
    localStorage.setItem('rsn_refresh', t.r);
    localStorage.setItem('rsn_tokens', JSON.stringify({ access: t.a, refresh: t.r }));
  }, { a: u.accessToken, r: u.refreshToken });
  ctxs.push(ctx);
  await primePreview(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await gotoRetry(page, `${APP}${path}`);
  return page;
}

test.beforeAll(async () => {
  browser = await launchBrowser();
  // Three made-up words only the test people share, and no job-category word
  // ("specialists" is a category the matcher gives every analyst on the
  // network, which would rank real members above the test people). Three
  // strong test matches means For You shows exactly them: no real member is
  // ever shown to this viewer, let alone clicked.
  const words = `zq${run} wx${run} vk${run}`;
  viewer = await createTestUser('m1-viewer'); made.push(viewer.id);
  longName = await createTestUser('m1-long'); made.push(longName.id);
  secretive = await createTestUser('m1-secret'); made.push(secretive.id);
  giver = await createTestUser('m1-giver'); made.push(giver.id);
  met = await createTestUser('m1-met'); made.push(met.id);
  blocked = await createTestUser('m1-blocked'); made.push(blocked.id);

  await pool.query(`UPDATE users SET who_i_want_to_meet = $1, first_name = 'Vera' WHERE id = $2`, [words, viewer.id]);
  await pool.query(`UPDATE users SET expertise_text = $1, avatar_url = NULL, display_name = $2 WHERE id = $3`,
    [words, LONG_NAME, longName.id]);
  await pool.query(`UPDATE users SET expertise_text = $1, who_i_want_to_meet = $2, display_name = $3 WHERE id = $4`,
    [words, `secret-want-${run}`, `Sofia Secret ${run}`, secretive.id]);
  await pool.query(`UPDATE users SET expertise_text = $1, what_i_can_help_with = $2, display_name = $3 WHERE id = $4`,
    [words, 'Introductions to seed investors', `Gil Giver ${run}`, giver.id]);
  const [a, b] = viewer.id < met.id ? [viewer.id, met.id] : [met.id, viewer.id];
  await pool.query(`INSERT INTO encounter_history (id, user_a_id, user_b_id, times_met, last_met_at) VALUES (gen_random_uuid(), $1, $2, 1, NOW())`, [a, b]);
  await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [`Mia Met ${run}`, met.id]);
  await pool.query(`INSERT INTO user_blocks (id, blocker_id, blocked_id) VALUES (gen_random_uuid(), $1, $2)`, [blocked.id, viewer.id]);
});

test.afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => undefined);
  await browser?.close();
  if (made.length) await cleanup(pool, { ids: made });
});

for (const [width, height] of SIZES) {
  test(`${engineLabel()} ${width}px: shell and For You fit, nothing private leaks`, async () => {
    const page = await openAs(viewer, '/', { width, height });
    const card = page.locator(`[data-person-id="${giver.id}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(await page.locator('[data-person-id]').count()).toBeLessThanOrEqual(5);
    await expect(page.locator('body')).not.toContainText(`secret-want-${run}`);

    if (width <= 720) {
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    } else {
      const icons = page.locator('aside nav a svg');
      expect(await icons.count()).toBe(8);
      const box = await icons.first().boundingBox();
      expect(box && box.width > 0).toBeTruthy();
    }

    for (const name of [/^(Meet|Request sent|Continue)$/, /^(Save|Saved)$/]) {
      const button = card.getByRole('button', { name });
      // Centre it first: a lower card sits below the fold on phones. The check
      // then also fails if the fixed bottom bar covers the button.
      await button.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const box = await expectReachable(page, button, `${String(name)} at ${width}px`);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const longCard = page.locator(`[data-person-id="${longName.id}"]`);
    const lb = await longCard.boundingBox();
    expect(lb && lb.x + lb.width <= width + 1).toBeTruthy();
  });
}

test(`${engineLabel()} phone: Save persists, Pass hides, Meet sends one request with note and format`, async () => {
  test.setTimeout(180_000);
  const page = await openAs(viewer, '/', { width: 390, height: 844 });
  const giverCard = page.locator(`[data-person-id="${giver.id}"]`);
  await expect(giverCard).toBeVisible({ timeout: 30_000 });

  await giverCard.getByRole('button', { name: 'Save' }).click();
  await expect(giverCard.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.reload();
  await expect(page.locator(`[data-person-id="${giver.id}"]`).getByRole('button', { name: 'Saved' })).toBeVisible({ timeout: 30_000 });

  // Pass from the Human Profile.
  await page.locator(`[data-person-id="${secretive.id}"]`).getByRole('link', { name: `Sofia Secret ${run}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: `Sofia Secret ${run}` })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(`secret-want-${run}`);
  await page.getByRole('button', { name: 'Pass: not relevant right now' }).click();
  await expect(page.getByRole('button', { name: 'Undo pass' })).toBeVisible();
  await page.getByRole('button', { name: '← Back' }).click();
  await page.reload();
  await expect(page.locator(`[data-person-id="${giver.id}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`[data-person-id="${secretive.id}"]`)).toHaveCount(0);
  const passed = await pool.query(`SELECT response FROM person_responses WHERE user_id = $1 AND target_user_id = $2`, [viewer.id, secretive.id]);
  expect(passed.rows[0]?.response).toBe('passed');

  // Meet, with a double press on Send.
  await page.locator(`[data-person-id="${longName.id}"]`).getByRole('button', { name: 'Meet', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('textbox').fill(`Hello from the preview ${run}`);
  await sheet.getByRole('combobox').selectOption('coffee');
  await sheet.getByRole('button', { name: 'Send request' }).dblclick();
  await expect(page.locator(`[data-person-id="${longName.id}"]`).getByRole('button', { name: 'Request sent' })).toBeVisible({ timeout: 15_000 });
  const pokes = await pool.query(`SELECT message, preferred_format FROM user_pokes WHERE sender_id = $1 AND recipient_id = $2`, [viewer.id, longName.id]);
  expect(pokes.rows).toHaveLength(1);
  expect(String(pokes.rows[0].message).startsWith(`Hello from the preview ${run}`)).toBe(true);
  expect(pokes.rows[0].preferred_format).toBe('coffee');
});

test(`${engineLabel()} phone: record what happened, blocked profile, More sheet, error state`, async () => {
  test.setTimeout(180_000);
  const page = await openAs(viewer, `/people/${met.id}?from=Messages`, { width: 390, height: 844 });
  await expect(page.getByText('You have met 1 time.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Record what happened' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Yes', exact: true }).click();
  await sheet.getByRole('button', { name: 'Introduction', exact: true }).click();
  await sheet.getByRole('button', { name: 'Save outcome' }).click();
  await expect(page.getByText('Worth continuing', { exact: true })).toBeVisible({ timeout: 15_000 });
  const outcome = await pool.query(`SELECT worth_continuing, outcome_keys FROM meeting_outcomes WHERE user_id = $1 AND target_user_id = $2`, [viewer.id, met.id]);
  expect(outcome.rows[0]).toMatchObject({ worth_continuing: 'yes', outcome_keys: ['introduction'] });

  await gotoRetry(page, `${APP}/people/${blocked.id}`);
  await expect(page.getByText('This profile is not available.')).toBeVisible({ timeout: 15_000 });

  await gotoRetry(page, `${APP}/`);
  await page.getByRole('button', { name: 'More' }).click();
  const more = page.getByRole('dialog', { name: 'More' });
  for (const label of ['Entities', 'Circles', 'Pods', 'Introductions', 'Settings', 'Support']) {
    await expect(more.getByRole('link', { name: label })).toBeVisible();
  }
  await more.getByRole('link', { name: 'Circles' }).click();
  await expect(page).toHaveURL(/\/circles$/);

  await page.route('**/api/matches/platform', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"success":false}' }));
  await gotoRetry(page, `${APP}/`);
  await expect(page.getByText('We could not load your people just now.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

  expect(pageErrors).toEqual([]);
});
```

- [ ] **Step 3: Run it in Chromium and WebKit, headed**

```bash
cd e2e
npx playwright test tests/reason-m1.spec.ts
E2E_ENGINE=webkit npx playwright test tests/reason-m1.spec.ts
```

Both runs are headed by default (`E2E_HEADED=0` makes them headless). They read `E2E_APP_URL` and `E2E_VERCEL_SHARE` from Step 1.

Expected: all tests pass in both engines (8 size checks plus 2 flows, per engine).

Any failure is a lead, not flake: read the first failure, check the real page, fix the root cause, push, mint a new token, and rerun.

- [ ] **Step 4: The screenshot sweep for Ali and Stefan**

For every size in `SIZES`, capture For You, the Human Profile (top and bottom), the More sheet (phones), the Meet sheet and the rail/sidebar. Save them under `workspace/scratch/2026-10-reason-m1-shots/`. Open each and look for:
- overlaps;
- clipped text;
- the sheep placement;
- that the logo is the official mark.

List anything not verifiable here in the report (for example, a real iPhone's home bar).

- [ ] **Step 5: Commit the spec**

```bash
git add e2e/tests/reason-m1.spec.ts
git commit -m "E2E: milestone 1 on the preview at every screen size"
git push
```

---

### Task B8: The stable preview address and the handoff to Stefan

**Files:** none in the repo. This task is DNS and Vercel configuration, and each step needs Ali's go.

- [ ] **Step 1 (Vercel, with Ali's go): point preview.rsn.network at the branch**

In the Vercel project `rsn-client`, open Settings → Domains and add `preview.rsn.network` with Git branch `reason-m1`. Vercel then shows the exact CNAME target.

The Vercel MCP `add_project_domain` with `gitBranch: "reason-m1"` does the same.

- [ ] **Step 2 (Ali, GoDaddy): add the DNS record**

rsn.network's DNS is at GoDaddy (`ns67/ns68.domaincontrol.com`). In GoDaddy DNS for `rsn.network`, add a CNAME record:
- Name: `preview`
- Value: the target Vercel shows (for comparison, `app` points at `ce5fad04b21c0774.vercel-dns-017.com`)
- TTL: 1 hour

- [ ] **Step 3: Verify the address**

```powershell
Resolve-DnsName preview.rsn.network
curl.exe -sI https://preview.rsn.network
```

Expected:
- The name resolves to Vercel.
- The response is HTTP 200 with the app's HTML, not a Vercel login page. Custom domains are outside the "all except custom domains" protection.

Then sign in on `https://preview.rsn.network/login` with an email link. It opens on preview.rsn.network, which the live-fixes plan's Task 1 allows. Google sign-in ends on the live app, so tell Stefan to use the email link.

- [ ] **Step 4: Rerun the spec on the stable address**

```bash
cd e2e && E2E_APP_URL=https://preview.rsn.network E2E_VERCEL_SHARE= npx playwright test tests/reason-m1.spec.ts
```

Expected: all pass.

- [ ] **Step 5: Record and hand over**

1. Add a `progress.md` entry on `main` (a separate "progress:" commit) with:
   - what shipped dark (Part A with its SHA);
   - the branch and preview address;
   - test counts;
   - E2E results per engine and size;
   - a "Not verified here" list (a physical iPhone and Android, real Stefan data).
2. Give Ali the test script, then the message for Stefan. It says the link is ready, to sign in with the email link, and that actions there are real (Meet sends a real request).
3. Do not merge `reason-m1` into `main` until Stefan approves. After approval, a separate plan covers:
   - retiring `AppLayout`/`HomePage`;
   - updating the source pins and the prod E2E specs that assert the old shell (`wave12-edge-cases`, `first-agent`, `matching-agents`, `search`, `onboarding-tour`);
   - the next screens.
