# RSN Live-Event Audit — 30–50 Participant Readiness (2026-06-12)

**Scope:** meetings, joining, realtime state, matchmaking, rounds, feedback — audited for correctness and for behavior at 30–50 concurrent participants in one session.
**Codebase:** branch `june9-punchlist` @ `3cf1187` (June-10/11 punchlist tip).
**Method:** 101-agent multi-stage audit — 7 domain auditors reading their subsystems in full (matchmaking engine/service, Socket.IO realtime + presence + fanout, round lifecycle + canonical state, join/rejoin/kick flow + snapshot, host/co-host controls + manual rooms, LiveKit + DB pool + rate limits + deploy config, client live UI), plus 3 follow-up audits chosen by a completeness critic (rating write path, recap read burst, DB migration runner). Every medium+ finding was independently adversarially verified (criticals/majors by two agents with different lenses: code correctness, reachability at 30–50 scale). 72 raw findings → **4 criticals, ~14 majors, ~20 mediums confirmed**; 3 refuted, several downgraded.

## Overall verdict

The platform is genuinely solid at the 5–10 person scale it has been live-tested at. The DB invariants, the matching fallback ladder, kick terminality, and the host-dashboard fanout show real operational hardening, and the "converge via redundant rails" state design makes single-user correctness robust against refreshes and zombie sockets.

**It is not ready for 30–50.** Two confirmed criticals will melt the event outright (main-room video subscriptions, snapshot-refetch storm × the per-IP rate limiter), one is a security hole (any attendee can seize host controls), and one is a race family in the round lifecycle that 30–50-person timing windows will start hitting routinely. The redundancy that makes 10-person events bulletproof is exactly what amplifies into O(N²) load at 50.

---

## Functional requirements assessment

This section answers directly: *are the core functional behaviors — late join, reconnect, disconnect, propagation to all users, and matchmaking after churn — correct and non-buggy?*

**Short answer: the design is correct and the happy paths work. Four verified bugs break exactly these scenarios, and the propagation mechanism is correct-but-quadratic.**

### 1. Late join → reflected to all users ✅ (works, but expensively)

A late joiner emits `session:join`; the server (under the per-session guard) auto-registers them (idempotent, `ON CONFLICT DO NOTHING`, kicked users barred), reconciles status, and broadcasts `participant:joined` + `roster:changed` + a debounced authoritative `session:state`. Every other client refetches the snapshot and sees the newcomer within ~1s; the host dashboard updates via its coalesced feed. **Functionally correct.** The cost is the problem: the reflect-to-all mechanism is an un-debounced REST refetch by all N clients per join (critical C3 below) — correct at 10 people, a 2,500-request storm at 50.

### 2. Matchmaking after late join / leave ✅ (verified working)

Every roster change triggers `repairFutureRounds`, which rewrites all not-yet-started rounds to include/exclude the changed user — throttled to one run per 5s per session with a trailing edge, serialized under the match-generation lock. An auditor flagged this as a load bug and the adversarial verifier **refuted it**: the throttle and lock behave correctly. A late joiner mid-round waits in the main room and is matched into the next round. Eligibility re-checks presence before generation, no-show detection reconciles against live sockets, and trios correctly continue when one member is demoted.

### 3. Reconnect / refresh ⚠️ (designed right, one major bug + two races)

The design is sound: on reconnect the client re-emits `session:join` + `session:resync`; the join replays the active match and rating state; the seq-guarded snapshot rail re-mints the LiveKit token; the user lands back in their breakout; single-socket enforcement evicts the old tab; kick terminality is properly enforced across all rails (well-pinned by tests).

The bugs:
- **M2 (major, confirmed 2×): returning users can be falsely shown "You have been removed from this event."** `handleResync` treats `status='left'` as terminal eviction (`state-snapshot.ts:195-198`), but `left` is NOT terminal here — the 30s reconciler escalates anyone disconnected >90s (phone locked, app backgrounded) to `left`, and explicit leavers may re-enter by design. On return, the *unguarded* resync races the *guarded* join reset and almost always wins → sticky removed-screen until a second manual refresh. At 30–50 people on phones this will hit several users per event, and they will believe the host kicked them.
- **REST snapshot applies have no seq guard** (`useSessionSocket.ts` `applyFullState`): two in-flight `/state` fetches can apply out of order and briefly regress visible state right after reconnect. (The socket `state:snapshot` rail IS seq-guarded; only the REST rail isn't.)
- **Post-deploy reconnect storm serializes behind one lock (M1):** all 50 sockets re-join within seconds, each join doing 10–20 sequential DB round-trips inside `withSessionGuard` — tail users wait 5–15s, and any round timer expiring during the burst waits behind the whole queue.

### 4. Disconnect → reflected to all users ⚠️ (works, with flapping and one round-killer)

The design: 15s heartbeat, 90s stale sweep, 30s reconciler that escalates long-disconnects to `left` *with `fetchSockets()` ground-truth checks*; pair rooms end when membership drops below 2; trios continue with 2; a leave-grace window prevents a refresh from killing rooms; in-room presence on the client is derived from LiveKit's own participant set. The historical presence-staleness bug is fixed **on the read side** (matching/rating/no-show decisions union the presenceMap with live `fetchSockets()`).

The bugs:
- **Presence flapping (medium):** the stale-sweep *producer* still clears entries on heartbeat age alone, without checking live sockets. A connected-but-throttled tab (phone backgrounded, laptop lid half-closed — guaranteed at 30–50) flaps: everyone else sees them leave and rejoin repeatedly, each flap broadcasting `participant:left` + entity fanout room-wide.
- **Ghost matching (medium):** matching eligibility is a fail-open 4-signal union, so a stale-present user can still be matched into a room they will never join. Their partner burns the 60s no-show window and then sits out the entire round, since mid-round re-pairing was deliberately removed (WS2). This is the residue of the historic "#1 bug family" — reduced, not closed.
- **Stuck-at-rating regression in production (part of M3):** the deliberate stale-presence fix in the rating early-close (`union presenceMap with fetchSockets`) is gated on an `io` parameter that the production REST rating path never passes — it is dead code in prod. Ghost entries block the early close until the 90s backstop; throttled-but-present users can stop blocking and get the form yanked mid-typing.

### 5. State propagation generally ✅ correctness / ⚠️ ordering & cost

Every membership/status change does reach all users through at least one rail (roster refetch, debounced `session:state`, seq-guarded `state:snapshot`, coalesced host dashboard). No confirmed bug where a change silently fails to propagate on the happy path. The confirmed problems are: ordering on the REST rail (no seq guard), churn amplification (every change → all-N refetch + all-N resync each minting a LiveKit token), and the round-lifecycle races (C4) which can briefly walk users into rooms whose canonical state was already cleared — the one path where propagation can actively mislead clients.

**Bottom line for the functional requirements:** late join, leave, and roster repair for matchmaking are correct and verified. Reconnect and disconnect are correct in design but carry one user-facing major (false "removed" screen), presence flapping, ghost-matching that costs a real participant their round, and a prod-only regression of the stuck-at-rating fix. All four are fixable with small, targeted changes (listed in the fix plan).

---

## CRITICAL findings

### C1. Any participant can self-promote to co-host (security)
`server/src/routes/host.ts:185-220`, `services/roles/effective-role.service.ts:81-138,183-198`

`POST /api/sessions/:id/host/acting-as-host` requires only `authenticate` and refuses only the event director. Any attendee can POST `{value:true}` for their own row; `getEffectiveRole` returns `'cohost'` for `acting_as_host=true`, so `verifyHost` passes on every host socket handler. The acting-as-host picker was removed from the client on 23 May, but the write endpoint and role override were left live. One attendee can mute-all, kick, scramble rooms, pause, force-close ratings. *Both verifiers: critical, high confidence.*

### C2. Main room: every client subscribes to every 540p stream — browser death at 30–50
`client/src/features/live/Lobby.tsx:41-44,623-626,1600-1622`, `BgCameraPublisher.tsx:65-67`, `lib/backgroundEffects.ts:20`

Every participant publishes 960×540@30 (BG-engine capture). The lobby `<LiveKitRoom>` sets only capture defaults — no `adaptiveStream`, no `dynacast`, no tile cap, no pagination anywhere in the client (grep: zero hits). livekit-client defaults to full subscription of every remote track at the highest simulcast layer, and `LobbyMosaic` renders all of them. At 50: ~49 inbound 540p streams per viewer (~25–80 Mbps) + 49 decoders + MediaPipe segmentation. Phones cap at ~8–12 concurrent decoders. Found independently by two auditors; all four verifier votes critical.

### C3. O(N²) snapshot-refetch storm × the 100 req/min/IP rate limiter
Server `participant-flow.ts:714-717` (+ `host-actions.ts:1036,2086,2168`) → client `useSessionSocket.ts:262-264` → `middleware/rateLimit.ts:49-65`, `render.yaml:62-65`

Every join/kick/co-host change broadcasts `roster:changed`; every client responds with an un-debounced REST `GET /sessions/:id/state` (≈ `fetchSockets()` + 4–6 DB queries each). 50 joins ≈ 1,250–2,500 snapshot builds (~6–12k queries) against a 25-connection pool. All of it counts against the global **100 req/min per-IP** limiter (in-memory, prod-pinned): ~10+ users behind one venue NAT get 429 on `/state` **and** `POST /token` (the only token rail) → eternal "Joining room…". The same limiter also chokes: pre-lobby 10s polls (17 co-located users trip it before Start), the end-of-event recap burst (~10–13 calls/user in the final minute → "Could not load your recap"), and **LiveKit webhooks** (limiter mounted before `/api/webhooks`; round transitions emit 100+ webhooks/min from few LiveKit IPs → push reconciliation shed exactly at peak). Bonus privacy leak: `/state` returns `hccParticipants` (every attendee's email + global role) to every authorized viewer, built unconditionally per call (`session-state-snapshot.service.ts:420-433`).

### C4. Round-lifecycle races: unguarded timers, unguarded confirm_round, TOCTOU FSM checks
`round-lifecycle.ts:481-483,737-742,853-855`, `matching-flow.ts:576-618,842-866`, `orchestration.service.ts:123-154`

Only recovery/resume timer callbacks are wrapped in `withSessionGuard`; the timers armed in normal operation call `endRound`/`endRatingWindow`/`completeSession` directly. `host:confirm_round` (the primary Start Round path) is unguarded AND outside the match-generation lock, so Confirm racing Re-match can `DELETE` a now-active round's match rows (participants sit in LiveKit rooms with no backing rows) or start a round from a half-rewritten plan. FSM checks are check-then-act across multi-await gaps: double `endRound` double-increments `rounds_completed` and duplicates rating fanout. Worst interleaving: status flips `ROUND_ACTIVE` seconds before matches activate; a kick/leave in the window fires `maybeAutoEndEmptyRound` → session lands in `ROUND_RATING` while `transitionToRound` keeps walking people into breakouts and re-writes canonical locations after they were cleared (the ghost-room pattern re-armed via ordering). At 30–50, round start stretches to 2–6s, turning these windows from rare to several-times-per-event.

---

## MAJOR findings

| # | Finding | Where |
|---|---|---|
| M1 | **Join serialization cliff:** 10–20 sequential DB round-trips per join inside `withSessionGuard`; same lock serializes leaves, ratings, host actions, timer transitions. Post-deploy 50-socket reconnect storm → 5–15s tail latency; expiring round timers queue behind it. | `participant-flow.ts:435-1111`, `session-state.ts:117-131` |
| M2 | **False "You have been removed" on reconnect:** `handleResync` treats `left` as terminal; the 30s reconciler escalates >90s-backgrounded phones to `left`; unguarded resync beats the guarded join reset. | `state-snapshot.ts:183-199`, `participant-flow.ts:679-690` |
| M3 | **Rating-burst family:** (a) first-rater check is an unlocked COUNT before `FOR UPDATE` — simultaneous partners double-increment `times_met`; first-ever encounters (most of round 1) hit a no-`ON CONFLICT` INSERT → one partner's rating 500s with no auto-retry; (b) production REST rating path passes no `io` → the `fetchSockets` stale-presence reconciliation is dead code in prod (stuck-at-rating returns); (c) `checkAllRatingsCompleteByUserId` clears/re-arms the shared session timer after multi-await staleness without re-checking status — can silently cancel the NEXT round's timer (round never auto-ends); (d) `submitRating`'s transaction acquires a second pool connection inside itself (meeting-records uses module-level `query`) — at ≥25 concurrent submissions the pool freezes in ~10s waves; (e) meeting_records commits outside the tx → recap counts drift; the "rebuild" promised in the catch-comment does not exist. | `rating.service.ts:120-251`, `routes/ratings.ts:38`, `participant-flow.ts:1437-1595`, `meeting-records.service.ts:29,111-131` |
| M4 | **Bulk breakout freezes the whole session:** sequential per-room LiveKit create + transaction + per-participant updates under `withSessionGuard` (~8–15s for 20–25 rooms) while joins/leaves/ratings are locked out. `round-lifecycle.ts` already has the fix (20-wide parallel batches); the bulk handler never adopted it. | `breakout-bulk.ts:100,218-455` |
| M5 | **Manual-room timers in-memory only, never recovered:** deploy mid-event → ghost rooms, occupants never sent to rating, dashboard interval gone. Rating-window 90s backstop and `detectNoShows` are also lost on restart and never re-armed. | `host-actions.ts:2624-2707`, `round-lifecycle.ts:109-222` |
| M6 | **Matching quality cliff at 31+:** both exact matchers (backtracking AND the augmenting-path rescue) gated `n <= 30` — at 31–50 the engine is pure greedy; corner cases escalate the ladder to L3/L4 which relaxes no-repeat exclusions → avoidable repeat pairings. The in-code comment claims Path-2 covers >30; the guard contradicts it (unintended gap). | `matching.engine.ts:226-246,296-322`, `matching.service.ts:465-512` |
| M7 | **Deploy-overlap double-driving:** the new instance re-arms all session timers from Redis before `listen()` while the old instance still serves — two processes own the same session for tens of seconds (double endRound, conflicting canonical RMWs — the ghost-engine class re-opened cross-process). Per-bug-ship-mid-event makes this routine. | `round-lifecycle.ts:147-153`, `canonical-state.ts:97-111`, `index.ts:379,403` |
| M8 | **Migration runner can brick mid-event deploys:** boot-time DDL on hot tables with no `lock_timeout` (queued ACCESS EXCLUSIVE on `session_participants` blocks every heartbeat/join/select, unbounded); 37/68 migration files self-`COMMIT`, breaking the runner's atomicity — an interrupt between file-COMMIT and the `_migrations` INSERT leaves an applied-but-unrecorded migration that crash-loops every subsequent boot until manual `_migrations` surgery on prod. | `db/migrate.ts:26-66`, `db/index.ts:20-24` |
| M9 | **Client re-render storm:** every snapshot apply swaps the `participants` array identity (whole Lobby tree re-renders on all clients); every TrackMuted/Subscribed event force-bumps the entire unmemoized tile grid. Compounds C2 on phones. | `sessionStore.ts:608-659`, `Lobby.tsx:56-72,339,623-626` |
| M10 | **Redundant per-join fanout:** one join = `participant:joined` + `roster:changed` + `participant:count` (own query) + per-user entity-fanout loop (own query) + debounced `session:state` — ~2,500 socket emits + 50 roster SELECTs across a 50-person arrival window. | `participant-flow.ts:41-53,699-733` |

## MEDIUM findings (confirmed)

- `transitionToRound`'s zero-matches fallback generation excludes only the director (not co-hosts/super-admins), no presence gate, no generation lock (`matching-flow.ts`).
- Room-creation-failure path un-cancels matches: batch-activate + `match:assigned` still fire for cancelled rows (`round-lifecycle.ts`).
- `resolvePendingRound` recovers `MAX(scheduled)` — post-restart Swap/Re-match edits the last planned round, not the previewed one.
- `findCompleteMatching` is unbounded synchronous backtracking — a no-perfect-matching instance near n=30 can freeze the event loop (needs a node budget).
- Stale-present users matchable (fail-open presence union) → partner burns the 60s no-show window and sits out the round (no mid-round re-pairing by design).
- No rate limiting on any socket event (`chat:send` = 3 queries + `fetchSockets` + N-recipient fanout, unthrottled).
- Stale-heartbeat sweep clears on age alone (no `fetchSockets` reconciliation on the producer side) → presence flaps broadcast room-wide for throttled tabs.
- Timer state persisted before armed → deploy can recover timerless or auto-start the next round off a stale timer.
- `endRound` does O(N) sequential queries + N serialized canonical RMWs (multi-second at 50, widening every C4 window); `endRatingWindow` has no backstop if a query throws → session wedged in `ROUND_RATING`.
- Kicked users' LiveKit tokens (TTL up to 4h) never revoked; webhook `participant_joined` heal lacks the sweep's `removed` guard → kick can transiently resurrect in LiveKit.
- Host mute not applied to re-issued tokens (despite the provider comment claiming it) — a refresh restores full publish permission.
- Round-transition token-mint amplification: every status change → all-N resyncs each minting a token, while `match:assigned` ALSO REST-mints (~1,000 burst queries per round cycle at 50).
- `getUnratedPartners` trio bug: the C-slot member gets one partner missing and the other duplicated.
- Host match-preview/confirm flow not refresh-survivable (one-shot `host:match_preview` + local `useState`).
- Chat panel unvirtualized, no per-bubble memoization, forced smooth-scroll per message.
- Remove-from-room gated director-only while every other room control accepts co-hosts (asymmetry), and depends on in-memory state.
- Mute-all fans out per-user LiveKit enforcement sequentially with no concurrency cap.
- Recap data fetched twice (SessionComplete + RecapPage) with window-focus refetch re-firing; post-completion 30s session polling never stops on the recap screen.

## Refuted / downgraded by adversarial verification

- "Each late join triggers a full future-round regeneration storm" — **refuted**: the 5s throttle + match-gen lock behave correctly.
- "acting_as_host not excluded from matching" — the three-subsystem disagreement exists in code, but is unreachable in the shipped product except via C1's endpoint; fixing C1 closes it.
- Terminal-state warn-and-allow fallback, per-process locks under horizontal scaling, grace timers lost on restart — downgraded to minor for the current single-instance deployment (revisit at scale-out).

## What is genuinely sound (keep as-is)

- Defense-in-depth DB invariants: unique pair-per-round partial indexes + active-only uniqueness trigger — duplicate pairs / double-booked participants physically cannot persist.
- Transactional match persistence; pre-event planning; the per-session match-generation lock with post-lock host re-verification.
- The L0–L4 fallback ladder: audit-tagged degradation, provably-safe 2-opt repeat reduction, trio formation instead of byes, hard constraints (blocks, inviter pairs) never relaxed.
- Kick/ban terminality across all rails (register bar, token gate, resync eviction, join eviction) — well-pinned by tests.
- Read-side presence reconciliation (matching/no-show/rating decisions union live `fetchSockets`).
- Host dashboard fanout: 1s coalesce + fingerprint emit-on-change + heartbeat; 20-wide batched LiveKit room creation at round start.
- Client: seq-guarded snapshot rail, LiveKit-derived in-room presence, event-scoped BG engine track reuse across rooms.

---

## Recommended fix plan (priority order)

### P0 — before any 30–50 person event
1. **Gate the acting-as-host endpoint** (C1): require effective role ≥ admin and not-director; regression test that a plain participant gets 403.
2. **Main-room video diet** (C2): `adaptiveStream: true` + `dynacast: true` on the Lobby `<LiveKitRoom>`; cap/paginate rendered tiles; consider 24fps BG capture.
3. **Defuse the storm/limiter collisions** (C3): debounce + jitter the client `roster:changed` → `/state` fetch; seq-guard REST snapshot applies; key the API limiter on userId (or exempt `GET /state` + `POST /token`); mount `/api/webhooks` before the limiter; gate `hccParticipants` on host/cohost role.
4. **Serialize the round lifecycle** (C4): wrap normal-operation timer callbacks + `handleHostConfirmRound` in `withSessionGuard`; put confirm under `withMatchGenerationLock`; re-check FSM status after every lock acquisition / await gap in `endRound`/`endRatingWindow`.

### P1
5. Rating family (M3): pass `io`+sessionId through the REST rating path; `ON CONFLICT` on the encounter INSERT + first-rater decision inside the lock; meeting-records on the transaction client; status re-check before timer clear/re-arm.
6. Reconnect correctness (M2): treat `left` as re-joinable in `handleResync`; only `removed` is terminal.
7. Join cost (M1, M10): move snapshot build outside the guard; collapse redundant per-join broadcasts into the debounced rail.
8. Bulk breakout → 20-wide parallel batches (M4); persist/recover manual-room timers + rating backstop + no-show timer (M5).
9. Presence flap fix: `fetchSockets` check in the stale-sweep producer before clearing (and before broadcasting `participant:left`).

### P2
10. Matcher: node-budgeted exact search at 31–50 instead of the hard n≤30 gates (M6).
11. Migration runner: `pg_advisory_xact_lock` + `SET lock_timeout` + strip inner BEGIN/COMMIT from .sql files (M8); deploy fencing for timer re-arm (M7).
12. Mediums above; client memoization (M9); socket-event rate limiting.

### Verification
- Full server test suite locally before every push (standing rule) + regression tests per fix.
- Headed Playwright prod smokes per shipped fix (standing per-bug process).
- **A 30–50 browser load run against a preview before the first big event**: extend the existing 20-browser canonical-state load harness to 40+, all cameras publishing; assert join-window latency, zero 429s for legitimate traffic, round transitions under churn (refresh + background-tab mix), and rating-burst success rate.
