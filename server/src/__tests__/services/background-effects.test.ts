// Background effects — architecture pins (2026-06-07 rebuild). Stefan/Ali: BG
// must apply in 1–2s, never hang a browser, and persist across every room for
// the whole event (Zoom model). The behavioural core is covered in
// bg-engine-core.test.ts and bg-frame-health.test.ts; this suite pins the
// WIRING that makes the architecture hold:
//   ONE event-scoped camera track + ONE MediaPipe pipeline (lib/bgEngine),
//   published into each room by BgCameraPublisher — rooms never create their
//   own camera and never destroy the pipeline on transitions.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');
const clientRoot = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client', rel), 'utf8');

describe('Background effects — event-scoped engine wiring', () => {
  const flags = clientSrc('lib/featureFlags.ts');
  const bg = clientSrc('lib/backgroundEffects.ts');
  const engine = clientSrc('lib/bgEngine.ts');
  const publisher = clientSrc('features/live/BgCameraPublisher.tsx');
  const panel = clientSrc('features/live/BackgroundPanel.tsx');
  const lobby = clientSrc('features/live/Lobby.tsx');
  const vr = clientSrc('features/live/VideoRoom.tsx');
  const page = clientSrc('features/live/LiveSessionPage.tsx');

  it('feature flag is ON (kill-switch defaults enabled)', () => {
    expect(flags).toMatch(/BACKGROUND_EFFECTS_ENABLED\s*=\s*true/);
  });

  it('rooms do NOT auto-create camera tracks — the engine publishes instead', () => {
    // video={false} in both rooms; BgCameraPublisher mounted inside each.
    expect(lobby).toMatch(/video=\{false\}/);
    expect(vr).toMatch(/video=\{false\}/);
    expect(lobby).toMatch(/<BgCameraPublisher \/>/);
    expect(vr).toMatch(/<BgCameraPublisher \/>/);
  });

  it('the engine track survives room teardown (unpublish without stop, before disconnect)', () => {
    expect(publisher).toMatch(/unpublishTrack\(track, false\)/);
    // and the engine self-heals if a race ever ends the track
    expect(engine).toMatch(/readyState === 'ended'/);
    expect(engine).toMatch(/notePipelineLost/);
  });

  it('rooms never stop/unpublish the shared camera track in toggle fallbacks', () => {
    // the old "stop all video tracks then re-enable" recovery paths are gone
    expect(lobby).not.toMatch(/pub\.track\.stop\(\)/);
    expect(vr).not.toMatch(/unpublishTrack\(pub\.track\)/);
  });

  it('a click before the camera exists acquires it instead of failing', () => {
    // bg-smoke on prod caught the gap: apply → execBuild with no track threw
    // bg_no_track and the user's first click was silently lost. The build now
    // self-acquires (deduped with the publisher via the same trackPromise).
    expect(engine).toMatch(/this\.track \?\? await this\.ensureTrack\(false\)/);
  });

  it('applies are serialized through the core queue with switchTo reuse', () => {
    expect(engine).toMatch(/createApplyQueue/);
    expect(engine).toMatch(/switchTo/);
    // the tuned blur radius must ride every switch — the library default (10)
    // is visibly weaker (caught by bg-visual on the preview, 2026-06-07)
    expect(engine).toMatch(/mode: 'background-blur', blurRadius: BG_BLUR_RADIUS/);
    // "None" keeps the pipeline warm (passthrough), not a destroy
    expect(engine).toMatch(/mode: 'disabled' \}\); \/\/ warm passthrough/);
  });

  it('panel-open prewarm makes the first apply an instant switch', () => {
    expect(engine).toMatch(/prewarmPipeline/);
    expect(lobby).toMatch(/bg\.prewarm\(\)/);
    expect(vr).toMatch(/bg\.prewarm\(\)/);
  });

  it('adaptive quality: device-class profile + in-place fps step-down + disable ladder + stall watchdog', () => {
    expect(engine).toMatch(/pickBgProfile/);
    expect(engine).toMatch(/applyConstraints\(\{ frameRate: this\.profile\.reducedFps \}\)/);
    expect(engine).toMatch(/createFrameHealthMonitor/);
    expect(engine).toMatch(/BG_STALL_MS/);
  });

  it('engine is destroyed on event exit (no capture/WASM outlives the event)', () => {
    expect(page).toMatch(/destroyBgEngine/);
  });

  it('custom uploads persist via IndexedDB sentinel (refresh-survivable)', () => {
    expect(engine).toMatch(/CUSTOM_BG_URL/);
    expect(clientSrc('lib/bgUploadStore.ts')).toMatch(/indexedDB\.open/);
  });

  it('both rooms share ONE picker component with upload + applying state', () => {
    expect(lobby).toMatch(/<BackgroundPanel/);
    expect(vr).toMatch(/<BackgroundPanel/);
    expect(panel).toMatch(/onUpload/);
    expect(panel).toMatch(/Applying…/);
    // 7 options: None, Blur, 4 preset images, + Upload
    expect(bg).toMatch(/'None'/);
    expect(bg).toMatch(/'Blur'/);
    expect(bg).toMatch(/'Office'/);
    expect(bg).toMatch(/'Nature'/);
    expect(bg).toMatch(/'City'/);
    expect(bg).toMatch(/'Abstract'/);
    expect(panel).toMatch(/\+ Upload/);
  });

  it('camera capture stays 540p in both rooms', () => {
    expect(bg).toMatch(/BG_CAPTURE_RESOLUTION\s*=\s*\{\s*width:\s*960,\s*height:\s*540/);
    expect(lobby).toMatch(/videoCaptureDefaults:\s*\{\s*resolution:\s*\{\s*\.\.\.BG_CAPTURE_RESOLUTION/);
    expect(vr).toMatch(/videoCaptureDefaults:\s*\{\s*resolution:\s*\{\s*\.\.\.BG_CAPTURE_RESOLUTION/);
  });

  it('MediaPipe assets are self-hosted with a CDN fallback', () => {
    expect(bg).toMatch(/\/mediapipe\/wasm/);
    expect(bg).toMatch(/\/mediapipe\/selfie_segmenter\.tflite/);
    expect(bg).toMatch(/resolveAssetPaths/);
  });

  it('UI is capability-gated at runtime, not hard-wired to the flag', () => {
    expect(bg).toMatch(/supportsModernBackgroundProcessors/);
    expect(lobby).toMatch(/bg\.supported/);
    expect(vr).toMatch(/bg\.supported/);
  });

  it('a transient module-load failure never hides the feature for the session', () => {
    // loadBgProcessors must NOT cache a rejected import (one flaky chunk fetch
    // erased the BG button until hard refresh — found by the 6-browser smoke,
    // 2026-06-07), the probe must timeout-race a STALLED import (no native
    // timeout on dynamic import), and the retry loop must outlive any blip.
    expect(bg).toMatch(/_modPromise = null; \/\/ transient/);
    expect(bg).toMatch(/if \(!mod\) return false; \/\/ do NOT cache/);
    expect(engine).toMatch(/Promise\.race\(\[\s*isBackgroundSupported\(\)/);
    expect(engine).toMatch(/probeSupport\(attempt \+ 1\)/);
    expect(engine).toMatch(/Math\.min\(15_000/); // gentle forever-loop, not a capped one
  });

  it('build self-hosts the wasm via a copy script hooked into the build', () => {
    const pkg = clientRoot('package.json');
    expect(pkg).toMatch(/copy-mediapipe\.mjs/);
    const script = clientRoot('scripts/copy-mediapipe.mjs');
    expect(script).toMatch(/@mediapipe\/tasks-vision\/wasm/);
  });
});
