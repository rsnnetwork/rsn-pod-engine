# 27 May Live-Test — Verified Bug Triage

**Date:** 2026-05-28
**Source:** `assets/27th May - review .pdf` (two debriefs: 11 "main glitches" + 14 follow-up observations)
**Method:** Read-only code audit of the current working tree (`C:\Users\ARFA TECH\Desktop\RSN`), 6 parallel subsystem investigations. Every status below is backed by `file:line` evidence read directly from source (NOT git history — this tree's `.git` points at an unrelated repo, so blame/log were not used).

**Status legend:**
- **Confirmed** — reproducible from the code; root cause identified.
- **Likely** — code strongly supports it; final confirmation needs a runtime repro.
- **Runtime-only** — plausible but not provable from static read alone.

---

## TL;DR — the one systemic root cause

The debrief's own conclusion ("client synchronization is failing", "back to square one") is **confirmed by the code**. The single biggest issue:

> **Presence and room-membership are authoritative in per-process in-memory JS Maps, mutated by multiple unsynchronized timers/reconcilers, while matching trusts the DB roster (not live presence), and the client rebuilds its participant list from incremental deltas.**

This one architecture explains the entire "Cluster A" family (bounced rooms, count flips, different realities, ghosts, matched-with-absent, alone-in-room, waiting-forever). The other clusters (timer, roles, video layout, pin↔mute, chat, leave, rating) are **independent, mostly self-contained bugs** — several are one-line fixes.

**Two highest-leverage one-line client fixes** (do these first, lowest risk, visible impact):
1. Chat name click ejects user from event → `<a href>` should be a router `<Link>` (`ChatPanel.tsx:248`).
2. Group-room rating shows only one person → pass `data.partners` to `setMatch` in the `match:reassigned` handler (`useSessionSocket.ts:393`).

---

## Architecture baseline (load-bearing for Cluster A)

- Presence/membership live in **in-process JS Maps on a single Node instance**: `activeSessions`, `presenceMap`, `roomParticipants`, `participantStates`, `disconnectTimeouts`, `sessionLocks` — `server/src/services/orchestration/state/session-state.ts:66-72`, `:13-50`.
- Redis is **write-through cache only** (`session-state.ts:121,133-161`). A Socket.IO Redis adapter is wired (`server/src/index.ts:358-363`) but only fans out broadcasts; it does **not** share the Maps across instances.
- `withSessionGuard` (`session-state.ts:80-94`) is a per-process promise lock — it does **not** serialize the `setTimeout` callbacks that move people between rooms.
- Render runs single instance (`render.yaml:18`, no `numInstances`), so multi-instance divergence is a *latent* risk, not the 27 May cause.

---

## Cluster A — State sync / presence / rooms (THE systemic cluster)

### A1. Users bounced in/out of rooms repeatedly — **Confirmed**
- **Root cause:** Multiple uncoordinated timers race to mutate the same user's match — the 15s disconnect-reassign, the 5s leave-conversation reassign, the stale-heartbeat→LEFT path, and the 30s reconciler — each firing `match:reassigned`/`return_to_lobby` from independent `setTimeout`s with **no per-user lock** (these timer bodies are NOT inside `withSessionGuard`).
- **Evidence:** `participant-flow.ts:1295` (`setTimeout(...15000)`), `:1085` (`setTimeout(...5000)`), `participant-state-machine.ts:382-396` (reconciler escalates to LEFT), `participant-flow.ts:1516` (stale heartbeat → repair). Reassign INSERT only catches conflict at the DB (`:1393-1401`); the losing timer still emits a stale event to the client.
- **Fix:** Route every membership-mutating timer body through `withSessionGuard` and re-validate presence + match state inside the lock before emitting.

### A2. Participant count flips 8 → 12 → 13 — **Confirmed**
- **Root cause:** Three different counters from three different sources, shown in different places, that never agree: client `ParticipantList` counts join/left **deltas** (`ParticipantList.tsx:46`, `sessionStore.ts:288-293`); the snapshot reports `connected` via `io.fetchSockets()` + `registered`/`active` from DB (`session-state-snapshot.service.ts:120-175`); REST `getActiveSessionState` returns `presenceMap.size` (`orchestration.service.ts:364`). The server *does* emit an authoritative `participant:count` (`participant-flow.ts:315-316`) but the client **ignores its value** (`useSessionSocket.ts:137` is a no-op).
- **Fix:** Pick one authoritative count (snapshot `participantCounts`), render it everywhere, stop deriving counts from deltas.

### A3. Different users saw different realities (pins/rooms vs empty) — **Confirmed**
- **Root cause:** The participant list is built from **incremental** `participant:joined`/`participant:left` deltas; a full snapshot only arrives on join, reconnect, and the 30s periodic resync. Any missed delta diverges that client until the next 30s tick. Host `rooms` array is rebuilt per-client from `presenceMap.has()` (per-instance/stale).
- **Evidence:** `useSessionSocket.ts:129-136` (delta handlers), `:139` (snapshot only on join), `:728-756` (30s `PERIODIC_RESYNC_MS`); `participant-flow.ts:378-385` (per-client room rebuild).
- **Fix:** Make joined/left carry-or-trigger a fresh authoritative snapshot, or shorten resync and treat the snapshot as the only source for the list.

### A4. 25 registered, only ~13 visible (ghosts / stuck waiting) — **Confirmed**
- **Root cause:** `connectedParticipants` is socket-room presence only; users whose WS never fully upgraded, or who are stuck `DISCONNECTED`, are filtered out of the host view. **Transport mismatch:** client requests `transports: ['websocket','polling']` (`socket.ts:14`) while the server pins `['websocket']` only (`index.ts:79`) — clients that fall back to polling silently fail to connect, registering in the DB but never appearing in presence. Stale-DISCONNECTED users are only escalated after 90s.
- **Evidence:** `session-state-snapshot.service.ts:120-127`; `host-participants-view.ts:145`; transport mismatch `socket.ts:14` vs `index.ts:79`; reconciler delay `participant-state-machine.ts:365-396`.
- **Fix:** Align client/server transports (or re-enable polling server-side); surface registered-but-disconnected users explicitly instead of dropping them.

### A5. Regression — "every time it just gets different" — **Likely** (structural)
- **Root cause:** State spread across 6 in-memory Maps + DB projection + Redis cache + client deltas, mutated from ~24 call sites; each fix adds another reconciler/timeout/guard that interacts with the others, so behaviour shifts run-to-run.
- **Evidence:** layered patches in one flow — `participant-flow.ts:261-304` (Fix A), `:1291-1306` (FIX 3C), `:1494-1521` (FIX 5E); reconciler `participant-state-machine.ts:316-419`.
- **Fix:** Make one store (Redis) authoritative for presence + membership and delete the parallel in-memory Maps + ad-hoc timers. (This is the canonical room-state redesign — see "Strategic" below.)

### A6. Background change kicks user out of the event — **Likely (client-side)**
- **Root cause:** No server path removes a user on background change (no LiveKit webhook receiver exists). The plausible mechanism is client-side: `setProcessor` failing/crashing the camera-track subtree → an error boundary unmounts the live page → `useSessionSocket` unmount cleanup unconditionally emits `session:leave` → server marks the user `LEFT`.
- **Evidence:** BG handler touches only the camera track (`Lobby.tsx:469-484`); unmount cleanup `useSessionSocket.ts:787-808` emits `session:leave`; `handleLeaveSession` sets `LEFT` (`participant-flow.ts:585,598`).
- **Fix:** Wrap the processor swap so a failure can't crash/unmount the page; don't treat an unmount during an active session as a permanent `LEFT` (use the disconnect-grace path instead).

---

## Cluster A-matching — Matching engine

**Core finding:** Matching eligibility is sourced from `session_participants` **DB status, NOT live presence**. A user who accepts an invite gets `status = 'registered'` and stays there until they open a socket. Both the matching query and the eligibility guard treat `registered` as eligible, and the in-memory `presenceMap` intersection was **deliberately removed** ("DB is single source of truth"). So a registered-but-absent user is fully matchable. The pairing algorithm itself (`matching.engine.ts`) is sound.

### M1. Matched with users not actually present — **Confirmed**
- **Evidence:** `matching.service.ts:205` & `:221` — `WHERE sp.session_id = $1 AND sp.status IN ('in_lobby','checked_in','registered')`; `:230-234` confirms the presence filter was removed.
- **Fix:** Intersect the eligible set with `activeSession.presenceMap` (heartbeat-fresh) before matching, as the pre-plan path still does at `:123`.

### M2. Late joiners thrown straight into meetings — **Likely**
- **Root cause:** On join during `ROUND_ACTIVE` the late joiner is set `IN_LOBBY` and triggers future-round repair, but there is **no grace/readiness gate** before they become eligible for the next confirmed round.
- **Evidence:** `participant-flow.ts:240-250`; `matching.service.ts:785` (`repairFutureRounds`).
- **Fix:** Require `presence:room_joined` or a "ready" ack before a participant counts as eligible.

### M3. Absent users still appear in assignments — **Confirmed** (same root as M1)
- **Evidence:** persisted at `matching.service.ts:874`; emitted `round-lifecycle.ts:362` (`match:assigned`). Host pre-check counts `registered` too (`:480`,`:492`), so the host's count looks fine while bodies are absent.

### M4. Alone in room / "waiting for partner" never clears — **Confirmed**
- **Root cause:** A match where the partner is absent still goes active; the partner's LiveKit track never arrives, and the "Waiting for partner…" tile only clears when a remote video track appears — nothing else resets it.
- **Evidence:** `VideoRoom.tsx:307-309` (`isWaiting` when `remoteTracks.length===0`, `:188`); no-show path keys off `presenceMap.has()` (`round-lifecycle.ts:1023-1060`, timer `:423`).
- **Fix:** Add a per-match "both parties joined LiveKit within N seconds, else abort/reassign" check, and emit a state that clears the waiting overlay.

### M5. Matched with someone who exists but isn't in the room — **Confirmed** (client manifestation of M1/M3)
- **Root cause:** No post-assignment validation that both parties actually joined the room.
- **Evidence:** `round-lifecycle.ts:197-442` (`transitionToRound`) activates matches + issues tokens with zero presence check; `match-validator.service.ts` only checks DB conflicts.
- **Fix:** Insert a presence/room-join gate in `transitionToRound` before marking a match `active`.

---

## Cluster B — Timer / round lifecycle

**Architecture:** The timer **is** server-authoritative (server emits `timer:sync` every 2s with an authoritative `endsAt`; clients recompute `Math.ceil((endsAt - now)/1000)` rather than decrement). The classic "each client drifts on its own clock" failure is **refuted** for normal rounds. The real fragility is **sync-starvation**.

### B1. Timers frozen / out of sync (27s vs 6s) — **Likely**
- **Root cause:** The displayed value depends on the client's 1s tick interval (started only on `session:round_started`, `timer:sync`, resume) plus continued receipt of `timer:sync`. If either lapses — missed events, an interval never re-armed, or the sync guard dropping events — that client freezes while others keep moving. Manual breakout sync omits `endsAt` and runs only every 5s, so those rooms self-correct slower.
- **Evidence:** `timer-manager.ts:87-118` (2s sync w/ `endsAt`); `sessionStore.ts:315-330` (`tickTimer` recompute, freezes when `!timerEndsAt`); `host-actions.ts:2255` & `breakout-bulk.ts:498` (manual sync, no `endsAt`); sync guard `useSessionSocket.ts:646-648`.
- **Fix:** Have the periodic sync re-arm the client tick if absent (or run an unconditional local 1s recompute from `timerEndsAt`); always include `endsAt` in manual-room syncs.

### B2. Rounds end abruptly — no countdown, sound, or warning — **Confirmed**
- **Root cause:** Round end is a single server `setTimeout` whose callback flips state and emits only `session:round_ended`; there is **no pre-end warning event, no end chime, no transition notice** — the client jumps straight to rating.
- **Evidence:** `round-lifecycle.ts:418-420` (timeout → `endRound`), `:470-484` (emits only `session:round_ended`/`status_changed`); no warning event exists server-side; client `useSessionSocket.ts:290-302` immediately `setPhase('rating')`. No round-end audio anywhere (only a mic-meter `AudioContext` in `Lobby.tsx:767`).
- **Fix:** Emit a server `timer:warning` (T-30s/T-10s) the client renders as visible countdown + sound; add a brief "round ending" transition before the rating swap.

### B3. "Final stretch" shows but transition never happens — **Confirmed**
- **Root cause:** "Final stretch" is not a lifecycle state — it's a static placeholder shown while the timer is hidden until a threshold; if the timer froze (B1), `timerSeconds` never crosses the reveal threshold so the label sticks.
- **Evidence:** `VideoRoom.tsx:701-705` (placeholder text), `:694-700` (visibility gated on `timerSeconds`); `sessionStore.ts:322` (freezes if `timerEndsAt` null/stale).
- **Fix:** Drive visibility from a server warning event (decouple from possibly-frozen `timerSeconds`); fix B1.

---

## Cluster C — Roles / host / co-host

### C1. Cannot make a co-host before the event starts — **Confirmed** (present-but-broken + missing pre-event surface)
- **Root cause:** Co-host assignment has two client entry points with inconsistent gating, and the **discoverable** one (Host Control Center) is hard-gated to appear only *after* the event starts. The server handler works fine pre-event.
  - Control Center button rendered only when `sessionStarted` (`HostControls.tsx:929`), and `sessionStarted = sessionStatus !== 'scheduled' || ... || currentRound > 0` (`:55`) → unreachable while `scheduled`.
  - The only pre-event control is a hover-only Shield icon in `ParticipantList.tsx:80`, restricted to `isOriginalHost` (`:17`) — so a super_admin/admin who isn't the host has no pre-event co-host button at all.
  - Server `handleAssignCohost` (`host-actions.ts:1461-1521`, `:1482` upsert into `session_cohosts`) has **no session-status check** — the write works pre-event.
- **Secondary inconsistency:** matching reads co-hosts from `session_participants.role='co_host'` (`matching.service.ts:817-818`) while assignment writes `session_cohosts` and never sets that column — co-host exclusion from matching reads a different table than where co-hosts are written.
- **Fix:** Remove the `sessionStarted` gate on the Control Center (or render it while `scheduled`) and/or surface a co-host control on the pre-event `SessionDetailPage`; broaden the `ParticipantList` button from `isOriginalHost` to `canActAsHost`; unify the co-host source of truth.

---

## Cluster D — Video layout (LobbyMosaic, main room)

> Note: the 3 density modes live in `LobbyMosaic` (`Lobby.tsx:67-77`), i.e. the **main room** — `VideoRoom.tsx` is the 1:1/trio breakout and has no density modes.

### D1. All three modes behave badly — **Confirmed** (shared cause with D2/D3)
### D2. Spacious clips people / can't scroll to all 13 — **Confirmed**
- **Root cause:** Spacious caps the grid at `max-w-2xl` with only `grid-cols-1 sm:grid-cols-2`, each tile fixed `aspect-video`; 13 tiles make a very tall column. The intended scroll container (`Lobby.tsx:958` `overflow-auto`) is defeated by a `flex-1 ... overflow-hidden` ancestor chain, so rows past the fold are clipped with no inner scroll.
- **Evidence:** `Lobby.tsx:69-70,77,119` (mode classes + `aspect-video`), `:973` (`flex-1 w-full max-w-4xl`, no `min-h-0`/`overflow-y-auto`); `LiveSessionPage.tsx:228,230` (`flex-1 flex overflow-hidden`).
- **Fix:** Give the grid wrapper `overflow-y-auto min-h-0` and remove the `flex-1` height trap so it scrolls independently.

### D3. Wasted space / tiny boxes, no scaling — **Confirmed**
- **Root cause:** Fixed `max-w-*` caps + hardcoded column counts + fixed `aspect-video` tiles; no `clamp`/`auto-fit`/`minmax`, so tiles stay small inside a narrow centred column on wide screens.
- **Evidence:** `Lobby.tsx:67-75,77,119`.
- **Fix:** `grid-template-columns: repeat(auto-fit, minmax(clamp(...),1fr))` filling available width/height.

---

## Cluster E — Audio / mute / pinning

### E5. Pinning a participant force-mutes them (PRIORITY) — **Confirmed**
- **Root cause:** Pinning swaps `LobbyMosaic` between two structurally different JSX trees, which **unmounts and remounts** the local tile's `LobbyMediaControls`, re-firing its mount effect that force-mutes non-host participants. The mount guard `appliedRef = useRef(false)` resets per instance.
- **Evidence:** `Lobby.tsx:198-216` (pinned branch) vs `:219-233` (grid branch) — different element trees; `:150` (controls rendered inside local tile); `:261` (`appliedRef` per-instance); `:279-285` (auto-mute on mount: `setMicrophoneEnabled(false)` + a 500ms double-apply).
- **Fix:** Hoist `pinnedSid` and `LobbyMediaControls` out of the per-tile render so the instance is stable across pin/grid layouts; gate auto-mute on a per-session/SID store flag, not a per-mount ref.

### E6. Auto-mute unstable — unmute reverts — **Confirmed**
- **Root cause:** Same remount-driven auto-mute as E5, plus the 500ms delayed `setMicrophoneEnabled(false)` that fires after the user may have already toggled the mic on.
- **Evidence:** `Lobby.tsx:283-285`, `:261-264`.
- **Fix:** Auto-mute exactly once per LiveKit room join keyed on SID; drop the 500ms re-apply.

### E4. Echo / "is my mic working?" — **Likely (echo) / Confirmed (mic-status ambiguity)**
- **Root cause:** No `audioCaptureDefaults`/`echoCancellation` is ever set (relies on LiveKit defaults). In the lobby only the host publishes audio (`audio={isHost}`), so a non-host who thinks they unmuted is not publishing in the main room. Echo most plausibly from multiple tabs/devices per user.
- **Evidence:** grep for `echoCancellation|audioCaptureDefaults` → no matches; `Lobby.tsx:972` (`audio={isHost}`); multi-tab eviction banner `LiveSessionPage.tsx:170`.
- **Fix:** Pass explicit `audioCaptureDefaults:{echoCancellation:true,noiseSuppression:true}`; surface a real publish/level indicator.

---

## Cluster F — Chat UX

### F2. Clicking a name in chat ejects user from the event (CRITICAL) — **Confirmed**
- **Root cause:** Each chat author name is a plain `<a href>` with no `target`, so clicking triggers a **full-page browser navigation** to `/profile/:id`, tearing down the React app — unmounting `LiveSessionPage`, disconnecting Socket.IO + LiveKit.
- **Evidence:** `ChatPanel.tsx:248` — `<a href={`/profile/${msg.userId}`} ...>`. (Pasted URLs at `:315` at least use `target="_blank"`; only the name link does the in-tab eject.)
- **Fix (one-line):** Replace the `<a href>` with a React-Router `<Link>` (client-side nav) or open profile in a modal/new tab.

### F1. Chat hard to find on mobile / hidden on desktop — **Confirmed**
- **Root cause:** Desktop renders chat as a fixed 320px right-side panel; mobile only via a small floating bubble that is itself conditionally hidden, and opening the panel hides the session content.
- **Evidence:** `LiveSessionPage.tsx:245-249` (desktop `sm:w-80`; content `hidden sm:flex` when chat open), `:259-273` (mobile floating toggle, shown only `!chatOpen && phase!=='complete'`).
- **Fix:** Promote chat to a persistent, labelled tab/icon in the top bar on all breakpoints.

---

## Cluster G — Leave / navigation

### G3. Two indistinguishable "Leave" actions → accidental full exits — **Confirmed**
- **Root cause:** Inside a breakout room, "Main Room" (leave breakout) and "Leave" (leave event) sit adjacent, both gray text, both using the identical `ArrowLeft` icon.
- **Evidence:** `VideoRoom.tsx:662-672` ("Main Room" → `participant:leave_conversation`) vs `:673-685` ("Leave" → `session:leave` + `window.location.href='/sessions'`). Confirm dialogs differ only in wording.
- **Fix:** Give "Leave event" a distinct destructive style (red, `LogOut` icon) and separate it spatially from the breakout-return action.

### G4. Navigation too complicated — **Confirmed** (3-4 leave paths)
- **Evidence:** top-bar "Leave" (`LiveSessionPage.tsx:132-137`, `handleLeave` `:88-98`, phase-dependent message) + the two `VideoRoom` buttons + auto-return on partner-leave (`VideoRoom.tsx:484`).
- **Fix:** Consolidate to one "Leave event" + one "Back to main room"; unify wording/placement across phases.

---

## Cluster H — Rating

### H6. Group (trio) rooms offer only ONE rating target — **Confirmed**
- **Root cause:** The client `match:reassigned` handler (used for manual/host-created group "Rooms") **ignores the `partners[]` array** the server sends and calls `setMatch` with only the single primary partner, so `currentPartners` stays `[]` and `RatingPrompt` rates just one person. (The algorithm-round path via `match:assigned` is correct.)
- **Evidence:** `useSessionSocket.ts:393` (`setMatch({ userId: data.newPartnerId,... }, data.matchId)` — no 3rd `partners` arg; default `[]` at `sessionStore.ts:294`); server *does* send partners (`breakout-bulk.ts:298-312`); `RatingPrompt.tsx:157` falls back to one target. Correct path: `match:assigned` handler `useSessionSocket.ts:364-365` + `round-lifecycle.ts:358-366`.
- **Fix (one-line):** In the `match:reassigned` handler, pass `data.partners` as the 3rd arg to `setMatch`, mirroring `match:assigned`.

### H5. Rating flow unclear / data-skew worry — **Confirmed**
- **Root cause:** Rating is skippable (good) but never labelled optional and offers no "session was broken / not applicable" path; the server accepts ratings regardless of session health.
- **Evidence:** `RatingPrompt.tsx:96` (prominent "Submit") vs `:100-102` (faint "Skip"); `rating.service.ts:64` (`RATABLE` includes `active`/`no_show`/`reassigned`).
- **Fix:** Make optionality explicit; add a "Skip — session didn't work" reason; tag short/no-show matches so analytics can exclude them.

---

## Recommended fix order

**Tier 0 — one-line, high-visibility, near-zero risk (ship immediately):**
1. F2 — chat name `<a>` → `<Link>` (`ChatPanel.tsx:248`).
2. H6 — pass `data.partners` to `setMatch` in `match:reassigned` (`useSessionSocket.ts:393`).

**Tier 1 — isolated, self-contained fixes (high impact, bounded blast radius):**
3. E5/E6 — stabilise pin/grid so `LobbyMediaControls` doesn't remount; auto-mute once per SID, drop 500ms re-apply.
4. A4 transport mismatch — align client/server Socket.IO transports (`socket.ts:14` ↔ `index.ts:79`). (Likely a big chunk of "ghost" users.)
5. B2/B3 — emit a pre-end `timer:warning` + countdown/sound; decouple "final stretch" reveal from `timerSeconds`.
6. C1 — ungate co-host control pre-event; broaden to `canActAsHost`.
7. D2/D3 — fix LobbyMosaic scroll container + responsive grid.
8. G3/G4 — distinct destructive style for "Leave event"; consolidate leave paths.
9. E4 — explicit `echoCancellation`/`noiseSuppression`; real mic-publish indicator.
10. H5 — rating optional labelling + broken-session reason + analytics tagging.

**Tier 2 — the systemic core (the debrief's real message; biggest effort):**
11. M1/M3/M5 — gate matching eligibility on live presence + add a both-parties-joined validation before a match goes `active`.
12. A1/A2/A3/A5/A6 — make one store (Redis) authoritative for presence + membership; serialise ALL mutations (including timer callbacks) through it; derive every count/list from that one source; stop ejecting on transient unmount.

Tier 2 is "systems engineering territory" as the debrief put it — it lines up with the canonical Redis-authoritative room-state redesign already on the roadmap. Tiers 0-1 are quick credibility wins that make the next live test dramatically less chaotic without waiting for the big refactor.

---

## Out of scope / not investigated here
- Actual runtime reproduction (this is a static audit; B1 and A6 are marked "Likely" pending a live repro).
- LiveKit server/SFU config and network conditions (echo could be partly environmental).
- The DB migration work needed for the Tier-2 Redis-authoritative redesign (separate plan).
