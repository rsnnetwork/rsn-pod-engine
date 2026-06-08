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

  it('auto-disable surfaces a transient toast, not just the in-panel notice (Bug③)', () => {
    expect(engine).toMatch(/useToastStore\.getState\(\)\.addToast/);
    expect(engine).toMatch(/lastDegradeToastAt/); // debounced so a flapping device can't spam
  });

  it('the live event page mounts a ToastContainer (it is outside AppLayout)', () => {
    // Without this the auto-disable toast fired into the void during an event
    // (Ali, 2026-06-08). The /session/:id/live route bypasses AppLayout.
    const page = clientSrc('features/live/LiveSessionPage.tsx');
    expect(page).toMatch(/import ToastContainer from '@\/components\/ui\/Toast'/);
    expect(page).toMatch(/<ToastContainer \/>/);
  });

  it('Bug④ — no-flash transformer is flag-gated, ALL-PATHS (mobile too), code-split, library-wrapped, same proven mask', () => {
    const flags = clientSrc('lib/featureFlags.ts');
    const nf = clientSrc('lib/bgNoFlashTransformer.ts');
    expect(flags).toMatch(/BG_NOFLASH_TRANSFORMER = true/);
    // 2026-06-09: gated on the flag ALONE — no longer modern-API-only, so the
    // canvas fallback (iOS Safari / older Android) also gets no apply-flash.
    expect(engine).toMatch(/const useNoFlash = BG_NOFLASH_TRANSFORMER;/);
    expect(engine).not.toMatch(/BG_NOFLASH_TRANSFORMER && this\.modernApi/);
    // dynamically imported so the heavy transformer/mediapipe stays code-split
    expect(engine).toMatch(/await import\('\.\/bgNoFlashTransformer'\)/);
    // built on the library's exported wrapper — only the transformer is vendored
    expect(engine).toMatch(/new mod\.BackgroundProcessorWrapper\(/);
    // SAME proven category mask as stock (compositing unchanged) ...
    expect(nf).toMatch(/outputCategoryMask: true/);
    expect(nf).toMatch(/result\.categoryMask\.getAsWebGLTexture\(\)/);
    // ... the ONLY change is dropping the first-frame raw-clone flash
    expect(nf).not.toMatch(/controller\.enqueue\(frame\.clone\(\)\)/);
    // confidence-mask path stays parked (would composite inverted)
    expect(nf).not.toMatch(/outputConfidenceMasks: true/);
  });

  it('image background re-covers when frame dimensions change (mobile rotation / fully-fitted)', () => {
    // The library covers the bitmap to canvas dims only at set-time; if the
    // frame size later changes the crop goes stale and the real room shows at
    // the edges. The vendored transformer re-covers on a dimension change.
    const nf = clientSrc('lib/bgNoFlashTransformer.ts');
    expect(nf).toMatch(/private bgFitKey = '';/);
    // re-cover guarded to image mode only (switchTo clears imagePath otherwise)
    expect(nf).toMatch(/typeof this\.options\.imagePath === 'string' && this\.backgroundImageAndPath/);
    expect(nf).toMatch(/this\.gl\?\.setBackgroundImage\(this\.backgroundImageAndPath\.imageData\)/);
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

  it('UI gate is an INSTANT local feature-detect (no module load) and fallback-inclusive', () => {
    // Bug① — accept the canvas fallback (iOS/Android), not modern-API-only.
    // Bug A (2026-06-08) — the gate must NOT wait on the heavy module import
    // (that hid the button until a refresh); it is a sync local detect now.
    expect(bg).toMatch(/function browserSupportsBgEffects\(\)/);
    expect(bg).toMatch(/_supported = browserSupportsBgEffects\(\)/);
    // gate no longer calls the async module to answer "supported?"
    expect(bg).not.toMatch(/mod\.supportsBackgroundProcessors\(\)/);
    expect(bg).not.toMatch(/_supported = typeof mod\.supportsModernBackgroundProcessors/);
    // local detect is fallback-inclusive (modern OR captureStream)
    expect(bg).toMatch(/hasModern \|\| hasFallback/);
    expect(lobby).toMatch(/bg\.supported/);
    expect(vr).toMatch(/bg\.supported/);
    // engine still detects the modern API for the adaptive profile (not the gate)
    expect(engine).toMatch(/modernApi/);
  });

  it('a transient module-load failure never hides the feature for the session', () => {
    // The GATE no longer touches the module at all (Bug A — sync local detect),
    // so a flaky/stalled chunk fetch can't hide the button. loadBgProcessors
    // (used only on prewarm/apply) still must NOT cache a rejected import.
    expect(bg).toMatch(/_modPromise = null; \/\/ transient/);
    // probe still resilient (now resolves instantly off the local detect)
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
