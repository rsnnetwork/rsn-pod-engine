# Phase 2.7 + 2.8 — Disconnect Hardening + Fallback Ladder

**Date:** 2026-05-06
**Estimated effort:** ~1 day combined (2.7 is ~3 hours; 2.8 is ~5 hours)
**Risk:** Low. Both phases are additive — they extend behaviour, don't replace it.
**Production DB ops:** None.
**Why this phase exists:** Two remaining spec compliance gaps after Phase 2.5:
1. **Spec §9 disconnect timing.** Spec mandates <60 s keep, 60–180 s reconnect, >180 s treat as left. Today we have a 15 s reassignment timer and **no auto-LEFT timer at all** — disconnected users sit in `DISCONNECTED` state forever until they reconnect or the session ends. Phase 2.7 adds the 180 s auto-LEFT timer.
2. **Spec §10 fallback ladder.** Spec mandates: (1) allow platform repeats → (2) allow pod repeats → (3) allow recent repeats → (4) only then within-event repeats. Today we have a 1-step fallback (strict → allow within-event repeats when zero pairs produced). Phase 2.5E's backtracking-primary makes the ladder rarely needed for ≤30-person events, but spec compliance still requires it. Phase 2.8 adds the 4-level ladder.

---

## Phase 2.7 — Disconnect grace-period hardening

### What's there today

- 15 s reassignment timer (`participant-flow.ts:1409`): when a user disconnects mid-match, partner gets `match:partner_disconnected`; after 15 s the system tries reassignment / bye for that round only.
- Stale-heartbeat detection at 90 s (`STALE_HEARTBEAT_MS`): if no heartbeat for 90 s, fire `participant:left` and clear presence.
- **Missing:** the auto-LEFT transition. A disconnected user's `session_participants.status` stays at `DISCONNECTED` indefinitely until they reconnect or the session ends. They get bye-d for current round (correct) but they're still counted as a participant for future rounds (the pre-plan still includes them).

### What 2.7 ships

**Sub-phase 2.7A — Auto-LEFT timer (~2 hours)**

Add a longer-window timer in `handleDisconnect` that:
- Fires after `DISCONNECT_AUTO_LEFT_MS = 180_000` (3 min, spec value)
- Checks if the user has reconnected since (`presenceMap.has(userId)` is true) — if yes, no-op
- If still disconnected: calls `transitionParticipant(LEFT)` (chokepoint set in Phase 2)
- That triggers `maybeRepairFutureRounds(io, sessionId, 'left')` (chokepoint set in Phase 2.5D), so future pre-planned rounds regenerate without them
- Emits `participant:auto_left` so host UI can toast "Sarah was disconnected for 3 minutes — removed from future rounds"

The 15 s reassignment timer stays as-is (it's the right cadence for a single-round decision; the spec's "<60 s keep" interpretation matches).

**Sub-phase 2.7B — Tests (~1 hour)**

Architectural pin:
- `DISCONNECT_AUTO_LEFT_MS` constant exists with value 180_000
- `handleDisconnect` registers an auto-LEFT timer
- Auto-LEFT path calls `transitionParticipant(LEFT)` and triggers `maybeRepairFutureRounds`

New `host:participant_auto_left` socket event type added to `shared/src/types/events.ts`.

---

## Phase 2.8 — Fallback ladder (Spec §10)

### What's there today

- Strict no-repeat-within-event constraint (default `matchingPolicy=within_event`)
- Single-step fallback: `matching.service.ts:344` — if engine produces zero pairs, retry with `excludedPairs = new Set()` (allows in-event repeats). Each pair this round gets `fallbackUsed=true` + `repeatInEvent=true` for admin visibility.

### What's missing per spec §10

A 4-step ladder, applied when the strict constraint produces an **incomplete** matching (not just zero):

1. **Level 1 — allow platform repeats.** People who've met in any other event on the platform.
2. **Level 2 — allow pod repeats.** People who've met in the same pod across events.
3. **Level 3 — allow recent repeats.** People who've met within a recent window (e.g. 30 days).
4. **Level 4 — allow within-event repeats.** Current fallback.

### What 2.8 ships

**Sub-phase 2.8A — Engine accepts a fallback level (~2 hours)**

`MatchingEngineV1.generateRound(... options?: { regenerate?: boolean; fallbackLevel?: number })`:

- `fallbackLevel: 0` (default) — strict, current behaviour
- `fallbackLevel: 1+` — progressively softens constraints

Implementation: at each level, the engine recomputes the `usedPairs` set based on encounter history scope:
- L0: only within-event pairs excluded (existing `usedPairs` from `previousRounds`)
- L1: same as L0 (platform repeats already implicitly allowed since cross-event pairs aren't in `usedPairs`); **additionally** drop the `encounterFreshness` weight to 0 so the soft-signal penalty doesn't push them away
- L2: L1 + filter encounter history to same-pod only (engine receives `podId` context from service layer; pairs from OTHER pods become "fresh")
- L3: L2 + filter encounter history to recent (< `RECENT_ENCOUNTER_DAYS = 30`)
- L4: drop the cross-round `excludedPairs` entirely (current `pairs.length === 0` fallback)

**Sub-phase 2.8B — Service-layer ladder runner (~2 hours)**

`matching.service.ts` `generateSingleRound`:

Today's flow:
```ts
let round = engine.generateRound(...);
if (round.pairs.length === 0 && excludedPairs.size > 0) {
  round = engine.generateRound(... excludedPairs=new Set()); // L4 jump
}
```

Phase 2.8 ladder:
```ts
for (let level = 0; level <= 4; level++) {
  round = engine.generateRound(..., { fallbackLevel: level });
  const matched = new Set(round.pairs.flatMap(p => [p.participantAId, p.participantBId]));
  const incomplete = matched.size < eligibleParticipantsCount;
  if (!incomplete) break; // got everyone matched at this level
  // else: try the next level
}
```

Each round records the `fallbackLevel` it landed on in `match_reason` (e.g. `'fallback_l2_pod_repeats'`) so admin surfaces show the actual escalation depth.

**Sub-phase 2.8C — Tests (~1 hour)**

New pins in `phase-2-7-2-8.test.ts`:
- 6 participants with all 15 unique pairs already used → engine returns matching at L4 with `fallback_used=true` + `match_reason='fallback_l4_event_repeats'`
- 6 participants with 12 unique pairs used → engine produces complete matching at some lower level, no fallback needed
- The ladder exits at the first level that produces a complete matching
- `RECENT_ENCOUNTER_DAYS` constant is 30

---

## Sub-phase ordering

1. 2.7A code → tests → push staging → CI green → push main → CI green → verify Render/Sentry
2. 2.7B (tests folded into 2.7A's commit since they're small)
3. 2.8A engine code → 2.8B service code → 2.8C tests → push as one commit
4. Same staging→main flow

This is two commits total, not six. Both phases are small enough that splitting further would be ceremony without rigor benefit.

---

## Verification gate

1. ☐ `npx tsc --noEmit` (server, shared) — clean
2. ☐ `npx jest` — all green (current 1018 + new ~10 Phase 2.7+2.8 pins)
3. ☐ `cd client && npx tsc --noEmit` — clean (no client work)
4. ☐ Architectural pin: `DISCONNECT_AUTO_LEFT_MS = 180_000`
5. ☐ Architectural pin: handleDisconnect registers auto-LEFT timer
6. ☐ Architectural pin: auto-LEFT path calls transitionParticipant(LEFT) + maybeRepairFutureRounds
7. ☐ Architectural pin: engine accepts fallbackLevel parameter
8. ☐ Architectural pin: service-layer ladder iterates levels 0..4
9. ☐ Architectural pin: match_reason captures the level (`fallback_lN_*`)
10. ☐ Acceptance: 6 people × all-pairs-used → L4 fallback succeeds with proper logging
11. ☐ CI staging green
12. ☐ CI main green
13. ☐ Render: status=live at the latest pushed SHA
14. ☐ Sentry rsn-api: 0 new "auto-left" or "fallback" error spikes
15. ☐ progress.md updated

---

## Risks & rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Auto-LEFT fires for users who genuinely just had a network blip | Medium | 180 s grace period is generous; AND the timer checks `presenceMap.has(userId)` before transitioning — reconnect cancels |
| Auto-LEFT triggers cascading future-round repairs that confuse the host | Low | Throttle on `maybeRepairFutureRounds` already in place from Phase 2.5D (one repair per 5 s per session) |
| Fallback ladder accidentally allows blocked users to be paired | Trivial | Hard `user_block` constraint runs INSIDE the engine's hardExclusions check — never softened by fallback level. Tests pin this. |
| Fallback ladder iteration is slow when level 4 is needed | Low | Each level call is < 30 ms for ≤30 participants; full ladder runs < 150 ms worst case |
| Spec's level 1/2/3 distinction (platform/pod/recent) is fuzzy in current encounter_history schema | Medium | Implementation collapses 1+2+3 into "soften encounter freshness signal" for now; richer per-level differentiation queued for Phase 5.5 (real learning loop) |

**Rollback:** `git revert <SHA>` per commit. The auto-LEFT timer is purely additive (new timer, doesn't modify existing 15 s reassignment). The fallback ladder is purely additive (new option parameter; default 0 = current behaviour).

---

## What is NOT in this phase

- Richer per-level differentiation in 2.8 (true platform vs pod vs recent encounter queries) — deferred to Phase 5.5 (learning loop) where we'll have the `pair_relationship` aggregate table to make this clean
- Client UI for `participant:auto_left` toast — server emits, host dashboard consumes in Phase 3
- Timer configurability per pod / event template — deferred to Phase 5.5 polish

---

## What "perfect this time" means specifically for 2.7 + 2.8

1. After 2.7, **a user disconnected for 3 minutes is automatically removed from future rounds** without host intervention. Future pre-planned rounds regenerate. Host sees a toast.
2. After 2.8, **the engine never produces an incomplete matching when ANY arrangement is possible** — even if it has to allow within-event repeats as last resort. Backtracking-primary (Phase 2.5E) catches most cases; the ladder catches the rest. Spec §14 acceptance criterion "each user gets one match per session" is now provably guaranteed for arbitrary participant counts and history depths, not just ≤30.
3. **Every match's escalation level is logged** so admin surfaces show where the engine had to relax constraints — full audit trail per Spec §13.
