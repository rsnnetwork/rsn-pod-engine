# April 17 Client Feedback — 17-Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the 17 items from the April 17, 2026 client feedback doc (`assets/17th April, 2026.pdf`) as architectural fixes — preserving every Change 4.5 and 4.6 behavior.

**Architecture:** Mostly surgical changes per area (auth, invites, onboarding, host controls, breakouts, access control). The four heavier architectural pieces: (1) mandatory onboarding with full profile capture; (2) encounter_history-based "connected users" invite filter; (3) route-level session access gate; (4) bulk manual-breakout-room controls with shared timer.

**Tech Stack:** Node.js/TypeScript server, React/Vite client, PostgreSQL (Neon), LiveKit, Socket.IO, Redis (Upstash), Jest.

**User-locked decisions:**
- Domain: **Option A** — Vercel rewrites proxy `/api/*` from `app.rsn.network` to Render backend. One domain for everything.
- Onboarding: **Option C1.A** — Add company, jobTitle, industry, reasonsToConnect to the onboarding form.
- Host Controls: **Option C2 approved** — status-driven primary action + overflow menu. COMPLETED events get NO "Host Controls" button.

**Preservation (Change 4.5 + 4.6 — MUST NOT REGRESS):**
- Ghost timer clearRoomTimers (`cb66184`), per-room timer sync (`d65e687`), leftCurrentRound race fix (`7d3efb8`)
- Rating in all leave/remove paths (`3975009`) + 30s cancelled-grace window
- Stale match cleanup across rounds (`84fe5d4`)
- match_status state machine (Change 4.6): no_show only via detectNoShows, reassign via findIsolatedParticipants helper
- LiveKit closeRoom debug-on-404 (`666dfb0`)

---

## File structure

**New files:**
- `server/src/db/migrations/038_onboarding_reasons_industry.sql` (if any schema gaps found — TBD during Task 1)
- `server/src/services/invite/connected-users.ts` — encounter-history-based search
- `server/src/services/orchestration/handlers/breakout-bulk.ts` — bulk breakout handlers
- `client/src/features/sessions/statusConfig.ts` — shared enum→label/color map
- `client/vercel.json` (or edit existing) — Vercel rewrite for Item 1
- `server/src/__tests__/services/invite/connected-users.test.ts`
- `server/src/__tests__/services/orchestration/breakout-bulk.test.ts`
- `client/src/__tests__/features/sessions/statusConfig.test.ts`

**Modified (high-level):**
- Onboarding form (OnboardingPage.tsx), ProtectedRoute.tsx
- `server/src/routes/invites.ts`, `server/src/routes/users.ts`, `server/src/routes/sessions.ts`, `server/src/routes/admin.ts`
- `server/src/middleware/auth.ts`, `server/src/services/identity/identity.service.ts`
- `server/src/services/orchestration/handlers/host-actions.ts`
- `client/src/features/auth/LoginPage.tsx`, `client/src/features/invites/*`, `client/src/features/pods/PodDetailPage.tsx`, `client/src/features/sessions/SessionDetailPage.tsx`, `client/src/features/live/HostControls.tsx`, `client/src/features/live/MatchingOverlay.tsx`, `client/src/features/live/VideoRoom.tsx`, `client/src/features/live/LiveSessionPage.tsx`

---

## Task order & dependency

| # | Item | Blocks / requires | Risk |
|---|---|---|---|
| 1 | #5 Onboarding mandatory + fields | Blocks Task 6 (invite signup lands here) | MED — touches signup gate |
| 2 | #7 Connected-users invite filter | Independent | LOW |
| 3 | #9 Session access control | Independent | MED — closes data leak |
| 4 | #2 Deactivation cache | Independent | LOW |
| 5 | #4 Invite cap removal | Independent | LOW |
| 6 | #3 Invite-aware LoginPage | Needs Task 1 complete | LOW |
| 7 | #6/#12 Auto-register deep audit | Independent — investigation first | Findings-dependent |
| 8 | #8 Pending invites placement | Independent | NIL |
| 9 | #10 Host Controls consolidation | Independent | MED — refactor |
| 10 | Extra: statusConfig util | Unblocks Task 9 display cleanup | LOW |
| 11 | Extra: "breakout rooms ready" text | Independent | NIL |
| 12 | Extra: video tile displayName/grey | Independent | LOW |
| 13 | #11 Extend per-room breakout timer | Independent | LOW — additive |
| 14 | #13 Bulk breakout controls | Builds on Task 13 | HIGH — new feature |
| 15 | #1 Domain cutover | Last (needs Stefan DNS + Google Cloud steps) | MED — auth break risk |
| 16 | Full deploy + check_hole + progress.md + Stefan message | All prior tasks | — |

---

## Task 1: Mandatory onboarding + full profile capture

**Why:** `profile_complete` flag checks fields (company, jobTitle, industry, reasonsToConnect) that aren't in the onboarding form. Users can skip onboarding entirely via "Skip for now" button. Matching algorithm degrades silently on incomplete profiles. Users are approved to pods with zero profile fields filled.

**User decision:** Option C1.A — add the 4 missing fields to onboarding form, make flow mandatory.

**Files:**
- Modify: `client/src/features/onboarding/OnboardingPage.tsx`
- Modify: `client/src/components/ProtectedRoute.tsx` (onboarding gate strictness)
- Modify: `server/src/routes/auth.ts` (onboarding-complete endpoint validation)
- Modify: `server/src/services/identity/identity.service.ts` (profile_complete computation)
- Create test: `server/src/__tests__/routes/onboarding-gate.test.ts`

- [ ] **Step 1.1: Read current OnboardingPage.tsx and map existing steps**

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN" && wc -l client/src/features/onboarding/OnboardingPage.tsx
grep -n "step\|Step\|skipForNow\|Skip for now\|professionalRole\|currentState\|careerStage\|goals\|meetingPreferences\|interests\|matchingNotes" client/src/features/onboarding/OnboardingPage.tsx | head -40
```

Note the existing step structure — we'll insert the new fields into whichever step(s) fit thematically.

- [ ] **Step 1.2: Add company + jobTitle + industry + reasonsToConnect to the form**

In `OnboardingPage.tsx`:
- Add a new step OR extend Step 1 (professional identity) to include:
  - `company` (text input)
  - `jobTitle` (text input)
  - `industry` (text input OR dropdown — match how Profile page handles it)
  - `reasonsToConnect` (multi-line textarea or comma-separated tags — check Profile page for existing input)

Each field's submit should write to users.* via the existing `PATCH /users/me` endpoint (or whichever update path the onboarding flow currently uses).

**Required**: mark all 4 fields required (red asterisk + inline error if empty on Next).

- [ ] **Step 1.3: Remove the "Skip for now" button**

Find and delete the skip link on Step 1 (currently around line ~232 per audit).

Replace with:
```tsx
<p className="text-xs text-gray-500 mt-2">
  We need your profile to introduce you to the right people. You can always edit it later on your Profile page.
</p>
```

- [ ] **Step 1.4: Harden the onboarding gate in ProtectedRoute**

Current (per audit, `ProtectedRoute.tsx:16`):
```tsx
if (onboardingCompleted === false) redirect('/onboarding?redirect=...')
```

Change to: gate on BOTH `onboarding_completed` AND `profile_complete`:
```tsx
if (!user.onboarding_completed || !user.profile_complete) {
  return <Navigate to={`/onboarding?redirect=${encodeURIComponent(location.pathname)}`} replace />;
}
```

This forces users with partial profiles back into onboarding until fields are filled.

- [ ] **Step 1.5: Align `profile_complete` computation**

In `server/src/services/identity/identity.service.ts` around line 222:

Current logic checks: firstName, lastName, displayName, company, jobTitle, industry, reasonsToConnect.

Keep that list — align onboarding to fill those same fields (done in Step 1.2). Confirm that the computation matches the onboarding form's required fields exactly. If any are missing from the list, add them.

- [ ] **Step 1.6: Harden `/auth/onboarding/complete` endpoint**

In `server/src/routes/auth.ts` around line 262:
- Require body to include all 4 new fields (empty rejected with 400)
- Server-side: after saving, re-compute profile_complete; must be TRUE or reject

- [ ] **Step 1.7: Grandfather existing users**

Migration is NOT needed — `033_onboarding_completed.sql` already sets existing users to `onboarding_completed=true`. Don't touch those rows. The new mandatory fields will be requested next time those users log in IF `profile_complete` is FALSE for them.

Verify: query count of existing users where `profile_complete = FALSE` to know the blast radius. If large (>20% of active users), flag as DONE_WITH_CONCERNS — we may want a gentler migration than forcing them all back into onboarding.

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN" && node -e "
const { Pool } = require('pg');
require('dotenv').config({ path: 'server/.env' });
const p = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const r = await p.query(\"SELECT COUNT(*)::int AS c, SUM(CASE WHEN profile_complete THEN 1 ELSE 0 END)::int AS complete FROM users WHERE status='active'\");
  console.log('Active users:', r.rows[0].c, '| profile_complete:', r.rows[0].complete);
  await p.end();
})();
"
```

- [ ] **Step 1.8: Test**

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN/server" && npx tsc --noEmit && npx jest --no-coverage 2>&1 | tail -10
cd "C:/Users/ARFA TECH/Desktop/RSN/client" && npx tsc --noEmit 2>&1 | head -10
```

- [ ] **Step 1.9: Commit**

```bash
git add client/src/features/onboarding client/src/components/ProtectedRoute.tsx server/src/routes/auth.ts server/src/services/identity/identity.service.ts
git commit -m "$(cat <<'EOF'
feat: onboarding mandatory + captures company/jobTitle/industry/reasonsToConnect

- OnboardingPage now requires the 4 fields profile_complete checks
- Removed "Skip for now" — onboarding blocks access until profile complete
- ProtectedRoute gates on BOTH onboarding_completed AND profile_complete
- /auth/onboarding/complete validates all required fields server-side
- Existing onboarded users grandfathered via migration 033; only users
  with profile_complete=FALSE will be redirected back through onboarding

Addresses April 17 feedback item #5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Connected-users invite filter

**Why:** Current `GET /users/search` returns ALL active users. Anyone can be invited to any pod. Stefan wants invites restricted to users the inviter has previously interacted with (i.e., shared a past event/match).

**Architecture:** "Connected" = exists a row in `encounter_history` where (user_a_id = me AND user_b_id = target) OR vice versa. Matches existing data model. No schema changes.

**Files:**
- Create: `server/src/services/invite/connected-users.ts`
- Create: `server/src/__tests__/services/invite/connected-users.test.ts`
- Modify: `server/src/routes/users.ts` (users/search endpoint — add `connectedOnly` query param OR add separate `/users/connected` endpoint)
- Modify: `client/src/features/pods/PodDetailPage.tsx`, `client/src/features/sessions/SessionDetailPage.tsx` (invite modals) — call connected-only endpoint

- [ ] **Step 2.1: Write failing test**

Create `server/src/__tests__/services/invite/connected-users.test.ts`:

```typescript
import { jest } from '@jest/globals';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: mockQuery }));

describe('searchConnectedUsers', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns only users with encounter_history rows shared with the requester', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'u1', display_name: 'Alice', email: 'a@e.com', company: null, job_title: null, industry: null, avatar_url: null },
      ],
    });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    const result = await searchConnectedUsers('me-id', 'ali', 20);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('u1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('encounter_history');
    expect(sql).toContain('user_a_id');
    expect(sql).toContain('user_b_id');
    expect(params).toEqual(['me-id', '%ali%', 20]);
  });

  it('returns empty list when requester has no encounter history', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    const result = await searchConnectedUsers('me-id', 'xyz', 20);
    expect(result).toEqual([]);
  });

  it('excludes the requester themselves even if somehow self-encountered', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'u2', display_name: 'Bob', email: 'b@e.com', company: null, job_title: null, industry: null, avatar_url: null },
      ],
    });
    const { searchConnectedUsers } = await import('../../../services/invite/connected-users');
    await searchConnectedUsers('me-id', 'bob', 20);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('u.id != $1');
  });
});
```

- [ ] **Step 2.2: Create helper**

`server/src/services/invite/connected-users.ts`:

```typescript
import { query } from '../../db';

export interface ConnectedUserResult {
  id: string;
  display_name: string | null;
  email: string;
  company: string | null;
  job_title: string | null;
  industry: string | null;
  avatar_url: string | null;
}

/**
 * Search for users the requester has previously interacted with via encounter_history.
 *
 * "Connected" = shared at least one session match (sits in encounter_history).
 *
 * Used by pod/session invite modals so inviters can only invite people they already
 * know from the platform, not random searchable strangers.
 */
export async function searchConnectedUsers(
  requesterId: string,
  searchTerm: string,
  limit = 20,
): Promise<ConnectedUserResult[]> {
  const result = await query<ConnectedUserResult>(
    `SELECT DISTINCT u.id, u.display_name, u.email, u.company, u.job_title, u.industry, u.avatar_url
     FROM users u
     WHERE u.status = 'active'
       AND u.id != $1
       AND EXISTS (
         SELECT 1 FROM encounter_history eh
         WHERE (eh.user_a_id = $1 AND eh.user_b_id = u.id)
            OR (eh.user_b_id = $1 AND eh.user_a_id = u.id)
       )
       AND (
         u.display_name ILIKE $2
         OR u.email ILIKE $2
         OR u.first_name ILIKE $2
         OR u.last_name ILIKE $2
       )
     ORDER BY u.display_name
     LIMIT $3`,
    [requesterId, `%${searchTerm}%`, limit],
  );
  return result.rows;
}
```

- [ ] **Step 2.3: Add route endpoint**

In `server/src/routes/users.ts`, ADD a new endpoint (don't remove existing `/users/search` — admin still needs it for full search). Add:

```typescript
// GET /api/users/connected?q=<term>&limit=<n>
router.get('/connected', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 50);
    if (q.length < 2) return res.json({ users: [] });
    const users = await searchConnectedUsers(req.user!.id, q, limit);
    res.json({ users });
  } catch (err) {
    next(err);
  }
});
```

Import at top: `import { searchConnectedUsers } from '../services/invite/connected-users';`

- [ ] **Step 2.4: Restrict existing `/users/search` to admins**

Add an admin check on the existing `/users/search` route (so non-admin platform users can't list-all). Admins still need full search for moderation.

- [ ] **Step 2.5: Update client invite modals to call the new endpoint**

In `client/src/features/pods/PodDetailPage.tsx:656` and `client/src/features/sessions/SessionDetailPage.tsx:734` (and anywhere else invoking user search for invite):
- Change fetch URL from `/api/users/search` to `/api/users/connected`
- When the result set is empty AND searchTerm is non-empty, show helpful copy: "No connected users match — you can only invite people you've met in a previous event."

- [ ] **Step 2.6: Test + commit**

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN/server" && npx tsc --noEmit && npx jest src/__tests__/services/invite --no-coverage
cd "C:/Users/ARFA TECH/Desktop/RSN/client" && npx tsc --noEmit 2>&1 | head -10
```

Commit:
```bash
git add server/src/services/invite/connected-users.ts server/src/__tests__/services/invite/connected-users.test.ts server/src/routes/users.ts client/src/features/pods/PodDetailPage.tsx client/src/features/sessions/SessionDetailPage.tsx
git commit -m "$(cat <<'EOF'
feat: pod invite search restricted to connected users (encounter_history)

- New endpoint GET /api/users/connected filters by encounter_history
- Client invite modals (pod + session) use the connected endpoint
- Admin /users/search retained for moderation (admin-only gate added)
- "Connected" = shared at least one session match

Addresses April 17 feedback item #7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Route-level session access control

**Why:** `GET /api/sessions/:id` returns full session data (title, config, host, timestamps) to ANY authenticated user. Non-members see "0 participants" instead of a clear access-denied message. Also a small data leak — session metadata should only be visible to pod members / registered participants.

**Files:**
- Modify: `server/src/routes/sessions.ts` (GET /:id)
- Modify: `client/src/features/sessions/SessionDetailPage.tsx` (handle 403)
- Create test: `server/src/__tests__/routes/sessions-access.test.ts`

- [ ] **Step 3.1: Add access gate helper**

In `server/src/services/session/session.service.ts` or a new `session-access.ts`:

```typescript
/**
 * Determine if a user can view a session's details.
 * - Host and admins: always
 * - Registered participants: always
 * - Pod members of a private/invite_only pod: always
 * - Everyone else: denied
 */
export async function canViewSession(userId: string, sessionId: string, userRole: string): Promise<boolean> {
  if (userRole === 'admin' || userRole === 'super_admin') return true;

  const sessRes = await query<{ host_user_id: string; pod_id: string; pod_visibility: string }>(
    `SELECT s.host_user_id, s.pod_id, p.visibility AS pod_visibility
     FROM sessions s
     LEFT JOIN pods p ON p.id = s.pod_id
     WHERE s.id = $1`,
    [sessionId],
  );
  if (sessRes.rows.length === 0) return false;
  const s = sessRes.rows[0];

  if (s.host_user_id === userId) return true;

  const partRes = await query<{ status: string }>(
    `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2 LIMIT 1`,
    [sessionId, userId],
  );
  if (partRes.rows.length > 0 && partRes.rows[0].status !== 'removed') return true;

  // Pod member fallback (for public/invite_only pods)
  if (s.pod_id) {
    const memRes = await query<{ role: string }>(
      `SELECT role FROM pod_members WHERE pod_id = $1 AND user_id = $2 LIMIT 1`,
      [s.pod_id, userId],
    );
    if (memRes.rows.length > 0) return true;
    // Public pods: allow anyone authenticated to view (discovery)
    if (s.pod_visibility === 'public') return true;
  }

  return false;
}
```

- [ ] **Step 3.2: Gate the GET /sessions/:id route**

In `server/src/routes/sessions.ts`, the GET /:id handler (~line 83):

```typescript
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const canView = await canViewSession(req.user!.id, req.params.id, req.user!.role);
    if (!canView) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You must be registered or a pod member to view this event.',
      });
    }
    const session = await sessionService.getSessionById(req.params.id);
    res.json(session);
  } catch (err) {
    next(err);
  }
});
```

Import `canViewSession` at the top.

- [ ] **Step 3.3: Client side — handle 403 cleanly**

In `client/src/features/sessions/SessionDetailPage.tsx`, wrap the session fetch:
- If 403 response → render a full-page access-denied card instead of the session UI
- Card text: "You don't have access to this event. Ask the host for an invite or register via your pod."

Look for the existing `useSessionQuery` or `fetchSession` pattern and add error handling.

- [ ] **Step 3.4: Test**

Add `server/src/__tests__/routes/sessions-access.test.ts` with unit tests for `canViewSession` covering:
- Host access → allowed
- Admin access → allowed
- Registered participant → allowed
- Pod member → allowed
- Non-member of private pod → denied
- Public pod any user → allowed

- [ ] **Step 3.5: Run + commit**

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN/server" && npx tsc --noEmit && npx jest --no-coverage 2>&1 | tail -10
git add server/src/services/session server/src/routes/sessions.ts server/src/__tests__/routes/sessions-access.test.ts client/src/features/sessions/SessionDetailPage.tsx
git commit -m "$(cat <<'EOF'
feat: route-level access control on GET /api/sessions/:id

- Non-participants of private/invite_only pods get 403 with clear message
- Admin / host / registered participant / pod member allowed
- Public pod sessions remain discoverable
- Client renders access-denied card on 403 instead of "0 participants"

Closes metadata leak + fixes April 17 feedback item #9.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Deactivation cache invalidation

**Why:** `invalidateUserStatusCache()` exists in `server/src/middleware/auth.ts` but is never called on reactivation. 60s stale window = "deactivated user can't log in for 60s after reactivation".

**Files:**
- Modify: `server/src/middleware/auth.ts` (ensure export)
- Modify: `server/src/routes/admin.ts` (call invalidation after bulk status change)
- Modify: `server/src/services/identity/identity.service.ts` (if it has any status-update paths, call invalidation)
- Test: `server/src/__tests__/middleware/auth-cache.test.ts`

- [ ] **Step 4.1: Verify function exists + is exported**

```bash
grep -n "invalidateUserStatusCache\|userStatusCache" server/src/middleware/auth.ts
```

- [ ] **Step 4.2: Call it from admin bulk-action**

In `server/src/routes/admin.ts:196-206`, after the `UPDATE users SET status = ...` query, iterate the affected userIds and call `invalidateUserStatusCache(userId)` for each.

- [ ] **Step 4.3: Audit all other status mutation sites**

```bash
grep -rn "UPDATE users SET status\|users.status =" server/src | grep -v test | grep -v migration
```

For every hit outside migrations/tests, call invalidation immediately after.

- [ ] **Step 4.4: Test**

Unit test the invalidation function directly (in-memory map add/delete) + integration test: admin bulk action → subsequent auth middleware call sees fresh status.

- [ ] **Step 4.5: Commit**

```bash
git add server/src/middleware/auth.ts server/src/routes/admin.ts server/src/services/identity/identity.service.ts server/src/__tests__
git commit -m "$(cat <<'EOF'
fix: invalidate user status cache on every status mutation

Previously, admin deactivate→reactivate had a 60s stale window where
the middleware cache still said deactivated. Now every UPDATE users
SET status call is followed by invalidateUserStatusCache(userId).

Addresses April 17 feedback item #2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Remove invite max_uses cap

**Why:** Zod schema caps `max_uses` at 1000. Stefan wants inviter-selectable unlimited.

**Files:**
- Modify: `server/src/routes/invites.ts` (Zod schema line 21)
- Modify: `client/src/features/invites/*.tsx` (inline validation)

- [ ] **Step 5.1: Server — remove the cap**

In `server/src/routes/invites.ts:21` find `.max(1000)` in the maxUses field of the Zod schema. Change to `.max(1_000_000)` (practical upper bound to prevent accidental `Number.MAX_SAFE_INTEGER` input; truly unlimited in business terms).

Keep `.min(1)` to prevent 0/negative.

- [ ] **Step 5.2: Client — inline validation feedback**

In `client/src/features/invites/CreateInviteModal.tsx` (or `InvitesPage.tsx:491`):
- When user types maxUses, show inline "Must be 1 or greater" if <1
- On submit, catch 400 errors and show the server's message instead of silent "Validation failed"

- [ ] **Step 5.3: Test + commit**

```bash
git commit -m "fix: remove invite max_uses 1000 cap (April 17 item #4)"
```

---

## Task 6: Invite-aware LoginPage

**Why:** New invited users hitting `/login?inviteCode=X` see BOTH "Sign in" and "Request to Join" — confusing, since they already have an invite. Stefan wants them to go straight to sign-in (Google or magic link), and if they're new, then into the mandatory onboarding (Task 1 output).

**Files:**
- Modify: `client/src/features/auth/LoginPage.tsx`

- [ ] **Step 6.1: Detect inviteCode in URL**

Read current LoginPage. Use `useSearchParams` to check for `inviteCode`.

```tsx
const [searchParams] = useSearchParams();
const inviteCode = searchParams.get('inviteCode');
const hasInvite = !!inviteCode;
```

- [ ] **Step 6.2: Conditionally render**

When `hasInvite === true`:
- Hide the "New here? Request access" / "Request to Join" button section entirely
- Replace heading "CONNECT WITH REASON" subtext with: "You've been invited — sign in to accept your invite"
- Keep Google + magic link buttons (they already pass inviteCode through per identity.service.ts)

When `hasInvite === false`: render as today.

- [ ] **Step 6.3: Ensure post-login redirect lands on onboarding for new users**

After successful auth, the flow is: VerifyPage → redirect to `?redirect=/invite/{code}`. On that `/invite/{code}` page, if user is new (profile_complete=false), ProtectedRoute (now hardened in Task 1) kicks them to `/onboarding?redirect=/invite/{code}`. After onboarding, they land on the invite accept page. Confirm this chain works end-to-end by tracing through the routes.

- [ ] **Step 6.4: Commit**

```bash
git commit -m "fix: LoginPage hides Request to Join when inviteCode present (April 17 item #3)"
```

---

## Task 7: Auto-registration deep audit

**Why:** Stefan reports "user gets auto-registered without accepting invite." First audit couldn't reproduce. This task: **investigate**, not fix blindly. If no bug found, document that the flow is correct and close. If bug found, fix.

**Approach:**

- [ ] **Step 7.1: Trace every code path that inserts `session_participants` rows**

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN" && grep -rn "INSERT INTO session_participants\|session_participants.*INSERT\|sp\.INSERT" server/src | grep -v test
```

List every path. For each: confirm it requires explicit user action (button click, API call with user intent).

- [ ] **Step 7.2: Deep-read `identity.service.ts:560` OAuth flow**

Per earlier audit, `findOrCreateGoogleUser()` at line 468 applies invite membership (pod_members, session_participants) automatically when a Google user completes OAuth with an invite code in state.

If the invite code came from clicking an invite email link (user intent = "I want this invite"), this is acceptable.

If the invite code came from ANY OTHER source (e.g., stored in URL from a previous session, shared link), it might auto-register without explicit consent.

Audit the OAuth state flow: where does `inviteCode` enter the flow? Is it always from explicit user action?

- [ ] **Step 7.3: Deep-read `invite.service.ts:419-462` acceptInvite fallback**

The "belt-and-suspenders" at lines 437-461 force-inserts session_participants even if `registerParticipant()` fails. If `registerParticipant()` correctly rejected (e.g., because user doesn't qualify), this fallback bypasses that guard.

Verify: when would `registerParticipant` fail? What legitimate rejections does this bypass?

- [ ] **Step 7.4: Add `session_participants.status = 'invited'` intermediate state (optional — based on findings)**

If findings show auto-registration is happening and the user wants an "invited but not yet accepted" distinction:
- Add 'invited' value to `participant_status` enum via migration 038
- Change acceptInvite to insert with status='invited' first
- Require explicit user action (button click) to transition 'invited' → 'registered'

If findings show flow is already explicit and Stefan's repro was a misclick, document that and close.

- [ ] **Step 7.5: Write test cases that prove the flow**

Whatever the findings, add tests that lock in the correct behavior:
- `test: user who clicks invite link but NOT accept button → not in session_participants`
- `test: user who clicks accept → appears in session_participants with status='registered'`
- `test: user who unregisters → status='left'`
- `test: user CAN re-register after leaving (if still invited)`

- [ ] **Step 7.6: Commit**

If no fix needed: commit the tests as regression protection.
If fix applied: commit with full explanation of what was broken + how fixed.

```bash
git commit -m "fix/test: auto-registration flow audit + regression tests (April 17 item #6, #12)"
```

---

## Task 8: Pending invites JSX reorder

**Why:** In `client/src/features/pods/PodDetailPage.tsx`, "Pending Pod Invites" section currently renders between "Events" and "Members". Stefan wants it lower (after Members).

**Files:**
- Modify: `client/src/features/pods/PodDetailPage.tsx:894-978` (move block)

- [ ] **Step 8.1: Read current section order**

```bash
grep -n "Pending Pod Invites\|Members\|Events\|showPodPendingInvites" client/src/features/pods/PodDetailPage.tsx | head -20
```

- [ ] **Step 8.2: Move the Pending Invites JSX block**

Cut lines 894-978 (Pending Invites block). Paste AFTER the Members section close tag (after line ~1075).

Verify no state or event handlers break — the section uses `showPodPendingInvites` state which is declared earlier in the component; that's fine.

- [ ] **Step 8.3: Commit**

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN/client" && npx tsc --noEmit 2>&1 | head -5
git add client/src/features/pods/PodDetailPage.tsx
git commit -m "fix: pending pod invites moved below Members section (April 17 item #8)"
```

---

## Task 9: Host Controls consolidation

**Why:** Event detail page has "Host Controls", "Copy Event", "Delete" buttons in a row regardless of session status. Per C2 design:
- SCHEDULED → "Enter Event" primary + overflow (Copy, Edit, Delete)
- LOBBY_OPEN / ROUND_ACTIVE / ROUND_RATING / ROUND_TRANSITION / CLOSING_LOBBY → "Enter Live Event" primary + "Host Controls" opens live-dashboard panel
- COMPLETED → "View Recap" primary + overflow (Copy, Delete). **NO Host Controls button.**

**Files:**
- Modify: `client/src/features/sessions/SessionDetailPage.tsx:417-439`
- Depends on Task 10 (statusConfig util) — do Task 10 FIRST, then return to this

(See Task 10 below.)

- [ ] **Step 9.1: Refactor button row to status-driven**

Use `sessionStatusPhase(status)` from Task 10's statusConfig to classify:
- `pre` = scheduled
- `live` = lobby_open, round_active, round_rating, round_transition, closing_lobby
- `done` = completed
- `cancelled` = cancelled

Render:
```tsx
{phase === 'pre' && <PrimaryButton onClick={enterEvent}>Enter Event</PrimaryButton>}
{phase === 'live' && <PrimaryButton onClick={enterLive}>Enter Live Event</PrimaryButton>}
{phase === 'done' && <PrimaryButton onClick={viewRecap}>View Recap</PrimaryButton>}

{(isHost || isAdmin) && (
  <OverflowMenu>
    <MenuItem onClick={copyEvent}>Copy Event</MenuItem>
    {phase === 'pre' && <MenuItem onClick={editEvent}>Edit Event</MenuItem>}
    {phase !== 'live' && <MenuItem onClick={deleteEvent} danger>Delete</MenuItem>}
  </OverflowMenu>
)}
```

**No "Host Controls" button** — the live host controls live inside the Live Event page/panel (already exists), reachable via "Enter Live Event".

- [ ] **Step 9.2: Verify the existing live host-controls panel works from the Enter Live Event flow**

Re-test that clicking "Enter Live Event" as host lands on the live dashboard with HostControls panel (no regression from Task 9 refactor).

- [ ] **Step 9.3: Commit**

```bash
git commit -m "refactor: consolidate event detail actions by status (April 17 item #10)"
```

---

## Task 10: Shared statusConfig utility

**Why:** `SessionDetailPage.tsx:317` renders status as `{session.status?.replace(/_/g, ' ')}` → "lobby_open" becomes "lobby open" (lowercase, ugly). `AdminSessionsPage.tsx` uses raw enum. `LiveSessionPage.tsx` has nice labels like "Main Room". Extract a shared config.

**Files:**
- Create: `client/src/features/sessions/statusConfig.ts`
- Modify: SessionDetailPage.tsx, AdminSessionsPage.tsx, LiveSessionPage.tsx (use util)

- [ ] **Step 10.1: Create the config module**

`client/src/features/sessions/statusConfig.ts`:

```typescript
export type SessionStatus =
  | 'scheduled' | 'lobby_open' | 'round_active' | 'round_rating'
  | 'round_transition' | 'closing_lobby' | 'completed' | 'cancelled';

export type StatusPhase = 'pre' | 'live' | 'done' | 'cancelled';

const LABEL_MAP: Record<SessionStatus, string> = {
  scheduled: 'Scheduled',
  lobby_open: 'Lobby open',
  round_active: 'Round active',
  round_rating: 'Rating',
  round_transition: 'Transition',
  closing_lobby: 'Closing lobby',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const COLOR_MAP: Record<SessionStatus, 'default' | 'success' | 'warning' | 'info' | 'error'> = {
  scheduled: 'default',
  lobby_open: 'info',
  round_active: 'success',
  round_rating: 'warning',
  round_transition: 'info',
  closing_lobby: 'warning',
  completed: 'default',
  cancelled: 'error',
};

const PHASE_MAP: Record<SessionStatus, StatusPhase> = {
  scheduled: 'pre',
  lobby_open: 'live',
  round_active: 'live',
  round_rating: 'live',
  round_transition: 'live',
  closing_lobby: 'live',
  completed: 'done',
  cancelled: 'cancelled',
};

export function sessionStatusLabel(s: string | undefined | null): string {
  return (s && LABEL_MAP[s as SessionStatus]) || 'Unknown';
}
export function sessionStatusColor(s: string | undefined | null) {
  return (s && COLOR_MAP[s as SessionStatus]) || 'default';
}
export function sessionStatusPhase(s: string | undefined | null): StatusPhase {
  return (s && PHASE_MAP[s as SessionStatus]) || 'pre';
}
```

- [ ] **Step 10.2: Replace usages**

- SessionDetailPage.tsx:317 → `<Badge variant={sessionStatusColor(session.status)}>{sessionStatusLabel(session.status)}</Badge>`
- AdminSessionsPage.tsx:16-20 → replace color map + use `sessionStatusLabel` for display
- LiveSessionPage.tsx STATE_CONFIG → delete local, import from shared util (or keep local if LiveSession has more context-specific labels like "Main Room"; in that case, let the util cover the generic case and LiveSession adds its overrides)

- [ ] **Step 10.3: Commit**

```bash
git commit -m "refactor: shared sessionStatusConfig for enum labels + colors (April 17 lobby_open display)"
```

---

## Task 11: MatchingOverlay text

**Why:** Shows "3 breakout rooms ready" — Stefan wants just "breakout rooms ready" without the count.

**Files:**
- Modify: `client/src/features/live/MatchingOverlay.tsx:56-59`

- [ ] **Step 11.1: Change the text**

```tsx
// BEFORE
${roomCount} breakout room${roomCount !== 1 ? 's' : ''} ready
// AFTER
breakout rooms ready
```

Keep the `roomCount = 0` fallback text as-is.

- [ ] **Step 11.2: Commit**

```bash
git commit -m "fix: matching overlay text simplified (April 17 screenshot item)"
```

---

## Task 12b: Remove "Wrapping up" + "All rounds complete" overlay (screenshot addendum)

**Why:** Stefan sent a screenshot (2026-04-17 via WhatsApp, "everything is working. we might want to remove this messaging which goes wrapping up"). Shows:
- Header: "Wrapping up · Round 5 of 5" — should just be "Round 5 of 5"
- Sub-header: "Wrapping up..."
- Giant centered overlay: sparkle icon + "All rounds complete" + "3 participants + host connected" + Compact/Normal/Spacious options

Both "Wrapping up" occurrences AND the "All rounds complete" overlay must be removed. Header should just read "Round 5 of 5" with no wrapping-up suffix, no overlay.

**Files to investigate (likely):**
- `client/src/features/live/LiveSessionPage.tsx` — top header phase text (`STATE_CONFIG` per audit — "closing_lobby" → "Wrapping up")
- Possibly `MatchingOverlay.tsx` or a separate `RoundsCompleteOverlay.tsx` component
- `client/src/hooks/useSessionSocket.ts` — the phase state transitions and what phase triggers the overlay

- [ ] **Step 12b.1: Find the "Wrapping up" text sources**

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN" && grep -rn "Wrapping up\|All rounds complete\|wrapping up" client/src 2>/dev/null | head -20
```

- [ ] **Step 12b.2: Replace closing_lobby label**

In whatever STATE_CONFIG / status-label map handles the live-session header during `closing_lobby`: remove "Wrapping up · " prefix. Show just "Round X of Y" — keep the round counter until session transitions to completed.

If the Task 10 `statusConfig.ts` util already covers this, update the label there: `closing_lobby: 'Round X of Y'` (but this is dynamic — the label needs access to currentRound/totalRounds). Alternative: leave `closing_lobby` out of the phase label entirely and let the UI compose "Round X of Y" from session state.

- [ ] **Step 12b.3: Remove the "All rounds complete" overlay**

Find and delete the overlay component invocation. It should render NOTHING during `closing_lobby` / `completed` phases beyond the regular layout + recap link.

Users navigate to the recap via a separate action (click "View Recap" on event detail page post-event). No need for a blocking celebration overlay.

- [ ] **Step 12b.4: Preservation check**

- Session `closing_lobby` status still transitions correctly → user sees normal video/chat UI, just without the "wrapping up" chrome
- `completed` status still routes user back to dashboard or recap page (existing behavior)
- Change 4.5 lobby chat during closing_lobby still works

- [ ] **Step 12b.5: Commit**

```bash
git commit -m "fix: remove 'Wrapping up' header + 'All rounds complete' overlay (April 17 screenshot addendum)"
```

---

## Task 12: Video tile displayName + grey space

**Why:** When partner's `displayName` is missing, email (e.g., `an@avivson.com`) shows in large grey space. Stefan wants a cleaner fallback + less grey.

**Files:**
- Modify: `client/src/features/live/VideoRoom.tsx:42-61` (VideoTile component)

- [ ] **Step 12.1: Add displayName fallback helper**

At the top of VideoRoom.tsx or in a utility file:
```tsx
function userDisplayLabel(input?: { displayName?: string | null; email?: string | null } | string): string {
  if (!input) return 'Partner';
  if (typeof input === 'string') {
    return input.includes('@') ? input.split('@')[0] : input;
  }
  if (input.displayName && input.displayName.trim()) return input.displayName.trim();
  if (input.email) return input.email.split('@')[0];
  return 'Partner';
}
```

- [ ] **Step 12.2: Update VideoTile label rendering**

Find the label div at lines 58-60 (`<div className="absolute bottom-2 left-2 bg-black/60 rounded px-2 py-1 text-xs text-white">{label}</div>`):

Change to:
```tsx
<div className="absolute bottom-2 left-2 bg-black/60 rounded px-2 py-1 text-xs text-white max-w-[60%] truncate">
  {label}
</div>
```

`max-w-[60%] truncate` prevents overflow into grey area when name is long.

- [ ] **Step 12.3: Ensure all call sites use userDisplayLabel**

Where VideoTile is called with a label (lines 86, 134, 146, 161 per audit), replace `rt.participant.name || currentPartners[i]?.displayName || 'Partner'` with `userDisplayLabel(rt.participant?.name || currentPartners[i])`.

- [ ] **Step 12.4: Commit**

```bash
git commit -m "fix: video tile displayName fallback + truncation (April 17 screenshot item)"
```

---

## Task 13: Extend per-room breakout timer

**Why:** No handler exists to extend an individual host-created breakout room's timer. Host can only extend session-level round timer. Feature request: let host extend any specific room.

**Files:**
- Modify: `server/src/services/orchestration/handlers/host-actions.ts` (add handleHostExtendBreakoutRoom)
- Modify: `server/src/services/orchestration/timer-manager.ts` (if it tracks per-room timers)
- Modify: `client/src/hooks/useSessionSocket.ts` (ensure timer:sync from this path is handled — should already work)
- Modify: `client/src/features/live/HostControls.tsx` (UI: +2 min button on each room in the dashboard)

- [ ] **Step 13.1: Add server-side handler**

In `host-actions.ts`, add a new socket event handler:

```typescript
export async function handleHostExtendBreakoutRoom(
  io: SocketServer,
  socket: Socket,
  data: { sessionId: string; matchId: string; additionalSeconds: number },
): Promise<void> {
  const { sessionId, matchId, additionalSeconds } = data;
  // Verify requester is host
  const session = await sessionService.getSessionById(sessionId);
  if (!session || session.hostUserId !== socket.data.userId) {
    return socket.emit('error', { message: 'Only the host can extend a breakout room.' });
  }
  // Find the per-room timer state
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) return;
  const roomTimer = activeSession.roomTimers?.get(matchId);
  if (!roomTimer) {
    return socket.emit('error', { message: 'Breakout room timer not found.' });
  }
  // Extend end time
  roomTimer.endsAt = new Date(roomTimer.endsAt.getTime() + additionalSeconds * 1000);
  // Reschedule the timeout
  if (roomTimer.timeoutHandle) clearTimeout(roomTimer.timeoutHandle);
  const msRemaining = roomTimer.endsAt.getTime() - Date.now();
  roomTimer.timeoutHandle = setTimeout(() => { /* existing room-end logic */ }, msRemaining);
  // Broadcast timer:sync to participants in this match's room
  const match = await matchingService.getMatchById(matchId);
  if (match) {
    const userIds = [match.participantAId, match.participantBId, match.participantCId].filter(Boolean);
    for (const uid of userIds) {
      io.to(userRoom(uid!)).emit('timer:sync', {
        segmentType: 'breakout_room',
        matchId,
        secondsRemaining: Math.ceil(msRemaining / 1000),
        totalSeconds: Math.ceil((roomTimer.endsAt.getTime() - roomTimer.startedAt.getTime()) / 1000),
      });
    }
  }
  logger.info({ sessionId, matchId, additionalSeconds }, 'Host extended breakout room');
}
```

Register this handler in the socket event router (wherever `host:extend_round` is currently registered — add `host:extend_breakout_room` alongside).

- [ ] **Step 13.2: Client UI**

In `client/src/features/live/HostControls.tsx`, the per-room dashboard row — add a "+2 min" button:

```tsx
<button
  onClick={() => socket.emit('host:extend_breakout_room', { sessionId, matchId: room.matchId, additionalSeconds: 120 })}
>
  +2 min
</button>
```

- [ ] **Step 13.3: Preservation check**

The existing `timer:sync` listener in `useSessionSocket.ts:511-521` handles per-room sync (per Change 4.5 commit `cb66184`). Verify it still fires correctly when our new `timer:sync` event arrives from this handler.

- [ ] **Step 13.4: Test + commit**

```bash
git commit -m "feat: host can extend individual breakout room timer (April 17 item #11)"
```

---

## Task 14: Bulk manual-breakout-room controls

**Why:** Stefan wants host to:
- Create N manual breakout rooms at once with a shared timer
- Choose timer visibility (hidden/visible)
- Extend all manual rooms by X min
- Set all manual rooms to same duration
- End all manual rooms at once
- End a specific manual room (already exists)
- Start all rooms at once

**Files:**
- Create: `server/src/services/orchestration/handlers/breakout-bulk.ts`
- Modify: `server/src/services/orchestration/orchestration.service.ts` (register handlers)
- Modify: `server/src/db/migrations/038_breakout_bulk.sql` (if `timer_visibility` needs to persist per match)
- Modify: `client/src/features/live/HostControls.tsx` (UI: bulk-create modal + bulk-control buttons)

- [ ] **Step 14.1: Schema decision**

Timer visibility: add a `timer_visibility VARCHAR(10) DEFAULT 'visible'` column to the `matches` table, OR store it on the session config, OR keep it in-memory (lost on restart). Decision: add to matches — `visible` | `hidden`. Migration 038.

```sql
-- 038_breakout_bulk.sql
ALTER TABLE matches ADD COLUMN IF NOT EXISTS timer_visibility VARCHAR(10) NOT NULL DEFAULT 'visible';
-- 'visible' or 'hidden' — controls whether participants see the countdown
COMMENT ON COLUMN matches.timer_visibility IS 'Breakout room timer visibility to participants. Set at creation time.';
```

- [ ] **Step 14.2: Socket event — bulk create**

New event: `host:create_breakout_bulk`

Payload:
```typescript
{
  sessionId: string;
  rooms: Array<{ participantIds: string[]; roomName?: string }>;
  sharedDurationSeconds: number;
  timerVisibility: 'visible' | 'hidden';
}
```

Handler (in `breakout-bulk.ts`):
1. Verify requester is host
2. Validate each room's participant list (users present in session, not in active match)
3. For each room, create a match (status='active'), LiveKit room, and per-room timer with `sharedDurationSeconds`
4. Persist `timer_visibility` on each match row
5. Broadcast `match:assigned` to each participant + `timer:sync` with visibility flag
6. Emit `host:dashboard_update` with the new rooms

- [ ] **Step 14.3: Socket event — bulk extend**

New event: `host:extend_breakout_all` — payload `{ sessionId, additionalSeconds }` — iterate all active manual breakout rooms (matches with `room_id LIKE '%-host-%'` per Change 4.5 naming), call the Task 13 extend logic for each.

- [ ] **Step 14.4: Socket event — bulk end**

New event: `host:end_breakout_all` — payload `{ sessionId }` — iterate active manual rooms, for each: mark match as `completed`, emit `match:return_to_lobby` to participants, close LiveKit room, clear per-room timer.

- [ ] **Step 14.5: Socket event — bulk set duration**

New event: `host:set_breakout_duration_all` — payload `{ sessionId, durationSeconds }` — for each active manual room, compute newEndsAt = startedAt + durationSeconds, update roomTimer, broadcast timer:sync.

- [ ] **Step 14.6: Socket event — bulk start**

New event: `host:start_breakout_all` — if any manual rooms are in 'scheduled' status (not yet started), transition them all to 'active' simultaneously. (Only useful if we support pre-created-then-started flow; may be optional for v1.)

- [ ] **Step 14.7: Client — bulk-create modal**

In `client/src/features/live/HostControls.tsx`:
- Add "Create breakout rooms" primary button — opens modal
- Modal: table of rooms with "+ Add Room" button, each row has participant multi-select, optional room name
- Below table: shared duration picker (3/5/10/15/20/30 min or custom) + visibility toggle (Visible / Hidden)
- "Create All" button → emits `host:create_breakout_bulk`

- [ ] **Step 14.8: Client — bulk-control panel**

Below the dashboard of active rooms, add bulk-control panel:
- "+2 min to all" (extend_breakout_all)
- "End all" (end_breakout_all) — confirmation dialog
- Duration dropdown + "Apply to all" (set_breakout_duration_all)

- [ ] **Step 14.9: Client — respect timer visibility**

In `client/src/features/live/VideoRoom.tsx` (the breakout timer display):
- If `match.timerVisibility === 'hidden'` → don't render the countdown at all
- Otherwise render as today

Backend must include `timerVisibility` in the `match:assigned` payload. Check the existing payload shape in `handleHostCreateBreakout` and extend it.

- [ ] **Step 14.10: Tests**

Unit test each bulk handler in `server/src/__tests__/services/orchestration/breakout-bulk.test.ts`:
- bulk create: happy path (3 rooms, 6 participants, 10 min, visible) → 3 matches inserted, 3 LiveKit rooms created, 6 `match:assigned` emits
- bulk extend: 2 active rooms → both extended, 2 timer:sync emits
- bulk end: 3 rooms → all marked completed, 3 return_to_lobby emits, LiveKit rooms closed

- [ ] **Step 14.11: Preservation**

- Change 4.5 `clearRoomTimers(matchId)` still called on each room's end (ghost timer fix)
- match_status transitions obey Change 4.6 state machine: active → completed on end
- rating window still opens for participants at the end of each room
- `findIsolatedParticipants` still works if a participant leaves a bulk room

- [ ] **Step 14.12: Commit**

```bash
git commit -m "feat: bulk manual breakout room controls (create/extend/end/set-duration/start-all) — April 17 item #13"
```

---

## Task 15: Domain cutover (Vercel proxy)

**Why:** Google OAuth consent screen currently shows `rsn-api-h04m.onrender.com`. User wants `app.rsn.network`. Strategy: Vercel rewrites `/api/*` to Render, then OAuth redirect_uri becomes `https://app.rsn.network/api/auth/google/callback`.

**Files:**
- Create OR modify: `client/vercel.json`
- Modify: `server/src/config/index.ts` (or more likely: update `API_BASE_URL` env var on Render)
- NOT modified by us: Google Cloud Console (Stefan does this), Vercel project (Stefan confirms custom domain), Render env var (I do this after Stefan confirms)

- [ ] **Step 15.1: Add `client/vercel.json` rewrite**

Check if file exists. If yes, add to existing rewrites. If no, create:

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://rsn-api-h04m.onrender.com/api/:path*" }
  ]
}
```

**Important:** After Vercel proxies, cookies set by the API will be on `app.rsn.network` domain. Verify CORS + cookie configs on the server don't break. Check `server/src/index.ts` for CORS origin list; must include `https://app.rsn.network`.

- [ ] **Step 15.2: Check CORS**

```bash
grep -rn "cors\|CORS_ORIGIN\|allowedOrigins" server/src/index.ts server/src/config 2>/dev/null | head -10
```

If `allowedOrigins` is a list that already includes `https://app.rsn.network`, we're good. If not, add it (already should be there — it's the production client URL).

- [ ] **Step 15.3: Commit the Vercel rewrite**

```bash
git add client/vercel.json
git commit -m "feat: Vercel proxies /api/* to Render for one-domain OAuth branding (April 17 item #1)"
```

- [ ] **Step 15.4: Coordination with user (Stefan)**

Message Stefan:
> "OAuth domain cutover steps: (1) Confirm `app.rsn.network` is primary domain on Vercel rsn-client project, (2) Go to Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client → Authorized redirect URIs: ADD `https://app.rsn.network/api/auth/google/callback` (don't remove the existing Render URL yet). Reply when done — I'll flip the env var and test."

**Wait for Stefan's confirmation.**

- [ ] **Step 15.5: After Stefan confirms, update Render env var**

Via Render API:
```bash
curl -X PATCH \
  -H "Authorization: Bearer <RENDER_TOKEN>" \
  -H "Content-Type: application/json" \
  https://api.render.com/v1/services/srv-d6namvvtskes73f9oru0/env-vars \
  -d '[{"key":"API_BASE_URL","value":"https://app.rsn.network"}]'
```

Render will auto-redeploy.

- [ ] **Step 15.6: Verify**

After redeploy:
1. Test Google OAuth flow from `app.rsn.network/login` — consent screen should now show `app.rsn.network`, NOT `rsn-api-h04m.onrender.com`
2. Test magic-link email — link still works
3. Check Sentry for any auth errors in the 10 minutes after cutover

- [ ] **Step 15.7: Cleanup**

After 24h of stable operation, message Stefan to REMOVE the old Render URL from Google Cloud Console (stops accepting OAuth from the legacy host).

---

## Task 16: Deploy, check_hole, progress.md, Stefan message

- [ ] **Step 16.1: Push to staging**

```bash
cd "C:/Users/ARFA TECH/Desktop/RSN" && git push origin staging
```

- [ ] **Step 16.2: Watch CI**

```bash
gh run list --branch staging --limit 1 --json databaseId | python -c "import sys,json; print(json.loads(sys.stdin.read())[0]['databaseId'])" | xargs -I{} gh run watch {} --exit-status
```

- [ ] **Step 16.3: Fast-forward main**

```bash
git checkout main && git merge --ff-only staging && git push origin main && git checkout staging
```

- [ ] **Step 16.4: Watch Render deploy**

```bash
until [ "$(curl -s -H "Authorization: Bearer <RENDER_TOKEN>" "https://api.render.com/v1/services/srv-d6namvvtskes73f9oru0/deploys?limit=1" | python -c "import sys,json; print(json.loads(sys.stdin.read())[0]['deploy']['status'])")" = "live" ]; do sleep 30; done
```

- [ ] **Step 16.5: Full check_hole**

Per `feedback_check_hole.md` — all 10 checks.

- [ ] **Step 16.6: Update progress.md**

Append a "Change 4.7 — April 17 Feedback" section listing all 17 items, commits, migrations (038), deploys, and the domain cutover timing.

- [ ] **Step 16.7: Commit progress.md, push both branches, wait for CI on progress.md push, FF main**

- [ ] **Step 16.8: Stefan message** (per `feedback_stefan_messages.md` — 4-5 lines, human tone)

Draft to adapt based on whether domain cutover completed:

> Morning Stefan — shipped the April 17 feedback set (17 items). Highlights: mandatory onboarding with full profile fields, connected-users-only invite search, access-gated event pages, bulk manual breakout controls (create N rooms with shared timer, extend/end all), host controls cleaned up, and the OAuth branding cutover via Vercel. Ready for your next test when you are.

---

## Self-Review Checklist

**Spec coverage — 17 items → 16 fix tasks + 1 deploy:**

| Doc item | Task | Notes |
|---|---|---|
| 1 Domain | 15 | Infra coordination |
| 2 Deactivation re-activation | 4 | Cache invalidation |
| 3 Invite account creation | 6 | Depends on Task 1 |
| 4 Invite 999 cap | 5 | Zod cap removal |
| 5 Onboarding missing | 1 | Mandatory + 4 added fields |
| 6 Auto-registration | 7 | Deep audit |
| 7 Invite unknown users | 2 | encounter_history filter |
| 8 Pending invites placement | 8 | JSX reorder |
| 9 Event access messaging | 3 | Route gate |
| 10 Host control redundancy | 9 (+10 dep) | statusConfig + consolidation |
| 11 Breakout timer | 13 | Per-room extend |
| 12 Registration state mismatch | 7 | (same as #6) |
| 13 Global breakout control | 14 | Biggest feature |
| Screenshot: "lobby_open" | 10 | statusConfig |
| Screenshot: "breakout rooms ready" | 11 | Text change |
| Screenshot: grey tile | 12 | displayName fallback |
| Screenshot: duration during event | 13 | Part of extend |

**Preservation — Change 4.5 + 4.6:**

- Ghost timer `clearRoomTimers` — preserved in Tasks 13, 14 (bulk end calls clear on each room)
- match_status state machine — preserved in Task 14 (active → completed on bulk end)
- rating on all leave/remove paths — preserved in Task 14 (bulk end emits rating window)
- no_show only via detectNoShows — preserved (bulk end uses 'completed', not 'no_show')
- LiveKit closeRoom debug-on-404 — no changes to livekit.provider.ts

**Risk map:**

- HIGH: Task 14 (bulk breakout) — new feature, large surface, many moving parts
- MED: Task 1 (onboarding), Task 3 (access control), Task 9 (host controls refactor), Task 15 (domain cutover)
- LOW/NIL: everything else

**Sequence rationale:**
1. Task 1 (onboarding) first so Task 6 (invite LoginPage) can rely on onboarding gate
2. Tasks 2–5 are parallelizable (invite filter, access control, deactivation, cap)
3. Task 10 (statusConfig) unblocks Task 9 (host controls)
4. Task 13 before Task 14 (per-room extend is the primitive for bulk extend)
5. Task 15 last among fixes (requires Stefan coordination; don't hold up other work)
6. Task 16 deploys everything

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-04-17-april-17-feedback-fixes.md`.

**Recommended: subagent-driven execution** (fresh subagent per task + two-stage review, same as Change 4.6).

Ready to start Task 1 (Onboarding)?
