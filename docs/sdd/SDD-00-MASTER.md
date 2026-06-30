# SDD 00 — MASTER: RSN 30–50 Scale Fix Programme

**Date:** 2026-06-13
**Baseline:** branch `june9-punchlist` @ `4717268`
**Source:** `docs/AUDIT-2026-06-12-live-30-50-readiness.md` (verified deep audit: 4 criticals, ~14 majors, ~20 mediums)
**Programme:** 39 work items across 7 clusters, each designed against the live code and then adversarially design-reviewed (symbol reality, library versions, pinned-test collisions, lock ordering, shippability).

## How to use this SDD (read first)

1. **One work item = one deploy.** Pick the next item from the ship order below, read its full spec in the cluster file, implement, test, ship, headed-smoke, `/checkhole`, then take the next. Never batch unrelated items into one deploy.
2. **The review amendments are part of the spec.** Every cluster's review verdict was *needs-changes*. Each work item's "⚠ Adversarial review — REQUIRED amendments" section overrides the original design text wherever they conflict. The blockers are summarized below — do not start those items without applying the amendment.
3. **Re-verify line numbers before editing.** This repo is actively worked by parallel sessions (commit `d2a02d4` landed *during* the design review). Cited line numbers were verified at `3cf1187`/`4717268`; treat them as anchors, not gospel — locate the named symbol/string first.
4. **Pinned tests are a contract.** Many tests in `server/src/__tests__/**` are *source-text pins* asserting code patterns (regex over file slices). Each work item lists the pins it touches; the reviewers found additional ones (in the amendments). If your change breaks a pin not listed, stop and decide deliberately: is the pin documenting intent you're changing (update it with justification) or did you break intent (fix your change)?

## The per-fix execution loop (MANDATORY — do not deviate)

Work **one work item at a time**, in the ship order below. Do **not** start the next item until Ali has signed off on the current one. For each item, run these 9 steps in order:

1. **Read** the work item's full spec in its `SDD-0x` cluster file, including the "⚠ Adversarial review — REQUIRED amendments" — apply those over the original text. Re-verify the cited line numbers against the live code (locate the named symbol first).
2. **Write the tests first.** Add every test the item lists under "Tests to add" — unit + integration in `server/src/__tests__/**` — covering the happy path **and every edge case** named in the spec. These should fail before the change exists.
3. **Implement** the change to make those tests pass. Touch only what the item scopes.
4. **Run the FULL local server test suite** (not just the new/touched files — cross-file source pins break silently otherwise). All green, including any pinned tests the item said to update.
5. **Ship** the single item: push to `staging` (CI gate), watch CI green, fast-forward `main`, push, confirm Render deploy (and for client items, confirm the `app.rsn.network` bundle hash changed).
6. **Headed Playwright E2E against prod — MANDATORY, no exceptions.** Write and run a **real headed browser** test (Chromium with a head, `headless:false`) that drives the actual prod UI at `app.rsn.network` as a real logged-in user and walks the real flow — **not** a socket-only or API-only check. (RSN's older `e2e/tests/*.spec.ts` drive socket.io + DB only; that is necessary but **not sufficient** here — a genuine browser walk is required.) Coverage bar: **every use case AND every edge case** for the item, asserting **outcomes** (DB/state/visible result), not mere element visibility — so that when Ali tests it by hand it passes ~99% of the time with no surprises. Capture screenshots at each key step. Include the **360 px mobile** viewport pass for any UI-touching item. Authenticate the browser by injecting a prod-valid token into `localStorage` (`rsn_access` / `rsn_refresh`); mint it with the **prod** `JWT_SECRET` (from `e2e/.jwt_secret` or Render env — `server/.env`'s secret does NOT match prod), via `e2e/helpers/auth.ts` `createTestUser`, and clean up created users by ID afterward. A server-side API/curl smoke MAY accompany it but never replaces the headed browser run.
7. **Run `/checkhole`** — confirm Sentry / Render / Vercel / CI / DB / Redis are clean after the deploy.
8. **STOP and hand the fix to Ali for manual verification.** Post a short note: which item shipped, the exact scenarios + edge cases to click through, what the correct outcome is for each, and the smoke evidence. Then **wait** — do not start the next item.
9. **Only after Ali confirms the fix is correct**, mark the item done and return to step 1 for the next item in the ship order.

This is the standing per-bug ship process: one fix → all automated verification (tests, edge cases, suite, smokes, checkhole) → **Ali's manual pass** → next fix. Never batch two items into one deploy. Never skip the manual sign-off gate.

## Cluster files

| File | Cluster | Items |
|---|---|---|
| `SDD-01-security-roles.md` | C1 privilege escalation + role cleanup | SEC-1..3 |
| `SDD-02-video-rendering.md` | Main-room video diet + render storms | VID-1..5 |
| `SDD-03-traffic-limiter.md` | Snapshot storm, rate limiter, fanout, recap | TRF-1..6 |
| `SDD-04-lifecycle-serialization.md` | Round-lifecycle races + locks | LCY-1..8 |
| `SDD-05-rating-presence.md` | Rating races, left-vs-removed, presence | RAT-1..7 |
| `SDD-06-join-scale.md` | Join cost, bulk breakout, timer recovery | JNS-1..5 |
| `SDD-07-platform-hardening.md` | Migrations, matcher, fencing, token hygiene | PLT-1..6 |

## Blockers found by design review (apply before implementing the item)

- **SEC-1** — the "client picker is fully pinned off" premise is partially false; verify every client surface that reads the acting-as-host state before assuming zero UI impact. The gate design itself stands. (Details in SDD-01.)
- **TRF-5** — the prescribed SessionComplete/RecapPage refactor breaks the `setBonusRoundsAdded` source pin (`may23-round3-rematch-endevent-fixes.test.ts:225`) and several stats-parity pins; preserve the pinned literals or update those pins explicitly.
- **RAT-1** — **baseline moved**: commit `d2a02d4` already shipped the eviction+token half (only `removed` is terminal; june11 pins now assert the *absence* of the `left` check — do NOT re-add it). RAT-1 is re-scoped to the remaining delta: the guarded `left` re-entry (`reEnterLeftParticipant`) so a resyncing left user is flipped to `in_lobby`/matchable instead of merely receiving a token while staying `status='left'`.
- **RAT-2** — the unified ensure-row + single-UPDATE flow regresses trio encounters (a brand-new pair must get `times_met=1` once per *match*, not per submission); apply the reviewer's corrected SQL flow.
- **RAT-6** — the strict presence gate as drafted never reaches the matching engine on the primary `handleHostGenerateMatches` path (it only touched a pre-check); the gate must filter the engine's input participant list.
- **PLT-5** — the Redis lease as drafted starves timers on a healthy single instance when the key is missing (missing key must be treated as *acquirable*, not as denial).
- **PLT-6** — the kick-evicts-all-rooms design re-opens the June-10 #4 pair-kick bug (it fights `demoteParticipantFromMatch`); apply the reviewer's ordering.

## Ship order

> Run the items **strictly top-to-bottom**, one at a time, each through the full 9-step per-fix loop above — including Ali's manual sign-off — before starting the next. **Finish all of Wave 0 (and pass the load gate) before touching Wave 1. Wave 1 is later, not now.**

**Wave 0 — P0, before any 30–50 person event (serial, one deploy each, Ali signs off between each):**
1. `SEC-1` — close the privilege escalation (server + cleanup migration)
2. `TRF-2` — userId-keyed rate limiter + webhooks mounted before it (server; unblocks honest load testing)
3. `TRF-1` — coalesced/jittered roster refetch + stamp-guarded applies (client)
4. `VID-1` — adaptiveStream + dynacast + simulcast (client)
5. `VID-2` — tile render cap + overflow (client)
6. `LCY-1` — guard normal-operation lifecycle timers
7. `LCY-2` — confirm_round under both locks + the global lock-ordering rule (document it in code; later items rely on it)
8. `LCY-3` — act-after-lock FSM re-checks + idempotent round counters
9. `LCY-4` — ROUND_ACTIVE flips only after match activation

**Gate:** extend the 20-browser load harness to 40+ browsers (cameras publishing) against a Vercel preview + prod backend; assert join-window latency, zero 429s for legitimate traffic, round transitions under churn (refresh + background-tab mix). Only then run the first 30–50 event, with `/liveloop` running during it.

**Wave 1 — P1:** RAT-2, RAT-3, RAT-4 (rating family, in that order), RAT-1, RAT-5, JNS-1, JNS-2, JNS-3, TRF-3, TRF-4, LCY-5, LCY-6, SEC-2, VID-3, VID-4, PLT-1, PLT-2.

**Wave 2 — P2:** TRF-5, TRF-6, LCY-7, LCY-8, RAT-6, RAT-7, JNS-4, JNS-5, SEC-3, VID-5, PLT-3, PLT-4, PLT-5, PLT-6.

Within a wave, order is a recommendation except where a `Depends on:` field or the notes above say otherwise. Items in different clusters are independent unless marked.

## Process ground rules (non-negotiable, from the standing project rules)

- **Workspace:** `C:\Users\ARFA TECH\Desktop\RSN-dev` (canonical clone). Never copy anything from `Desktop\RSN` (stale, contains live secrets with weaker gitignore).
- **Git identity:** `RSN Network` / `dev@rsn.network` (local repo config; never override global).
- **No AI attribution, ever:** no `Co-Authored-By: Claude`, no "Generated with", no 🤖, no Claude/Anthropic mentions in commits, PRs, tags, or any pushed text. Scan every message before committing/pushing.
- **Branch flow:** push to `staging` (CI gate only — there is no isolated staging runtime), then fast-forward `main`; Render deploys from `main`; migrations auto-run on boot. For client changes, verify the `app.rsn.network` bundle hash actually changed (same-sha staging+main pushes can dedup and skip the prod build).
- **Full test suite locally before every push** — not just touched files; cross-file source pins break silently otherwise.
- **Headed Playwright prod smoke for every change** covering edge + use cases, asserting *outcomes* (DB/state), not just visibility; for fixed-resolution UI assert `boundingBox` fits the viewport. The `/e2e`, `/checkhole`, `/shipphase`, `/liveloop` skills exist for this.
- **Migrations** (until PLT-1 hardens the runner): idempotent DDL only (`IF NOT EXISTS` / guarded UPDATEs), **no inner `BEGIN`/`COMMIT`** in the .sql file, no long-running backfills at boot. Next free number: `068`.
- **Responsive rule:** any UI change must work at 360/390/768/1024/1280; verify the live views at 360px in the headed smoke.
- **Do not break the BG engine contract:** one event-scoped camera track + pipeline republished across room moves (`bgEngine.ts`, `BgCameraPublisher.tsx`).
- **Server restarts:** never `taskkill` all node.exe — kill by PID only.

## Verification programme

1. Per work item: the item's "Tests to add" + full local suite + headed prod smoke from its acceptance criteria.
2. After Wave 0: the 40-browser load run (gate above).
3. Before the first 30–50 event: `/e2e` full pass + `/checkhole` green.
4. During the event: `/liveloop`.

## Work item index

| ID | P | Title | Spec |
|---|---|---|---|
| SEC-1 | P0 | Gate acting-as-host endpoint + getEffectiveRole hardening + cleanup migration | SDD-01 |
| SEC-2 | P1 | Remove-from-room: verifyHost parity | SDD-01 |
| SEC-3 | P2 | Reassign guard uses full getAllHostIds set | SDD-01 |
| VID-1 | P0 | adaptiveStream + dynacast + simulcast on both LiveKit rooms | SDD-02 |
| VID-2 | P0 | Lobby tile render cap + '+N more' + content-visibility | SDD-02 |
| VID-3 | P1 | Identity-stable snapshot applies in sessionStore | SDD-02 |
| VID-4 | P1 | Memoized LobbyTile + per-tile mute subscriptions | SDD-02 |
| VID-5 | P2 | ChatPanel windowing + memo + at-bottom autoscroll | SDD-02 |
| TRF-1 | P0 | Coalesce/jitter roster refetch + stamp-guard applyFullState | SDD-03 |
| TRF-2 | P0 | userId-keyed rate limiter + webhooks before limiter | SDD-03 |
| TRF-3 | P1 | Gate hccParticipants on host-side viewers | SDD-03 |
| TRF-4 | P1 | Consolidate per-join/leave fanout | SDD-03 |
| TRF-5 | P2 | Recap burst diet | SDD-03 |
| TRF-6 | P2 | Mint resync tokens only when needed | SDD-03 |
| LCY-1 | P0 | Guard normal-operation lifecycle timers | SDD-04 |
| LCY-2 | P0 | confirm_round under both locks; lock-ordering rule | SDD-04 |
| LCY-3 | P0 | Act-after-lock FSM re-checks; idempotent counters | SDD-04 |
| LCY-4 | P0 | ROUND_ACTIVE flips after match activation | SDD-04 |
| LCY-5 | P1 | Cancelled matches stay cancelled | SDD-04 |
| LCY-6 | P1 | Rating-complete check re-validates before timer re-arm | SDD-04 |
| LCY-7 | P2 | Remove zero-matches generation fallback | SDD-04 |
| LCY-8 | P2 | endRatingWindow cannot wedge the session | SDD-04 |
| RAT-1 | P1 | Resync 'left' = explicit re-entry (re-scoped; see blocker) | SDD-05 |
| RAT-2 | P1 | First-rater decision inside the encounter lock | SDD-05 |
| RAT-3 | P1 | Plumb io+sessionId through REST rating path | SDD-05 |
| RAT-4 | P1 | meeting_records inside the rating transaction | SDD-05 |
| RAT-5 | P1 | Heartbeat sweep reconciles vs live sockets | SDD-05 |
| RAT-6 | P2 | Strict presence gate at generation time | SDD-05 |
| RAT-7 | P2 | getUnratedPartners trio C-slot fix | SDD-05 |
| JNS-1 | P1 | Shrink join critical section | SDD-06 |
| JNS-2 | P1 | Bulk breakout: parallel LiveKit creation | SDD-06 |
| JNS-3 | P1 | Persist + recover all in-memory timers | SDD-06 |
| JNS-4 | P2 | Mute-all concurrency cap | SDD-06 |
| JNS-5 | P2 | Per-socket token-bucket rate limiting | SDD-06 |
| PLT-1 | P1 | Migration runner hardening | SDD-07 |
| PLT-2 | P1 | Node-budgeted exact matcher at all n | SDD-07 |
| PLT-3 | P2 | Persist timerEndsAt after arming | SDD-07 |
| PLT-4 | P2 | resolvePendingRound persists pendingRoundNumber | SDD-07 |
| PLT-5 | P2 | Deploy-overlap timer fencing (Redis lease) | SDD-07 |
| PLT-6 | P2 | LiveKit token hygiene (TTL, mute on re-mint, kick evict) | SDD-07 |
