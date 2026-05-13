# 12th May 2026 — Stefan's RSN Test Feedback (10 items)

**Source:** `assets/12th may.pdf` (in old Desktop\RSN\, content captured below)
**Test date:** 12 May 2026
**Plan date:** 13 May 2026
**Working dir:** `C:\Users\ARFA TECH\Desktop\RSN-dev\` (fresh clone after workspace recovery)
**Base:** `staging` @ `977f960` (Phase I — narrow auto-host capability to super_admin only)

## 1. Audit summary — what's already done, what's left

| # | Item                                              | Current state                                                                                                    | Remaining work                                                                                                                                |
| - | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Host/Admin separation + "Join as host" toggle     | Phase I (May 12) narrowed auto-host to super_admin only. Regular admins now join as participants.                | The **toggle** is missing. Spec wants admins/super_admin to be able to opt in/out per-event. Need a server-side acting_as_host state + UI.    |
| 2 | Multi-host display (Primary / Co-host / Invisible)| Phase G (May 11) shipped the FULL backend: enum `host_visibility_mode` (big_speaker / normal / producer / hidden), DB migration 059, service, REST, socket event, snapshot, client store. | Missing: HostControlCenter dropdown to pick mode; Lobby/VideoRoom render effects (filter hidden, side-row producer, pin big_speaker).         |
| 3 | Matching only on "Match People" press             | `host:generate_matches` runs on host press. BUT Phase 2.5B added a pre-plan path: if pre-event plan exists for round, system surfaces it instead of re-running engine.                   | Pre-plan ignores late joiners. Fix: detect stale pre-plan (eligibility ≠ planned participants) and regenerate. Or always run engine on press. |
| 4 | Late joiner on rematch                            | `getEligibleParticipants` queries DB live (Phase A1, May 10). So `host:regenerate_matches` already includes late joiners.                                                                | Verify: completed rounds preserved (already true — DELETE is scoped to pendingRoundNumber). Add invariant test.                                |
| 6 | Unified Control Center UX                         | Phase 7C.1 built HostControlCenter (chips, per-row actions). Phase B "admin sees host UI" was reverted by Phase I.                                                                       | Verify no role/UI desync remains post-Phase-I. Likely 0 code changes — invariant test only.                                                    |
| 7 | Single authoritative audio/mute state             | Today: `host:mute_all` / `host:mute_participant` are pure LiveKit relays. No server-side persistent mute state. `hostMuteCommand` is ephemeral.                                          | Add `session_participants.mute_state` column. Persist on host-mute. Sync on snapshot + reconnect. Enforce LiveKit track-publish permissions.   |
| 9 | Pairing dedup on rematch                          | `handleHostRegenerateMatches` deletes ALL matches for `pendingRoundNumber` before regen (Phase 1, May 5).                                                                                | Already done. Add invariant test.                                                                                                              |
| 10| Stats = unique people not rounds                  | `meeting_records.service` uses `COUNT(DISTINCT partner_id)` where partner_id is UUID FK to users.id. Pinned by Phase F (test invariants/items/15-16, May 11).                            | Done. Re-verify pin still passes.                                                                                                              |
| 12| Per-interaction rating dedup                      | Server `submitRating` rejects with `MATCH_ALREADY_RATED` if duplicate.                                                                                                                   | Verify UI doesn't re-prompt after kick/reassign. If it does, server should not emit `rating:window_open` for an already-rated match.            |
| 14| Meet-everyone-again safety                        | `matching.engine` builds usedPairs Set seeded from previousRounds. Pinned by Phase F (items 15/16, May 11).                                                                              | Done. Re-verify pin.                                                                                                                           |

## 2. Phased rollout

Each phase is a single `/shipphase` cycle: tests → commit → push staging → CI → fast-forward main → CI → verify Render+Vercel → smoke.

### Phase J — Invariant pins for items 9, 10, 12, 14 (verify-only)

**Goal:** prove the four "already done" items don't silently regress, and produce a written checkpoint for Stefan.

**Files (server tests only):**

- `server/src/__tests__/services/may-12/item-9-rematch-clears-round.test.ts` — pin `DELETE FROM matches WHERE session_id = $1 AND round_number = $2` (no status filter) inside `handleHostRegenerateMatches`.
- `server/src/__tests__/services/may-12/item-10-stats-distinct-partners.test.ts` — re-assert `COUNT(DISTINCT partner_id)` + partner_id is UUID; forbid `display_name` grouping.
- `server/src/__tests__/services/may-12/item-12-rating-dedup.test.ts` — pin `MATCH_ALREADY_RATED` throw in `submitRating`. Audit whether `rating:window_open` is emitted again on a re-assigned match; add prompt-side dedup if needed.
- `server/src/__tests__/services/may-12/item-14-no-repeat-pairs.test.ts` — pin `usedPairs` seeded from `previousRounds` and re-added per generation.

**Risks:** none. No production code changes.

**Exit criteria:** suite green; Stefan can re-test the four items on staging.

### Phase K — Matching on-demand + late-joiner correctness (items 3, 4)

**Goal:** matching only runs when host presses "Match People", and always reflects the live eligible-participant set, including late joiners. Pre-plan stays as a perf optimisation but is invalidated when stale.

**Server changes (matching-flow.ts):**

- In `handleHostGenerateMatches`, before the `hasPrePlan` shortcut, compare `eligible.map(p => p.userId)` against `existingPlanned.filter(scheduled).flatMap(participants)`.
- If the set differs (late joiner OR someone left), DELETE the pre-plan matches for this round and fall through to the legacy on-the-fly path.
- Log the divergence with `{ planned: [...ids], eligible: [...ids], delta: [...ids] }`.

**Tests:**

- `phase-k-matching-on-demand.test.ts` — pre-plan exists + new user joins → divergence detected → pre-plan deleted + engine re-runs. Plus: pre-plan + same participants → uses pre-plan.
- Verify: completed rounds (status='completed') are NOT touched by the DELETE.

**Risks:** minimal. The legacy on-the-fly path is well-trodden. Only adds a comparison before using pre-plan.

**Exit criteria:** Stefan starts an event with 4 users, presses Match People, then 2 late joiners arrive, presses Re-match → all 6 included; previous-round results untouched.

### Phase L — Control Center role audit (item 6)

**Goal:** after Phase B and Phase I, confirm there's no leftover place where admin sees host UI or where the participant list shows two different shapes to different roles.

**Audit only — no code changes expected. Add invariants:**

- `phase-l-control-center-role-consistency.test.ts` — for each `isHost` use site in client, assert it matches the canonical form `isOriginalHost || isCohost || isSuperAdmin`.
- Verify HostControlCenter component is guarded on the same predicate as the entry button.
- Verify all `host:*` socket events server-side accept only effective-role host/super_admin.

**If audit surfaces a desync, fix in the same phase.** Otherwise ship as pure invariants.

**Risks:** none if audit comes back clean. Small cleanup risk if a stale gate is found.

**Exit criteria:** Shradha and Stefan see the same UI for the same role on the same event.

### Phase M — "Join as host" toggle (item 1)

**Goal:** super_admin (today auto-host) and event-host can opt-out per-event ("Join as participant for this event"). Regular admins can opt-in if needed (they default to participant after Phase I).

**Schema (migration 060):**

```sql
ALTER TABLE session_participants
  ADD COLUMN acting_as_host BOOLEAN;
  -- NULL = follow role default. TRUE/FALSE = explicit override.
COMMENT ON COLUMN session_participants.acting_as_host IS
  'Phase M — per-event opt-in/opt-out for host UI. NULL means use role default.';
```

**Server:**

- `services/roles/effective-role.service.ts` — getEffectiveRole reads `acting_as_host`. If TRUE → resolves to host regardless of base role (subject to admin+ check). If FALSE → resolves to participant. If NULL → existing logic.
- New socket event `host:set_acting_as_host { sessionId, value: boolean | null }`. Handler in `host-actions.ts` requires the user to have base capability (super_admin OR admin OR event_host OR cohost); updates row; emits `permissions:updated` so the UI re-derives.
- `session-state-snapshot` includes `participants[].actingAsHost`.

**Client:**

- Lobby entry banner for eligible users: "You're joining as Host. Switch to Participant?" toggle.
- HostControlCenter: same toggle in its settings drawer for cohost-able users.
- `LiveSessionPage.isHost` already uses the effective-role-derived `isSuperAdmin || isCohost || isOriginalHost`; need to also read `actingAsHost === false` and downgrade. Equivalently: derive isHost from `session-state-snapshot.participants[me].effectiveRole` instead of from raw user.role.

**Tests:**

- `phase-m-join-as-host-toggle.test.ts` — schema + service + socket event + snapshot field + client gate.

**Risks:** medium. Touches role-resolution which has many call sites (already simplified by Phase I, so the surface is smaller than before).

**Exit criteria:** Stefan can press "Join as participant" at the lobby and be matched into a breakout room; he can flip back mid-event to take host controls.

### Phase N — Multi-host visibility UI (item 2)

**Goal:** finish what Phase G started. Host picks visibility mode per host/cohost; lobby + breakout grids honour it.

**Client:**

- `HostControlCenter.tsx` — add a "Visibility" dropdown next to each host/cohost row: big_speaker / normal / producer / hidden. Calls `socket.emit('host:set_visibility', { sessionId, userId, mode })` (already wired server-side in Phase G).
- `Lobby.tsx` — filter `hostVisibilityModes[u] === 'hidden'` out of the grid; render `producer` users in a slim side row (audio-only, not in the main mosaic); pin `big_speaker` users as the large tile when present.
- `VideoRoom.tsx` (breakout) — same visibility rules apply for hosts who joined the room (rare but possible).

**Server (already shipped in Phase G):** nothing to add.

**Tests:**

- `phase-n-multi-host-visibility-ui.test.ts` — HostControlCenter has the dropdown wired to `host:set_visibility`; Lobby applies visibility filter; pinning honors big_speaker.

**Risks:** UI-only. Mobile-responsive at 360 / 414 / 768 / 1024 needs hand-testing (per RajaSkill mobile rule).

**Exit criteria:** Stefan as super_admin can set himself "producer", be off-camera, and still see + run the event from the Control Center.

### Phase O — Authoritative audio/mute state (item 7)

**Goal:** single source of truth for mute state. Host can mute and trust the user stays muted; the user cannot unmute themselves when host-muted; on reconnect, mute state is restored.

**Schema (migration 061):**

```sql
ALTER TABLE session_participants
  ADD COLUMN host_muted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN host_muted_at TIMESTAMPTZ;
COMMENT ON COLUMN session_participants.host_muted IS
  'Phase O — TRUE if host has muted this participant. Persistent across reconnects.';
```

**Server:**

- `handleHostMuteParticipant` / `handleHostMuteAll` — UPDATE the column transactionally, then publish LiveKit mute via the existing relay.
- New REST and socket event `host:unmute_participant` (currently only mute exists in shared types — there is `muted: boolean` field but no unmute path enforcement).
- Snapshot includes `participants[].hostMuted`.
- Block self-unmute server-side: on `participant:unmute_request`, check `host_muted` first; reject if true.
- LiveKit permission integration: when host_muted = TRUE, revoke `canPublishAudio` from the participant's room token. Re-grant on host_muted = FALSE. This is the only way to enforce mute at the media layer; client-side state alone is bypassable.

**Client:**

- Mute UI shows two icons: "you muted yourself" vs "host muted you" with a tooltip explaining the difference (can't unmute the latter without host action).
- On reconnect, snapshot's `hostMuted` overrides any stale local state.

**Tests:**

- `phase-o-authoritative-mute-state.test.ts` — schema + handler persistence + snapshot + reject self-unmute + LiveKit permission round-trip.

**Risks:** higher. Touches LiveKit room token issuance. Need to test with real LiveKit (use the existing IVideoProvider mock for unit, real LiveKit on staging).

**Exit criteria:** Stefan mutes Shradha. Shradha cannot unmute herself. Shradha refreshes. Still muted. Stefan unmutes. Shradha can speak.

## 3. Cross-cutting rules (apply to every phase)

- Update `progress.md` after every phase (RSN convention; entry per phase: timestamp, files touched, decisions, verification).
- TDD: write the failing test first per phase, watch it red, then code, watch it green.
- No AI attribution in commits / PRs / progress entries.
- Mobile-responsive verify on every UI change (360 / 414 / 768 / 1024). If can't test from here, ask Stefan to spot-check on iPhone + Android.
- `/shipphase` per phase: push to staging → CI green → fast-forward main → CI green → Render+Vercel verify → smoke check.
- After each phase, run `/checkhole` to confirm Sentry quiet + Render healthy + DB connections OK before declaring done.

## 4. Order of operations (recommended)

1. **Phase J** — fastest, builds confidence + adds pins. Half a day.
2. **Phase K** — fixes a real bug Stefan can observe. Half a day.
3. **Phase L** — should be near-zero code, fast confidence check. Quarter-day.
4. **Phase N** — UI work on top of done backend. One day (mobile testing).
5. **Phase M** — touches role resolution; medium. One day.
6. **Phase O** — audio + LiveKit permission integration. Highest risk, do last. 1–2 days.

Total estimate: 4–5 days work spread across phases, each independently shippable.

## 5. What's deliberately NOT in this plan

- Item 5, 8, 11, 13 — not in the 12 May PDF (it's numbered with gaps).
- Anything labelled "Phase 2 (Redis state)" or "Phase 3 (state machine)" forward-architecture work — those are larger initiatives, not Stefan-feedback items.
- Re-test orchestration: this plan ships fixes; the live test rerun is Stefan's call after each phase lands on staging.
