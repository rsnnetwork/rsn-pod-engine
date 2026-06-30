# SDD 05 — M3 rating family + M2 left-vs-removed + presence flap + ghost matching

Part of the RSN 30-50 scale fix programme. Baseline: `june9-punchlist` @ `4717268`. Read `SDD-00-MASTER.md` first for ground rules, ship order, and process.

**Review verdict for this cluster: needs-changes.** Every issue listed under a work item below is a REQUIRED amendment to that item's design — apply the issue's suggestion over the original text wherever they conflict.

## Cluster notes (designer)

Verification status: every audit citation in this cluster was re-verified against branch june9-punchlist @ 3cf1187 and is accurate, with these refinements: (1) the M2 eviction is at state-snapshot.ts:195 (`st === 'removed' || st === 'left'`), and generateLiveKitToken (session.service.ts:756-760) ALSO rejects 'left' — so the RAT-1 fix must flip status BEFORE minting, which is why the re-entry reset runs inside the resync's guarded branch rather than relaxing the token gate (the token gate's 'left' check is pinned by june11-kick-token-and-cohost.test.ts and must stay). (2) The M3a race is two-headed exactly as described: the COUNT at rating.service.ts:211-215 precedes the FOR UPDATE at 218, and the no-ON-CONFLICT INSERT is at 245-250; encounter_history's UNIQUE(user_a_id,user_b_id) exists since 001_initial_schema.sql:267. (3) For M3b, the rating:skip reference path (participant-flow.ts:1414-1431) is UNGUARDED — wrapHandler (orchestration.service.ts:92-106) is try/catch only — so the REST path stays unguarded too; the io plumbing reuses orchestration.service's own module-level `io` via a wrapper around the existing re-export at line 424, mirroring the setHostActionsIo precedent (host-actions.ts:2325-2330). (4) upsertRatingForMeeting has exactly one production caller (rating.service.ts:160), so the M3d signature change is contained. (5) The presence-flap sweep is startHeartbeatStaleDetection at participant-flow.ts:1926-1961; the read-side fetchSockets union pattern to copy lives at participant-state-machine.ts:510-523 and participant-flow.ts:1542-1551. (6) The ghost-matching union is getPresentUserIds (matching-flow.ts:71-110), whose source is pin-frozen by may24-presence-livekit-reconcile.test.ts — hence RAT-6 adds a NEW strict helper instead of modifying it, and the host-visible reason rides the existing Bug-B bye-reason surface (matching-flow.ts:1201-1215 → HostControls.tsx:494-495 renders `name (reason)` generically, zero client work). (7) The trio C-slot bug is confirmed: branch 1 of the getUnratedPartners CTE (rating.service.ts:799-803) catches C-slot rows in its ELSE (partner=A) and branch 3 (834-837) also resolves to A — A duplicated, B never emitted.

Library capabilities confirmed: socket.io ^4.7 (server/package.json:36) — io.in(room).fetchSockets() with serialized .data on remote sockets is used today in three places; pg ^8.12 (server/package.json:31) — PoolClient.query is call-compatible with the module-level query helper, enabling the Pick<PoolClient,'query'> param. No new dependencies anywhere in the cluster.

Recommended ship order (one fix per deploy, headed smoke between): RAT-1 → RAT-2 → RAT-4 → RAT-3 → RAT-5 → RAT-6 → RAT-7. Hard dependency: RAT-4 after RAT-2 (the meeting-records deadlock-freedom argument relies on RAT-2's encounter-row lock being the established same-pair serialization point). Soft ordering: RAT-6 after RAT-5 (non-flapping presenceMap improves the 30s heartbeat signal). RAT-1, RAT-3, RAT-5, RAT-7 are fully independent. All seven items are server-only: no migrations, no env vars, no render.yaml edits, no client deploys, and all are safe under Render's two-instance deploy overlap.

Cross-cluster boundaries honored: M3c (timer clear/re-arm status re-check) and the C4 round-lifecycle guard work are NOT touched by RAT-3 (explicitly scoped out); the REST snapshot seq-guard and join-cost items (M1/M10/C3) belong to other clusters; RAT-6 deliberately leaves repairFutureRounds, breakout-bulk, and transitionToRound's fallback generation on the loose union. One watch-out for whoever owns C3: RAT-3 adds one fetchSockets per REST rating submission — fine at 50 users, but if the C3 cluster adds rating-burst coalescing, these can share a debounce.

---

## RAT-1 — M2: handleResync treats only status='removed' as terminal; 'left' becomes explicit re-entry

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/state-snapshot.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/participant-state-machine.ts`

### Problem

handleResync (state-snapshot.ts:183-199) emits session:evicted{reason:'removed_from_event'} when session_participants.status is 'removed' OR 'left'. But 'left' is NOT terminal: the 30s reconciler (participant-state-machine.ts:451-537) escalates anyone disconnected >90s (backgrounded phone) to 'left', and the FSM explicitly allows LEFT → IN_MAIN_ROOM as 'explicit re-entry' (LEGAL_TRANSITIONS, participant-state-machine.ts:117). On return the client emits session:join (guarded, queued behind withSessionGuard) and session:resync (unguarded, orchestration.service.ts:276) back-to-back (useSessionSocket.ts:169/175, 1198/1203, 1244/1248); the unguarded resync reads status before the guarded join's Fix-A reset (participant-flow.ts:679-690) flips it, wins the race, and the client shows a sticky 'You have been removed from this event.' screen (useSessionSocket.ts:348-365 sets removedFromEvent=true on that reason).

### Design

Server-only change, two parts.

(1) NEW helper in participant-state-machine.ts (the chokepoint's home — deliberately NOT extracted from participant-flow's Fix-A block, which is pinned by 3 source-pin tests):
  export async function reEnterLeftParticipant(sessionId: string, userId: string): Promise<boolean>
Contract: read session_participants.status for (sessionId,userId); if status !== 'left' return false (no-op). Verify no active match exists for the user (same SELECT id FROM matches WHERE session_id=$1 AND status='active' AND (participant_a_id=$2 OR participant_b_id=$2 OR participant_c_id=$2) LIMIT 1 used at participant-flow.ts:640-646); if an active match exists, return false. Otherwise call transitionParticipant(sessionId, userId, ParticipantState.IN_MAIN_ROOM) — the FSM validates LEFT→IN_MAIN_ROOM, projects to DB 'in_lobby', clears left_at, and patches canonical location. Return result.ok. Must NOT acquire withSessionGuard itself (caller holds it).

(2) In handleResync (state-snapshot.ts:188-199): keep the existing status lookup. Change the terminal branch from `st === 'removed' || st === 'left'` to ONLY `st === 'removed'` → emit session:evicted{reason:'removed_from_event'} and return (this branch must stay BEFORE buildYou — pinned by june11-kick-token-and-cohost.test.ts:53-63). Add a new branch for `st === 'left'`:
  - import withSessionGuard from './session-state' (module already imports userRoom/activeSessions from there).
  - await withSessionGuard(data.sessionId, async () => { re-read status fresh (the join may have already reset it, or a kick may have landed): if 'removed' → set a local evicted flag; if 'left' → await reEnterLeftParticipant(...) (dynamic import of '../participant-state-machine' is fine; static import also acceptable, no cycle). });
  - if evicted flag → emit session:evicted and return.
  - Re-read the canonical doc (readCanonical) AFTER the guard so base.seq and the user's entry are fresh; if the user's canonical entry is missing or connState still 'left', fall back to the existing Ship-C synthetic main-room `p` (state-snapshot.ts:168-179 pattern). Then proceed to the normal buildYou(…, true) + state:snapshot emit.
Why guard only the 'left' branch: the normal resync path stays fast (no coupling to the M1 join-serialization cliff); the rare left-re-entry path serializes with the concurrent guarded join so both orders converge — if join's Fix-A ran first the re-read sees 'in_lobby' and reEnterLeftParticipant no-ops; if resync wins, the join's Fix-A later finds nothing to reset (idempotent).

Token behavior: generateLiveKitToken (session.service.ts:756-760) rejects status 'left' AND 'removed' (pinned by june11 test) — do NOT relax that gate. Because the re-entry reset runs BEFORE buildYou, the status is 'in_lobby' at mint time and the mint succeeds through the existing chokepoint.

Client contract (NO client change required): while the resync is queued behind the guard, the client stays in its current 'lobby' joining/connecting state. It must never see the removed screen unless reason==='removed_from_event', which the client already gates on (useSessionSocket.ts:355). After the snapshot lands, the `you` block carries location {type:'main'} + token + lobby roomId and the client renders the main room. Roster self-state may read 'left' for one heartbeat until presence:ready flips canonical connState — acceptable, document in code comment.

Edge cases: (a) session not in activeSessions (event over) → transitionParticipant returns NO_ACTIVE_SESSION, helper returns false, resync proceeds token-less (buildYou's mint fails and degrades, existing behavior); (b) kick landing while queued → fresh re-read sees 'removed' → evict; (c) status lookup failure → existing best-effort catch stands (token gate still protects).

### Code sketch

````
// state-snapshot.ts — inside handleResync, replacing lines 194-198
const st = statusRow.rows[0]?.status;
if (st === 'removed') {
  socket.emit('session:evicted', { reason: 'removed_from_event' });
  return;
}
if (st === 'left') {
  // LEFT is NOT terminal (FSM: explicit re-entry). A live authenticated
  // socket asking to resync IS explicit re-entry. Serialize with the
  // guarded join so the two reset paths can't interleave.
  const { withSessionGuard } = await import('./session-state');
  let evicted = false;
  await withSessionGuard(data.sessionId, async () => {
    const fresh = await query<{ status: string }>(
      `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`,
      [data.sessionId, userId]);
    const fs = fresh.rows[0]?.status;
    if (fs === 'removed') { evicted = true; return; }
    if (fs === 'left') {
      const { reEnterLeftParticipant } = await import('./participant-state-machine');
      await reEnterLeftParticipant(data.sessionId, userId);
    }
  });
  if (evicted) { socket.emit('session:evicted', { reason: 'removed_from_event' }); return; }
  const freshDoc = await readCanonical(data.sessionId);
  if (freshDoc) { /* rebuild base + p from freshDoc; keep synthetic-main fallback */ }
}
// ... fall through to existing buildYou(data.sessionId, userId, p, true) + emit

// participant-state-machine.ts — new export, place after setPresence
export async function reEnterLeftParticipant(sessionId: string, userId: string): Promise<boolean> {
  const cur = await query<{ status: string }>(
    `SELECT status FROM session_participants WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId]);
  if (cur.rows[0]?.status !== 'left') return false;
  const active = await query<{ id: string }>(
    `SELECT id FROM matches WHERE session_id = $1 AND status = 'active'
       AND (participant_a_id = $2 OR participant_b_id = $2 OR participant_c_id = $2) LIMIT 1`,
    [sessionId, userId]);
  if (active.rows.length > 0) return false;
  const r = await transitionParticipant(sessionId, userId, ParticipantState.IN_MAIN_ROOM);
  return r.ok;
}
````

### Tests to add

- NEW server/src/__tests__/services/orchestration/resync-left-reentry.test.ts — source pins: handleResync slice contains `st === 'removed'` eviction but NOT `|| st === 'left'` in the eviction condition; contains reEnterLeftParticipant and withSessionGuard in the 'left' branch; the removed-eviction still precedes buildYou(.
- Same file, behavioral (reuse the canonical-100-shipA.test.ts harness style: mock ../../../db query, readCanonical, session.service): status='left' → expect NO session:evicted emit, expect transitionParticipant/reEnterLeftParticipant invoked, expect state:snapshot emitted with you.token; status='removed' → expect session:evicted and no snapshot; status='left' that flips to 'removed' inside the guard → evicted.
- Behavioral: reEnterLeftParticipant unit — status 'left' + no active match → transition called with IN_MAIN_ROOM; active match present → no transition, returns false; status 'in_lobby' → no-op.
- Headed Playwright prod smoke: user A joins live event; via test API/DB set A's session_participants.status='left' (simulates 90s reconciler escalation); A reloads the live page; assert the lobby video grid renders and the text 'You have been removed' is NEVER visible (assert on outcome over 15s window); assert A reappears in another participant's roster and is included in the next round's matching.

### Acceptance criteria

- A participant whose status is 'left' (reconciler escalation or explicit leave) who reopens the live page lands in the main room with a working LiveKit token on the FIRST load — no removed screen, no second manual refresh.
- A kicked ('removed') participant still gets session:evicted{removed_from_event} on resync and can never receive a snapshot token (june11 pins stay green).
- Concurrent session:join + session:resync from the same returning user converge to status 'in_lobby' with exactly one state-machine transition logged (no ILLEGAL_TRANSITION warnings).
- Full server test suite passes; june11-kick-token-and-cohost.test.ts, canonical-100-shipA.test.ts, disconnect-rejoin.test.ts, phase-2-state-machine-adoption.test.ts unchanged and green.

### Pinned tests to update

- None expected. Verify these stay green: server/src/__tests__/services/june11-kick-token-and-cohost.test.ts (removed-eviction before buildYou — preserved), server/src/__tests__/services/orchestration/canonical-100-shipA.test.ts (resync always mints — preserved for non-left users; its db mock returns no status row so the new branch is not entered), server/src/__tests__/services/orchestration/disconnect-rejoin.test.ts + phase-2-state-machine-adoption.test.ts (Fix-A block in participant-flow.ts untouched by design).

### Risks

Left-branch resyncs now queue behind withSessionGuard; during a post-deploy reconnect storm (M1, other cluster) a returning left user's snapshot may take seconds — still strictly better than a false removed screen. An explicitly-departed user who reopens the tab is silently re-entered — this matches the existing guarded-join Fix-A behavior (23 May rule: any present user with no active match must be matchable), so it is not a new policy. Canonical connState may lag 'left' for one heartbeat after re-entry (self-tile shows stale state briefly).

### Deploy notes

Server-only; no migration, no env var, no render.yaml change, no client deploy needed (client eviction handler already keys on reason). Safe under Render's two-instance deploy overlap: both code paths converge via DB status. Ship first in this cluster (highest user-facing pain).

### ⚠ Adversarial review — REQUIRED amendments

**[BLOCKER]** The spec's load-bearing premises for RAT-1 are now INVERTED by uncommitted changes sitting in the supposedly read-only repo — and those files changed DURING this review (mtimes 2026-06-13 00:50-00:52, while HEAD is still 3cf1187). Working tree: state-snapshot.ts already evicts ONLY 'removed' (line 199, the June-12 comment block); session.service.ts generateLiveKitToken already bars ONLY 'removed' (isActiveMember = status !== 'removed', no 'left' check); june11-kick-token-and-cohost.test.ts now pins the OPPOSITE of what the spec claims: expect(fn).not.toMatch(/status !== 'left'/) and expect(fn).not.toMatch(/st === 'removed' \|\| st === 'left'/). The spec instructs 'Token behavior: generateLiveKitToken rejects status left AND removed (pinned by june11 test) — do NOT relax that gate' and clusterNotes says 'the token gate's left check is pinned... and must stay'. An implementer following that literally (preserving/restoring the 'left' bar, or treating the eviction condition as still containing '|| st === left') would break the updated june11 pins and re-introduce the June-12 'left users stranded without tokens' regression. Additionally, half of RAT-1's problem statement (the sticky removed screen) is already fixed by these uncommitted edits; only the reEnterLeftParticipant/guarded re-entry half remains.

*Required action:* Before implementation: (1) reconcile with whoever owns the uncommitted working-tree changes (state-snapshot.ts, session.service.ts, june11 test, e2e/tests/_repro-left-stuck.spec.ts) — commit or adopt them as the RAT-1 baseline; (2) rewrite RAT-1's token-behavior paragraph: the gate bars only 'removed' and the june11 pin REQUIRES the absence of a 'left' check — do not re-add it; (3) re-scope RAT-1 to the remaining delta: the guarded 'left' branch + reEnterLeftParticipant so a resyncing left user is actually flipped to in_lobby (matchable) instead of merely receiving a token while staying status='left'.

**[NIT]** pinnedTestsToUpdate mis-describes the canonical-100-shipA.test.ts harness: 'its db mock returns no status row so the new branch is not entered'. shipA mocks redis/session.service/logger but does NOT mock ../../../db — the handleResync status lookup's dynamic db import hits the real pool and throws (connection refused in jest), swallowed by the existing try/catch, which is the actual reason the left branch is unreachable there. This stays true ONLY if the new left-branch code remains downstream of a successful status read inside that try/catch. An implementer who restructures the try/catch boundary (e.g. hoists the status query out to simplify the guard logic) would make shipA's 'resync always mints' test fail or hang on a real pool connect.

*Required action:* Correct the note and add an explicit constraint: the 'left' branch must only be reachable after the best-effort status read succeeds, inside the existing try/catch, so db-unavailable degrades to today's mint-and-degrade path (this is also the correct production fail-open behavior).

---

## RAT-2 — M3a: first-rater decision inside the encounter row lock + race-free encounter INSERT

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/rating/rating.service.ts`

### Problem

upsertEncounterHistory (rating.service.ts:184-252) runs the first-rater COUNT (lines 211-215) BEFORE acquiring the SELECT ... FOR UPDATE row lock (line 218). Two partners submitting simultaneously each see zero other ratings (the partner's rating row is uncommitted in the other transaction) → both increment times_met (double count). Worse, for a first-ever encounter (most of round 1) there is no row to lock; both transactions take the INSERT branch (lines 245-250) and the loser of the UNIQUE(user_a_id,user_b_id) race (001_initial_schema.sql:267) gets a 23505 → submitRating 500s with no client auto-retry. At 30-50 people the rating burst makes both interleavings routine.

### Design

Restructure upsertEncounterHistory into a single race-free flow: ensure-row → lock → decide → update. The encounter_history table has UNIQUE(user_a_id,user_b_id) and CHECK user_a_id < user_b_id (verified in 001_initial_schema.sql:253-268), so ON CONFLICT (user_a_id, user_b_id) is valid.

New statement order (all on the SAME transaction client param, unchanged signature):
1. INSERT ... ON CONFLICT (user_a_id, user_b_id) DO NOTHING with times_met = 0 and NULL meet-again sides — guarantees a row exists and, under concurrency, the second inserter waits on the first's speculative insert then no-ops.
2. SELECT ... FOR UPDATE (existing query at line 218, unchanged text) — now always finds a row; this is the critical-section gate. A concurrent same-pair rater blocks here until we commit.
3. The first-rater COUNT (move lines 211-215 here verbatim — keep the variable name isFirstRatingForThisMatch and the exact SQL text `SELECT COUNT(*)::text AS cnt FROM ratings WHERE match_id = $1 AND from_user_id <> $2` — both are pinned). In READ COMMITTED each statement takes a fresh snapshot, so after the lock wait this COUNT sees the partner's committed rating → exactly one of two concurrent raters increments.
4. The existing UPDATE (lines 229-239) becomes the ONLY write path — keep the pinned template `times_met = ${isFirstRatingForThisMatch ? 'times_met + 1' : 'times_met'}`. Merge meet-again sides from the locked SELECT exactly as today (meetAgainA/meetAgainB/mutual computation lines 224-227). Delete the old else-branch INSERT (lines 241-251).
Net effect: a brand-new pair goes 0 → 1 via the UPDATE on first rating; the second rating merges its side without incrementing; no 23505 possible.

Do NOT change trio semantics: the per-match COUNT discriminator (any other rating on the match suppresses the increment) is pre-existing Bug-6 behavior; concurrent CROSS-pair trio ratings (A→B vs C→B) lock different encounter rows and may both increment their own pairs — that is correct (different pairs) and unchanged.

Exact arithmetic contract (acceptance-testable): for any pair (X,Y) and any single match M, the sum of times_met increments attributable to M is exactly 0 or 1, regardless of submission concurrency; it is 1 when at least one of the pair's ratings on M is the first rating filed on M.

### Code sketch

````
// upsertEncounterHistory — new body order (signature unchanged)
// 1. ensure row (race-free anchor for the lock)
await client.query(
  `INSERT INTO encounter_history (id, user_a_id, user_b_id, times_met, last_met_at, last_session_id, mutual_meet_again)
   VALUES ($1, $2, $3, 0, NOW(), $4, FALSE)
   ON CONFLICT (user_a_id, user_b_id) DO NOTHING`,
  [uuid(), userAId, userBId, sessionId],
);
// 2. lock — critical section starts here (existing SELECT, unchanged)
const existing = await client.query(
  'SELECT id, last_meet_again_a, last_meet_again_b, last_session_id FROM encounter_history WHERE user_a_id = $1 AND user_b_id = $2 FOR UPDATE',
  [userAId, userBId]);
// 3. first-rater decision INSIDE the lock (moved, text unchanged — pinned)
const otherRatingsRes = (await client.query(
  `SELECT COUNT(*)::text AS cnt FROM ratings WHERE match_id = $1 AND from_user_id <> $2`,
  [matchId, fromUserId])) as { rows: { cnt: string }[] };
const isFirstRatingForThisMatch = otherRatingsRes.rows[0]?.cnt === '0';
// 4. single UPDATE path (existing SQL, template pinned). meetAgainA/B/mutual
//    computed from `existing.rows[0]` exactly as today. Delete the INSERT else-branch.
````

### Tests to add

- NEW server/src/__tests__/services/rating/encounter-race.test.ts — behavioral with a recording mock client (the rating.service.test.ts mock pattern): call upsertEncounterHistory and assert statement ORDER is [INSERT ... ON CONFLICT (user_a_id, user_b_id) DO NOTHING, SELECT ... FOR UPDATE, SELECT COUNT(*) ... FROM ratings, UPDATE encounter_history]; assert the COUNT statement index > FOR UPDATE statement index.
- Same file: when mock COUNT returns '0' the UPDATE text contains 'times_met + 1'; when '1' it does not; meet-again side merge respects isFromA on both first and second rater shapes (existing row with last_meet_again_a set).
- Source pin: upsertEncounterHistory contains ON CONFLICT (user_a_id, user_b_id) DO NOTHING and contains exactly one INSERT INTO encounter_history (the times_met=1 INSERT branch is gone).
- Headed Playwright prod smoke: 2-browser event, both users submit their round-1 ratings within the same second (Promise.all the two submit clicks); assert BOTH submissions return success (no error toast / no 500), then via recap+API assert encounter times_met === 1 for the pair and mutual flag correct. Repeat for a pair that already met (round 2 same-pair manual room) → times_met === 2.

### Acceptance criteria

- Two concurrent first-ever ratings on the same match: zero 500s, exactly one times_met increment, both meet-again sides recorded, mutual computed correctly.
- Two concurrent ratings between a pair that already has an encounter row: times_met increments by exactly 1 total for that match.
- phase-x-may-13-live-bugs.test.ts Bug-6 pins stay green without modification (variable name, COUNT SQL shape, times_met template preserved).
- Full local suite green.

### Pinned tests to update

- server/src/__tests__/services/phase-x-may-13-live-bugs.test.ts (Bug 6 block, lines 367-389) — should remain green if the implementer preserves: the identifier isFirstRatingForThisMatch, the COUNT SQL text `FROM ratings WHERE match_id = $1 AND from_user_id <> $2`, and the UPDATE template `times_met = ${isFirstRatingForThisMatch ? 'times_met + 1' : 'times_met'}`. If any of those are reworded, update these three pins in the same commit and say why.

### Risks

Lock hold time grows by one COUNT statement (~1ms) — negligible. The ensure-row INSERT briefly creates a times_met=0 row visible to other transactions only after commit, by which time step 4 has set it to ≥1 in the same transaction — no reader can ever observe 0 (single commit point). Rollback of the whole rating transaction removes the inserted row. Deadlock-free: every same-pair writer takes locks in the same order (encounter row first).

### Deploy notes

Server-only; no migration (UNIQUE constraint already exists since 001), no env vars. Independent deploy; recommend shipping before RAT-4 so the encounter row lock is the established serialization point the RAT-4 deadlock argument relies on.

### ⚠ Adversarial review — REQUIRED amendments

**[BLOCKER]** The unified ensure-row+single-UPDATE flow regresses trio encounters. Old code: a brand-new pair ALWAYS got times_met=1 via the unconditional INSERT branch (rating.service.ts:245-250, literal '1'), regardless of the per-match COUNT discriminator. New flow: the increment is gated for ALL pairs on isFirstRatingForThisMatch, whose pinned SQL counts ANY other rating on the match (rating.service.ts:212: FROM ratings WHERE match_id=$1 AND from_user_id<>$2) — not ratings between this pair. Trace for trio (A,B,C), match M, ratings in order A→B, A→C, B→A, B→C, C→A, C→B: pair (A,B) gets 1, pair (A,C) gets 1, but B→C and C→B both see prior ratings from other raters on M → 'not first' → pair (B,C) is created by the ensure-INSERT at times_met=0 and stays 0 forever. The spec's own 'exact arithmetic contract' (0 or 1 increment per match TOTAL) encodes this bug — for a trio match the correct total is one increment per DISTINCT PAIR (up to 3). Downstream: times_met>0 drives the 'met before' preview badges and platform_wide cross-event exclusion (matching-flow.ts:1074-1077 filters times_met>0), and getUserEncounters would list 'met 0 times' rows.

*Required action:* Scope the first-rater decision to the pair, not the match: e.g. COUNT ratings on this match where both from_user_id and to_user_id are in {userAId,userBId} and from_user_id <> fromUserId. This changes the pinned COUNT SQL (phase-x-may-13-live-bugs.test.ts:380-381) — update that pin in the same commit with justification, exactly as the spec's own escape hatch allows. Alternatively keep the per-match COUNT for the increment-suppression of EXISTING rows (preserving Bug-6 semantics and the pin) and add a separate 'pair has no prior rating on this match' check to force the 0→1 increment for rows the ensure-INSERT just created. Update the spec's arithmetic contract to 'exactly 0 or 1 increment per (pair, match)'.

**[IMPORTANT]** Missed pinned-test collision: server/src/__tests__/services/rating.service.test.ts (NOT listed in pinnedTestsToUpdate) has two behavioral tests ('should submit a rating for a completed match', lines 46-72, and 'allows rating a cancelled match within 30s', lines 115-145) whose transaction-client mock provides exactly 3 sequential responses in the OLD statement order: INSERT rating → SELECT encounter_history → INSERT encounter_history. Under the new order (INSERT rating → ensure-INSERT → SELECT FOR UPDATE → COUNT → UPDATE), the COUNT lands on an exhausted jest mock returning undefined, so `otherRatingsRes.rows[0]` throws TypeError, the transaction callback rejects, and both tests fail. (The empty-rows FOR UPDATE result also makes the merge read existing.rows[0] of an empty array — a second latent failure if the COUNT were mocked.)

*Required action:* Add rating.service.test.ts to pinnedTestsToUpdate: re-sequence both client mocks to [INSERT rating, ensure-INSERT, SELECT FOR UPDATE (return one row with null meet-again sides), COUNT (cnt:'0'), UPDATE] in the same commit. Also instruct the implementer to handle existing.rows[0] defensively (the ensure-INSERT guarantees a row in prod, but mocks won't).

---

## RAT-3 — M3b: plumb io + sessionId through the REST rating path so the fetchSockets rating-close reconciliation runs in prod

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/routes/ratings.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/orchestration.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/participant-flow.ts`

### Problem

checkAllRatingsCompleteByUserId (participant-flow.ts:1469-1600) unions presenceMap with live io.fetchSockets() before deciding who can still block the rating-window early close (lines 1542-1551) — but only when an `io` parameter is passed. The production client submits ratings via REST POST /ratings (routes/ratings.ts:30-44), which calls notifyRatingSubmitted(req.user!.userId) (line 38) → checkAllRatingsCompleteByUserId(userId) with NO sessionId and NO io (participant-flow.ts:1437-1439). Result in prod: sessionId resolution falls back to a presenceMap scan (stale) and the fetchSockets reconciliation is dead code — ghost presenceMap entries block the early close until the 90s backstop, and throttled-but-present users stop blocking and get the form yanked mid-typing. The guarded socket rails (rating:submit, rating:skip) already pass both (lines 1394, 1430).

### Design

Three small edits, no new accessor module — reuse the existing 'module holds io after init' pattern (host-actions.ts:2325-2330 setHostActionsIo; orchestration.service.ts itself holds `let io: SocketServer` set in initOrchestration, line 88/111).

(1) participant-flow.ts:1437 — widen the signature:
  export async function notifyRatingSubmitted(userId: string, matchId?: string, io?: SocketServer): Promise<void>
Body: if matchId given, resolve sessionId with one PK lookup `SELECT session_id FROM matches WHERE id = $1` (best-effort try/catch → undefined on failure), then await checkAllRatingsCompleteByUserId(userId, sessionId, io). Without matchId, legacy behavior (presenceMap scan) stands.

(2) orchestration.service.ts — replace the bare re-export (line 424 `export { notifyRatingSubmitted };`) with a thin wrapper that injects the module-level io: rename the import at line 38 to `notifyRatingSubmitted as notifyRatingSubmittedImpl`, then:
  export async function notifyRatingSubmitted(userId: string, matchId?: string): Promise<void> { return notifyRatingSubmittedImpl(userId, matchId, io); }
io is assigned in initOrchestration before the HTTP server accepts traffic (index.ts wiring), so it is always set when a REST rating arrives; if somehow undefined, the impl degrades to today's behavior.

(3) routes/ratings.ts:38 — pass the matchId: `notifyRatingSubmitted(req.user!.userId, req.body.matchId).catch(() => {});` (req.body.matchId is zod-validated as uuid).

Guard decision (explicit): do NOT wrap the REST notify in withSessionGuard. Reference behavior is the rating:skip socket path (participant-flow.ts:1414-1431), which calls checkAllRatingsCompleteByUserId directly with io and no guard (wrapHandler at orchestration.service.ts:92-106 is only try/catch — verified, no guard). checkAllRatingsCompleteByUserId is read-mostly + in-memory timer manipulation; serializing 25-50 concurrent REST rating notifies behind the session guard would queue them behind joins/leaves for no correctness gain this item claims (the timer-staleness re-check is M3c, owned by the round-lifecycle cluster). Keep the existing fire-and-forget .catch(() => {}).

### Code sketch

````
// participant-flow.ts:1437
export async function notifyRatingSubmitted(
  userId: string, matchId?: string, io?: SocketServer,
): Promise<void> {
  let sessionId: string | undefined;
  if (matchId) {
    try {
      const r = await query<{ session_id: string }>(
        `SELECT session_id FROM matches WHERE id = $1`, [matchId]);
      sessionId = r.rows[0]?.session_id;
    } catch { /* fall back to presenceMap scan inside the check */ }
  }
  await checkAllRatingsCompleteByUserId(userId, sessionId, io);
}

// orchestration.service.ts (line 38 import rename + replace line 424)
import { startHeartbeatStaleDetection, notifyRatingSubmitted as notifyRatingSubmittedImpl, ... } from './handlers/participant-flow';
export async function notifyRatingSubmitted(userId: string, matchId?: string): Promise<void> {
  return notifyRatingSubmittedImpl(userId, matchId, io);
}

// routes/ratings.ts:38
notifyRatingSubmitted(req.user!.userId, req.body.matchId).catch(() => {});
````

### Tests to add

- Extend server/src/__tests__/services/orchestration/stuck-at-rating.test.ts (behavioral harness already drives the real function): new case — call the new notifyRatingSubmitted('A', 'm1', io) where the db mock resolves session_id=SID for m1 and io.fetchSockets returns a live socket for non-rater 'B' with empty presenceMap → assert the window does NOT close (B blocks via live socket), mirroring the existing test at line 240. Second case: no live sockets, all rated → closes via the 3s grace.
- Source pin (same file or new june13 test): routes/ratings.ts contains `notifyRatingSubmitted(req.user!.userId, req.body.matchId)`; orchestration.service.ts wrapper passes `io` to the impl; participant-flow's notifyRatingSubmitted resolves `SELECT session_id FROM matches`.
- Headed Playwright prod smoke: 4-browser event (2 pairs). Pair 1 both submit via the real REST UI; pair 2 has one browser hard-killed mid-round so its presenceMap entry goes stale-present. Assert the rating window closes within ~5s of the last live participant's submission (NOT at the 90s backstop) — assert via the next-phase UI appearing, with a hard upper bound of 15s. Also assert a throttled-but-present user (background the tab, keep socket alive) who hasn't rated KEEPS the form open (no mid-typing yank).

### Acceptance criteria

- POST /ratings in production reaches checkAllRatingsCompleteByUserId with a non-undefined sessionId and io (assertable via the existing 'All ratings submitted — ending rating window early' log carrying the right sessionId immediately after REST-only submissions).
- Rating window early-close latency after the last present rater submits is ≤5s (3s grace + overhead) in the smoke, vs the 90s backstop today when a ghost entry exists.
- stuck-at-rating.test.ts suite green, including the new cases; rating:skip path behavior unchanged.
- Full local suite green.

### Pinned tests to update

- None. server/src/__tests__/services/may25-live-fixes.test.ts:190-196 (early-close source pins) and stuck-at-rating.test.ts existing cases remain green — the signature change is additive and the function body's pinned strings are untouched.

### Risks

Adds one matches PK lookup + one fetchSockets per REST rating: at a 50-user burst that is ≤50 fetchSockets over a few seconds; with the Redis adapter each is one round-trip (~ms). If this ever shows in latency, coalesce per (sessionId, 250ms) — note for later, not needed now. The decision to stay unguarded matches the skip path; the known TOCTOU on the shared timer (M3c) is explicitly out of scope here and owned by the round-lifecycle cluster — do not partially fix it in this item.

### Deploy notes

Server-only; no migration, no env vars, no client change. Independent deploy. Verify after deploy via Render logs: REST-only rating rounds log the early-close line with the correct sessionId.

---

## RAT-4 — M3d+M3e: meeting_records writes use the rating transaction's client (atomic, no nested pool acquisition)

**Priority:** P1
**Depends on:** RAT-2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/meeting-records/meeting-records.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/rating/rating.service.ts`

### Problem

submitRating wraps its work in transaction(client => …) (rating.service.ts:120-177) but the meeting_records step calls upsertRatingForMeeting (lines 160-169) which uses the MODULE-LEVEL query (meeting-records.service.ts:29, 111-131) — i.e. it acquires a SECOND pool connection while the transaction's connection is held. At ≥25 concurrent submissions against the 25-connection pool, every transaction holds one connection and waits for a second → pool starvation freeze in ~10s waves (M3d). And because those writes run on a different connection, they commit independently of the rating: a rollback leaves meeting_records updated (or vice versa), drifting recap counts; the 'recap will rebuild' promised in the catch comment (rating.service.ts:170-173) does not exist (M3e).

### Design

(1) meeting-records.service.ts — widen upsertRatingForMeeting to accept an optional DB executor, defaulting to the module query (same convention as upsertEncounterHistory's `client` param):
  export async function upsertRatingForMeeting(input: {...unchanged...}, client?: Pick<PoolClient, 'query'>): Promise<void>
Inside, `const db = client ?? { query };` and replace both `await query(` calls (lines 111 and 123) with `await db.query(` — SQL text unchanged (the EXCLUDED.* strings are pinned). Import type PoolClient from 'pg' (pg ^8.12, PoolClient.query is call-compatible with the module helper; calling db.query keeps correct `this` binding for the real client).

(2) rating.service.ts submitRating — inside the transaction callback, keep the dynamic import and the call position (both pinned: import + call after upsertEncounterHistory), pass the transaction client, and REMOVE the try/catch so a meeting-records failure aborts the whole transaction (atomic with the rating):
  const { upsertRatingForMeeting } = await import('../meeting-records/meeting-records.service');
  await upsertRatingForMeeting({ ...same fields... }, client);
Delete the catch block and its misleading comment; the route's error middleware turns a rare failure into a 5xx the client can retry, and the data can no longer half-commit.

(3) Caller audit (performed — exhaustive): upsertRatingForMeeting has exactly ONE production caller, rating.service.ts:160. recordMeeting/recordRoundMeetings (called from finalizeRoundRatings outside any transaction) keep using module query — out of scope, do not touch. No other signature impact.

Deadlock note for the implementer: with RAT-2 in place, same-pair concurrent raters are serialized by the encounter_history row lock BEFORE reaching the meeting_records upserts, and each transaction touches exactly the two directed rows (rater,partner)/(partner,rater) for its own pair — cross-pair transactions touch disjoint meeting_records rows (unique key session,round,user,partner). No lock-order inversion exists. This is why RAT-2 should ship first.

### Code sketch

````
// meeting-records.service.ts
import type { PoolClient } from 'pg';
export async function upsertRatingForMeeting(
  input: { sessionId: string; roundNumber: number; matchId: string;
           raterUserId: string; ratedUserId: string;
           qualityScore: number | null; meetAgain: boolean },
  client?: Pick<PoolClient, 'query'>,
): Promise<void> {
  const db = client ?? { query };
  await db.query(`INSERT INTO meeting_records (... rater row ...) ON CONFLICT (session_id, round_number, user_id, partner_id) DO UPDATE SET rating_given = EXCLUDED.rating_given, meet_again_self = EXCLUDED.meet_again_self`, [...]);
  await db.query(`INSERT INTO meeting_records (... partner row ...) ON CONFLICT (...) DO UPDATE SET meet_again_partner = EXCLUDED.meet_again_partner`, [...]);
}

// rating.service.ts inside transaction(async (client) => { ... })
const { upsertRatingForMeeting } = await import('../meeting-records/meeting-records.service');
await upsertRatingForMeeting({
  sessionId: match.sessionId, roundNumber: match.roundNumber, matchId: input.matchId,
  raterUserId: fromUserId, ratedUserId: toUserId,
  qualityScore: scoreForAggregates, meetAgain: input.meetAgain,
}, client);  // ← transaction client; NO try/catch — atomic with the rating
````

### Tests to add

- NEW server/src/__tests__/services/meeting-records/tx-client.test.ts — behavioral: call upsertRatingForMeeting(input, mockClient) and assert BOTH statements ran on mockClient.query and ZERO calls hit the mocked module-level db query; call without client → module query used (back-compat for any future caller).
- Source pins (same file): rating.service submitRating slice contains `upsertRatingForMeeting(` with `, client)` as an argument; the slice between upsertRatingForMeeting( and the end of the transaction callback contains no `catch (mrErr)`; meeting-records fn signature matches /client\?: Pick<PoolClient, 'query'>/.
- Behavioral: submitRating with the rating.service.test.ts mock-transaction harness — make the meeting-records statement reject and assert submitRating rejects (transaction rolls back; no partial success returned).
- Headed Playwright prod smoke: 6-browser event, one full round, ALL six submit ratings within the same 2s window (the pool-pressure shape); assert all six get the success state, then assert recap counts (uniquePeopleMet/totalMeetings/mutual) are exactly consistent with the submitted ratings for all six users. Watch Render logs for zero pool-timeout errors during the burst.

### Acceptance criteria

- submitRating's transaction performs ALL writes (ratings, encounter_history, meeting_records ×2) on a single pooled connection — assertable in tests by connection identity, and in prod by surviving a ≥25-concurrent-submission burst with zero connectionTimeoutMillis (10s) acquisition failures.
- A meeting-records write failure rolls back the rating (no rating row without meeting_records rows and vice versa).
- phase2-meeting-records.test.ts green without modification (EXCLUDED.* SQL, dynamic import, eh-before-mr order all preserved).
- Full local suite green.

### Pinned tests to update

- None expected: server/src/__tests__/services/meeting-records/phase2-meeting-records.test.ts pins (lines 75-84 EXCLUDED.* in the fn slice; 138-155 dynamic import + call order in submitRating) survive — the fn slice for upsertRatingForMeeting still ends at the first column-0 `}` and keeps both SQL strings; keep the dynamic import form when passing the client.

### Risks

Behavior change: a persistent meeting_records failure (e.g. future constraint bug) now 500s the rating instead of silently dropping recap data — intended, but monitor Sentry for new RATING_FAILED spikes in the first live event after ship. Transaction duration grows by two statements on the same connection (faster than today's cross-connection waits). Trios: concurrent disjoint-pair writers cannot deadlock (analysis in design); same-pair writers are serialized by RAT-2's encounter lock.

### Deploy notes

Server-only; no migration, no env vars. Ship AFTER RAT-2 (lock-ordering argument). Independent headed smoke before/after.

---

## RAT-5 — Presence flap: stale-heartbeat sweep reconciles against live sockets before clearing presence and broadcasting participant:left

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/participant-flow.ts`

### Problem

startHeartbeatStaleDetection (participant-flow.ts:1926-1961, 30s tick, 90s threshold) clears presenceMap entries on heartbeat AGE ALONE — no live-socket check — then broadcasts participant:left + entity fanout + the debounced list push room-wide. A connected-but-throttled tab (backgrounded phone, half-closed laptop — guaranteed at 30-50) misses heartbeats while its socket stays alive, so everyone repeatedly sees them leave and rejoin (flap), each flap costing a room-wide broadcast + N refetches. The read-side fix already exists (the 30s reconciler asks io.fetchSockets() before LEFT escalation, participant-state-machine.ts:510-523; rating close unions fetchSockets, participant-flow.ts:1542-1551) — the sweep is the last presence PRODUCER without it.

### Design

Inside the sweep's per-session loop, restructure to: collect stale candidates first; if any, do ONE io.in(sessionRoom(sessionId)).fetchSockets() per session per tick; for each candidate with a live socket, REFRESH presence instead of clearing (reuse the Phase 7A.1 pattern: setPresence(sessionId, userId, { lastHeartbeat: new Date(), socketId: 'sweep-reconciled' }) — participant-state-machine.ts:514 uses socketId 'reconciled') and emit NOTHING; for candidates with no live socket, keep today's exact behavior (setPresence(sessionId, userId, null), participant:left emit, fanSessionRoomEntities, scheduleParticipantListBroadcast). If fetchSockets throws, fall back to today's age-only clearing (ground truth unavailable must not wedge presence forever).

Keep ALL pinned strings inside the function: the call text `setPresence(sessionId, userId, null)`, the `M1 fix (21 May Ali)` comment block, the participant:left emit, and STALE_HEARTBEAT_MS = 90_000 / STALE_CHECK_INTERVAL_MS = 30_000 unchanged. Keep additions compact (see pinnedTestsToUpdate — one pin slices only the first 3500 chars of the function).

Cost contract at 50 users: fetchSockets fires only on ticks where ≥1 candidate is stale, max once per active session per 30s; via the Redis adapter that is one round-trip returning ≤50 lightweight remote-socket handles whose .data.userId is readable (same as the reconciler's usage) → worst case ~2 calls/min/session, negligible against the read-side paths that already call it per rating submission. During Render deploy overlap the adapter unions sockets from BOTH instances, so the new instance's sweep cannot flap users still connected to the old one — strictly better than today.

Behavioral contract: a user whose socket is connected NEVER has presence cleared by the sweep and never triggers participant:left from it; a user with no socket and heartbeat age >90s is cleared exactly as today (no LEFT transition — that stays the reconciler's job).

### Code sketch

````
setInterval(async () => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions) {
    const stale: string[] = [];
    for (const [userId, presence] of session.presenceMap) {
      if (now - presence.lastHeartbeat.getTime() > STALE_HEARTBEAT_MS) stale.push(userId);
    }
    if (stale.length === 0) continue;
    // Ground truth ONCE per session per tick (read-side union pattern,
    // cf. participant-state-machine.ts:510 reconciler).
    let live: Set<string> | null = null;
    try {
      const socks = await io.in(sessionRoom(sessionId)).fetchSockets();
      live = new Set(socks.map(s => (s.data as { userId?: string })?.userId).filter((u): u is string => !!u));
    } catch { /* adapter unavailable → legacy age-only behaviour */ }
    for (const userId of stale) {
      if (live?.has(userId)) {
        // throttled-but-connected: refresh, don't flap
        setPresence(sessionId, userId, { lastHeartbeat: new Date(), socketId: 'sweep-reconciled' });
        continue;
      }
      logger.warn({ userId, sessionId }, 'Stale heartbeat — clearing presence');
      // M1 fix (21 May Ali) — ...keep existing comment block...
      setPresence(sessionId, userId, null);
      io.to(sessionRoom(sessionId)).emit('participant:left', { userId });
      fanSessionRoomEntities(io, sessionId, [E.session(sessionId), E.sessionParticipants(sessionId)]).catch(() => {});
      scheduleParticipantListBroadcast(io, sessionId);
    }
  }
}, STALE_CHECK_INTERVAL_MS);
````

### Tests to add

- NEW server/src/__tests__/services/orchestration/sweep-socket-reconcile.test.ts — behavioral with jest fake timers: seed activeSessions with a presenceMap entry 100s old; io mock whose fetchSockets returns a socket with data.userId of that user → advance 30s → expect setPresence REFRESH (entry still present, lastHeartbeat updated) and ZERO 'participant:left' emits; fetchSockets returns [] → expect presence cleared + exactly one participant:left; fetchSockets rejects → expect legacy clear (fail-open).
- Source pin in same file: startHeartbeatStaleDetection slice contains fetchSockets BEFORE `setPresence(sessionId, userId, null)` and contains 'sweep-reconciled'.
- Headed Playwright prod smoke: 3-browser event; background one tab (CDP Page.setWebLifecycleState or emulate timer throttling) for 3+ minutes while its websocket stays connected; assert on another browser that the backgrounded user's tile NEVER disappears/reappears across the window (poll roster every 5s, assert continuous presence); then hard-kill the tab and assert participant:left propagates within ~120s (90s threshold + 30s tick).

### Acceptance criteria

- A connected-but-heartbeat-silent user is never cleared by the sweep: zero participant:left flaps room-wide over a 5-minute backgrounded-tab window (smoke-asserted).
- A genuinely-gone user (no socket) is still cleared within 90-120s with the same emits as today.
- Sweep adds at most one fetchSockets per active session per 30s tick (assert via mock call counts in the behavioral test).
- phase-2-7-2-8-disconnect-and-fallback.test.ts and phase-may19-bugs-33-36-37-44.test.ts sweep pins green; full suite green.

### Pinned tests to update

- server/src/__tests__/services/matching/phase-2-7-2-8-disconnect-and-fallback.test.ts:91-118 — slices the fn to the first column-0 '}'; keep all added code indented (no column-0 brace) and keep `setPresence(sessionId, userId, null)`, the participant:left emit, and STALE_HEARTBEAT_MS = 90_000 inside it. Should pass unchanged.
- server/src/__tests__/services/phase-may19-bugs-33-36-37-44.test.ts:102-111 — slices only the FIRST 3500 chars from the fn start and requires `setPresence(sessionId, userId, null)` within it; keep the additions compact (trim the relocated comment if needed) or bump that slice window to 4500 in the same commit with a one-line justification.

### Risks

Zombie-socket edge: a crashed page whose TCP lingers keeps presence alive for at most Socket.IO's ping cycle (defaults: 25s interval + 20s timeout ⇒ ~45s until the socket is dropped), after which the next tick clears it — bounded staleness, strictly better than infinite flapping. The interval callback is now async-heavier; failures are caught per-session so a Redis hiccup degrades to legacy behavior, never skips other sessions.

### Deploy notes

Server-only; no migration, no env vars. Independent deploy. After ship, watch for the 'Stale heartbeat — clearing presence' log rate dropping to near-zero during live events with backgrounded phones.

---

## RAT-6 — Ghost matching: strict presence gate at match-GENERATION time with host-visible 'appears offline' bye reason

**Priority:** P2
**Depends on:** RAT-5

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/matching-flow.ts`

### Problem

Matching eligibility is gated by getPresentUserIds (matching-flow.ts:71-110), a deliberately fail-open UNION of 4 signals (live sockets ∪ presenceMap ∪ canonical connState ∪ LiveKit lobby roster). Any single stale signal keeps a gone user 'present', so the engine matches them into a room they will never join; their partner burns the 60s no-show window and then sits out the entire round (mid-round re-pairing was removed by design, WS2). The host sees no explanation. The union must stay fail-open for its other consumers (rating close, no-show, bye-list display) — only round GENERATION should be stricter.

### Design

Add a SECOND, stricter helper used only at the two generation entry points, leaving getPresentUserIds and every other consumer untouched (its source is pinned by may24-presence-livekit-reconcile.test.ts).

(1) NEW in matching-flow.ts (place directly below getPresentUserIds):
  const STRICT_PRESENCE_HEARTBEAT_MS = 30_000;
  export async function getStrictlyPresentUserIds(io, sessionId, activeSession): Promise<Set<string> | null>
Contract: live sockets in sessionRoom via fetchSockets ∪ presenceMap entries with lastHeartbeat ≤30s old (2 missed 15s heartbeats). Returns null if fetchSockets throws (ground truth unavailable ⇒ caller falls open to the loose union — never block matching on an infra blip). Canonical connState and the LiveKit roster are deliberately NOT trusted here: both are heal-oriented signals that go stale exactly in the ghost scenario.

(2) handleHostGenerateMatches (matching-flow.ts:333-367): KEEP the loose getPresentUserIds call at line 340 (it feeds the present-but-'disconnected' DB reconcile at 341-358, which must stay generous, and the function call is pinned by may23-live-test-host-fixes.test.ts:28-30). After it, compute the strict set and intersect:
  const strict = await getStrictlyPresentUserIds(io, data.sessionId, activeSession);
  const generationPresent = strict && strict.size > 0 ? new Set([...presentUserIds].filter(u => strict.has(u))) : presentUserIds;
  const absentExcludedUserIds = strict ? new Set([...presentUserIds].filter(u => !strict.has(u))) : new Set<string>();
Pass generationPresent (not presentUserIds) to matchingService.getEligibleParticipants at line 360 — gatePresentRows (matching.service.ts:191-210) already falls open on empty/zero-overlap sets, preserving the never-match-zero-people invariant. Thread absentExcludedUserIds into BOTH sendMatchPreview calls in this handler (lines 440 and 552).

(3) handleHostRematch (matching-flow.ts:847-877): same intersection; pass generationPresent into both generateSingleRound calls (lines 863-866 and 877) and absentExcludedUserIds into the sendMatchPreview at line 908.

(4) sendMatchPreview (matching-flow.ts:1012): add optional last param opts?: { absentExcludedUserIds?: Set<string> }. In the byeParticipants mapping (lines 1201-1215) extend the reason resolution:
  reason: actingAsHost ? 'acting as host' : opts?.absentExcludedUserIds?.has(uid) ? 'appears offline' : undefined
The bye-list present-filter at 1163-1165 keeps using the LOOSE union, so strict-excluded users remain VISIBLE in the bye list (they're in the loose set) with the reason attached. The client already renders reasons generically — HostControls.tsx:494-495 renders `${displayName} (${reason})` — zero client change. The policy-bye warning (line 1221 filters !p.reason) automatically stops counting them as 'no fresh pairs' byes.

Explicitly OUT of scope (do not touch): replanRoundsAfterPreviewEdit/repairFutureRounds (future rounds are re-checked at confirm time), breakout-bulk.ts:188, participant-flow.ts:139, transitionToRound's zero-match fallback (other cluster), and all rating/no-show consumers.

### Code sketch

````
const STRICT_PRESENCE_HEARTBEAT_MS = 30_000;
/** GENERATION-TIME presence gate (2026-06-12 audit: ghost matching).
 *  Stricter than getPresentUserIds: live socket OR heartbeat ≤30s.
 *  null = ground truth unavailable → caller must fall open. */
export async function getStrictlyPresentUserIds(
  io: SocketServer, sessionId: string, activeSession: ActiveSession,
): Promise<Set<string> | null> {
  const strict = new Set<string>();
  try {
    for (const s of await io.in(sessionRoom(sessionId)).fetchSockets()) {
      const uid = (s.data as { userId?: string })?.userId;
      if (uid) strict.add(uid);
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'strict presence: fetchSockets failed — falling open');
    return null;
  }
  const now = Date.now();
  for (const [uid, p] of activeSession.presenceMap) {
    if (now - p.lastHeartbeat.getTime() <= STRICT_PRESENCE_HEARTBEAT_MS) strict.add(uid);
  }
  return strict;
}
// handleHostGenerateMatches — after line 340
const strict = await getStrictlyPresentUserIds(io, data.sessionId, activeSession);
const generationPresent = strict && strict.size > 0
  ? new Set([...presentUserIds].filter(u => strict.has(u))) : presentUserIds;
const absentExcludedUserIds = strict
  ? new Set([...presentUserIds].filter(u => !strict.has(u))) : new Set<string>();
const eligible = await matchingService.getEligibleParticipants(data.sessionId, allHostIds, generationPresent);
// sendMatchPreview byes
reason: actingAsHost ? 'acting as host'
  : opts?.absentExcludedUserIds?.has(uid) ? 'appears offline' : undefined,
````

### Tests to add

- NEW server/src/__tests__/services/orchestration/strict-generation-gate.test.ts — behavioral: getStrictlyPresentUserIds with io mock (live socket user A) + presenceMap (B fresh 10s, C stale 60s) → returns {A,B}; fetchSockets rejects → null.
- Source pins: handleHostGenerateMatches contains getStrictlyPresentUserIds( AND still contains getPresentUserIds( (preserving the may23 pin); getEligibleParticipants receives generationPresent; handleHostRematch contains getStrictlyPresentUserIds(; sendMatchPreview reason resolution contains 'appears offline'.
- Behavioral on sendMatchPreview (mock query/io): a bye user in absentExcludedUserIds gets reason 'appears offline'; an acting-host bye keeps 'acting as host'; a plain bye keeps undefined and still counts toward the policy warning.
- Headed Playwright prod smoke: 5-browser event; hard-kill browser 5's process (socket gone, heartbeat stale, but canonical/LiveKit signals possibly lingering) ~40s before the host clicks Match People; assert the preview pairs only the 4 live users, the bye list shows 'User5 (appears offline)', and after Confirm NO live participant lands in a no-show wait (everyone's partner arrives within 20s). Negative case: a merely-backgrounded-but-connected tab (live socket) IS matched.

### Acceptance criteria

- A user with no live socket and no heartbeat within 30s at generation time is never placed in a round's matches; they appear in the host's 'Not matched' list suffixed '(appears offline)'.
- A connected-but-throttled user (live socket, stale heartbeat) IS still matched (socket signal suffices).
- fetchSockets failure ⇒ behavior identical to today (loose union, fail-open) — no INSUFFICIENT_PARTICIPANTS regressions attributable to the gate.
- Rating/no-show/bye-display consumers unchanged (getPresentUserIds source byte-identical); may23 + may24 pin tests green; full suite green.

### Pinned tests to update

- None expected: server/src/__tests__/services/may24-presence-livekit-reconcile.test.ts pins getPresentUserIds' source — untouched; server/src/__tests__/services/may23-live-test-host-fixes.test.ts pins that handleHostGenerateMatches calls getPresentUserIds( — still true. If any may23 pin asserts ordering between getPresentUserIds and getEligibleParticipants, the intersection insert sits between them and preserves both markers.

### Risks

A user mid-reconnect at the exact generation instant can be excluded for that round — visible to the host with a reason, and recoverable via Re-match before Confirm; this trades a silent partner-burning ghost for an explicit, host-actionable bye (correct trade at 30-50). The 30s heartbeat window assumes the 15s client heartbeat cadence — if that cadence ever changes, this constant must move with it (code comment required). Late repairFutureRounds paths still use the loose union by design; ghosts there are re-filtered when the round is actually generated/confirmed.

### Deploy notes

Server-only; no migration, no env vars, no client change (reason string renders via the existing Bug-B surface). Ship after RAT-5 (a non-flapping presenceMap makes the 30s heartbeat signal more reliable), though not strictly dependent.

### ⚠ Adversarial review — REQUIRED amendments

**[BLOCKER]** The strict presence gate never reaches the matching engine on the PRIMARY generate path. In handleHostGenerateMatches, the spec changes only the getEligibleParticipants call at matching-flow.ts:360 (a pre-check used for the <2 guard and pre-plan staleness comparison) and threads absentExcludedUserIds into sendMatchPreview. But the actual fresh-generation engine run at matching-flow.ts:497 — generateSingleRound(data.sessionId, nextRound, allHostIds, undefined, presentUserIds) — still receives the LOOSE union, and generateSingleRound re-derives eligibility internally via gatePresentRows(presentUserIds) (matching.service.ts:275-277). Worse, this is exactly the path that runs in the ghost scenario: a ghost's exclusion from the strict-intersected 'eligible' set makes the pre-plan look stale (sameMembers=false at lines 403-404), the scheduled plan is DELETEd (467-470), and control falls through to the line-497 engine run with the loose set — re-matching the ghost. Acceptance criterion 1 ('never placed in a round's matches') fails on the main 'Match People' click.

*Required action:* Pass the intersected set to the engine too: change line 497 to generateSingleRound(data.sessionId, nextRound, allHostIds, undefined, generationPresent) — symmetric with what the spec already (correctly) prescribes for the two generateSingleRound calls in handleHostRegenerateMatches (lines 863-866 and 877). gatePresentRows' fail-open behavior preserves the never-match-zero-people invariant identically.

**[IMPORTANT]** The prescribed variable name breaks a source pin the spec explicitly cleared as safe. may23-live-test-host-fixes.test.ts:39 asserts, within the handleHostGenerateMatches slice: expect(fn).toMatch(/getEligibleParticipants\(\[\s\S\]{0,80}presentUserIds/). The spec mandates 'Pass generationPresent (not presentUserIds) to matchingService.getEligibleParticipants at line 360' — `getEligibleParticipants(data.sessionId, allHostIds, generationPresent)` contains no literal 'presentUserIds' within 80 chars of the paren, so the pin fails. The spec's pinnedTestsToUpdate claims may23 'pins that handleHostGenerateMatches calls getPresentUserIds( — still true' and only considered ordering pins; it missed this third assertion.

*Required action:* Either name the intersected set with the pinned substring as a prefix (e.g. presentUserIdsForGeneration — 'presentUserIds' then matches within the 80-char window) or update the may23 pin in the same commit with a one-line justification. State this explicitly in the work item so an implementer doesn't discover it via a red suite.

**[NIT]** Two sendMatchPreview call sites are not threaded with absentExcludedUserIds: handleHostSwapMatch (matching-flow.ts:698) and handleHostExcludeFromRound (matching-flow.ts:789). After the host swaps or excludes someone on a preview that contained 'appears offline' byes, the re-sent preview silently drops those reasons and the affected users fall back into the 'no fresh pairs' policy-bye warning count (line 1221 filters !p.reason) — visibly inconsistent host UX within the same preview session.

*Required action:* Either thread the computed absentExcludedUserIds through the swap/exclude re-preview paths (recomputing the strict set there is one fetchSockets), or document the dropped-reason behavior as accepted in the work item so the smoke doesn't flag it.

**[NIT]** Symbol does not exist: 'handleHostRematch (matching-flow.ts:847-877)'. The function is handleHostRegenerateMatches (matching-flow.ts:802); the cited line numbers (850 getPresentUserIds, 863-866 and 877 generateSingleRound, 908 sendMatchPreview) are all correct WITHIN that function. An implementer grepping for handleHostRematch finds nothing.

*Required action:* Rename the reference to handleHostRegenerateMatches (matching-flow.ts:802); keep the line citations.

---

## RAT-7 — getUnratedPartners: fix trio C-slot partner enumeration (B missing, A duplicated)

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/rating/rating.service.ts`

### Problem

getUnratedPartners (rating.service.ts:777-871) builds the end-of-event missed-rating forms from a 3-branch UNION ALL CTE. For a participant_c row: branch 1's WHERE includes participant_c_id = $2 and its CASE falls to ELSE participant_a_id (partner A); branch 3 (the C-slot branch) computes 'a if a != $2 else b' which for a C-slot user is ALWAYS a. Net: the C-slot member gets partner A twice (two identical UNION ALL rows → duplicate form) and partner B never (no missed-rating form for B, so that rating is silently unobtainable).

### Design

Replace the entire 3-branch user_partners CTE with the single LATERAL-unnest enumeration pattern this same file already uses and trusts in getPeopleMet (rating.service.ts:397-404): for every qualifying match containing $2 in any slot, emit one row per non-$2 participant. This is structurally incapable of the slot asymmetry. Preserve EVERYTHING the phase5 pin test asserts: the literal `(m.participant_c_id IS NOT NULL) AS is_trio` projection, the display-name COALESCE chain, the rated-already NOT EXISTS filter, and `ORDER BY up.is_manual ASC, up.round_number ASC` — only the CTE body changes.

Scope guard: do NOT add departed_user_ids to the enumeration (getPeopleMet unions them, but extending missed-rating forms to departed partners is a behavior change beyond this bug; leave a one-line comment noting the deliberate divergence).

Resulting semantics: pair member → 1 row (other slot); trio A/B/C member → exactly 2 rows each, all distinct, is_trio true; solo/NULL-B manual rooms → 0 rows (pid IS NOT NULL filter).

### Code sketch

````
WITH user_partners AS (
  SELECT
    m.id AS match_id,
    m.round_number,
    m.is_manual,
    (m.participant_c_id IS NOT NULL) AS is_trio,
    partners.partner_id
  FROM matches m
  JOIN sessions s ON s.id = m.session_id
  CROSS JOIN LATERAL (
    SELECT DISTINCT pid AS partner_id
    FROM unnest(ARRAY[m.participant_a_id, m.participant_b_id, m.participant_c_id]) AS pid
    WHERE pid IS NOT NULL AND pid != $2
  ) AS partners
  WHERE m.session_id = $1
    AND (m.participant_a_id = $2 OR m.participant_b_id = $2 OR m.participant_c_id = $2)
    AND m.status IN ('completed', 'no_show')
    AND s.status IN ('completed', 'closing_lobby')
)
SELECT up.match_id, up.partner_id,
  COALESCE(NULLIF(TRIM(u.display_name), ''), SPLIT_PART(u.email, '@', 1), 'Partner ' || SUBSTRING(up.partner_id::text, 1, 6)) AS partner_display_name,
  up.round_number, up.is_manual, up.is_trio
FROM user_partners up
JOIN users u ON u.id = up.partner_id
WHERE NOT EXISTS (
  SELECT 1 FROM ratings r
  WHERE r.match_id = up.match_id AND r.from_user_id = $2 AND r.to_user_id = up.partner_id
)
ORDER BY up.is_manual ASC, up.round_number ASC
````

### Tests to add

- NEW server/src/__tests__/services/rating/unrated-partners-trio.test.ts — source pins: getUnratedPartners fn slice contains CROSS JOIN LATERAL + unnest(ARRAY[m.participant_a_id, m.participant_b_id, m.participant_c_id]) + `pid != $2`, contains exactly ONE 'FROM matches m' occurrence in the CTE (UNION ALL branches gone), and still contains `(m.participant_c_id IS NOT NULL) AS is_trio` + the ORDER BY.
- Behavioral with mocked query capturing SQL + simulated rows: trio match (A,B,C), caller C, no ratings → mock returns rows for A and B; assert mapping yields 2 distinct partnerIds with isTrio true and no duplicates (drives the row-mapping code; the SQL itself is pinned + smoke-verified).
- Verify existing server/src/__tests__/services/rating/phase5-missed-rating-context.test.ts passes unmodified.
- Headed Playwright prod smoke: 3-browser event with exactly one trio round; the C-slot user skips both ratings in-round; after End Event, on C's recap assert EXACTLY two late-rating forms appear, one labelled with A's name and one with B's name (no duplicate A form); submit both, assert both land (encounter/meeting counts reflect them).

### Acceptance criteria

- C-slot trio member's GET /ratings/unrated returns exactly two rows — partners A and B, no duplicates; A/B slot members unchanged (two distinct rows each); pair members unchanged (one row).
- No duplicate late-rating forms render on the recap for any trio member.
- phase5-missed-rating-context.test.ts green without changes; full suite green.

### Pinned tests to update

- None: server/src/__tests__/services/rating/phase5-missed-rating-context.test.ts pins (is_trio projection shape, m.is_manual select, COALESCE name chain, ORDER BY, isManual/isTrio mapping) are all preserved verbatim by the sketch above.

### Risks

Low — read-only endpoint feeding the recap forms. Output set GROWS for C-slot members (the missing B row appears) — intended. The DISTINCT in the LATERAL guards the degenerate case of a departed id also occupying a slot. Solo manual rooms produce zero rows as before.

### Deploy notes

Server-only; no migration, no env vars, no client change (RecapPage already renders one form per returned row). Independently shippable at any point in the cluster sequence.

## Reviewer-verified facts (safe to rely on)

- Branch june9-punchlist @ 3cf1187 confirmed; all core symbols exist: handleResync (state-snapshot.ts:160+), withSessionGuard non-reentrant promise-chain lock (session-state.ts:117-131), session:resync registered UNGUARDED at orchestration.service.ts:276, wrapHandler is try/catch-only (orchestration.service.ts:92-106) — RAT-1's guard analysis is structurally correct
- LEFT -> IN_MAIN_ROOM is legal 'explicit re-entry only' (participant-state-machine.ts:117); transitionParticipant projects IN_MAIN_ROOM to DB 'in_lobby', clears left_at (lines 257-272), and writes location 'main' only when no active match exists (331-343) — reEnterLeftParticipant's contract is implementable as specced; no import cycle (participant-state-machine does not import state-snapshot)
- Fix-A reset block confirmed at participant-flow.ts:679-690 inside guarded handleJoinSession (withSessionGuard at line 435); client emits session:join + session:resync back-to-back at useSessionSocket.ts ~168/175, 1198/1203, 1243/1248; session:evicted handler gates the removed screen on reason==='removed_from_event' at useSessionSocket.ts:348-365 (check at 355) — RAT-1's race narrative and 'no client change' claim verified
- RAT-2 premises verified: first-rater COUNT at rating.service.ts:211-215 runs BEFORE the SELECT...FOR UPDATE at 218; the no-ON-CONFLICT INSERT is at 245-250; encounter_history has UNIQUE(user_a_id,user_b_id) + CHECK user_a_id<user_b_id (001_initial_schema.sql:266-268) unchanged by any later migration; transaction() is plain BEGIN = READ COMMITTED (db/index.ts:88); pool max defaults to 25 (config/index.ts:19) with connectionTimeoutMillis 10s (db/index.ts:12)
- RAT-3 premises verified: notifyRatingSubmitted (participant-flow.ts:1437-1439) has exactly ONE production caller — routes/ratings.ts:38 via the orchestration.service re-export (lines 10/424 confirmed); rating:skip calls checkAllRatingsCompleteByUserId directly with io and no guard (participant-flow.ts:1414-1431); the fetchSockets union is io-gated at 1542-1551; submit path passes io at 1394; zod validates matchId as uuid (routes/ratings.ts:18); setHostActionsIo precedent exists (host-actions.ts:2324-2329)
- RAT-4 premises verified: upsertRatingForMeeting uses module-level query (meeting-records.service.ts:111,123) and has exactly one production caller (rating.service.ts:160); is_mutual is a GENERATED ALWAYS column (054_meeting_records.sql:34) so passing a transaction client cannot break mutual computation; phase2-meeting-records.test.ts pins (fn slice to first column-0 brace, EXCLUDED.* strings, dynamic import, eh-before-mr order) all survive the sketch as written; socket error rail catches submitRating rejections (participant-flow.ts:1395-1397)
- RAT-5 premises verified: startHeartbeatStaleDetection (participant-flow.ts:1926-1961) clears on heartbeat age alone; the fetchSockets reconcile pattern to copy exists at participant-state-machine.ts:510-523 ('reconciled' socketId at 514); both pinned tests slice exactly as the spec warns (phase-2-7-2-8:92-118 to first column-0 brace; may19 test:102-111 first-3500-chars window) and the sketch keeps every pinned string; socket.io v4 ping defaults (25s/20s) make the ~45s zombie-socket bound accurate
- RAT-6/RAT-7 premises verified: getPresentUserIds is the 4-signal fail-open union (matching-flow.ts:71-110); gatePresentRows falls open on empty/zero-overlap (matching.service.ts:191-210); bye reason map at matching-flow.ts:1201-1215 with loose-present filter at 1162-1166 and policy warning at 1221; HostControls.tsx renders `name (reason)` generically (~489-497); the trio C-slot bug is real (branch 1 ELSE -> A at rating.service.ts:799-803, branch 3 always-A at 834-837); the LATERAL rewrite preserves every phase5-missed-rating-context.test.ts pin; getPeopleMet's LATERAL precedent at 397-404
- Library reality: socket.io ^4.7.0 (server/package.json:36) and @socket.io/redis-adapter ^8.3.0 (line 19) support io.in(room).fetchSockets() with serialized .data on remote sockets (already used in 3 production sites); pg ^8.12.0 (line 31) PoolClient.query is call-compatible with Pick<PoolClient,'query'>; redis adapter wired at index.ts:366-370; no pg advisory locks, express-rate-limit, or livekit-client API changes are actually relied on by this cluster
- Cluster boundary claims verified against docs/AUDIT-2026-06-12-live-30-50-readiness.md: M3c (timer TOCTOU) correctly scoped out of RAT-3; M2/M3a-e/M-presence citations match the audit doc's findings table

