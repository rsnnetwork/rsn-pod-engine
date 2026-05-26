// Owns the lifecycle of the local participant's background-effect processor for
// one room mount (lobby OR a breakout). Both rooms use this identical hook, so
// the behaviour can't drift between them.
//
// Guarantees:
//   • Persists the user's choice and re-applies it whenever the camera publishes
//     — so the effect survives main → breakout → main until they pick "Off".
//   • Reuses one processor via switchTo() (no rebuild churn / leak on toggle).
//   • Destroys the processor on unmount (no orphaned MediaPipe worker across rooms).
//   • Two independent safety nets so the tab can never freeze:
//       1. Frame-health ladder (bgFrameHealth) — sustained slow frames step fps
//          down, then disable.
//       2. Stall watchdog — if frames stop arriving while BG is on and the
//          camera is live (lost WebGL context / hung pipeline), disable.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadBgProcessors,
  resolveAssetPaths,
  createBackgroundProcessor,
  getCameraTrack,
  isBackgroundSupported,
} from '@/lib/backgroundEffects';
import {
  createFrameHealthMonitor,
  BG_MAX_FPS,
  BG_REDUCED_MAX_FPS,
  type FrameStats,
} from '@/lib/bgFrameHealth';
import { loadBgPreference, saveBgPreference, type BgPreference } from '@/lib/bgPreference';

const APPLY_TIMEOUT_MS = 8000;
// No processed frame for this long while BG is active + camera on ⇒ pipeline is
// hung (e.g. lost GL context). Frame budget is ~66ms at 15fps, so 4s is unambiguous.
const BG_STALL_MS = 4000;

const withTimeout = <T,>(p: Promise<T>, ms = APPLY_TIMEOUT_MS): Promise<T> =>
  Promise.race<T>([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('bg_timeout')), ms)),
  ]);

// Opt-in diagnostics: set localStorage.rsn_bg_debug = "1" to log frame timing
// and the reason the effect stepped down / disabled. Off (silent) otherwise.
function bgDebug(...args: unknown[]): void {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('rsn_bg_debug')) {
      // eslint-disable-next-line no-console
      console.log('[bg]', ...args);
    }
  } catch {
    /* ignore */
  }
}

interface LocalParticipantLike {
  trackPublications: Map<string, any> | { values(): IterableIterator<any> };
  isCameraEnabled?: boolean;
}

export interface UseBackgroundEffects {
  /** flag + browser support; when false the caller hides the BG control entirely */
  supported: boolean;
  /** current applied preference (for highlighting the active preset) */
  current: BgPreference;
  /** true after the effect auto-disabled because the device couldn't keep up */
  degraded: boolean;
  /** apply a user-chosen preference (clears any prior degraded state) */
  apply: (pref: BgPreference) => Promise<void>;
}

export function useBackgroundEffects(
  localParticipant: LocalParticipantLike | null | undefined,
  cameraReady: boolean,
): UseBackgroundEffects {
  const [supported, setSupported] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [current, setCurrent] = useState<BgPreference>(() => loadBgPreference() ?? { mode: 'disabled' });

  const processorRef = useRef<any>(null);
  const reducedRef = useRef(false);
  const currentPrefRef = useRef<BgPreference>(current);
  const lastFrameAtRef = useRef(0);
  const stallTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopStallWatchdog = useCallback(() => {
    if (stallTimerRef.current) {
      clearInterval(stallTimerRef.current);
      stallTimerRef.current = null;
    }
  }, []);

  const destroyProcessor = useCallback(async () => {
    const p = processorRef.current;
    processorRef.current = null;
    if (p?.destroy) {
      try { await p.destroy(); } catch { /* already gone */ }
    }
  }, []);

  // Forward declarations via refs so the monitor callbacks can reach the latest
  // builders without a dependency cycle.
  const autoDisableRef = useRef<(reason: string) => Promise<void>>(async () => {});
  const rebuildReducedRef = useRef<() => Promise<void>>(async () => {});

  const startStallWatchdog = useCallback(() => {
    stopStallWatchdog();
    lastFrameAtRef.current = Date.now();
    stallTimerRef.current = setInterval(() => {
      if (!processorRef.current) return;
      if (localParticipant?.isCameraEnabled === false) return; // camera off: silence is expected
      if (Date.now() - lastFrameAtRef.current > BG_STALL_MS) {
        void autoDisableRef.current('stall');
      }
    }, 1000);
  }, [localParticipant, stopStallWatchdog]);

  const buildProcessor = useCallback(
    async (track: any, pref: Exclude<BgPreference, { mode: 'disabled' }>, startReduced: boolean) => {
      const mod = await loadBgProcessors();
      if (!mod) return;
      const assetPaths = await resolveAssetPaths();
      const monitor = createFrameHealthMonitor({
        startReduced,
        budgetMs: startReduced ? 1000 / BG_REDUCED_MAX_FPS : undefined,
        onReduce: () => { bgDebug('reduce → ' + BG_REDUCED_MAX_FPS + 'fps'); reducedRef.current = true; void rebuildReducedRef.current(); },
        onDisable: () => { void autoDisableRef.current('degrade'); },
      });
      let frameN = 0;
      let frameSum = 0;
      const onFrameProcessed = (stats: FrameStats) => {
        lastFrameAtRef.current = Date.now();
        frameN++; frameSum += stats.processingTimeMs;
        if (frameN % 30 === 0) { bgDebug(`avg processingTimeMs over 30 frames: ${(frameSum / 30).toFixed(1)} (fps=${startReduced ? BG_REDUCED_MAX_FPS : BG_MAX_FPS})`); frameSum = 0; }
        monitor(stats);
      };
      const proc = createBackgroundProcessor(mod, {
        pref,
        maxFps: startReduced ? BG_REDUCED_MAX_FPS : BG_MAX_FPS,
        assetPaths,
        onFrameProcessed,
      });
      await withTimeout(track.setProcessor(proc));
      processorRef.current = proc;
      currentPrefRef.current = pref;
      startStallWatchdog();
    },
    [startStallWatchdog],
  );

  const apply = useCallback(
    async (pref: BgPreference) => {
      setDegraded(false);
      const track = getCameraTrack(localParticipant as any);
      if (!track) {
        // camera not published yet — remember the choice; the re-apply effect retries.
        setCurrent(pref);
        currentPrefRef.current = pref;
        saveBgPreference(pref);
        return;
      }
      try {
        if (pref.mode === 'disabled') {
          reducedRef.current = false;
          stopStallWatchdog();
          await withTimeout(track.stopProcessor?.() ?? Promise.resolve(), 5000).catch(() => {});
          await destroyProcessor();
        } else {
          const existing = processorRef.current;
          // reuse the live pipeline via switchTo — no MediaPipe rebuild
          if (existing && typeof existing.switchTo === 'function') {
            if (pref.mode === 'blur') {
              await withTimeout(existing.switchTo({ mode: 'background-blur' }));
            } else {
              await withTimeout(existing.switchTo({ mode: 'virtual-background', imagePath: pref.imageUrl }));
            }
            currentPrefRef.current = pref;
          } else {
            reducedRef.current = false;
            await buildProcessor(track, pref, false);
          }
        }
        setCurrent(pref);
        saveBgPreference(pref);
      } catch (err) {
        console.error('Failed to apply background effect:', err);
      }
    },
    [localParticipant, buildProcessor, destroyProcessor, stopStallWatchdog],
  );

  // Keep the latest implementations behind the refs the monitor uses.
  useEffect(() => {
    rebuildReducedRef.current = async () => {
      const track = getCameraTrack(localParticipant as any);
      const pref = currentPrefRef.current;
      if (!track || pref.mode === 'disabled') return;
      await destroyProcessor();
      await buildProcessor(track, pref, true);
    };
    autoDisableRef.current = async (reason: string) => {
      bgDebug('auto-disable:', reason);
      const track = getCameraTrack(localParticipant as any);
      stopStallWatchdog();
      try { await withTimeout(track?.stopProcessor?.() ?? Promise.resolve(), 5000); } catch { /* noop */ }
      await destroyProcessor();
      reducedRef.current = false;
      setCurrent({ mode: 'disabled' });
      currentPrefRef.current = { mode: 'disabled' };
      setDegraded(true);
      // Don't keep retrying a device that can't cope — persist Off so room hops
      // don't re-spin it. The user can re-enable explicitly.
      saveBgPreference({ mode: 'disabled' });
    };
  }, [localParticipant, buildProcessor, destroyProcessor, stopStallWatchdog]);

  // Capability probe (once).
  useEffect(() => {
    let mounted = true;
    isBackgroundSupported().then((s) => { if (mounted) setSupported(s); });
    return () => { mounted = false; };
  }, []);

  // Re-apply the persisted preference each time the camera publishes (fresh
  // lobby join, breakout↔lobby return, camera off→on). This is what makes the
  // effect persist across rooms.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!(await isBackgroundSupported())) return;
      if (!localParticipant || !cameraReady) return;
      const pref = loadBgPreference();
      if (!pref || pref.mode === 'disabled') return;
      if (cancelled) return;
      await apply(pref);
    })();
    return () => { cancelled = true; };
    // apply is intentionally omitted — it's recreated on localParticipant change,
    // which is already a dep; including it would double-fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localParticipant, cameraReady]);

  // Tear down on unmount so no MediaPipe worker outlives the room.
  useEffect(() => {
    return () => {
      stopStallWatchdog();
      const p = processorRef.current;
      processorRef.current = null;
      if (p?.destroy) Promise.resolve(p.destroy()).catch(() => {});
    };
  }, [stopStallWatchdog]);

  return { supported, current, degraded, apply };
}
