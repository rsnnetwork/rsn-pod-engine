# SDD 06 — M1 join cost + M4 bulk breakout + M5 timer recovery + socket throttling

Part of the RSN 30-50 scale fix programme. Baseline: `june9-punchlist` @ `4717268`. Read `SDD-00-MASTER.md` first for ground rules, ship order, and process.

**Review verdict for this cluster: needs-changes.** Every issue listed under a work item below is a REQUIRED amendment to that item's design — apply the issue's suggestion over the original text wherever they conflict.

## Cluster notes (designer)

Cluster join-scale covers audit items M1 (join serialization cliff), M4 (bulk breakout freeze), M5 (unrecovered timers), the mute-all concurrency medium, and the socket-rate-limiting medium. All audit citations were re-verified against the code on branch june9-punchlist; line references in the work items are from the current files, which drift slightly from the audit's (e.g. handleJoinSession is 430-1111, mute-all is host-actions.ts:1331-1412, manual timers 2616-2707/2911-3006).

Verified library facts: server socket.io ^4.7 (socket.data available; no built-in per-event rate limiter → custom token bucket, no new dep), express-rate-limit ^7.1 + rate-limit-redis ^4.3 exist but are HTTP-only (not used here), livekit-server-sdk ^2.0 (RoomService calls already wrapped by video.service; 15-20-wide concurrency matches the existing ROOM_BATCH_SIZE=20 precedent at round-lifecycle.ts:308-338). tsconfig.base has noUnusedLocals:true — this is why JNS-3 must prune the breakout-bulk import list and update one pin (the only pinned-test change in the whole cluster; every other item was designed around the existing pins, which are enumerated per item).

Recommended ship order (one fix per deploy, headed prod smoke between): JNS-1 → JNS-2 → JNS-3 (depends on JNS-2 for breakout-bulk.ts merge cleanliness; also carries migration 068) → JNS-4 → JNS-5. JNS-1/JNS-4/JNS-5 are mutually independent if re-ordering is needed.

Cross-cluster coordination: (a) C4 cluster plans to wrap normal-operation timer callbacks in withSessionGuard — JNS-3 already guard-wraps the re-architected no-show timer using the same timerCallbacks pattern (orchestration.service.ts:128-133); the C4 implementer should not double-wrap it. (b) M7 deploy-overlap fencing (other cluster) interacts with JNS-3: recovery now re-arms MORE timers, all of whose callbacks are idempotent (status-guarded UPDATEs + emitRatingWindowOnce dedup), but fencing remains the real fix for two-instance double-driving. (c) M8 migration-runner hardening: migration 068 is written to the hardened spec (no inner BEGIN/COMMIT, IF NOT EXISTS) and is metadata-only, but lands a brief ACCESS EXCLUSIVE on matches — deploy JNS-3 outside a live round until M8's lock_timeout ships. (d) C3/M10 (snapshot storm, fanout collapse) is another cluster; JNS-1 deliberately keeps the participant:count emit and roster:changed broadcast semantics unchanged so that cluster can collapse them independently.

Final verification gate for the cluster (matches the audit's recommendation): extend the existing 20-browser canonical-state load harness to 40+ browsers against a preview — assert join-burst tail latency < 5s (JNS-1), bulk-create non-blocking (JNS-2), a mid-run deploy preserving manual-room timers and rating backstop (JNS-3), mute-all under load (JNS-4), and zero rate-limit drops for legitimate traffic with one flood client fully shed (JNS-5).

---

## JNS-1 — M1 — Shrink the withSessionGuard critical section in handleJoinSession to 3-5 DB round-trips

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/participant-flow.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/session-state.ts (read-only reference: withSessionGuard at 117-131)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/m1-join-guard-slim.test.ts (new)`

### Problem

handleJoinSession (participant-flow.ts:430-1111) runs its ENTIRE body inside withSessionGuard — 10-20 sequential DB round-trips per join, including the display-name SELECT, getSessionById, snapshot build (fetchSockets + 4-6 queries), participant-count query, and the host-dashboard replay (4+ queries). The same lock serializes leaves, ratings, host actions and the guard-wrapped timer callbacks (orchestration.service.ts:128-133). A post-deploy 50-socket reconnect storm queues 5-15s of tail latency and starves expiring round timers behind the join queue.

### Design

Restructure handleJoinSession into three phases, all remaining inside the single exported function (every source-pin test slices on 'export async function handleJoinSession' — moving code into other functions breaks them; moving it within the function does not, provided the comment anchors keep their relative order, see below).

PHASE 0 — PRE-LOCK (runs before withSessionGuard):
1. userId null-check + UNAUTHORIZED emit (current lines 437-441).
2. Display-name refresh SELECT (444-449). Pure read; no invariant.
3. `const session = await sessionService.getSessionById(data.sessionId)` (451). Used for hostUserId + status fallback. hostUserId is stable except the rare promote-cohost baton pass — acceptable ms-level staleness (see risks).

PHASE 1 — INSIDE withSessionGuard(data.sessionId, …). Keep, in this exact order (order is pinned):
 a. Cross-session presence eviction loop (457-464) and same-session single-socket eviction (468-481) — presenceMap writes + socket disconnects must be serialized.
 b. On-the-fly ActiveSession recovery (512-534). CHANGE: because `session` is now read pre-lock, when `!activeSession` re-read ONLY the status cheaply inside the lock before creating the entry: `SELECT status, config, current_round, host_user_id FROM sessions WHERE id = $1` (1 RT, fires only on the rare recovery path) and build the ActiveSession from that fresh row. This preserves the invariant that two concurrent joins cannot create divergent ActiveSession objects and that the recovered status is not stale.
 c. disconnectTimeouts cancel (537-542), socket.join sessionRoom/userRoom (545-546), setPresence (549-555).
 d. registerParticipant + the REMOVED_FROM_EVENT bounce (560-582). On the bounce, the guarded closure must `return { proceed: false }` so Phase 2 is skipped entirely (a kicked user must trigger NO broadcasts/snapshot). Keep the `session:evicted` + reason 'removed_from_event' text verbatim (pinned by june10-kick-is-terminal.test.ts).
 e. `void maybeRepairFutureRounds(...)` trigger (589-591) — just schedules, keep here.
 f. Participant-status update block with the Bug 37.1 / S20 comments and shape (603-629) — pinned; must stay BEFORE the '// ── FIX A: Defensive status reset' comment.
 g. FIX A defensive reset (639-695). CHANGE: collapse the two SELECTs (userActiveMatch at 640-645 + currentRow at 653-656) into ONE combined query (see codeSketch). The combined query must contain the literal text 'FROM matches' BEFORE the condition `currentStatus === 'left' || currentStatus === 'disconnected' || currentStatus === 'in_round'` (both pinned — disconnect-rejoin.test.ts:166-200, phase-may19-bugs-33-36-37-44.test.ts:72-82). Keep the variable name `currentStatus`, the exact 3-way condition, and `transitionParticipant(..., ParticipantState.IN_MAIN_ROOM)`.
 h. manuallyLeftRound.delete (900-902).
 i. KEEP IN-LOCK the state-dependent replays (they only execute in their statuses, so the 50-join lobby storm never pays for them): the ROUND_ACTIVE match-restore block (905-957: getMatchesByRound + partner names + IN_ROUND restore + match:assigned + match:partner_reconnected), the WS2 late-return rating replay (958-1022), and the ROUND_RATING rating replay gated by `const ratingReplayStatuses = [SessionStatus.ROUND_RATING]` (1034-1096, declaration line pinned by june10-skip-ratings-no-revert.test.ts). Rationale: these emits walk users into rooms; today they are serialized against endRound/endRatingWindow (both run under the same guard via timerCallbacks), and moving them out re-opens the ghost-room/closed-window-replay family. The guarded closure returns `{ proceed: true, activeSession, isHost }`.

PHASE 2 — POST-LOCK (after the guard resolves; skipped when proceed=false):
 j. The '// Notify others — include isHost flag' comment + participant:joined broadcast (697-703) — comment text must be preserved verbatim; it is the slice END-marker for the Bug-36 pin, and FIX A must remain earlier in the file than it (satisfied: FIX A is in Phase 1, this is Phase 2).
 k. roster:changed broadcast (714-717), fanSessionRoomEntities (721-724).
 l. getParticipantCount + participant:count emit (727-728), scheduleParticipantListBroadcast (733).
 m. T0-3 snapshot build + unicast (740-774). Invariant: built AFTER the status/presence commits — guaranteed because Phase 2 runs strictly after the guarded closure resolved; buildSessionStateSnapshot reads activeSessions + DB + fetchSockets, all post-commit. It may include even newer state from a concurrent join — fine, snapshots are convergent and the client field-guards partial payloads.
 n. Host-dashboard replay block (782-868) and BOTH emitHostDashboard branches incl. the 'Bug 44' comment + `activeSession.status !== SessionStatus.ROUND_ACTIVE` + `emitHostDashboard(data.sessionId)` (876-897) — text pinned (phase-may19 test, Bug 44 describe), keep verbatim.
 o. chat:history send (1098-1103) — in-memory, no DB.

Keep ONE outer try/catch around all three phases emitting `{ code: 'JOIN_FAILED' }` (current 1106-1109).

Resulting in-lock round-trips, common case (LOBBY_OPEN / ROUND_TRANSITION join — the storm case): registerParticipant (1) + updateParticipantStatus chokepoint (1-2) + combined FIX-A query (1) + optional transitionParticipant (2 when stuck) = 3-5. ROUND_ACTIVE joins add the restore block (~3 more) only for mid-round reconnects.

### Code sketch

````
export async function handleJoinSession(io, socket, data) {
  try {
    const userId = getUserIdFromSocket(socket);
    if (!userId) { socket.emit('error', { code: 'UNAUTHORIZED', ... }); return; }
    // PHASE 0 — pre-lock reads (M1): pure reads, no session-state writes.
    const freshNameResult = await query(...);            // moved from inside guard
    if (...) (socket.data as any).displayName = ...;
    const session = await sessionService.getSessionById(data.sessionId);

    const guarded = await withSessionGuard(data.sessionId, async () => {
      // a. cross-session + single-socket eviction (unchanged)
      // b. on-the-fly recovery — RE-READ status inside the lock:
      if (!activeSession) {
        const fresh = await query(`SELECT status, config, current_round, host_user_id FROM sessions WHERE id = $1`, [data.sessionId]);
        // build ActiveSession from `fresh`, not the pre-lock `session`
      }
      // c. timeout cancel, socket.join, setPresence (unchanged)
      // d. registerParticipant; REMOVED_FROM_EVENT bounce:
      //      socket.leave(...); socket.emit('session:evicted', { reason: 'removed_from_event' });
      //      return { proceed: false as const };
      // f. status block (Bug 37.1 / S20 — text unchanged)
      // g. FIX A — combined single query:
      const fixA = await query<{ status: string; active_match_id: string | null }>(
        `SELECT sp.status,
                (SELECT m.id FROM matches m
                  WHERE m.session_id = $1 AND m.status = 'active'
                    AND (m.participant_a_id = $2 OR m.participant_b_id = $2 OR m.participant_c_id = $2)
                  LIMIT 1) AS active_match_id
           FROM session_participants sp
          WHERE sp.session_id = $1 AND sp.user_id = $2`,
        [data.sessionId, userId]);
      const currentStatus = fixA.rows[0]?.status;
      const hasActiveMatch = !!fixA.rows[0]?.active_match_id;
      if (!hasActiveMatch && (currentStatus === 'left' || currentStatus === 'disconnected' || currentStatus === 'in_round')) {
        const result = await transitionParticipant(data.sessionId, userId, ParticipantState.IN_MAIN_ROOM);
        ...
      }
      // h. manuallyLeftRound; i. ROUND_ACTIVE restore + late-return + ROUND_RATING replay (unchanged text)
      return { proceed: true as const, activeSession };
    });
    if (!guarded.proceed) return;
    const activeSession = guarded.activeSession;
    const isHost = session.hostUserId === userId;
    // PHASE 2 — post-lock fanout: '// Notify others — include isHost flag' …
    // participant:joined, roster:changed, fanSessionRoomEntities, count,
    // scheduleParticipantListBroadcast, snapshot unicast, host dashboard replay
    // (incl. the pinned Bug 44 branch), chat history.
  } catch (err) { socket.emit('error', { code: 'JOIN_FAILED', message: err.message }); }
}
````

### Tests to add

- NEW server/src/__tests__/services/orchestration/m1-join-guard-slim.test.ts — source pins: (1) the display-name SELECT and getSessionById appear BEFORE the `withSessionGuard(data.sessionId` call inside handleJoinSession (index comparison on the fn slice); (2) `buildSessionStateSnapshot` and `getParticipantCount` appear AFTER the guarded closure's closing `});` (pin via: index of 'buildSessionStateSnapshot' > index of `return { proceed: true`); (3) the REMOVED_FROM_EVENT branch returns proceed:false and no 'participant:joined' emit exists between the bounce and the closure end; (4) the on-the-fly recovery branch re-reads `SELECT status` inside the guard.
- Functional (jest, mocked db/io, same mocking style as disconnect-rejoin.test.ts): a join where registerParticipant throws REMOVED_FROM_EVENT emits session:evicted and emits NEITHER participant:joined NOR roster:changed NOR session:state.
- Functional: a normal LOBBY_OPEN join still emits participant:joined, roster:changed, participant:count and the session:state unicast (assert all four on the io/socket mocks) — proves Phase-2 wiring survived the move.
- Run the FULL existing suite — disconnect-rejoin.test.ts, phase-may19-bugs-33-36-37-44.test.ts, s14, s18, s20, ws2-room-ends-below-two, june10-* must pass unchanged.
- Headed Playwright prod smoke: 12-15 browsers join one event within ~3s of each other (reuse the 20-browser canonical-state load harness); assert every browser reaches the lobby with the full roster within 5s, then mid-round kill+rejoin one browser and assert it lands back in its breakout (match restore intact); while the join burst is in flight, the host presses a timer-adjacent action (Extend Round) and it applies within 2s (lock not starved).

### Acceptance criteria

- In-lock DB round-trips for a LOBBY_OPEN/ROUND_TRANSITION join ≤ 5 (count by code inspection + a debug log of queries issued inside the guard in dev).
- All existing handleJoinSession source-pin tests pass WITHOUT modification (the comment anchors '// ── FIX A: Defensive status reset', '// Notify others — include isHost flag', 'Bug 37.1', 'Bug 44', the ratingReplayStatuses declaration line, and the left/disconnected/in_round condition are unmoved relative to each other).
- Kicked user rejoin: session:evicted emitted, zero room broadcasts.
- Headed smoke: 15-browser join burst, all lobbies rendered < 5s; reconnect-mid-round restore works; host action during burst applies < 2s.

### Risks

1) Emit-order change: match:assigned (Phase 1) now precedes the joiner's own session:state unicast (Phase 2). The client treats them independently and field-guards session:state, and the seq-guarded state:snapshot rail carries tokens — verified low risk, but the headed smoke must cover mid-round reconnect explicitly. 2) Pre-lock getSessionById can be stale across a concurrent promote-cohost (hostUserId) — isHost on the participant:joined payload could be momentarily wrong; the debounced roster rail corrects it. 3) On-the-fly recovery now needs the in-lock status re-read — if the implementer forgets it, a SCHEDULED→LOBBY_OPEN race can recreate a stale ActiveSession (this is why it is spelled out). 4) Any helper extraction OUT of handleJoinSession breaks the sliceFn-based pins — restructure must stay inside the function.

### Deploy notes

Server-only, no migration, no env, no render.yaml, no client change. Safe under Render's two-instance overlap (no schema/state-format change). Ship alone (one fix per deploy), run full local suite before push, headed prod smoke after deploy per standing process.

### ⚠ Adversarial review — REQUIRED amendments

**[IMPORTANT]** The acceptance gate 'in-lock DB round-trips ≤ 5, count by … a debug log of queries issued inside the guard' is unachievable as written. The spec counts registerParticipant as '(1)', but registerParticipant alone issues ~6 queries inside its transaction (server/src/services/session/session.service.ts:235-302: sessions SELECT, pods SELECT, pod_members SELECT, capacity COUNT, existing-registration SELECT, plus the INSERT/UPDATE), and updateParticipantStatus routes through the transitionParticipant chokepoint (additional reads+write). A query-level debug log for a plain LOBBY_OPEN join will show ~9-12 statements, so an implementer following the gate literally either fails acceptance or starts 'optimizing' registerParticipant — out of scope and pin-risky.

*Required action:* Restate the gate in the spec's own counting unit: 'in-lock awaited handler-level operations ≤ 5 (registerParticipant, status-update chokepoint, combined FIX-A query, optional transitionParticipant, optional recovery re-read)' and/or assert the ABSENCE of the moved work in-lock (no display-name SELECT, no getSessionById, no buildSessionStateSnapshot/fetchSockets, no getParticipantCount, no host-dashboard queries inside the guard). Keep the wall-clock smoke assertions as the real gate.

---

## JNS-2 — M4 — Bulk breakout: 20-wide parallel LiveKit room creation outside the session guard

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/breakout-bulk.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts (export createRoomWithRetry, lines 82-103)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/breakout-bulk.test.ts (extend)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/m4-bulk-parallel-create.test.ts (new)`

### Problem

handleHostCreateBreakoutBulk (breakout-bulk.ts:100, 218-455) wraps the whole flow in withSessionGuard and creates LiveKit rooms SEQUENTIALLY (one awaited createMatchRoom per room, no retry) before each per-room DB transaction. 20-25 rooms ≈ 8-15s with the session lock held, during which every join/leave/rating/timer callback on the session is frozen. round-lifecycle.ts:308-338 already contains the correct pattern (ROOM_BATCH_SIZE=20 Promise.all batches with createRoomWithRetry); the bulk handler never adopted it.

### Design

Split handleHostCreateBreakoutBulk into Phase A (unguarded) and Phase B (guarded):

PHASE A — runs BEFORE withSessionGuard, in this order:
1. `verifyHost` (moves out of the guard — it is read-only; the non-host pin test still passes because the error emit happens before any createMatchRoom call).
2. All existing input validation: rooms array shape, 1-3 per room, ≤25 rooms, cross-room duplicate check (108-131) — these must stay BEFORE any LiveKit call (pinned behavior in breakout-bulk.test.ts 'validation errors' describe).
3. activeSessions existence check + capture `const roundNumber = activeSession.currentRound` ONCE — used for BOTH the LiveKit room name and the INSERT round_number so the pair can never diverge if a round transition lands between phases.
4. The read-only UX validations: name lookup (141-145), in-use check (158-181), present-in-main check (188-204). These are advisory (DB trigger + partial unique index are the real invariant); running them pre-lock is the same staleness class as today's TOCTOU between check and tx.
5. Build specs: `const specs = rooms.map(r => ({ participantIds: r.participantIds, roomSlug: 'host-' + Date.now() + '-' + rand, roomId: videoService.matchRoomId(sessionId, roundNumber, roomSlug), created: false }))`. NOTE: generate each slug with a per-spec random suffix exactly as today (222) — Date.now() alone would collide inside one batch.
6. Export `createRoomWithRetry` from round-lifecycle.ts (change `async function` → `export async function`; the dr-arch FIX-3E pins match on substring so the added `export ` keyword is safe — verify with a grep before committing) and import it in breakout-bulk. Create rooms in batches: `const ROOM_BATCH_SIZE = 20;` then for each slice `await Promise.all(batch.map(async spec => { spec.created = await createRoomWithRetry(sessionId, roundNumber, spec.roomSlug); }))`. This adopts the 1-retry behavior the algorithm path already has.
7. Partial failure (mirrors the round-start cancel pattern — here no match rows exist yet, so a 'cancelled spec' is simply never inserted): `const failed = specs.filter(s => !s.created)`. If failed.length > 0, emit ONE aggregated `socket.emit('error', { code: 'ROOM_CREATION_FAILED', message: `${failed.length} of ${specs.length} rooms could not be created — the rest were opened.` })`. If ALL failed, emit and return without ever taking the guard. No bye events are needed (participants were never notified about the failed rooms).

PHASE B — `return withSessionGuard(data.sessionId, async () => { ... })` containing:
8. Re-fetch `const live = activeSessions.get(sessionId)`; if missing or `live.status === SessionStatus.COMPLETED`, emit INVALID_STATE and return (session ended during Phase A; the already-created LiveKit rooms are orphaned-but-harmless per the existing Phase-4A comment — LiveKit GCs empty rooms).
9. The existing per-room loop (218-455) over `specs.filter(s => s.created)` UNCHANGED except: the `createMatchRoom` call + slug generation are deleted (done in Phase A), `newRoomId` comes from spec.roomId, and validateMatchAssignment stays where it is (structural, 1 cheap query per room). Everything else — the transaction with reassign+INSERT (timer_visibility + is_manual TRUE text preserved for pins), clearCanonicalBreakoutByMatch, clearRoomTimers for reassigned matches, setRoomAssignment, status updates, match:reassigned emit (timerVisibility within 800 chars — pinned), the per-room timer arm block, PARTICIPANT_ALREADY_MATCHED on 23505 — stays byte-identical.
10. Tail: _emitHostDashboard, ensureManualDashboardInterval, host action receipt (457-477) — unchanged, inside the guard.

Guard-hold time becomes DB-only: ~25 fast transactions ≈ 0.5-1.5s instead of 8-15s.

### Code sketch

````
// round-lifecycle.ts:82 — one-word change
export async function createRoomWithRetry(sessionId, roundNumber, matchIdShort): Promise<boolean> { ...unchanged... }

// breakout-bulk.ts
export async function handleHostCreateBreakoutBulk(io, socket, data) {
  // ── PHASE A (NO session guard): validate + create LiveKit rooms 20-wide ──
  if (!await verifyHost(socket, data.sessionId)) return;
  ...input validation (unchanged text)...
  const activeSession = activeSessions.get(sessionId);
  if (!activeSession) { socket.emit('error', { code: 'INVALID_STATE', ... }); return; }
  const roundNumber = activeSession.currentRound;   // captured once, used for roomId AND INSERT
  ...nameRes / inUseRes / presentForBulk checks (unchanged)...
  const specs = rooms.map(r => { const roomSlug = `host-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    return { participantIds: r.participantIds, roomSlug,
             roomId: videoService.matchRoomId(sessionId, roundNumber, roomSlug), created: false }; });
  const ROOM_BATCH_SIZE = 20; // mirrors round-lifecycle.ts:310
  for (let i = 0; i < specs.length; i += ROOM_BATCH_SIZE) {
    await Promise.all(specs.slice(i, i + ROOM_BATCH_SIZE).map(async (spec) => {
      spec.created = await createRoomWithRetry(sessionId, roundNumber, spec.roomSlug);
    }));
  }
  const failedCount = specs.filter(s => !s.created).length;
  if (failedCount > 0) socket.emit('error', { code: 'ROOM_CREATION_FAILED',
    message: `${failedCount} of ${specs.length} rooms could not be created${failedCount === specs.length ? '.' : ' — the rest were opened.'}` });
  if (failedCount === specs.length) return;

  // ── PHASE B (guarded): DB mutations + canonical writes + emits + timers ──
  return withSessionGuard(data.sessionId, async () => {
    const live = activeSessions.get(sessionId);
    if (!live || live.status === SessionStatus.COMPLETED) { socket.emit('error', { code: 'INVALID_STATE', ... }); return; }
    const createdMatchIds: string[] = [];
    for (const spec of specs) {
      if (!spec.created) continue;   // cancelled spec — never inserted, mirrors round-start cancel
      const newRoomId = spec.roomId;
      ...existing per-room body 234-454 verbatim (validate → transaction → canonical clear →
         setRoomAssignment → statuses → match:reassigned → timer arm)...
    }
    ...dashboard + ensureManualDashboardInterval + receipt (unchanged)...
  });
}
````

### Tests to add

- EXTEND breakout-bulk.test.ts: source pin — `createRoomWithRetry` is imported from round-lifecycle and called inside a `Promise.all` within handleHostCreateBreakoutBulk; `ROOM_BATCH_SIZE` constant present; `withSessionGuard(` index in the fn slice is GREATER than the `Promise.all` index (LiveKit creation precedes the guard).
- NEW m4-bulk-parallel-create.test.ts (functional, mocked videoService/db): (1) 5 rooms where createMatchRoom rejects twice for room #3 (both attempts) → exactly 4 transactions run, one aggregated ROOM_CREATION_FAILED error emitted, 4 match:reassigned fan-outs; (2) all rooms fail → no transaction call, single error, withSessionGuard never blocks (assert via sessionLocks map empty); (3) session removed from activeSessions between Phase A and Phase B (simulate by deleting in the createMatchRoom mock) → INVALID_STATE, no INSERT.
- All existing breakout-bulk.test.ts cases pass unchanged (non-host rejects still emit before any createMatchRoom; validation-order cases unchanged; INSERT pins unchanged).
- Headed Playwright prod smoke: 21+ participants, host bulk-creates 10 rooms with a 3-min shared timer; assert (a) all 10 rooms open and every participant lands in the right room < 8s, (b) a NEW participant joining DURING the bulk create reaches the lobby in < 3s (the guard is no longer held through LiveKit), (c) host dashboard shows 10 manual rooms.

### Acceptance criteria

- Session guard hold time for a 25-room bulk create ≤ 2s (log guard acquire/release timestamps in dev and assert in the functional test via fake timers that no LiveKit call happens while the lock is held).
- Partial failure: rooms that fail LiveKit creation (after 1 retry) are skipped with one aggregated host-facing error; the remaining rooms are fully created (DB rows + emits + timers).
- Joins/leaves/ratings proceed during the LiveKit-creation phase (headed smoke point b).
- Existing breakout-bulk pins green without edits.

### Risks

1) Validation staleness between Phase A and Phase B widens slightly (it already existed between check and tx): a participant who enters another room during Phase A is caught by the in-tx reassign / unique-trigger and surfaces as the existing PARTICIPANT_ALREADY_MATCHED error for that room only. 2) Orphaned LiveKit rooms when Phase B aborts — explicitly accepted (existing comment: empty rooms are GC'd; the orphan-lobby reaper is a second net). 3) roundNumber captured pre-guard: if a round transition lands between phases, manual rooms are tagged with the previous round number — informational only (manual matches are excluded from algorithm logic via is_manual), consistent room name/row pair guaranteed by single capture. 4) createRoomWithRetry adds a 2s in-batch retry delay — worst case Phase A = 2 batches × (call + 2s retry) ≈ 5-6s, but unguarded so harmless.

### Deploy notes

Server-only, no migration, no env. Ship after JNS-1 or independently (no code overlap). Note for JNS-3: this item deliberately does NOT touch the per-room timer block, so JNS-3 can land on top without conflicts. Full local suite before push; headed prod smoke after deploy.

### ⚠ Adversarial review — REQUIRED amendments

**[IMPORTANT]** The aggregated partial-failure message never reaches the host, contradicting 'no client change' and the acceptance criterion. The client maps ROOM_CREATION_FAILED to FIXED copy 'Could not create breakout room. Try again.' and discards data.message (client/src/hooks/useSessionSocket.ts:1114, entry lookup at 1124). So the spec's carefully-worded `"${failed.length} of ${specs.length} rooms could not be created — the rest were opened."` is silently replaced by total-failure copy plus 'Try again' — on a 9-of-10 success the host will likely re-press the action and duplicate the nine successful rooms (made easier to hit by the Phase-A race above). Acceptance bullet 2 ('one aggregated host-facing error') reads as satisfied server-side but is not what the host sees.

*Required action:* Either (a) emit a NEW code (e.g. ROOM_CREATION_PARTIAL) — unknown codes fall through to the raw server message per useSessionSocket.ts:1124 and the pin at phase-4-and-5-atomic-and-errors.test.ts:140-143, so the server text shows with zero client edits — or (b) explicitly include a one-line client FRIENDLY-map change in the work item and drop the 'no client change' deploy note. Update the headed smoke to assert the visible toast text on partial failure.

**[IMPORTANT]** Bug-7 'no silent yanking' contract is re-opened, and the spec misstates the failure mode. Today the in-use check (breakout-bulk.ts:158-181) and the per-room transaction run under the SAME withSessionGuard as every conflicting writer (transitionToRound via guarded timerCallbacks, other manual creates, joins), so there is no TOCTOU window against guarded writers — the spec's claim 'same staleness class as today's TOCTOU between check and tx' is false. After moving validation to unguarded Phase A, a round start or a second bulk-create that lands during Phase A's LiveKit window (up to ~5-6s with retries) passes Phase A, then Phase B's transaction loop (breakout-bulk.ts:256-281) SILENTLY sets the participant's existing active match to 'reassigned' and inserts the new room — no error is thrown. The spec's risk #1 claims this 'surfaces as the existing PARTICIPANT_ALREADY_MATCHED error' — wrong: the reassign loop clears the conflict before the INSERT, so the unique trigger never fires. That silent yank is exactly what Bug 7 removed (dr-arch-april-19-bugs.test.ts:50-71 pins the reject-before-transaction contract; the breakout-bulk.ts:147-156 comment documents 'the host had no idea they were yanking people out of a live conversation'). The source pins still pass (text order preserved), so the regression ships green.

*Required action:* Inside Phase B (under the guard), re-run the cheap conflict SELECT (one query over all participantIds, same SQL as breakout-bulk.ts:158-165) before the per-room loop; emit PARTICIPANT_IN_ACTIVE_ROOM and skip (or abort) conflicted rooms instead of letting the in-tx reassign fire. Alternatively make the Phase-B per-room transaction fail (skip the reassign loop) when a conflicting active match exists. Add a functional test: session enters ROUND_ACTIVE between Phase A and Phase B → zero reassignments of algorithm matches.

**[NIT]** Fabricated test citation: step 6 says 'the dr-arch FIX-3E pins match on substring so the added `export ` keyword is safe — verify with a grep before committing.' No test under server/src/__tests__ references createRoomWithRetry, 'FIX 3E', or ROOM_BATCH_SIZE at all (grep returns zero matches; dr-arch-april-19-bugs.test.ts pins Bug 6/7/8/8.5/9 only). The export change IS safe, but an implementer hunting for the cited pin will waste time and lose trust in the otherwise-accurate pin inventory.

*Required action:* Drop the FIX-3E-pin claim and state plainly: 'no existing test references createRoomWithRetry; exporting it is pin-free (verified by grep).'

---

## JNS-3 — M5 — Persist + recover manual-room timers, rating backstop, no-show timer, and dashboard intervals across deploys

**Priority:** P1
**Depends on:** JNS-2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/db/migrations/068_matches_timer_ends_at.sql (new)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/host-actions.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/breakout-bulk.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/round-lifecycle.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/m5-timer-recovery.test.ts (new)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/breakout-bulk.test.ts (one pin update)`

### Problem

Manual breakout-room timers live only in the in-memory roomTimers/roomSyncIntervals maps (host-actions.ts:2616-2633); a mid-event deploy leaves ghost rooms whose occupants are never sent to rating and kills the manual dashboard interval. The 90s rating backstop is armed AFTER persistSessionState runs in endRound (round-lifecycle.ts:563 vs 736-742), so the Redis/DB blob never carries the backstop's timerEndsAt and recovery re-arms nothing — a restart during ROUND_RATING wedges the session. detectNoShows is an untracked raw setTimeout (round-lifecycle.ts:486-488), lost on restart and never cleared on round end. The ROUND_ACTIVE 5s dashboard interval (492-499) is also lost.

### Design

FOUR sub-changes, one deploy.

A. MIGRATION 068 (068_matches_timer_ends_at.sql): mirrors how the round timer persists (sessions.active_state.timerEndsAt / Redis blob — session-state.ts:163-187) but at match granularity, which is the natural home because matches already carry started_at and timer_visibility (migration 039):
```sql
-- Migration 068 — M5: persist the manual breakout room timer expiry so a deploy
-- mid-event can re-arm room timers on boot (recoverManualRoomTimers).
ALTER TABLE matches ADD COLUMN IF NOT EXISTS timer_ends_at TIMESTAMPTZ NULL;
COMMENT ON COLUMN matches.timer_ends_at IS 'Manual room timer expiry; NULL = unlimited. Read on boot for status=active AND is_manual=TRUE.';
```
No BEGIN/COMMIT (the runner wraps each file — migrate.ts:50-58), idempotent, nullable-no-default so the ALTER is metadata-only.

B. SHARED ARM HELPER + PERSISTENCE (host-actions.ts). Extract the three near-identical timer blocks (host-actions single-create 2911-3006, breakout-bulk create 350-454, plus the future recovery path) into ONE exported helper next to roomTimers:
`export function armManualRoomTimer(io: SocketServer, sessionId: string, matchId: string, participantIds: string[], opts: { endsAt: Date; startedAt: Date; timerVisibility: 'visible' | 'hidden' }): void`
Body = the existing bulk-create block semantics: clearRoomTimers(matchId) first; 5s roomSyncIntervals interval emitting `io.to(userRoom(pid)).emit('timer:sync', { segmentType: 'breakout', secondsRemaining, endsAt: endsAtIso })` ONLY when timerVisibility==='visible' (keep `{ segmentType: 'breakout', secondsRemaining` ordering — may25-live-fixes.test.ts pins that no userRoom timer:sync starts with `{ secondsRemaining`); shared fireCallback (status!='active' bail → UPDATE matches SET status='completed' WHERE status='active' → clearCanonicalBreakoutByMatch → names → updateParticipantStatus IN_LOBBY → emitRatingWindowOnce(durationSeconds:20, earlyLeave:true) → _emitHostDashboard); setTimeout(max(0, endsAt-now)); roomTimers.set; initial visible timer:sync with endsAt. Note: this intentionally adds endsAt to the single-create 5s syncs (today only bulk includes it — Bug 15 parity) and makes single-create visibility-aware (single-create has no hidden option today, so behavior is identical).
Call sites: handleHostCreateBreakout Step 5 and handleHostCreateBreakoutBulk per-room timer block both become `armManualRoomTimer(io, sessionId, matchId, [...participantIds], { endsAt, startedAt, timerVisibility })`.
PERSIST endsAt atomically with creation: add `timer_ends_at` to BOTH INSERT statements (host-actions:2818-2822 and breakout-bulk:276-280), computing `endsAt` pre-transaction when duration > 0, else NULL. (The INSERT pins only require timer_visibility / is_manual presence — adding a column is pin-safe.)
EXTEND/SET-DURATION persistence: after rescheduling in handleHostExtendBreakoutRoom (1973-1979), handleHostExtendBreakoutAll (512-517), handleHostSetBreakoutDurationAll (653-663), add `await query("UPDATE matches SET timer_ends_at = $2 WHERE id = $1 AND status = 'active'", [matchId, newEndsAt]).catch(non-fatal log)`.

C. RECOVERY (host-actions.ts + round-lifecycle.ts):
`export async function recoverManualRoomTimers(io: SocketServer, sessionId: string): Promise<void>` in host-actions.ts: `SELECT id, participant_a_id, participant_b_id, participant_c_id, timer_ends_at, started_at, timer_visibility FROM matches WHERE session_id = $1 AND status = 'active' AND is_manual = TRUE`. For each row with timer_ends_at: `armManualRoomTimer(io, sessionId, id, slots, { endsAt: new Date(Math.max(Date.parse(timer_ends_at), Date.now() + 2000)), startedAt, timerVisibility })` — the +2s clamp lets an already-expired room end promptly post-boot instead of mid-recovery (fireCallback re-checks status='active', so double-fires are no-ops). If ANY rows returned (timered or not), call `ensureManualDashboardInterval(io, sessionId)`.
In recoverActiveSessions (round-lifecycle.ts:109-222), after activeSessions.set + warmParticipantStatesOnRestore in BOTH the Redis branch and the DB-fallback branch, add a call to a new private `rearmRecoveredTimers(io, sessionId, activeSession)` declared BELOW recoverActiveSessions in the same file (declaring it above would shrink the fn-slice some pin tests take from 'export async function recoverActiveSessions'; keep warmParticipantStatesOnRestore calls inline in both branches as today). rearmRecoveredTimers does: (1) the existing timerEndsAt re-arm via startSegmentTimer EXCEPT when status === ROUND_RATING — then use a raw `activeSession.timer = setTimeout(() => _timerCallbacks!.endRatingWindow(sessionId, activeSession.currentRound), remainingMs)` mirroring endRound's backstop shape (startSegmentTimer would broadcast timer:sync during rating, violating the no-rating-countdown contract pinned in may25-live-fixes); if status === ROUND_RATING and timerEndsAt is missing/expired, arm a 10s self-heal backstop instead of nothing (closes the wedged-in-ROUND_RATING hole); (2) if status === ROUND_ACTIVE: re-arm the no-show timer (see D) with remaining = (MIN(started_at of this round's active matches) + config.noShowTimeoutSeconds*1000) - now, clamped ≥ 2000ms, and re-create the 5s host-dashboard interval by calling a small extracted `startRoundDashboardInterval(io, sessionId)` (the existing 492-499 block, also called from transitionToRound); (3) `await (await import('./host-actions')).recoverManualRoomTimers(io, sessionId)` (dynamic import — the established pattern for this cycle, see completeSession:905).

D. TRACKED NO-SHOW TIMER (round-lifecycle.ts): module-level `const noShowTimers = new Map<string, NodeJS.Timeout>();` with `export function armNoShowTimer(io, sessionId, roundNumber, delayMs)` (clears existing; `setTimeout(() => { noShowTimers.delete(sessionId); void withSessionGuard(sessionId, () => detectNoShows(io, sessionId, roundNumber)); }, delayMs)`, unref'd) and `export function clearNoShowTimer(sessionId)`. transitionToRound:486-488 replaces the raw setTimeout with armNoShowTimer(io, sessionId, roundNumber, config.noShowTimeoutSeconds * 1000). endRound (right after the FSM guard) and completeSession (next to clearSessionTimers) call clearNoShowTimer(sessionId). The withSessionGuard wrap matches the timerCallbacks pattern (orchestration.service.ts:128-133) and is safe: detectNoShows never acquires the guard (its callees endRound/maybeAutoEndEmptyRound don't either). detectNoShows' own `status !== ROUND_ACTIVE` bail (pinned, tier1-a3) stays.
E. BACKSTOP PERSIST ORDER (round-lifecycle.ts endRound): immediately after the backstop arm (after line 742), add `persistSessionState(sessionId, activeSession).catch(() => {});` so the Redis/DB blob carries timerEndsAt = now+90s while in ROUND_RATING. Do NOT remove the existing line-563 persist (it commits the status flip early).

POST-CHANGE TIMER INVENTORY (the contract this item must document in code comments): RECOVERED after deploy — session segment timer + sync interval (all statuses, existing), ROUND_RATING 90s backstop (new: E + C1), CLOSING_LOBBY 600s safety (existing via startSegmentTimer), detectNoShows (new: D + C2), ROUND_ACTIVE 5s dashboard interval (new: C2), manual-room timers + sync intervals (new: A/B/C), manualDashboardIntervals (new: C), heartbeat stale-detection + global reconciler + LiveKit sweep + TTL/orphan reapers (existing, re-armed unconditionally on boot). DELIBERATELY NOT RECOVERED — 15s disconnect/match-end grace timers (disconnectTimeouts; the 30s reconciler and maybeAutoEndEmptyRound self-heal, and recovering them would end rooms for users who are themselves reconnecting post-deploy), 5s future-repair trailing timer (next roster change re-triggers), 300ms participant-broadcast debounce (harmless), host-actions solo-partner 5s return timeout (2857; window too short to matter).

### Code sketch

````
// host-actions.ts — single canonical arm + recovery
export function armManualRoomTimer(io, sessionId, matchId, participantIds, opts): void {
  clearRoomTimers(matchId);
  const { endsAt, startedAt, timerVisibility } = opts;
  roomSyncIntervals.set(matchId, setInterval(() => {
    const state = roomTimers.get(matchId);
    if (!state) { /* self-clear */ return; }
    const remaining = Math.max(0, Math.ceil((state.endsAt.getTime() - Date.now()) / 1000));
    if (timerVisibility === 'visible') for (const pid of state.participantIds)
      io.to(userRoom(pid)).emit('timer:sync', { segmentType: 'breakout', secondsRemaining: remaining, endsAt: state.endsAt.toISOString() });
    if (remaining <= 0) { /* self-clear interval */ }
  }, 5000));
  const fireCallback = async () => { /* existing expiry body: status check → complete →
     clearCanonicalBreakoutByMatch → IN_LOBBY → emitRatingWindowOnce → dashboard */ };
  roomTimers.set(matchId, { timeoutHandle: setTimeout(() => { fireCallback(); }, Math.max(0, endsAt.getTime() - Date.now())),
                            endsAt, startedAt, participantIds: [...participantIds], fireCallback });
  if (timerVisibility === 'visible') /* initial sync incl. endsAt */;
}

export async function recoverManualRoomTimers(io, sessionId): Promise<void> {
  const rows = await query(`SELECT id, participant_a_id, participant_b_id, participant_c_id,
          timer_ends_at, started_at, timer_visibility
     FROM matches WHERE session_id = $1 AND status = 'active' AND is_manual = TRUE`, [sessionId]);
  for (const r of rows.rows) {
    if (!r.timer_ends_at) continue;  // unlimited room — dashboard interval still wanted below
    const endsAt = new Date(Math.max(new Date(r.timer_ends_at).getTime(), Date.now() + 2000));
    armManualRoomTimer(io, sessionId, r.id, [r.participant_a_id, r.participant_b_id, r.participant_c_id].filter(Boolean),
      { endsAt, startedAt: new Date(r.started_at), timerVisibility: r.timer_visibility === 'hidden' ? 'hidden' : 'visible' });
  }
  if (rows.rows.length > 0) ensureManualDashboardInterval(io, sessionId);
}

// round-lifecycle.ts
const noShowTimers = new Map<string, NodeJS.Timeout>();
export function armNoShowTimer(io, sessionId, roundNumber, delayMs) {
  clearNoShowTimer(sessionId);
  const t = setTimeout(() => { noShowTimers.delete(sessionId);
    void withSessionGuard(sessionId, () => detectNoShows(io, sessionId, roundNumber)); }, delayMs);
  if (typeof t.unref === 'function') t.unref();
  noShowTimers.set(sessionId, t);
}
export function clearNoShowTimer(sessionId) { const t = noShowTimers.get(sessionId); if (t) clearTimeout(t); noShowTimers.delete(sessionId); }

// endRound — after arming the 90s backstop (line ~742):
persistSessionState(sessionId, activeSession).catch(() => {});

// rearmRecoveredTimers (called from both recovery branches):
if (status === ROUND_RATING) {
  const remaining = timerEndsAt && timerEndsAt > now ? timerEndsAt - now : 10_000; // self-heal floor
  activeSession.timerEndsAt = new Date(Date.now() + remaining);
  activeSession.timer = setTimeout(() => { _timerCallbacks!.endRatingWindow(sessionId, activeSession.currentRound); }, remaining);
} else if (timerEndsAt in future && !isPaused) { startSegmentTimer(...getTimerCallbackForState...); }
if (status === ROUND_ACTIVE) {
  const ms = await remainingNoShowMs(sessionId, currentRound, config.noShowTimeoutSeconds); // MIN(started_at)+timeout-now, ≥2s
  if (ms !== null) armNoShowTimer(io, sessionId, currentRound, ms);
  startRoundDashboardInterval(io, sessionId);
}
await (await import('./host-actions')).recoverManualRoomTimers(io, sessionId);
````

### Tests to add

- NEW m5-timer-recovery.test.ts — migration pins: 068 file exists, matches /ADD COLUMN IF NOT EXISTS timer_ends_at TIMESTAMPTZ/, contains NO /\bBEGIN\b|\bCOMMIT\b/.
- Source pins: host-actions exports armManualRoomTimer + recoverManualRoomTimers; both INSERT INTO matches statements (host-actions + breakout-bulk) include timer_ends_at; all three extend/set-duration handlers contain /UPDATE matches SET timer_ends_at/; endRound fn-slice has persistSessionState AFTER the RATING_BACKSTOP_MS arm (index comparison); transitionToRound uses armNoShowTimer (and no longer contains the raw `setTimeout(() => {\n detectNoShows`); endRound + completeSession call clearNoShowTimer; recoverActiveSessions path reaches recoverManualRoomTimers; the ROUND_RATING recovery branch does NOT use startSegmentTimer (raw setTimeout pin, mirroring may25-live-fixes B).
- Functional (jest fake timers, mocked query/io): armManualRoomTimer fires after endsAt → asserts UPDATE…completed + emitRatingWindowOnce per participant + sync interval cleared; recoverManualRoomTimers with an expired timer_ends_at arms ≥2s (does not fire synchronously); 'hidden' visibility emits no timer:sync.
- Functional: endRound with mocked persistSessionState — assert it is called a second time after timerEndsAt is set to now+90s (capture the argument's timerEndsAt).
- Existing suites must stay green: may25-live-fixes.test.ts (timer:sync tagging + backstop shape), tier1-a3-timeout-guards, dr-arch-april-19 (extend pins), pause-timer-sync, s14 detectNoShows pins, ws3-timer-warning.
- Headed Playwright prod smoke (per-bug deploy reality): start a real event, host creates 2 manual rooms with a 4-min timer, trigger a Render deploy (the fix's own deploy) mid-timer; assert after the new instance is live that (a) occupants still see the countdown ticking (timer:sync resumes), (b) at expiry both rooms end and the rating window opens, (c) the host dashboard keeps refreshing. Second pass: deploy during ROUND_RATING and assert the session advances to ROUND_TRANSITION within ≤100s (recovered backstop).

### Acceptance criteria

- A server restart during an active manual room with a timer re-arms the timer with the correct remaining time (±2s) and the room ends into the rating flow; an already-expired timer ends the room within ~5s of boot.
- A restart during ROUND_RATING ends the rating window within the remaining backstop time (or 10s if the persisted timer was lost) — the session can no longer wedge in ROUND_RATING after a deploy.
- A restart during ROUND_ACTIVE within the no-show window re-arms detectNoShows; ending a round clears the no-show timer (no stray fetchSockets work next round).
- Host dashboard auto-refresh resumes after a restart in both ROUND_ACTIVE and manual-room LOBBY_OPEN states.
- Migration 068 applies idempotently on a database where it already ran (re-run yields no error).

### Pinned tests to update

- server/src/__tests__/services/orchestration/breakout-bulk.test.ts — 'reuses clearRoomTimers + roomTimers map (Change 4.5 ghost-timer fix)': the regex /roomTimers,\s*roomSyncIntervals/ pins the breakout-bulk import list; after delegating the create-path timer block to armManualRoomTimer, roomSyncIntervals (and the RoomTimerState type) become unused in breakout-bulk.ts and MUST be dropped from the import (tsconfig has noUnusedLocals:true). Update the pin to expect /roomTimers/ AND /armManualRoomTimer/ AND keep /clearRoomTimers/. roomTimers itself stays imported (extend-all/set-duration-all/add_to_room still read it).

### Risks

1) Render zero-downtime overlap (M7, other cluster): during the ~30s two-instance window, BOTH instances can hold a manual-room timer and both fireCallbacks can run — safe-by-construction here because the expiry body is guarded by `WHERE status='active'` + emitRatingWindowOnce dedup, but this widens the M7 surface; coordinate with the deploy-fencing item. 2) ALTER TABLE matches takes a brief ACCESS EXCLUSIVE lock — nullable-no-default so it is metadata-only, but the runner has no lock_timeout yet (M8 cluster); deploy outside a live round to be safe. 3) Rooms created by the OLD instance during the overlap won't have timer_ends_at written (old code) — their timers die with the old instance; one-deploy transition cost, accepted. 4) The armManualRoomTimer extraction touches three pinned files — the pin checklist above is exhaustive per current tests, but the implementer must run the FULL suite locally (standing rule) before push. 5) Guard-wrapping detectNoShows changes its concurrency (now serialized with joins) — it runs once per round and its callees never re-acquire the guard, so no deadlock; verified against session-state.ts (non-reentrant guard).

### Deploy notes

Includes migration 068 (auto-runs on boot; written WITHOUT inner BEGIN/COMMIT and idempotent per the hardening rules). Server-only; no env, no render.yaml, no client change. Ship AFTER JNS-2 to avoid breakout-bulk.ts merge conflicts in the create path. Deploy at a quiet moment (brief matches-table lock). Full local suite + both headed smoke passes before declaring done.

### ⚠ Adversarial review — REQUIRED amendments

**[IMPORTANT]** The POST-CHANGE TIMER INVENTORY (which the item requires documenting in code as the contract) wrongly lists 'CLOSING_LOBBY 600s safety (existing via startSegmentTimer)' as RECOVERED after a deploy. In endRatingWindow, persistSessionState runs at round-lifecycle.ts:839 BEFORE startSegmentTimer(io, sessionId, 600, …) at :853 sets the new timerEndsAt, and the 90s-backstop entry path even nulls timerEndsAt before calling endRatingWindow (round-lifecycle.ts:738-740). No later persist exists for CLOSING_LOBBY. So the persisted blob carries a null (or stale) timerEndsAt and recovery re-arms nothing: a deploy during CLOSING_LOBBY leaves the session wedged with no auto-completeSession — the exact wedge class M5 sets out to close for ROUND_RATING (sub-change E) survives one state later, and the in-code contract comment would assert otherwise.

*Required action:* Mirror sub-change E in endRatingWindow's CLOSING_LOBBY branch: add `persistSessionState(sessionId, activeSession).catch(() => {});` immediately AFTER the startSegmentTimer(…, 600, …) arm at :853-855 (startSegmentTimer sets timerEndsAt synchronously), and/or give rearmRecoveredTimers a CLOSING_LOBBY fallback (timerEndsAt missing/expired → arm a fresh completeSession safety timer). Add the corresponding source pin and a third headed-smoke pass (deploy during CLOSING_LOBBY → event auto-completes).

**[NIT]** Two prose inaccuracies that could encode wrong code/pins: (1) the armManualRoomTimer call-site for handleHostCreateBreakout — there is no `timerVisibility` variable in the single-create path (host-actions.ts:2911-3006; its INSERT at 2818-2822 doesn't even write timer_visibility, rows rely on the migration-039 'visible' default), so the stated uniform call `armManualRoomTimer(io, sessionId, matchId, […], { endsAt, startedAt, timerVisibility })` needs a hardcoded 'visible' there; (2) 'mirroring endRound's backstop shape' for the ROUND_RATING recovery re-arm is inexact — endRound's backstop calls the module-local endRatingWindow DIRECTLY/unguarded (round-lifecycle.ts:741), while the codeSketch (correctly, and more safely) uses the guard-wrapped `_timerCallbacks!.endRatingWindow` (orchestration.service.ts:131). If the new m5 source pin is written to match 'endRound's shape' literally, it pins the wrong call.

*Required action:* State explicitly: single-create passes timerVisibility:'visible'; and word the m5 pin as 'raw setTimeout invoking _timerCallbacks.endRatingWindow (NOT startSegmentTimer)' rather than 'mirrors endRound'.

---

## JNS-4 — Mute-all: cap LiveKit enforcement concurrency at 15 with batched Promise.allSettled

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/handlers/host-actions.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/m-mute-all-batching.test.ts (new)`

### Problem

handleHostMuteAll (host-actions.ts:1331-1412) fires enforceLiveKitMute for every present participant with UNBOUNDED concurrency: the mute path fire-and-forgets all N at once (1387-1389), the unmute path launches all N void-chains at once (1397-1405). Each enforceLiveKitMute (1289-1327) issues 2 DB queries + up to 2 LiveKit Cloud calls, so mute-all at 50 participants bursts ~100 concurrent queries against the 25-connection pool plus ~100 LiveKit API calls — pool starvation exactly when the host is trying to take control of a noisy room.

### Design

Keep the S17-pinned per-user ordering and the loop shape, add bounded batching.

In handleHostMuteAll, replace the direct launches inside the existing `for (const participantId of mutePresent)` loop with task collection, then drain in batches of 15:
- MUTE path (data.muted): the `io.to(userRoom(participantId)).emit('lobby:mute_command', { muted: true, byHost: true })` relay stays SYNCHRONOUS inside the loop (every participant mutes locally instantly — S17 contract), and the `enforceLiveKitMute(data.sessionId, participantId, false).catch(...)` call is pushed as a deferred task instead of being invoked immediately. The relay-before-revoke text order inside the `if (data.muted) {` branch is pinned (s17-instant-mute-ordering.test.ts 'MUTE-all relays first, revoke follows') — preserve it.
- UNMUTE path: push the whole existing chain as a deferred task, keeping the exact pinned shape `enforceLiveKitMute(data.sessionId, participantId, true).catch(...).then(() => { io.to(userRoom(participantId)).emit('lobby:mute_command', { muted: false, byHost: true }); })` — the pin requires `.then(() => {` with the emit within 200 chars after enforceLiveKitMute(...true); the `.catch` between them is within the regex's 400-char window (verify by running the test). Each user's relay still waits only for their OWN restore.
- Drain: `const MUTE_ENFORCE_CONCURRENCY = 15;` then `for (let i = 0; i < tasks.length; i += MUTE_ENFORCE_CONCURRENCY) { await Promise.allSettled(tasks.slice(i, i + MUTE_ENFORCE_CONCURRENCY).map(t => t())); }`. Per-task .catch already swallows; allSettled is belt-and-braces so one rejection never aborts a batch.
- The handler stays un-guarded (registered via raw socket.on at orchestration.service.ts:338-341) and the Phase-O bulk DB persist (1350-1368) stays exactly where it is, BEFORE the loop.
Why 15: each task holds ≤2 pool connections transiently → ≤30 outstanding statements with pool=25 queueing slightly but never starving heartbeats/joins; LiveKit Cloud comfortably absorbs 15 concurrent RoomService calls (round-lifecycle already does 20-wide room creates).

### Code sketch

````
const tasks: Array<() => Promise<unknown>> = [];
for (const participantId of mutePresent) {
  if (allHostIds.includes(participantId)) continue;
  if (data.muted) {
    // S17 — MUTE: relay first (instant local mute), SFU revoke follows (batched below).
    io.to(userRoom(participantId)).emit('lobby:mute_command', { muted: true, byHost: true });
    tasks.push(() => enforceLiveKitMute(data.sessionId, participantId, false).catch(err =>
      logger.warn({ err, participantId }, 'Phase U bulk mute enforcement failed (non-fatal)')));
  } else {
    // S17 — UNMUTE: each user's relay waits only for their OWN permission restore.
    tasks.push(() => enforceLiveKitMute(data.sessionId, participantId, true)
      .catch(err => logger.warn({ err, participantId }, 'Phase U bulk mute enforcement failed (non-fatal)'))
      .then(() => {
        io.to(userRoom(participantId)).emit('lobby:mute_command', { muted: false, byHost: true });
      }));
  }
  count++;
}
// M-batch — bounded concurrency so 50 enforcements can't starve the 25-conn pool.
const MUTE_ENFORCE_CONCURRENCY = 15;
for (let i = 0; i < tasks.length; i += MUTE_ENFORCE_CONCURRENCY) {
  await Promise.allSettled(tasks.slice(i, i + MUTE_ENFORCE_CONCURRENCY).map(t => t()));
}
````

### Tests to add

- NEW m-mute-all-batching.test.ts (functional, mocked query/videoService/io): with 40 present participants and an enforceLiveKitMute mock that tracks in-flight concurrency via an incremented/decremented counter behind a deferred promise, assert max in-flight ≤ 15 for both mute and unmute; assert all 40 relays were emitted; mute path: every relay emit happens BEFORE the first enforcement resolves (instant-mute preserved); unmute path: a participant whose enforcement rejects still receives the unmute relay (catch→then chain).
- Source pin in the same file: /MUTE_ENFORCE_CONCURRENCY\s*=\s*15/ and /Promise\.allSettled/ inside the handleHostMuteAll fn slice.
- Existing s17-instant-mute-ordering.test.ts and phase-o-authoritative-mute-state.test.ts must pass UNCHANGED — run them explicitly before push; if the S17 unmute regex's 400-char window trips on the new spacing, tighten the code spacing, not the test.
- Headed Playwright prod smoke: 20+ browsers publishing mics; host presses Mute All → every remote tile shows muted within 3s and /checkhole DB health stays green during the burst; host presses Unmute All → all mics restorable (no PublishTrackError in console) within 5s.

### Acceptance criteria

- Max concurrent enforceLiveKitMute executions ≤ 15 (asserted by unit test).
- Mute-all at 40 mocked participants: all lobby:mute_command relays emitted synchronously before enforcement completes (mute) / strictly after the user's own restore (unmute).
- s17 + phase-o pins green without edits.
- Prod smoke: 20-browser mute-all visually complete < 3s, no DB pool alarms.

### Risks

1) Unmute-all tail latency becomes bounded-sequential: 50 users / 15-wide ≈ 4 batches × ~300-500ms ≈ ~2s for the last user's relay (today: all at once but pool-thrashed). Acceptable; note in the host-facing behavior that unmute ripples over ~2s. 2) The handler now awaits enforcement (today it returns immediately after launching) — the socket handler runs longer but is unguarded, so nothing else queues behind it. 3) S17 regex sensitivity: the unmute chain refactor must keep .catch+.then within the pinned character windows — run the pin test locally before pushing.

### Deploy notes

Server-only, no migration, no env, no client change. Independent — ship in any order. Full local suite + headed smoke per standing process.

---

## JNS-5 — Per-socket token-bucket rate limiting for chat / reaction / presence socket events

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/state/socket-rate-limit.ts (new)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/services/orchestration/orchestration.service.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/orchestration/socket-rate-limit.test.ts (new)`

### Problem

No socket event has any rate limiting (audit medium): one misbehaving or malicious client can loop chat:send (3 queries + fetchSockets + N-recipient fanout each), chat:react, or reaction:send and saturate the DB pool and the room's sockets. express-rate-limit (v7, in package.json) only covers HTTP — Socket.IO 4.7 has no built-in per-event limiter, so a tiny in-process token bucket is the right tool (single Render instance; no Redis needed).

### Design

NEW module server/src/services/orchestration/state/socket-rate-limit.ts (pure, no deps — keeps it unit-testable and keeps orchestration.service.ts thin):
- Two buckets per socket, stored on `socket.data.__rsnRateBuckets` so state is garbage-collected with the socket (no Map leak, works with the existing single-socket-per-user eviction): bucket 'chat' for ['chat:send','chat:react','chat:request_history','reaction:send'] and bucket 'presence' for ['presence:heartbeat','presence:ready','presence:room_joined']. Separate buckets so a chat flood can NEVER starve heartbeats (a starved heartbeat would feed the presence-flap problem).
- Parameters per bucket: capacity 20 (burst), refill 10 tokens/sec (per the scope: 10 events/s burst 20). Continuous refill: `tokens = min(20, tokens + (now-last)/1000*10)`.
- Exports: `classify(eventName): 'chat'|'presence'|null`, `allowSocketEvent(socket, eventName, now=Date.now()): boolean` (returns true for unclassified events), `shouldEmitRateWarning(socket, now=Date.now()): boolean` (at most one warning per 2000ms per socket).

HOOK POINTS in orchestration.service.ts:
1. wrapHandler (lines 92-106): add `if (!allowSocketEvent(socket, eventName)) return;` as the FIRST line of the socket.on callback, before the try. None of today's wrapHandler events are classified (session:join, rating:submit, host:* stay EXEMPT — deliberately: reconnect storms and host actions must never be shed), so this is future-proofing plus the single documented chokepoint the next event registration inherits.
2. The raw registrations for the targeted events (chat:send 353-356, chat:react 357-360, chat:request_history 362-365, reaction:send 366-369, presence:heartbeat 279-282, presence:ready 283-286, presence:room_joined 291-294): prepend the same check.

REJECTION BEHAVIOR (the contract):
- presence:* and chat:react / reaction:send / chat:request_history: SILENT DROP (no emit). Rationale: these are fire-and-forget signals; an error toast per dropped reaction would itself be a fanout amplifier, and hostQuiet mode suppresses non-actionable toasts anyway. Log at debug with { userId, eventName }.
- chat:send: DROP + `socket.emit('error', { code: 'RATE_LIMITED', message: 'You are sending messages too quickly — give it a moment.' })`, throttled by shouldEmitRateWarning to ≤1 per 2s per socket. The client's existing socket.on('error') handler (useSessionSocket.ts:1089-1095) falls through to showing data.message as a toast, so NO client change is required. Chat has no optimistic local echo dependency on the server ack beyond the broadcast, so the sender simply sees their message not appear plus the toast — correct UX for a flood.
- EXEMPT (documented in the module header): session:join, session:leave, session:resync, rating:submit, rating:skip, participant:leave_conversation, all host:*, all dm:* (DM volume is platform-level; revisit separately).
Sizing sanity: fastest legit human chat ≈ 2-3 msg/s — never trips; reaction spam click-storm ≈ 5-8/s — burst 20 absorbs; heartbeat is 1 per 15s on its own bucket.

### Code sketch

````
// state/socket-rate-limit.ts
const CHAT_EVENTS = new Set(['chat:send', 'chat:react', 'chat:request_history', 'reaction:send']);
const PRESENCE_EVENTS = new Set(['presence:heartbeat', 'presence:ready', 'presence:room_joined']);
export const SOCKET_RL_CAPACITY = 20;
export const SOCKET_RL_REFILL_PER_SEC = 10;
interface Bucket { tokens: number; last: number }
interface RlState { chat: Bucket; presence: Bucket; lastWarnAt: number }
export function classify(event: string): 'chat' | 'presence' | null { ... }
export function allowSocketEvent(socket: { data: any }, event: string, now = Date.now()): boolean {
  const kind = classify(event);
  if (!kind) return true;
  const st: RlState = socket.data.__rsnRateBuckets ??= {
    chat: { tokens: SOCKET_RL_CAPACITY, last: now },
    presence: { tokens: SOCKET_RL_CAPACITY, last: now }, lastWarnAt: 0 };
  const b = st[kind];
  b.tokens = Math.min(SOCKET_RL_CAPACITY, b.tokens + ((now - b.last) / 1000) * SOCKET_RL_REFILL_PER_SEC);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1; return true;
}
export function shouldEmitRateWarning(socket: { data: any }, now = Date.now()): boolean { /* 2s throttle on st.lastWarnAt */ }

// orchestration.service.ts — wrapHandler (92-106)
socket.on(eventName, async (data: any) => {
  if (!allowSocketEvent(socket, eventName)) return;   // JNS-5: classified events only; others pass
  try { await handler(io, socket, data); } catch (err) { ...unchanged... }
});

// chat:send registration (353)
socket.on('chat:send', async (data) => {
  if (!allowSocketEvent(socket, 'chat:send')) {
    if (shouldEmitRateWarning(socket)) socket.emit('error', { code: 'RATE_LIMITED', message: 'You are sending messages too quickly — give it a moment.' });
    return;
  }
  try { await handleChatSend(io, socket, data); } catch ...
});
// chat:react / reaction:send / chat:request_history / presence:* — same guard, silent drop.
````

### Tests to add

- NEW socket-rate-limit.test.ts (pure unit, fake clock): burst of 20 allowed then 21st denied; after 1000ms exactly 10 more allowed; chat flood does NOT consume presence tokens (send 100 chat events, then presence:heartbeat still allowed); unclassified event ('session:join') always allowed and consumes nothing; buckets are per-socket (two socket.data objects independent); shouldEmitRateWarning fires at most once per 2s.
- Integration-style pin in the same file: orchestration.service.ts source contains `allowSocketEvent(socket, eventName)` inside wrapHandler and `allowSocketEvent(socket, 'chat:send')` (plus the other six raw registrations) — and the RATE_LIMITED emit exists ONLY in the chat:send registration.
- Existing services/socket-events.test.ts and breakout-bulk.test.ts registration pins must pass unchanged (event names and wrapHandler usage untouched).
- Headed Playwright prod smoke: 3 browsers in an event; browser A runs a page-context loop emitting 50 chat:send/s for 5s. Assert: browser B receives a bounded trickle (≈10/s) not 250 messages; browser A sees the rate-limit toast at least once; browsers B/C heartbeats unaffected (no participant:left flap for A or anyone during the flood); normal chat from B delivers instantly during A's flood.

### Acceptance criteria

- A socket emitting >10/s sustained on chat/reaction events is shed to ~10/s with burst 20; all other sockets and all exempt events are unaffected.
- A chat flood from a socket never causes that socket's presence:heartbeat to be dropped (separate buckets — asserted by unit test).
- chat:send over-limit produces the RATE_LIMITED error at most once per 2s; reactions/presence shed silently.
- No new dependency added; client unchanged.

### Risks

1) In-process state: limits reset on deploy and are per-instance — fine for the current single-instance Render deployment (documented in the module header; revisit with rate-limit-redis if horizontal scaling lands — the dependency already exists in package.json for the HTTP layer). 2) False positives: a legit feature that bursts reactions (e.g. emoji rain) would shed silently — capacity 20 covers known UX; monitor the debug log counter for a week after ship. 3) The generic client error toast renders data.message — wording must be user-safe (it is part of the contract above). 4) Dropping presence:ready during a pathological loop could delay a status reset — presence:ready is client-emitted once per connect/foreground, nowhere near 10/s; risk negligible.

### Deploy notes

Server-only, no migration, no env, no render.yaml. Client untouched (toast rides the existing generic error handler). Independent — ship any time; recommended last in the cluster since it is pure hardening. Full local suite + the 3-browser flood smoke before sign-off; afterwards extend the 40-browser load run to include a flood client to confirm no legit-user 429-equivalents (zero drops for normal usage).

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** The RATE_LIMITED rejection contract is slightly understated: unknown codes in the client error handler fall through with severity 'error' (useSessionSocket.ts:1124), which fires the toast AND `store.setError(...)` — a persistent error banner for 5s (useSessionSocket.ts:1127-1133) — repeated every 2s under sustained flood. The spec promises 'toast' semantics and leans on hostQuiet, but hostQuiet does not suppress the severity-'error' fallthrough path.

*Required action:* Either document the banner as accepted behavior for a flooding client, or add a one-line FRIENDLY map entry `RATE_LIMITED: { msg: rawMsg, severity: 'info' }` in the same item (and amend the 'client untouched' deploy note accordingly).

## Reviewer-verified facts (safe to rely on)

- withSessionGuard exists at server/src/services/orchestration/state/session-state.ts:117-131 exactly as cited (non-reentrant promise-map mutex); handleJoinSession spans participant-flow.ts:430-1111 with its ENTIRE body inside the guard, and every sub-block line range in JNS-1 (437-441, 444-449, 451, 457-481, 512-534, 537-555, 560-591, 603-629, 639-695, 697-703, 714-733, 740-774, 782-868, 876-897, 899-902, 905-1096, 1098-1103, 1106-1109) checks out against the branch.
- All JNS-1 pinned tests exist and slice as the spec claims: Bug-36 pin ends at '// Notify others — include isHost flag' and Bug-37.1 pin ends at the FIX-A comment (phase-may19-bugs-33-36-37-44.test.ts:72-134), Bug-44 +1200-char window (:191-202), 3-way currentStatus condition + FROM-matches-before-reset pins (disconnect-rejoin.test.ts:166-201 — the 2-way jsForm regex is a substring of the kept 3-way condition), ratingReplayStatuses single-line pin (june10-skip-ratings-no-revert.test.ts:36-54), kick-bounce 700-char window pin (june10-kick-is-terminal.test.ts:39-45), and the s14/s18/s20/ws2 pins all use sliceFn('export async function handleJoinSession' → next '\nexport') so the in-function restructure survives them. No test pins that handleJoinSession's first statement is withSessionGuard.
- JNS-2 symbol reality: handleHostCreateBreakoutBulk guard at breakout-bulk.ts:100, sequential awaited createMatchRoom with no retry at :222-230, slug shape at :222, INSERT with timer_visibility + is_manual at :276-280, per-room timer block :350-454, tail :457-477; createRoomWithRetry is a PRIVATE `async function` returning boolean at round-lifecycle.ts:82-103 (never throws); ROOM_BATCH_SIZE=20 Promise.all batching precedent at :308-338; verifyHost (host-actions.ts:191-215) is read-only; no static import cycle is created by breakout-bulk → round-lifecycle.
- JNS-3 symbol reality: roomTimers/roomSyncIntervals/clearRoomTimers at host-actions.ts:2616-2633, ensureManualDashboardInterval :2651-2707, single-create timer block :2911-3006 (its 5s sync emits `{ segmentType: 'breakout', secondsRemaining }` without endsAt, unconditional — as the spec says), single-create INSERT :2818-2822, handleHostExtendBreakoutRoom reschedule :1973-1979, extend-all :512-517 and set-duration-all :653-663 in breakout-bulk.ts, solo-partner 5s timeout :2857; endRound persist at round-lifecycle.ts:563 vs backstop arm :734-742 (problem statement accurate); raw detectNoShows setTimeout :486-488 and ROUND_ACTIVE dashboard interval :491-499; recoverActiveSessions :109-222 with warmParticipantStatesOnRestore in BOTH branches; completeSession:905 dynamic-import('./host-actions') pattern exists; persistSessionState at session-state.ts:163-187.
- Lock-order/deadlock check passes: grep of all non-test withSessionGuard call sites shows only handler entry points + the orchestration.service.ts:128-133 timerCallbacks wrap; detectNoShows, maybeAutoEndEmptyRound, endRound, endRatingWindow, transitionParticipant, emitHostDashboard and emitRatingWindowOnce never acquire the guard, so armNoShowTimer's withSessionGuard wrap and JNS-1's in-lock blocks are deadlock-free; phase2-locked-transitions.test.ts:35-51 pins are untouched by all five items.
- Library reality: server/package.json pins socket.io ^4.7.0 (socket.data supported, no built-in per-event limiter), express-rate-limit ^7.1.0 + rate-limit-redis ^4.3.1 (HTTP-only, unused here), livekit-server-sdk ^2.0.0, pg ^8.12; DB pool default max 25 (config/index.ts:19); tsconfig.base.json noUnusedLocals:true and server/tsconfig.json extends it — so JNS-3's import-prune + single pin update (breakout-bulk.test.ts:294 /roomTimers,\s*roomSyncIntervals/) is real and is indeed the only required pin edit: after extraction, roomSyncIntervals and RoomTimerState become unused in breakout-bulk.ts while roomTimers stays used (:509, :650, :772) and clearRoomTimers stays used (:306, :561).
- Migration safety: latest migration is 067 (068 free, no collision); migrate.ts wraps each file in BEGIN/COMMIT at :49-58 as cited; matches.timer_visibility exists with DEFAULT 'visible' (migration 039) and is_manual (040), so recoverManualRoomTimers' SELECT columns all exist; nullable no-default TIMESTAMPTZ ADD COLUMN is metadata-only.
- JNS-4 pins verified compatible: s17-instant-mute-ordering.test.ts:70 unmute regex allows ≤400 chars between enforceLiveKitMute(...true) and .then(() => { (the sketch's .catch chunk fits) and ≤200 to the emit; the MUTE-branch slice (:73-80) keeps relay-before-revoke; handleHostMuteAll is raw-registered (unguarded) at orchestration.service.ts:338-341; enforceLiveKitMute = 2 parallel queries + ≤2 LiveKit calls (:1289-1327); phase-o pins (persist-before-relay, verifyHost) unaffected; no other callers of handleHostMuteAll exist.
- JNS-5 hook points verified: wrapHandler at orchestration.service.ts:92-106 with no body pins (tests pin only wrapHandler('event', …) registration names); chat:send :353-356, chat:react :357-360, chat:request_history :362-365, reaction:send :366-369, presence:heartbeat :279-282, presence:ready :283-286, presence:room_joined :291-294 all match; client heartbeat is 1/15s (useSessionSocket.ts:161-164) so the presence bucket never trips legitimately; unknown error codes fall through to rawMsg on the client (useSessionSocket.ts:1124, pinned by phase-4-and-5-atomic-and-errors.test.ts:140-143) so the RATE_LIMITED message text does render.
- may25-live-fixes pins verified for JNS-3: the negative pin /userRoom\([^)]*\)\)\.emit\('timer:sync', \{ secondsRemaining/ (line 88) is satisfied by armManualRoomTimer's '{ segmentType: \'breakout\', secondsRemaining' ordering; endRound backstop pins (no startSegmentTimer→endRatingWindow within 60 chars, RATING_BACKSTOP_MS=90_000, activeSession.timer = setTimeout) survive adding the post-arm persist; startSegmentTimer DOES broadcast timer:sync (timer-manager.ts:103-156), confirming the spec's rationale for the raw-setTimeout ROUND_RATING recovery; canonical-100-shipB.test.ts:320-325 recoverActiveSessions pin has ~1,500 chars of headroom for the rearmRecoveredTimers calls (measured offsets 1665/4447 of 6000).
- JNS-1 client-side ordering risk verified as low, as the spec claims: the session:state handler is fully field-guarded with no phase writes (useSessionSocket.ts:194-221) and setSessionStatus is a pure set (sessionStore.ts:458), so match:assigned / rating-replay emits preceding the snapshot unicast do not get clobbered; the FIX-A combined query is semantically equivalent for all row-presence cases (no sp row, active match, stuck statuses).

