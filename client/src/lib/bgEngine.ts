// Event-scoped background engine — the Zoom model. ONE camera LocalVideoTrack +
// ONE MediaPipe pipeline for the WHOLE event; each room (main / breakout /
// manual) publishes the same already-processed track, so:
//   • room transitions never rebuild segmentation (the 3.5–8.8s cold cost and
//     ~300ms/frame warmup jank measured on prod 2026-06-07 happen ONCE)
//   • persistence is structural — the background IS the track, everywhere,
//     until the user changes it or closes the browser
//   • every apply after the first is a switchTo() (measured 244–409ms)
// Serialization / latest-wins / watchdog semantics live in bgEngineCore (pure,
// unit-tested); this shell binds them to livekit-client + track-processors.
import { createLocalVideoTrack, LocalVideoTrack } from 'livekit-client';
import {
  BG_BLUR_RADIUS,
  BG_CAPTURE_RESOLUTION,
  createBackgroundProcessor,
  isBackgroundSupported,
  loadBgProcessors,
  prewarmBackground,
  resolveAssetPaths,
} from './backgroundEffects';
import {
  createApplyQueue,
  pickBgProfile,
  samePref,
  type ApplyQueue,
  type ApplyResult,
  type BgProfile,
} from './bgEngineCore';
import { createFrameHealthMonitor, type FrameStats } from './bgFrameHealth';
import { loadBgPreference, saveBgPreference, type BgPreference } from './bgPreference';
import { CUSTOM_BG_URL, loadCustomBg, saveCustomBg } from './bgUploadStore';

const BG_STALL_MS = 4000;

export interface BgEngineState {
  supported: boolean;
  applying: boolean;
  current: BgPreference;
  degraded: boolean;
}

function bgDebug(...args: unknown[]): void {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('rsn_bg_debug')) {
      // eslint-disable-next-line no-console
      console.log('[bg]', ...args);
    }
  } catch { /* ignore */ }
}

function detectProfile(): BgProfile {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)
    || (nav.maxTouchPoints > 1 && /Mac/.test(nav.userAgent)); // iPadOS masquerades as Mac
  const modernApi = typeof (window as any).MediaStreamTrackGenerator !== 'undefined'
    && typeof (window as any).MediaStreamTrackProcessor !== 'undefined';
  return pickBgProfile({
    isMobile,
    cores: nav.hardwareConcurrency ?? 4,
    deviceMemoryGB: nav.deviceMemory ?? 8,
    modernApi,
  });
}

class BgEngine {
  private track: LocalVideoTrack | null = null;
  private trackPromise: Promise<LocalVideoTrack | null> | null = null;
  private processor: any = null;
  private queue: ApplyQueue;
  private profile: BgProfile = detectProfile();
  private reduced = false;
  private listeners = new Set<() => void>();
  private stateCache: BgEngineState;
  private lastFrameAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private customUrl: string | null = null; // live object URL for the IDB upload
  private destroyed = false;

  constructor() {
    this.stateCache = {
      supported: false,
      applying: false,
      current: loadBgPreference() ?? { mode: 'disabled' },
      degraded: false,
    };
    this.queue = createApplyQueue(
      {
        hasPipeline: () => !!this.processor,
        dropPipeline: () => this.disposeProcessor(),
        build: (pref) => this.execBuild(pref),
        switchTo: (pref) => this.execSwitch(pref),
      },
      {
        onStateChange: (s) => {
          this.patch({ applying: s.applying, current: s.currentPref });
        },
        onError: (err) => {
          bgDebug('apply failed', err);
        },
        onHardFail: (err, pref) => {
          // A wedged WASM worker — raw camera is the safe state.
          bgDebug('apply hard-fail (watchdog)', pref, err);
          this.patch({ current: { mode: 'disabled' }, degraded: true });
          saveBgPreference({ mode: 'disabled' });
        },
      },
    );
    void this.probeSupport();
  }

  /** Capability probe that can never be defeated by the network. Two failure
   *  shapes both used to hide the BG button for the whole event:
   *    • a REJECTED module import was cached as "unsupported" forever
   *    • a STALLED import (no timeout on dynamic import) hung the first and
   *      only probe, so no retry ever ran
   *  Now every attempt is timeout-raced and the loop keeps going for the
   *  event's lifetime (genuine-unsupported devices hit the cached answer, so
   *  later laps cost a microtask). Converges the moment the chunk lands. */
  private async probeSupport(attempt = 0): Promise<void> {
    if (this.destroyed) return;
    const s = await Promise.race([
      isBackgroundSupported(),
      new Promise<null>((r) => setTimeout(() => r(null), 8000)), // stalled fetch ⇒ check again later
    ]);
    bgDebug('probe attempt', attempt, '→', s === null ? 'stalled' : s);
    if (s) {
      this.patch({ supported: true });
      void prewarmBackground(); // HTTP-cache wasm+model early
      return;
    }
    setTimeout(() => { void this.probeSupport(attempt + 1); }, Math.min(15_000, 2000 * (attempt + 1)));
  }

  // ── public state for React ────────────────────────────────────────────────
  getState(): BgEngineState { return this.stateCache; }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private patch(p: Partial<BgEngineState>) {
    this.stateCache = { ...this.stateCache, ...p };
    this.listeners.forEach((fn) => fn());
  }

  // ── camera track (one per event) ──────────────────────────────────────────

  /** Create (once) and return the event camera track. The saved background is
   *  applied CONCURRENTLY — publish immediately; the processed output replaces
   *  the sender's track the moment it attaches.
   *  @param applySaved re-apply the persisted pref after creation (the
   *  publisher path wants this; the queue's own build path must NOT — it is
   *  already executing an apply). */
  ensureTrack(applySaved = true): Promise<LocalVideoTrack | null> {
    if (this.destroyed) return Promise.resolve(null);
    // Self-heal: if a teardown race ever stopped the track (readyState 'ended'),
    // re-acquire instead of handing rooms a dead camera for the rest of the event.
    if (this.track && this.track.mediaStreamTrack?.readyState === 'ended' && !this.track.isMuted) {
      bgDebug('engine track ended unexpectedly — reacquiring');
      this.disposeProcessor();
      this.queue.notePipelineLost(); // reality = raw camera; saved pref re-applies on recreate
      try { this.track.stop(); } catch { /* already dead */ }
      this.track = null;
      this.trackPromise = null;
    }
    if (!this.trackPromise) {
      this.trackPromise = (async () => {
        try {
          const track = await createLocalVideoTrack({
            resolution: {
              ...BG_CAPTURE_RESOLUTION,
              frameRate: this.profile.maxFps * 2, // capture headroom; segmentation is fps-capped separately
            },
          });
          this.track = track;
          if (applySaved) {
            const pref = loadBgPreference();
            if (pref && pref.mode !== 'disabled' && (await isBackgroundSupported())) {
              void this.apply(pref); // fire-and-forget — never blocks publish
            }
          }
          return track;
        } catch (err) {
          bgDebug('camera acquire failed', err);
          this.trackPromise = null; // allow retry (permission re-grant etc.)
          return null;
        }
      })();
    }
    return this.trackPromise;
  }

  getTrack(): LocalVideoTrack | null { return this.track; }

  // ── applies ───────────────────────────────────────────────────────────────

  /** User picked a preset / blur / off. Persists on success. */
  async apply(pref: BgPreference): Promise<ApplyResult> {
    this.patch({ degraded: false });
    const resolved = await this.resolvePref(pref);
    if (!resolved) return 'failed';
    const res = await this.queue.request(resolved.runtime);
    if (res === 'applied') saveBgPreference(resolved.persisted);
    return res;
  }

  /** User picked a custom image file. Stored in IDB so it survives refresh. */
  async applyUpload(file: Blob): Promise<ApplyResult> {
    try { await saveCustomBg(file); } catch { /* still usable this session */ }
    if (this.customUrl) URL.revokeObjectURL(this.customUrl);
    this.customUrl = URL.createObjectURL(file);
    this.patch({ degraded: false });
    const res = await this.queue.request({ mode: 'image', imageUrl: this.customUrl });
    if (res === 'applied') saveBgPreference({ mode: 'image', imageUrl: CUSTOM_BG_URL });
    return res;
  }

  /** Panel opened — build the pipeline while the user is still choosing, so the
   *  first apply is an instant switchTo instead of a multi-second cold build. */
  prewarmPipeline(): void {
    if (!this.stateCache.supported || !this.track) return;
    void this.queue.prewarm();
  }

  /** Map the persisted/UI pref to what the pipeline runs (IDB sentinel → URL). */
  private async resolvePref(
    pref: BgPreference,
  ): Promise<{ runtime: BgPreference; persisted: BgPreference } | null> {
    if (pref.mode === 'image' && pref.imageUrl === CUSTOM_BG_URL) {
      if (!this.customUrl) {
        const blob = await loadCustomBg();
        if (!blob) return null; // upload gone (cleared storage) — caller treats as failed
        this.customUrl = URL.createObjectURL(blob);
      }
      return { runtime: { mode: 'image', imageUrl: this.customUrl }, persisted: pref };
    }
    if (pref.mode === 'image' && this.customUrl === pref.imageUrl) {
      return { runtime: pref, persisted: { mode: 'image', imageUrl: CUSTOM_BG_URL } };
    }
    return { runtime: pref, persisted: pref };
  }

  // ── executor (queue-serialized; never call directly) ─────────────────────

  private async execBuild(pref: BgPreference): Promise<void> {
    // A click can land before the camera exists (page still booting, publisher
    // not yet connected). The OLD hook remembered the choice for later; the
    // engine goes further — acquire the camera now (deduped with the
    // publisher's ensureTrack via the same promise) and proceed. Without this
    // the user's first click silently failed with bg_no_track.
    const track = this.track ?? await this.ensureTrack(false);
    if (!track) throw new Error('bg_no_track');
    const mod = await loadBgProcessors();
    if (!mod) throw new Error('bg_module_unavailable');
    const assetPaths = await resolveAssetPaths();
    this.reduced = false;
    const monitor = createFrameHealthMonitor({
      onReduce: () => this.stepDownFps(),
      onDisable: () => { void this.autoDisable('degrade'); },
    });
    const onFrameProcessed = (stats: FrameStats) => {
      this.lastFrameAt = Date.now();
      monitor(stats);
    };
    const proc = pref.mode === 'disabled'
      ? mod.BackgroundProcessor({ mode: 'disabled', maxFps: this.profile.maxFps, assetPaths, onFrameProcessed })
      : createBackgroundProcessor(mod, { pref, maxFps: this.profile.maxFps, assetPaths, onFrameProcessed });
    await track.setProcessor(proc);
    this.processor = proc;
    this.startStallWatchdog();
    bgDebug('pipeline built', pref.mode, 'maxFps', this.profile.maxFps);
  }

  private async execSwitch(pref: BgPreference): Promise<void> {
    const proc = this.processor;
    if (!proc?.switchTo) throw new Error('bg_no_pipeline');
    // blurRadius must ride along — the library's switchTo default (10) is
    // visibly weaker than the tuned RSN radius (bg-visual smoke caught this).
    if (pref.mode === 'blur') await proc.switchTo({ mode: 'background-blur', blurRadius: BG_BLUR_RADIUS });
    else if (pref.mode === 'image') await proc.switchTo({ mode: 'virtual-background', imagePath: pref.imageUrl });
    else await proc.switchTo({ mode: 'disabled' }); // warm passthrough — re-enable stays instant
  }

  private disposeProcessor(): void {
    const proc = this.processor;
    this.processor = null;
    this.stopStallWatchdog();
    const track = this.track;
    void (async () => {
      try { await track?.stopProcessor?.(); } catch { /* already detached */ }
      try { await proc?.destroy?.(); } catch { /* already gone */ }
    })();
  }

  // ── safety nets (one pipeline → one set of nets) ─────────────────────────

  /** Sustained slow frames: lower the SEGMENTATION rate in place via capture
   *  constraints — works on both the modern and fallback paths, no rebuild. */
  private stepDownFps(): void {
    if (this.reduced) return;
    this.reduced = true;
    bgDebug('reduce →', this.profile.reducedFps, 'fps');
    void this.track?.mediaStreamTrack
      ?.applyConstraints({ frameRate: this.profile.reducedFps })
      .catch(() => { /* constraint unsupported — the disable ladder still guards */ });
  }

  private async autoDisable(reason: string): Promise<void> {
    bgDebug('auto-disable:', reason);
    this.stopStallWatchdog();
    await this.queue.request({ mode: 'disabled' });
    this.disposeProcessor(); // device can't cope — free the WASM/GL memory too
    this.patch({ degraded: true, current: { mode: 'disabled' } });
    // Persist Off so room hops / refreshes don't re-spin a pipeline the device
    // already proved it can't sustain. The user can re-enable explicitly.
    saveBgPreference({ mode: 'disabled' });
  }

  private startStallWatchdog(): void {
    this.stopStallWatchdog();
    this.lastFrameAt = Date.now();
    this.stallTimer = setInterval(() => {
      if (!this.processor) return;
      if (this.track?.isMuted) { this.lastFrameAt = Date.now(); return; } // camera off: silence expected
      if (this.stateCache.current.mode === 'disabled') return;            // passthrough emits no stats
      if (Date.now() - this.lastFrameAt > BG_STALL_MS) void this.autoDisable('stall');
    }, 1000);
  }

  private stopStallWatchdog(): void {
    if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = null; }
  }

  // ── teardown (event exit) ────────────────────────────────────────────────

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.stopStallWatchdog();
    const proc = this.processor;
    this.processor = null;
    try { await this.track?.stopProcessor?.(); } catch { /* noop */ }
    try { await proc?.destroy?.(); } catch { /* noop */ }
    try { this.track?.stop(); } catch { /* noop */ }
    this.track = null;
    this.trackPromise = null;
    if (this.customUrl) { URL.revokeObjectURL(this.customUrl); this.customUrl = null; }
    this.listeners.clear();
  }
}

let _engine: BgEngine | null = null;

/** The per-tab engine. Created lazily on first use (event entry). */
export function getBgEngine(): BgEngine {
  if (!_engine) _engine = new BgEngine();
  return _engine;
}

/** Tear down on event exit — the next event gets a fresh engine. */
export async function destroyBgEngine(): Promise<void> {
  const e = _engine;
  _engine = null;
  if (e) await e.destroy();
}

export { samePref };
export type { BgPreference };
