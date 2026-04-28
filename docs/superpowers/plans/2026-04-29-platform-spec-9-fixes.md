# Plan — RSN Platform 28 April Spec — 9 Locked Fixes (Architectural)

**Spec source:** `assets/RSN PLATFORM – 28th April .pdf` + clarifications from Stefan (cross-pod / cross-platform matching policy) + user (one-user-one-room hard rule, per-room host controls, distinct people-met count).

**Decision summary:** see chat log "Locked Decisions (29 April 2026)" — 9 fixes covering state integrity, registration, event visibility, matching policy, breakouts, host controls, end-event flow, missed-rating fallback, stats consistency, UI placeholder + state feedback.

**Approach:** Dr Arch — every change is an architectural improvement, not a surface patch. TDD throughout. Each phase ships independently (tested, deployed, verified) so nothing already-working can regress.

---

## Phase ordering (risk-ordered: lowest risk first)

### Phase 1 — UI foundations (Q2, Q3, Q9)
**Scope:** Replace `window.location.href` with React Router `navigate()` in invite-accept paths. Kill every silent `.catch(() => {})`. Replace the `user: user` placeholder on host matching screen with real display names. Add proper Loading/Success/Error states to every uncovered mutation. Surface real backend error messages everywhere — kill generic `"Something went wrong"` fallbacks.

**Files:** `client/src/features/invites/{InviteAcceptPage,InvitesPage}.tsx`, `client/src/components/ui/NotificationBell.tsx`, `client/src/features/sessions/SessionDetailPage.tsx`, `client/src/features/sessions/Lobby.tsx`, `client/src/hooks/useSessionSocket.ts`, `client/src/features/host/*` (matching screen), plus a sweep of any other silent-swallow callsites.

**Tests:** source-code assertions banning `.catch(() => {})` in the relevant files; banning `window.location.href` in the invite-accept paths; a test asserting the host matching screen renders real display names for unmatched users (not the literal string "user").

**Risk:** Low — client only, well-tested React patterns.

### Phase 2 — State integrity + one-user-one-room hard block (Q1)
**Scope:** Manual Match Edit must reject any attempt to add a user who is already in another room (manual breakout OR another matching pair) for this round. Clear error message naming the room conflict. Backend validator must check both `status='active'` AND `status='scheduled'` matches in the round so the block fires during preview, not at Start Round. Strict transition map (currently advisory) — invalid transitions throw, not log-and-continue. Add canonical `participant:state_changed` socket event so frontend always reflects backend.

**Files:** `server/src/services/matching/match-validator.service.ts`, `server/src/services/orchestration/handlers/host-actions.ts` (manual match edit endpoint), `server/src/services/session/session.service.ts` (`updateParticipantStatus` strict mode), `server/src/services/orchestration/handlers/participant-flow.ts` (broadcast state change), client subscribers.

**Tests:** unit tests for validator with `conflictingStatuses: ['scheduled', 'active']`; integration test for manual-match-edit rejecting a user already in a manual breakout; transition-map enforcement test.

**Risk:** Medium — touches host action paths used in production. Strict transition enforcement could break edge cases if any existing code relies on the advisory mode. Audit each `updateParticipantStatus` callsite first.

### Phase 3 — Breakout room edge cases + host controls + distinct people-met (Q5)
**Scope:**
- 3-person room (manual or trio): when 1 leaves or host pulls back, remaining 2 keep talking. No premature rating prompt.
- 1-person manual breakout: stays indefinitely, no auto-return.
- Host controls per breakout room: set/extend timer, pause/resume timer, move users between rooms, pull users back to lobby. Bulk variant for "apply to all active rooms".
- Distinct people-met count: change all "people met" stats to `COUNT(DISTINCT partner_id)` across all rooms (manual + algorithm + trio), not `SUM(partners_per_round)`.

**Files:** `server/src/services/orchestration/handlers/{round-lifecycle,participant-flow,host-actions}.ts`, `server/src/services/rating/rating.service.ts`, `server/src/services/session/session.service.ts`, `server/src/routes/sessions.ts` (host control endpoints), client `HostControls.tsx`, recap page.

**Tests:** scenario tests for 3→2 continuation; 2→1 lobby-return preserved; 1-person hold; bulk-vs-per-room timer change; distinct count test.

**Risk:** Medium — orchestration logic, rating flows.

### Phase 4 — Matching policy 3-option chooser (Q4)
**Scope:** Add `matching_policy` field to session config: `'platform_wide'` | `'within_event'` (default) | `'none'`. Matching engine reads this and applies the right exclusion filter:
- `platform_wide` → existing cross-event encounter history
- `within_event` → query `matches` for this session only, exclude pairs already matched here
- `none` → no exclusion
Add radio selector to event creation form.

**Files:** `server/src/services/matching/matching.service.ts` (`getEncounterHistoryForUsers` extended), `server/src/services/session/session.service.ts` (config schema), shared types, `client/src/features/sessions/CreateSessionPage.tsx`.

**Tests:** matching engine test for each of the 3 policies; default-policy test; event creation form test.

**Risk:** Medium — matching engine is core. Backwards-compatible default ensures existing sessions don't change behavior unintentionally.

### Phase 5 — End event flow + missed-rating fallback (Q6, Q7)
**Scope:**
- Context-aware End Event: instant if everyone in lobby and rated; 8-10s rating popup if rounds in progress.
- Missed-rating collection at event end: query for any (user, match) pair where match is `completed`/`reassigned` and no rating exists, surface forms with context labels.
- New endpoint `/sessions/:id/unrated-for-me` returning user's missed forms + context.

**Files:** `server/src/services/orchestration/handlers/round-lifecycle.ts` (`completeSession` flow), `server/src/services/rating/rating.service.ts` (new `getUnratedMatchesForUser`), `server/src/routes/sessions.ts` or `ratings.ts` (endpoint), client `RecapPage.tsx` + new `MissedRatings.tsx` step.

**Tests:** End event with rounds in progress vs idle lobby; missed-rating endpoint returns correct context; user can submit/skip per form.

**Risk:** Medium-high — rating flow changes touch live event UX. Phase 5 must be carefully sequenced.

### Phase 6 — Stats parity (Q8) + recap UI/email match
**Scope:** Single canonical SQL source for "Mutual matches" (= distinct people met), "Want to meet again" (= mutual interest from ratings), and "Matches created / Successful" host stats. Recap email content must equal recap UI content for both user view and host view.

**Files:** `server/src/services/rating/rating.service.ts`, `server/src/services/email/email.service.ts` (recap email template), `client/src/features/recap/RecapPage.tsx`.

**Tests:** SQL parity test (UI query == email query); recap content snapshot.

**Risk:** Low-medium — output-only changes.

---

## Per-phase workflow

For each phase:
1. Write failing tests first (TDD).
2. Implement minimal change to make tests pass.
3. Run full server test suite (current baseline: 663 tests). Must stay green.
4. Run full client test suite if touched.
5. Build server + client. Must succeed.
6. Update `progress.md` with the phase summary.
7. Commit with explicit file list (no stray files).
8. Push to staging.
9. Wait for staging CI green.
10. Fast-forward main and push.
11. Wait for Render deploy live.
12. `check whole` — verify no regressions in Sentry, logs, /health, etc.
13. Then proceed to next phase.

## Rollback

Each phase is independent and revertable via `git revert <sha>`. No DB migrations in any phase except possibly Phase 4 (`matching_policy` column on sessions). That migration is additive (default value provided), so it's safe to roll back without losing data.

## Out of scope (explicit non-goals)

- LiveKit `NegotiationError` (separate diagnosis).
- `PARTICIPANT_ALREADY_MATCHED` round-transition error (separate diagnosis).
- Tier-2 horizontal scaling.
- Cross-pod matching policy expansion (Stefan said "expand later").
- Pod-level UI changes to dashboards beyond what Q3 demands.
