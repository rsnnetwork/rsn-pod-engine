# SDD 07 — M6 matcher cap + M7 deploy fencing + M8 migration runner + LiveKit token hygiene

Part of the RSN 30-50 scale fix programme. Baseline: `june9-punchlist` @ `4717268`. Read `SDD-00-MASTER.md` first for ground rules, ship order, and process.

**Review verdict for this cluster: needs-changes.** Every issue listed under a work item below is a REQUIRED amendment to that item's design — apply the issue's suggestion over the original text wherever they conflict.

## Cluster notes (designer)

Scope: M8 migration runner (PLT-1, P1), M6 matcher cap (PLT-2, P1), M7 deploy fencing (PLT-3, P2), timer-persist ordering (LCY-1, P2), resolvePendingRound recovery (LCY-2, P2), LiveKit token hygiene (VID-1, P2). Repo read at C:/Users/ARFA TECH/Desktop/RSN-dev @ june9-punchlist.

Recommended ship order (one fix per deploy): PLT-1 → PLT-2 → LCY-1 → LCY-2 → PLT-3 → VID-1. Hard dependency: PLT-3 after LCY-1 (lease handover re-arms from the persisted timerEndsAt, which is only trustworthy after the persist-after-arm fix). Everything else is independent. PLT-3's own deploy is unfenced (old binary lacks lease logic) — schedule it outside a live event.

Audit re-verification results (differences from the audit text): (1) M6 — the audit's parenthetical 'the Path-2 augmenting rescue ... is polynomial' is WRONG: matching.engine.ts:300-322 calls the same exponential DFS findCompleteMatching (lines 591-660) as the primary path; there is no augmenting-path implementation anywhere in the repo (grep 'augment' hits only comments/test names). The node budget is therefore mandatory for extending to all n, and the budget doubles as the fix for the audit's separate unbounded-backtracking medium — no event-loop yield needed (200k nodes ≈ ≤50ms synchronous at n=50). (2) M8 — confirmed 37 files / 74 wrapper statements (exactly one BEGIN;/COMMIT; pair per file, all line-anchored); plpgsql bodies are dollar-quoted and never contain 'BEGIN;' so a dollar-quote-aware line strip is provably safe on the existing corpus; duplicate 060 pair (060_acting_as_host.sql, 060_cancelled_excluded_from_unique_pair.sql) are both applied — grandfather them, never rename applied files (filename is the _migrations identity key). Recommended runtime-strip over a 37-file cleanup because several pinned tests read migration file text verbatim. db/index.ts:6 mentions a Neon-style pooler → use transaction-scoped pg_advisory_xact_lock (pooler-safe), never session-scoped pg_advisory_lock. (3) resolvePendingRound — root cause is narrower than 'persist pendingRoundNumber in the Redis blob': the field IS already serialized (session-state.ts:212) and restored (round-lifecycle.ts:128); what's missing is persistSessionState calls at the two set-sites (matching-flow.ts:439, 526), the field in the DB active_state JSON, and the DB-fallback mapping (round-lifecycle.ts:196 hardcodes null). The MAX(scheduled) inference stays only as last resort, retargeted to MIN(scheduled > currentRound). (4) VID — generateLiveKitToken (session.service.ts:736-831) is the single token chokepoint (provider.issueJoinToken has no production callers — grep confirms tests only); membership row already SELECT *'d so host_muted is available for free; livekit-server-sdk ^2.0.0 confirmed to provide removeParticipant, AccessToken ttl, and VideoGrant.canPublishSources (TrackSource already imported in the provider). The webhook 'removed' guard belongs in the shared chokepoint healParticipantConnState (livekit-sweep.ts:27) so the push (webhook) and pull (sweep) rails cannot diverge — exactly the file's own stated design principle. (5) M7 — recoverActiveSessions is fired from initOrchestration (orchestration.service.ts:175) before listen (index.ts:379 vs 403); shutdown (index.ts:417-434) currently releases nothing. Socket.IO already runs the Redis adapter, so suppressed-instance broadcasts are not a concern.

Cross-cluster coordination: C4's cluster is wrapping normal-operation timer callbacks and handleHostConfirmRound in withSessionGuard/withMatchGenerationLock — PLT-3's lease gate composes cleanly (lease check fires before the callback; the guard lives inside the callback), but if both clusters touch timer-manager.ts:68-84 in the same window, rebase deliberately. C3's cluster moves /api/webhooks ahead of the rate limiter — independent of VID-1's heal guard. M5 (manual-room timer persistence) is another cluster; PLT-3 deliberately excludes manual-room timers and detectNoShows from fencing scope.

Key pinned-behavior constraints discovered (full list per item): phase-2-5-pre-event-planning.test.ts:178 pins the n<=30 routing (must be updated with PLT-2 — exact replacement regex given); may25-live-fixes.test.ts:176 forbids 'startSegmentTimer' within 60 chars before 'endRatingWindow' in endRound (constrains LCY-1/PLT-3 insertions); june11-kick-token-and-cohost.test.ts:39-48 pins the generateLiveKitToken status gate (VID-1 must not disturb those lines). Standing rules apply to every item: full local test suite before push, headed prod smoke per deploy, one fix per deploy.

---

## PLT-1 — Migration runner: advisory lock, lock/statement timeouts, inner-BEGIN/COMMIT strip, duplicate-number guard, recovery convention

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/db/migrate.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/db/migrate-hardening.test.ts (new)`

### Problem

runMigrations (db/migrate.ts:26-73) wraps each .sql file in BEGIN..COMMIT, but 37/68 migration files contain their own BEGIN;/COMMIT; (74 occurrences, exactly one wrapper pair per file — verified by grep). The inner COMMIT commits the runner's transaction early, so the _migrations INSERT runs in autocommit: an interrupt between them leaves an applied-but-unrecorded migration that crash-loops every boot. There is also no lock_timeout (boot-time DDL on hot tables like session_participants queues an ACCESS EXCLUSIVE lock that blocks every heartbeat/join indefinitely), no cross-instance mutual exclusion during Render's zero-downtime overlap, and a duplicate 060_ numbering pair with no guard against future dupes.

### Design

All changes in server/src/db/migrate.ts. (1) Export `stripTransactionWrappers(sql: string, filename: string): string`. Contract: scan the file tracking dollar-quoted regions ($tag$...$tag$) and `--` line comments; OUTSIDE those regions, if the first non-comment statement is exactly /^\s*BEGIN\s*;\s*$/im and the last is /^\s*COMMIT\s*;\s*$/im, remove BOTH (and only those two); after stripping, if /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\s*;|START\s+TRANSACTION|BEGIN\s+TRANSACTION/i still matches outside dollar-quotes/comments, THROW `Migration ${filename} contains inner transaction control — the runner provides the transaction`. plpgsql bodies are safe: `BEGIN` inside $$..$$ is never followed by `;` and lives inside a tracked dollar region (verified against 042_active_only_uniqueness_trigger.sql). RECOMMENDATION: runtime strip, NOT a one-time edit of the 37 files — applied files are identified by filename so edits are technically safe, but several pinned tests read migration file text (e.g. phase-1-greedy-completeness.test.ts:239-260 pins 057, phase-o-authoritative-mute-state.test.ts pins 061) and a 37-file diff risks pin/content mistakes for zero benefit; the strip provably handles the existing corpus and the reject-clause handles future files. (2) Per-file transaction (replacing migrate.ts:49-65): BEGIN; SET LOCAL lock_timeout='30s'; SELECT pg_advisory_xact_lock($1) with constant MIGRATION_ADVISORY_LOCK_KEY = 727001; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'; re-check `SELECT 1 FROM _migrations WHERE filename=$1` INSIDE the lock (a concurrent runner may have applied it while we waited — COMMIT and continue if present); run stripped sql; INSERT _migrations; COMMIT. Use pg_advisory_xact_lock (transaction-scoped), NOT pg_advisory_lock — db/index.ts:6 notes a Neon-style pooler; xact-scoped locks are pinned to one backend for the tx and are pooler-safe. (3) Retry-on-timeout: wrap each file in a retry loop (3 attempts, 3s then 6s backoff) for pg error codes '55P03' (lock_not_available) and '57014' (query_canceled); log `Migration ${file} timed out waiting for a lock on a hot table — retrying (attempt N/3); if this recurs, deploy outside a live event`. After 3 failures throw — boot aborts; on Render the old instance keeps serving (safe failure). (4) Duplicate-number guard before the loop: extract /^(\d+)_/ prefixes of ALL .sql files; if any prefix has >1 file AND any of them is pending → throw listing the files. Grandfather: const GRANDFATHERED_DUPLICATE_PREFIXES = new Set(['060']) (060_acting_as_host.sql + 060_cancelled_excluded_from_unique_pair.sql are both applied in prod and lexicographic .sort() keeps their order stable; NEVER rename applied files — filename is the _migrations identity). (5) Recovery story: with the inner-COMMIT strip, sql + _migrations INSERT are atomic again, closing the applied-but-unrecorded window for new runs. Going-forward convention (document in a header comment in migrate.ts): every new migration must be idempotent DDL — IF NOT EXISTS / IF EXISTS / CREATE OR REPLACE / DO $$ guards. Add an error hint in the catch: if err.code IN ('42710','42P07','42701') log `Hint: object already exists — this migration may have been applied but not recorded. After manually verifying, record it with: INSERT INTO _migrations (filename) VALUES ('${file}');`. Do NOT auto-record. Note: CREATE INDEX CONCURRENTLY cannot run inside a tx — none exist in the corpus (the runner has always wrapped files, so one would already have failed); reject is implicit.

### Code sketch

````
for (const file of pending) {
  const sql = stripTransactionWrappers(fs.readFileSync(filePath, 'utf-8'), file);
  await retryOnLockTimeout(file, 3, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '30s'`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`SET LOCAL statement_timeout = '120s'`);
      const seen = await client.query('SELECT 1 FROM _migrations WHERE filename = $1', [file]);
      if (seen.rows.length === 0) {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  });
}
// stripTransactionWrappers dollar-quote scanner sketch:
// walk sql; on /\$[A-Za-z_]*\$/ push tag until matching close; only consider
// line-anchored BEGIN;/COMMIT; matches when depth === 0 and line not starting '--'.
````

### Tests to add

- server/src/__tests__/db/migrate-hardening.test.ts — stripTransactionWrappers unit fixtures: wrapper pair stripped; plpgsql DO/$$ BEGIN..END $$ body untouched (use real 042 file content as fixture); mid-file COMMIT; throws; BEGIN TRANSACTION; throws; dollar-quoted 'COMMIT;' string untouched; file without wrappers passes through byte-identical
- Corpus test: iterate every file in server/src/db/migrations — stripTransactionWrappers never throws and output contains no /^\s*(BEGIN|COMMIT)\s*;/im outside dollar quotes (proves all 37 grandfathered files conform)
- Duplicate-prefix guard unit tests incl. the grandfathered 060 pair passing and a synthetic 068 dupe throwing
- Source pins on migrate.ts: pg_advisory_xact_lock present; SET LOCAL lock_timeout present twice (30s then 5s); SET LOCAL statement_timeout present; _migrations re-check appears between pg_advisory_xact_lock and the sql execution (indexOf ordering)
- Headed/deploy smoke: ship with a no-op idempotent migration 068 (DO $$ BEGIN NULL; END $$;), watch Render boot logs for 'Migration completed', verify the _migrations row exists, and verify /health stays green during boot

### Acceptance criteria

- Two runners racing on the same DB with one pending migration: exactly one applies; the other waits on the advisory lock, sees the _migrations row in the in-lock re-check, and skips — no duplicate-key error, no double-apply
- A file containing wrapper BEGIN;/COMMIT; applies atomically — _migrations row and schema change commit together (no applied-but-unrecorded state possible)
- A migration blocked by a hot-table lock fails fast (~5s) with the retry message and aborts boot after 3 attempts instead of hanging; old Render instance keeps serving
- A new migration file reusing an existing number is rejected at boot with a message naming both files; fresh-DB replay of the historical 060 pair still works
- Full existing server test suite green (no current pins reference migrate.ts internals)

### Risks

Stripper bug could alter SQL semantics — mitigated by the dollar-quote scanner, the strict first/last-statement-only rule, the reject clause, and the full-corpus test. statement_timeout=120s could kill a legitimately slow future backfill — acceptable default; a per-file override comment convention can be added later if ever needed. The advisory-lock wait (30s) plus 3 retries bounds worst-case boot delay to ~2min.

### Deploy notes

Server-only. No env vars, no render.yaml change, no migration required (optionally include the 068 no-op to exercise the new path). Ship alone with nothing else in the deploy. Rollback = revert commit; _migrations format unchanged.

---

## PLT-2 — Matcher: node-budgeted exact backtracking at all even n (drop both n<=30 gates)

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/matching/matching.engine.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/matching/phase-2-5-pre-event-planning.test.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/matching/node-budgeted-backtracking.test.ts (new)`

### Problem

Both exact-matching paths in generateSingleRound are gated n<=30: the primary backtracking route (matching.engine.ts:232) and the 'Path 2 augmenting search' rescue (matching.engine.ts:300). At 31-50 participants the engine is pure greedy; greedy corners escalate the L0-L4 ladder (matching.service.ts:465-512), which relaxes no-repeat exclusions and produces avoidable repeat pairings. VERIFIED CORRECTION TO THE AUDIT: 'Path 2' is NOT a polynomial augmenting-path algorithm — matching.engine.ts:301 calls the same exponential DFS findCompleteMatching (lines 591-660) as the primary path. Lifting the gate without a node budget would re-open the unbounded-synchronous-backtracking event-loop freeze (the audit's own medium at line 99: the 60s Promise.race in matching-flow.ts:497-501 cannot preempt synchronous code).

### Design

All in matching.engine.ts. (1) Add module const MATCHING_BACKTRACK_NODE_BUDGET = 200_000. (2) Change findCompleteMatching to return a discriminated result: `{ pairs: MatchPair[] | null; budgetExhausted: boolean }`. Inside recurse(): increment a node counter on every invocation; if counter > budget, set exhausted=true and return false from every frame immediately (`if (exhausted) return false;` at the top). Semantics contract: pairs!==null → complete matching found; pairs===null && !budgetExhausted → exhaustively PROVEN no complete matching exists in the candidate graph (byes are legitimate); pairs===null && budgetExhausted → unknown, caller must fall back to greedy + ladder. Keep the lowest-index vertex selection and the fresh-first adjacency sort (lines 618-620) EXACTLY as-is — the freshest-complete-matching guarantee is pinned behaviorally by fresh-first-selection.test.ts. (3) Primary gate (line 232): change `n <= 30 && n >= 2 && n % 2 === 0` to `n >= 2 && n % 2 === 0`. On budgetExhausted, logger.warn({ n, roundNumber, budget }) 'backtracking node budget exhausted — falling back to greedy'. (4) Path-2 gate (line 300): change `greedyUnmatched.length >= 2 && n % 2 === 0 && n <= 30` to drop the n<=30 clause. (5) Run-at-most-once: within one generateSingleRound call the candidate graph is identical for both blocks, so capture the primary block's outcome in a local (e.g. `let backtrackOutcome: BacktrackResult | null`) and have the Path-2 block reuse it instead of re-searching (the primary block runs for all even n now, so Path-2's search would always be a duplicate). Contract: findCompleteMatching executes at most once per generateSingleRound invocation. (6) Do NOT make the engine async and do NOT add an event-loop yield — the budget bounds the synchronous slice to roughly <=50ms at n=50 (200k nodes x ~O(n) per node); state this in a comment. (7) Update stale comments: lines 222-228 ('Above 30 participants, fall through to greedy'), 282-295 ('<=30 covers every realistic event'), and the findCompleteMatching docblock lines 580-590 ('Bounded to <=30 participants (caller guards)') to describe the node-budget contract. (8) No changes to matching.service.ts — the L0-L4 ladder and reduceRepeatPairs stay as the safety net for budget-exhausted/infeasible instances.

### Code sketch

````
private findCompleteMatching(participants, candidates, nodeBudget = MATCHING_BACKTRACK_NODE_BUDGET): { pairs: MatchPair[] | null; budgetExhausted: boolean } {
  // ... existing adjacency build + fresh-first sort unchanged ...
  let nodes = 0; let exhausted = false;
  const recurse = (): boolean => {
    if (exhausted) return false;
    if (++nodes > nodeBudget) { exhausted = true; return false; }
    // ... existing lowest-index selection + partner loop unchanged ...
  };
  const ok = recurse();
  return { pairs: ok ? result : null, budgetExhausted: exhausted };
}

// generateSingleRound — primary path (replaces line 232 block):
let backtrackOutcome: ReturnType<...> | null = null;
if (n >= 2 && n % 2 === 0) {
  backtrackOutcome = this.findCompleteMatching(participants, candidates);
  if (backtrackOutcome.budgetExhausted) logger.warn({ n, roundNumber }, 'backtrack budget exhausted — greedy fallback');
  if (backtrackOutcome.pairs) { /* adopt as today (lines 237-243) */ }
}
// Path-2 rescue (replaces line 300 block):
if (greedyUnmatched.length >= 2 && n % 2 === 0) {
  const outcome = backtrackOutcome ?? this.findCompleteMatching(participants, candidates);
  if (outcome.pairs) { /* replace greedy result as today (lines 309-320) */ }
}
````

### Tests to add

- node-budgeted-backtracking.test.ts — n=40, no history: 20 pairs, 0 byes
- Adversarial n=34 path-graph instance (shape the candidate graph via hardExclusions so the only complete matching is (0,1)(2,3)... while score ordering tempts greedy to strand vertex 0): engine returns 17 pairs, 0 byes — proves the gate is gone
- Budget sentinel: call (engine as any).findCompleteMatching with nodeBudget=100 on a dense no-perfect-matching instance (one isolated vertex, n=30): returns { pairs: null, budgetExhausted: true } in <250ms
- Proven-infeasible still null/false: the existing 4-all-met case returns { pairs: null, budgetExhausted: false } and the round produces byes (mirrors phase-1-greedy-completeness.test.ts:121-143)
- Wall-clock bound: n=50 with an infeasible graph (one odd component) completes generateRound in <500ms
- Existing suites must stay green untouched: phase-1-greedy-completeness.test.ts, fresh-first-selection.test.ts, phase-2-5 sub-phase 2.5F acceptance (6x3 rounds, 9 unique pairs, 0 byes)
- Headed prod smoke: extend the existing 20-browser load harness to 32+ E2E users on a preview deploy; run 3 consecutive Match People → Confirm cycles; assert each preview shows floor(n/2) pairs, zero unexpected byes, fallbackLevel 0 while fresh pairs exist, and the host:matches_ready arrives <2s after the click

### Acceptance criteria

- A 32-50 person event gets exact matching: while a no-repeat complete matching exists, every round lands at fallbackLevel 0 with zero repeatInEvent pairs
- generateSingleRound never blocks the event loop >250ms per round at n<=50 (assert via the engine's logged durationMs in the smoke)
- Budget exhaustion degrades to today's exact greedy+ladder behavior (no byes introduced that greedy would have avoided)
- Updated phase-2-5 pin green; phase-1 and fresh-first suites green unmodified

### Pinned tests to update

- server/src/__tests__/services/matching/phase-2-5-pre-event-planning.test.ts:174-178 — the regex /n\s*<=\s*30\s*&&\s*n\s*>=\s*2\s*&&\s*n\s*%\s*2\s*===\s*0[\s\S]{0,200}findCompleteMatching\(/ pins the n<=30 routing. Replace with /n\s*>=\s*2\s*&&\s*n\s*%\s*2\s*===\s*0[\s\S]{0,200}findCompleteMatching\(/ plus a new negative pin expect(src).not.toMatch(/n\s*<=\s*30/) and a positive pin for MATCHING_BACKTRACK_NODE_BUDGET. Update the describe title at line 171 ('backtracking is PRIMARY for n ≤ 30') and the header comment at line 15 (sub-phase 2.5E description) to 'all even n, node-budgeted'. Reason: the pin pins the exact behavior this fix intentionally changes.
- phase-2-5-pre-event-planning.test.ts:181-183 (greedy-fallback pin) — verify still green; the greedy loop shape is unchanged, no edit expected

### Risks

Pairings at 31-50 will differ from current prod greedy output (intended — better quality); no client contract changes. A sentinel bug conflating budget-exhausted with proven-infeasible would silently bye users — guarded by the two-field return type and dedicated tests. The run-at-most-once memo assumes candidates/usedPairs are not mutated between the two blocks within generateSingleRound — true today (verified: nothing mutates candidates between lines 246 and 300).

### Deploy notes

Server-only. No migration, no env var. Independently shippable; run the FULL server suite locally first (pin update included in the same commit). Deploy then run the 32-browser preview smoke before the next large event.

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** The headed smoke asserts 'host:matches_ready arrives <2s' — no such wire event exists. The preview emit is `host:match_preview` (matching-flow.ts:1233); 'host:matches_ready' appears only inside a comment (matching.service.ts:577). A smoke written against the spec's event name waits forever.

*Required action:* Assert on host:match_preview (or the client-side preview render) instead.

**[NIT]** codeSketch shows `findCompleteMatching(participants, candidates, nodeBudget = ...)` but the real signature (matching.engine.ts:591-601) is (participants, candidates, _usedPairs, _hardExclusions); nodeBudget must be a 5th defaulted parameter, and both call sites (:233-235, :301-303) pass 4 args. Also the worst-case synchronous-slice claim ('<=50ms at n=50') ignores that the L0-L4 ladder (matching.service.ts:465-512) calls engine.generateRound→generateSingleRound up to 5 times back-to-back in one synchronous stretch per level loop — worst case is ~5x the per-call budget, which is exactly the spec's own 250ms acceptance ceiling.

*Required action:* State nodeBudget as the 5th param and note the x5 ladder multiplier in the no-yield justification comment (or share a per-service-call budget across ladder levels).

---

## PLT-3 — Persist timerEndsAt AFTER arming (chokepoint in startSegmentTimer) + per-session persist serialization

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/timer-manager.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/session-state.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/timer-persist-ordering.test.ts (new)`

### Problem

transitionToRound persists session state at round-lifecycle.ts:274 but arms the round timer at line 481 — startSegmentTimer (timer-manager.ts:65) sets activeSession.timerEndsAt AFTER the persist, and nothing re-persists. The Redis/DB blob therefore carries a stale/null timerEndsAt for the whole segment; a deploy mid-round recovers timerless (round never auto-ends) or, worse, recovers a stale previous-segment endsAt and fires the wrong transition. Same pattern at endRatingWindow's CLOSING_LOBBY timer (line 853) and endRound's manual rating backstop (lines 736-742, persisted at 563 before the backstop is armed). Additionally persistSessionState calls are fire-and-forget and unserialized, so two rapid persists can land in Redis out of order.

### Design

(1) timer-manager.ts: import persistSessionState from '../state/session-state' (module already imports ActiveSession/activeSessions/sessionRoom from there). At the very end of startSegmentTimer — after `activeSession.timerSyncInterval = syncInterval;` (line 159) — add `persistSessionState(sessionId, activeSession).catch(() => {});`. This is the chokepoint: it covers transitionToRound (round timer), endRatingWindow (CLOSING_LOBBY 600s), recovery re-arms (harmless same-value re-persist), and the pause/resume re-arm paths, with zero per-site edits. (2) round-lifecycle.ts endRound: the rating backstop deliberately does NOT use startSegmentTimer (pinned — see pinnedTestsToUpdate); after the backstop arm (immediately after line 742's closing `}, RATING_BACKSTOP_MS);`) add `persistSessionState(sessionId, activeSession).catch(() => {});`. CAUTION: do not introduce the literal token 'startSegmentTimer' within 60 chars before 'endRatingWindow' inside endRound — may25-live-fixes.test.ts:176 pins its absence. (3) Do NOT persist inside the timer-fire path (timer-manager.ts:68-84 where timerEndsAt is nulled): the callback's own status-change persist supersedes it, and adding a persist there can race the callback's persist (a late-landing null-timer write would clobber the freshly-armed backstop). Instead, (4) serialize persists: in session-state.ts wrap the body of persistSessionState in a per-session promise chain identical in shape to canonical-state.ts:101-111 serializeRmw (module-level `const _persistChains = new Map<string, Promise<void>>()`), so persist writes land in call order. Keep the function signature and fire-and-forget call sites unchanged. (5) Recovery contract unchanged: round-lifecycle.ts:147-153/207-214 already arm from timerEndsAt when future and skip when past — with fresh persisted values this now behaves correctly for round, rating-backstop, and closing-lobby segments.

### Code sketch

````
// session-state.ts
const _persistChains = new Map<string, Promise<void>>();
export function persistSessionState(sessionId: string, activeSession: ActiveSession): Promise<void> {
  const prev = _persistChains.get(sessionId) ?? Promise.resolve();
  const next = prev.then(() => doPersist(sessionId, activeSession)); // doPersist = current body
  const tracked = next.catch(() => {});
  _persistChains.set(sessionId, tracked);
  void tracked.then(() => { if (_persistChains.get(sessionId) === tracked) _persistChains.delete(sessionId); });
  return next;
}

// timer-manager.ts — end of startSegmentTimer
activeSession.timerSyncInterval = syncInterval;
// LCY-1: persist AFTER arming so recovery always sees the live endsAt
persistSessionState(sessionId, activeSession).catch(() => {});

// round-lifecycle.ts endRound — after `}, RATING_BACKSTOP_MS);`
persistSessionState(sessionId, activeSession).catch(() => {});
````

### Tests to add

- timer-persist-ordering.test.ts — behavioral: jest.mock session-state partially (real activeSessions, mocked persistSessionState — same pattern as phase3-canonical-authority.test.ts:25); call startSegmentTimer(io, id, 60, cb); assert persistSessionState called once with a session whose timerEndsAt is within [now+59s, now+61s]
- Serialization: with a fake redis recording write order, fire two overlapping persistSessionState calls where the first's DB write is artificially delayed; assert the final Redis value matches the second call's state (call order preserved)
- Source pins: startSegmentTimer body contains persistSessionState AFTER the timerSyncInterval assignment (indexOf ordering); endRound contains a persistSessionState call after the RATING_BACKSTOP_MS arm block; the timer-fire closure (lines 68-84 region) contains NO persistSessionState call
- Recovery integration (unit): build an ActiveSession, run startSegmentTimer, snapshot what persistToRedis serialized, feed it through the recoverActiveSessions Redis-path mapping (round-lifecycle.ts:117-137 shape) and assert the timer would be re-armed with remainingSec within 1s of truth
- Headed prod smoke (shared with PLT-3): start a 2-user event with a short round on preview, restart the server mid-round, assert timer:sync resumes within ~10s of boot and session:round_ended fires at the original endsAt ±2s; repeat during the rating window and assert the 90s backstop still closes it after restart

### Acceptance criteria

- Within 1s of any segment timer being armed, the Redis blob's timerEndsAt equals the armed endsAt (verify via redis GET rsn:session:{id} in the smoke)
- Deploy/restart mid-round logs 'Recovered from Redis with running timer' with remainingSec matching the wall clock, and the round auto-ends on schedule
- Deploy/restart during ROUND_RATING recovers the backstop and endRatingWindow fires by the original backstop expiry
- No persist is issued from the timer-fire path (prevents the null-clobber race)

### Pinned tests to update

- None expected to change — but two negative pins constrain the edit: may25-live-fixes.test.ts:172-176 (`endRound uses a plain setTimeout backstop` — must not match /startSegmentTimer[\s\S]{0,60}endRatingWindow/) and dr-arch-april-19-bugs.test.ts:85-123 (startSegmentTimer 2s sync-interval pins). Run both; the specified insertions do not violate them.

### Risks

Adds ~2 extra DB+Redis writes per segment — trivial. The persist chain delays writes under contention by design; if a session ends mid-chain the trailing writes hit a deleted session row harmlessly (UPDATE matches 0 rows; clearPersistedState runs after completeSession's finally). The chain holds the latest activeSession by reference, so serialized writes always serialize the CURRENT state — acceptable (later state is never worse).

### Deploy notes

Server-only, no migration/env. Ship before PLT-3 (the lease handover re-arms from this now-trustworthy persisted timerEndsAt). Independently valuable on its own.

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** Two unstated fragilities: (1) the per-session chain serializes doPersist invocations, but doPersist's Redis write is fire-and-forget (`persistToRedis(...).catch(() => {})`, session-state.ts:182) — ordering of the Redis blob (the value recovery actually reads first) holds only because setex is issued synchronously on the single shared ioredis connection; the spec's claimed guarantee ('persist writes land in call order') is not structurally delivered by wrapping the body. (2) The chokepoint persist at the end of startSegmentTimer makes phase6-timer-refetch.test.ts (which mocks neither db nor session-state) issue a real pg connection attempt from inside the timer test — assertions still pass (errors are swallowed) but it adds env-dependent flake/open-handle noise that pinnedTestsToUpdate ('None expected') doesn't mention.

*Required action:* Await persistToRedis inside doPersist so the chain genuinely orders the Redis write, and note phase6-timer-refetch in the test plan (mock persistSessionState there, same pattern as phase3-canonical-authority.test.ts:23-27).

---

## PLT-4 — resolvePendingRound: persist pendingRoundNumber at set/clear sites; DB-fallback inference becomes MIN(scheduled > currentRound)

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/matching-flow.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/session-state.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/pending-round-recovery.test.ts (new)`

### Problem

After a deploy between 'Match People' and a preview edit, resolvePendingRound (matching-flow.ts:118-130) infers the previewed round as MAX(round_number) over scheduled matches. Since pre-event planning (2.5A) writes scheduled rows for ALL future rounds, MAX returns the LAST planned round — post-restart Swap/Re-match silently edits round N instead of the round on the host's screen. Root cause verified: pendingRoundNumber IS already serialized into the Redis blob (session-state.ts:212) and restored on recovery (round-lifecycle.ts:128) — but the two set-sites (matching-flow.ts:439 and 526) never call persistSessionState, so the blob is stale; and the DB active_state JSON (persistSessionState, session-state.ts:165-172) omits the field entirely, so the DB-fallback recovery path hardcodes null (round-lifecycle.ts:196).

### Design

(1) matching-flow.ts — add `persistSessionState(data.sessionId, activeSession).catch(() => {});` immediately after every pendingRoundNumber mutation: after line 439 (`activeSession.pendingRoundNumber = nextRound;` pre-plan branch), after line 526 (legacy on-the-fly branch), and after the clear in handleHostCancelPreview (the `activeSession.pendingRoundNumber = null;` at ~line 948). handleHostConfirmRound already persists after its clear (line 613) — leave it. Import persistSessionState from '../state/session-state' if not already imported. PIN CAUTION: phase-2-5-pre-event-planning.test.ts:105-115 asserts indexOf('if (hasPrePlan)') < indexOf('DELETE FROM matches...') within handleHostGenerateMatches — inserting a persist line does not disturb that ordering; lines 152-163 pin maybeRepairFutureRounds call-sites in participant-flow.ts — untouched. (2) session-state.ts — add `pendingRoundNumber: activeSession.pendingRoundNumber ?? null` to the DB `state` object inside persistSessionState (the Redis serializer already has it). (3) round-lifecycle.ts:196 (DB-fallback restore) — change `pendingRoundNumber: null` to `pendingRoundNumber: state?.pendingRoundNumber ?? null`. (4) resolvePendingRound — widen the param type to `{ pendingRoundNumber: number | null; currentRound: number }` and replace the inference SQL with `SELECT MIN(round_number) AS round_number FROM matches WHERE session_id = $1 AND status = 'scheduled' AND round_number > $2` ($2 = activeSession.currentRound). This is now LAST-RESORT only (fires when both Redis blob and DB active_state were lost); MIN(>current) is the only round a preview could be showing. After a successful inference (line 128), also persist. Both call sites (lines 635, 820) already pass activeSession, which has currentRound — no caller changes beyond the type. Behavioral contract: in-memory value wins; recovered-blob value wins next; DB inference is the final fallback and now targets the next-upcoming scheduled round, never the last planned one.

### Code sketch

````
// matching-flow.ts:439 (and same after 526, and after the cancel-preview clear)
activeSession.pendingRoundNumber = nextRound;
persistSessionState(data.sessionId, activeSession).catch(() => {});

// resolvePendingRound
async function resolvePendingRound(
  activeSession: { pendingRoundNumber: number | null; currentRound: number },
  sessionId: string,
): Promise<number | null> {
  if (activeSession.pendingRoundNumber) return activeSession.pendingRoundNumber;
  const sched = await query<{ round_number: number | null }>(
    `SELECT MIN(round_number) AS round_number FROM matches
      WHERE session_id = $1 AND status = 'scheduled' AND round_number > $2`,
    [sessionId, activeSession.currentRound],
  );
  const recovered = sched.rows[0]?.round_number ?? null;
  if (recovered) { activeSession.pendingRoundNumber = recovered; /* persist */ }
  return recovered;
}
````

### Tests to add

- pending-round-recovery.test.ts — source pins: matching-flow.ts contains persistSessionState within 200 chars after each `pendingRoundNumber = nextRound` assignment (assert 2 occurrences); resolvePendingRound SQL contains MIN(round_number) and round_number > $2 and does NOT contain MAX(round_number); session-state.ts persistSessionState state object includes pendingRoundNumber; round-lifecycle.ts DB fallback maps state?.pendingRoundNumber
- Behavioral: mock query; activeSession { pendingRoundNumber: null, currentRound: 2 } with scheduled rows for rounds 3,4,5 → resolvePendingRound returns 3 (not 5) and memoizes
- Behavioral: pendingRoundNumber already set → no query issued
- Round-trip: persistToRedis → restoreAllFromRedis mapping preserves pendingRoundNumber (extend the existing shape used by session-state-snapshot.test.ts:105-115)
- Headed prod smoke: on preview — host opens Match People for round 2 of a 5-round plan, server restarts, host clicks Swap on two previewed users; assert the preview re-renders with the swap applied to ROUND 2's pairs and the Event Plan strip shows rounds 3-5 untouched; then Confirm starts round 2

### Acceptance criteria

- Deploy between Match People and Confirm: Confirm starts exactly the previewed round number (verify round_number in the matches activated)
- Deploy between Match People and Swap/Re-match: the edit lands on the previewed round, never the last planned round
- With the Redis blob intact, the DB inference query is never executed (assert via query mock in unit tests / debug log in smoke)
- Redis lost AND DB active_state lost: inference returns the next-upcoming scheduled round above currentRound

### Pinned tests to update

- None — phase-2-5-pre-event-planning.test.ts:92-125 pins on handleHostGenerateMatches are ordering/substring pins that survive the inserted persist lines; run the file to confirm. session-state-snapshot.test.ts pendingRoundNumber pins (lines 84-135) are unaffected (snapshot service reads the in-memory field).

### Risks

Minimal — three persist calls added on host-action paths (low frequency). The inference can still 'recover' a pending round when no preview was actually open (pre-existing 23-May behavior, unchanged in shape) — but it now targets the round Swap/Re-match would legitimately edit next, so the failure mode is benign.

### Deploy notes

Server-only, no migration/env. Independently shippable in any order relative to LCY-1 (both touch persistSessionState — coordinate the session-state.ts edit if shipped together; if LCY-1 ships first, add the field inside doPersist).

---

## PLT-5 — Deploy-overlap timer fencing: per-session Redis lease gating timer arm + fire

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/timer-lease.ts (new)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/timer-manager.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/orchestration.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/session-state.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/index.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/timer-lease.test.ts (new)`

### Problem

On Render zero-downtime deploys two instances overlap for tens of seconds. initOrchestration (called at index.ts:379, before server.listen at 403) fire-and-forgets recoverActiveSessions (orchestration.service.ts:175), which re-arms every session timer from Redis (round-lifecycle.ts:147-153, 207-214) while the old instance still owns the same timers — double endRound, duplicate rating fanout, and conflicting canonical RMWs cross-process (canonical-state.ts:101-111's serializeRmw is per-process only). The per-bug-ship process makes mid-event deploys routine. Goal: deploy-overlap safety for a single-logical-instance deployment, not HA.

### Design

New module timer-lease.ts with key `rsn:timer-lease:{sessionId}`, value = INSTANCE_ID (randomUUID() at module load), TTL 15s, renewal every 5s. API: tryAcquireTimerLease(sessionId) → boolean via ioredis `set(key, INSTANCE_ID, 'PX', 15000, 'NX')` (treat already-held-by-self as success via a GET check); takeTimerLease(sessionId) → forced SET (no NX) for live arm sites; holdsTimerLease(sessionId) → GET === INSTANCE_ID; releaseTimerLease / releaseAllTimerLeases → Lua compare-and-DEL; startLeaseRenewal/stopLeaseRenewal → one global 5s interval running Lua compare-and-PEXPIRE per held session, dropping lost leases from the in-memory heldLeases Set with a warn. FAIL-OPEN RULE: when getRedisClient() (services/redis/redis.client.ts:13) returns null or any call throws, every function returns the permissive value (acquire=true, holds=true, release=no-op) so behavior without Redis is byte-identical to today. Integration: (1) timer-manager.ts startSegmentTimer gains `opts?: { skipLeaseTake?: boolean }` as a 5th param; at arm time call `void takeTimerLease(sessionId)` unless skipLeaseTake (a live socket-driven arm makes this instance authoritative; the old instance's renewal is compare-and-set so it cannot re-steal and its callbacks start failing the holds check). Wrap the fire: inside the setTimeout (timer-manager.ts:68-84), after clearing fields, replace `callback()` with `holdsTimerLease(sessionId).then(h => { if (!h) { logger.warn({sessionId},'segment timer suppressed — lease held by another instance'); return; } callback(); })`. The suppressed path must return BEFORE any state mutation beyond the local field clears (it does — callbacks own all mutations). (2) round-lifecycle.ts endRound rating backstop (lines 737-742): add `void takeTimerLease(sessionId)` beside the arm and the same holdsTimerLease gate around the endRatingWindow call inside the setTimeout. PIN CAUTION: may25-live-fixes.test.ts:176 forbids the token 'startSegmentTimer' within 60 chars before 'endRatingWindow' — 'holdsTimerLease' is safe. (3) recoverActiveSessions (BOTH the Redis path at 147-153 and the DB path at 207-214): gate the arm: `if (await tryAcquireTimerLease(sessionId)) startSegmentTimer(..., { skipLeaseTake: true }); else scheduleLeaseRetryArm(io, sessionId);`. scheduleLeaseRetryArm: 5s interval, up to 24 attempts; stop if !activeSessions.has(sessionId); on acquire: RE-READ the session blob via a new `restoreOneFromRedis(sessionId)` in session-state.ts (single-key variant of restoreAllFromRedis:243-264), overwrite the in-memory fields (status, currentRound, timerEndsAt, isPaused, pausedTimeRemaining, pendingRoundNumber) — the old instance may have advanced the session during the overlap (this is why PLT-3 depends on LCY-1's persist-after-arm); then if timerEndsAt is in the future arm via startSegmentTimer(skipLeaseTake:true); if timerEndsAt exists but is PAST (segment expired during handover), arm a 1-second timer with getTimerCallbackForState so the missed transition fires once. (4) orchestration.service.ts: call startLeaseRenewal() next to startLiveKitSweep() (line 191). (5) index.ts shutdown() (lines 417-434): FIRST stopLeaseRenewal() + await releaseAllTimerLeases() (dynamic import, try/catch), then the existing io.close/server.close/closePool — release happens within the SIGTERM grace so the new instance's retry acquires in ≤5s. NON-GOALS (state in code comments): no fencing for detectNoShows setTimeout (round-lifecycle.ts:486-488 — reconciles idempotently), manual-room timers (M5, other cluster), or the host-dashboard interval; no split-brain handling beyond the 15s TTL (an old instance that dies without releasing delays takeover by ≤15s).

### Code sketch

````
// timer-lease.ts core
export const INSTANCE_ID = randomUUID();
const KEY = (id: string) => `rsn:timer-lease:${id}`;
const heldLeases = new Set<string>();
export async function tryAcquireTimerLease(id: string): Promise<boolean> {
  const r = getRedisClient(); if (!r) return true; // fail-open
  try {
    const ok = await r.set(KEY(id), INSTANCE_ID, 'PX', 15_000, 'NX');
    if (ok === 'OK') { heldLeases.add(id); return true; }
    if (await r.get(KEY(id)) === INSTANCE_ID) { heldLeases.add(id); return true; }
    return false;
  } catch { return true; }
}
const RELEASE_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

// timer-manager.ts fire gate (inside the existing setTimeout)
holdsTimerLease(sessionId).then(holds => {
  if (!holds) { logger.warn({ sessionId }, 'segment timer suppressed — lease lost (deploy overlap)'); return; }
  callback();
});

// round-lifecycle.ts recoverActiveSessions (both paths)
if (activeSession.timerEndsAt && activeSession.timerEndsAt.getTime() > Date.now() && !activeSession.isPaused) {
  if (await tryAcquireTimerLease(sessionId)) {
    startSegmentTimer(io, sessionId, remainingSec, getTimerCallbackForState(...), { skipLeaseTake: true });
  } else {
    logger.info({ sessionId }, 'timer lease held elsewhere — deferring arm until release');
    scheduleLeaseRetryArm(io, sessionId);
  }
}
````

### Tests to add

- timer-lease.test.ts — with a jest-mocked redis.client (fake in-memory store implementing set/get/eval): NX acquire wins once; second INSTANCE_ID fails; holds flips false after another value overwrites; release deletes only own value; renewal extends only own; fail-open: getRedisClient()→null makes acquire/holds return true and release no-op
- Suppression unit: jest fake timers; arm via startSegmentTimer with the fake redis; overwrite the lease value to 'other-instance'; advance timers; assert callback NOT invoked and the suppression warn logged; restore value; re-arm; assert callback fires
- Retry-arm unit: tryAcquire fails → scheduleLeaseRetryArm polls; release the lease; assert restoreOneFromRedis is consulted and startSegmentTimer armed with remaining time derived from the RE-READ blob (not the boot snapshot); past-endsAt case arms the 1s catch-up timer
- Source pins: recoverActiveSessions contains tryAcquireTimerLease before startSegmentTimer in BOTH recovery paths; startSegmentTimer's setTimeout contains holdsTimerLease before callback(); index.ts shutdown contains releaseAllTimerLeases before io.close; endRound backstop contains holdsTimerLease before endRatingWindow
- Headed prod smoke: 2-browser event on preview with a 90s round; trigger a deploy mid-round; client-side listeners count session:round_ended — assert exactly ONE per round across the deploy, rounds_completed incremented exactly once in DB, timer:sync resumes ≤10s after the old instance exits, and the round ends at the original endsAt ±2s. Repeat once with the deploy landing during ROUND_RATING.

### Acceptance criteria

- Local two-process test (two `npm start` on different ports, same REDIS_URL): process A arms a session timer; process B boots and logs 'timer lease held elsewhere — deferring arm'; B's timer never fires while A lives; SIGTERM A → B acquires ≤10s later and the segment completes exactly once
- Without REDIS_URL configured, every code path behaves exactly as today (no suppression, no deferral) — verified by running the orchestration test suite with getRedisClient mocked to null
- During a real Render deploy mid-round: exactly one round_ended emission, no duplicate rating:window_open fanout, no canonical seq regression in the client logs
- Suppressed callbacks mutate nothing (no DB writes, no broadcasts) — assert via mock in the suppression unit test

### Pinned tests to update

- None — but verify may25-live-fixes.test.ts:172-176 (no 'startSegmentTimer' token within 60 chars before 'endRatingWindow' in endRound) and dr-arch-april-19-bugs.test.ts startSegmentTimer pins after editing timer-manager.ts.

### Risks

Fail-open means a Redis outage during a deploy re-opens today's double-drive window — accepted (no regression vs status quo). The forced takeTimerLease on live arms could suppress an old instance's imminently-firing identical transition — benign, the new instance owns it. The async holds check adds ≤10ms to timer fire. Retry loop leak guarded by the activeSessions.has() stop condition and the 24-attempt cap. The 15s TTL delays takeover after a hard crash of the holder — acceptable for P2 scope.

### Deploy notes

Server-only; requires REDIS_URL (already set in prod; no render.yaml change). MUST ship AFTER LCY-1 (handover re-arms from the persisted timerEndsAt). The deploy that ships this fix is itself unfenced (old binary has no lease logic) — schedule it outside a live event. Coordination: the C4 cluster is wrapping timer callbacks in withSessionGuard — the lease gate composes cleanly (lease check first, guard inside the callback); if both land in the same window, rebase carefully around timer-manager.ts:68-84.

### ⚠ Adversarial review — REQUIRED amendments

**[BLOCKER]** The lease design silently starves timers on a healthy single instance whenever the lease key is MISSING while Redis is up. holdsTimerLease = (GET === INSTANCE_ID) returns false on a missing key; the fire gate then suppresses the callback, and with no second instance nothing ever fires it — round/rating/closing segments never transition (the exact bug class this programme exists to kill). Triggers: (1) Redis restart/failover or key eviction mid-event wipes rsn:timer-lease:* → every armed timer on the only instance is suppressed at fire time; (2) arm under fail-open (sketch: `if (!r) return true` and the catch path return true WITHOUT heldLeases.add) → renewal never maintains a key, Redis recovers, fire-time GET=null → suppressed; (3) any >15s renewal gap expires the key, and the spec's renewal explicitly only 'drops lost leases from heldLeases with a warn' — it never re-acquires. The FAIL-OPEN RULE covers only 'getRedisClient() returns null or any call throws', not key-missing-with-Redis-up. scheduleLeaseRetryArm runs only on the recovery path of another instance, so there is no self-heal.

*Required action:* Make holdsTimerLease reclaim on missing key: if GET returns null, SET key INSTANCE_ID PX 15000 NX and return true (only return false when the key holds a DIFFERENT instance id). Make the renewal re-acquire (SET PX NX) instead of dropping, and add heldLeases.add in the fail-open/catch paths or track armed sessions independently of Redis success.

**[IMPORTANT]** Missed pinned-test collision: server/src/__tests__/services/orchestration/phase6-timer-refetch.test.ts (lines 24-34 and 41-47) behaviorally pins startSegmentTimer's fire path with jest fake timers and asserts `fired === true` synchronously immediately after jest.advanceTimersByTime(1000). Wrapping callback() in `holdsTimerLease(sessionId).then(...)` (spec's fire-gate at timer-manager.ts:68-84) defers the callback to a promise microtask that does not flush inside advanceTimersByTime — both tests fail. The test does NOT mock redis.client or timer-manager (unlike phase4-eviction-lobby.test.ts:75-84 which mocks timer-manager wholesale and is safe). PLT-3's pinnedTestsToUpdate says 'None' and names only may25-live-fixes and dr-arch-april-19.

*Required action:* List phase6-timer-refetch.test.ts in pinnedTestsToUpdate: either make the gate synchronously short-circuit when getRedisClient() is null (preserving today's sync fire in the no-Redis path, which also matches the fail-open contract), or update the tests to await microtask flush.

**[NIT]** takeTimerLease is specified only as 'forced SET (no NX)' — the PX 15000 TTL is implied by the module description but not stated for this call; a literal `r.set(key, INSTANCE_ID)` leaves an immortal key after a hard crash, permanently blocking takeover (NX fails, GET mismatch forever). Separately, scheduleLeaseRetryArm's 24-attempt/2-minute cap silently abandons the arm if the old instance outlives the cap (long drain), with nothing re-triggering acquisition afterwards.

*Required action:* Spell out SET key INSTANCE_ID PX 15000 (no NX) for takeTimerLease, and either raise/re-trigger the retry cap or fall back to a periodic holds-check that re-runs the arm.

---

## PLT-6 — LiveKit token hygiene: 15-min TTL, host-mute honored on re-mint, kick evicts all session rooms, removed-guard on webhook heal

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/session/session.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/livekit-sweep.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/host-actions.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/video/video.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/video/livekit.provider.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/livekit-token-hygiene.test.ts (new)`

### Problem

Four verified gaps. (a) generateLiveKitToken (session.service.ts:769-776) clamps TTL to 1800-14400s — a kicked/left user's token stays valid up to 4h and LiveKit tokens cannot be revoked. (b) The same function grants canPublish:true unconditionally (line 821) — the comment in livekit.provider.ts:225-229 claims 'the mute persists in DB and will apply when they re-issue a token' but no mint path reads host_muted, so a muted participant's refresh restores full mic. (c) The webhook participant_joined heal (webhooks.ts:47-48 → healParticipantConnState, livekit-sweep.ts:27-38) lacks the sweep's 'never resurrect a kicked user' guard (livekit-sweep.ts:56) — a kicked user replaying a still-valid token flips canonical connState back to connected. (d) Kick eviction (host-actions.ts:1029-1030) covers only the lobby + the user's current match room. SDK verified: livekit-server-sdk ^2.0.0 — RoomServiceClient.removeParticipant exists (used at provider:133,180), AccessToken.ttl in seconds exists (used at provider:103-107), VideoGrant.canPublishSources: TrackSource[] exists (TrackSource already imported and used at provider:204-217).

### Design

(a) TTL — session.service.ts: replace lines 769-776 with `const ttl = Number(process.env.LIVEKIT_TOKEN_TTL_SECONDS || 900);` (15 min, env-overridable for rollback). Safe because: every reconnect rail re-mints (handleResync mints per resync; the seq-guarded state:snapshot rail mints on location change; REST POST /token is the fallback — generateLiveKitToken is the single chokepoint per the June-11 comment at lines 749-755), and LiveKit Cloud refreshes tokens for already-connected participants automatically (livekit-client handles tokenRefresh), so long events are unaffected; only the replay window for departed users shrinks. KEEP the June-11 status gate (lines 756-760) byte-identical — it is pinned. Also align the default in livekit.provider.ts:93 (3600 → 900) for the unused-in-prod issueJoinToken path. (b) Host-mute on mint — in generateLiveKitToken, membership is already fetched via SELECT * (line 744-747); read `const hostMuted = (membership as any)?.host_muted === true;` (raw pg snake_case key; host/cohost callers without a row → false). Build the grant conditionally: when hostMuted, add `canPublishSources: [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]` (exact mirror of the whitelist in livekit.provider.ts:204-206 — mic revoked, camera/screen intact); import TrackSource via the existing dynamic `await import('livekit-server-sdk')` at line 737. Update the stale provider comment at livekit.provider.ts:225-229 to reference generateLiveKitToken. (c) Removed-guard at the shared chokepoint — healParticipantConnState (livekit-sweep.ts:27-38): before writing, when connState==='connected', `const doc = await readCanonical(sessionId); if (doc?.participants[userId]?.connState === 'removed') { logger.info(...,'heal refused — user is removed'); return; }` (readCanonical already imported at line 20). Placing it in the chokepoint covers the webhook AND keeps the sweep aligned (the sweep's own check at line 56 stays as cheap pre-filter). Additionally, in reconcileRoomRoster's removed-branch (line 56), replace the bare `continue` with best-effort eviction: `void (await import('../../video/video.service')).evictFromRoom(p.userId, roomId); continue;` — a kicked user replaying a still-valid token is now physically removed from the SFU within one 15s sweep tick. (d) Kick evicts all rooms — add to video.service.ts: `export async function evictFromAllSessionRooms(sessionId: string, userId: string): Promise<void>` — rooms = lobbyRoomId(sessionId) ∪ `SELECT DISTINCT room_id FROM matches WHERE session_id=$1 AND room_id IS NOT NULL AND status IN ('active','scheduled')`; evict via Promise.allSettled in 20-wide batches (same BATCH_SIZE pattern as cleanupLiveKitRooms, round-lifecycle.ts:1070-1080); never throws (wrap per-call like evictFromRoom). In host-actions.ts handleHostRemoveParticipant replace lines 1029-1030 with `await videoService.evictFromAllSessionRooms(data.sessionId, data.userId);` (keep evicting kickMatchRoomId implicitly via the query; the room of a just-ended pair may already be closed — harmless no-op).

### Code sketch

````
// session.service.ts generateLiveKitToken
const ttl = Number(process.env.LIVEKIT_TOKEN_TTL_SECONDS || 900); // VID-1: short-lived; all rails re-mint, LiveKit refreshes connected clients
const hostMuted = (membership as any)?.host_muted === true;
const { AccessToken, TrackSource } = await import('livekit-server-sdk');
const grant: any = { room: roomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true };
if (hostMuted) {
  // mirror of livekit.provider.setParticipantCanPublishAudio whitelist — mic stays revoked across refresh/reconnect
  grant.canPublishSources = [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];
}
at.addGrant(grant);

// livekit-sweep.ts healParticipantConnState
if (connState === 'connected') {
  const doc = await readCanonical(sessionId);
  if (doc?.participants[userId]?.connState === 'removed') {
    logger.info({ sessionId, userId }, 'connState heal refused — participant is removed (kick terminality)');
    return;
  }
}
await updateCanonicalParticipant(...);
````

### Tests to add

- livekit-token-hygiene.test.ts — behavioral: mock db query so membership = { status: 'in_lobby', host_muted: true }; call generateLiveKitToken; jwt.decode the token: assert payload.video.canPublishSources deep-equals ['camera','screen_share','screen_share_audio'] and exp-iat === 900; with host_muted:false assert canPublishSources absent and canPublish true
- Behavioral: healParticipantConnState('connected') against a fake-redis canonical doc with connState:'removed' → doc unchanged (updateCanonicalParticipant not called); 'disconnected' heal still writes; non-removed 'connected' heal still writes
- Source pins: generateLiveKitToken contains LIVEKIT_TOKEN_TTL_SECONDS and does NOT contain 14400; contains canPublishSources within the function; healParticipantConnState contains the removed check BEFORE updateCanonicalParticipant (indexOf ordering); handleHostRemoveParticipant calls evictFromAllSessionRooms; reconcileRoomRoster contains evictFromRoom in the removed branch
- evictFromAllSessionRooms unit: mock query returning 25 room_ids → provider.removeParticipant called for lobby + all 25, in batches of ≤20, and a thrown removeParticipant does not reject the whole call
- Existing pins must stay green: june11-kick-token-and-cohost.test.ts:39-48 (status !== 'removed'/'left' + ForbiddenError pins — do not touch those lines), may21-rating-window-default-pin.test.ts, canonical-100-shipC.test.ts:61, phase-o-authoritative-mute-state.test.ts
- Headed prod smoke: 3-browser event — (1) host mutes B; B hard-refreshes; assert B's mic track is never published post-refresh (A sees B's tile with no audio indicator; B's mic toggle errors) while B's camera stays live; (2) host kicks C mid-round; assert C's video disappears from A within 2s, C's client lands on the removed screen, and a scripted rejoin attempt from C's browser context replaying the cached token is removed from the room within 15s with canonical connState still 'removed' (query /state as host); (3) decode A's token from the network tab: exp-iat === 900; (4) soak: A idles in the lobby 20+ minutes — video stays connected (LiveKit refresh) and a refresh at minute 20 re-mints and rejoins cleanly

### Acceptance criteria

- Every minted room token on every rail (resync, snapshot, REST /token) carries exp-iat ≤ 900s (env-overridable)
- A host-muted participant cannot publish microphone after refresh, reconnect, or round transition — at the SFU permission level, not just client UI — while camera/screen-share remain
- A kicked user is absent from ALL the session's LiveKit rooms ≤2s after the kick and cannot re-enter for more than one sweep tick (≤15s) by replaying a cached token; canonical connState never returns to 'connected'
- A LiveKit participant_joined webhook for a removed user never resurrects their canonical connState
- A 20-minute idle lobby participant stays connected and can refresh-rejoin (no TTL regression for legitimate users)

### Pinned tests to update

- None to modify — but three suites constrain the edit and MUST be run: june11-kick-token-and-cohost.test.ts (sliceFn over generateLiveKitToken — keep the status-gate lines and ForbiddenError string intact), phase-o-authoritative-mute-state.test.ts (its header comment describes this exact 'future LiveKit permission integration' — consider updating the comment text in the test header, not the pins), may25/may21 pin files indirectly touching token rails.

### Risks

Short TTL: any flow that mints a token and connects >15min later would 401 — the soak smoke covers the pre-lobby/idle case, and LIVEKIT_TOKEN_TTL_SECONDS allows instant rollback via Render env without a deploy. canPublishSources whitelist semantics must exactly match the provider's live-update whitelist or mute/unmute would diverge between live enforcement and re-mint (mirrored arrays, pinned by test). The sweep-evict for removed users adds removeParticipant calls — bounded by roster size and best-effort. The extra readCanonical per webhook heal is one Redis GET (webhook volume concern belongs to C3's limiter fix, independent).

### Deploy notes

Server-only, single deploy; no migration. Optional env LIVEKIT_TOKEN_TTL_SECONDS (code default 900 — no render.yaml change required, but document the override). No client changes (client already re-mints on every rail). Smoke immediately after deploy with the kick + mute scenarios; keep the env override handy as the rollback lever for the TTL half while the rest of the change can stay.

### ⚠ Adversarial review — REQUIRED amendments

**[BLOCKER]** Item (d) re-opens the June-10 #4 kick bug for the most common case (pair kick). handleHostRemoveParticipant calls matchingService.demoteParticipantFromMatch(kickMatch.id, userId, 'completed') at server/src/services/orchestration/handlers/host-actions.ts:939-941 BEFORE the eviction site at :1029-1030, so by eviction time the kicked user's pair match is status='completed' (trio stays 'active'). The spec replaces the explicit evictFromRoom(userId, kickMatchRoomId) at :1030 with evictFromAllSessionRooms whose query is `status IN ('active','scheduled')` and claims kickMatchRoomId is kept 'implicitly via the query' — false: the completed match's room_id is invisible to that query. room-end-early.ts never closes the LiveKit room or evicts (grep: zero closeRoom/deleteRoom/evictFromRoom hits in endRoomEarlyForSurvivors), and the sweep (livekit-sweep.ts:97-100) also only enumerates 'active' match rooms, so the kicked user's SFU connection in their own breakout room survives indefinitely — failing VID-1's own acceptance ('absent from ALL rooms ≤2s').

*Required action:* Keep the explicit kickMatchRoomId eviction at host-actions.ts:1030 (or pass kickMatchRoomId into evictFromAllSessionRooms as an extra room, or widen the status filter to include the just-terminated match). Add a unit test for the pair-kick case where the match is already 'completed' at eviction time.

**[IMPORTANT]** Wrong line citations would break a literal implementer in session.service.ts: (1) 'replace lines 769-776' — the dynamic-TTL block is actually 775-782 (clamp `Math.max(1800, Math.min(14400, ...))` at :782); lines 769-773 are the displayName fetch consumed at :787 (`name: displayName`) and :776 is the sessionConfig parse. Literal replacement deletes the displayName lookup (compile error, or `name: undefined` if mis-fixed). (2) 'grants canPublish:true unconditionally (line 821)' — the addGrant is at :827 (:821 is `roomName = roomId;`). (3) 'KEEP the June-11 status gate (lines 756-760) byte-identical' — 755-761 is comment text; the pinned gate code (membership/isActiveMember/ForbiddenError, pinned by june11-kick-token-and-cohost.test.ts:39-51) is at :762-766.

*Required action:* Correct the ranges: replace only 775-782 with the env-driven ttl const; cite the grant at :827 and the pinned gate at :762-766. Everything else in VID-1 (a)/(b) checks out (SELECT * at 744-747, dynamic import at 737, TrackSource whitelist mirror at livekit.provider.ts:204-206, stale comment at 225-229, no production callers of issueJoinToken).

**[NIT]** Item (c)'s removed-guard in healParticipantConnState does readCanonical OUTSIDE the serializeRmw chain (canonical-state.ts:101-111), then enqueues the connected-write — a heal racing the kick's removed-write in the chain can still resurrect connState in a small TOCTOU window. Same shape as the existing sweep pre-filter at livekit-sweep.ts:49/56, so no regression, but the spec presents the guard as closing kick terminality at the chokepoint.

*Required action:* Optionally move the removed check inside the RMW mutator (conditional patch in updateCanonicalParticipant) for total ordering; otherwise document the residual window.

## Reviewer-verified facts (safe to rely on)

- PLT-1 corpus claims verified by script: exactly 37/68 migration files contain a line-anchored wrapper BEGIN;/COMMIT; pair (74 total occurrences, exactly one pair per file); in all 37 the first non-comment statement is BEGIN; and the last is COMMIT;; zero non-wrapper transaction-control tokens, zero /* */ block comments, zero CREATE INDEX CONCURRENTLY in the corpus; plpgsql BEGINs are all inside $$ regions (042_active_only_uniqueness_trigger.sql:33-62 read in full); the 060 duplicate pair exists and sorts stably; db/index.ts:6 carries the Neon-pooler comment; no test references runMigrations or db/migrate (grep of server/src/__tests__), while phase-1-greedy-completeness.test.ts:239-260 and phase-o-authoritative-mute-state.test.ts:46-56 do pin migration FILE text, supporting the runtime-strip recommendation; runMigrations per-file BEGIN..COMMIT block is migrate.ts:49-65 as cited
- PLT-2 symbols verified: gates exact at matching.engine.ts:232 (`n <= 30 && n >= 2 && n % 2 === 0`) and :300 (`greedyUnmatched.length >= 2 && n % 2 === 0 && n <= 30`); both blocks call the SAME exponential DFS findCompleteMatching(participants, candidates, usedPairs, hardExclusions) at :233-235/:301-303 (audit's 'polynomial augmenting search' correction is right — :591-660 is plain backtracking); fresh-first adjacency sort at :618-620; docblock :580-590; stale comments at :222-228/:282-295; nothing mutates candidates between :246 and :300 (greedy loop :251-280 is read-only on candidates), so the run-at-most-once memo is valid within one engine generateSingleRound call (engine private method at :153 — spec's function name is correct); the engine's adopt blocks are :237-243/:309-320 as cited
- PLT-2 pinned-test claims verified: phase-2-5-pre-event-planning.test.ts:178 contains the exact pin regex the spec quotes, describe title at :171, header at :15, greedy-fallback pin at :181-183; this is the ONLY test file pinning n<=30 against the engine (repo-wide grep); fresh-first-selection.test.ts is purely behavioral (zero readFileSync/toMatch), phase-1-greedy-completeness.test.ts:121-143 is the 4-all-met byes case as cited; the proposed negative pin not.toMatch(/n\s*<=\s*30/) is safe because the only ASCII 'n <= 30' occurrences in matching.engine.ts are the two gates being removed (comments use unicode ≤)
- LCY-1 symbols verified: timer-manager.ts sets timerEndsAt at :65, fire path nulls it at :68-84, timerSyncInterval assignment at :159, module already imports ActiveSession/activeSessions/sessionRoom from session-state (:8-12, no import cycle); round-lifecycle.ts persists at :274 but arms at :481, endRound persists at :563 before the backstop arm at :734-742 (`}, RATING_BACKSTOP_MS);` at :742), CLOSING_LOBBY startSegmentTimer(io, sessionId, 600, ...) at :853, recovery arm-from-timerEndsAt at :147-153 (Redis) and :207-214 (DB); may25-live-fixes.test.ts:172-179 negative pin (/startSegmentTimer[\s\S]{0,60}endRatingWindow/ within the endRound slice) verified verbatim — the specified insertions do not violate it; dr-arch-april-19-bugs.test.ts:84-123 pins (2000ms sync interval regex, endsAt in the sync block) survive the insertions; phase3-canonical-authority.test.ts:23-27 is the partial-mock pattern cited (:25 = persistSessionState jest.fn)
- LCY-2 root-cause claims all verified: resolvePendingRound at matching-flow.ts:118-130 uses MAX(round_number) over scheduled; pendingRoundNumber IS serialized to Redis (session-state.ts:212) and restored (round-lifecycle.ts:128) but omitted from the DB active_state object (session-state.ts:165-172) and hardcoded null in the DB fallback (round-lifecycle.ts:196); set sites are exactly :439, :526 (both `= nextRound`), the confirm clear at :612 already followed by persistSessionState at :613, and the cancel-preview clear at :948 inside handleHostCancelPreview — repo-wide grep confirms no other pendingRoundNumber assignment sites; resolvePendingRound call sites are :635 (handleHostSwapMatch) and :820 (handleHostRegenerateMatches), both passing the full ActiveSession (has currentRound); persistSessionState already imported at :24; phase-2-5 pins :105-115 (hasPrePlan before DELETE ordering) and :152-163 survive the inserted persist lines; session-state-snapshot.test.ts pendingRoundNumber assertions (~:84-135) read the in-memory field only
- PLT-3 environment claims verified: initOrchestration called at index.ts:379 before server.listen at :403; recoverActiveSessions fire-and-forgotten at orchestration.service.ts:175; startLiveKitSweep at :191; shutdown (index.ts:417-434) currently releases nothing; Socket.IO Redis adapter wired at index.ts:366-371; getRedisClient at redis.client.ts:13 returns null when unavailable (fail-open base is real); canonical-state.ts:101-111 is serializeRmw (per-process only, as the spec says); detectNoShows setTimeout at round-lifecycle.ts:486-488; ioredis ^5.10.1 supports set(key, val, 'PX', ms, 'NX') and eval for the Lua compare-and-del/pexpire; the 60s Promise.race the audit cites is at matching-flow.ts:497-501
- VID-1 claims verified: generateLiveKitToken at session.service.ts:736-837 with SELECT * membership at :744-747, status gate code at :762-766 (pinned by june11-kick-token-and-cohost.test.ts:39-51 — sliceFn covers the whole function; pins are status !== 'removed', NOT status !== 'left', the ForbiddenError string), TTL clamp 1800-14400 at :775-782, unconditional canPublish:true addGrant at :827, dynamic import('livekit-server-sdk') at :737; livekit.provider.ts:93 default 3600, AccessToken ttl :103-107, removeParticipant :133/:180, TrackSource imported (:9) and whitelist arrays :204-206 exactly as the spec mirrors, stale comment :225-229; healParticipantConnState at livekit-sweep.ts:27-38 with readCanonical imported at :20; sweep removed-guard at :56; webhook participant_joined heal at webhooks.ts:~47-48 has no removed guard; generateLiveKitToken is the single production chokepoint (callers: routes/sessions.ts:444 REST /token, state-snapshot.ts:114 resync/snapshot rail; issueJoinToken has zero production callers); cleanupLiveKitRooms BATCH_SIZE=20 at round-lifecycle.ts:~1071-1080; evictFromRoom never throws (video.service.ts:116-122); livekit-server-sdk ^2.0.0 and client livekit-client ^2.17.2 pinned in package.json; no test pins the provider's 3600 token default or 14400 in session.service; phase-u/phase-x whitelist pins target the provider lines VID-1 leaves untouched
- Audit doc exists at docs/AUDIT-2026-06-12-live-30-50-readiness.md and its mediums list confirms the unbounded-backtracking and persist-before-arm claims the spec builds on; repo is on branch june9-punchlist with the June-11 kick-token gate commit (c5da95e) present

