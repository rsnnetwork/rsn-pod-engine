# Phase 3 — Host Dashboard UI + Sync

**Date:** 2026-05-06
**Estimated effort:** 1–2 days
**Risk:** Medium-low. First UI work in this rebuild — needs browser-walk verification on staging in addition to type-check + tests.
**Production DB ops:** None.
**Why this phase exists:** Closes Stefan's 5th May items #6, #7 (UX feedback), #9 (UI sync), #11 (visibility), #12 (host dashboard). Phase 2.5/2.7/2.8 already emit the right server-side socket events (`host:event_plan_generated`, `host:event_plan_repaired`) — Phase 3 wires the client to consume them and adds the visibility surfaces Stefan asked for.

---

## What's already there (do not re-do)

- **Toast infrastructure** (`useToastStore`) — 223 usages across the client. We just feed it new triggers.
- **Round-dashboard payload** (`host:round_dashboard`) — server already broadcasts a full snapshot of the current round (rooms, participant states, byes). HostControls already partially renders it.
- **Match preview + bye-banner UI** (Phase 1) — already shows when bye is mathematically forced.
- **Server-emitted plan events** (Phase 2.5/2.7/2.8):
  - `host:event_plan_generated` — fires after Start Event with `roundCount + totalPairs`
  - `host:event_plan_repaired` — fires after late-joiner/leaver future-only repair with `reason + regeneratedRounds[]`

What's NOT done is **client consumption** of the two plan events + visibility for the multi-round upcoming-plan view + force-refresh discipline after host actions.

---

## Sub-phase plan

### Sub-phase 3A — Toast consumers for plan events (~2 hours)

**Files:** `client/src/hooks/useSessionSocket.ts`, `client/src/stores/sessionStore.ts`

- Wire `socket.on('host:event_plan_generated', ...)` in `useSessionSocket.ts` — fires `addToast("Event plan ready — N rounds, M pairs", "success")` via `useToastStore`. Also stores `eventPlanRoundCount + totalPairs` in `sessionStore` so the host UI can show "Plan: 5 rounds, 15 pairs" persistently.
- Wire `socket.on('host:event_plan_repaired', ...)` — fires `addToast("Plan updated for rounds X–Y (reason)", "info")` with friendly reason text:
  - `late_joiner` → "new participant joined"
  - `left` → "participant left"
  - `host_request` → "manual update"

**Tests:** grep-style pin in `phase-3-host-dashboard.test.ts`:
- `useSessionSocket.ts` registers both listeners
- Listeners call `useToastStore.addToast`

### Sub-phase 3B — Plan-visibility panel in HostControls (~4 hours)

**Files:** `client/src/features/live/HostControls.tsx`, `client/src/stores/sessionStore.ts`

Add an upcoming-rounds visibility strip above the existing match-preview block. It shows the full event timeline at a glance:

```
Round 1 ✓ done    Round 2 ▶ active    Round 3 ⊝ planned    Round 4 ⊝ planned    Round 5 ⊝ planned
```

Implementation:
- New REST endpoint `GET /api/sessions/:id/plan` returns the full plan: `[{ roundNumber, status, pairCount, byeCount }]` for every round.
- New `useQuery` hook in HostControls fetches this on mount + on `host:event_plan_generated` / `host:event_plan_repaired` events.
- Renders as a horizontal scrollable strip. Each round has:
  - Number
  - Status badge (`done`, `active`, `planned`, `cancelled`)
  - Pair count (e.g. "3 pairs") + bye count if any
- Tooltip on hover shows the actual pair list for that round (host can preview rounds 3-5 before they run)

Why this matters for Stefan #12: today, host has no idea what's coming next. With the strip, host can see "round 3 has Mike paired with Sarah, round 4 has Mike paired with Tom" and override before running.

**Server work:** add the GET endpoint to `server/src/routes/sessions.ts`. Returns aggregated counts only — no individual user data unless host requests detail (separate endpoint deferred to 3D).

**Tests:**
- Server pin: `/api/sessions/:id/plan` endpoint exists, host-only auth, returns aggregate shape
- Client pin: HostControls renders the strip with N rounds when sessionStore has `eventPlanRoundCount`

### Sub-phase 3C — Force-refresh after host actions (~3 hours)

**Files:** `client/src/features/live/HostControls.tsx`, `server/src/services/orchestration/orchestration.service.ts` (or wherever host action handlers re-emit dashboard)

Stefan #9 root: today some host actions update local UI optimistically (set state then hope server agrees). When server disagrees, UI is stale.

Pattern:
- After every host mutation (`host:generate_matches`, `host:regenerate_matches`, `host:force_match`, `host:exclude_participant`, `host:remove_participant`, `host:create_breakout`, `host:move_to_room`), the server immediately re-emits `host:round_dashboard` (or `host:match_preview` if in preview phase).
- Client consumers in `useSessionSocket.ts` always treat the emitted payload as authoritative — no optimistic merging, just `store.setRoundDashboard(payload)`.
- Audit existing handlers — most already do this correctly. Pin the ones that don't.

**Server-side audit & fix:**
- Search for `socket.emit('host:` in handlers — confirm every host action emits canonical state at the end
- Add the missing emits where found

**Tests:** new architectural pin: every `host:` mutation handler (`host-actions.ts`, `matching-flow.ts`) ends with a `host:round_dashboard` or `host:match_preview` emit before returning success.

### Sub-phase 3D — Browser walk verification on staging (~1 hour)

First UI work in this rebuild — server-only verification gate isn't enough. Manual staging walk required:

1. Open `app.rsn.network` as host, create a 6-person event.
2. Click Start Event → confirm "Event plan ready — 5 rounds, 15 pairs" toast appears. Confirm plan-visibility strip shows 5 round cards.
3. Click "Show round 1 preview" → confirm the matches show. Click Re-match → confirm at least one pair swaps.
4. Begin round 1 → run to completion → start round 2.
5. Mid-round-2, have a 7th person join the lobby → confirm "Plan updated for rounds 3–5 (new participant joined)" toast appears for the host.
6. Have someone leave mid-round-2 → confirm "Plan updated for rounds 3–5 (participant left)" toast.
7. Confirm plan-visibility strip auto-updates with new round status.
8. Click force-match between two participants → confirm UI updates immediately (no stale state).
9. Click exclude participant → confirm dashboard removes them within 1 second.
10. End event → confirm clean shutdown, recap shows correct per-user counts (Phase 1).

Sentry post-walk: zero new errors in client (rsn-client) or server (rsn-api) attributable to the walk.

---

## Verification gate

1. ☐ Server TypeScript clean
2. ☐ Server tests green (~1029 + new ~10 Phase 3 pins)
3. ☐ Client TypeScript clean
4. ☐ Client build clean
5. ☐ Architectural pin: useSessionSocket consumes `host:event_plan_generated` + `host:event_plan_repaired`
6. ☐ Architectural pin: GET /api/sessions/:id/plan endpoint exists
7. ☐ Architectural pin: HostControls renders plan-visibility strip
8. ☐ Architectural pin: every host mutation handler ends with a canonical-state emit
9. ☐ CI staging green
10. ☐ CI main green
11. ☐ Render service: status=live at the latest pushed SHA
12. ☐ Vercel: production deployment Ready
13. ☐ Sentry rsn-api (last 30 min): 0 new errors
14. ☐ Sentry rsn-client (last 30 min): 0 new errors
15. ☐ **Browser walk on staging: all 10 steps pass** (manual; first UI phase requires this)
16. ☐ progress.md updated

---

## Risks & rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Plan-visibility strip slows HostControls render with 200+ users | Low | Strip shows aggregate counts only; per-round details fetched on hover; lazy-loaded |
| GET /api/sessions/:id/plan exposes data to non-hosts | Low | Endpoint behind `authenticate` + host-or-cohost middleware (existing pattern) |
| Toast spam during rapid late-joiner bursts | Medium | Server already throttles `repairFutureRounds` to 5s/session (Phase 2.5D); each repair fires one `event_plan_repaired` event; toast naturally rate-limited |
| Force-refresh breaks an existing optimistic-UI flow that relied on it | Low | Audit identifies every existing handler before edit; preserve any intentional optimistic behaviour with comment |
| Browser walk on staging reveals an issue not caught by tests | Medium | This is exactly why we walk. Any issue → fix and re-walk. Phase declared done only when walk passes. |

**Rollback:** `git revert <SHA>` per sub-phase. Each is independent. Server endpoint addition is additive (no existing route modified).

---

## What is NOT in this phase

- Per-round pair-detail expansion (deferred to 3 polish iteration if needed)
- Manual override of an individual participant's state (e.g. "force this user to NO_SHOW") — Stefan #12 has this; queued for Phase 5 polish since the underlying state-machine already supports it
- Test-mode UX (Stefan #2) — Phase 5
- Atomic room creation server-side (Stefan #6, #7) — Phase 4
- Chat reliability fix (Stefan #8) — Phase 4
- Error-surface coverage (Stefan #14) — Phase 5

---

## What "perfect this time" means specifically for Phase 3

1. **Host always knows what's coming.** Plan-visibility strip shows the entire event timeline. No more "let's see what we get" per round — the host has full forward visibility.
2. **Toasts confirm every backend state change.** Plan generated → toast. Plan repaired → toast. Stefan's complaint #14 ("logging is there but not used for UX") closes for the matching path.
3. **No stale UI after host actions.** Every host mutation ends with a server re-emit; client always renders authoritative state. Stefan #9 closes for HostControls.
4. **Browser walk passes 10/10 steps.** First UI phase shipped under the discipline of actually clicking through it — not just CI green.
