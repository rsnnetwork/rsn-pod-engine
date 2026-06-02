# Phase 1 — Quick Wins + Greedy Completeness Fallback

**Date:** 2026-05-05
**Estimated effort:** 1 day (~6 focused hours)
**Risk:** Low. All changes are isolated, additive, and reversible.
**Production DB ops:** 1 migration (additive only) + 1 surgical cleanup of session `3fc21cbb`.
**Why this phase exists:** Close the visible bugs from the test event (session `3fc21cbb-f806-47b8-8642-e9f8d75ea9ab`, 5 May 2026, "crib de crop") *before* the architectural rebuild starts. So the next test isn't sabotaged by issues we already know about.

---

## What ships in this phase

### Item A — Per-user recap on `/live` post-event view

**Bug:** `SessionComplete.tsx` (the post-event card embedded in `/session/:id/live`) calls `GET /ratings/sessions/{id}/stats` which is a **session-wide aggregate endpoint**. Every participant sees the same "12 mutual matches" number — confirmed in live data.

**Files:**
- `client/src/features/live/SessionComplete.tsx` — replace the stats call with the per-user recap call (`/sessions/:id/recap`) and read `uniquePeopleMet`, `totalMeetings`, `mutualMatches`, `connections.length`. Same pattern that `RecapPage.tsx` already uses correctly.
- Optionally remove the `mutualMeetAgainCount` reference if it's not referenced elsewhere; keep `avgQualityScore` and `meetAgainRate` which are session-wide *and the user reads them as host-style anyway* (verify intent first — Stefan might want these to be per-user too, in which case the recap endpoint already exposes them).

**Verification:**
- Type-check + build clean
- Browser walk: open the post-event view as 2 different participants, confirm mutual-match counts differ
- Confirm at least one participant in `3fc21cbb` shows their actual per-user count (3, 4, 4, 5, 5, or 5) instead of the session-wide 12

---

### Item B — Re-match SQL hardening + DB UNIQUE constraint (migration 057)

**Bug:** `handleHostRegenerateMatches` deletes only `scheduled` and `cancelled` matches before regenerating. Anything in `confirmed` / `forced` / other state survives. Re-match presses then layer new matches on top → duplicates. This is what made round 4 of `3fc21cbb` have 6 matches with the same pair (`5b0c7b21, c52d876d`) appearing twice.

**Files:**
- `server/src/db/migrations/057_dm_match_pair_uniqueness.sql` (new)
  - Add `UNIQUE(session_id, round_number, LEAST(participant_a_id, participant_b_id), GREATEST(participant_a_id, participant_b_id))` via a unique index expression. Ensures the same unordered pair cannot exist twice in the same round, ever, at the DB level.
  - Note: the column is named `participant_a_id` but the engine doesn't always order them; expression index is the right call.
- `server/src/services/orchestration/handlers/matching-flow.ts` — widen the `handleHostRegenerateMatches` `DELETE` to include all states (anything in the pending round that isn't already started gets nuked before regenerating). Use the activeSession's `pendingRoundNumber` as the guard so only the previewing round is affected, never a confirmed/active one.

**Tests:**
- New `phase-N-rematch-hardening.test.ts` with grep-style pins:
  - Migration 057 creates the unique index expression
  - The DELETE in `handleHostRegenerateMatches` is no longer state-restricted

**Verification:**
- Migration applies on Neon (verify table index exists with `pg_indexes` query)
- Server tests pass (967 → +N)
- Manually: in staging, generate matches → press Re-match 4 times → confirm round still has exactly N pairs (not 4N)

---

### Item C — Surgical cleanup of session `3fc21cbb` round 4

**Bug:** Round 4 has 6 matches for 6 people, including a literal duplicate pair `(5b0c7b21, c52d876d)` and people booked in 2 matches simultaneously. None should exist — only rounds 1–3 were intended.

**Plan:**
1. Pull the full match list for round 4 of `3fc21cbb` and confirm with the user which pairs are legit vs duplicates.
2. With explicit user approval (this is a destructive prod DB op, RajaSkill rule):
   - DELETE the 6 round-4 matches (keep 0 matches in round 4, since the event was 3 rounds)
   - Cascade automatically removes their `meeting_records` (FK ON DELETE CASCADE)
   - Cascade automatically removes their `ratings`
3. Verify per-user counts in `meeting_records` reduce to the legitimate values (per-user uniques drop from 4–5 to ~3–4 reflecting only rounds 1–3)
4. Update `sessions.current_round` from 4 → 3 to match reality

**Verification:**
- Per-user mutual counts queried before/after — should drop sensibly
- The screenshot user can refresh `/recap/3fc21cbb` and see correct stats

---

### Item D — Re-match jitter

**Bug:** Re-match button does run on the server but produces identical output (deterministic greedy). User feels nothing happens.

**File:**
- `server/src/services/matching/matching.engine.ts` — when called with a "regenerate" flag, add tiny noise (±2–5% of score) to break ties. Initial Generate stays deterministic (best score always wins on first try). Re-match becomes "give me a different acceptable arrangement."

**API:**
- Pass `regenerate: boolean` flag through the engine entry point. Default false.
- When true, score = baseScore × (1 + (random() - 0.5) × 0.05).

**Verification:**
- Unit test: same input + `regenerate=false` → same output (deterministic)
- Unit test: same input + `regenerate=true` × 100 trials → at least N distinct match sets (jitter does change order)
- Browser walk: press Re-match in staging → see at least one pair swap when participants are similar

---

### Item E — Multi-bye visibility + Path 2 augmenting search

**Bugs:**
1. Engine reports only the FIRST bye participant via `byeParticipant` field; multiple-bye case loses visibility.
2. Greedy fails to find a complete matching when one exists (the round-3 case in `3fc21cbb` — math says 6 people / 3 rounds shouldn't bye anyone).

**Files:**
- `server/src/services/matching/matching.engine.ts`
  - Already populates `byeParticipants[]` array internally — surface it on the engine return shape.
  - **Add Path 2 augmenting search:** after greedy completes, if `stillUnmatched.length > 1`, attempt re-pairing with different starting choices until either a complete matching is found or all permutations exhausted. For ≤30 participants this runs in milliseconds.
- `server/src/services/orchestration/handlers/matching-flow.ts` — surface multi-bye to the host UI via the existing `match_preview` payload.
- `client/src/stores/sessionStore.ts` — add `byeParticipants: string[]` to the preview state.
- `client/src/features/live/HostControls.tsx` — render a small banner above the preview: "X people on bye this round — unique pairs exhausted" with the names listed. Only shows if `byeParticipants.length > 0` AND Path 2 confirmed no complete matching exists.

**Tests:**
- Pin: with 6 participants + 2 prior rounds matching the `3fc21cbb` history, engine produces 3 pairs in round 3 (no bye)
- Pin: with mathematically impossible scenarios (4 participants who've all met everyone), bye list contains all unmatched, banner renders

**Verification:**
- Run the regression test seeded with `3fc21cbb` history → assert 0 byes in round 3
- Live: in staging, run a 6-person 3-round event → confirm no byes ever
- Banner appears only when byes are mathematically forced

---

## Files touched (full list)

### New
- `server/src/db/migrations/057_dm_match_pair_uniqueness.sql`
- `server/src/__tests__/services/matching/phase-N-rematch-hardening.test.ts`
- `server/src/__tests__/services/matching/phase-N-greedy-completeness.test.ts`

### Modified
- `client/src/features/live/SessionComplete.tsx`
- `server/src/services/orchestration/handlers/matching-flow.ts`
- `server/src/services/matching/matching.engine.ts`
- `server/src/services/matching/matching.service.ts` (jitter flag plumbing)
- `client/src/stores/sessionStore.ts` (byeParticipants field)
- `client/src/features/live/HostControls.tsx` (bye banner)
- `shared/src/types/events.ts` (extend match_preview payload)
- `progress.md` (timestamped phase entry)

---

## Verification gate (before declaring Phase 1 done)

All of these must pass:

1. ☐ `cd server && npx tsc --noEmit` — clean
2. ☐ `cd server && npx jest` — all green, count increased by tests added
3. ☐ `cd client && npx tsc --noEmit` — clean
4. ☐ `cd client && npm run build` — clean
5. ☐ `cd shared && npm run build` — clean
6. ☐ Migration 057 applied on Neon: `\d dm_match_unique_idx` shows the expression index
7. ☐ Surgical cleanup of `3fc21cbb` round 4 confirmed: matches=0 in r4, meeting_records reflects rounds 1–3 only, sessions.current_round=3
8. ☐ Per-user counts query for the 6 active participants of `3fc21cbb` returns realistic per-user numbers
9. ☐ CI staging run for the commit: green
10. ☐ CI main run for the commit: green
11. ☐ Render service: status=live at the pushed SHA
12. ☐ Vercel: latest production deployment Ready
13. ☐ Sentry rsn-api: 0 new unresolved in 30 min post-deploy
14. ☐ Sentry rsn-client: 0 new unresolved in 30 min post-deploy
15. ☐ Browser walk in staging: post-event recap shows per-user count for at least 2 different participants; Re-match visibly shuffles at least one pair; no banner when complete matching exists; banner appears in synthetic impossible scenario
16. ☐ progress.md updated with timestamps + verification evidence

If any line fails, the phase is not done. Fix and re-run before moving to Phase 2.

---

## Risks & rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Migration 057 conflicts with existing duplicates | Medium | Run a `SELECT … HAVING COUNT(*) > 1` check pre-migration; clean any existing dups first; only then apply unique index |
| Cleanup deletes legitimate ratings | Low | Pre-write a SELECT preview of what will be deleted; user confirms; transaction-wrap the cleanup so any error rolls back |
| Path 2 augmenting search produces matches that violate priority order | Low | The score is still respected; we just allow choosing a different *starting* pair. Test pins assert priority order is preserved |
| Re-match jitter changes match quality at scale | Low | ±2–5% of score; well below the gap between strong matches. Tests pin that the top-scoring pair when it's unambiguously best still wins |
| Banner copy is wrong tone | Trivial | Stefan-style: "2 people on bye this round" — short, factual |

**Rollback:** every change is in one commit. `git revert <SHA>` reverses everything. Migration 057 is dropped via `DROP INDEX dm_match_unique_idx` + `git push staging:main` to redeploy. Surgical cleanup is irreversible (DELETE), but the session was a test event so the loss is acceptable; users will have already screenshotted the broken numbers anyway.

---

## Sequence (when user gives "go")

1. Confirm understanding of the surgical cleanup scope (item C) — list the 6 matches that will be deleted, get explicit yes
2. Create migration 057 + run pre-flight duplicate check on Neon
3. Apply migration on Neon (confirmed safe by step 2)
4. Implement items A, B, D, E in order
5. Run cleanup C with user confirmation at the moment
6. Run all 16 verification checks
7. Update progress.md
8. Ask before commit
9. Push staging, wait green
10. Push main, wait green
11. Verify Render + Vercel + Sentry post-deploy (per check-whole protocol)
12. Final report with timestamp, all checks ticked, screenshot of post-event recap

---

## What is NOT in this phase

- Pre-event session planning (Phase 2.5)
- State machine adoption (Phase 2)
- Future-only repair (Phase 2.7)
- Fallback ladder (Phase 2.8)
- Real learning loop (Phase 5.5)
- Test-mode UX (Phase 5)

These are queued and will get their own plans.
