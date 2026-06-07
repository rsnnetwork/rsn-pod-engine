// Single source of truth for in-call virtual backgrounds (blur / image), shared
// by the lobby (main room) and breakout VideoRoom. Wraps @livekit/track-processors
// (MediaPipe Selfie Segmentation — the same model Google Meet uses) but tuned so
// it stays light and can never freeze a weak laptop:
//   • 540p capture + maxFps 15 + blur radius 18 (cheap per frame)
//   • self-hosted WASM + model (no runtime CDN; reliable for a 500-person event)
//   • modern BackgroundProcessor + switchTo() (one pipeline, no rebuild-on-toggle)
//   • onFrameProcessed → degrade-then-disable ladder (see bgFrameHealth.ts)
//   • capability-gated; if unsupported the UI hides the control entirely.
import { Track } from 'livekit-client';
import { BACKGROUND_EFFECTS_ENABLED } from './featureFlags';
import { BG_MAX_FPS, type FrameStats } from './bgFrameHealth';
import type { BgPreference } from './bgPreference';

export const BG_BLUR_RADIUS = 18;

// 540p capture — used by both rooms' RoomOptions.videoCaptureDefaults. Halves the
// pixels of 720p for the segmentation composite AND cuts everyone's egress
// bandwidth at scale, while staying crisp for 1:1 video.
export const BG_CAPTURE_RESOLUTION = { width: 960, height: 540, frameRate: 30 } as const;

// Self-hosted MediaPipe assets (copied into client/public/mediapipe by
// scripts/copy-mediapipe.mjs at build). If they 404 we fall back to the library
// CDN default so the feature degrades rather than breaks.
const SELF_HOSTED_ASSETS = {
  tasksVisionFileSet: '/mediapipe/wasm',
  modelAssetPath: '/mediapipe/selfie_segmenter.tflite',
};

export interface BgPreset {
  label: string;
  mode: BgPreference['mode'];
  /** self-hosted image for 'image' presets (also used as the panel thumbnail) */
  image?: string;
}

// Self-hosted preset images (client/public/backgrounds) — no runtime Unsplash
// fetch hammering an external host with 500 users at event start.
export const BG_PRESETS: BgPreset[] = [
  { label: 'None', mode: 'disabled' },
  { label: 'Blur', mode: 'blur' },
  { label: 'Office', mode: 'image', image: '/backgrounds/office.jpg' },
  { label: 'Nature', mode: 'image', image: '/backgrounds/nature.jpg' },
  { label: 'City', mode: 'image', image: '/backgrounds/city.jpg' },
  { label: 'Abstract', mode: 'image', image: '/backgrounds/abstract.jpg' },
];

/** Map a preset tile onto the persisted preference shape. */
export function presetToPreference(preset: BgPreset): BgPreference {
  if (preset.mode === 'blur') return { mode: 'blur' };
  if (preset.mode === 'image' && preset.image) return { mode: 'image', imageUrl: preset.image };
  return { mode: 'disabled' };
}

/** Whether a preset tile is the currently-applied one (for highlight). */
export function isActivePreset(preset: BgPreset, current: BgPreference): boolean {
  if (preset.mode === 'disabled') return current.mode === 'disabled';
  if (preset.mode === 'blur') return current.mode === 'blur';
  return current.mode === 'image' && current.imageUrl === preset.image;
}

/** A custom upload is active when an image is set that isn't one of the presets. */
export function isCustomActive(current: BgPreference): boolean {
  return current.mode === 'image' && !BG_PRESETS.some((p) => p.image === current.imageUrl);
}

type BgModule = typeof import('@livekit/track-processors');

let _modPromise: Promise<BgModule | null> | null = null;
/** Lazy-load the heavy processor module once. A FAILED load is NOT cached —
 *  one flaky chunk fetch must not erase the feature for the whole session
 *  (observed 2026-06-07: fully-working lobby, BG button permanently missing). */
export function loadBgProcessors(): Promise<BgModule | null> {
  if (!_modPromise) {
    _modPromise = import(/* @vite-ignore */ '@livekit/track-processors').catch(() => {
      _modPromise = null; // transient — let the next caller retry the import
      return null;
    });
  }
  return _modPromise;
}

let _supported: boolean | undefined;
/** True when the flag is on AND the browser can run the processor AT ALL —
 *  modern (MediaStreamTrackProcessor, Chrome/Edge) OR the canvas.captureStream
 *  FALLBACK (iOS Safari, older Android). Gating on the modern check alone hid
 *  the BG button entirely on mobile (Ali, 2026-06-08). The fallback path is
 *  heavier (main-thread RAF), so the engine runs it at the lightest adaptive
 *  profile and the never-freeze ladder still guards it.
 *  A GENUINE capability answer is cached (can't change within a session);
 *  a module-load failure is NOT an answer — it stays uncached so a later
 *  probe can retry once the network recovers. */
export async function isBackgroundSupported(): Promise<boolean> {
  if (!BACKGROUND_EFFECTS_ENABLED) return false;
  if (_supported !== undefined) return _supported;
  const mod = await loadBgProcessors();
  if (!mod) return false; // do NOT cache — transient load failure
  try {
    _supported = typeof mod.supportsBackgroundProcessors === 'function'
      ? mod.supportsBackgroundProcessors()
      : false;
  } catch {
    _supported = false;
  }
  return _supported;
}

let _assetPaths: typeof SELF_HOSTED_ASSETS | null | undefined;
/** Use self-hosted assets if present, else undefined (library falls back to CDN). */
export async function resolveAssetPaths(): Promise<typeof SELF_HOSTED_ASSETS | undefined> {
  if (_assetPaths !== undefined) return _assetPaths ?? undefined;
  try {
    const r = await fetch(`${SELF_HOSTED_ASSETS.tasksVisionFileSet}/vision_wasm_internal.wasm`, {
      method: 'HEAD',
    });
    _assetPaths = r.ok ? SELF_HOSTED_ASSETS : null;
  } catch {
    _assetPaths = null;
  }
  return _assetPaths ?? undefined;
}

let _prewarmed = false;
/** Warm the lazy module + HTTP-cache the MediaPipe WASM/model the moment the
 *  room mounts, so the FIRST setProcessor() doesn't pay the ~9.7MB download
 *  inside the user's click. That download delay is what pushes the processor's
 *  internal <video> play() late and trips the "failed to play processor element,
 *  retrying" path — making the first apply flaky. Best-effort; ignores failures. */
export async function prewarmBackground(): Promise<void> {
  if (_prewarmed) return;
  _prewarmed = true;
  const mod = await loadBgProcessors();
  if (!mod) return;
  const paths = await resolveAssetPaths();
  const urls: string[] = [];
  if (paths?.tasksVisionFileSet) {
    urls.push(
      `${paths.tasksVisionFileSet}/vision_wasm_internal.js`,
      `${paths.tasksVisionFileSet}/vision_wasm_internal.wasm`,
    );
  }
  if (paths?.modelAssetPath) urls.push(paths.modelAssetPath);
  await Promise.all(urls.map((u) => fetch(u, { cache: 'force-cache' }).catch(() => {})));
}

export interface CreateProcessorOptions {
  pref: Exclude<BgPreference, { mode: 'disabled' }>;
  maxFps?: number;
  assetPaths?: typeof SELF_HOSTED_ASSETS;
  onFrameProcessed: (stats: FrameStats) => void;
}

/** Build a modern BackgroundProcessor for the given preference. The instance
 *  supports switchTo() so the caller can change mode later without rebuilding. */
export function createBackgroundProcessor(mod: BgModule, opts: CreateProcessorOptions): any {
  const maxFps = opts.maxFps ?? BG_MAX_FPS;
  const common = { maxFps, assetPaths: opts.assetPaths, onFrameProcessed: opts.onFrameProcessed };
  if (opts.pref.mode === 'blur') {
    return mod.BackgroundProcessor({ mode: 'background-blur', blurRadius: BG_BLUR_RADIUS, ...common });
  }
  return mod.BackgroundProcessor({ mode: 'virtual-background', imagePath: opts.pref.imageUrl, ...common });
}

/** The live local camera LocalVideoTrack, or null if not published yet. */
export function getCameraTrack(localParticipant: {
  trackPublications: Map<string, any> | { values(): IterableIterator<any> };
}): any | null {
  try {
    const pubs = Array.from((localParticipant.trackPublications as any).values());
    const camPub = pubs.find((p: any) => p.source === Track.Source.Camera);
    return (camPub as any)?.track ?? null;
  } catch {
    return null;
  }
}
