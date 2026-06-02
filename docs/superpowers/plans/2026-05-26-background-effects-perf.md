# Background Effects — perf rebuild so BG works like Meet/Zoom (no hang, low memory)

**Date:** 2026-05-26 (event: next 13:00 UTC)
**Driver:** Stefan — "BG must be there and work very fine." Current BG hangs weak laptops / eats browser memory.
**Decisions (Ali, interview):** auto-degrade then auto-off · capture 540p · keep ALL three effects (blur + presets + custom upload), all must work flawlessly · ship to prod today once verified · BG must persist main→breakout→main until explicitly removed.

## Root cause (evidenced from code + installed lib)
1. **Camera captures 1280×720 @ 30fps** (`Lobby.tsx:1533`, `VideoRoom.tsx:772`) → full-frame WebGL gaussian blur (**radius 25**) on every one of 30 frames/sec.
2. **Processor `maxFps` defaults to 30** — no cap (deprecated `BackgroundBlur(25)` passes no processor options).
3. **MediaPipe WASM + model fetched from public CDN at runtime** (jsdelivr + storage.googleapis.com) → slow/hanging init behind weak networks/firewalls; 500 users hammer the CDN at event start. (Existing code has 8s "hangs forever" timeout band-aids pointing right at this.)
4. **Preset images are remote Unsplash w=1280 URLs** — another runtime fetch × 500 users.
5. **Deprecated API rebuilds the whole pipeline on every toggle** (no `switchTo`) → MediaPipe re-init churn + memory.
6. Logic **duplicated** across `Lobby.tsx` and `VideoRoom.tsx` → divergence + double bug surface.

What Meet/Zoom do (and we'll now match): same MediaPipe Selfie Segmentation model, but run at **reduced fps**, **self-hosted assets**, **downscaled work**, and **graceful degradation** so the tab never freezes. LiveKit 0.7.2 already exposes every lever (`maxFps`, `segmenterOptions`, self-host `assetPaths`, `onFrameProcessed` stats, `supportsModernBackgroundProcessors()`, modern `BackgroundProcessor` + `switchTo`).

## Plan

### Tier 1 — kill the hang (core)
- Capture **960×540 @ 30fps** in both Lobby + VideoRoom.
- Processor **`maxFps: 15`**, **blur radius 10**.
- Use modern **`BackgroundProcessor({ mode, ... })` + `switchTo()`** (no rebuild on toggle).
- **Capability gate**: only offer BG when `BACKGROUND_EFFECTS_ENABLED && supportsModernBackgroundProcessors()`.
- **Auto-degrade → auto-off** via `onFrameProcessed`: rolling avg `processingTimeMs`; sustained > 45ms ⇒ rebuild at maxFps 10; still > 70ms ⇒ stopProcessor + "your device couldn't keep up" notice. One-shot transitions, no thrash.
- **Persist across rooms + refresh**: keep the Issue-10 re-apply-on-camera-publish; switch storage sessionStorage→localStorage so blur/preset survive a refresh too (custom blob falls back to off on hard reload — blob lifetime). Explicit "Off" clears it.

### Tier 2 — reliability at 500 users
- **Self-host** MediaPipe WASM (copy `@mediapipe/tasks-vision@0.10.14/wasm` → `client/public/mediapipe/wasm/` via `scripts/copy-mediapipe.mjs`, hooked into `dev`+`build`; gitignored) + commit `selfie_segmenter.tflite` model + commit 960×540 preset images under `client/public/backgrounds/`.
- **HEAD-probe** `/mediapipe/wasm/...` once at capability time → use self-hosted if present, else fall back to CDN. Safe if the build copy is ever missing.

### Architecture (de-dupe)
- NEW `client/src/lib/backgroundEffects.ts` — constants, `isBackgroundSupported()`, `loadBgProcessors()`, `BG_PRESETS`, `applyBackgroundEffect()`, `evaluateFrameHealth()` (pure, tested) + `createFrameHealthMonitor()`.
- NEW `client/src/hooks/useBackgroundEffects.ts` — owns mode/supported/degraded state, re-apply-on-publish, destroy-on-unmount, `apply()`.
- NEW `client/src/features/live/BackgroundPanel.tsx` — shared panel (presets + blur + upload + degraded notice).
- `bgPreference.ts` — persistence only (localStorage), keep `BgPreference` type.
- `featureFlags.ts` — `BACKGROUND_EFFECTS_ENABLED = true` (kill-switch).
- Lobby + VideoRoom consume the hook + panel; capture → 540p.
- **Close PR #7** (hide-BG) — superseded by this fix.

## Tests (TDD)
- `evaluateFrameHealth` pure unit: ok / reduce / disable ladders incl. one-shot guards.
- Source-pins: capture 540 (not 720) in both files; processor passes `maxFps`+`assetPaths`+modern API; blur radius 10; `BACKGROUND_EFFECTS_ENABLED = true`; capability gate present; persistence via localStorage.
- Build: `tsc -b` clean; `vite build` produces `dist/mediapipe/wasm/*` + model + backgrounds.
- Browser smoke (Playwright, fake camera) if feasible: apply blur → frame stats fire → switch preset → toggle off.

## Ship
staging → CI → ff main → prod; verify Vercel bundle hash changed + `/mediapipe/...` 200 on prod. Well before the event window.

## Cross-AI review reconciliation (Gemini, verified against v0.7.2 source)
- **Worker?** v0.7.2 runs the segmentation render loop on the **main thread** (`ProcessorWrapper.ts` RAF loop; explicit "could be offloaded to a webworker… challenging" comment). Confirmed Gemini's main-thread-jank risk. Mitigation = cheap-per-frame + degrade-off; worker fork deferred.
- **Frame queue/memory balloon?** No — it's a pull-based RAF loop grabbing the latest frame and skipping when behind (`hasNewFrame && timeSinceLastFrame >= minFrameInterval`). Drop-frame is built in; Gemini's queue-crash risk does not apply here.
- **COOP/COEP / SharedArrayBuffer multithread:** deliberately NOT enabling — would force CORP/CORS on every cross-origin resource (LiveKit/Sentry/embeds) and risks breaking the app the day of a 500-person event. Single-threaded WASM-SIMD + WebGL GPU delegate (Meet's effective web path) is enough.
- **ADD: `webglcontextlost` handler** — weak GPUs drop the WebGL context under memory pressure (black bg). Listen → stopProcessor + degraded notice → raw camera.

## Out of scope / deferred (fast-follow, not event-day)
- Worker/OffscreenCanvas segmentation offload (fork LiveKit processor) — true main-thread isolation.
- Sub-frame-resolution mask + bilateral upscale shader (fork) — Meet's deepest optimization.
- WebRTC `RTCRtpSender` outbound-fps secondary degrade trigger — robust but fragile getStats coupling.
- CPU-delegate fallback rung for weak Intel iGPUs before full disable.
- Replacing MediaPipe — unnecessary (same model as Meet).
