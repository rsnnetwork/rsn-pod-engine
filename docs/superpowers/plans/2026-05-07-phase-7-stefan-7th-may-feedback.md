# Phase 7 — Stefan's 7th May Feedback (full close-out)

**Date:** 2026-05-07
**Estimated effort:** 5–6 days, 3 sub-phases
**Risk:** Mixed. 7A is server-architectural (medium risk, well-tested patterns). 7B is client-architectural (low risk). 7C is new UI builds (low risk per build, time-cost is the variable).
**Why:** Stefan's 7th May doc identified 12 critical issues from today's test, plus a strategic critique that the system is "forgiving" when it needs to be "authoritative." Three of my prior phases had real holes that fired today (#2 disconnect ghost, #5 stat drift, #8 host in matches via pre-plan). Phase 7 closes all 12 + the strategic gap.

---

## Sub-phase 7A — Server architectural fixes (~1 day)

**Goal:** make the backend authoritative. Close the four real bugs from today plus strengthen role boundaries.

### 7A.1 — Stale-state escalation in reconciler (closes Stefan #2)

**Today's evidence:** `c43142d8` (`stefan@avivson.com`) joined event `98e109af` at 13:06:28 UTC, went DISCONNECTED, stayed DISCONNECTED for the full 10-min event, was never matched. Phase 2.7's 15s timer fires only for mid-match disconnects; stale-heartbeat at 90s only checks users currently in `presenceMap`. A user who registered → briefly connected → disconnected before any match never falls into either path.

**Fix:** extend `reconcileSessionStates` in `participant-state-machine.ts`. On every 30s tick, query session_participants where status='disconnected' AND joined_at older than 90s AND not in any active match. Transition each to LEFT via the chokepoint. Fire `maybeRepairFutureRounds(...)` once per session (throttled).

### 7A.2 — Pre-plan host/cohost exclusion (closes Stefan #8)

**Today's evidence:** event `02140b88` r1 has match `bcae06f8` with `4164c7ed` (host) + `85e59ae1`. Phase 2.5A's `generateSessionSchedule` queries participants without filtering host/cohort.

**Fix:** add `excludeUserIds?: string[]` param to `generateSessionSchedule`. In `handleHostStart`, call `getAllHostIds(...)` and pass it. Same shape as `generateSingleRound`.

### 7A.3 — Single-source mutual stats (closes Stefan #5)

**Today's potential drift:** count card uses `meeting_records.is_mutual` aggregate; connections list uses `connections.filter(c => c.mutualMeetAgain)` from a different query that joins encounter_history. Two paths can drift if encounter_history writes lag.

**Fix:** in `getPeopleMet`, derive `mutualConnections` from the `connections` array filtered by joining against `meeting_records.is_mutual=TRUE` for that session. Single source. Both the count and the list pull from the same canonical aggregate.

### 7A.4 — Atomic for every manual-room op (closes Stefan #9)

**Phase 4A made create-breakout atomic.** Phase 7 extends to:
- `handleHostMoveToRoom` — wrap in transaction
- `handleHostRemoveFromRoom` — wrap in transaction
- Per-room timer-end auto-handling — already idempotent, audit + pin

Plus: a drift detector that runs on each `host:round_dashboard` emit. Cross-checks `roomParticipants` map vs DB matches. Any room with mismatched state gets flagged in the dashboard payload (`hasDrift: boolean`) so the host UI can show a "fix" button.

### 7A.5 — Cohost role architecture (closes part of Stefan #7)

**Today's gap:** cohosts inconsistently treated as participants. The DB has `session_participants.role` and a `session_cohosts` table; eligibility queries don't all filter cohorts out.

**Fix:**
- Audit every eligibility / matching query to ensure host AND cohorts are excluded by default
- Add config flag `participate_as_attendee` per cohost (off by default, on means they CAN be matched)
- `getAllHostIds` already returns host + cohorts; ensure every matching path uses it

---

## Sub-phase 7B — Frontend safety net + click polish (~half day)

### 7B.1 — Periodic backend re-sync (closes Stefan #4)

**Today's gap:** Phase 3 force-refreshes after host actions. Server-driven state changes (round timer expires, partner leaves, reconciler corrects drift) rely on socket events the client receives. Lost socket event = stale UI.

**Fix:** in `useSessionSocket.ts`, set up a `setInterval(30_000)` that calls `fetchSessionStateSnapshot()` (already exists). If server state differs from local, server wins. Cleared on unmount.

### 7B.2 — 404-to-recovery wrapper (closes Stefan #1)

**Generic safety net.** Wrap the `/session/:id/live` route in a guard component:
1. On mount, fetch `/sessions/:id/state`. 
2. If 404: show "Reconnecting..." with retry. Backoff: 1s → 2s → 4s. After 3 retries: show "This event no longer exists." with back-to-dashboard.
3. If 200: proceed to render LiveSessionPage.
4. Re-runs on focus/visibility change (handles tab-switch case where session ended elsewhere).

### 7B.3 — Click feedback + idempotency (closes Stefan #10)

**Server side:** add a `requestId: string` field to host-action socket events. Server caches `(socketId, requestId) → result` for 30s. Duplicate requestId returns cached result, no re-fire.

**Client side:** every host-action button gets immediate disabled + spinner state on click. Buttons stay disabled until the canonical state confirms the action (server emit received). Double-clicks coalesce.

---

## Sub-phase 7C — UI new builds (~3–4 days)

### 7C.1 — Host Control Center panel (closes Stefan #3 + #11)

New `<HostControlCenter />` component. Toggle button in HostControls opens a side drawer:

**Top section — counts (live):**
- Total participants / Ready / Matched / Unmatched / Disconnected / Host / Cohorts
- Each is a tappable filter

**Per-participant rows:**
- Avatar + name + email
- Current state badge (in_lobby / in_room_X / in_matching / disconnected / left)
- Per-row actions: Force into room... / Make co-host / Kick / Reassign

**Right pane — rooms:**
- Each active room with its participants + timer
- Actions: end-room / extend-timer / merge-with-other-room

Updates via existing `host:round_dashboard` socket event. No new endpoints.

### 7C.2 — Cohost assignment UI (closes UX half of Stefan #7)

Inline in the Host Control Center per-participant row. "Make co-host" toggle. On confirm, fires `host:assign_cohost`. Cohost gets a badge in the row + a permissions tooltip on hover.

### 7C.3 — Test-mode banner v2 (closes Stefan #12)

**Heuristic upgrade in `session-state-snapshot.service.ts`:**
- Drop the username-length-≥4 gate
- Trigger if 2+ non-host participants match the host on ANY of:
  - Email-username root (any length)
  - Email domain
  - Display-name first-name token (case-insensitive)
- Plus: explicit `session.config.testMode` override still wins

**Manual host toggle:** new control in HostControls — "This is a test event" / "This is a real event." Sends `host:set_test_mode { value: boolean }` socket event. Server updates `session.config.testMode` and re-emits state.

### 7C.4 — Admin analytics dashboard (closes Stefan #6)

New routes:
- `/admin/analytics` — cross-event aggregate
- `/sessions/:id/analytics` — single-event detail (host-or-admin auth)

**Data shown:**
- Event feedback overview (per-event: avg quality, mutual rate, total ratings, dropoff)
- User satisfaction (per-user composite score: 50% avg quality + 50% meet-again rate)
- Match success rates (mutual rate / total ratings) per event, time-series last 30 days
- Re-match interest (% of meet_again=TRUE) overall + per-event
- Dropoff rate (joined → left/disconnected before round 3, OR last round had no rating)
- Most-liked users (% partners who said meet_again, min 5 meetings to qualify)
- Event quality score (composite: 40% avg satisfaction + 30% completion + 30% mutual density)
- Connection graph (force-directed: nodes = users, edges = mutual matches, weighted by frequency). Library: `react-force-graph-2d`.

**Server endpoints:** new in `routes/admin.ts`:
- `GET /admin/analytics/overview` — top-line numbers
- `GET /admin/analytics/events` — per-event scores + trends
- `GET /admin/analytics/users` — per-user satisfaction + most-liked
- `GET /admin/analytics/connections` — graph data (nodes + edges)
- `GET /admin/analytics/export/:type.csv` — CSV download

Cached on-read (60s TTL per query) — no batch job needed at current scale.

---

## Verification gate (Phase 7 done)

For each sub-phase commit:
- ☐ Server TypeScript clean
- ☐ Server tests green (current 1088 + new ~30 Phase 7 pins)
- ☐ Client TypeScript clean
- ☐ Client build clean
- ☐ CI staging green
- ☐ CI main green
- ☐ Render: live at pushed SHA
- ☐ Vercel: production Ready
- ☐ Sentry rsn-api last 30m: 0 new errors
- ☐ Sentry rsn-client last 30m: 0 new errors
- ☐ progress.md updated

For 7C (UI work):
- ☐ Manual browser walk on staging covering each new panel/page

---

## What is NOT in this phase

- Phase 5.5 (real learning loop) still deferred — needs accumulated feedback data
- Drag-drop UX in Host Control Center — Phase 8 polish
- Mobile-optimised Host Control Center — desktop only this round
- Cross-event time-series for individual users beyond 30 days — Phase 8

---

## Sequence of execution

7A → push → CI green both branches → verify → 7B → same → 7C → same.

Each sub-phase is independently shippable and reverts cleanly via git revert if any production issue surfaces.
