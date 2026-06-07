# Background (BG) Architectural Fix + Event Reliability Programme

**Date:** 2026-06-07 · **Status:** awaiting approval · **Workspace:** RSN-p2 (main @ dfce2a5)

## 1. The problem, with measured evidence (prod, 2026-06-07)

Measured via headed Playwright on prod (`e2e/tests/bg-latency-measure.spec.ts`):

| # | Measurement | Value |
|---|---|---|
| M1 | First apply, cold pipeline (click → visible) | **8.8s** (attach 3.5s) on a fast desktop; on run 1 it **exceeded the 8s `bg_timeout`** — pref never saved, UI showed nothing, yet the processor attached anyway 8.2s later |
| M2 | Preset switch with live pipeline (`switchTo`) | **244–409ms** |
| M3 | None → Blur (current destroy → full MediaPipe rebuild) | **821ms** + 294ms/frame warmup spike |
| M4 | Steady-state per-frame cost (GPU) | **4–9ms** (cheap once built) |
| — | Library frame leak on rebuild | `VideoFrame was garbage collected without being closed` |

### Root causes (code-confirmed)

1. **Per-room pipeline rebuild.** Main room and breakout are separate `<LiveKitRoom>`s
   (`Lobby.tsx:1585`, `VideoRoom.tsx:616`). `useBackgroundEffects` destroys the processor on
   unmount and rebuilds it from scratch (WASM graph + GPU delegate + model) on every
   main↔breakout transition, camera toggle, and None→re-enable. Cold build = 3.5–8s+ and a
   ~300ms/frame warmup spike that janks the tab.
2. **Timeout abandons a live attach.** `useBackgroundEffects.ts:143` wraps `setProcessor` in an
   8s race. On slow devices the attach loses the race → catch swallows it → pref unsaved,
   `processorRef` stays null, **but the processor still attaches**. Result: an orphaned pipeline
   the app doesn't track; the next apply builds a SECOND one. This is the reported
   "takes 20 seconds / didn't change / browser heavy".
3. **`segmentForVideo` runs on the main thread** ("tens to ~100ms" per the library's own source,
   `@livekit/track-processors` 0.7.2 = latest; no worker option exists). Mitigation must be:
   build once, adaptive fps, never rebuild mid-event.
4. **Persistence is re-apply-based**, so every room hop re-pays #1 and shows raw camera until
   the rebuild lands.

## 2. The fix — Zoom model: one camera track + one processor per EVENT

New module `client/src/lib/bgEngine.ts` — an **event-scoped singleton** owning the entire
camera/BG lifecycle. `Lobby` and `VideoRoom` stop owning tracks and processors entirely.

### Architecture

```
event join                       room transitions
─────────                        ────────────────
createLocalVideoTrack(540p)      LiveKitRoom video={false}
  └─ if saved pref ≠ none:       on connect:  publishTrack(engine.track)
     attach processor BEFORE     on leave:    unpublishTrack(stop=false)
     first publish               → track + pipeline NEVER stop between rooms
```

- **ONE `LocalVideoTrack` + ONE `BackgroundProcessorWrapper` for the whole event** (created on
  event entry, destroyed on event exit/`beforeunload`). Rooms receive the already-processed
  track via `publishTrack` — remote viewers always see the composited feed; the camera light
  never flickers between rooms.
- **Apply = `switchTo`** (measured 244–409ms) for every preset change once the pipeline exists.
  "None" = `switchTo({mode:'disabled'})` → frame passthrough (near-zero cost), pipeline stays
  warm → re-enable is instant too. Full destroy only on event exit.
- **First-ever enable**: assets prewarmed at event join (already shipped); segmenter
  **pre-built when the BG panel opens** — by the time the user picks a tile (~1–2s of human
  time) init is done → perceived apply ≤1–2s even cold. Tile shows an "Applying…" state until
  the engine confirms.
- **No more timeout-abandonment.** Applies are serialized through one in-flight promise
  (latest-wins queue). A slow attach is *awaited and reconciled to its actual outcome* —
  UI state can never diverge from the real pipeline again. A 20s hard watchdog only fires for a
  genuinely hung WASM worker → rollback to raw camera + toast, pipeline disposed.
- **Adaptive quality (Zoom-style).** Device-class probe (mobile / `hardwareConcurrency` /
  `deviceMemory` / Safari-fallback path) picks initial maxFps: 15 desktop, 10 mobile/fallback.
  The existing degrade ladder (15→10→off), 250ms frame watchdog, warmup grace, and stall
  watchdog move into the engine unchanged.
- **Persistence:** localStorage pref (existing) + the structural persistence above. Custom
  uploads move from `blob:` (dies on refresh) to **IndexedDB** → uploads survive refresh like
  presets. RSN users refresh constantly mid-event — this matters.
- **UI unification:** both rooms use the shared `BackgroundPanel` with the Lobby's
  bottom-sheet-on-mobile pattern, ≥44px tap targets, active-tile highlight, "Applying…"
  progress, degraded notice. 7 options everywhere: None, Blur, Office, Nature, City, Abstract,
  + Upload — main room, breakout, manual breakout, desktop + mobile.
- **Scale:** each user pays only for their own segmentation; remote participants receive
  composited video. 100 users all using BG = zero marginal cost per viewer. No server changes
  required (tokens already grant publish per room).

### Why this hits the targets

- **1–2s apply:** warm path 0.25–0.4s; cold path absorbed into panel-open pre-build.
- **No hangs:** rebuilds (the 300ms/frame spike source) drop from ~2×/round to **once per event**;
  steady state measured 4–9ms/frame; ladder + watchdog still guard weak devices.
- **Whole-event persistence:** the processed track is the *same object* in every room — Zoom
  semantics by construction, not by re-apply.

### Risk surface (gets dedicated tests)

camera on/off (mute/unmute of the shared track), device switch, reconnect rails
(S21 roster hold, S26/S27 token re-mint → republish on remount), host mute-all (audio-only —
untouched), event leave cleanup (no ghost engine), Safari fallback path.

## 3. Priority-2: codebase reliability fixes (audited, code-verified)

Each ships as its own deploy after BG, per the per-bug process:

| # | Fix | Evidence |
|---|---|---|
| P2-1 | Zustand whole-store destructuring → selectors (5 sites in `Lobby.tsx`: 654, 1079, 1237, 1445, 1557 + sweep VideoRoom/live components). Every store change re-renders the whole lobby incl. video grid today | code-verified |
| P2-2 | `NotificationBell.tsx:77` 30s poll runs during live events → pause while in an event | code-verified |
| P2-3 | `Lobby.tsx:639` module-scope `appliedPrefsForSid` Set never pruned → clear on session reset | code-verified |
| P2-4 | Server: 5s full host-dashboard rebuild+emit during every round (`round-lifecycle.ts:482`) → emit-on-change (state hash) through the existing 1s coalescer | code-verified |
| P2-5 | Server: N+1 `getName` per match on host reconnect (`participant-flow.ts:787`) → one `ANY($1)` batch (the immediate-emit path already does this) | code-verified |
| P2-6 | `timer:sync` 2s fan-out: payload is small; leave as-is (timer correctness depends on it) — re-measure after P2-4 | measured low |

Discarded after verification: MessagesPage RAF "leak" (cleanup exists at 459/620),
`roomSyncIntervals` "leaks forever" (self-clears next tick).

## 4. Verification plan

1. **TDD:** engine unit tests (apply serialization, reconcile-to-outcome, ladder, adaptive
   profile, IndexedDB pref) + existing 2135-test suite stays green.
2. **Latency re-measure:** re-run `bg-latency-measure.spec.ts` vs the preview → must show
   warm apply <1s, transition re-attach ≈0 (no rebuild), zero `bg_timeout`.
3. **20–25 browser headed smoke (the Ali test):** 25 contexts (batched within the 8GB machine's
   ceiling), every user applies a background in the main room → breakout → back → manual room;
   outcome asserts (pref + processed-track + responsiveness probe + heap) per user; BG persists
   everywhere; no tab freeze; heap flat.
4. **Mobile:** 360/390/768px headed runs incl. bottom-sheet panel + tap targets; iOS Safari
   needs Ali's phone for the real-device pass (fallback path) — explicitly flagged.
5. Existing bg-smoke, ws2/ws3, S21/S26/S27 smokes re-run (reconnect rails touch the publish path).
6. Per-bug ship: BG engine → verify → deploy → `/checkhole` → P2 fixes one by one.

## 5. Out of scope / deferred

- Web-worker segmentation (library doesn't support it; custom pipeline = separate project).
- Server-side BG preference (cross-device persistence) — localStorage + IndexedDB covers the
  stated requirement (persists until browser closes).
- `timer:sync` cadence change (P2-6) — only if re-measurement still shows it matters.
