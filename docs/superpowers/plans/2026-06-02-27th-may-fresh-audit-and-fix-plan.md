# 27 May Live-Test — Fresh Independent Audit + Fix Plan

**Date:** 2026-06-02
**Auditor:** Read-only whole-codebase audit of `origin/main` @ `c91c662` (the deployed/stable branch), in an isolated worktree. 6 parallel subsystem investigations, every status backed by `file:line` read from the current code (NOT from the older 2026-05-28 triage, which was a static read of the stale `Desktop\RSN` tree).
**Source of bugs:** `assets/27th May - review .pdf` (11 "main glitches" + 14 follow-up observations) + 3 Stefan screenshots (2026-06-02).
**Directive:** Fix everything *properly and systemically — not patches*. No imminent live test.

---

## 0. The headline — two findings that govern everything

### Finding 1 (BLOCKER): `main` HEAD contains a large snapshot REGRESSION
Commit **`9a457c3` "Add complete RSN workspace snapshot"** (merged into `main` today via PR #8 `fortheetaboss`, now HEAD) is **350 files, +12,522 / −30,217 lines**. It overwrote most of `client/src` with an older snapshot:
- **Deleted:** `client/src/hooks/useBackgroundEffects.ts` (−260), `client/src/features/live/BackgroundPanel.tsx` (−80), `client/src/lib/featureFlags.ts`, `client/src/features/live/useVisibilityPartition.ts` (−70).
- **Reverted to older/smaller versions:** `Lobby.tsx` (−763), `LiveSessionPage.tsx` (−~400), `HostControlCenter.tsx` (−~400), `HostControls.tsx`, `MessagesPage.tsx` (−~600), `RecapPage.tsx`, `SessionComplete.tsx`, `ParticipantList.tsx`, `RatingPrompt.tsx`, `ChatPanel.tsx`, and more.
- The crash-proof background rebuild (`371005d`, `2fc7ad1`, `ebebfc8`, `d97e1dd`, `b257744`, May 27) is effectively **reverted** in HEAD. BG is default-ON again with no degrade ladder and no unmount-safe processor disposal.
- The server-side state-management fix `823444f` (2026-06-02) **survived** — its signatures (`serverNow`, `scheduleParticipantListBroadcast`, `withMatchGenerationLock`) are present in HEAD's server + `useSessionSocket.ts`/`sessionStore.ts`.

**Implication:** `main` is a hybrid — newest server state work on top of reverted client code. Any client-side fix written against current `main` risks (a) being thrown away if the snapshot is later reverted, or (b) re-deleting work that someone intended to keep. **This must be resolved before any client work begins.** It is also the most plausible mechanical cause of the debrief's #12 "back to square one" regression.

### Finding 2: the systemic state-sync root cause is REAL and only PARTIALLY fixed
The debrief's own conclusion ("client synchronization is failing", "every time it just gets different") is confirmed by the code. The single biggest issue:

> **Presence + room membership are authoritative in per-process in-memory JS Maps, mutated by multiple unsynchronized timers/reconcilers; the per-session lock does NOT cover the timer/interval/reconciler bodies that do the most damaging mutations; matching eligibility trusts DB status (not live presence); and the client still derives its headline count from incremental deltas.**

`823444f` made genuine progress (server-authoritative timer clock-offset, a debounced authoritative participant-list broadcast, a match-generation lock, snapshot dedup, + new load/churn tests) but **left the architecture untouched**: Redis is still a write-through cache, the volatile state (`presenceMap`, `roomParticipants`, `participantStates`) is never persisted to Redis, and the destructive async paths still run outside any lock. **The systemic redesign is still required.**

---

## 1. Status of every reported issue

Legend: ✅ Fixed · 🟡 Partially fixed · ❌ Still open · 🔁 Regressed by the snapshot

### Cluster A — State sync / presence / rooms (THE systemic cluster)
| ID | Symptom (27 May) | Status | Root cause in current code |
|----|------------------|--------|----------------------------|
| A1 | Users bounced in/out of rooms | ❌ | `handleDisconnect` (`participant-flow.ts:1305`), the disconnect-reassign `setTimeout` body (`:1364`), `handleLeaveConversation`'s reassign timer (`:1153`), and the stale-heartbeat `setInterval` (`:1570`) all mutate presence/membership **outside `withSessionGuard`**. Multiple writers, no per-user lock → bounce. `823444f` did not wrap these. |
| A2 | Count flips 8→12→13 | 🟡 | Authoritative `participantCounts` exists in the snapshot (`session-state-snapshot.service.ts:284`) and `participant:count` is emitted, but the client **ignores it** (`useSessionSocket.ts:137` is a no-op) and renders `participants.length` (`Lobby.tsx:671`, `ParticipantList.tsx:46`). `823444f`'s debounced list broadcast helps convergence but the headline count is still derived from array length. |
| A3 | Different users saw different realities | 🟡 | Lobby list now has an authoritative convergence path (debounced broadcast + 30s `applyFullState`). But **room/breakout composition** (`roundDashboard.rooms`, pins) is still delta-only with no periodic authoritative snapshot, and `roomParticipants` is not in Redis. Miss one `host:room_status_update` → stay wrong until next dashboard emit. |
| A4 | 25 registered, ~13 visible (ghosts) | 🟡 | **Transport mismatch confirmed:** client allows `['websocket','polling']` (`client/src/lib/socket.ts:14`); server pins `['websocket']` only (`server/src/index.ts:79,99`). A client behind a WS-blocking proxy falls back to polling, which the server refuses → registered in DB, never in `fetchSockets()` = ghost. Snapshot dedup fixed double-count, not missing-user. |
| A5 | Regression — "every time it gets different" | ❌ | Non-determinism from N unsynchronized writers over `await` boundaries on shared mutable Maps; all in-process state lost on redeploy (Maps not persisted to Redis). `823444f` added a *second* lock + more reconcilers — more async writers, not fewer. (Compounded by Finding 1.) |

### Cluster A-matching — Matching engine
| ID | Symptom | Status | Root cause |
|----|---------|--------|-----------|
| M1 | Matched with users not present | ❌ | Eligibility is pure DB status; the live-presence intersection was **deliberately removed** (`matching.service.ts:471-475` comment; `:205`,`:221`,`:480`,`:492`). A `registered` user who never connected is fully matchable. |
| M2 | Late joiners thrown into meetings | ❌ | No readiness handshake. `presence:room_joined` exists (`participant-flow.ts:747`) but is used only for chat routing + host badge, never as a precondition to assign/activate a match. |
| M3 | Absent users still in assignments | ❌ | Same as M1, **plus** co-host source-of-truth mismatch: assignment writes `session_cohosts` (`host-actions.ts:1489`) but `repairFutureRounds` reads `session_participants.role='co_host'` (`matching.service.ts:817`), a column nothing writes → co-hosts not excluded on repair. |
| M4 | Alone in room / "waiting for partner" | ❌ | Matches flip to `active` + timer with **zero both-present check** (`round-lifecycle.ts:280-292`,`:423`). Only correction is a single `detectNoShows` `setTimeout` (`:428`) keyed off the racy in-process `presenceMap`. |
| M5 | Matched w/ someone not in the room | ❌ | Client manifestation of M1/M3; no post-assignment both-joined validation. `match-validator.service.ts` checks assignment integrity, never presence. |

### Cluster B — Timer / round lifecycle
| ID | Symptom | Status | Root cause |
|----|---------|--------|-----------|
| B1 | Timers frozen / 27s vs 6s | ✅ | Now server-authoritative: `timer:sync` every 2s with absolute `endsAt` + `serverNow` clock-offset; client recomputes (not decrements) and re-arms on every sync + 30s REST resync. `823444f` added the `serverNow` anchor (`timer-manager.ts:123`). **Residual:** tick only re-arms on inbound events, so a fully-suspended tab can still freeze until the next delivered event. |
| B2 | Ended with no countdown/sound/warning | ❌ | `endRound` (`round-lifecycle.ts:453-489`) emits only `session:round_ended`. No `timer:warning` event anywhere; **no client audio infrastructure at all** (no `new Audio`). Screen jumps straight to rating. |
| B3 | "Final stretch" sticks, no transition | ❌ | "Final stretch" is not a lifecycle state — it's a static placeholder string (`VideoRoom.tsx:704`) gated entirely on `timerSeconds`. If the tick lapses, the label sticks. No `FINAL_STRETCH` in the `SessionStatus` enum. |

### Cluster C — Roles / host / co-host
| ID | Symptom | Status | Root cause |
|----|---------|--------|-----------|
| C1 | Can't make co-host before event starts | 🟡 | Server is fixed (`handleAssignCohost` has no status gate, authorizes via `canActAsHost`). **Client gaps:** the discoverable Host Control Center opener is gated `{sessionStarted && ...}` (`HostControls.tsx:929`, `sessionStarted` false while `scheduled`); the only pre-event control is a hover-only icon restricted to `isOriginalHost` (`ParticipantList.tsx:80`) — a super_admin/admin-acting-as-host has no pre-event co-host button. Plus the M3 source-of-truth mismatch. |

### Cluster D — Video layout
| ID | Symptom | Status | Root cause |
|----|---------|--------|-----------|
| D1 | Compact/normal/spacious all bad | ❌🔁 | Three hardcoded `grid-cols` ladders keyed off count, wrapped in `max-w-5xl/4xl/2xl` caps (`Lobby.tsx:66-77`), fixed `aspect-video` tiles (`:119`). No `auto-fit`/`minmax`, no viewport scaling. (Lobby is the older snapshot version.) |
| D2 | Spacious clips people, can't scroll | ❌🔁 | Grid has no inner scroll container; ancestor chain `LiveSessionPage.tsx:228/230` (`flex-1 overflow-hidden`) → `Lobby.tsx:967` `LiveKitRoom flex-1` (no `min-h-0`) → grid (no `overflow-y-auto`). Rows past the fold are clipped. Spacious caps at 2 cols inside `max-w-2xl`. |
| D3 | Wasted space, tiny boxes | ❌🔁 | `max-w-*` caps + fixed `aspect-video`; on 1280px+ the grid pins to ~672px centered with huge margins. Contrast `VideoRoom.tsx` which correctly uses `flex-1 min-h-0 h-full`. |

### Cluster Background
| ID | Symptom | Status | Root cause |
|----|---------|--------|-----------|
| BG1 | Background change kicks user out; blur partial | ❌🔁 | The crash-proof rebuild was **reverted by the `9a457c3` snapshot**. Current Lobby calls `stopProcessor()`/`setProcessor()` directly (`Lobby.tsx:469-483`) with no `processorRef`, no unmount disposal; a MediaPipe/WASM failure propagates to `SectionErrorBoundary` (`LiveSessionPage.tsx:231`) which unmounts the Lobby + LiveKit subtree → user perceives a kick. No degrade ladder, default-on. |

### Cluster E — Audio / mute / pinning
| ID | Symptom | Status | Root cause |
|----|---------|--------|-----------|
| E4 | Echo / can't hear / "is my mic working" | ❌ | `echoCancellation`/`noiseSuppression`/`audioCaptureDefaults` **never set** (LiveKit defaults only). **Critically:** lobby uses `<LiveKitRoom audio={isHost}>` (`Lobby.tsx:972`) — only the host publishes audio in the main room, so a non-host who "unmutes" is not actually heard. This is Stefan's "could not hear anything at all." |
| E5 | Pinning force-mutes (PRIORITY) | ❌ | Pinning swaps between two structurally different JSX trees (`Lobby.tsx:198-216` flex vs `:219-233` grid), unmounting/remounting the local `LobbyMediaControls`; its mount effect (`:262-295`) force-mutes non-hosts, guarded only by a per-instance `useRef` (`:261`) that resets on remount. |
| E6 | Auto-mute unstable, unmute reverts | ❌ | Same remount re-arm, plus a 500ms delayed `setMicrophoneEnabled(false)` (`:283-285`) that fires after the user toggles on. Multiple async writers on mic state. "Logged out to re-enable mic" in Stefan's screenshot = users escaping this by leaving entirely. |

### Cluster F — Chat
| ID | Symptom | Status | Root cause |
|----|---------|--------|-----------|
| F2 | Clicking a name in chat removes user (CRITICAL) | ❌ | Author name is a plain `<a href="/profile/:id">` (`ChatPanel.tsx:248`) → full-page navigation under `BrowserRouter` tears down the React app → Socket.IO disconnect → `handleDisconnect` (`participant-flow.ts:1305`) clears presence, sets `DISCONNECTED`, emits `participant:left`, triggers reassignment. (Pasted URLs use `target=_blank` and are safe.) |
| F1 | Chat hard to find mobile / hidden desktop | 🟡 | Mobile FAB + unread badge + safe-area now exist. Still open: opening chat on mobile **hides** session content (`LiveSessionPage.tsx:230` `hidden sm:flex`); desktop chat is a fixed side panel mutually exclusive with the participant list. |

### Cluster G — Leave / navigation
| ID | Symptom | Status | Root cause |
|----|---------|--------|-----------|
| G3 | Two indistinguishable Leave actions | ❌ | "Main Room" (leave breakout) and "Leave" (leave event) sit adjacent (`VideoRoom.tsx:660-686`), both gray at rest, **both `<ArrowLeft>`**; color differs only on hover. A `confirm()` was added but the visual confusion remains. |
| G4 | Navigation too complicated | ❌ | 5 distinct exit/return surfaces; during a breakout a non-host sees two full-event-exit buttons (top-bar `LiveSessionPage.tsx:132` + in-room `VideoRoom.tsx:673`) using two different mechanisms (`navigate` vs `window.location.href`). |

### Cluster H — Rating
| ID | Symptom | Status | Root cause |
|----|---------|--------|-----------|
| H5 | Rating unclear / data-skew worry | ❌ | No "session didn't work" option, no "optional" framing (`RatingPrompt.tsx:100` bare Skip). Server accepts ratings for `no_show`/`reassigned`/short matches (`rating.service.ts:64`) with **no exclusion tag**; `getSessionRatingStats` (`:542`) aggregates all of them — the worry is well-founded. |
| H6 | Trio room offers only ONE rating | 🟡 | All primary paths send/consume `partners[]` correctly **except** the `match:reassigned` handler, which calls `setMatch({...}, matchId)` with **no 3rd `partners` arg** (`useSessionSocket.ts:418`) → `currentPartners=[]` → rates one person. Server already sends `data.partners`. |

### Strategic (not bugs)
- Follow-up #14 (Claus): concept is strong, users stayed engaged despite chaos. The event layer **is** the product → justifies investing in the systemic fix over more patches.

---

## 2. Root causes, consolidated

Almost all 25 symptoms trace to **five** underlying causes:

1. **No single authoritative state store.** Presence/membership/rooms live in per-process JS Maps; Redis is a write-through cache; mutations happen from ~24 call sites including unguarded timers/intervals/reconcilers. → A1, A2, A3, A4, A5, M4, frozen-thumbnails, "different realities".
2. **Matching trusts DB status, not live presence; no both-joined activation gate.** → M1, M2, M3, M4, M5, "waiting for partner".
3. **The snapshot regression (`9a457c3`).** → BG1, D1/D2/D3 (reverted), latent re-breakage of prior client fixes (#12).
4. **Client component instability + wrong audio policy.** Pin swaps remount media controls; `audio={isHost}` mutes the room. → E4, E5, E6, "could not hear", "logged out to re-enable mic".
5. **Missing lifecycle/UX affordances.** No warning event/chime, no real final-stretch state, no rating-quality tagging, indistinguishable leave actions, full-page chat links. → B2, B3, H5, H6, G3, G4, F2, F1.

---

## 3. The plan — proper fixes, sequenced

> Principle: fix causes, not symptoms. The spine is Phase 1 (one authoritative store). Genuinely-complete small fixes (not band-aids) ship alongside in Phase 0.

### Phase 0 — Decide the regression + land the correct one-liners (gating)
- **0a. Resolve `9a457c3`.** Decide WITH the team whether the snapshot revert was intentional. If not, recover the reverted client work (BG hardening, layout, HostControlCenter, etc.) by re-applying the post-snapshot commits or reverting the snapshot, so we build forward from the best client code — not an older one. **Nothing client-side should be built until this is settled.**
- **0b. Verify `main` builds/typechecks/tests green** on a clean checkout (the snapshot merge may have left it inconsistent). Gate.
- **0c. Correct, complete, low-risk fixes (not patches):**
  - F2 — chat author name `<a href>` → router `<Link>` / new-tab (`ChatPanel.tsx:248`).
  - H6 — pass `data.partners` as 3rd arg to `setMatch` in `match:reassigned` (`useSessionSocket.ts:418`); refactor `setMatch` to a single typed object so a positional arg can't be silently dropped again.
  - A4 — align Socket.IO transports on client and server (`socket.ts:14` ↔ `index.ts:79/99`). Kills a concrete ghost source.
  - M3b/C1c — unify co-host source of truth: `repairFutureRounds` (`matching.service.ts:817`) and the plan-auth read (`sessions.ts:583`) use `getAllHostIds` (reads `session_cohosts`) instead of the never-written `session_participants.role='co_host'`.

### Phase 1 — The systemic core: one authoritative event state (the real fix)
This is "systems engineering territory" and closes A1–A5, M1–M5, and the screenshot symptoms.
1. **Make Redis authoritative** for presence, room membership, room composition, and participant state (hashes/sets per session). In-memory Maps become a read cache rebuilt from Redis on boot. Persist `roomParticipants`/`participantStates` (today they survive nothing — a redeploy mid-event resets reality).
2. **Serialize ALL membership mutations** behind a single per-user lock implemented as a Redis lease (Redlock-style `SET NX`). `transitionParticipant` acquires the lease itself so no caller — handler, `setTimeout`, `setInterval`, reconciler — can mutate without it. Removes the race/interleaving that makes behaviour "different every time."
3. **Clients become pure projections.** Extend the authoritative snapshot + `applyFullState` to include room composition and counts; reconcile on every transition + a short cadence. Display server `participantCounts`, never `participants.length`. "Waiting" state self-heals from the snapshot even if an event is missed.
4. **Presence-gated matching + two-phase activation.** Eligibility = DB-status-eligible ∩ Redis-fresh-presence (TTL ≈ 2× heartbeat). A match is emitted `pending`; both parties must `presence:room_joined` within N seconds, else abort + reassign with an explicit `match:reassigning` (clears the waiting overlay). Closes M1/M2/M4/M5 and the dead-room window.
5. **Deterministic test harness + load/churn gates.** Build on `823444f`'s `load-25-users`/`load-churn` e2e; add a deterministic event-engine unit harness (fake timers, scripted joins/leaves/disconnects) asserting identical end state across runs. This directly attacks the "insufficient automated testing / regression" root cause and makes #12 not recur.

### Phase 2 — Audio + video integrity (high user-visible)
- **E4 audio policy:** set explicit `audioCaptureDefaults: { echoCancellation, noiseSuppression, autoGainControl }` on both `LiveKitRoom`s; fix the main-room publish policy so non-hosts are actually heard (replace `audio={isHost}`), or deliberately disable+grey the mic for non-hosts if silence is intended. This is the "could not hear anything."
- **E5/E6 pin↔mute:** hoist `LobbyMediaControls` (and `pinnedSid`) out of `renderTile` so the local tile instance is stable across pin/grid; enlarge the pinned tile via CSS (`row/col-span`) in one grid rather than swapping flex↔grid trees. Move auto-mute "apply once" to a SID-keyed store flag; delete the 500ms re-apply.
- **Frozen thumbnails:** investigate LiveKit track resubscription on state desync (Stefan: "thumbnails of people who did appear were frozen") — likely resolved largely by Phase 1 + a track-resubscribe on reconnect.

### Phase 3 — Layout + background (after Phase 0a settled)
- **D1/D2/D3:** one CSS-grid `repeat(auto-fit, minmax(<density-floor>, 1fr))`; density picks only the tile-size floor (≈140/220/320px), not column count; drop `max-w-*` caps; make the grid the scroll owner (`flex-1 min-h-0 overflow-y-auto`) and add `min-h-0` up the flex chain; `aspect-video` as a max, not a hard ratio. Verify at 360/390/414/768/1024/1280px.
- **BG1:** restore the rebuilt subsystem (`featureFlags.ts` default-off, persist-across-rooms processor, degrade→disable ladder, prewarm); wrap every `setProcessor`/`stopProcessor` so failure only resets the BG button (never throws into render); dispose the processor in a real unmount cleanup in both Lobby and VideoRoom.

### Phase 4 — Lifecycle UX
- **B2:** emit `timer:warning {atSeconds}` at T-30/T-10 from the timer loop (deduped); client shows a "wrapping up" banner + a short preloaded chime (respect a mute setting).
- **B3:** drive "final stretch" visibility from authoritative `timerEndsAt` (always present) not the display counter; fall back + resync if `endsAt` passed with no transition. Consider a real `ROUND_ENDING_SOON` state tied to B2.
- **H5:** add an explicit "We couldn't connect / it didn't work" choice posting a structured reason; add `excluded_from_quality_stats` (or `rating_kind`) to `ratings`, set it for no_show/cancelled/short/"didn't work", filter it from `getSessionRatingStats` + recap. Label the form optional.

### Phase 5 — Roles + navigation
- **C1:** make co-host management a first-class pre-event surface (render the Control Center / a "Manage co-hosts" panel whenever `isHost`, not only after start); broaden the `ParticipantList` toggle from `isOriginalHost` to `isHost` and make it always-visible (touch-friendly).
- **G3/G4:** one canonical "Leave Event" (top bar), destructive styling + `LogOut` icon; within a breakout expose only a non-destructive "Back to Main Room"; remove the duplicate in-room Leave-event button; standardize on `navigate` (drop `window.location.href`).
- **F1:** mobile chat as an overlay/bottom-sheet above the video (don't `hidden` the content); desktop chat a collapsible dock that coexists with the participant list.

---

## 4. Suggested order of execution
Phase 0 (decision + one-liners) → **Phase 1 (the systemic core)** → Phase 2 (audio/video) → Phase 3 (layout/BG) → Phase 4 (lifecycle UX) → Phase 5 (roles/nav). Phases 2–5 can parallelize across people once Phase 0a is settled and Phase 1's authoritative snapshot API exists.

## 5. Open decisions for the team
1. **`9a457c3` snapshot:** intentional, or an accidental wholesale revert to recover from? (Gates all client work.)
2. **Lobby audio:** are non-hosts meant to speak in the main room? (Determines the E4 publish-policy fix.)
3. **Redis-authoritative scope now vs incremental:** full Phase 1 in one branch, or land it subsystem-by-subsystem behind the new snapshot API.

## 6. Out of scope / not done here
- Runtime reproduction (static audit; B1-residual and frozen-thumbnails need a live repro to fully confirm).
- LiveKit SFU/network config (echo may be partly environmental).
- The DB migration detail for the Redis-authoritative store + the `ratings` quality column (separate implementation specs once Phase 0a is decided).
