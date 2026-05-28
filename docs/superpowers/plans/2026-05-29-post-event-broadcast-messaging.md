# Post-Event Broadcast Messaging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After any completed event, an authorized user clicks one button and every participant receives a tailored 1:1 DM (thanking them + asking what went wrong), based on what they actually did in the event — delivered durably and idempotently at any scale.

**Architecture:** A durable DB-backed job (`post_event_message_jobs` + `post_event_message_recipients`) created by a REST endpoint, drained by a background worker holding a Redis lock. Each recipient is classified into one of four buckets from their participation record, a template is filled, and the message is sent through a broadcast seam in the DM service that bypasses the mutual-match gate (authorization is enforced once at job-creation time). Sending reuses the existing `broadcastDmMessage` fan-out (socket + bell notification + offline email). v1 is enabled for admins/super-admins only; the authorization layer already recognizes Pro users and pod directors so enabling them later is a flag flip, not a rewrite. The client shows a working button to admins and a disabled "Pro – coming soon" button to hosts/directors.

**Tech Stack:** Node/Express + TypeScript (server), `pg` (Neon Postgres), ioredis (Upstash), Socket.IO, React + Vite + Tailwind + react-query + zustand (client), Jest (server tests), Playwright (E2E).

---

## Conventions discovered in audit (use these exactly)

- **Roles:** `UserRole` enum in `shared/src/types/user.ts` — `SUPER_ADMIN, ADMIN, HOST, FOUNDING_MEMBER, PRO, MEMBER, FREE`; `hasRoleAtLeast(subjectRole, requiredRole)`.
- **RBAC middleware:** `requireRole(...roles)` in `server/src/middleware/rbac.ts`; `authenticate` in `server/src/middleware/auth.ts`. `req.user` carries `{ userId, role }`.
- **DB access:** `import { query, transaction } from '../../db'` (server). `query<T>(sql, params)`.
- **Redis:** `import { getRedisClient } from '../redis/redis.client'` → `Redis | null`.
- **DM send:** `dmService.sendMessage(fromUserId, toUserId, content, attachment?)` → `{ message, conversationId }` (validates + `canMessage` gate + upserts conversation + inserts message). `broadcastDmMessage(io, fromUserId, toUserId, conversationId, message)` does socket + bell + offline-email fan-out.
- **Mutual gate:** `canMessage()` in `server/src/services/dm/dm.service.ts:110-165` — only `admin`/`super_admin` (literal `users.role`) bypass; grandfather rule allows once a thread has ≥1 message.
- **Participants:** `sessionService.getSessionParticipants(sessionId)` → rows with `userId, status, joinedAt, leftAt, roundsCompleted, displayName, email`.
- **Socket from a route:** `const io = req.app.get('io') as SocketServer | null`.
- **Background worker pattern:** `setInterval` in `server/src/index.ts:378-390` (see `processAutoReminders`).
- **Migrations:** `server/src/db/migrations/NNN_snake_case.sql`, wrapped in `BEGIN; … COMMIT;`. Next number is **065**.
- **Client role check:** `isAdmin(role)` in `client/src/lib/utils.ts`; auth store `client/src/stores/authStore.ts` (`user.role`, `user.id`). API: `client/src/lib/api.ts` (axios). UI: `components/ui/Button.tsx`, `components/ui/Modal.tsx`, toast via `stores/toastStore.ts` (`addToast(msg, 'success'|'error'|'info')`). Brand red `#DE322E` / Tailwind `rsn-red`.
- **Event/recap pages:** `client/src/features/sessions/SessionDetailPage.tsx` (`isHost`, `isAdmin` at lines 110-111; action menu 512-557) and `RecapPage.tsx` (header actions 287-299).

> **User-facing language:** say **"event"**, never "session", in any string a participant or host sees.

---

## Participation buckets (single source of truth)

Derived from each participant's record. The `is_no_show` column is unreliable (audit confirmed people with 7–10 rounds flagged true) — **do not use it**. Classify by `roundsCompleted` + `joinedAt`:

| Bucket key | Rule | Template intent |
|---|---|---|
| `stayed` | `roundsCompleted >= 1` AND `joinedAt` set AND (`leftAt` null OR `leftAt` within 120s of event `endedAt`) | Thank for staying through; ask what was clunky |
| `left_early` | `roundsCompleted >= 1` AND `leftAt` set more than 120s before event `endedAt` | Acknowledge they left partway; ask why |
| `could_not_join` | `joinedAt` set AND `roundsCompleted == 0` | Apologize they couldn't get into conversations; ask what broke |
| `no_show` | `joinedAt` null (never connected) | "Sorry we missed you"; ask what got in the way |

Internal accounts are excluded by user id (the event host + any `super_admin`/`admin` whose email is in the internal set). Exclusion is by **role + the event's own host**, computed at job-creation time.

---

## File Structure

**Server — new files**
- `server/src/db/migrations/065_post_event_message_jobs.sql` — two tables + enums + indexes.
- `server/src/services/post-event-message/classify.ts` — pure bucket classifier (no DB).
- `server/src/services/post-event-message/templates.ts` — bucket → message builder (pure).
- `server/src/services/post-event-message/broadcast-eligibility.ts` — `canBroadcastToEvent(userId, sessionId)` (the scalable gate seam).
- `server/src/services/post-event-message/post-event-message.service.ts` — create job, enqueue recipients, status, preview.
- `server/src/services/post-event-message/post-event-message.worker.ts` — durable drain worker (Redis lock + batch send).
- `server/src/routes/post-event-message.ts` — REST endpoints.

**Server — modified files**
- `server/src/services/dm/dm.service.ts` — add `sendBroadcastMessage()` seam (skips `canMessage`).
- `server/src/index.ts` — register the worker `setInterval` next to `processAutoReminders`.
- `server/src/app.ts` (or wherever routers mount; confirm during Task) — mount `post-event-message` router.

**Shared**
- `shared/src/types/post-event-message.ts` — DTOs + enums; export from `shared/src/index.ts`.

**Client — new files**
- `client/src/features/sessions/MessageParticipantsButton.tsx` — button + coming-soon + confirm modal + status.
- `client/src/features/sessions/usePostEventMessage.ts` — react-query hooks (status, preview, send).

**Client — modified files**
- `client/src/features/sessions/SessionDetailPage.tsx` — render the button for completed events.

**Tests**
- `server/src/__tests__/services/post-event-message/classify.test.ts`
- `server/src/__tests__/services/post-event-message/templates.test.ts`
- `server/src/__tests__/services/post-event-message/broadcast-eligibility.test.ts`
- `server/src/__tests__/services/post-event-message/service.test.ts`
- `server/src/__tests__/services/post-event-message/worker.test.ts`
- `e2e/tests/post-event-message.spec.ts`

---

## Phase 1 — Database

### Task 1: Migration for job + recipient tables

**Files:**
- Create: `server/src/db/migrations/065_post_event_message_jobs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Migration 065: Post-Event Broadcast Messaging
-- A durable job per (event, send) and one tracked row per recipient so the
-- worker is idempotent and survives restarts. Per-recipient UNIQUE(job,user)
-- plus status make double-sends impossible.

BEGIN;

CREATE TYPE post_event_message_job_status AS ENUM (
  'pending', 'processing', 'completed', 'completed_with_errors', 'failed'
);
CREATE TYPE post_event_message_recipient_status AS ENUM (
  'pending', 'sent', 'failed', 'skipped'
);
CREATE TYPE post_event_message_bucket AS ENUM (
  'stayed', 'left_early', 'could_not_join', 'no_show'
);

CREATE TABLE post_event_message_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES users(id),
  status          post_event_message_job_status NOT NULL DEFAULT 'pending',
  total_recipients   INTEGER NOT NULL DEFAULT 0,
  sent_count         INTEGER NOT NULL DEFAULT 0,
  failed_count       INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

-- Only one active (non-terminal) job per event at a time. Terminal jobs may
-- coexist historically; partial unique index enforces the live-singleton rule.
CREATE UNIQUE INDEX uniq_active_job_per_session
  ON post_event_message_jobs(session_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX idx_pem_jobs_status ON post_event_message_jobs(status);
CREATE INDEX idx_pem_jobs_session ON post_event_message_jobs(session_id);

CREATE TABLE post_event_message_recipients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES post_event_message_jobs(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket          post_event_message_bucket NOT NULL,
  status          post_event_message_recipient_status NOT NULL DEFAULT 'pending',
  message_id      UUID,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ,
  UNIQUE(job_id, user_id)
);

CREATE INDEX idx_pem_recipients_job ON post_event_message_recipients(job_id);
CREATE INDEX idx_pem_recipients_pending
  ON post_event_message_recipients(job_id) WHERE status = 'pending';

COMMIT;
```

- [ ] **Step 2: Apply against a scratch/staging DB and verify** (NEVER prod directly)

Run (using a non-prod `DATABASE_URL`): `npm run db:migrate --workspace=server`
Expected: migration 065 applies; `\d post_event_message_jobs` shows the table. If no scratch DB is available, ask the user before touching the Neon prod branch — migrations here are additive + reversible but still confirm per RajaSkill Phase 4.2.

- [ ] **Step 3: Commit**

```bash
git add server/src/db/migrations/065_post_event_message_jobs.sql
git commit -m "Add post-event broadcast messaging tables"
```

---

## Phase 2 — Shared types

### Task 2: DTOs and enums

**Files:**
- Create: `shared/src/types/post-event-message.ts`
- Modify: `shared/src/index.ts` (add `export * from './types/post-event-message';`)

- [ ] **Step 1: Write the types**

```typescript
// Post-Event Broadcast Messaging — shared DTOs.

export type PostEventMessageBucket =
  | 'stayed' | 'left_early' | 'could_not_join' | 'no_show';

export type PostEventMessageJobStatus =
  | 'pending' | 'processing' | 'completed' | 'completed_with_errors' | 'failed';

/** Why the current user can (or cannot yet) use the feature on an event. */
export interface BroadcastEligibility {
  /** True when the button should perform a real send (admins in v1). */
  enabled: boolean;
  /** True when the button should be shown at all (admins + hosts/directors). */
  visible: boolean;
  /** Machine reason for the disabled/coming-soon state. */
  reason: 'admin' | 'pro_coming_soon' | 'director_coming_soon' | 'not_allowed';
}

export interface PostEventMessageBucketCount {
  bucket: PostEventMessageBucket;
  count: number;
}

/** Returned by the dry-run preview: who would get messaged, grouped. */
export interface PostEventMessagePreview {
  sessionId: string;
  totalRecipients: number;
  buckets: PostEventMessageBucketCount[];
}

/** Returned by status endpoint and by create. */
export interface PostEventMessageJob {
  id: string;
  sessionId: string;
  status: PostEventMessageJobStatus;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
}
```

- [ ] **Step 2: Build shared to confirm no type errors**

Run: `npm run build:shared`
Expected: success, `dist` updated.

- [ ] **Step 3: Commit**

```bash
git add shared/src/types/post-event-message.ts shared/src/index.ts
git commit -m "Add shared types for post-event messaging"
```

---

## Phase 3 — Pure logic (classifier + templates)

### Task 3: Participation classifier

**Files:**
- Create: `server/src/services/post-event-message/classify.ts`
- Test: `server/src/__tests__/services/post-event-message/classify.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { classifyParticipant } from '../../../services/post-event-message/classify';

const END = new Date('2026-05-27T13:39:00Z');

describe('classifyParticipant', () => {
  const base = { joinedAt: new Date('2026-05-27T13:00:00Z'), leftAt: null as Date | null, roundsCompleted: 0 };

  it('stayed: rounds>=1 and present at end', () => {
    expect(classifyParticipant({ ...base, roundsCompleted: 6, leftAt: END }, END)).toBe('stayed');
  });
  it('stayed: rounds>=1 and leftAt null', () => {
    expect(classifyParticipant({ ...base, roundsCompleted: 6, leftAt: null }, END)).toBe('stayed');
  });
  it('left_early: rounds>=1 but left >120s before end', () => {
    const left = new Date('2026-05-27T13:21:00Z'); // 18 min before end
    expect(classifyParticipant({ ...base, roundsCompleted: 4, leftAt: left }, END)).toBe('left_early');
  });
  it('could_not_join: joined but 0 rounds', () => {
    expect(classifyParticipant({ ...base, roundsCompleted: 0, leftAt: END }, END)).toBe('could_not_join');
  });
  it('no_show: never joined', () => {
    expect(classifyParticipant({ joinedAt: null, leftAt: null, roundsCompleted: 0 }, END)).toBe('no_show');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test --workspace=server -- classify.test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import type { PostEventMessageBucket } from '@rsn/shared';

export interface ParticipationInput {
  joinedAt: Date | null;
  leftAt: Date | null;
  roundsCompleted: number;
}

const END_GRACE_MS = 120_000; // within 2 min of event end == "stayed to the end"

export function classifyParticipant(
  p: ParticipationInput,
  eventEndedAt: Date | null,
): PostEventMessageBucket {
  if (!p.joinedAt) return 'no_show';
  if (p.roundsCompleted < 1) return 'could_not_join';
  if (p.leftAt && eventEndedAt) {
    const gap = eventEndedAt.getTime() - p.leftAt.getTime();
    if (gap > END_GRACE_MS) return 'left_early';
  }
  return 'stayed';
}
```

- [ ] **Step 4: Run, verify pass.** Run: `npm test --workspace=server -- classify.test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/post-event-message/classify.ts server/src/__tests__/services/post-event-message/classify.test.ts
git commit -m "Add participation classifier for post-event messaging"
```

### Task 4: Message templates

**Files:**
- Create: `server/src/services/post-event-message/templates.ts`
- Test: `server/src/__tests__/services/post-event-message/templates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { buildMessage } from '../../../services/post-event-message/templates';

describe('buildMessage', () => {
  const ctx = { firstName: 'Ian', eventTitle: 'The 1st big test of reason', eventDate: 'Tuesday, 27 May 2026', senderName: 'Stefan' };

  it('fills first name, event and date into the stayed template', () => {
    const msg = buildMessage('stayed', ctx);
    expect(msg).toContain('Ian');
    expect(msg).toContain('The 1st big test of reason');
    expect(msg).toContain('Tuesday, 27 May 2026');
    expect(msg.length).toBeGreaterThan(40);
  });

  it('produces distinct copy per bucket', () => {
    const buckets = ['stayed','left_early','could_not_join','no_show'] as const;
    const msgs = buckets.map(b => buildMessage(b, ctx));
    expect(new Set(msgs).size).toBe(4);
  });

  it('falls back to "there" when first name missing', () => {
    expect(buildMessage('stayed', { ...ctx, firstName: '' })).toContain('Hi there');
  });
});
```

- [ ] **Step 2: Run, verify fail.** `npm test --workspace=server -- templates.test` → FAIL.

- [ ] **Step 3: Implement** (copy approved in the Stefan brief; "event" not "session")

```typescript
import type { PostEventMessageBucket } from '@rsn/shared';

export interface TemplateContext {
  firstName: string;
  eventTitle: string;
  eventDate: string;
  senderName: string;
}

export function buildMessage(bucket: PostEventMessageBucket, ctx: TemplateContext): string {
  const hi = `Hi ${ctx.firstName && ctx.firstName.trim() ? ctx.firstName.trim() : 'there'},`;
  const ev = `${ctx.eventTitle} on ${ctx.eventDate}`;
  const sign = `— ${ctx.senderName}`;
  switch (bucket) {
    case 'stayed':
      return [hi,
        `Thank you for being part of ${ev}. You stayed with us right through to the end and met a good few people, which is exactly what we hoped for.`,
        `Since we're always improving, I'd love your honest take. What worked, what felt clunky, or anything that got in your way? Just reply here and tell me.`,
        `Thanks again for giving it a go. ${sign}`].join('\n\n');
    case 'left_early':
      return [hi,
        `Thank you for joining ${ev}. You got a few conversations in before you had to head off partway through, and I'm glad you came.`,
        `I'd genuinely like to know what made you leave — whether something wasn't working, the format, the timing, or just life. Just reply here and tell me. It helps us make the next one better.`,
        sign].join('\n\n');
    case 'could_not_join':
      return [hi,
        `Thank you for coming to ${ev}. It looks like you weren't able to get into the conversations once things got going, and I'm sorry about that.`,
        `Would you tell me what happened on your end — what you saw on your screen, where it got stuck? Just reply here. I'd really like to make the next one work for you.`,
        sign].join('\n\n');
    case 'no_show':
      return [hi,
        `Thank you for signing up for ${ev}. It looks like you didn't get the chance to take part, and I'm sorry we missed you.`,
        `If anything got in the way — the timing, something technical, or the joining process — I'd love to hear it. Just reply here. I hope to have you at the next one.`,
        sign].join('\n\n');
  }
}
```

- [ ] **Step 4: Run, verify pass.** → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/post-event-message/templates.ts server/src/__tests__/services/post-event-message/templates.test.ts
git commit -m "Add per-bucket message templates"
```

---

## Phase 4 — Broadcast send seam (DM service)

### Task 5: `sendBroadcastMessage` that bypasses the mutual gate

**Files:**
- Modify: `server/src/services/dm/dm.service.ts` (add a new exported function near `sendMessage`, reusing the same conversation-upsert + insert transaction; do NOT call `canMessage`).
- Test: `server/src/__tests__/services/post-event-message/service.test.ts` (gate-bypass unit; see note)

> **Why:** authorization is enforced once at job-creation (`canBroadcastToEvent`). The per-message send must not re-run the mutual-match gate, or pod-directors/Pro users (future) and even admins-to-strangers would be blocked. Admins already bypass `canMessage`, so v1 behavior is unchanged; this seam is what makes the feature scalable to non-admin senders without editing the gate.

- [ ] **Step 1: Write the failing test** (asserts the function exists and inserts a message + conversation regardless of encounter history)

```typescript
import * as dm from '../../../services/dm/dm.service';

it('sendBroadcastMessage is exported and accepts (from,to,content)', () => {
  expect(typeof dm.sendBroadcastMessage).toBe('function');
  expect(dm.sendBroadcastMessage.length).toBeGreaterThanOrEqual(3);
});
```

- [ ] **Step 2: Run, verify fail.** → FAIL.

- [ ] **Step 3: Implement** — extract the existing insert transaction in `sendMessage` (lines 232-293) into a private `insertDirectMessage(fromUserId, toUserId, content)` helper, then:

```typescript
/**
 * Send a DM as part of an authorized broadcast. Skips canMessage() because the
 * caller (post-event-message job creation) has already authorized the sender
 * for this audience. Still validates content length. Returns the same shape as
 * sendMessage so the caller can broadcast via broadcastDmMessage().
 */
export async function sendBroadcastMessage(
  fromUserId: string,
  toUserId: string,
  content: string,
): Promise<{ message: DmMessage; conversationId: string }> {
  if (fromUserId === toUserId) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'You cannot DM yourself');
  }
  const trimmed = (content ?? '').trim();
  if (trimmed.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Message cannot be empty');
  }
  if (trimmed.length > 4000) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Message too long (max 4000 characters)');
  }
  return insertDirectMessage(fromUserId, toUserId, trimmed, null);
}
```

Refactor note: `sendMessage` keeps its validation + `canMessage` check, then calls the shared `insertDirectMessage`. Keep `sendMessage`'s existing behavior byte-for-byte.

- [ ] **Step 4: Run the full DM test suite to confirm no regression**

Run: `npm test --workspace=server -- dm`
Expected: all existing DM tests still PASS, plus the new export test.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/dm/dm.service.ts server/src/__tests__/services/post-event-message/service.test.ts
git commit -m "Add broadcast DM send seam that bypasses mutual gate"
```

---

## Phase 5 — Authorization gate (scalable seam)

### Task 6: `canBroadcastToEvent`

**Files:**
- Create: `server/src/services/post-event-message/broadcast-eligibility.ts`
- Test: `server/src/__tests__/services/post-event-message/broadcast-eligibility.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { computeEligibility } from '../../../services/post-event-message/broadcast-eligibility';
import { UserRole } from '@rsn/shared';

describe('computeEligibility', () => {
  it('admin: enabled + visible', () => {
    expect(computeEligibility({ role: UserRole.ADMIN, isPro: false, isDirector: false }))
      .toEqual({ enabled: true, visible: true, reason: 'admin' });
  });
  it('super_admin: enabled', () => {
    expect(computeEligibility({ role: UserRole.SUPER_ADMIN, isPro: false, isDirector: false }).enabled).toBe(true);
  });
  it('pro (no subscription system yet): visible but disabled, coming soon', () => {
    expect(computeEligibility({ role: UserRole.PRO, isPro: true, isDirector: false }))
      .toEqual({ enabled: false, visible: true, reason: 'pro_coming_soon' });
  });
  it('pod director: visible but disabled, coming soon', () => {
    expect(computeEligibility({ role: UserRole.MEMBER, isPro: false, isDirector: true }))
      .toEqual({ enabled: false, visible: true, reason: 'director_coming_soon' });
  });
  it('plain member: not visible', () => {
    expect(computeEligibility({ role: UserRole.MEMBER, isPro: false, isDirector: false }))
      .toEqual({ enabled: false, visible: false, reason: 'not_allowed' });
  });
});
```

- [ ] **Step 2: Run, verify fail.** → FAIL.

- [ ] **Step 3: Implement** the pure decision + a DB-backed resolver

```typescript
import { UserRole, hasRoleAtLeast, type BroadcastEligibility } from '@rsn/shared';
import { query } from '../../db';

export interface EligibilityInputs {
  role: UserRole;
  isPro: boolean;
  isDirector: boolean;
}

/** Pure policy. v1: only admins are enabled; pro/director see coming-soon. */
export function computeEligibility(i: EligibilityInputs): BroadcastEligibility {
  if (hasRoleAtLeast(i.role, UserRole.ADMIN)) {
    return { enabled: true, visible: true, reason: 'admin' };
  }
  if (i.isPro) return { enabled: false, visible: true, reason: 'pro_coming_soon' };
  if (i.isDirector) return { enabled: false, visible: true, reason: 'director_coming_soon' };
  return { enabled: false, visible: false, reason: 'not_allowed' };
}

/** Resolve the inputs for a user against the event's pod, then apply policy. */
export async function getEligibilityForEvent(
  userId: string,
  userRole: UserRole,
  sessionId: string,
): Promise<BroadcastEligibility> {
  const sub = await query<{ plan: string }>(
    `SELECT plan FROM user_subscriptions WHERE user_id = $1`, [userId],
  );
  const isPro = sub.rows[0]?.plan === 'premium';

  const dir = await query<{ role: string }>(
    `SELECT pm.role FROM pod_members pm
     JOIN sessions s ON s.pod_id = pm.pod_id
     WHERE s.id = $1 AND pm.user_id = $2 AND pm.role = 'director' AND pm.status = 'active'
     LIMIT 1`,
    [sessionId, userId],
  );
  const isDirector = dir.rows.length > 0;

  return computeEligibility({ role: userRole, isPro, isDirector });
}
```

- [ ] **Step 4: Run, verify pass.** → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/post-event-message/broadcast-eligibility.ts server/src/__tests__/services/post-event-message/broadcast-eligibility.test.ts
git commit -m "Add broadcast eligibility policy (admin now, pro/director seam)"
```

---

## Phase 6 — Job service

### Task 7: Recipient assembly + job creation + preview

**Files:**
- Create: `server/src/services/post-event-message/post-event-message.service.ts`
- Test: extend `server/src/__tests__/services/post-event-message/service.test.ts`

Functions to implement (signatures the route + worker depend on):

```typescript
import { query, transaction } from '../../db';
import { v4 as uuid } from 'uuid';
import { AppError } from '../../middleware/errors';
import { ErrorCodes, UserRole, hasRoleAtLeast,
  type PostEventMessagePreview, type PostEventMessageJob } from '@rsn/shared';
import * as sessionService from '../session/session.service';
import { classifyParticipant } from './classify';

/** Build the eligible recipient list for an event: every participant minus
 *  the event host and any super_admin/admin internal account. Returns rows
 *  with userId, firstName, bucket. */
export async function assembleRecipients(sessionId: string): Promise<Array<{
  userId: string; firstName: string; bucket: import('@rsn/shared').PostEventMessageBucket;
}>>;

/** Dry-run: classify recipients and return grouped counts. Sends nothing. */
export async function previewJob(sessionId: string): Promise<PostEventMessagePreview>;

/** Create a pending job + recipient rows in one transaction. Relies on the
 *  partial unique index to reject a second active job for the same event
 *  (maps the 23505 unique violation to a 409). Idempotent re-create after a
 *  completed run is allowed and only enqueues users with no prior 'sent' row
 *  across this event's jobs. */
export async function createJob(sessionId: string, createdBy: string): Promise<PostEventMessageJob>;

/** Status for the event's most recent job (for the button state). */
export async function getLatestJob(sessionId: string): Promise<PostEventMessageJob | null>;
```

- [ ] **Step 1: Write failing tests** for: (a) `assembleRecipients` excludes the host id and super_admin accounts; (b) `previewJob` returns bucket counts summing to total; (c) `createJob` throws `AppError(409)` when an active job already exists (simulate unique violation); (d) `createJob` skips users already `sent` in a prior job for the event. Use the existing DB test harness/fixtures pattern from a neighboring service test (open one under `server/src/__tests__/services/` to copy the setup).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** the functions. Key points:
  - Host id: `SELECT host_user_id FROM sessions WHERE id=$1`.
  - Exclude `users.role IN ('admin','super_admin')` AND the host id.
  - First name: `users.first_name` (fallback to '' → template uses "there").
  - Event end for classifier: `sessions.ended_at` (fallback `updated_at`).
  - "already sent" guard:
    ```sql
    SELECT r.user_id FROM post_event_message_recipients r
    JOIN post_event_message_jobs j ON j.id = r.job_id
    WHERE j.session_id = $1 AND r.status = 'sent'
    ```
  - Wrap job + recipients insert in `transaction()`. Catch Postgres error code `'23505'` on the active-job index → `throw new AppError(409, ErrorCodes.VALIDATION_ERROR, 'A message job is already running for this event')`.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add server/src/services/post-event-message/post-event-message.service.ts server/src/__tests__/services/post-event-message/service.test.ts
git commit -m "Add post-event message job service (assemble, preview, create, status)"
```

---

## Phase 7 — Background worker

### Task 8: Durable drain worker with Redis lock

**Files:**
- Create: `server/src/services/post-event-message/post-event-message.worker.ts`
- Modify: `server/src/index.ts` (register interval)
- Test: `server/src/__tests__/services/post-event-message/worker.test.ts`

**Design:** `processPendingJobs(io)` — acquire a Redis lock (`SET pem:worker:lock 1 NX EX 55`); if not acquired, return (another instance is draining). Find the oldest `pending` job, mark `processing` + `started_at`. Stream its `pending` recipients in batches of 25; for each: build the message (`buildMessage(bucket, ctx)`), `dmService.sendBroadcastMessage(createdBy, userId, content)`, then `broadcastDmMessage(io, createdBy, userId, conversationId, message)`; on success mark recipient `sent` + `message_id` + increment job `sent_count`; on error mark `failed` + `error` + increment `failed_count` (never throw out of the loop). When no `pending` recipients remain, set job `completed` (or `completed_with_errors` if `failed_count > 0`), `completed_at`. Release the lock. Each recipient send is independently committed so a crash resumes cleanly (idempotent: only `pending` rows are picked up).

- [ ] **Step 1: Write the failing test** — with `sendBroadcastMessage` and `broadcastDmMessage` mocked: a job with 3 pending recipients ends with job `completed`, `sent_count=3`, all recipient rows `sent`; if the mock throws for one recipient, job ends `completed_with_errors`, `sent_count=2`, `failed_count=1`, and re-running does not resend the 2 already `sent`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** `processPendingJobs(io)`. Batch query:
```sql
SELECT id, user_id, bucket FROM post_event_message_recipients
WHERE job_id = $1 AND status = 'pending'
ORDER BY created_at LIMIT 25
```
Lock helper (degrade gracefully if Redis null → still run, single-instance assumption acceptable for v1):
```typescript
const redis = getRedisClient();
if (redis) {
  const ok = await redis.set('pem:worker:lock', '1', 'NX', 'EX', 55);
  if (!ok) return;
}
try { /* drain */ } finally { if (redis) await redis.del('pem:worker:lock').catch(()=>{}); }
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Register the worker** in `server/src/index.ts` after `initOrchestration(io)` (mirror `processAutoReminders`):
```typescript
// Drain post-event broadcast message jobs every 10s.
const POST_EVENT_MSG_INTERVAL = 10_000;
setInterval(() => {
  processPendingJobs(io).catch(err =>
    logger.error({ err }, 'Post-event message worker cycle failed'));
}, POST_EVENT_MSG_INTERVAL);
```
Add the import at the top of `index.ts`.

- [ ] **Step 6: Run the full server suite** `npm test --workspace=server` → all PASS. Then `npm run build:server` → no type errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/post-event-message/post-event-message.worker.ts server/src/index.ts server/src/__tests__/services/post-event-message/worker.test.ts
git commit -m "Add durable post-event message worker"
```

---

## Phase 8 — REST endpoints

### Task 9: Router + mount

**Files:**
- Create: `server/src/routes/post-event-message.ts`
- Modify: wherever routers mount (grep `router.use('/dm'` / `app.use` to find the central mount file; mirror it).
- Test: extend `service.test.ts` or add a light route test if the repo has route tests (grep `supertest`).

Endpoints (all `authenticate` first; the event must be status `completed`):

- `GET /sessions/:sessionId/post-event-message/eligibility` → `getEligibilityForEvent(req.user.userId, req.user.role, sessionId)`. Returns `BroadcastEligibility`. (Drives the button state; safe for hosts/directors.)
- `GET /sessions/:sessionId/post-event-message/preview` → require `enabled` (admin) via a guard that calls `getEligibilityForEvent` and 403s if not enabled; returns `previewJob(sessionId)`.
- `POST /sessions/:sessionId/post-event-message` → require `enabled`; `createJob(sessionId, req.user.userId)`; returns the job (worker picks it up within 10s).
- `GET /sessions/:sessionId/post-event-message/status` → `getLatestJob(sessionId)`.

Guard helper inside the route file:
```typescript
async function requireBroadcastEnabled(req, res, next) {
  const elig = await getEligibilityForEvent(req.user!.userId, req.user!.role as UserRole, req.params.sessionId);
  if (!elig.enabled) return next(new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'This feature is coming soon'));
  next();
}
```

- [ ] **Step 1: Write a failing route test** if `supertest` exists (assert 403 for a non-admin POST, 201 for an admin POST against a completed fixture event). If no route-test harness exists, assert the handlers via the service tests and mark this step done with a note.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement the router**, mount it, validate `:sessionId` is uuid and event is `completed` (404/409 otherwise).

- [ ] **Step 4: Run, verify pass + `npm run build:server`.**

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/post-event-message.ts <mount-file> server/src/__tests__/...
git commit -m "Add post-event message REST endpoints"
```

---

## Phase 9 — Client UI

### Task 10: react-query hooks

**Files:**
- Create: `client/src/features/sessions/usePostEventMessage.ts`

- [ ] **Step 1: Implement** three hooks using `api` (axios) + react-query:
  - `useBroadcastEligibility(sessionId)` → GET eligibility.
  - `usePostEventMessageStatus(sessionId)` → GET status (poll every 5s while a job is `pending`/`processing`).
  - `useSendPostEventMessages(sessionId)` → mutation POST; on success `addToast('Messages are being sent to {n} participants', 'success')` and invalidate status; on error `addToast(err.response?.data?.error?.message || 'Could not send', 'error')`.
  - `usePostEventMessagePreview(sessionId, enabled)` → GET preview, only when the confirm modal opens.

- [ ] **Step 2: Build the client** `npm run build:client` (or `tsc --noEmit` in client) → no type errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/features/sessions/usePostEventMessage.ts
git commit -m "Add post-event message client hooks"
```

### Task 11: Button + confirm modal + coming-soon

**Files:**
- Create: `client/src/features/sessions/MessageParticipantsButton.tsx`
- Modify: `client/src/features/sessions/SessionDetailPage.tsx` (render it when `session.status === 'completed'`, inside the existing action area near lines 512-557)

- [ ] **Step 1: Implement `MessageParticipantsButton`** with these states (use `Button`, `Modal`, toast):
  - Calls `useBroadcastEligibility`. If `!visible` → render nothing.
  - If `visible && !enabled` → render a disabled `Button` with a hover/title `"Pro — coming soon"` (native `title` attr is fine; no Tooltip component exists). Label: `Message all participants`.
  - If `enabled`:
    - If latest job status is `completed`/`completed_with_errors` → show `Sent on <date>` (still allow re-open to message anyone missed).
    - If status `pending`/`processing` → show `Sending… {sent}/{total}` (disabled, polling).
    - Else → enabled button opens a confirm `Modal` showing the preview: "This will message {total} participants: {stayed} stayed, {left_early} left early, {could_not_join} couldn't join, {no_show} didn't take part." Confirm → fire mutation. Cancel → close.

- [ ] **Step 2: Render in `SessionDetailPage`** — import and place `{session?.status === 'completed' && <MessageParticipantsButton sessionId={sessionId} />}` in the action row. Match existing button sizing (`variant="secondary" size="sm"`).

- [ ] **Step 3: Build the client** → no type errors. Then visually verify with Playwright/manual against a local dev client if available (screenshot the completed-event action row in all three states using mocked eligibility). If the local client can't be driven, note it and rely on E2E (Task 12).

- [ ] **Step 4: Commit**

```bash
git add client/src/features/sessions/MessageParticipantsButton.tsx client/src/features/sessions/SessionDetailPage.tsx
git commit -m "Add Message-all-participants button with coming-soon state"
```

---

## Phase 10 — Verification against production (safe)

> **HARD SAFETY RULE:** never run the send against the real 27 May event (session `598c6dc0-1c37-4d31-b88c-27060ab17067`) or any real participants. All prod verification uses throwaway users in a throwaway event, cleaned up by id. This mirrors the existing `/e2e` discipline (emails like `%rsn-e2e.invalid`, delete by id).

### Task 12: E2E against production

**Files:**
- Create: `e2e/tests/post-event-message.spec.ts`

- [ ] **Step 1: Write the E2E** (follow the existing `e2e/tests/*.spec.ts` setup + the `/e2e` skill's dummy-user/cleanup pattern):
  1. Seed: create 1 admin-authed context (existing super_admin test creds) + 4 dummy users with `%rsn-e2e.invalid` emails.
  2. Create a dummy pod + a `completed` event whose `session_participants` cover all four buckets (set `rounds_completed`, `joined_at`, `left_at` directly via the seed path used elsewhere, or via the test DB helper).
  3. As admin: `GET …/eligibility` → `{enabled:true,reason:'admin'}`. As a dummy member: → `{enabled:false}`.
  4. As admin: `GET …/preview` → counts match the 4 buckets.
  5. As admin: `POST …/post-event-message` → 201; poll `…/status` until `completed`.
  6. Assert each dummy user received exactly one DM from the admin with the right bucket copy (query `direct_messages`), one `notifications` row, and that a re-`POST` does not create duplicate messages (idempotency).
  7. Cleanup: delete dummy users + their pod/event/messages/notifications **by id** (extend the existing cleanup helper / `/cleanup-e2e`).

- [ ] **Step 2: Run the E2E against the prod backend** per the `/e2e` skill. Expected: green, 0 orphans left.

- [ ] **Step 3: Smoke** the live UI: on a *dummy* completed event in the prod client, confirm the admin sees the button, the confirm modal shows correct counts, sending flips to "Sending…/Sent", and a dummy recipient sees the DM + bell + (offline) email. Tear down the dummy event.

- [ ] **Step 4: Commit**

```bash
git add e2e/tests/post-event-message.spec.ts e2e/<cleanup-helper-if-touched>
git commit -m "Add E2E for post-event broadcast messaging"
```

### Task 13: Ship

- [ ] **Step 1:** Full server suite + client typecheck green locally (RajaSkill: full suite, not just touched files).
- [ ] **Step 2:** `/security-review` (new authenticated endpoints + role gate + sends real messages).
- [ ] **Step 3:** `/simplify` on the diff.
- [ ] **Step 4:** Ship via the project flow (`/shipphase`) — staging → CI → main → CI → deploy verify. Confirm migration 065 runs on deploy. Do not deploy during a live event window.
- [ ] **Step 5:** `/checkhole` after deploy.

---

## Self-Review

**Spec coverage:**
- Scalable backend → durable job table + worker + Redis lock (Phases 1, 6, 7). ✓
- Auto-generate per-participation message → classifier + templates + assembleRecipients (Phases 3, 7). ✓
- "Request received, then system sends automatically" → `createJob` returns immediately, worker drains async (Phases 7, 8). ✓
- Admins send for real; non-admin pro/director see "coming soon" → `computeEligibility` + button states (Phases 5, 9). ✓
- Future pro/subscription with no payment system yet → policy returns `pro_coming_soon`/`director_coming_soon`; flip to enabled later with no schema change (Phase 5). ✓
- Verify against production, no bugs, smoke + E2E → Phase 10 with dummy-user safety. ✓
- Idempotent / no double-send → per-recipient UNIQUE + status, "already sent" guard, partial unique active-job index (Phases 1, 6, 7). ✓
- "event" not "session" in user-facing copy → templates + button text. ✓

**Type consistency:** `BroadcastEligibility`, `PostEventMessageBucket`, `PostEventMessageJob`, `PostEventMessagePreview` defined once in shared (Task 2) and consumed identically server + client. `computeEligibility` reasons match the `BroadcastEligibility.reason` union. `sendBroadcastMessage` returns the same shape as `sendMessage`.

**Open confirmations for the executor (resolve in-task, don't guess):**
1. Central router mount file — grep `app.use('/sessions'` vs a sessions sub-router; mount consistently.
2. Whether a `supertest` route-test harness exists (Task 9 Step 1).
3. The exact DB test-fixture helper neighboring services use (Tasks 7, 8).
