# Phase 2.5 — Pre-event Session Planning + Future-only Repair

**Date:** 2026-05-06
**Estimated effort:** 5–7 days
**Risk:** **High.** Changes the time at which match generation runs; touches event-start path, round-transition path, Re-match path, late-joiner/leaver paths. Each sub-phase shippable independently to bound risk.
**Production DB ops:** None — no schema changes required (engine already supports global planning; we just wire it differently).
**Why this phase exists:** Matching Spec §3 + §5 + §9. Spec §5 explicitly says: *"Generate the full session plan upfront. Do not match session by session."* Today we match session-by-session at host trigger. This phase shifts to upfront planning + future-only repair, which is the spec's architectural mandate. Most of the symptoms Stefan reported (greedy bye, Re-match feels fake, brittle round-end) collapse into "we never planned globally."

---

## What's already done (do not re-do)

The matching engine **already supports global planning**:

- `MatchingEngineV1.generateSchedule(input)` exists (line 43 of `matching.engine.ts`). It builds a `usedPairs` set across rounds and generates round 1, round 2, … round N in one call, with the no-repeat constraint honored across every round.
- `matchingService.generateSessionSchedule(...)` exists (line 77 of `matching.service.ts`). It loads participants, encounter history, blocks, runs the engine's `generateSchedule`, persists every match.
- The Phase 1 Path 2 augmenting search already finds complete matchings when greedy fails — for ≤30 participants it'll be promoted to primary.

What's NOT done is **wiring**: today, event-start does NOT call `generateSessionSchedule`. Instead, the host triggers `host:generate_matches` which calls `generateSingleRound` for the current round only. So even though the engine could plan globally, we've never asked it to.

---

## Sub-phase plan

Each is a separate commit, independently shippable.

### Sub-phase 2.5A — Wire `generateSessionSchedule` into event-start (~6 hours)

**Goal:** when the host clicks Start Event, generate ALL rounds upfront. Persist them. Subsequent round transitions just look them up.

- New behaviour in `handleHostStart` (`host-actions.ts`): after the existing transition-to-LOBBY_OPEN flow, if the session config has `prePlanMatches: true` (default false in this sub-phase to preserve back-compat), call `matchingService.generateSessionSchedule(sessionId)` which already creates all rounds at status='scheduled'.
- New session-config flag `prePlanMatches` defaults `false`. We flip it to `true` in 2.5B once the round-transition path consumes pre-planned matches correctly.
- Logging: emit a `host:event_plan_generated` socket event with `roundCount, totalPairs` so the host UI can show "Plan generated for 5 rounds" feedback (UI work in 2.5B).

**Tests:** new architectural pin `phase-2-5-pre-event-planning.test.ts`:
- `generateSessionSchedule` is called from `handleHostStart` when `prePlanMatches=true`
- Existing `generateSingleRound`-per-round path still runs when `prePlanMatches=false` (back-compat)

### Sub-phase 2.5B — Round-transition consumes pre-planned matches (~6 hours)

**Goal:** when a round actually starts, look up pre-planned matches for that round number and promote them to 'active' instead of calling the engine again.

- `transitionToRound(io, sessionId, roundNumber)` in `round-lifecycle.ts`:
  - Check if pre-planned matches exist for `(sessionId, roundNumber, status='scheduled')`
  - If yes (pre-plan path): promote those matches to status='active'; build LiveKit rooms; emit dashboard. **No engine call.**
  - If no (legacy path): fall back to `handleHostGenerateMatches` → `generateSingleRound` (current behavior, kept as fallback for sessions started before 2.5A flipped the flag)
- Flip default of `prePlanMatches` to `true` once the path is verified in staging.

**Tests:**
- Round-transition with pre-planned matches: 0 calls to `generateSingleRound`, 0 calls to `engine.generateRound`
- Round-transition without pre-planned matches: legacy path still runs

### Sub-phase 2.5C — Re-match scopes to current round (~4 hours)

**Goal:** the existing `host:regenerate_matches` button behaviour is preserved (works on the current round's preview), but now operates inside a pre-planned event.

- `handleHostRegenerateMatches`:
  - DELETE matches for the current round (already widened in Phase 1)
  - Call `generateSingleRound` for THAT round only, respecting the existing pre-planned future rounds (which contribute to the `usedPairs` set so we don't accidentally re-pair people across rounds)
  - The chokepoint side: future-round pre-planned matches stay 'scheduled' and untouched
- New socket event `host:regenerate_event_plan_forward` for the case where the host wants to regenerate from round N onward (added but not yet UI-surfaced — UI in 2.5D).

**Tests:**
- Re-match on round N preserves rounds N+1, N+2, … unchanged
- Re-match still respects no-repeat-within-event including pre-planned future rounds
- `host:regenerate_event_plan_forward` regenerates from round N forward, leaves earlier completed rounds alone

### Sub-phase 2.5D — Late-joiner / leaver repair (~6 hours)

**Goal:** Spec §9. *"Never change a live session. Only update future sessions."*

- New service function `repairFutureRounds(sessionId, fromRoundNumber, reason)`:
  1. DELETE all 'scheduled' matches with `round_number > currentRoundNumber`
  2. Re-run the engine's `generateSchedule` over the remaining round range, with `previousRounds` populated from the now-completed rounds (so the no-repeat constraint includes their history)
  3. Persist the new future rounds at status='scheduled'
  4. Emit `host:event_plan_repaired` event with reason ('late_joiner' / 'left' / 'host_request')
- Wire from `participant-flow.ts` join path: when a new participant joins mid-event AND `prePlanMatches=true` AND `currentRound >= 1`, call `repairFutureRounds(sessionId, currentRound, 'late_joiner')`. Throttle to one repair per 5 seconds per session.
- Wire from leave/disconnect-permanent path: same, with reason `'left'`.

**Tests:**
- Late-joiner mid-event triggers repairFutureRounds for round currentRound+1 onward
- Repair preserves completed rounds (status='completed') and live round (status='active')
- Repair does NOT touch ratings / meeting_records of completed rounds
- Throttle prevents repair storms when 10 users join in quick succession

### Sub-phase 2.5E — Promote backtracking to primary (~3 hours)

**Goal:** the Path 2 augmenting search shipped in Phase 1 becomes the PRIMARY matching path for ≤30 participants, since "find a complete matching when one exists" is what the spec requires for §10 ("each user gets one match per session").

- `MatchingEngineV1.generateSingleRound`:
  - If `n ≤ 30` (covers every realistic event size): use `findCompleteMatching` first
    - If it returns a complete matching, USE IT
    - If it returns null (impossible), fall back to greedy + Path 2 fallback (which we already have)
  - If `n > 30`: stick with greedy (faster for larger sets)
- This guarantees the Stefan's-spec acceptance criterion #3 ("each user gets one match per session") is met for typical event sizes.

**Tests:**
- 6 participants, 2 prior rounds → backtracking finds the complete matching directly (already pinned in `phase-1-greedy-completeness.test.ts`)
- 30 participants synthetic regression case
- 32 participants → falls back to greedy (large-event path)

### Sub-phase 2.5F — Acceptance gate (~3 hours)

**Goal:** automated test that runs the full event lifecycle and asserts every Section 14 acceptance criterion is met for a realistic event.

- New end-to-end test `phase-2-5-acceptance.test.ts`:
  1. Set up an event with 8 participants, 5 rounds
  2. Call `generateSessionSchedule` (event start)
  3. Assert all 5 rounds × 4 pairs = 20 matches at status='scheduled'
  4. Assert no pair appears twice across all 5 rounds
  5. Assert no participant has a bye in any round
  6. Simulate round 1 → 2 → 3 transitions; assert pre-planned matches are used (no engine re-runs)
  7. Simulate a late-joiner mid-round-2; assert `repairFutureRounds` regenerates rounds 3+ but leaves rounds 1+2 untouched
  8. Simulate a permanent leaver mid-round-3; same shape
  9. Final assertion: every spec §14 bullet provably passes

---

## Verification gate (before declaring Phase 2.5 done)

1. ☐ `cd server && npx tsc --noEmit` — clean
2. ☐ `cd server && npx jest` — all green (current 1002 + new ~25 Phase 2.5 pins)
3. ☐ `cd client && npx tsc --noEmit` — clean (no client work expected)
4. ☐ Architectural pin: `handleHostStart` calls `generateSessionSchedule` when flag enabled
5. ☐ Architectural pin: `transitionToRound` consumes pre-planned matches without engine re-runs
6. ☐ Architectural pin: `repairFutureRounds` skips completed + active rounds
7. ☐ Acceptance test passes: 8 participants × 5 rounds → 20 unique pairs, 0 byes
8. ☐ Acceptance test passes: late-joiner triggers future-only repair
9. ☐ CI staging green for each sub-phase commit
10. ☐ CI main green for each sub-phase commit
11. ☐ Render: status=live at the latest pushed SHA after each sub-phase
12. ☐ Sentry rsn-api: 0 new error spikes related to matching after each push
13. ☐ Manual staging walk: create a 6-person event → start → see "5-round plan generated" feedback → run rounds end-to-end → confirm no bye, no repeat
14. ☐ Manual staging walk: late-joiner test — start a 4-person event, join a 5th mid-round-1, confirm round 2 + 3 + 4 + 5 plans regenerate cleanly with the new participant included
15. ☐ progress.md updated

---

## Risks & rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Pre-planned matches stale after late-joiner before repair fires | Medium | Throttle repair calls but ensure they ALWAYS fire on join/leave (non-skippable); add Sentry alert for "round started with stale plan" |
| `generateSessionSchedule` slow at event start (300+ users) | Low | Engine target is 30 s for 300 users, already measured. Show "generating plan" loading state on host UI; backgroundable if needed |
| Repair fires during round transition timer race | Medium | Wrap repair in transaction; abort and retry-once if currentRoundNumber changed mid-repair |
| Backtracking-as-primary slower than greedy at high participant counts | Low | Capped at n ≤ 30 (verified to run sub-millisecond at that size); n > 30 falls back to greedy |
| Re-match logic inconsistency between current-round-only and forward-regenerate | Low | Two named handlers (`regenerate_matches` for current, `regenerate_event_plan_forward` for future); tests pin scope of each |
| Existing in-flight events break on deploy because their plan was never generated | High → Mitigated | The fallback to legacy `generateSingleRound` path stays in 2.5B for sessions where no pre-plan exists; only NEW events use the pre-plan path |

**Rollback per sub-phase:** `git revert <SHA>` reverts that cluster only. The legacy session-by-session path stays in place as fallback throughout 2.5B–2.5E, so reverting any sub-phase returns to a known-good behavior. Phase 2.5F removes the legacy fallback only after the pre-plan path is verified — that's the only point where rollback would actually require regenerating in-flight session plans manually.

---

## Sequence

1. 2.5A → tests → push staging → CI green → push main → CI green → verify Render/Sentry
2. 2.5B → same
3. 2.5C → same
4. 2.5D → same
5. 2.5E → same
6. 2.5F → same; THIS commit removes the `prePlanMatches=false` legacy fallback because the pre-plan path is now mandatory

---

## What is NOT in this phase

- Fallback ladder (Phase 2.8 — spec §10 "platform repeats → pod repeats → recent → event")
- Real learning loop (Phase 5.5 — spec §8)
- Dynamic config of `prePlanMatches` per pod template (Phase 5.5 polish)
- Client UI for "regenerate event plan from round N forward" — server endpoint added but UI deferred to Phase 3 host dashboard work

---

## What "perfect this time" means specifically for Phase 2.5

1. After 2.5, **every event starts with a fully-formed plan for all its rounds.** The host clicks Start Event and gets a deterministic schedule across the entire event, not a roll-of-the-dice per round.
2. **Joining late or leaving mid-event repairs only the future.** Already-played rounds are immutable; current round runs to completion; future rounds are recomputed automatically.
3. **No participant is ever on bye unless mathematically required.** The spec §14 bullet "each user gets one match per session" is automatically enforced at typical event sizes.
4. **Re-match has clear, scoped semantics.** Current-round Re-match swaps that round only; forward regenerate is a separate explicit command for repair.
5. **The acceptance gate is automated.** Future PRs that break Section 14 acceptance fail CI.
