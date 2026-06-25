# Matching Engine — Phase 2 report (for Ali)

_Built and shipped overnight 2026-06-25. Read this first when you wake._

## TL;DR
Phase 2 of the matching engine is **built, tested, and live on prod** as one ship.
Everything is additive and backward compatible — a member with no new data is matched
exactly as before, and the live event flow is unchanged except for one small,
**members-only** check-in (the host never sees it). Full server test suite green
(2353 tests, 0 failures). Two real bugs were caught by headed testing and fixed +
re-shipped before you woke.

## What Phase 2 added (6 items)
1. **Richer match storage** — every match now stores which template produced it +
   a 0–1 **confidence** score (migration 071). Foundation for the analytics + future learning.
2. **Admin matching analytics** — new "Matching" tab in `/admin/analytics`:
   per-template performance, fallback rate, average confidence, and a breakdown of
   why pairs were made. (Extends the existing analytics; nothing rebuilt.)
3. **Per-event check-in (members only)** — an optional, skippable popup when a member
   enters a live event ("what brings you here today?" + how open to surprises). Feeds a
   per-event overlay on top of their onboarding profile. The host never sees it.
4. **Incomplete-profile scoring tiers** — thin profiles get safer matching (sparse-data
   signals are dampened); rich profiles are scored exactly as before.
5. **Structured designation + want/avoid categories** — onboarding now captures a clean
   designation bucket (founder/investor/…) and desired/avoid designations, instead of
   guessing from free-text. Fixes fuzzy misses (e.g. "recruiters" vs "recruiting").
6. **Cooldown matching policy** — a 4th policy: rematch blocked within N months
   (default 12), allowed-but-deprioritised after. `platform_wide` / `within_event` /
   `none` are untouched.

**No hard exclusion was weakened.** Avoid stays soft. Onboarding data drives matching.

## Migration 071 (applied on prod, verified)
- `matches` += `matching_template_id`, `confidence`, `is_override`
- `session_participants` += `event_intention`, `openness`

## Shipped commits (main, auto-deployed to Render + Vercel)
- `c6955e0` feat(matching): phase 2 — per-event intent, profile tiers, cooldown, richer storage + analytics
- `e681cd1` fix(matching): accept cooldown policy + cooldownMonths in session config schema
- `e570f8b` fix(matching): check-in modal shows to members only, never the host

## Bugs caught by headed testing + fixed (before you woke)
1. **Check-in modal covered the host's controls** ("host stuck at a screen"). → Gated to
   members only (`!isHost`). Re-shipped.
2. **Cooldown policy rejected at session creation** — the engine accepted `cooldown` but
   the create-session validation didn't, so a cooldown event couldn't be made. → Added to
   the schema + a `cooldownMonths` field. Re-shipped.
3. **One pinned test deliberately updated** — `ws3-didnt-work-rating` pins the exact count
   of quality-score averages in `admin.ts`; the new analytics average (which correctly
   carries the excluded-ratings filter) made it 3→4. Updated with a note.

## Verification
- **Full server suite: 216 suites, 2353 passed, 0 failed.** Zero broken pins. All matching
  + onboarding + admin + rating suites green. Client + shared typecheck + build clean.
- **Prod deploy live + migration 071 columns confirmed** on the live DB.
- **Headed prod E2E (real browsers, 6 brand-new onboarded members + host): the whole
  in-event experience verified.**
- **Socket-driven 3-round proof: PASS — 3 distinct played rounds, zero repeats.**

### A) Headed whole-event run (real browsers)
6 brand-new accounts onboarded for real, then a real event in real browser windows:
lobby → check-in → chat → BG → matched → breakout → rate → back to main. Verified:
- **Onboarding drove the matching** — `m1 founder ↔ m2 investor` tagged `mutual_intent`,
  `designation:founder+investor`, **and `event_intent`** (M1's "meet investors" check-in
  worked); `m3↔m6` founder+investor; `m4↔m5` advisor+manager.
- **Breakout rooms assigned = 3** (one per pair). **Chat delivered** (member→member).
  **Background applied, no crash.** **Ratings recorded.** **Admin Matching analytics live.**
- Every match stored a **confidence** (0.45–0.57). Round reached `completed` cleanly.

### B) 3-round re-matching proof (the part you specifically asked for)
Driven through the real lifecycle (start_round → 60s timer → rating → transition →
start_round, which auto-generates each next round fresh). Across 3 played rounds, **every
member met three different people — zero repeats:**

| Member | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| m1 founder  | m2 | m3 | m6 |
| m2 investor | m1 | m4 | m5 |
| m3 founder  | m6 | m1 | m4 |
| m4 operator | m5 | m2 | m3 |
| m5 advisor  | m4 | m6 | m2 |
| m6 investor | m3 | m5 | m1 |

`rounds played: 3/3 | total pairs: 9 | noRepeat: true` → **3ROUND: PASS.**

### Note: a test-harness bug I fixed (not an app bug)
My first multi-round headed run showed "Round 2 = Round 1". Root cause was **in the test, not
the app**: rounds advance on a timer + `host:start_round` (which auto-generates the next round
fresh, excluding completed rounds) — but my test pre-generated every round via "Match People",
leaving rounds 2/3 as unplayed `scheduled` previews. There is no `host:end_round`; rounds end on
their timer. Once driven correctly (proof B above), no-repeat is perfect. The engine's no-repeat
is also covered by green unit tests (`repeat-reduction`, `matching-engine-v1-spec`). One earlier
run was also interrupted by a transient internet drop on this machine (hung a DB query); the
harness now has query timeouts + retries.

## How you can test it manually
1. Create 4–6 new accounts, onboard each (the chatbot now also captures a structured
   designation + who-to-meet/avoid).
2. Create a pod + a multi-round speed-networking session; register the accounts.
3. Join as members → you'll get the optional check-in popup ("what brings you here") —
   set an intent or skip. The host does NOT get this popup.
4. Run the event: Match People → Confirm → Start Round → let the round play → End Round →
   rate → next round. Pairings should reflect onboarding intent/designation, and across
   rounds people should meet new people (no repeats).
5. As an admin, open `/admin/analytics` → **Matching** tab to see template performance,
   fallback rate, confidence, and pairing reasons.
6. (Optional) Create a session with matching policy = cooldown to block recent rematches.

## Not in Phase 2 (Phase 3 — awaiting your go)
Templates admin CRUD UI, manual host pair-swap (the `is_override` column is already in
place for it), violation-based exclusion, and further edge cases. **Not started** — per
your note, we decide on Phase 3 after you review this.
