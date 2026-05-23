# 23 May Live-Test Host-Control Fixes

**Source:** Live test with Stefan, 23 May 2026, after deploy `b6a977b` (popup removal, admin-matchable, reconnect reset, swap/re-match recovery, amber color).
**Scope:** 8 fixes found during that test. Background-change freeze (#9) is deliberately OUT of this batch (separate video-architecture effort).
**Branch:** `fix/may23-live-test-host-fixes` off `main`.
**Theme:** the core matching works; these are eligibility correctness + host-facing feedback. Each is small except where noted.

---

## 1. Eligibility = who is actually in the room  (TOP — the undercount bug)

**Problem:** Host sees "4 in main room" but matching produces a trio/pair (only 2–3 matched). Refreshing every browser fixes it.

**Root cause (confirmed):** two filters disagree.
- Room count + "not matched" list: `status NOT IN ('removed','left','no_show')` — **includes** `disconnected`.
- `getEligibleParticipants` (matching): `status NOT IN ('removed','left','no_show','disconnected')` — **excludes** `disconnected`.
A transient socket/heartbeat blip (mobile lock, backgrounded tab, Wi-Fi) flags a present user `disconnected`; they stay in the count but vanish from matching. The earlier reconnect reset (b6a977b) only fires on `presence:ready` (rejoin), not while idle.

**Fix:** In `handleHostGenerateMatches`, **before** computing eligibility, reconcile presence: for every participant whose socket is currently in `sessionRoom` (`io.in(sessionRoom).fetchSockets()` → userIds) and/or has a fresh heartbeat in `presenceMap`, if their DB status is `disconnected`, transition them back to `IN_MAIN_ROOM` via the chokepoint. Then run `getEligibleParticipants` as normal.

**Files:** `services/orchestration/handlers/matching-flow.ts` (+ small reconcile helper, possibly in `participant-flow.ts`/`session-state.ts`).
**Tests:** present-but-`disconnected` user is reconciled and included; eligible count == present count; a genuinely-gone (no socket) `disconnected` user is NOT included.
**Acceptance:** host never needs to refresh browsers; matched count == people visibly in the room.

## 2. Recap counts only rounds that actually started  (the "3 of 4" bug)

**Problem:** Recap shows "attended 3 of 4 rounds" when only 3 ran. Round 4 exists only as never-started `scheduled` matches.

**Root cause (confirmed):** clicking "Match People"/"Another Round" in the closing phase bumps `config.numberOfRounds` (+`bonusRoundsAdded`) **before** the round starts, and cancelling/ending never reverts it. Recap reads `totalRounds = config.numberOfRounds`.

**Fix:** (a) Move the round-count bump out of the preview/Match-People action and into the actual round **start** (`handleHostConfirmRound` → `transitionToRound`), so a previewed-but-unstarted round never inflates the count. (b) Make recap `totalRounds` derive from rounds that actually ran (distinct `round_number` with completed matches, or `current_round`), not the raw config.

**Files:** `matching-flow.ts` (remove bump from CLOSING_LOBBY branch), `round-lifecycle.ts` (bump on confirmed start), `services/rating/rating.service.ts` `getPeopleMet` (totalRounds source), host recap query.
**Tests:** preview round N+1 but never start → recap stays "of N"; start it → "of N+1".
**Acceptance:** total rounds in recap == rounds the host actually started.

## 3. Swap works (stop the false "already in another match")

**Problem:** Swapping two people between the two preview rooms is rejected: "1 participant already in another active match."

**Root cause (confirmed):** `validateMatchAssignment` takes a single `excludeMatchId` (match-validator line 133). A swap rewrites BOTH rooms, but each validation only excludes its own room, so the swap-partner sitting in the OTHER room reads as a conflict.

**Fix:** Add `excludeMatchIds: string[]` support to `validateMatchAssignment` (`m.id != ALL($n)`); in `handleHostSwapMatch` pass both `[matchA.id, matchB.id]` to both checks. Fix the wording so a scheduled preview isn't called an "active match."

**Files:** `services/matching/match-validator.service.ts`, `matching-flow.ts` (swap handler).
**Tests:** swap two participants between two `scheduled` rooms succeeds; a genuine conflict (third room) still rejects.
**Acceptance:** host can swap any two people between rooms.

## 4. Amber appears the instant the host presses Start

**Problem:** Active round doesn't turn amber on Start; strip shows "Planned" (and for short rounds, never goes amber).

**Root cause (confirmed):** the Event Plan strip is host-only and only refreshes on `host:event_plan_repaired`/`generated`, the entity invalidator, or its 30s timer. Round start (`transitionToRound`) emits entity refreshes to the matched **participants**, plus `session:round_started` to the room — none of which refresh the **host's** strip.

**Fix:** On round **start** (`transitionToRound`) and round **end** (`endRound`/`endRatingWindow`), emit a plan refresh that reaches the host — `host:event_plan_repaired` to the session room and/or `emitEntities([E.sessionPlan, E.session])` to the host IDs.

**Files:** `round-lifecycle.ts`.
**Tests:** `transitionToRound` emits the host-reaching plan refresh; `endRound` likewise.
**Acceptance:** strip flips amber "Active" on Start and green "Done" on round end, immediately.

## 5. Re-match tells the host why nothing changed

**Problem:** Re-match works once, then "does nothing" with no message.

**Root cause:** with limited fresh no-repeat options left, regenerate lands on the same (only) valid arrangement; the result is unchanged and silent.

**Fix:** After regenerate, compare the new arrangement to the prior; if unchanged (or the engine reports no fresh alternative), emit a host toast: "No other no-repeat pairing is possible for this round — these are the only fresh matches left." Quiet confirmation when it does change.

**Files:** `matching-flow.ts` (`handleHostRegenerateMatches`), client toast mapping if needed.
**Tests:** regenerate with no alternative emits the "no other arrangement" message.
**Acceptance:** Re-match never looks dead — it either shuffles or explains why it can't.

## 6. No double-rating after an early pull-back

**Problem:** Host pulls a participant back mid-round; they + partner rate early; round then ends and they're prompted to rate the SAME partner again.

**Root cause (to confirm during impl):** `endRound` already dedups via the `ratings` table, so the early rating's `match_id` likely diverges from what `endRound` re-checks (the pull-back may mark the match `reassigned`/`completed` or create a new row). Need to trace the pull-back + rating-record path first.

**Fix:** Close the dedup gap so an already-rated (user, partner, round) is never re-prompted — align the `match_id` the early rating writes with the round-end dedup, or dedup by (round, user, partner) regardless of match status.

**Files:** `host-actions.ts` (reassign/return-to-main), `round-lifecycle.ts` (`endRound` dedup), `rating.service.ts`.
**Tests:** rate early via pull-back, then end round → no second rating form for that pair.
**Acceptance:** each pair is asked to rate at most once.

## 7. Human-readable round outcomes + don't count hosts as "not matched"

**Problem:** "Round 3 Cancelled · 4 not matched" — counts hosts as not-matched and gives no reason.

**Root cause:** the bye/"not matched" count includes hosts (3-status filter, no host exclusion); cancelled rounds carry no reason.

**Fix:** (a) Exclude director + cohosts from the "not matched" tally. (b) Attach a human reason to a cancelled/short round — "everyone remaining has already met," "N are hosts," "odd number → group of 3" — and render it in the strip.

**Files:** `routes/sessions.ts` (`/plan` endpoint byeCount + reason), matching/round-cancel path, client `EventPlanStrip.tsx`.
**Tests:** `/plan` byeCount excludes hosts; a cancelled round carries a reason string.
**Acceptance:** host reads what actually happened, not a raw cancel + an inflated count.

## 8. Manual Match clarity + visible feedback

**Problem:** Manual Match "does nothing" and is being used to try to swap.

**Root cause:** force-match correctly refuses (both already paired) and says "use Swap," but the rejection isn't surfacing clearly; and Manual Match (pairs two people together) is the wrong tool for a swap.

**Fix:** Ensure the `PARTICIPANT_ALREADY_MATCHED` rejection toasts visibly; clarify labels/help so Manual Match = pair two people, Swap = move people between rooms.

**Files:** `matching-flow.ts` (force-match), client `HostControls.tsx`.
**Tests:** rejection surfaces a toast.
**Acceptance:** host always sees why a manual pair was refused and which tool to use.

---

## Order & shipping

1. **#1 (eligibility)** and **#2 (recap count)** first — highest impact.
2. Then **#3 swap**, **#4 amber refresh**, **#7 round outcomes**, **#5 re-match feedback**, **#8 manual match**.
3. **#6 double-rating** last (needs the trace).

Each via TDD (failing test → fix → green). Full server suite green + client/server typecheck. Ship through staging → CI → main → deploy verify → smoke (`/shipphase`). One deploy for the batch (or split #1+#2 early if the next test is imminent).

**Out of scope:** #9 background-change freeze (separate video-architecture effort), full acting-as-host infra teardown (inert, later cleanup).
