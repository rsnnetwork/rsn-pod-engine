// Background-effects perf rebuild (27 May) — Stefan: "BG must be there and work
// very fine." Source-pins the tuning that keeps MediaPipe segmentation light and
// crash-proof (the behavioural degrade-ladder is covered in bg-frame-health.test.ts).
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');
const clientRoot = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client', rel), 'utf8');

describe('Background effects — perf + safety wiring', () => {
  const flags = clientSrc('lib/featureFlags.ts');
  const bg = clientSrc('lib/backgroundEffects.ts');
  const hook = clientSrc('hooks/useBackgroundEffects.ts');
  const lobby = clientSrc('features/live/Lobby.tsx');
  const vr = clientSrc('features/live/VideoRoom.tsx');

  it('feature flag is ON (kill-switch defaults enabled)', () => {
    expect(flags).toMatch(/BACKGROUND_EFFECTS_ENABLED\s*=\s*true/);
  });

  it('camera capture is 540p (not 720p) in both rooms', () => {
    expect(bg).toMatch(/BG_CAPTURE_RESOLUTION\s*=\s*\{\s*width:\s*960,\s*height:\s*540/);
    expect(lobby).toMatch(/videoCaptureDefaults:\s*\{\s*resolution:\s*\{\s*\.\.\.BG_CAPTURE_RESOLUTION/);
    expect(vr).toMatch(/videoCaptureDefaults:\s*\{\s*resolution:\s*\{\s*\.\.\.BG_CAPTURE_RESOLUTION/);
    expect(lobby).not.toMatch(/width:\s*1280,\s*height:\s*720/);
    expect(vr).not.toMatch(/width:\s*1280,\s*height:\s*720/);
  });

  it('processor is fps-capped and uses the modern BackgroundProcessor API (not the deprecated rebuild path)', () => {
    expect(bg).toMatch(/BackgroundProcessor\(/);
    expect(bg).toMatch(/maxFps/);
    // deprecated BackgroundBlur()/VirtualBackground() rebuild-on-toggle calls
    // are gone from the room components.
    expect(lobby).not.toMatch(/BackgroundBlur\(/);
    expect(vr).not.toMatch(/BackgroundBlur\(/);
  });

  it('MediaPipe assets are self-hosted with a CDN fallback', () => {
    expect(bg).toMatch(/\/mediapipe\/wasm/);
    expect(bg).toMatch(/\/mediapipe\/selfie_segmenter\.tflite/);
    expect(bg).toMatch(/resolveAssetPaths/); // HEAD-probe → CDN fallback
  });

  it('UI is capability-gated at runtime, not hard-wired to the flag', () => {
    expect(bg).toMatch(/supportsModernBackgroundProcessors/);
    expect(lobby).toMatch(/bg\.supported/);
    expect(vr).toMatch(/bg\.supported/);
  });

  it('degrade-then-disable + stall watchdog safety nets are wired', () => {
    expect(hook).toMatch(/createFrameHealthMonitor/);
    expect(hook).toMatch(/onFrameProcessed/);
    expect(hook).toMatch(/BG_STALL_MS/); // frames stop arriving ⇒ disable (lost GL ctx / hang)
  });

  it('build self-hosts the wasm via a copy script hooked into the build', () => {
    const pkg = clientRoot('package.json');
    expect(pkg).toMatch(/copy-mediapipe\.mjs/);
    const script = clientRoot('scripts/copy-mediapipe.mjs');
    expect(script).toMatch(/@mediapipe\/tasks-vision\/wasm/);
  });
});
