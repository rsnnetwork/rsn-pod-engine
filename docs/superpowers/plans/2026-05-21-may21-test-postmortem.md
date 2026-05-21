# May 21 Test Post-Mortem — three trust-killer bugs

**Date:** 2026-05-21
**Live event analysed:** session `4ce532ec`, started 13:08:45 UTC, ended 13:22:11 UTC, host `4164c7ed` (Stefan Mr Raw), 8 participants total, 11 matches across R1–R4 (R4 was a host-triggered "Another Round" bonus).
**Source:** `assets/Review - 21st May.pdf` + Ali's verbal report + DB forensics on prod session.

---

## Bug catalogue (with root causes)

### M1 — Participant count desync (RECURRING)

**Symptom (Ali, 21 May test):**
> "Actual people in main room is 8 but UI was showing 5. Counts dropped each round: 7 → 5 → 3."

**DB evidence after the event:**
- 8 rows in `session_participants` for session `4ce532ec`.
- Three rows have `status='left'` (Alex Willard, Ali Hamzaa, sa@vokt.ai/Saif), `left_at` set AFTER event ended.
- Two rows have `status='checked_in'` AND `left_at IS NOT NULL` (Shradha's Uni A/C, Stefan Avivson participant) — that's an *inconsistent state* that can't have been written by one straight-line code path.
- The snapshot filter is `status NOT IN ('removed', 'left', 'no_show')` (`session-state-snapshot.service.ts:271`). 8 − 3 = 5. That matches the live count exactly.

**Root cause: two compounding bugs.**

**A) `LEFT` is set too aggressively on socket disconnect.**
`participant-flow.ts:1540–1597` — when a user disconnects mid-round, the server starts a 15 s timeout. If the user's socket isn't back by then, it calls `transitionParticipant(..., ParticipantState.LEFT)`. The state machine writes `status='left'` and `left_at=NOW()`. A 16 s network blip on a phone hand-off, an ISP route flap, or a laptop sleep all cross that threshold permanently.

**B) Reconnect doesn't undo `LEFT`.**
`participant-flow.ts:436–442` — the reconnect path only resets `disconnected` or `in_round` back to `in_main_room`. It explicitly does NOT recover from `left`. So once a participant has timed out, even if they reload the tab and sit through the rest of the event, they stay marked `left` and the participant list never shows them again.

**C) `left_at` is never cleared.**
`participant-state-machine.ts:248–252` — `joined_at = COALESCE(joined_at, NOW())` is preserved-on-rejoin, but there is no symmetric `left_at = NULL` when the state moves out of LEFT. So even when the LEFT row gets force-corrected by the reconciler (Phase 2E) or by a manual reset, the historical `left_at` remains. Downstream surfaces that filter on `left_at IS NULL` (any new code we'd write tomorrow that uses that field) inherit the corruption.

**Why this is a trust killer:** matching engine reads from a different filter than the UI snapshot reads from. Engine matches everyone (it uses `disconnected` filter at `matching.service.ts:47`), UI shows a subset (it uses `status NOT IN ('removed','left','no_show')`). User sees "match generated for 8" but UI says "5 here" and they don't know whom to trust.

---

### M3 — Stefan ↔ Alex / Alex ↔ Saif paired 4× in 4 rounds

**Symptom (Ali, 21 May test):**
> "Stefan and Alexander matched three times that is not possible."

**DB evidence (matches in order):**
| Round | Participants |
|---|---|
| R1 | Ali Hamzaa + sa@vokt.ai + Alexander Willard *(3-way)* |
| R2 | Raja + sa@vokt.ai + Alexander Willard *(3-way)* |
| R3 | Alexander Willard + sa@vokt.ai *(1v1)* |
| R4 | Stefan Avivson + sa@vokt.ai + Alexander Willard *(3-way)* |

Alex and sa@vokt.ai (Saif) co-occurred in **4 of 4 rounds**. `repeat_in_event = false` on every one of those matches — the engine never noticed.

**Root cause: the excluded-pairs query ignores `participant_c_id`.**
`matching.service.ts:264–273`:
```sql
SELECT participant_a_id, participant_b_id FROM matches
WHERE session_id = $1 AND round_number != $2
  AND status NOT IN ('cancelled', 'no_show')
  AND is_manual = FALSE
```
For a 3-way match `{a, b, c}`, the engine records only the `(a,b)` pair as "met". It never records `(a,c)` or `(b,c)`. So in subsequent rounds, c is treated as if they've met nobody.

Why this didn't bite us with 2-person matches alone: Phase Q's auto-elevation + matching engine forces some 3-way breakouts whenever the count is odd or there's a forced fallback. The 8-participant event with an odd-N after host-exclude was structurally guaranteed to surface this.

---

### M2 — "Matched" state not updating in UI

**Symptom (May 21 doc + Ali):**
> "System often does not show 'Matched' even after successful matching."

**Evidence so far:**
- All 11 matches in DB are `status='completed'` → server-side state machine reached the right end-state.
- Client `match:assigned` handler at `useSessionSocket.ts:402–441` does set `phase='matched'` and store the partner + token.
- The early-return at line 408 (`return if sessionStatus is round_rating or completed`) is a documented intentional guard, NOT a bug.

**Unconfirmed hypothesis:** the symptom may be specifically about the HOST's "Match People" button label / the lobby status banner not flipping to a "Matched" indicator. Server-side, `host:match_preview` fires; the host UI probably stays on "Match People" until the host clicks Confirm Matches, never showing a "Matched" badge once breakouts start.

**Resolution path:** Need one clarifying screenshot or one sentence from Ali on *what* the user expected to see. Not blocking M1/M3 ship — defer M2 until M1/M3 are out.

---

## Fix plan (in order)

### Fix 1 — Stop disappearing participants on disconnect (M1, top priority)

**A. Extend the disconnect→LEFT grace period from 15 s to 60 s.**
`participant-flow.ts:1540` (`setTimeout(... 15000)`). 15 s is too tight for typical mobile networks. 60 s catches phone-to-WiFi hand-offs, brief ISP route flaps, and laptop screen-locks while keeping the legitimate "they really did leave" semantic intact for ratings-cutoff purposes.

**B. Recover from `left` on reconnect.**
`participant-flow.ts:436–442` — extend the reset path:
```ts
} else if (
  currentStatus === 'disconnected' ||
  currentStatus === 'in_round' ||
  currentStatus === 'left'   // ← add this
) {
  await transitionParticipant(sessionId, userId, ParticipantState.IN_MAIN_ROOM);
}
```
Wire the same fanout as the host/cohost LEFT carve-out (Bug 36) so other clients' participant lists refresh in the same tick.

**C. Clear `left_at` when state moves out of LEFT.**
`participant-state-machine.ts:248–253` — add a symmetric clause:
```ts
if (toState !== ParticipantState.LEFT && toState !== ParticipantState.REMOVED) {
  setClauses.push(`left_at = NULL`);
}
```
Keeps DB rows internally consistent: `left_at` is set ⇔ `status IN ('left','removed')`.

**D. Backfill defensive snapshot guard.**
`session-state-snapshot.service.ts:271` — current filter is `status NOT IN (...)`. Leave it as-is; the fix above keeps `status` as the single source of truth. But add a clean-up SQL one-shot to backfill the corrupt rows from the 21 May event before we re-run anything: `UPDATE session_participants SET left_at = NULL WHERE status = 'checked_in' AND left_at IS NOT NULL`.

### Fix 2 — Track 3-way co-occurrences as "already met" (M3)

`matching.service.ts:264–273` — broaden the excluded-pairs query and pair-expansion:
```ts
const excludedResult = await query<{ a: string; b: string; c: string | null }>(
  `SELECT participant_a_id AS a, participant_b_id AS b, participant_c_id AS c
   FROM matches
   WHERE session_id = $1 AND round_number != $2
     AND status NOT IN ('cancelled', 'no_show')
     AND is_manual = FALSE`,
  [sessionId, roundNumber],
);
for (const r of excludedResult.rows) {
  excludedPairs.add(pairKey(r.a, r.b));
  if (r.c) {
    excludedPairs.add(pairKey(r.a, r.c));
    excludedPairs.add(pairKey(r.b, r.c));
  }
}
```
Three pairs per 3-way match. The pair-set semantics stay the same; only the input data widens. Same Set, same downstream consumer (the engine's `excluded_pairs` hard constraint).

### Fix 3 — Defer M2 until interview clarifies expected UI state

Will not touch M2 in this batch. Will follow up with Ali for one sentence on what "Matched" should visibly look like vs what it shows now.

---

## Tests to add

**M1:**
- `participant-state-machine.test.ts`: transitioning LEFT → IN_MAIN_ROOM clears `left_at` to NULL.
- `phase-may21-disconnect-grace.test.ts`: 30 s disconnect does NOT mark user as left; 90 s does.
- `phase-may21-reconnect-from-left.test.ts`: reconnect handler resets `status='left'` to `in_main_room` (currently only `disconnected`/`in_round`).
- Source-pattern test: snapshot filter still `status NOT IN ('removed','left','no_show')` (regression guard against accidentally adding `left_at IS NULL`).

**M3:**
- `matching.service.test.ts` (new block): a 3-way `{a, b, c}` match in R1 excludes `(a,c)`, `(b,c)`, and `(a,b)` from R2's candidate pool.
- Source-pattern test: the excluded-pairs query selects `participant_c_id` (regression guard).

---

## Out-of-scope / deferred

- M2 (matched-state UI) — deferred pending clarification.
- May 21 doc Section 4+: other issues postponed per the doc's own opening line ("the other issues and feedbacks are postponed for later").
- Repeated-match prevention across DIFFERENT sessions (the platform-wide encounter freshness penalty) — already in place, not in scope here.
- The Phase 2E reconciler — currently it only converges in-memory ↔ DB on `status`. Could be extended to enforce the `left_at` invariant. Out of scope for this batch; the state-machine fix above prevents new corruption.

---

## Branch + push strategy

RSN convention: `staging` → `main`. Single commit if all three fixes are coherent (likely — all are server-side, isolated). Wait for CI green on both branches and Render redeploy before declaring done. NO live event in progress (DB clean as of 13:25:29 UTC `/checkhole`).
