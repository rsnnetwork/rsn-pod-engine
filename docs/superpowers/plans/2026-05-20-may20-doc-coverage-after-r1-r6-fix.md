# May 20 Doc — Coverage After `d305b72` (R1 + R4 + R6 Fix)

**Companion to:** `2026-05-20-may20-test-postmortem-and-fixes.md`
**Fix commit:** `d305b72` — `fix(matching): exclude event host from reassign + rating paths`
**Status as of fix:** server tests 1656/1656 ✓, lint clean, secret-guard clean

This doc maps every item in the May 20 test plan to one of three statuses:
- ✅ **FIXED by this PR** — the change in `d305b72` directly addresses this item
- 🔵 **STILL EXPECTED TO WORK** — was working before today; not touched by this PR
- ⚪ **DEFERRED** — Ali explicitly said "test later" or low-priority polish

Ali tests the system manually against this plan; any item that fails on the live test → file a follow-up.

---

## Part 1 — Realtime invariant (no refresh, ever)

| Item | Doc bugs | Status | Notes |
|---|---|---|---|
| 1.1 Pod surfaces (create / invite / accept / remove) | Bug 30 | 🔵 | Untouched by this PR. Shipped in earlier Phase 2/Phase 6 realtime migration. |
| 1.2 Events surface (create / invite / accept) | Bug 30, 29, 28 | 🔵 | Untouched. |
| 1.3 Auth-page realtime (bell bumps on non-AppLayout) | Bug 32 | 🔵 | Untouched. |
| 1.4 Realtime stress test (rapid invite/revoke/etc) | Bug 41, Phases 1-6 | 🔵 | Untouched. Entity-tag fanout from realtime migration. |

---

## Part 2 — Pre-event lobby (golden path)

| Item | Doc bugs | Status | Notes |
|---|---|---|---|
| 2.1 Joining / late joiner / Director big tile / co-host badge | Bug 21, 12 | 🔵 | Untouched. |
| 2.2 Pin / unpin button | Bug 1 | 🔵 | Untouched. |
| 2.3 Shield demote/promote | Bug 38 | 🔵 | Untouched, but **R6 fix likely improves cohort-state coherence** because cohosts are now correctly excluded from matching when demoted-then-promoted. |
| 2.4 Director shrinks cohost tile | Bug 26 | 🔵 | Untouched. |
| 2.5 Acting-as-host toggle (Phase J-P) | Phase P, Phase P-A, Bug B | ✅ | R1 enforces "director cannot demote themselves via this flow" SERVER-SIDE — auto-reassign can never put the director into a match, which is the matching-side guarantee of Phase P-A. |

---

## Part 3 — Matching + rounds

| Item | Doc bugs | Status | Notes |
|---|---|---|---|
| 3.1 Match People button enable/disable | Bug 44, 48 | 🔵 partially helped | R6 fix means `eligibleMainRoomCount` server-side now correctly excludes cohorts (which it previously didn't, though it wasn't bitten today because no cohorts). Client-side stale-until-F5 (Bug 48) was already fixed in `10fa4a9`. |
| 3.2 Generate matches / met-before badge | — | 🔵 | Untouched. |
| 3.3 Spinner doesn't wedge | Bug 35, 45 | 🔵 | Untouched. |
| 3.4 Cancel matching mid-spin | Bug 35 | 🔵 | Untouched. |
| 3.5 Another Round (idempotent, persists) | Bug 27, 23, 22 | 🔵 | Untouched. |
| 3.6 Cancelled matches preserved in audit | Bug 25 | 🔵 | Untouched. |
| 3.7 **Cohost promotion / demotion mid-event** | Bug 33 | ✅ | R6 fix replaces the dead `session_participants.role='co_host'` query with `session_cohosts` + `acting_as_host=TRUE` union. Now cohorts mid-event are correctly excluded from new rounds. Promote a cohort → they leave the eligible pool. Demote them → they re-enter. |

---

## Part 4 — Inside breakout rooms

| Item | Doc bugs | Status | Notes |
|---|---|---|---|
| 4.1 fillMode (object-contain default) | Bug 6 | 🔵 | Untouched. |
| 4.2 **Mid-match disconnect (director + cohort)** | Bug 36, 37 | ✅ | R1 makes the director never appear in any match → R1 mechanically eliminates "director stuck in LEFT state on own event" (Bug 36). For cohorts (Bug 37), R6 means cohorts are excluded from the matching pool so they won't be re-matched into ghost rooms on disconnect. |
| 4.3 Late joiner mid-event | Bug 18 | 🔵 | Untouched. The R1 fix incidentally helps because `findIsolatedParticipants` now correctly classifies late joiners (a late joiner who is a host can't be paired into a phantom match). |

---

## Part 5 — Host Control Center (HCC)

| Item | Doc bugs | Status | Notes |
|---|---|---|---|
| 5.1 Opens centered, draggable, resizable | Bug 39, 42, 45, 47 | 🔵 | Untouched. Shipped earlier in `7e71a07`. |
| 5.2 HCC for cohosts | — | 🔵 | Untouched. |
| 5.3 Director removes Phase M opt-in cohost | Bug 43 | 🔵 | Untouched. |

---

## Part 6 — Mobile

| Item | Doc bugs | Status | Notes |
|---|---|---|---|
| 6.1 Tile density (compact/normal/spacious) | Bug 8, 49 | 🔵 | Untouched. Shipped in `10fa4a9`. |
| 6.2 Local-tile controls in compact mode | Bug 51 | 🔵 | Untouched. Shipped in `10fa4a9`. |
| 6.3 Chat panel during breakouts (bottom-sheet) | Bug 9, 50 | 🔵 | Untouched. Shipped in `10fa4a9`. |
| 6.4 Disabled Match People mobile toast | Bug 34 | 🔵 | Untouched. |
| 6.5 HCC on small screens (full-screen drawer) | Phase V | 🔵 | Untouched. |
| 6.6 No horizontal overflow | Phase V | 🔵 | Untouched. |

---

## Part 7 — Notifications + chat + DMs

| Item | Doc bugs | Status | Notes |
|---|---|---|---|
| 7.1 Notification bell (cross-tab) | Bug 41 | 🔵 | Untouched. |
| 7.2 DMs (inbox, reactions, read receipts) | — | 🔵 | Untouched. |
| 7.3 No "bye" in user-visible copy | Bug 40 | 🔵 | Untouched. |

---

## Part 8 — Recap + end of event

| Item | Doc bugs | Status | Notes |
|---|---|---|---|
| 8.1 Mutual Matches dedup | Bug 24 | 🔵 | Untouched. |
| 8.2 Director / host on recap | — | ✅ partially | R1 means the director can no longer appear in match rows, so the recap will no longer show "Director had 1 mutual + 1 people match" — that was a downstream symptom of the host-matched bug from earlier events. |

---

## Part 9 — Admin

| Item | Status | Notes |
|---|---|---|
| User list, templates, violations, support tickets — realtime refresh | 🔵 | Untouched. |

---

## Part 10 — Sanity / regressions

| Regression | Bug ref | Status | Notes |
|---|---|---|---|
| "Something went wrong in Lobby" red error | Bug 46 | 🔵 | Shipped `10fa4a9`. |
| HCC opening at bottom of screen | Bug 47 | 🔵 | Shipped `10fa4a9`. |
| Match People stuck enabled/disabled until F5 | Bug 48 | 🔵 | Shipped `10fa4a9`. |
| Compact-mode controls covering video | Bug 51 | 🔵 | Shipped `10fa4a9`. |
| "Switch back to host" for event director | Phase P | ✅ | R1 fix enforces this at the matching-engine level too. The UI guard was already in place; now the server refuses to put the director into a reassign INSERT. |
| Director stuck in LEFT state on own event | Bug 36 | ✅ | R1 fix — director can never be in any match, can never auto-transition to LEFT via match-end paths. |
| React #185 / infinite update depth | — | 🔵 | Shipped earlier. |
| LiveKit Publish/Negotiation errors taking down whole page | — | 🔵 | Untouched. |

---

## New bugs discovered in today's audit (NOT on the May 20 doc — fixed by this PR)

| Bug | Status | Where to test |
|---|---|---|
| **R2** Per-client count desync (Ali=7, Klas=3, others=0) | ⚪ DEFERRED — partially helped | R2's deep fix needs entity-tag fanout audit on `E.sessionParticipants` for ALL emit sites. Out of scope for tight scope. Ali to verify whether next test still shows divergence. |
| **R3** Ghost participant not matched in R3 | ✅ | Should disappear automatically because R1 eliminates the phantom-match cascade that bloated `excludedPairs`. |
| **R4** Premature rating screen on host refresh | ✅ | `emitRatingWindowOnce` now refuses to fire for host_user_id. Host never sees rating modal even if upstream regresses. |
| **R5** Initial connection flicker ("not connected" briefly) | ⚪ DEFERRED | <5s visible, no functional impact. Fix later. |

---

## What to test against the live system after `d305b72` deploys

Ali — when you next run a test with 8 participants + 1 host, focus on these scenarios because they exercise the new code paths:

### Critical (R1 verification)
1. **Host disconnect during a round.** Close the host's browser tab in the middle of Round 2. Wait 30 seconds.
   - ✅ Expect: NO new match row gets created with the host in it.
   - SQL probe: `SELECT * FROM matches WHERE session_id = '<sid>' AND (participant_a_id = '<host>' OR participant_b_id = '<host>' OR participant_c_id = '<host>')` → 0 rows.

2. **Participant disconnect during a round.** Have a participant close their browser mid-round. Their partner becomes solo.
   - ✅ Expect: Server auto-reassigns the leftover partner with ANOTHER participant (not the host).
   - The new match row will use `auto-reassign-<timestamp>` room slug.

3. **Host refreshes during a round.** The host hits Ctrl+R during R2 while others are still matching.
   - ✅ Expect: Host rejoins as host. No rating screen appears for host. No phantom match created.

### Secondary (R6 verification — only matters if cohorts used)
4. **Run an event with cohorts.** Promote a participant to cohost via Shield. Generate matches.
   - ✅ Expect: cohost is NOT in any match row.
   - ✅ Expect: `eligibleMainRoomCount` decreases when promoting to cohost; increases on demote.

### Sanity (full doc walkthrough)
5. **Run the entire May 20 doc Part-by-Part on the live system.** Most items are 🔵 in this report — they should still work. If any 🔵 item fails, that's a new regression and needs investigating.

---

## Quick test data — what I'd query in DB after the next test

```sql
-- 1. Was host EVER in a match? Should always be 0 rows after the fix.
SELECT m.round_number, m.participant_a_id, m.participant_b_id, m.participant_c_id, m.room_id, m.is_manual
FROM matches m
JOIN sessions s ON s.id = m.session_id
WHERE s.id = '<new-session-id>'
  AND (m.participant_a_id = s.host_user_id
       OR m.participant_b_id = s.host_user_id
       OR m.participant_c_id = s.host_user_id);

-- 2. Were any auto-reassign matches created? If yes, who got paired?
SELECT m.round_number, m.participant_a_id, m.participant_b_id, m.room_id, m.created_at
FROM matches m
WHERE m.session_id = '<new-session-id>'
  AND m.room_id LIKE '%auto-reassign-%'
ORDER BY m.created_at;

-- 3. Cross-check: who was a cohost? They should NOT be in any match either.
SELECT user_id FROM session_cohosts WHERE session_id = '<new-session-id>';
SELECT user_id FROM session_participants WHERE session_id = '<new-session-id>' AND acting_as_host = TRUE;
```

---

## Risk register for this fix

| Risk | Mitigation |
|---|---|
| Subquery in `findIsolatedParticipants` adds query cost | Negligible — runs on disconnect only, not hot path. Single round-trip via NOT IN. |
| Phase M opt-in case (admin chose "Join as host") could now break if `acting_as_host=TRUE` filter is wrong | Test pin: `acting_as_host=TRUE` row → excluded. Verified by Phase R1 test. |
| `emitRatingWindowOnce` adds an extra DB call per emit | Negligible — emit fires only on match transitions, low frequency. Fail-open keeps prior behavior on DB error. |
| Belt-and-braces guard could mask a real bug by silently skipping | All three guards `logger.error` before continuing/returning — Sentry will surface it. |
| Could break a legitimate flow where host SHOULD be in a session_participants row | The host has ALWAYS been in session_participants (verified in today's DB). They've just never been MATCHABLE. The fix preserves the row, just keeps them out of matches. |

---

## Out of scope for this PR (carry to next)

1. **R2 entity-tag fanout audit** — make sure every `participant:*` emit fans `E.sessionParticipants(sessionId)` so client counters can't drift. Today's fix doesn't directly address this; Ali to verify count behaviour during the next test.
2. **R5 initial connection flicker** — small UX polish.
3. **DB-level CHECK trigger** for `matches.participant_*_id != sessions.host_user_id` — belt-and-braces below the code-level guards. Defer to a follow-up after we confirm code-level fix is stable in prod.
4. **Client-side audit of host-id stale references** — if any client component renders matches assuming the host can be in them (e.g., a recap component), would silently show wrong data. Need to verify, but low-likelihood given the data invariant.

---

**Recommendation:** Once `d305b72` is live on prod, run the May 20 doc Parts 1-10 as a smoke test in addition to the R1-R6 verification scenarios above. Report any 🔵 item that fails so we can prioritize.
