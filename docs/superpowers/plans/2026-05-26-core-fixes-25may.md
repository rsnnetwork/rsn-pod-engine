# Core Fixes — Stefan's 25th-May list (spec)

- **Date:** 2026-05-26 · **Deadline:** before Wednesday
- **Source:** `assets/core fixes - 25th may.pdf` (9 items)
- **Status:** spec — awaiting approval to build
- **Decisions locked with Ali:** #1 platform-wide = hard exclusion; #3 numerator = others' votes (people who want to meet *you* again) ÷ total people met, shown on recap; #5 DM gate forward-only (existing threads keep working); #6 deferred (structural rebuild); #8 is QA (Ali/team).

---

## Scope

**Building:** #1, #2/#9, #3, #4, #5, #7.
**Out of scope:** #6 (dynamic room resizing — XL structural rebuild, deferred by Ali). #8 (full mobile retesting — device QA, Ali's pass; I'll supply a checklist).

---

## #1 — Platform-wide "no rematch" not enforced (hard exclusion)

**Evidence:** UI policy selector exists (`Platform-wide no rematch / Within this event only / No restriction`). Default `matchingPolicy = 'within_event'` (`shared/src/types/session.ts:110`). For `platform_wide`, cross-event history IS loaded (`matching.service.ts:708`) but only feeds a **soft** score (`encounterFreshness` weight 0.10, `matching.engine.ts:509-524`) — never a hard block. Within-event repeats ARE hard-excluded already (`usedPairs` from prior rounds, `matching.service.ts:271-291`).

**Fix:** When `matchingPolicy = 'platform_wide'`, every prior meeting *anywhere on RSN* becomes a **hard exclusion** (added to the excluded-pairs set passed to the engine, same mechanism as within-event), so those pairs are never generated. The existing fallback ladder (L0→L4) is the only relaxation, and only when a complete fresh matching is impossible. `within_event` keeps current behavior; `none` unchanged.

**Acceptance:** With `platform_wide`, two users who met in any prior event/pod are never paired unless the ladder is forced to relax (no fresh complete matching exists). UI copy ("never be matched again") now matches behavior.

**Files:** `server/src/services/matching/matching.service.ts` (build cross-event excluded pairs for `platform_wide` and pass as hard exclusion), `matching.engine.ts` (ensure hard-exclusion path covers them). **Effort: M.**

---

## #2 / #9 — Fresh pairs not surfaced first; rematch UX

**Evidence:** weights `sharedInterests 0.25 + sharedReasons 0.25 = 0.50` vs `encounterFreshness 0.10` (`matching.service.ts:26-32`). A never-met pair with weaker interests loses to an already-met pair with strong interests, so the first preview shows "met 1x" while fresh pairs exist; they only appear after several rematch clicks.

**Fix:**
- **Freshness becomes the dominant tier in selection:** never-met pairs are always preferred over already-met pairs when a complete matching using fresh pairs exists. Within each tier, existing weighted scoring (interests/reasons) orders the pairs. Already-met pairs are used only when fresh pairs are exhausted, ordered least-met-first (Stefan's "never met → highest, prev meeting → lowest"). Implement as a primary sort key / pre-pass, not just a weight bump (a weight bump alone can't guarantee fresh-first).
- **Feedback (#9):** when the round/preview had to use already-met pairs (fallback engaged), surface it to the host — a clear "No fresh pairings left — showing closest available" state and a visible "finding next person" indication on rematch, instead of the button silently re-rolling.

**Acceptance:** First preview shows all-fresh pairs whenever a fresh complete matching exists. Host sees explicit feedback when repeats are unavoidable. Rematch no longer requires multiple clicks to reach fresh people that were available.

**Files:** `matching.engine.ts` (fresh-first selection), `matching.service.ts` (return fallback level reached), `matching-flow.ts` (surface fallback state), client host preview UI (feedback string). **Effort: M–L.**

---

## #3 — Meet Again Rate wrong on recap

**Evidence:** recap stat computes `(you said meet-again) / (people you RATED)` (`SessionComplete.tsx:139,143-145`) — wrong denominator (rated, not met) and wrong field, so 0 ratings can read 100%. Appears on the recap page at event end (Ali confirmed). `Connection` already has `theirMeetAgain` (the partner's vote — `SessionComplete.tsx:44`, `RecapPage.tsx:22`).

**Fix:** `meetAgainRate = (# people you met whose theirMeetAgain === true) / (total unique people you met)`; 0 met → 0% (never 100%). Apply on the recap (`SessionComplete.tsx`) and `RecapPage.tsx` if it shows the same stat. Label stays "Meet Again Rate" (it's "how many want to meet you again").

**Acceptance:** 4 met, 0 said meet-again about you → 0%; 1 → 25%; 2 → 50%. Stefan rating nobody no longer yields 100%.

**Files:** `client/src/features/live/SessionComplete.tsx`, `client/src/features/sessions/RecapPage.tsx`. **Effort: S.** (Verify the connections endpoint populates `theirMeetAgain` for all met people, not only rated ones.)

---

## #4 — "Expressed Interest" wording

**Evidence:** `SessionComplete.tsx:73-90` + `RecapPage.tsx:90-107` (duplicated `InterestBadge`). Strings: "You expressed interest", "They expressed interest", "Mutual Match!".

**Fix:** "You expressed interest" → **"You wanted to meet again"**; "They expressed interest" → **"They wanted to meet again"**; "Mutual Match!" → **"Mutual interest"** (keep "Mutual Match" elsewhere if it's a section title). **Effort: S.**

---

## #5 — Mutual-match messaging only

**Evidence:** `dm.service.ts:101-127` `canMessage()` allows DM if an encounter row exists (ever met) — never checks `mutual_meet_again`, which already exists in `encounter_history` (`rating.service.ts:197,206`). People page has All Encounters / Mutual Matches tabs (screenshot).

**Fix:**
- **Backend gate:** `canMessage()` requires `mutual_meet_again = TRUE` for the pair, with a new reason `not_mutual`. **Forward-only:** allow sending in a thread that already has messages (grandfather existing conversations); the mutual requirement gates *new* conversations. Re-check on send (handles "one user changes decision later" for new threads).
- **Admin override (server-authoritative):** if the requesting user's **global role is `admin` or `super_admin`**, `canMessage()` returns allowed for **anyone** — no mutual-match and no prior-encounter requirement. Role is read from the DB on the server (never trusted from the client). Applies only to admins (regular members and cohosts still need mutual match).
- **UI — Message button visibility:**
  - Regular members: shown only for mutual matches — People → All Encounters (only rows with mutual badge), People → Mutual Matches (all), live recap mutual section (already present), post-event `RecapPage` mutual section.
  - Admins: Message button shown **everywhere** they can see a person — any recap, any People-page tab/row, and any profile they open (`PublicProfilePage`).

**Acceptance:** A non-admin, non-mutual pair sees no Message button and cannot start a DM; a mutual pair can. An **admin/super_admin sees Message on every person** (any encounter row, any profile) and can DM them regardless of mutual status. Existing conversations remain usable.

**Files:** `server/src/services/dm/dm.service.ts`, `server/src/routes/dm.ts`, client People/encounters page, `RecapPage.tsx`, `SessionComplete.tsx`. **Effort: M.**

---

## #7 — Background-change crash

**Evidence:** the LiveKit track-processor (background blur / virtual bg) is created per room change and on bg change but **never disposed on unmount** (`VideoRoom.tsx:434-517`, `MediaControls` has no cleanup) → processors accumulate across room transitions → WASM/GPU exhaustion → browser crash.

**Fix:** stop/dispose the processor on `MediaControls` unmount and before re-applying a new one; ensure the old track processor is released on room change. **Effort: M.** **Needs real browser verification** (no client test runner) — Ali to confirm across Chrome/Safari/mobile (folds into #8).

---

## Follow-ups from 26 May live re-test (Ali)

### #9-UI — host banner + toast on fallback/repeat
When matches are generated/re-matched and the engine had to use the fallback ladder (repeats), the host must get a **persistent banner** ("This round reuses some past pairings — no fresh matches were possible") AND a **toast** at the moment of the action. The engine already returns `fallbackLevel`/`usedRepeats` (shipped in `ef23dea`); wire it through `matching-flow.ts` preview → host UI. **Effort: M (client + small server thread-through).**

### A — round warning: suppress on ended rounds + explicit wording + hover tooltip
`EventPlanStrip.tsx:129-131` shows `<AlertTriangle aria-label="Used fallback ladder"/>` whenever `hasFallback` (from `GET /sessions/:id/plan`, `sessions.ts:790`, which sums `matches.fallback_used` across ALL statuses). Decisions (Ali):
- **Suppress the warning once a round has ENDED/completed** — only show it on the active/current round(s). (Don't badge done rounds.)
- **Explicit, host-readable wording + a real hover tooltip** giving the exact reason (replace the cryptic "used fallback ladder"). Expose the per-round fallback reason from the plan endpoint (the `match_reason` `fallback_l1…l4` / `repeat_in_event` data exists but isn't surfaced) so the tooltip can say e.g. "2 pairs had already met — no fresh pairing was possible this round."
**Effort: M (plan endpoint reason + client warning gating/tooltip).**

### B — remove the rating-window timer (no visible countdown)
Decision (Ali): the rating form shows **no countdown** — the user fills the form(s) at their own pace and returns to the main room. Root cause of the old flicker = three colliding `timer:sync` streams (session-level scaled timer + per-user `rating:window_open` + leftover breakout timer) plus the client's 12s breakout-ownership drop.
- **Client `RatingPrompt.tsx`:** remove the timer display entirely; stop consuming rating `timer:sync`/`durationSeconds` for any countdown. User flow unchanged otherwise (rate → next form → return to lobby on done).
- **Server `round-lifecycle.ts`:** the round still advances via the EXISTING all-rated early-close (`checkAllRatingsCompleteByUserId` → `endRatingWindow`, `participant-flow.ts:1059-1104`). Replace the visible scaled 30/60s segment timer with a **generous, non-broadcasting safety-net timeout** (e.g. fixed ~180s, plain `setTimeout`, no `timer:sync`) that fires `endRatingWindow` only if stragglers never finish. Drop the per-user `rating:window_open.durationSeconds` countdown.
- Net: no rating countdown shown, no flicker, round still advances (all-rated early-close + hidden backstop). **Effort: M.**

## Live-test-2 fixes (26 May, post-event — root causes confirmed)

**#3 policy persistence — DONE (`beda546`, on main):** create/update session zod config schema omitted `matchingPolicy`; zod stripped it → sessions saved `within_event`. Added the enum to both schemas. Engine #1 now receives `platform_wide`.

**#4 stuck-at-rating after last round — ROOT CAUSE:** `checkAllRatingsCompleteByUserId` (`participant-flow.ts:1097-1103`) computes `expectedRatings = Σ pCount*(pCount-1)` assuming EVERY participant rates EVERY partner. It does NOT subtract **skips** (`activeSession.ratingSkips`), **leavers** (not present), or **re-match duplicate matches** (round had extra completed matches from the churn). So `totalRatings < expectedRatings` forever → early-close never fires → event sits on the (B-change) **180s silent backstop**. Rounds 1-2 had clean full ratings → fired; round 3's re-match churn inflated `expectedRatings` → stuck. No host escape hatch.
- **Fix:** (a) make the early-close robust — a participant counts as "done" when they've **rated OR skipped** each partner of their *current* (latest, non-superseded) match, and only count **present** participants; close when all done. (b) Add a **host force-advance**: allow the host to end the rating window / start the next round / end the event from `ROUND_RATING` (don't block on pending ratings). (c) Lower the silent backstop from 180s (e.g. 90s) since the real close is the all-rated/host path. Server-side; TDD.

**#2 double-rating — ROOT CAUSE:** the client `rating:window_open` handler (`useSessionSocket.ts:542`) sets `phase='rating'` and shows the form **unconditionally** — no check whether the user already rated/skipped that match. A re-emit during re-match churn re-prompts; server correctly `409`s but the user sees "rate again."
- **Fix:** client tracks matches it has already rated/skipped (a set keyed by matchId, e.g. in the store); on `rating:window_open` for an already-handled match, skip straight to lobby/next instead of re-showing the form. Server `409` stays as backstop. Verify by build + Playwright.

**#67% recap meet-again-rate — ROOT CAUSE:** `getPeopleMet` returns `connections` **per-match** (`theirMeetAgain` = partner's vote for THAT match, `rating.service.ts:351`, kept per-match by design for the round breakdown). My #3 client calc dedups by userId keeping the **last** row — so Saif's r3 re-match with 85e59ae1 (not re-rated → `theirMeetAgain=false`) overwrote the r2 `true` → 2/3 = 67%, even though `encounter_history.mutual=true` for all 3.
- **Fix:** in `SessionComplete.tsx`, when computing `meetAgainRate`, **aggregate `theirMeetAgain` per user (OR across that user's connection rows)** — a person counts if they said meet-again in ANY of their encounters this event — rather than last-wins. Denominator = unique people met. (Optionally source from `mutualConnections`/aggregate.) Verify by build + Playwright + the known data (should be 100% for Saif).

**#1 host breakout-timer flicker — INVESTIGATE-THEN-FIX:** host dashboard shows a "shared" manual-breakout timer (`HostRoundDashboard.tsx:311`, `manualSharedEndsAt`) only when all rooms share `endsAt`; per-room `timer:sync` goes to participants, not the host. Flicker (59→110→56) likely = the dashboard recomputing from changing per-room `endsAt` across coalesced `emitHostDashboard` refreshes, or a per-room tick fed by multiple rooms. Confirm the exact mechanism (the `manualSharedEndsAt` derivation + the 1s `remainingSeconds` tick + dashboard refresh cadence) before fixing; then drive the host timer from a single stable source with one steady tick. Lowest severity (cosmetic, host-only).

## Fix order (tight timeline)

1. **#4** wording (S, certain, no risk) — first.
2. **#3** meet-again-rate (S, client, clear formula) — second.
3. **#1** platform-wide hard exclusion (M, headline) + **#2/#9** fresh-first selection (M–L) — related, do together in the matching engine.
4. **#5** mutual DM gate + button visibility (M).
5. **#7** bg-crash disposal (M) — last, since it needs Ali's browser verification.
6. **#6** deferred. **#8** QA checklist handed to Ali.

## Testing

- Matching (#1/#2): unit tests in `server/src/__tests__/services/matching/` — platform_wide hard-excludes prior-event pairs; fresh-first selection prefers never-met when a complete fresh matching exists; fallback only when impossible.
- #3: client calc unit-reasoned (no client test runner) + manual recap check (0/4=0%, 2/4=50%).
- #5: server test for `canMessage()` mutual gate + forward-only grandfathering.
- #7: browser verification (Ali) across room transitions.

## Risk / rollout

Server matching + DM changes go via staging→main (RSN flow). #1/#2 change live matching behavior — verify on a test event before relying on it. #7 client change needs browser sign-off before trust. No DB migration required (uses existing `encounter_history` / `mutual_meet_again`).
