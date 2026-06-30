# SDD 02 — C2 main-room video diet + M9 re-render storms + chat rendering

Part of the RSN 30-50 scale fix programme. Baseline: `june9-punchlist` @ `4717268`. Read `SDD-00-MASTER.md` first for ground rules, ship order, and process.

**Review verdict for this cluster: needs-changes.** Every issue listed under a work item below is a REQUIRED amendment to that item's design — apply the issue's suggestion over the original text wherever they conflict.

## Cluster notes (designer)

SHIP ORDER: VID-1 → VID-2 (the two P0 halves of the C2 fix) → VID-3 → VID-4 (the two M9 halves) → VID-5. One deploy per item with a headed prod smoke between (per-bug ship process). All five are client-only Vercel deploys: no migrations, no env vars, no render.yaml, no server code, no client/server ordering constraints with other clusters. After each Vercel deploy verify the app.rsn.network bundle hash actually changed (same-sha staging+main pushes can dedup and skip the prod build).

AUDIT RE-VERIFICATION (rule: don't trust the audit blindly): C2 confirmed — grep for adaptiveStream/dynacast/simulcast across client/src returns zero hits; Lobby.tsx:1618-1622 and VideoRoom.tsx:662-669 set only capture defaults; LobbyMosaic renders every camera track (Lobby.tsx:623-626). One audit nuance corrected: simulcast PUBLISHING is already on by default in livekit-client 2.17.2 (default sub-layers h180/h360) — the missing pieces are the subscriber-side machinery (adaptiveStream), publisher layer-pausing (dynacast), and a render cap; the explicit videoSimulcastLayers in VID-1 pins the default rather than introduces it. M9 confirmed — applyFullState swaps 7 collection identities per apply (sessionStore.ts:608-686) and is invoked by every roster:changed REST refetch (useSessionSocket.ts:262-264) plus a 30s periodic resync (useSessionSocket.ts:1167-1169); the grid-wide muteTick is at Lobby.tsx:54-72; renderTile closure at Lobby.tsx:339. Chat finding confirmed (ChatPanel.tsx:54-56, 116-169; store cap 200 at sessionStore.ts:550-559).

LIBRARY CAPABILITIES VERIFIED against installed versions (root package-lock.json: livekit-client 2.17.2, @livekit/components-react 2.9.20, @livekit/components-core 0.12.13): RoomOptions.adaptiveStream/dynacast (options.d.ts:21,30), TrackPublishDefaults.videoSimulcastLayers/videoEncoding (room/track/options.d.ts:7,91), VideoPresets h180=320x180@160k/20fps, h360=640x360@450k/20fps, h540=960x540@800k/25fps (runtime-checked), AdaptiveStreamSettings { pixelDensity, pauseVideoInBackground (default true) }, useIsMuted(trackRef) hook (components-react dist/hooks/useIsMuted.d.ts).

BG-ENGINE CONTRACT: deliberately untouched in every item. The event-scoped track (bgEngine.ts ensureTrack/getTrack) is published per-room by BgCameraPublisher via publishTrack(track, { source: Camera }) and unpublished with stopOnUnpublish=false on room exit — room publishDefaults (VID-1) apply at the encoder layer only; capture resolution/fps and the MediaPipe pipeline are not modified (the audit's '24fps' suggestion is implemented as publishDefaults.videoEncoding.maxFramerate=24, not as a capture change). The headed bg smoke (e2e/tests/bg-smoke.spec.ts / bg-cross-device.spec.ts) re-proves persistence across main↔breakout↔manual after VID-1 — that is the rollback tripwire for dynacast.

TILE STRATEGY DECISION (one primary approach, as required): hard render cap per density×viewport + deterministic Phase-Q priority ordering + single '+N more' overflow tile + content-visibility, with adaptiveStream as the underlying subscription diet. Pagination rejected (state churn vs density toggle and reconnect-hold). Audio decision: ALL audio always subscribed at any N — RoomAudioRenderer untouched, overflow participants audible, documented in-code and pinned by test. Caps: compact 12/30 (mobile/desktop), normal 9/20, spacious 4/8 — at 360px normal that is 3 rows of 3 tiles + overflow, no horizontal scroll, consistent with the june11 top-bar count which keeps showing the full roster.

CROSS-CLUSTER NOTES: (a) the C3 cluster (snapshot-refetch storm) will debounce the roster:changed→/state refetch — VID-3 is complementary (identity-stable applies make whatever refetches remain free on the render side); no file conflicts expected beyond useSessionSocket.ts if they add a debounce wrapper (VID items touch sessionStore.ts/Lobby.tsx/ChatPanel.tsx, not the socket handler bodies). (b) The 40-browser pre-event load run recommended by the audit is the cluster-level verification gate for VID-1+VID-2 — extend e2e/tests/load-25-users.spec.ts / loadABC-20users.spec.ts with all cameras publishing and assert per-viewer rendered-tile cap, zero decoder-related tab crashes, and bounded inbound bitrate. (c) The server jest suite is the home for ALL tests in this cluster (client has no test runner); pure client modules are imported directly (existing bg-engine-core.test.ts precedent), UI wiring is pinned by source-text tests, and behavior is proven by headed Playwright prod smokes — run the FULL server suite locally before every push (standing rule; the pin tests read client sources, so client-only changes can still break the server suite).

---

## VID-1 — Enable adaptiveStream + dynacast + pinned simulcast/encoding on both LiveKit rooms (main-room video diet, part 1)

**Priority:** P0

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/live/Lobby.tsx`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/live/VideoRoom.tsx`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/client/c2-video-diet.test.ts (new)`

### Problem

Every participant publishes the 960x540@~30fps BG-engine track and every client full-subscribes every remote camera at the top simulcast layer because the lobby <LiveKitRoom> (Lobby.tsx:1600-1622) and breakout <LiveKitRoom> (VideoRoom.tsx:652-669) set only capture/audio defaults — no adaptiveStream, no dynacast (verified: zero grep hits in client/src). At 50 participants each viewer decodes ~49 simultaneous 540p streams (~25-80 Mbps inbound); phones cap at ~8-12 hardware decoders and die. This is audit critical C2.

### Design

VERSIONS (verified in root package-lock.json): livekit-client 2.17.2 — RoomOptions.adaptiveStream: AdaptiveStreamSettings|boolean and RoomOptions.dynacast: boolean exist (node_modules/livekit-client/dist/src/options.d.ts:21,30); TrackPublishDefaults.videoSimulcastLayers?: VideoPreset[] and videoEncoding?: VideoEncoding exist (room/track/options.d.ts:7,91); VideoPresets.h180 = 320x180 @160kbps/20fps, h360 = 640x360 @450kbps/20fps, h540 = 960x540 @800kbps/25fps. @livekit/components-react 2.9.20 LiveKitRoom already accepts options (RoomOptions) — both rooms use it today.

CHANGE 1 — Lobby.tsx options object (currently lines 1618-1622). Replace with (preserving the two PINNED lines byte-for-byte — see pinnedTestsToUpdate):
  options={{
    adaptiveStream: true,
    dynacast: true,
    videoCaptureDefaults: { resolution: { ...BG_CAPTURE_RESOLUTION } },
    publishDefaults: {
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      videoEncoding: { maxBitrate: 800_000, maxFramerate: 24 },
    },
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  }}
Add VideoPresets to the existing `from 'livekit-client'` import (line 24). Notes: simulcast is ON by default in livekit-client and 2.17.2's docs state blank videoSimulcastLayers defaults to h180+h360 — the explicit array PINS that so a library default change can't silently fatten the room. videoEncoding caps the TOP layer at 800kbps/24fps (the audit's '24fps' suggestion implemented at the ENCODER, not by touching bgEngine capture — zero blast radius on the segmentation pipeline). adaptiveStream is subscriber-side only: each VideoTrack element's rendered size selects the simulcast layer, and unattached/off-viewport elements get paused. dynacast is publisher-side: simulcast layers nobody consumes stop being encoded/sent.

CHANGE 2 — VideoRoom.tsx options (lines 662-669): add the SAME adaptiveStream/dynacast/publishDefaults keys for consistency (breakouts are 2-3 people; this mainly helps mobile downlink and keeps one mental model). Keep videoCaptureDefaults + audioCaptureDefaults lines verbatim.

BG-ENGINE CONTRACT (must not break): NO changes to bgEngine.ts or BgCameraPublisher.tsx. The engine's LocalVideoTrack is published via lp.publishTrack(track, { source: Track.Source.Camera }) (BgCameraPublisher.tsx:67) — room publishDefaults apply to that call (per-publish options override per-field only; only `source` is passed). unpublishTrack(track, false) on room exit (BgCameraPublisher.tsx:84) is unaffected by dynacast (dynacast state is per-publication and resets on republish in the next room). Backgrounds persisting across main↔breakout↔manual moves must be re-proven by the existing headed bg smoke after this ships.

AUDIO DECISION (explicit contract): audio is COMPLETELY unaffected. adaptiveStream manages video only; autoSubscribe stays default-true; RoomAudioRenderer (Lobby.tsx:1631, VideoRoom.tsx:828) keeps rendering every subscribed mic. All audio always subscribed at any N. Document this in a comment on the adaptiveStream line.

EDGE CASES: (a) AdaptiveStreamSettings.pauseVideoInBackground defaults true — backgrounded tabs pause remote video and auto-resume on foreground; compatible with the S21 reconnect-hold (which renders placeholder divs, no VideoTrack, during hold). (b) A paused off-screen tile shows its last frozen frame for ~100-300ms when scrolled into view until the layer resumes — cosmetic, acceptable. (c) hasVideo checks (publication.track && !isMuted) are unaffected: stream-paused is not isMuted. (d) The pinned big tile / big_speaker stage tiles are large elements → adaptiveStream requests h540; small grid/strip tiles request h180/h360.

### Code sketch

````
// Lobby.tsx import line 24:
import { Track, ConnectionState, RoomEvent, VideoPresets } from 'livekit-client';

// Lobby.tsx options (KEEP the two pinned lines EXACTLY as-is):
options={{
  // C2 (audit 2026-06-12) — subscriber-side diet: layer per rendered tile
  // size, pause unattached/off-screen video. AUDIO IS NEVER AFFECTED —
  // every mic stays subscribed; people without a rendered tile are heard.
  adaptiveStream: true,
  // Publisher-side diet: stop encoding simulcast layers nobody consumes.
  dynacast: true,
  videoCaptureDefaults: { resolution: { ...BG_CAPTURE_RESOLUTION } },
  publishDefaults: {
    // Pin the sub-layers (library default today, explicit so an upgrade
    // can't silently change them) + cap the top layer at 800kbps/24fps.
    videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
    videoEncoding: { maxBitrate: 800_000, maxFramerate: 24 },
  },
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
}}

// new pin test server/src/__tests__/client/c2-video-diet.test.ts:
for (const rel of ['features/live/Lobby.tsx', 'features/live/VideoRoom.tsx']) {
  const src = readClient(rel);
  expect(src).toMatch(/adaptiveStream: true/);
  expect(src).toMatch(/dynacast: true/);
  expect(src).toMatch(/videoSimulcastLayers: \[VideoPresets\.h180, VideoPresets\.h360\]/);
  expect(src).toMatch(/maxFramerate: 24/);
}
// audio contract pin: RoomAudioRenderer still mounted in both rooms
expect(readClient('features/live/Lobby.tsx')).toMatch(/<RoomAudioRenderer \/>/);
````

### Tests to add

- NEW server/src/__tests__/client/c2-video-diet.test.ts — source pins: adaptiveStream:true, dynacast:true, videoSimulcastLayers [h180,h360], maxFramerate:24 present in BOTH Lobby.tsx and VideoRoom.tsx; RoomAudioRenderer still mounted in both; videoCaptureDefaults/audioCaptureDefaults pinned lines unchanged (defense alongside existing ws3/background-effects pins).
- Run full existing server suite — background-effects.test.ts:155-156 (videoCaptureDefaults regex), ws3-audio-cluster.test.ts:26,32 (audioCaptureDefaults exact line, audio={isHost}), may21-livekit-presence-pin.test.ts:73-77 (LiveKitPresenceSync inside <LiveKitRoom>), t0-2-room-presence.test.ts:118 (onConnected emits presence:room_joined) must all stay green with zero edits.
- Headed Playwright prod smoke (extend e2e/tests/bg-smoke.spec.ts pattern): 3 browsers with fake cameras join one event; assert each viewer sees the other two video tiles rendering (outcome: VideoTrack element has nonzero videoWidth); apply a background in main room, host starts a round, assert background survives main→breakout→main (existing bg-cross-device assertions) — proves dynacast/adaptiveStream did not break the BG-engine republish contract; mobile-emulation viewport 390x844 included.

### Acceptance criteria

- Both <LiveKitRoom> components pass adaptiveStream:true and dynacast:true; new pin test green; ALL existing pin suites green without modification.
- 3-browser headed prod smoke: bidirectional video works in lobby and breakout; background persists across room moves (existing bg smoke assertions pass).
- Manually (or via Playwright page.evaluate on getStats): with 10+ tiles in the lobby grid, inbound resolution for a small grid tile is ≤640x360 (a sub-layer), not 960x540 — adaptive layer selection observed.
- No change to join-muted policy, mic controls, pin behavior, host tile elevation (smoke covers mute/pin paths).

### Pinned tests to update

- NONE must change — design preserves byte-exact pinned lines: server/src/__tests__/services/background-effects.test.ts:155-156 (`videoCaptureDefaults: { resolution: { ...BG_CAPTURE_RESOLUTION`), server/src/__tests__/client/ws3-audio-cluster.test.ts:26 (`audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }` — keep this exact one-line form when editing the options object), ws3-audio-cluster.test.ts:32 (`audio={isHost}`), may21-livekit-presence-pin.test.ts (LiveKitPresenceSync/BgCameraPublisher inside the LiveKitRoom block).

### Risks

dynacast + the processed (track-processors) BG track is the main unknown — it operates at the encoder layer and should be orthogonal, but if simulcast layers fail to resume after a room hop, the visible symptom is a black/frozen remote tile after round transitions; rollback is deleting the single `dynacast: true` line (keep adaptiveStream). adaptiveStream means video for unrendered participants is paused — any future feature that reads remote video pixels without attaching an element would see frozen frames (none exists today). Frozen last-frame for ~100-300ms when a paused tile re-enters the viewport is expected, not a bug. Encoder cap 24fps slightly reduces motion smoothness on the top layer — invisible at meeting tile sizes.

### Deploy notes

Client-only (Vercel). No migration, no env var, no render.yaml, no server change, no ordering constraint. Verify the app.rsn.network bundle hash actually changed post-deploy (same-sha dedup gotcha). Ship FIRST in this cluster; run the headed bg smoke before announcing.

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** CHANGE 2 adds publishDefaults with VideoPresets to VideoRoom.tsx, but the spec's import instruction covers only Lobby.tsx line 24. VideoRoom.tsx's livekit-client import (line 21: { Track, ConnectionState, RoomEvent }) lacks VideoPresets — tsc fails until the implementer infers the same edit there.

*Required action:* State explicitly: add VideoPresets to VideoRoom.tsx's 'from livekit-client' import at line 21.

---

## VID-2 — Lobby tile render cap with '+N more' overflow + content-visibility (30-50 grid strategy, part 2)

**Priority:** P0
**Depends on:** VID-1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/live/Lobby.tsx`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/live/tileWindow.ts (new, pure module)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/hooks/useMediaQuery.ts (new)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/c2-tile-window.test.ts (new)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/client/c2-video-diet.test.ts (extend)`

### Problem

LobbyMosaic renders one tile per camera track with no cap or pagination (Lobby.tsx:623-626 maps ALL cameraTracks; the pinned-layout strip at 585-593 maps all unpinned tracks). At 50 participants that is ~50 video elements + 50 decoders + 50 sets of overlay DOM per client. VID-1's adaptiveStream pauses off-viewport video, but the DOM/decoder/layout cost and worst-case scroll-thrash remain unbounded, and phones at 360px get an endless scroll of micro-tiles.

### Design

CHOSEN PRIMARY APPROACH (one approach, per the work order): hard render cap by density+viewport, deterministic priority ordering (the EXISTING Phase-Q sort: director → acting hosts → local user → others, Lobby.tsx:103-117), a single non-interactive '+N more' overflow tile, and CSS content-visibility on every tile wrapper so the rendered-but-offscreen remainder costs no layout/paint and lets adaptiveStream pause it. Explicit pagination was REJECTED: it adds stateful page churn that fights the density toggle and reconnect-hold, and active speakers would be invisible on other pages; cap+overflow is one decision and mobile-first.

NEW PURE MODULE client/src/features/live/tileWindow.ts (no imports — unit-testable from the server jest suite via the bgEngineCore direct-import pattern, see server/src/__tests__/services/bg-engine-core.test.ts:14):
  export const TILE_CAPS = {
    compact:  { mobile: 12, desktop: 30 },
    normal:   { mobile: 9,  desktop: 20 },
    spacious: { mobile: 4,  desktop: 8  },
  } as const;
  export function computeTileWindow<T>(args: { tracks: T[]; density: 'compact'|'normal'|'spacious'; isMobile: boolean; localSid: string|null; sidOf: (t: T) => string }): { visible: T[]; overflowCount: number }
Contract: cap = TILE_CAPS[density][isMobile?'mobile':'desktop']. tracks.length <= cap → { visible: tracks, overflowCount: 0 } (same array reference — zero behavior change under cap). Otherwise visible = tracks.slice(0, cap); if localSid is non-null and not within visible, REPLACE the last visible slot with the local track (self-view is always rendered); overflowCount = tracks.length - visible.length. Deterministic, order-preserving — no churn between renders beyond the existing sort. (The Phase-Q sort guarantees director/hosts/local sit in the first ~4 slots, so the swap is a rare safety net.)

NEW HOOK client/src/hooks/useMediaQuery.ts: standard matchMedia + 'change' listener returning boolean (no such hook exists in the repo — verified). Lobby uses useMediaQuery('(max-width: 639px)') to align with the Tailwind sm: breakpoint the grid classes already use.

LOBBY WIRING (LobbyMosaic): after the useVisibilityPartition destructure (KEEP `normalTracks: cameraTracks` — pinned by phase-n:137 and phase-t:68):
  const isMobile = useMediaQuery('(max-width: 639px)');
  const { visible: gridTracks, overflowCount } = computeTileWindow({ tracks: cameraTracks, density: lobbyDensity, isMobile, localSid: localParticipant.sid, sidOf: t => t.participant.sid });
- Default grid (623-626): map gridTracks instead of cameraTracks; the empty-state condition stays on cameraTracks.length. After the map, render the overflow tile when overflowCount > 0 (see codeSketch). gridCols continues to derive from n = participants.length (unchanged classes — the density pins in phase-q stay intact).
- Pinned layout strip (585-593): apply the same window to unpinnedTracks (slice via computeTileWindow with the same args) and append a small '+N' pill div at the end of the strip when overflowing.
- big_speaker stage row: NOT capped (host-curated, realistically 1-2).
- CONTENT-VISIBILITY: append `[content-visibility:auto] [contain-intrinsic-size:auto_200px]` (Tailwind arbitrary properties) to the tile wrapper className in renderTile and to the overflow tile. This is the virtualization half: off-viewport rendered tiles skip layout/paint, and adaptiveStream (VID-1) pauses their video via IntersectionObserver.

AUDIO CONTRACT (explicit): the cap affects VIDEO TILES ONLY. RoomAudioRenderer renders every mic regardless; an overflow participant is still heard, can still be host-muted via HCC/ParticipantList (roster-driven, not tile-driven), and a host server-pin of an overflow user still works because the serverPinnedSid resolver searches cameraTracksSorted — all tracks, not just rendered ones (Lobby.tsx:250-256) — and the pinned layout then renders them. The overflow tile carries the hint text 'audio still on'.

MOBILE-FIRST 360px SPEC (global rule): normal density at 50 people → cap 9 → grid-cols-3 → exactly 3 rows of ~110px tiles + 1 overflow tile; spacious → 4 single-column framed tiles + overflow; compact → 12 tiles at 3-col + overflow. No horizontal scroll (grid is fluid); the overflow tile is aspect-video like its siblings so it cannot overflow the column; top-bar count (TopBarParticipantCount, LiveSessionPage.tsx:688-700) keeps showing the full roster so grid(≤cap) + '+N more' is always reconcilable with the header count.

### Code sketch

````
// Lobby.tsx — default grid block (replaces the map at 623-626):
<div className={`grid ${gridCols} ${gapClass} w-full`}>
  {gridTracks.map(trackRef =>
    renderTile(trackRef, { onClick: () => setEffectivePin(trackRef.participant.sid) })
  )}
  {overflowCount > 0 && (
    <div
      data-testid="lobby-overflow-tile"
      className="relative rounded-xl bg-[#3c4043] aspect-video flex flex-col items-center justify-center text-gray-300 [content-visibility:auto]"
    >
      <Users className="h-6 w-6 mb-1" />
      <span className="text-sm font-semibold">+{overflowCount} more</span>
      <span className="text-[10px] text-gray-500">audio still on</span>
    </div>
  )}
  {cameraTracks.length === 0 && bigSpeakerTracks.length === 0 && ( /* unchanged empty state */ )}
</div>

// tileWindow.ts core:
export function computeTileWindow<T>({ tracks, density, isMobile, localSid, sidOf }: Args<T>) {
  const cap = TILE_CAPS[density][isMobile ? 'mobile' : 'desktop'];
  if (tracks.length <= cap) return { visible: tracks, overflowCount: 0 };
  const visible = tracks.slice(0, cap);
  if (localSid && !visible.some(t => sidOf(t) === localSid)) {
    const local = tracks.find(t => sidOf(t) === localSid);
    if (local) visible[visible.length - 1] = local; // self-view always rendered
  }
  return { visible, overflowCount: tracks.length - visible.length };
}

// renderTile wrapper div — append to the existing className template:
// `... ${tileClass} [content-visibility:auto] [contain-intrinsic-size:auto_200px] flex items-center justify-center group cursor-pointer`
````

### Tests to add

- NEW server/src/__tests__/services/c2-tile-window.test.ts (direct import of client/src/features/live/tileWindow.ts, same pattern as bg-engine-core.test.ts): under-cap returns same array reference + overflow 0; each density×viewport cap honored; local-sid swap-in when local lands beyond cap; overflowCount math (50 tracks, normal/mobile → 9 visible + 41 overflow); empty input.
- EXTEND server/src/__tests__/client/c2-video-diet.test.ts pins: Lobby.tsx contains data-testid="lobby-overflow-tile", `gridTracks.map(`, `computeTileWindow(`, `[content-visibility:auto]`, and the literal 'audio still on' hint; `normalTracks: cameraTracks` destructure still present (mirrors phase-n/phase-t pins).
- Headed Playwright prod smoke (extend e2e/tests/load-25-users.spec.ts harness): 12 fake-camera users join; a 13th viewer at viewport 360x740, density 'normal': assert rendered tiles ≤ 9, overflow tile visible with text '+4 more' (13 in room → 12 camera tracks for the viewer +1 self = 13 tracks → 9 + '+4'), assert overflow tile boundingBox fully inside viewport width (no horizontal scroll, per the viewport-fit assertion rule), toggle density to compact → rendered count rises to ≤12 and overflow text updates; assert self tile (data-self="true") always present; assert audio elements exist for all remote mics (audio contract) — count of <audio> elements from RoomAudioRenderer ≥ unrendered participants.

### Acceptance criteria

- With 50 in-room cameras at any density/viewport the DOM contains at most TILE_CAPS[density][viewport] video tiles + exactly one overflow tile; '+N more' N always equals total camera tracks minus rendered tiles.
- The local self-view tile is rendered in every configuration (data-self always present).
- At n ≤ cap the grid is pixel-identical to today (overflow tile absent; same array reference means no extra re-render) — existing phase-q/phase-n/phase-t/s21 pin suites green unmodified.
- A participant with no rendered tile is still audible, still appears in the top-bar count and ParticipantList, and a host server-pin of them still renders them as the big tile.
- 360px: no horizontal scroll; overflow tile within viewport; density toggle changes the cap live.

### Pinned tests to update

- NONE must change — keep `normalTracks: cameraTracks` (phase-n-multi-host-visibility-ui.test.ts:137, phase-t-breakout-visibility.test.ts:68), keep `heldRosterRef.current = cameraTracksSorted.map` (s21-reconnect-roster-hold.test.ts:35 — the hold path is untouched), keep the gridCols/density expressions and all phase-q class-constant pins (the cap windows WHICH tiles render, never their classes).

### Risks

Late joiners are the ones bumped to overflow (deterministic consequence of the Phase-Q priority sort) — acceptable and predictable; an active speaker in overflow is heard but not seen (speaker-promotion into the window is a deliberate non-goal for v1 — it reintroduces churn; note for a future item). Local pin via tile-click is impossible for overflow users (no tile to click) — host pin and all roster-based controls still cover them. contain-intrinsic-size estimate (200px) only affects scrollbar accuracy, not correctness. content-visibility is supported in all evergreen browsers; older Safari ignores it gracefully (tiles just render normally — adaptiveStream still pauses off-screen video).

### Deploy notes

Client-only (Vercel). No migration/env/server change. Ship AFTER VID-1 so the cap and adaptive subscriptions are smoke-tested together (technically independent — cap works without VID-1). One deploy, headed smoke, then proceed.

### ⚠ Adversarial review — REQUIRED amendments

**[IMPORTANT]** The mobile reconcilability claim and part of the acceptance are false: TopBarParticipantCount renders with className 'hidden sm:inline-flex' (client/src/features/live/LiveSessionPage.tsx:703), i.e. it is INVISIBLE below 640px. The spec asserts 'top-bar count keeps showing the full roster so grid(≤cap) + +N more is always reconcilable with the header count' specifically in the MOBILE-FIRST 360px section — but at 360px (where the cap bites hardest: 9 of 50 rendered) there is no top-bar count at all, and acceptance bullet 4 ('still appears in the top-bar count') cannot be verified on the primary target viewport.

*Required action:* Either drop the 'hidden sm:' guard so the count shows on mobile (it is compact text and fits the top bar), or rewrite the claim/acceptance to rely on the '+N more' tile plus the ParticipantList drawer count on mobile. Decide explicitly — Ali's global rule makes phone users the primary audience.

**[NIT]** Unlisted pin that constrains the strip windowing shape: phase-n-multi-host-visibility-ui.test.ts:165 requires the literal assignment /const\s+unpinnedTracks\s*=\s*cameraTracksSorted\.filter\(/ with visibilityFor(t) !== 'hidden' inside. The spec says 'apply the same window to unpinnedTracks (slice via computeTileWindow with the same args)' without naming this pin — an implementer who restructures the assignment (e.g. const unpinnedTracks = computeTileWindow({ tracks: cameraTracksSorted.filter(...) }).visible) breaks it. Safe only if windowing lands in a NEW variable after the pinned assignment.

*Required action:* Add to VID-2's pinnedTestsToUpdate notes: keep the 'const unpinnedTracks = cameraTracksSorted.filter(...)' assignment verbatim and window into a separate variable (e.g. stripTracks) afterwards.

---

## VID-3 — Identity-stable snapshot applies in sessionStore (deep-compare participants and sibling collections) — M9 part 1

**Priority:** P1

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/stores/sessionStore.ts`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/lib/stateIdentity.ts (new, pure module)`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/services/m9-state-identity.test.ts (new)`

### Problem

applyFullState (sessionStore.ts:619-686) rebuilds SEVEN collections with fresh identities on EVERY apply — participants (new .map array), cohosts (new Set), hostVisibilityModes (`|| {}` fresh object when absent), actingAsHostOverrides, hostMutedUserIds (new Set), tileDemotedUserIds ([] literal), hccParticipants ([] fallback). applyFullState runs on every roster:changed REST refetch (useSessionSocket.ts:262-264), on mount, on reconnect, AND on the 30s periodic resync (useSessionSocket.ts:1168) — so even a completely unchanged roster re-renders LobbyMosaic (which selects participants, cohosts, hostVisibilityModes, actingAsHostOverrides, tileDemotedUserIds) and the whole Lobby tree every 30s, and in a churn burst at 50 people, dozens of times per minute. applyStateSnapshot (608-614) has the same array-identity swap. Audit M9.

### Design

NEW PURE MODULE client/src/lib/stateIdentity.ts (zero imports → directly unit-testable from the server jest suite, bgEngineCore pattern):
  export function keepIfEqual<T>(prev: T, next: T, eq: (a: T, b: T) => boolean): T  // returns prev when eq, else next
  export function sameParticipantList(a: ReadonlyArray<{userId: string; displayName: string}>, b: same): boolean  // length + ORDER-SENSITIVE per-item userId/displayName equality (order-sensitive deliberately: a server-side reorder is a real change for sorted consumers, and it keeps the compare O(n) single-pass)
  export function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean  // size + has() loop
  export function sameStringArray(a: readonly string[], b: readonly string[]): boolean
  export function sameShallowRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean  // key count + Object.is per key
  export function sameHccList(a: any[], b: any[]): boolean  // length + per-item userId/displayName/email/role/actingAsHost field equality

CHANGE 1 — applyFullState: keep the existing body EXACTLY as-is (it carries four pinned expressions — see pinnedTestsToUpdate) but assign it to a local `const next = { ...existing literal... };` then stabilize BEFORE returning:
  next.participants = keepIfEqual(s.participants, next.participants, sameParticipantList);
  next.cohosts = keepIfEqual(s.cohosts, next.cohosts, sameStringSet);
  next.hostVisibilityModes = keepIfEqual(s.hostVisibilityModes, next.hostVisibilityModes, sameShallowRecord);
  next.actingAsHostOverrides = keepIfEqual(s.actingAsHostOverrides, next.actingAsHostOverrides, sameShallowRecord);
  next.hostMutedUserIds = keepIfEqual(s.hostMutedUserIds, next.hostMutedUserIds, sameStringSet);
  next.tileDemotedUserIds = keepIfEqual(s.tileDemotedUserIds, next.tileDemotedUserIds, sameStringArray);
  next.hccParticipants = keepIfEqual(s.hccParticipants, next.hccParticipants, sameHccList);
  return next;
Zustand v5 uses Object.is per selected field — returning the previous reference means selectors on those fields do NOT re-render. Scalar fields (sessionStatus, hostUserId, serverPinnedUserId, isPaused, …) are value-equal across no-op applies already. timerSeconds/clockOffset change only while a timer is actually running (when timerEndsAt is null both recompute to the same 0/previous values).

CHANGE 2 — applyStateSnapshot (608-614): seq MUST keep bumping (the you-block convergence in useSessionSocket.ts:274-277 reads prevSeq via getState() BEFORE calling apply, then compares data.seq — unaffected), but reuse the array:
  const mapped = snap.participants.map(p => ({ userId: p.userId, displayName: p.displayName }));
  return { snapshotSeq: snap.seq, participants: keepIfEqual(s.participants, mapped, sameParticipantList) };

CONSUMER AUDIT (done — safe): useInRoomParticipants (sessionStore.ts:732-743) memoizes on [storeParticipants, liveRoomParticipants] — stable identity = fewer recomputes, same values. LiveKitPresenceSync writes liveRoomParticipants through its own key-diff (already identity-guarded). No effect anywhere keys off participants identity to detect 'a snapshot arrived' (sessionStateLoaded serves that). reset() is untouched.

### Code sketch

````
// sessionStore.ts — applyFullState tail (after the existing object literal):
applyFullState: (snapshot) => set((s) => {
  // ... existing clockOffset/timerSeconds derivation unchanged ...
  const next: Partial<SessionState> = {
    // ... ALL existing fields verbatim, including the pinned lines:
    //   actingAsHostOverrides: snapshot.actingAsHostOverrides || {},
    //   serverPinnedUserId: (snapshot as any).pinnedUserId ?? null,
    //   hccParticipants: (snapshot as any).hccParticipants ?? [],
  };
  // M9 — identity-stable collections: a value-equal refetch (roster:changed
  // storm, 30s periodic resync) must not swap references, or every selector
  // consumer (the whole lobby grid) re-renders for nothing.
  next.participants = keepIfEqual(s.participants, next.participants!, sameParticipantList);
  next.cohosts = keepIfEqual(s.cohosts, next.cohosts!, sameStringSet);
  next.hostVisibilityModes = keepIfEqual(s.hostVisibilityModes, next.hostVisibilityModes!, sameShallowRecord);
  next.actingAsHostOverrides = keepIfEqual(s.actingAsHostOverrides, next.actingAsHostOverrides!, sameShallowRecord);
  next.hostMutedUserIds = keepIfEqual(s.hostMutedUserIds, next.hostMutedUserIds!, sameStringSet);
  next.tileDemotedUserIds = keepIfEqual(s.tileDemotedUserIds, next.tileDemotedUserIds!, sameStringArray);
  next.hccParticipants = keepIfEqual(s.hccParticipants, next.hccParticipants!, sameHccList);
  return next;
}),
````

### Tests to add

- NEW server/src/__tests__/services/m9-state-identity.test.ts — part A (direct import of client/src/lib/stateIdentity.ts): exhaustive comparator semantics — equal/unequal lists, order change detected, Set size vs membership, record key add/remove/value change, empty cases, keepIfEqual reference passthrough.
- Part B (direct import of client/src/stores/sessionStore.ts, like bg-engine-core.test.ts imports client modules — zustand and react resolve in the monorepo root node_modules): build a minimal snapshot fixture; getState().applyFullState(fix); capture refs of all 7 collections; applyFullState(structuredClone(fix)); expect all 7 refs toBe identical; mutate one participant displayName in a clone → expect participants identity changed AND value correct, others toBe stable; applyStateSnapshot with seq+1 and identical participants → snapshotSeq bumped, participants reference unchanged; stale seq → no-op. If the store's transitive imports prove un-importable under the server jest config, fall back to source pins (`keepIfEqual(s.participants`, `keepIfEqual(s.cohosts`, etc. in sessionStore.ts) and keep part A as the behavioral test.
- Headed Playwright prod smoke: 3 browsers idle in the lobby for 70s (≥2 periodic resyncs): assert no tile flicker via two screenshots 35s apart being pixel-stable in the grid region (or assert via injected React Profiler counter in a dev-flag build); then a 4th user joins → all 3 viewers show the new tile within 2s (roster propagation intact); kick the 4th → tile disappears everywhere (mutation path intact).

### Acceptance criteria

- Applying a value-identical snapshot twice yields toBe-identical references for participants, cohosts, hostVisibilityModes, actingAsHostOverrides, hostMutedUserIds, tileDemotedUserIds, hccParticipants.
- A genuine roster/cohost/visibility change still swaps identity and carries the new values (no staleness).
- snapshotSeq monotonicity contract unchanged: stale/duplicate seq still ignored, newer seq always recorded even when participants are value-equal.
- Existing pins green unmodified: phase-m-acting-as-host.test.ts:217-218, phase-may18-stefan-feedback (serverPinnedUserId hydrate regex), s26-start-signal-resilience.test.ts:61 (s.applyFullState(d)), june10-kick-is-terminal store pins.

### Pinned tests to update

- NONE must change — the object-literal lines that pins match are preserved verbatim: `actingAsHostOverrides: snapshot.actingAsHostOverrides || {}` (phase-m-acting-as-host.test.ts:218 regex), `serverPinnedUserId: (snapshot as any).pinnedUserId ?? null` (phase-may18-stefan-feedback.test.ts ~81), reset() literals (phase-m:221-225). The stabilization happens via post-assignment, not by rewriting those lines.

### Risks

Low. The one behavioral nuance: a server-side participant REORDER without membership change now (correctly) re-renders, and order-sensitivity means we never mask it. If any future code mutates the store's collections in place (none does today — verified all setters replace), keepIfEqual would hide the change; the comparators live in one module so that contract is documented there. hccParticipants compare must include every field the HCC drawer renders — sameHccList lists them explicitly so a server field addition shows up in review.

### Deploy notes

Client-only (Vercel). No migration/env/server change. Independent of VID-1/2; ship as its own deploy with the smoke. Recommended order: after VID-2 (P0s first).

### ⚠ Adversarial review — REQUIRED amendments

**[IMPORTANT]** sameHccList's comparator field list is wrong and would freeze genuinely-changed HCC data. The snapshot's hccParticipants items carry {userId, displayName, email, role, globalRole, state, currentMatchId, currentRoomId, joinedAt} (server/src/services/session/session-state-snapshot.service.ts:163-173). HostControlCenter derives its counts and filter from p.state (client/src/features/live/HostControlCenter.tsx:283-295) and uses currentMatchId/currentRoomId for move targets. The spec's comparator compares only 'userId/displayName/email/role/actingAsHost' — 'actingAsHost' is not even a field on these items (overrides live in a separate map), and state/currentRoomId/currentMatchId change every round with NO membership change, so keepIfEqual would keep the stale pre-round array indefinitely. This directly violates the spec's own acceptance criterion 2 ('a genuine change still swaps identity'). The live roundDashboard.participants path usually wins in HCC (HostControlCenter.tsx:243-251), so the stale data surfaces on the cold-start/fresh-cohost fallback path — exactly the path Bug 68 added hccParticipants to fix.

*Required action:* Define sameHccList over ALL snapshot fields: userId, displayName, email, role, globalRole, state, currentMatchId, currentRoomId, joinedAt (drop the non-existent actingAsHost). Better: make it a generic keyed shallow-compare over Object.keys union so a server field addition can never silently reintroduce staleness, and add a part-A test case where only `state` changes and the identity must swap.

**[NIT]** The claim 'timerSeconds/clockOffset change only while a timer is actually running' is wrong for clockOffset: applyFullState recomputes clockOffset = Date.parse(snapshot.serverNow) - Date.now() whenever serverNow is present (sessionStore.ts:628-630), which jitters by milliseconds on EVERY apply including no-op 30s resyncs — so clockOffset-selecting components still re-render every resync. LobbyMosaic does not select clockOffset, so the headline M9 fix stands, but the spec's 'value-equal across no-op applies' framing overstates the result and could mislead someone profiling residual re-renders.

*Required action:* Correct the claim, and optionally stabilize clockOffset too (e.g. keep the previous offset when |delta| < some threshold like 250ms) as a documented follow-up rather than silently absorbing it.

---

## VID-4 — Memoized LobbyTile component + per-tile mute subscriptions; remove the grid-wide muteTick — M9 part 2

**Priority:** P1
**Depends on:** VID-3

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/live/Lobby.tsx`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/client/m9-lobby-tile-memo.test.ts (new)`

### Problem

renderTile (Lobby.tsx:339-537) is an inline closure — every LobbyMosaic render rebuilds every tile's JSX with zero memoization. Worse, the UX2 muteTick effect (Lobby.tsx:54-72) bumps a state counter on EVERY RoomEvent.TrackMuted/TrackUnmuted/TrackSubscribed/TrackUnsubscribed in the room, force-re-rendering the ENTIRE grid: at 50 people one person toggling their mic re-renders 50 tiles on 50 clients. This compounds C2 on phones (audit M9).

### Design

COMPONENT BOUNDARY: new module-scope `const LobbyTile = memo(function LobbyTile(props: LobbyTileProps), lobbyTilePropsEqual)` placed above LobbyMosaic in Lobby.tsx, containing the entire current tile JSX (wrapper div through LobbyTileReaction). The `const renderTile = (trackRef, { isPinned, onClick }) =>` closure REMAINS at its current position but becomes a thin derivation wrapper that computes the per-tile primitives and returns <LobbyTile .../> — this deliberately preserves every phase-q source pin (see pinnedTestsToUpdate). React key stays `trackRef.participant.sid` (the requested memo key), set where renderTile is invoked (key={trackRef.participant.sid} on <LobbyTile>).

PROPS (primitives + trackRef + stable handlers):
  interface LobbyTileProps { trackRef: any; name: string; isLocal: boolean; tileIsHost: boolean; isActingHost: boolean; isDemoted: boolean; isPinned: boolean; tileClass: string; viewerIsHost: boolean; sessionId?: string; onClick?: () => void → replace with onTileClick: (sid: string) => void; onPinToggle: (sid: string | null, identity: string | null) => void; onHostMute: (identity: string, mute: boolean) => void; onKick: (identity: string, name: string) => void; onSetTileSize: (identity: string, size: 'participant'|'host') => void; }
renderTile computes: name (existing line), isLocal, tileIsHost, isActingHost (KEEP the pinned expression `isActingHost = !!trackRef.participant.identity && hostsSet.has(trackRef.participant.identity) && !tileDemotedSet.has(...)` inside renderTile), and tileClass via the PINNED expression `isPinned ? 'h-full w-full' : isActingHost ? (useBigHostTiles ? soloOrCompactHostTileClass : multiHostNarrowTileClass) : 'aspect-video'`.

MEMO EQUALITY lobbyTilePropsEqual(prev, next): trackRef compared by participant.sid + publication?.trackSid + !!publication?.track (subscription presence — drives video-vs-placeholder); all primitive props by Object.is; handler props assumed stable (enforced below). Mute state is EXCLUDED from the comparator because it moves into per-tile hooks:

PER-TILE MUTE SCOPING (replaces grid-wide muteTick): inside LobbyTile use @livekit/components-react 2.9.20's `useIsMuted(trackRef: TrackReferenceOrPlaceholder): boolean` (verified at node_modules/@livekit/components-react/dist/hooks/useIsMuted.d.ts:21):
  const camMuted = useIsMuted(trackRef);  // camera trackRef from useTracks
  const micRef = useMemo(() => ({ participant: trackRef.participant, source: Track.Source.Microphone }), [trackRef.participant]);
  const micMuted = useIsMuted(micRef as any);  // placeholder ref is valid TrackReferenceOrPlaceholder
  const hasVideo = !!trackRef.publication?.track && !camMuted;  // UX2 semantics preserved
  const isMicOn = !micMuted;  // replaces participant.isMicrophoneEnabled reads
Each tile now re-renders ONLY on its own participant's mute events. DELETE the muteTick effect (Lobby.tsx:54-72) and the now-unused `const room = useRoomContext()` (line 54) + useRoomContext import if unused elsewhere in the file. TrackSubscribed/Unsubscribed coverage is retained WITHOUT the bump: useTracks already re-emits on subscription changes (components-core trackReferencesObservable), and the comparator's !!publication?.track re-renders exactly the affected tile.

STABLE HANDLERS: handleHostMute/handleKick/handleSetTileSize already useCallback([sessionId]) — stable. setEffectivePin is NOT (deps include cameraTracksSorted, Lobby.tsx:267-288): restructure to take the identity from the caller instead of searching tracks — signature `const setEffectivePin = useCallback((sid: string | null, identity: string | null) => { if (isHost && sessionId) { socket?.emit('host:set_pin', { sessionId, pinnedUserId: identity }); setPinnedSid(null); } else { setPinnedSid(sid); } }, [isHost, sessionId]);` — KEEPS the may18 pinned fragments (`const setEffectivePin`, `if (isHost && sessionId)`, `socket?.emit('host:set_pin'`, `setPinnedSid(sid)`) while removing the unstable dep. Call sites pass trackRef.participant.identity (the tile knows it); the unpin path passes (null, null). The auto-unpin effect and serverPinnedSid resolver are unchanged.

UNCHANGED INSIDE LobbyTile: LobbyTileReaction (already per-user memo), LobbyMediaControls on the local tile (own hooks, re-renders independently), all data-testids, `data-self={isLocal ? 'true' : undefined}` and `data-acting-host={isActingHost ? 'true' : undefined}` verbatim (pinned, file-wide regex — props keep the same names). VideoStage's twin bump in VideoRoom.tsx (lines 119-133) is deliberately LEFT ALONE (2-3 tiles; not worth blast radius) — note in code comment.

### Code sketch

````
// Module scope, above LobbyMosaic:
function lobbyTilePropsEqual(prev: LobbyTileProps, next: LobbyTileProps): boolean {
  return (
    prev.trackRef?.participant?.sid === next.trackRef?.participant?.sid &&
    prev.trackRef?.publication?.trackSid === next.trackRef?.publication?.trackSid &&
    !!prev.trackRef?.publication?.track === !!next.trackRef?.publication?.track &&
    prev.name === next.name && prev.isLocal === next.isLocal &&
    prev.tileIsHost === next.tileIsHost && prev.isActingHost === next.isActingHost &&
    prev.isDemoted === next.isDemoted && prev.isPinned === next.isPinned &&
    prev.tileClass === next.tileClass && prev.viewerIsHost === next.viewerIsHost &&
    prev.sessionId === next.sessionId &&
    prev.onTileClick === next.onTileClick && prev.onPinToggle === next.onPinToggle &&
    prev.onHostMute === next.onHostMute && prev.onKick === next.onKick &&
    prev.onSetTileSize === next.onSetTileSize
  );
}
const LobbyTile = memo(function LobbyTile(props: LobbyTileProps) {
  const { trackRef, isLocal, isActingHost } = props;
  const camMuted = useIsMuted(trackRef);                       // per-tile camera mute
  const micRef = useMemo(() => ({ participant: trackRef.participant, source: Track.Source.Microphone }), [trackRef.participant]);
  const micMuted = useIsMuted(micRef as any);                  // per-tile mic mute
  const hasVideo = !!trackRef.publication?.track && !camMuted; // UX2 semantics
  const isMicOn = !micMuted;
  return (
    <div data-self={isLocal ? 'true' : undefined} data-acting-host={isActingHost ? 'true' : undefined} ...>{/* existing JSX verbatim */}</div>
  );
}, lobbyTilePropsEqual);

// Inside LobbyMosaic — renderTile becomes a thin wrapper (pins preserved):
const renderTile = (trackRef: any, { isPinned = false, onClick }: ... = {}) => {
  const name = trackRef.participant.name || trackRef.participant.identity || 'User';
  const isLocal = trackRef.participant.sid === localParticipant.sid;
  const tileIsHost = trackRef.participant.identity === hostUserId;
  const isActingHost = !!trackRef.participant.identity
    && hostsSet.has(trackRef.participant.identity)
    && !tileDemotedSet.has(trackRef.participant.identity);
  const tileClass = isPinned ? 'h-full w-full' : isActingHost ? (useBigHostTiles ? soloOrCompactHostTileClass : multiHostNarrowTileClass) : 'aspect-video';
  return <LobbyTile key={trackRef.participant.sid} trackRef={trackRef} name={name} isLocal={isLocal} tileIsHost={tileIsHost} isActingHost={isActingHost} isDemoted={tileDemotedSet.has(trackRef.participant.identity)} isPinned={isPinned} tileClass={tileClass} viewerIsHost={isHost} sessionId={sessionId} onTileClick={onClick ? () => onClick() : undefined} onPinToggle={setEffectivePin} onHostMute={handleHostMute} onKick={handleKick} onSetTileSize={handleSetTileSize} />;
};
// NOTE: onTileClick built inline is UNSTABLE — instead pass setEffectivePin and let
// the tile call props.onPinToggle(sid, identity) / grid clicks route the same way;
// the grid map's `onClick: () => setEffectivePin(...)` wrappers are removed in favor
// of the tile invoking onPinToggle(trackRef.participant.sid, trackRef.participant.identity).
````

### Tests to add

- NEW server/src/__tests__/client/m9-lobby-tile-memo.test.ts — source pins: `const LobbyTile = memo(` with `lobbyTilePropsEqual` as second arg; `useIsMuted` imported from '@livekit/components-react'; grid-wide bump GONE (`expect(src).not.toMatch(/setMuteTick/)` and not.toMatch(/RoomEvent\.TrackMuted, bump/)); setEffectivePin has no cameraTracksSorted dep (`expect(src).toMatch(/\},\s*\[isHost,\s*sessionId\]\s*,?\s*\);/` scoped after `const setEffectivePin`); hasVideo derives from camMuted (`!camMuted`).
- Run the FULL existing suite — phase-q-host-tile-elevation.test.ts (all 12 pins), phase-x-may-13 Bug 8 pins, phase-may18 setEffectivePin pins, s21 roster-hold pins, ws3-audio-cluster, may21 — must be green WITHOUT edits (the renderTile-wrapper design exists precisely for this).
- Headed Playwright prod smoke (extend e2e/tests/s17-s18-mute-and-endgame-smoke.spec.ts + phase-q-ui-host-tile-elevation.spec.ts): 3 browsers; B mutes mic → A shows B's red MicOff badge within 2s; B unmutes → badge clears; B turns camera off → A shows avatar placeholder (not frozen video) within 2s; back on → video resumes; host pins B globally → all viewers show B as big tile; host mute-participant on B → B's tile reflects mute on A (outcome asserts, not visibility-only). These pin the exact behaviors the old grid-wide bump guaranteed (UX2 + Bug 1 + S17).

### Acceptance criteria

- One participant's mic/cam toggle re-renders only that participant's tile (verifiable in dev via React DevTools highlight or a dev-only render counter; enforced in CI by the smoke outcomes + pins).
- Remote mute/camera indicators stay correct through toggle storms (smoke), including during/after a TrackSubscribed race (placeholder→video flip still instant).
- Pin/unpin, host pin broadcast, shrink/restore tile, host mute, kick all function identically (smoke).
- All pre-existing pin suites green with zero modifications.

### Pinned tests to update

- NONE if the design is followed exactly. The load-bearing pins that constrain HOW this refactor must be shaped: phase-q-host-tile-elevation.test.ts:44 + 79 (literal `const renderTile` must exist inside LobbyMosaic, with the isActingHost/hostsSet derivation within 1800 chars — hence the thin-wrapper design), :94-97 (className expression `isActingHost ? (useBigHostTiles ? soloOrCompactHostTileClass : multiHostNarrowTileClass)` + the two class constants verbatim), :118 + 126 (`data-acting-host={isActingHost ? 'true' : undefined}` and `data-self={isLocal ? 'true' : undefined}` — keep prop names isActingHost/isLocal in LobbyTile), phase-x-may-13-live-bugs.test.ts:405-416 (`useBigHostTiles ? soloOrCompactHostTileClass`), phase-may18-stefan-feedback.test.ts (within 2000 chars of `const setEffectivePin`: `if (isHost && sessionId)`, `socket?.emit('host:set_pin'`, `setPinnedSid(sid)`; plus `effectivePinnedSid ? cameraTracksSorted.find`), s21-reconnect-roster-hold.test.ts:31-35 (`heldRosterRef.current = cameraTracksSorted.map` untouched). If any of these prove impossible to preserve during implementation, update THAT specific pin in the SAME commit with a comment explaining the refactor — but the design was built so none need it.

### Risks

Highest-touch item of the cluster (large JSX move). Main hazards: (1) a missed prop in lobbyTilePropsEqual yields a stale tile — mitigate by comparing EVERY prop explicitly (no rest-spread props on LobbyTile); (2) useIsMuted re-subscribes when trackRef identity changes on the (now rare, post-VID-3) parent re-renders — cheap, but verify no listener leak with a long-running smoke; (3) the inline onClick wrappers in the grid map were the old click path — route clicks through the tile's own onPinToggle(sid, identity) so no unstable closures remain; (4) if the implementer relocates the isActingHost/tileClass derivations INTO LobbyTile instead of keeping them in renderTile, phase-q pins break — the design forbids that. Ship as its own deploy; instant rollback is reverting one file.

### Deploy notes

Client-only (Vercel). No migration/env/server change. Ship after VID-3 (independent, but VID-3 makes parent re-renders rare so this lands on a quiet baseline and profiling attribution is clean).

### ⚠ Adversarial review — REQUIRED amendments

**[IMPORTANT]** The click-routing design is self-contradictory and, followed literally, inverts the pinned big tile's unpin behavior. The props list says replace onClick with onTileClick:(sid)=>void; the codeSketch passes onTileClick={onClick ? () => onClick() : undefined} (an unstable inline closure that defeats the memo); then a NOTE says to drop both and have the tile call onPinToggle(trackRef.participant.sid, trackRef.participant.identity) for wrapper-div clicks. But today's wrapper-div clicks are NOT uniformly 'pin': the pinned big tile's click UNPINS (Lobby.tsx:583 onClick: () => setEffectivePin(null)), while grid (625), strip (589) and stage (618) clicks pin. Routing every wrapper click to onPinToggle(sid, identity) makes clicking the big tile re-pin it — the click-to-unpin path dies, and only the small PinOff button (which the spec doesn't re-specify) would clear a pin.

*Required action:* Specify one click contract explicitly: the tile's wrapper onClick calls props.onPinToggle(isPinned ? null : sid, isPinned ? null : identity) — mirroring the existing pin-button logic at Lobby.tsx:431 — and delete the contradictory onTileClick prop and the 'onClick ? () => onClick()' sketch line. Add an unpin-by-clicking-big-tile assertion to the headed smoke.

**[IMPORTANT]** Missed pinned-test collision: server/src/__tests__/services/phase-may19-bug26-tile-demote.test.ts:154-162 anchors on the FIRST occurrence of the string 'isActingHost' in Lobby.tsx (lobbySrc.indexOf('isActingHost')) and requires hostsSet.has(...) AND !tileDemotedSet.has(...) within the following 600 chars. Today the first occurrence is the renderTile derivation at Lobby.tsx:358-360, which satisfies it. The spec places LobbyTileProps/lobbyTilePropsEqual/LobbyTile at module scope ABOVE LobbyMosaic, and all three contain 'isActingHost' (interface field, comparator 'prev.isActingHost === next.isActingHost', destructure) — moving the first occurrence to module scope where no hostsSet/tileDemotedSet reference exists within 600 chars. The pin fails, yet VID-4's pinnedTestsToUpdate claims 'NONE if the design is followed exactly' and never lists this file.

*Required action:* Place LobbyTile + lobbyTilePropsEqual + the props interface BELOW LobbyMosaic (a const component referenced at render time, not module-init, so definition order is irrelevant), or explicitly add phase-may19-bug26-tile-demote.test.ts:154-162 to pinnedTestsToUpdate for a same-commit pin fix (e.g. anchor on 'const isActingHost' instead of 'isActingHost').

**[NIT]** The codeSketch comment '{/* existing JSX verbatim */}' and the 'all data-testids ... verbatim' framing are unachievable as stated: the tile JSX closes over LobbyMosaic locals the props do not carry 1:1 — hostsSet.has(identity) && identity !== hostUserId gates the cohost shrink/restore buttons (Lobby.tsx:480-482), tileDemotedSet.has(...) at :448/:483, useBigHostTiles/soloOrCompactHostTileClass in tileClass, and setEffectivePin in the pin button (:431). Each must be rewritten against props ((isActingHost || isDemoted) && !tileIsHost for the cohost-button gate; isDemoted for the toggle branches; onPinToggle for the pin button). Derivable, but 'verbatim' invites a broken copy-paste and the cohost-gate rewrite is genuinely subtle (a demoted cohost must still show the Restore button).

*Required action:* Replace 'verbatim' with an explicit closure-variable-to-prop mapping table, including the line 480-482 gate rewritten as (isActingHost || isDemoted) && !tileIsHost, and note that tileDemotedUserIds only ever contains cohosts so the equivalence holds.

**[NIT]** Deleting the muteTick effect (Lobby.tsx:54-72) leaves the RoomEvent import (line 24) unused — client/tsconfig.json has noUnusedLocals:true and build is 'tsc -b && vite build', so the build fails. The spec only mentions removing the useRoomContext import 'if unused elsewhere' (it is otherwise unused in Lobby.tsx — only line 54 uses it) and never mentions RoomEvent. Loud failure, but the spec's import-cleanup checklist is incomplete.

*Required action:* Add 'remove RoomEvent from the livekit-client import (line 24)' to VID-4's cleanup list (Track and ConnectionState remain used at lines 42/97 and 138-139).

---

## VID-5 — ChatPanel: message windowing + memoized bubbles + at-bottom-only autoscroll with 'new messages' pill

**Priority:** P2

**Files:**
- `C:/Users/ARFA TECH/Desktop/RSN-dev/client/src/features/live/ChatPanel.tsx`
- `C:/Users/ARFA TECH/Desktop/RSN-dev/server/src/__tests__/client/m9-chat-window.test.ts (new)`

### Problem

ChatPanel renders every visible message as an unmemoized MessageBubble (ChatPanel.tsx:162-169; the store caps at 200 — sessionStore.ts:550-559), and an unconditional smooth-scroll effect fires on EVERY new message (ChatPanel.tsx:54-56) — so a reader scrolled up to re-read gets yanked to the bottom by anyone chatting, and at 30-50 people a busy lobby chat re-renders up to 200 bubbles per message with queued smooth-scroll animations. Audit medium: 'Chat panel unvirtualized, no per-bubble memoization, forced smooth-scroll per message.'

### Design

WINDOWING (no new dependency — the 200-message store cap makes slice-windowing sufficient; a virtualization library is overkill and banned by rule 5):
  const CHAT_WINDOW = 60;
  const [windowSize, setWindowSize] = useState(CHAT_WINDOW);
  useEffect(() => { setWindowSize(CHAT_WINDOW); }, [scope]);  // reset when lobby↔room scope flips
Keep the PINNED `const visibleMessages = chatMessages.filter(...)` block (ChatPanel.tsx:116-125) byte-identical (phase-c-chat-roomid-fix.test.ts:34 pins its exact shape), then add AFTER it:
  const windowedMessages = visibleMessages.slice(-windowSize);
  const hiddenCount = visibleMessages.length - windowedMessages.length;
Render map switches to windowedMessages. When hiddenCount > 0, render a 'Show earlier messages (N)' button (data-testid="chat-show-earlier", min-h-[44px] tap target) at the top of the scroll container → setWindowSize(s => s + CHAT_WINDOW). Scroll-position preservation on expand: useLayoutEffect keyed on windowSize — capture container.scrollHeight before expand (ref set in the click handler), then container.scrollTop += (newScrollHeight - prevScrollHeight). Set `overflow-anchor: none` (style or Tailwind [overflow-anchor:none]) on the messages container so native scroll anchoring doesn't fight the manual restore.

PER-BUBBLE MEMO: wrap the existing component: `const MessageBubble = memo(function MessageBubble({ msg, isOwn, sessionId }: ...) { ...unchanged body... });` Default shallow equality SUFFICES because message object identity is stable: addChatMessage appends (sessionStore.ts:550-559) and updateMessageReaction replaces ONLY the matched message object (sessionStore.ts:561-563, `m.id === messageId ? { ...m, reactions } : m`) — a reaction re-renders exactly one bubble. isOwn/sessionId are stable per mount.

AT-BOTTOM-ONLY AUTOSCROLL: add a ref on the scrollable messages div (the `flex-1 overflow-y-auto px-4 py-3 space-y-3` container, line 156):
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [newSinceScroll, setNewSinceScroll] = useState(0);
  onScroll={() => { const el = scrollContainerRef.current; if (!el) return; const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60; atBottomRef.current = atBottom; if (atBottom && newSinceScroll) setNewSinceScroll(0); }}
Replace the unconditional effect (54-56) with:
  useEffect(() => {
    if (atBottomRef.current) { messagesEndRef.current?.scrollIntoView({ behavior: 'auto' }); }
    else { setNewSinceScroll(c => c + 1); }
  }, [chatMessages.length]);
('auto' not 'smooth' — smooth queues animation frames under burst; on-open positioning becomes instant which is also the correct drawer UX.) handleSend additionally forces atBottomRef.current = true before emit so your own message always scrolls into view.
NEW-MESSAGES PILL: when newSinceScroll > 0 && !atBottom, render a floating pill inside the panel, absolutely positioned above the input row, centered: data-testid="chat-new-messages-pill", `absolute bottom-20 left-1/2 -translate-x-1/2 z-10 min-h-[44px] px-4 rounded-full bg-blue-600 text-white text-xs font-medium shadow-lg` with label `{newSinceScroll} new message{s} ↓`; onClick → scrollIntoView({ behavior: 'auto' }) + setNewSinceScroll(0). The panel root needs `relative` added to position it. MOBILE (360px, global rule): pill is centered with max-w-[calc(100vw-2rem)], ≥44px tall, sits above the input (bottom-20 clears the 44px send button + padding) and cannot overlap the send button or emoji picker; keyboard-open behavior unchanged (pill scrolls with the panel, not the page).

UNTOUCHED (pinned or behavioral contracts): the scope filter block, the history-fetch guard (lines 72-82, phase-x pin), ProfileLink usage in bubbles (ws2 pin), container classes rounded-t-2xl sm:rounded-none / sm:border-l / drag handle / text-base sm:text-sm (phase6-mobile pins), maxLength 500 input, chatDisabled gate.

### Code sketch

````
// after the pinned visibleMessages block:
const windowedMessages = visibleMessages.slice(-windowSize);
const hiddenCount = visibleMessages.length - windowedMessages.length;

// messages container:
<div ref={scrollContainerRef} onScroll={handleScroll}
     className="flex-1 overflow-y-auto px-4 py-3 space-y-3 [overflow-anchor:none]">
  {hiddenCount > 0 && (
    <button data-testid="chat-show-earlier" onClick={showEarlier}
      className="w-full min-h-[44px] text-xs text-blue-600 hover:bg-gray-50 rounded-lg">
      Show earlier messages ({hiddenCount})
    </button>
  )}
  {windowedMessages.map(msg => (
    <MessageBubble key={msg.id} msg={msg} isOwn={msg.userId === user?.id} sessionId={sessionId} />
  ))}
  <div ref={messagesEndRef} />
</div>

// expand with scroll preservation:
const pendingRestoreRef = useRef<number | null>(null);
const showEarlier = () => { pendingRestoreRef.current = scrollContainerRef.current?.scrollHeight ?? null; setWindowSize(s => s + CHAT_WINDOW); };
useLayoutEffect(() => {
  const el = scrollContainerRef.current;
  if (el && pendingRestoreRef.current != null) {
    el.scrollTop += el.scrollHeight - pendingRestoreRef.current;
    pendingRestoreRef.current = null;
  }
}, [windowSize]);
````

### Tests to add

- NEW server/src/__tests__/client/m9-chat-window.test.ts — source pins: `const CHAT_WINDOW = 60`, `visibleMessages.slice(-windowSize)`, `const MessageBubble = memo(`, data-testid="chat-show-earlier", data-testid="chat-new-messages-pill", the conditional autoscroll (`if (atBottomRef.current)`) present AND the old unconditional form gone (not.toMatch(/scrollIntoView\(\{ behavior: 'smooth' \}\);\s*\}, \[chatMessages\.length\]\)/)); pill min-h-[44px] (tap-target rule).
- Run existing suite — phase-c-chat-roomid-fix.test.ts:25-34 (visibleMessages filter shape + roomId scoping), client/phase6-mobile-responsiveness.test.ts:28-50 (drawer classes, text-base sm:text-sm, 'temporary…clears at round end'), phase-x-may-13-live-bugs.test.ts:54 (history-fetch guard), ws2-profile-link-safety, may21-livekit-presence-pin.test.ts:124 must stay green unmodified.
- Headed Playwright prod smoke (2 browsers, one at 360x740): B scrolls chat up ~3 screens; A sends 3 messages → assert B's scrollTop unchanged (±2px) AND pill shows '3 new messages'; B taps pill → at bottom, pill gone; B (at bottom) receives a message → autoscrolled, no pill; B sends own message while scrolled up → autoscrolled to own message; with 80 seeded messages assert exactly 60 bubbles rendered + 'Show earlier messages (20)'; tap it → 80 rendered, anchor message still in view (scroll preserved); pill boundingBox fully inside the 360px viewport and not intersecting the send button's boundingBox; react to an old message → only that bubble's reaction count updates.

### Acceptance criteria

- A reader scrolled up is NEVER auto-scrolled by incoming messages; an unobtrusive counter pill appears instead and clears on tap or on manually reaching bottom.
- At the store's 200-message cap, at most 60 bubbles render until 'Show earlier' is tapped; expanding preserves the reading position.
- Reactions update exactly one bubble (memo holds — store identity contract verified at sessionStore.ts:561-563).
- All existing chat pins green; 360px layout has no overlap between pill, input, and send button, all tap targets ≥44px.

### Pinned tests to update

- NONE must change — the design preserves: phase-c-chat-roomid-fix.test.ts:34 regex `/const\s+visibleMessages\s*=\s*chatMessages\.filter[\s\S]*?\}\);/` (windowing slices AFTER the pinned filter, never inside it), phase6-mobile-responsiveness ChatPanel class pins, phase-x history-guard pin, ws2 ProfileLink pin.

### Risks

Low. Scroll-position restore vs native scroll anchoring can double-compensate — neutralized by [overflow-anchor:none] on the container. The 60px at-bottom threshold can misclassify during momentum scrolling on iOS (pill flickers once) — cosmetic; threshold is a named constant for tuning. Window reset on scope change means a breakout user returning to lobby sees the latest 60 — intended. behavior:'auto' on open changes the open animation feel slightly (instant position) — strictly better for a drawer.

### Deploy notes

Client-only (Vercel). No migration/env/server change. Last item in the cluster ship order; independent of all others.

### ⚠ Adversarial review — REQUIRED amendments

**[NIT]** The new-messages pill counter keys on chatMessages.length, which counts BOTH scopes — the store holds lobby and room messages simultaneously (that is why the visibleMessages scope filter at ChatPanel.tsx:116-125 exists). A message arriving in the non-visible scope increments the pill ('3 new messages') with nothing new to see at the bottom. The old behavior had the same scope-blindness but it was invisible (a redundant scroll); the pill makes it a user-visible lie.

*Required action:* Key the autoscroll/counter effect on visibleMessages.length (or compute newSinceScroll from visibleMessages growth) so the pill counts only messages the reader can actually see.

## Reviewer-verified facts (safe to rely on)

- Versions pinned in root package-lock.json match the spec exactly: livekit-client 2.17.2, @livekit/components-react 2.9.20, @livekit/components-core 0.12.13, zustand 5.0.11 (v5 = Object.is per-selector equality as claimed), react 18.3.1.
- livekit-client 2.17.2 API claims verified: RoomOptions.adaptiveStream at node_modules/livekit-client/dist/src/options.d.ts:21 and dynacast at :30; TrackPublishDefaults.videoEncoding at dist/src/room/track/options.d.ts:7 and videoSimulcastLayers at :91; runtime VideoPresets h180=320x180@160k/20fps, h360=640x360@450k/20fps, h540=960x540@800k/25fps match the spec byte-for-byte; AdaptiveStreamSettings.pauseVideoInBackground documented default true (dist/src/room/track/types.d.ts:18-21).
- Room publishDefaults DO apply to the BG-engine publish path: livekit-client merges roomOptions.publishDefaults under per-publish options (dist/livekit-client.esm.mjs:24407 'Object.assign({}, roomOptions.publishDefaults), options'), and BgCameraPublisher publishes with only { source } (client/src/features/live/BgCameraPublisher.tsx:67) and unpublishes with stopOnUnpublish=false (:84) — VID-1's encoder-layer claim is correct.
- useIsMuted(trackRef: TrackReferenceOrPlaceholder): boolean exists and is exported (node_modules/@livekit/components-react/dist/hooks/useIsMuted.d.ts:21, hooks/index.d.ts:10); components-core mutedObserver (dist/index.mjs:1213-1233) handles placeholder refs by falling back to participant.getTrackPublication(source) and returns muted=true when no publication — behavior parity with the current participant.isMicrophoneEnabled read at Lobby.tsx:361.
- All major line references verified on june9-punchlist: Lobby.tsx import line 24, muteTick effect 54-72, Phase-Q sort 103-117, serverPinnedSid resolver 250-256, setEffectivePin 267-288 (deps [isHost, cameraTracksSorted, sessionId]), renderTile 339-537, pinned strip 585-593, grid map 623-626, LiveKitRoom options 1618-1622, RoomAudioRenderer 1631; VideoRoom.tsx options 662-669, RoomAudioRenderer 828, VideoStage bump 118-133; sessionStore.ts addChatMessage cap-200 550-559, updateMessageReaction 561-563, applyStateSnapshot 608-614, applyFullState 619-686, useInRoomParticipants 732-743; ChatPanel.tsx autoscroll 54-56, history guard 72-82, visibleMessages 116-125, scroll container 156, bubble map 162-169; useSessionSocket.ts roster:changed 262-264, you-block prevSeq-before-apply 274-277, 30s resync 1167-1188.
- Audit re-verification claims hold: grep for adaptiveStream/dynacast/simulcast across client/src returns zero hits; no useMediaQuery hook exists in client/src/hooks; docs/AUDIT-2026-06-12-live-30-50-readiness.md contains C2 (:62-65), M9 (:91) and the 24fps suggestion (:137) as characterized.
- Test-infrastructure strategy is feasible: server/jest.config.js transforms only .ts (moduleFileExtensions ts/js/json) and bg-engine-core.test.ts already imports client .ts modules directly via '../../../../client/src/...'; all proposed importable modules (tileWindow.ts, stateIdentity.ts, sessionStore.ts) are plain .ts; sessionStore imports only zustand+react, both resolving at root node_modules; client has no test runner (scripts: dev/build/lint only) as the clusterNotes claim.
- Pinned tests the spec lists exist at the claimed locations and survive the designs as written: background-effects.test.ts:154-156 (whitespace-tolerant videoCaptureDefaults regex), ws3-audio-cluster.test.ts:26/31 (exact one-line audioCaptureDefaults + audio={isHost}), may21-livekit-presence-pin.test.ts:73-80, t0-2-room-presence.test.ts:117-122, phase-n:137 + phase-t:68 (normalTracks: cameraTracks), s21-reconnect-roster-hold.test.ts:35, phase-q-host-tile-elevation.test.ts:44/79-82/94-97/113-114/118/126 (thin-wrapper renderTile design does preserve these), phase-x-may-13-live-bugs.test.ts:54/405-416, phase-may18-stefan-feedback.test.ts:96-118, phase-m-acting-as-host.test.ts:217-225, s26-start-signal-resilience.test.ts:61, phase-c-chat-roomid-fix.test.ts:34-38 (VID-5 windowing after the filter block is pin-safe), phase6-mobile-responsiveness ChatPanel pins :28-50.
- Hidden-coupling sweep of all 37 test files reading the touched client files found no pins on muteTick/setMuteTick/TrackMuted, none on the chat scrollIntoView effect, none on applyStateSnapshot internals, and none on MessageBubble — the only missed collision is phase-may19-bug26-tile-demote.test.ts (see issues). t2-ui-polish-batch, phase-8c, video-tile-object-cover, s17, phase8-host-action-receipts, phase-p, p2-event-reliability, may20, june10-kick-is-terminal pins are all file-wide regexes or anchors untouched by the five designs.
- Referenced e2e specs all exist: e2e/tests/bg-smoke.spec.ts, bg-cross-device.spec.ts, load-25-users.spec.ts, loadABC-20users.spec.ts, s17-s18-mute-and-endgame-smoke.spec.ts, phase-q-ui-host-tile-elevation.spec.ts.
- Shippability verified: all five work items touch only client/src files (no server source, no migrations, no env, no render.yaml); LiveKit adaptiveStream/dynacast are per-connection options so mixed old/new clients in the same room during a rolling Vercel deploy are compatible; no advisory locks or lock ordering anywhere in the spec (check 5 vacuously passes); express-rate-limit/pg/socket.io APIs are not used by this cluster.
- Store identity contracts VID-5 relies on verified: addChatMessage appends and caps at 200 (sessionStore.ts:550-559), updateMessageReaction replaces only the matched message object (:561-563), so memo'd MessageBubble with default shallow equality re-renders exactly one bubble per reaction.
- VID-2 supporting claims verified: lobbyDensity type is 'compact'|'normal'|'spacious' (sessionStore.ts:196), Phase-Q sort + visibility partition preserve order into cameraTracks, serverPinnedSid resolver searches cameraTracksSorted not the rendered window (Lobby.tsx:250-256), Users icon already imported (Lobby.tsx:1), Tailwind 3.4 supports [content-visibility:auto] arbitrary properties, sm: breakpoint = 640px matches the proposed (max-width: 639px) query.

